// Owns the sidebar view and the detail panels, and routes webview messages to the API.
import * as vscode from 'vscode';
import type { GitHubApi } from '../shared/api';
import type { Session, ToExtension, ToWebview } from '../shared/protocol';
import type { ChangedFile, ItemKind, PullDetail, RepoRef } from '../shared/types';
import type { Auth } from './auth';
import { checkoutPull } from './checkout';
import { fileUri, GitHubContentProvider } from './diff';
import { errorMessage, UserError } from './errors';
import { buildHtml, webviewOptions } from './html';
import { log, showLog } from './log';
import type { RepoResolver, RepoState } from './repo';

const DETAIL_VIEW_TYPE = 'airGithub.detail';
export const SIDEBAR_VIEW_ID = 'airGithub.sidebar';

interface Panel {
  key: string;
  panel: vscode.WebviewPanel;
  kind: ItemKind;
  number: number;
  /** Repository the item belongs to (fixed at creation, so a repo switch does not change what it shows). */
  repo: RepoRef;
}

/** Per-webview context for message handling. */
type Target = { kind: 'sidebar'; webview: vscode.Webview } | { kind: 'detail'; webview: vscode.Webview; panel: Panel };

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function isMessage(m: unknown): m is ToExtension {
  return !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string';
}

function isKind(k: unknown): k is ItemKind {
  return k === 'issue' || k === 'pull';
}

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export class Controller implements vscode.WebviewViewProvider, vscode.Disposable {
  private sidebar: vscode.WebviewView | undefined;
  private readonly panels = new Map<string, Panel>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly auth: Auth,
    private readonly repos: RepoResolver,
    private readonly getApi: () => GitHubApi,
    private readonly content: GitHubContentProvider,
  ) {
    this.subs.push(
      repos.onDidChange(() => {
        // Repo switched: new session, then reload the list.
        void this.pushSessionToSidebar().then(() => this.postSidebar({ type: 'refresh' }));
      }),
      auth.onDidChange(({ accountChanged }) => {
        void this.broadcastSession().then(() => {
          if (accountChanged) this.broadcast({ type: 'refresh' });
        });
      }),
    );
  }

  // ---------------- session ----------------

  private async buildSession(repoOverride?: RepoRef): Promise<Session> {
    const s = await this.auth.current();
    let state: RepoState;
    if (repoOverride) {
      // Keep the panel's repo, but refresh the current branch if it is the same checkout.
      const cur = this.repos.snapshot.repo;
      state = { repo: cur && cur.rootPath === repoOverride.rootPath && cur.owner === repoOverride.owner && cur.name === repoOverride.name ? cur : repoOverride };
    } else {
      state = await this.repos.current();
    }
    let user = null;
    if (s) {
      try {
        user = await this.auth.viewer();
      } catch (err) {
        log.error('Fetching the signed-in user failed', err);
      }
    }
    const reason = !s ? (state.repo ? 'Sign in to GitHub to see issues and pull requests.' : state.reason) : state.reason;
    return { signedIn: !!s, user, repo: state.repo, ...(reason ? { reason } : {}) };
  }

  private async pushSession(t: Target): Promise<void> {
    const session = await this.buildSession(t.kind === 'detail' ? t.panel.repo : undefined);
    await this.post(t.webview, { type: 'session', session });
  }

  private async pushSessionToSidebar(): Promise<void> {
    if (this.sidebar) await this.pushSession({ kind: 'sidebar', webview: this.sidebar.webview }).catch((err) => log.error('session', err));
  }

  async broadcastSession(): Promise<void> {
    const jobs: Promise<void>[] = [this.pushSessionToSidebar()];
    for (const p of this.panels.values()) {
      jobs.push(this.pushSession({ kind: 'detail', webview: p.panel.webview, panel: p }).catch((err) => log.error('session', err)));
    }
    await Promise.all(jobs);
  }

  // ---------------- posting ----------------

  private async post(webview: vscode.Webview, msg: ToWebview): Promise<void> {
    try {
      await webview.postMessage(msg);
    } catch (err) {
      // The webview may have been disposed meanwhile.
      log.warn(`postMessage(${msg.type}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private postSidebar(msg: ToWebview): void {
    if (this.sidebar) void this.post(this.sidebar.webview, msg);
  }

  /** Posts to the sidebar and every open detail panel. */
  broadcast(msg: ToWebview): void {
    this.postSidebar(msg);
    for (const p of this.panels.values()) void this.post(p.panel.webview, msg);
  }

  // ---------------- sidebar ----------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebar = view;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = buildHtml(view.webview, this.extensionUri, 'sidebar', 'GitHub');
    const target: Target = { kind: 'sidebar', webview: view.webview };
    const sub = view.webview.onDidReceiveMessage((m) => this.handle(m, target));
    view.onDidDispose(() => {
      sub.dispose();
      if (this.sidebar === view) this.sidebar = undefined;
    });
  }

  // ---------------- detail panels ----------------

  async openItem(kind: ItemKind, number: number, repo?: RepoRef | null): Promise<void> {
    repo ??= (await this.repos.current()).repo;
    if (!repo) {
      void vscode.window.showWarningMessage((await this.repos.current()).reason ?? 'No GitHub repository is open.');
      return;
    }
    const key = `${repo.owner}/${repo.name}:${kind}-${number}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(undefined, false);
      void this.post(existing.panel.webview, { type: 'showItem', kind, number });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      DETAIL_VIEW_TYPE,
      `#${number}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { ...webviewOptions(this.extensionUri), retainContextWhenHidden: true, enableFindWidget: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'github.svg');
    const entry: Panel = { key, panel, kind, number, repo };
    this.panels.set(key, entry);
    panel.webview.html = buildHtml(panel.webview, this.extensionUri, 'detail', `#${number}`);
    const target: Target = { kind: 'detail', webview: panel.webview, panel: entry };
    const sub = panel.webview.onDidReceiveMessage((m) => this.handle(m, target));
    panel.onDidDispose(() => {
      sub.dispose();
      if (this.panels.get(key) === entry) this.panels.delete(key);
    });
  }

  private setPanelTitle(p: Panel, title: string) {
    p.panel.title = truncate(`#${p.number} ${title}`, 40);
  }

  // ---------------- message routing ----------------

  private handle(raw: unknown, t: Target): void {
    if (!isMessage(raw)) return;
    void this.route(raw, t).catch((err) => {
      log.error(`Handling "${raw.type}" failed`, err);
      const requestId = 'requestId' in raw && typeof raw.requestId === 'string' ? raw.requestId : undefined;
      void this.post(t.webview, { type: 'error', ...(requestId ? { requestId } : {}), message: errorMessage(err) });
    });
  }

  private async requireRepo(t: Target): Promise<RepoRef> {
    if (t.kind === 'detail') return t.panel.repo;
    const s = await this.repos.current();
    if (!s.repo) throw new UserError(s.reason ?? 'No GitHub repository is open.');
    return s.repo;
  }

  private async requireViewerLogin(): Promise<string> {
    if (!(await this.auth.current())) throw new UserError('Sign in to GitHub to continue.');
    const user = await this.auth.viewer();
    if (!user) throw new UserError('Sign in to GitHub to continue.');
    return user.login;
  }

  private async route(m: ToExtension, t: Target): Promise<void> {
    switch (m.type) {
      case 'ready': {
        await this.pushSession(t);
        if (t.kind === 'detail') await this.post(t.webview, { type: 'showItem', kind: t.panel.kind, number: t.panel.number });
        return;
      }
      case 'refresh':
        await this.pushSession(t);
        return;
      case 'signIn':
        await this.signIn();
        return;
      case 'list': {
        if (!isKind(m.kind) || !m.filter) throw new UserError('Invalid list request.');
        const repo = await this.requireRepo(t);
        const login = await this.requireViewerLogin();
        const page = await this.getApi().list(repo.owner, repo.name, m.kind, m.filter, login, m.cursor ?? null);
        await this.post(t.webview, { type: 'listResult', requestId: m.requestId, kind: m.kind, page, append: !!m.cursor });
        return;
      }
      case 'openItem':
        if (!isKind(m.kind) || !isPosInt(m.number)) return;
        await this.openItem(m.kind, m.number, t.kind === 'detail' ? t.panel.repo : undefined);
        return;
      case 'detail': {
        if (!isKind(m.kind) || !isPosInt(m.number)) throw new UserError('Invalid item.');
        const repo = await this.requireRepo(t);
        await this.requireViewerLogin();
        const item = await this.getApi().detail(repo.owner, repo.name, m.kind, m.number);
        if (t.kind === 'detail' && t.panel.kind === m.kind && t.panel.number === m.number) this.setPanelTitle(t.panel, item.title);
        await this.post(t.webview, { type: 'detailResult', requestId: m.requestId, item });
        return;
      }
      case 'addComment': {
        if (!isKind(m.kind) || !isPosInt(m.number)) throw new UserError('Invalid item.');
        if (typeof m.body !== 'string' || !m.body.trim()) throw new UserError('The comment is empty.');
        const repo = await this.requireRepo(t);
        await this.requireViewerLogin();
        const entry = await this.getApi().addComment(repo.owner, repo.name, m.kind, m.number, m.body);
        await this.post(t.webview, { type: 'commentAdded', requestId: m.requestId, entry });
        return;
      }
      case 'openExternal':
        await this.openExternal(m.url);
        return;
      case 'checkoutPull':
        if (!isPosInt(m.number)) return;
        await this.checkout(await this.requireRepo(t), m.number);
        return;
      case 'openFileDiff':
        if (!isPosInt(m.number) || typeof m.path !== 'string') return;
        await this.openFileDiff(await this.requireRepo(t), m.number, m.path);
        return;
      default:
        log.warn(`Unknown message type: ${(m as { type: string }).type}`);
    }
  }

  // ---------------- actions ----------------

  async signIn(): Promise<void> {
    const ok = await this.auth.signIn();
    await this.broadcastSession();
    if (ok) this.broadcast({ type: 'refresh' });
  }

  private async openExternal(url: unknown): Promise<void> {
    if (typeof url !== 'string') return;
    let parsed: vscode.Uri;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      parsed = vscode.Uri.parse(u.toString(), true);
    } catch {
      log.warn(`Refusing to open non-http(s) URL: ${url}`);
      return;
    }
    await vscode.env.openExternal(parsed);
  }

  private async checkout(repo: RepoRef, number: number): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out pull request #${number}…`, cancellable: false },
      async () => {
        try {
          await this.requireViewerLogin();
          const pr = (await this.getApi().detail(repo.owner, repo.name, 'pull', number)) as PullDetail;
          if (!pr.headRef) throw new UserError(`Pull request #${number} has no head branch.`);
          const remote = this.repos.remoteNameFor(repo.rootPath);
          const branch = await checkoutPull(repo, remote, number, pr.headRef);
          void vscode.window.showInformationMessage(`Checked out pull request #${number} on branch "${branch}".`);
        } catch (err) {
          log.error(`Checkout of #${number} failed`, err);
          void vscode.window.showErrorMessage(`Could not check out #${number}: ${errorMessage(err)}`, 'Show Log').then((a) => {
            if (a) showLog();
          });
        }
      },
    );
  }

  private async openFileDiff(repo: RepoRef, number: number, filePath: string): Promise<void> {
    const fallback = `${repo.url}/pull/${number}/files`;
    try {
      await this.requireViewerLogin();
      const pr = (await this.getApi().detail(repo.owner, repo.name, 'pull', number)) as PullDetail;
      const file: ChangedFile | undefined = pr.files?.find((f) => f.path === filePath);
      const change = (file?.changeType ?? 'MODIFIED').toUpperCase();
      const headRefs = change === 'DELETED' ? [] : [`refs/pull/${number}/head`, pr.headRef].filter(Boolean);
      const baseRefs = change === 'ADDED' ? [] : [pr.baseRef].filter(Boolean);
      const missingOk = change !== 'MODIFIED' && change !== 'CHANGED';
      const left = fileUri(filePath, { owner: repo.owner, repo: repo.name, refs: baseRefs, emptyIfMissing: missingOk }, 'base');
      const right = fileUri(filePath, { owner: repo.owner, repo: repo.name, refs: headRefs, emptyIfMissing: missingOk }, 'head');
      // Fetch both sides up front so failures fall back to the browser instead of an empty diff.
      await Promise.all([this.content.load(left), this.content.load(right)]);
      const name = filePath.split('/').pop() ?? filePath;
      await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (#${number}: ${pr.baseRef} ↔ ${pr.headRef})`, {
        preview: true,
      } satisfies vscode.TextDocumentShowOptions);
    } catch (err) {
      log.error(`Opening diff for ${filePath} failed, opening in browser`, err);
      await vscode.env.openExternal(vscode.Uri.parse(fallback));
    }
  }

  /** Command: ask for a number and open it, detecting whether it is a pull request or an issue. */
  async openItemByNumber(): Promise<void> {
    const repo = (await this.repos.current()).repo;
    if (!repo) {
      void vscode.window.showWarningMessage((await this.repos.current()).reason ?? 'No GitHub repository is open.');
      return;
    }
    const input = await vscode.window.showInputBox({
      title: `Open issue or pull request in ${repo.owner}/${repo.name}`,
      prompt: 'Issue or pull request number',
      placeHolder: '#123',
      validateInput: (v) => (/^\s*#?\d+\s*$/.test(v) && Number(v.replace(/[#\s]/g, '')) > 0 ? undefined : 'Enter a number, e.g. 123'),
    });
    if (input === undefined) return;
    const number = Number(input.replace(/[#\s]/g, ''));
    let kind: ItemKind | undefined;
    if (await this.auth.current()) {
      kind = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Looking up #${number}` }, async () => {
        for (const k of ['pull', 'issue'] as const) {
          try {
            await this.getApi().detail(repo.owner, repo.name, k, number);
            return k;
          } catch (err) {
            log.info(`#${number} is not a ${k}: ${errorMessage(err)}`);
          }
        }
        return undefined;
      });
    }
    if (!kind) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(git-pull-request) Pull request', itemKind: 'pull' as const },
          { label: '$(issues) Issue', itemKind: 'issue' as const },
        ],
        { title: `Open #${number} as…` },
      );
      kind = pick?.itemKind;
    }
    if (kind) await this.openItem(kind, number, repo);
  }

  dispose() {
    for (const p of [...this.panels.values()]) p.panel.dispose();
    this.panels.clear();
    for (const d of this.subs) d.dispose();
  }
}
