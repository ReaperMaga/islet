// GitHub GraphQL v4 client implementing the shared GitHubApi interface.

import type { GitHubApi, TokenProvider } from '../shared/api';
import type { ItemKind, ListFilter, ListPage } from '../shared/types';
import * as Q from './queries';
import { comment, issueDetail, pullDetail, summary, user } from './map';

const ENDPOINT = 'https://api.github.com/graphql';
const PAGE_SIZE = 25;

function minutesUntil(resetHeader: string | null): number {
  const reset = Number(resetHeader);
  if (!reset) return 1;
  return Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000));
}

function rateLimitError(res: Response): Error {
  const retryAfter = Number(res.headers.get('retry-after'));
  const min = retryAfter ? Math.max(1, Math.ceil(retryAfter / 60)) : minutesUntil(res.headers.get('x-ratelimit-reset'));
  return new Error(`GitHub rate limit reached, try again in ${min} min`);
}

/** Builds the search query string for list(). Returns null when the combination can't match anything. */
export function buildSearchQuery(owner: string, repo: string, kind: ItemKind, filter: ListFilter, viewerLogin: string): string | null {
  const parts = [`repo:${owner}/${repo}`, kind === 'pull' ? 'is:pr' : 'is:issue'];
  if (filter.state === 'open') parts.push('is:open');
  else if (filter.state === 'closed') parts.push('is:closed');
  switch (filter.scope) {
    case 'mine': parts.push(`author:${viewerLogin}`); break;
    case 'assigned': parts.push(`assignee:${viewerLogin}`); break;
    case 'review':
      if (kind !== 'pull') return null;
      parts.push(`review-requested:${viewerLogin}`);
      break;
  }
  const text = filter.query.trim();
  if (text) parts.push(text);
  parts.push('sort:updated-desc');
  return parts.join(' ');
}

export function createGitHubApi(getToken: TokenProvider): GitHubApi {
  async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await getToken();
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'air-github-vscode',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error("Can't reach GitHub");
    }

    if (res.status === 401) throw new Error('GitHub sign-in expired');
    if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'))) {
      throw rateLimitError(res);
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new Error(res.ok ? 'Unexpected response from GitHub' : `GitHub error ${res.status}`);
    }
    if (!res.ok && !json?.errors) throw new Error(json?.message || `GitHub error ${res.status}`);

    const errors: any[] | undefined = json?.errors;
    if (errors?.length) {
      if (errors.some((e) => e.type === 'RATE_LIMITED')) throw rateLimitError(res);
      throw new Error(errors[0]?.message || 'GitHub request failed');
    }
    return json.data as T;
  }

  return {
    async viewer() {
      const data = await gql(Q.VIEWER);
      const u = user(data.viewer);
      if (!u) throw new Error('GitHub sign-in expired');
      return u;
    },

    async list(owner, repo, kind, filter, viewerLogin, cursor): Promise<ListPage> {
      const q = buildSearchQuery(owner, repo, kind, filter, viewerLogin);
      if (!q) return { items: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 };
      const data = await gql(Q.SEARCH, { q, first: PAGE_SIZE, after: cursor ?? null });
      const s = data.search;
      return {
        items: (s.nodes ?? []).filter((n: any) => n && n.number != null).map(summary),
        pageInfo: { hasNextPage: !!s.pageInfo?.hasNextPage, endCursor: s.pageInfo?.endCursor ?? null },
        totalCount: s.issueCount ?? 0,
      };
    },

    async detail(owner, repo, kind, number) {
      const vars = { owner, name: repo, number };
      if (kind === 'pull') {
        const data = await gql(Q.PULL_DETAIL, vars);
        const pr = data.repository?.pullRequest;
        if (!pr) throw new Error(`Pull request #${number} not found`);
        return pullDetail(pr, !!data.repository.isArchived);
      }
      const data = await gql(Q.ISSUE_DETAIL, vars);
      const issue = data.repository?.issue;
      if (!issue) throw new Error(`Issue #${number} not found`);
      return issueDetail(issue, !!data.repository.isArchived);
    },

    async addComment(owner, repo, _kind, number, body) {
      const idData = await gql(Q.NODE_ID, { owner, name: repo, number });
      const subjectId = idData.repository?.issueOrPullRequest?.id;
      if (!subjectId) throw new Error(`#${number} not found`);
      const data = await gql(Q.ADD_COMMENT, { subjectId, body });
      const node = data.addComment?.commentEdge?.node;
      if (!node) throw new Error('Comment was not created');
      return comment(node);
    },
  };
}
