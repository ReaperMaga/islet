// Resolves the GitHub repository for the repository selected in VS Code, via the built-in git extension.
import * as path from 'path';
import * as vscode from 'vscode';
import type { RepoRef } from '../shared/types';
import { log } from './log';

// ---- minimal local typing of the vscode.git API (v1) ----

interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}
interface GitRepositoryState {
  readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
  readonly remotes: GitRemote[];
  readonly onDidChange: vscode.Event<void>;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  readonly ui: { readonly selected: boolean; readonly onDidChange: vscode.Event<void> };
}
interface GitAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitAPI;
}

// ---- remote URL parsing ----

/** Parses a GitHub remote URL (https, ssh scp-like, ssh://, git://) into owner/name. */
export function parseGitHubRemote(url: string | undefined): { owner: string; name: string } | null {
  if (!url) return null;
  url = url.trim();
  let repoPath: string | undefined;
  const scp = /^(?:[^@/]+@)?(?:www\.)?github\.com:(?!\/\/)(.+)$/i.exec(url);
  if (scp) {
    repoPath = scp[1];
  } else {
    try {
      const u = new URL(url);
      if (!/^(https?|ssh|git|git\+ssh|ssh\+git):$/i.test(u.protocol)) return null;
      if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
      repoPath = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  }
  const parts = repoPath.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  if (!name) return null;
  return { owner, name };
}

function pickRemote(remotes: GitRemote[]): { remote: GitRemote; owner: string; name: string } | null {
  const gh = (r: GitRemote) => parseGitHubRemote(r.fetchUrl) ?? parseGitHubRemote(r.pushUrl);
  const origin = remotes.find((r) => r.name === 'origin');
  const o = origin && gh(origin);
  if (origin && o) return { remote: origin, ...o };
  for (const r of remotes) {
    const p = gh(r);
    if (p) return { remote: r, ...p };
  }
  return null;
}

// ---- resolver ----

export interface RepoState {
  repo: RepoRef | null;
  /** Name of the git remote the repo was parsed from (usually "origin"). */
  remoteName?: string;
  reason?: string;
}

function norm(p: string): string {
  const n = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

function isInside(file: string, root: string): boolean {
  const f = norm(file);
  const r = norm(root);
  return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function keyOf(s: RepoState): string {
  return s.repo ? `${s.repo.owner}/${s.repo.name}@${s.repo.currentBranch ?? ''}|${s.repo.rootPath}` : `none|${s.reason ?? ''}`;
}

export class RepoResolver implements vscode.Disposable {
  private api: GitAPI | undefined;
  private state: RepoState = { repo: null, reason: 'Looking for a Git repository…' };
  private readonly subs: vscode.Disposable[] = [];
  private readonly repoSubs = new Map<GitRepository, vscode.Disposable[]>();
  private readonly emitter = new vscode.EventEmitter<RepoState>();
  /** Fires when the resolved repository (owner/name/branch/root) changes. */
  readonly onDidChange = this.emitter.event;
  /** Root of the repo containing the last active text editor (kept while a webview has focus). */
  private editorRoot: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>((r) => (this.readyResolve = r));

  constructor() {
    this.subs.push(this.emitter);
    void this.init().catch((err) => {
      log.error('Initialising the git integration failed', err);
      this.set({ repo: null, reason: 'The Git integration could not be loaded.' });
      this.readyResolve();
    });
    // Do not wait forever for a slow git extension.
    setTimeout(() => this.readyResolve(), 8000);
  }

  /** Resolved repository; waits for the git extension on first use. */
  async current(): Promise<RepoState> {
    await this.ready;
    return this.state;
  }

  /** Synchronous snapshot (may be the "looking…" state during startup). */
  get snapshot(): RepoState {
    return this.state;
  }

  /** Remote name for a repository root (defaults to "origin"). */
  remoteNameFor(rootPath: string): string {
    const repo = this.api?.repositories.find((r) => norm(r.rootUri.fsPath) === norm(rootPath));
    return (repo && pickRemote(repo.state.remotes)?.remote.name) ?? 'origin';
  }

  private async init() {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
      this.set({ repo: null, reason: 'The built-in Git extension is not available.' });
      this.readyResolve();
      return;
    }
    const gitExt = ext.isActive ? ext.exports : await ext.activate();
    const attach = () => {
      if (this.api || !gitExt.enabled) return;
      this.attachApi(gitExt.getAPI(1));
    };
    this.subs.push(
      gitExt.onDidChangeEnablement((enabled) => {
        if (enabled) attach();
        else {
          this.detachApi();
          this.set({ repo: null, reason: 'Git is disabled in VS Code (setting "git.enabled").' });
        }
      }),
    );
    if (!gitExt.enabled) {
      this.set({ repo: null, reason: 'Git is disabled in VS Code (setting "git.enabled").' });
      this.readyResolve();
      return;
    }
    attach();
  }

  private apiSubs: vscode.Disposable[] = [];

  private attachApi(api: GitAPI) {
    this.api = api;
    const onReady = () => {
      for (const r of api.repositories) this.watchRepo(r);
      this.recompute(true);
      this.readyResolve();
    };
    this.apiSubs.push(
      api.onDidOpenRepository((r) => {
        this.watchRepo(r);
        this.schedule();
      }),
      api.onDidCloseRepository((r) => {
        this.unwatchRepo(r);
        this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
    );
    if (api.state === 'initialized') onReady();
    else {
      const d = api.onDidChangeState((s) => {
        if (s !== 'initialized') return;
        d.dispose();
        onReady();
      });
      this.apiSubs.push(d);
    }
  }

  private detachApi() {
    for (const d of this.apiSubs) d.dispose();
    this.apiSubs = [];
    for (const r of [...this.repoSubs.keys()]) this.unwatchRepo(r);
    this.api = undefined;
  }

  private watchRepo(r: GitRepository) {
    if (this.repoSubs.has(r)) return;
    this.repoSubs.set(r, [r.ui.onDidChange(() => this.schedule()), r.state.onDidChange(() => this.schedule())]);
  }

  private unwatchRepo(r: GitRepository) {
    for (const d of this.repoSubs.get(r) ?? []) d.dispose();
    this.repoSubs.delete(r);
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.recompute(false);
      } catch (err) {
        log.error('Resolving repository failed', err);
      }
    }, 150);
  }

  private pickRepository(repos: GitRepository[]): GitRepository | undefined {
    if (repos.length === 0) return undefined;
    if (repos.length === 1) return repos[0];
    // Several repositories can be "selected" (visible) in Source Control; then the editor decides among them.
    const selected = repos.filter((r) => r.ui.selected);
    if (selected.length === 1) return selected[0];
    if (selected.length > 1) repos = selected;
    const doc = vscode.window.activeTextEditor?.document.uri;
    if (doc?.scheme === 'file') {
      // Longest root wins for nested repositories.
      const match = repos
        .filter((r) => isInside(doc.fsPath, r.rootUri.fsPath))
        .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
      if (match) this.editorRoot = match.rootUri.fsPath;
    }
    if (this.editorRoot) {
      const remembered = repos.find((r) => norm(r.rootUri.fsPath) === norm(this.editorRoot!));
      if (remembered) return remembered;
    }
    return repos[0];
  }

  private recompute(force: boolean) {
    const api = this.api;
    if (!api) return;
    const repo = this.pickRepository(api.repositories);
    let next: RepoState;
    if (!repo) {
      next = {
        repo: null,
        reason: vscode.workspace.workspaceFolders?.length
          ? 'No Git repository found in this workspace.'
          : 'Open a folder that contains a Git repository.',
      };
    } else {
      const folder = path.basename(repo.rootUri.fsPath);
      const remote = pickRemote(repo.state.remotes);
      if (!remote) {
        next = {
          repo: null,
          reason:
            repo.state.remotes.length === 0
              ? `"${folder}" has no remotes. Add a GitHub remote to see its issues and pull requests.`
              : `No GitHub remote found in "${folder}". Only github.com remotes are supported.`,
        };
      } else {
        next = {
          repo: {
            owner: remote.owner,
            name: remote.name,
            url: `https://github.com/${remote.owner}/${remote.name}`,
            rootPath: repo.rootUri.fsPath,
            currentBranch: repo.state.HEAD?.name || undefined,
          },
          remoteName: remote.remote.name,
        };
      }
    }
    this.set(next, force);
  }

  private set(next: RepoState, force = false) {
    const changed = keyOf(next) !== keyOf(this.state);
    this.state = next;
    if (changed || force) {
      log.info(next.repo ? `Repository: ${next.repo.owner}/${next.repo.name} (${next.repo.currentBranch ?? 'detached'})` : `No repository: ${next.reason}`);
      this.emitter.fire(next);
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.detachApi();
    for (const d of this.subs) d.dispose();
  }
}
