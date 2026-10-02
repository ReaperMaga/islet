// Interface of the GitHub API layer (implemented in src/api/github.ts).
// The extension host only talks to GitHub through this interface.

import type { ItemDetail, ItemKind, ListFilter, ListPage, TimelineEntry, UserLite } from './types';

export interface GitHubApi {
  viewer(): Promise<UserLite>;
  list(owner: string, repo: string, kind: ItemKind, filter: ListFilter, viewerLogin: string, cursor?: string | null): Promise<ListPage>;
  detail(owner: string, repo: string, kind: ItemKind, number: number): Promise<ItemDetail>;
  addComment(owner: string, repo: string, kind: ItemKind, number: number, body: string): Promise<TimelineEntry>;
}

/** Returns a GitHub OAuth token; may prompt the user to sign in. */
export type TokenProvider = () => Promise<string>;
