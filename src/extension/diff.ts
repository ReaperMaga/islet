// Read-only file contents at a GitHub ref, served under the "islet:" scheme for vscode.diff.
import * as vscode from 'vscode';
import type { TokenProvider } from '../shared/api';
import { log } from './log';

export const SCHEME = 'islet';

interface FileQuery {
  owner: string;
  repo: string;
  /** Refs to try in order (first that exists wins). Empty = empty document. */
  refs: string[];
  /** Treat "not found" as an empty file (added/removed/renamed files). */
  emptyIfMissing: boolean;
}

export function fileUri(path: string, q: FileQuery, label: string): vscode.Uri {
  const query = new URLSearchParams({ owner: q.owner, repo: q.repo, refs: q.refs.join('\n'), empty: q.emptyIfMissing ? '1' : '0', label });
  // Keep the real file path so the editor picks the right language mode.
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + path.replace(/^\/+/, ''), query: query.toString() });
}

function parse(uri: vscode.Uri): FileQuery & { path: string } {
  const q = new URLSearchParams(uri.query);
  return {
    owner: q.get('owner') ?? '',
    repo: q.get('repo') ?? '',
    refs: (q.get('refs') ?? '').split('\n').filter(Boolean),
    emptyIfMissing: q.get('empty') === '1',
    path: uri.path.replace(/^\/+/, ''),
  };
}

export class GitHubContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly getToken: TokenProvider) {}

  /** Loads (and caches) the content; rejects on failure so callers can fall back. */
  load(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    let p = this.cache.get(key);
    if (!p) {
      p = this.fetchContent(parse(uri));
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
      // Keep the cache small; documents are re-requested only when reopened.
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      return await this.load(uri);
    } catch (err) {
      log.error(`Loading ${uri.toString()} failed`, err);
      return '';
    }
  }

  private async fetchContent(q: FileQuery & { path: string }): Promise<string> {
    if (q.refs.length === 0) return '';
    const token = await this.getToken();
    const encodedPath = q.path.split('/').map(encodeURIComponent).join('/');
    let lastStatus = 0;
    for (const ref of q.refs) {
      const url = `https://api.github.com/repos/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.raw',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'islet-vscode',
        },
      });
      if (res.ok) return await res.text();
      lastStatus = res.status;
      if (res.status !== 404) break;
    }
    if (lastStatus === 404 && q.emptyIfMissing) return '';
    const err = new Error(`GitHub returned HTTP ${lastStatus} for ${q.path}`);
    (err as { status?: number }).status = lastStatus;
    throw err;
  }

  dispose() {
    this.cache.clear();
  }
}
