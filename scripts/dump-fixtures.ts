// Dumps real GitHub data into src/webview/mock/fixtures.json for the browser design preview.
// Read-only: only viewer/list/detail are called, never mutations.
//
// Run (bash, from the project root):
//   npx esbuild scripts/dump-fixtures.ts --bundle --platform=node --format=esm --outfile="$TEMP/dump.mjs" && node "$TEMP/dump.mjs" [owner/name]

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHubApi } from '../src/api/github';
import type { ItemDetail, ItemKind, ItemSummary, ListFilter, PullDetail } from '../src/shared/types';

const OWN_REPO = 'ReaperMaga/findgamestogether';
const FALLBACK_REPO = 'vitejs/vite';
const MAX_BODY = 12_000;
const MAX_TIMELINE = 40;

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const api = createGitHubApi(async () => token);

function filter(state: ListFilter['state']): ListFilter {
  return { state, scope: 'all', query: '' };
}

async function items(owner: string, name: string, kind: ItemKind, login: string): Promise<ItemSummary[]> {
  const open = (await api.list(owner, name, kind, filter('open'), login)).items;
  const closed = (await api.list(owner, name, kind, filter('closed'), login)).items;
  return [...open.slice(0, 11), ...closed.slice(0, 9)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function truncate(html: string): string {
  return html.length > MAX_BODY ? html.slice(0, MAX_BODY).replace(/<[^>]*$/, '') + '<p><em>… truncated for fixtures</em></p>' : html;
}

function slim<T extends ItemDetail>(d: T): T {
  return {
    ...d,
    bodyHTML: truncate(d.bodyHTML),
    timeline: d.timeline.slice(-MAX_TIMELINE).map((e) => ({ ...e, bodyHTML: truncate(e.bodyHTML) })),
  };
}

async function main() {
  const user = await api.viewer();
  console.log('viewer', user.login);

  const explicit = process.argv[2];
  let [owner, name] = (explicit ?? OWN_REPO).split('/');
  let issues = await items(owner, name, 'issue', user.login);
  let pulls = await items(owner, name, 'pull', user.login);
  if (!explicit && (issues.length < 6 || pulls.length < 4)) {
    console.log(`${OWN_REPO} has ${issues.length} issues / ${pulls.length} PRs, using ${FALLBACK_REPO}`);
    [owner, name] = FALLBACK_REPO.split('/');
    issues = await items(owner, name, 'issue', user.login);
    pulls = await items(owner, name, 'pull', user.login);
  }
  console.log(`${owner}/${name}: ${issues.length} issues, ${pulls.length} pulls`);

  const details: Record<string, ItemDetail> = {};
  const add = (d: ItemDetail) => { details[`${d.kind}-${d.number}`] = slim(d); console.log('detail', d.kind, d.number, d.title); };

  // Issue 1: most discussed with labels. Issue 2: another labelled one, preferably in the other state.
  const byComments = [...issues].sort((a, b) => b.commentCount - a.commentCount);
  const issue1 = byComments.find((i) => i.labels.length > 0) ?? byComments[0];
  const issue2 = byComments.find((i) => i !== issue1 && i.state !== issue1.state && i.labels.length > 0)
    ?? byComments.find((i) => i !== issue1);
  for (const i of [issue1, issue2]) if (i) add(await api.detail(owner, name, 'issue', i.number));

  // PR 1: merged with reviews and checks. PR 2: open with requested reviewers.
  const merged = pulls.filter((p) => p.state === 'merged');
  let pr1: PullDetail | undefined;
  for (const p of merged.slice(0, 8)) {
    const d = (await api.detail(owner, name, 'pull', p.number)) as PullDetail;
    if (!pr1 || (d.latestReviews.length > 0 && d.checkRuns.length > 0 && !(pr1.latestReviews.length > 0 && pr1.checkRuns.length > 0))) pr1 = d;
    if (d.latestReviews.length > 0 && d.checkRuns.length > 0) break;
  }
  if (pr1) add(pr1);

  // Requested *user* reviewers are rare (teams are skipped), so scan up to two pages of open PRs.
  const first = await api.list(owner, name, 'pull', filter('open'), user.login);
  const second = first.pageInfo.hasNextPage ? await api.list(owner, name, 'pull', filter('open'), user.login, first.pageInfo.endCursor) : null;
  let pr2: PullDetail | undefined;
  for (const p of [...first.items, ...(second?.items ?? [])]) {
    const d = (await api.detail(owner, name, 'pull', p.number)) as PullDetail;
    pr2 ??= d;
    if (d.reviewRequests.length > 0) { pr2 = d; break; }
  }
  if (pr2) {
    add(pr2);
    if (!pulls.some((p) => p.number === pr2.number)) {
      const { number, title, state, isDraft, author, createdAt, updatedAt, commentCount, labels, assignees, url, reviewDecision, checks, headRef, baseRef } = pr2;
      pulls.push({ kind: 'pull', number, title, state, isDraft, author, createdAt, updatedAt, commentCount, labels, assignees, url, reviewDecision, checks, headRef, baseRef });
      pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
  }

  const fixtures = {
    session: {
      signedIn: true,
      user,
      repo: { owner, name, url: `https://github.com/${owner}/${name}`, rootPath: `C:/dev/${name}`, currentBranch: 'main' },
    },
    issues,
    pulls,
    details,
  };
  const out = join(process.cwd(), 'src', 'webview', 'mock', 'fixtures.json');
  const json = JSON.stringify(fixtures, null, 1);
  writeFileSync(out, json + '\n');
  console.log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
