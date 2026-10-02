// Messages between the webviews and the extension host (postMessage).
// Every request from a webview carries a requestId; the matching response echoes it.

import type { ItemDetail, ItemKind, ListFilter, ListPage, RepoRef, TimelineEntry, UserLite } from './types';

// ---------- webview -> extension ----------

export type ToExtension =
  /** Webview finished loading; extension replies with a 'session' message. */
  | { type: 'ready' }
  | { type: 'signIn' }
  | { type: 'list'; requestId: string; kind: ItemKind; filter: ListFilter; cursor?: string | null }
  /** Sidebar asks to open an item in the detail editor tab. */
  | { type: 'openItem'; kind: ItemKind; number: number }
  /** Detail panel asks for its data. */
  | { type: 'detail'; requestId: string; kind: ItemKind; number: number }
  | { type: 'addComment'; requestId: string; kind: ItemKind; number: number; body: string }
  | { type: 'openExternal'; url: string }
  /** Detail panel: check out the pull request branch locally. */
  | { type: 'checkoutPull'; number: number }
  /** Detail panel: open a changed file of a pull request as a diff (base vs head). */
  | { type: 'openFileDiff'; number: number; path: string }
  | { type: 'refresh' };

// ---------- extension -> webview ----------

export interface Session {
  signedIn: boolean;
  user: UserLite | null;
  repo: RepoRef | null;
  /** Why repo/user is missing, shown as an empty state, e.g. "No GitHub remote found". */
  reason?: string;
}

export type ToWebview =
  | { type: 'session'; session: Session }
  | { type: 'listResult'; requestId: string; kind: ItemKind; page: ListPage; append: boolean }
  | { type: 'detailResult'; requestId: string; item: ItemDetail }
  | { type: 'commentAdded'; requestId: string; entry: TimelineEntry }
  | { type: 'error'; requestId?: string; message: string }
  /** Extension asks the webview to reload its data (refresh command, repo switched). */
  | { type: 'refresh' }
  /** Detail panel only: which item to show (sent right after the panel is created or reused). */
  | { type: 'showItem'; kind: ItemKind; number: number };
