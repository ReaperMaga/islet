// Checks out a pull request branch in the local repository (git CLI via execFile, no shell).
import { execFile } from 'child_process';
import type { RepoRef } from '../shared/types';
import { UserError } from './errors';
import { log } from './log';

function git(cwd: string, args: string[]): Promise<string> {
  log.info(`git ${args.join(' ')}  (in ${cwd})`);
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message).trim();
        log.warn(`git ${args[0]} failed: ${detail}`);
        const e = new UserError(detail.split('\n').filter(Boolean).slice(-1)[0] ?? `git ${args[0]} failed`);
        (e as { code?: unknown }).code = (err as { code?: unknown }).code;
        reject(e);
      } else resolve(stdout);
    });
  });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Rejects branch names that could be mistaken for options or are not valid refs. */
function assertSafeRef(ref: string) {
  if (!ref || ref.startsWith('-') || /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\.lock$|\/$/.test(ref)) {
    throw new UserError(`Unsupported branch name: ${ref}`);
  }
}

/**
 * Checks out PR #number. If the head branch lives in the same repository (detected by comparing
 * refs/heads/<headRef> with refs/pull/<n>/head on the remote), the branch is checked out tracking
 * <remote>/<headRef>; otherwise the PR head is fetched into a local branch pr/<n>.
 * Returns the name of the checked-out branch.
 */
export async function checkoutPull(repo: RepoRef, remote: string, number: number, headRef: string): Promise<string> {
  const cwd = repo.rootPath;
  assertSafeRef(headRef);
  assertSafeRef(remote);

  try {
    await git(cwd, ['--version']);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') throw new UserError('Git was not found on PATH.');
    throw err;
  }

  let sameRepo = false;
  try {
    const out = await git(cwd, ['ls-remote', remote, `refs/heads/${headRef}`, `refs/pull/${number}/head`]);
    const shas = new Map<string, string>();
    for (const line of out.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref) shas.set(ref, sha);
    }
    const branchSha = shas.get(`refs/heads/${headRef}`);
    sameRepo = !!branchSha && branchSha === shas.get(`refs/pull/${number}/head`);
  } catch (err) {
    log.warn(`ls-remote failed, assuming fork: ${(err as Error).message}`);
  }

  if (sameRepo) {
    const tracking = `${remote}/${headRef}`;
    await git(cwd, ['fetch', remote, `+refs/heads/${headRef}:refs/remotes/${tracking}`]);
    const localExists = await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${headRef}`]);
    // Do not throw away local commits: only reset the local branch if it is behind/equal to the remote one.
    if (localExists && !(await gitOk(cwd, ['merge-base', '--is-ancestor', `refs/heads/${headRef}`, `refs/remotes/${tracking}`]))) {
      await git(cwd, ['checkout', headRef, '--']);
      log.warn(`Local branch ${headRef} has commits not on ${tracking}; checked it out without resetting.`);
      return headRef;
    }
    await git(cwd, ['checkout', '-B', headRef, '--track', tracking]);
    return headRef;
  }

  const local = `pr/${number}`;
  await git(cwd, ['fetch', remote, `+refs/pull/${number}/head:refs/heads/${local}`]).catch(async (err: unknown) => {
    // Fetching into the currently checked-out branch is refused; fetch to FETCH_HEAD and reset instead.
    const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    if (current !== local) throw err;
    await git(cwd, ['fetch', remote, `refs/pull/${number}/head`]);
    await git(cwd, ['merge', '--ff-only', 'FETCH_HEAD']);
  });
  await git(cwd, ['checkout', local, '--']);
  return local;
}
