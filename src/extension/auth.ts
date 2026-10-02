// GitHub authentication through VS Code's built-in provider. No tokens are stored by us.
import * as vscode from 'vscode';
import type { GitHubApi } from '../shared/api';
import type { UserLite } from '../shared/types';
import { log } from './log';

const PROVIDER = 'github';
const SCOPES = ['repo'];

export class Auth implements vscode.Disposable {
  private session: vscode.AuthenticationSession | undefined;
  private loaded: Promise<void> | undefined;
  private viewerCache = new Map<string, Promise<UserLite>>();
  private readonly emitter = new vscode.EventEmitter<{ accountChanged: boolean }>();
  /** Fires when the GitHub session changed (sign in/out, account switch, token refresh). */
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly getApi: () => GitHubApi, private readonly devToken?: string) {
    this.subs.push(
      this.emitter,
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id !== PROVIDER) return;
        void this.reload().then(
          (accountChanged) => this.emitter.fire({ accountChanged }),
          (err) => log.error('Reloading GitHub session failed', err),
        );
      }),
    );
  }

  /** Current session without prompting. */
  async current(): Promise<vscode.AuthenticationSession | undefined> {
    this.loaded ??= this.reload().then(() => undefined);
    await this.loaded;
    return this.session;
  }

  /** Interactive sign-in. Returns false if the user cancelled. */
  async signIn(): Promise<boolean> {
    try {
      const s = await vscode.authentication.getSession(PROVIDER, SCOPES, { createIfNone: true });
      this.setSession(s);
      return true;
    } catch (err) {
      log.warn(`Sign-in cancelled or failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** TokenProvider for the API client. */
  readonly getToken = async (): Promise<string> => {
    const s = await this.current();
    if (!s) throw new Error('Not signed in to GitHub.');
    return s.accessToken;
  };

  /** Signed-in user, fetched once per token. Returns null when signed out. */
  async viewer(): Promise<UserLite | null> {
    const s = await this.current();
    if (!s) return null;
    let p = this.viewerCache.get(s.accessToken);
    if (!p) {
      p = this.getApi().viewer();
      this.viewerCache.set(s.accessToken, p);
      p.catch(() => this.viewerCache.delete(s.accessToken));
    }
    return p;
  }

  /** Reloads the session silently. Returns true if the account/token changed. */
  private async reload(): Promise<boolean> {
    let s: vscode.AuthenticationSession | undefined;
    if (this.devToken) {
      return this.setSession({ id: 'dev', accessToken: this.devToken, account: { id: 'dev', label: 'dev token' }, scopes: SCOPES });
    }
    try {
      s = await vscode.authentication.getSession(PROVIDER, SCOPES, { createIfNone: false, silent: true });
    } catch (err) {
      log.error('Reading GitHub session failed', err);
      s = undefined;
    }
    return this.setSession(s);
  }

  private setSession(s: vscode.AuthenticationSession | undefined): boolean {
    const changed = this.session?.accessToken !== s?.accessToken;
    if (changed) {
      this.viewerCache.clear();
      log.info(s ? `Signed in to GitHub as ${s.account.label}` : 'Not signed in to GitHub');
    }
    this.session = s;
    this.loaded = Promise.resolve();
    return changed;
  }

  dispose() {
    for (const d of this.subs) d.dispose();
  }
}
