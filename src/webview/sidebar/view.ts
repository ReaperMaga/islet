// HTML builders for the sidebar. Plain strings; every piece of user content goes through esc().

import type { Session } from '../../shared/protocol';
import type { ChecksState, ItemKind, ItemSummary, ListFilter, ReviewDecision } from '../../shared/types';
import { avatar, esc, fullDate, icons, labelPill, relTime, stateIcon, stateText } from '../shared/ui';
import { SCOPE_LABELS, STATE_LABELS } from './state';

// ---- local icons (same 16px line style as shared/ui.ts) ----

const svg = (body: string, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const localIcons = {
  repo: (c?: string) => svg('<path d="M3.5 12.5V3a1 1 0 0 1 1-1H12.5v9.5H4.5a1 1 0 0 0-1 1 1 1 0 0 0 1 1H12.5"/><path d="M6 2v5l1.25-1 1.25 1V2"/>', c),
  close: (c?: string) => svg('<path d="M5 5l6 6M11 5l-6 6"/>', c),
  alert: (c?: string) => svg('<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5"/><circle cx="8" cy="11" r=".6" fill="currentColor"/>', c),
  changes: (c?: string) => svg('<path d="M4 2h5l3 3v9H4z"/><path d="M8 6.5v4M6 8.5h4"/>', c),
  arrow: (c?: string) => svg('<path d="M3 8h9.5M9.5 5l3 3-3 3"/>', c),
  lock: (c?: string) => svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>', c),
  folder: (c?: string) => svg('<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>', c),
};

// ---- header ----

export function headerHtml(session: Session | null): string {
  const repo = session?.repo;
  const user = session?.user;
  const identity = repo
    ? `<span class="repo-name mono" title="${esc(repo.owner)}/${esc(repo.name)}"><span class="repo-owner">${esc(repo.owner)}</span><span class="repo-slash">/</span><span class="repo-short">${esc(repo.name)}</span></span>
       ${repo.currentBranch ? `<span class="branch-pill mono" title="Current branch: ${esc(repo.currentBranch)}">${icons.branch('icon xs')}<span class="ellipsis">${esc(repo.currentBranch)}</span></span>` : ''}`
    : `<span class="skeleton sk-repo"></span>`;
  const me = user ? `<span class="me" title="Signed in as ${esc(user.login)}">${avatar(user)}</span>` : '';
  return `<div class="repo">${localIcons.repo('icon repo-icon')}${identity}<span class="grow"></span>${me}</div>`;
}

export function tabsHtml(active: ItemKind, counts: Partial<Record<ItemKind, number>>): string {
  const tab = (kind: ItemKind, icon: string, long: string, short: string) => {
    const n = counts[kind];
    const on = kind === active;
    return `<button class="seg-btn tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-tab="${kind}" tabindex="${on ? 0 : -1}">
      ${icon}<span class="lbl-long">${long}</span><span class="lbl-short">${short}</span>
      ${n !== undefined ? `<span class="count mono">${formatCount(n)}</span>` : ''}
    </button>`;
  };
  return `<div class="seg tabs" role="tablist" aria-label="Item type">
    ${tab('issue', icons.issueOpen('icon sm'), 'Issues', 'Issues')}
    ${tab('pull', icons.pullOpen('icon sm'), 'Pull requests', 'PRs')}
  </div>`;
}

function formatCount(n: number): string {
  return n >= 10000 ? `${Math.floor(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

export function filtersHtml(kind: ItemKind, filter: ListFilter, menuOpen: boolean): string {
  const states = (['open', 'closed', 'all'] as const)
    .map((s) => `<button class="seg-btn${filter.state === s ? ' on' : ''}" data-state="${s}" aria-pressed="${filter.state === s}">${STATE_LABELS[s]}</button>`)
    .join('');
  const scopes = (['all', 'mine', 'assigned', 'review'] as const).filter((s) => s !== 'review' || kind === 'pull');
  const menu = menuOpen
    ? `<div class="menu" role="menu" aria-label="Scope">
        ${scopes
          .map((s) => `<button class="menu-item${filter.scope === s ? ' on' : ''}" role="menuitemradio" aria-checked="${filter.scope === s}" data-scope="${s}">
              <span class="menu-check">${filter.scope === s ? icons.check('icon sm') : ''}</span>${SCOPE_LABELS[s]}
            </button>`)
          .join('')}
      </div>`
    : '';
  const scoped = filter.scope !== 'all';
  return `<div class="seg states" role="group" aria-label="State">${states}</div>
    <div class="scope-wrap">
      <button class="scope-btn${scoped ? ' active' : ''}${menuOpen ? ' open' : ''}" data-action="scope" aria-haspopup="menu" aria-expanded="${menuOpen}" title="Scope: ${SCOPE_LABELS[filter.scope]}">
        ${icons.user('icon sm')}<span class="ellipsis scope-lbl">${SCOPE_LABELS[filter.scope]}</span>${icons.chevronDown('icon xs chev')}
      </button>
      ${menu}
    </div>`;
}

// ---- rows ----

const CHECKS: Record<Exclude<ChecksState, null>, { cls: string; title: string }> = {
  SUCCESS: { cls: 'ok', title: 'Checks passing' },
  FAILURE: { cls: 'fail', title: 'Checks failing' },
  PENDING: { cls: 'pending', title: 'Checks running' },
};

function reviewHtml(d: ReviewDecision | undefined): string {
  switch (d) {
    case 'APPROVED': return `<span class="review ok" title="Approved">${icons.check('icon sm')}</span>`;
    case 'CHANGES_REQUESTED': return `<span class="review fail" title="Changes requested">${localIcons.changes('icon sm')}</span>`;
    case 'REVIEW_REQUIRED': return `<span class="review wait" title="Review required">${icons.eye('icon sm')}</span>`;
    default: return '';
  }
}

export function rowHtml(item: ItemSummary, selected: boolean): string {
  const st = stateIcon(item);
  const isPull = item.kind === 'pull';
  const labels = item.labels.slice(0, 3).map(labelPill).join('');
  const rest = item.labels.slice(3);
  const more = rest.length ? `<span class="tag" title="${esc(rest.map((l) => l.name).join(', '))}">+${rest.length}</span>` : '';
  const draft = isPull && item.isDraft && item.state === 'open' ? '<span class="tag">Draft</span>' : '';
  const tagRow = draft || labels ? `<div class="row-labels">${draft}${labels}${more}</div>` : '';

  const checks = isPull && item.checks ? `<span class="checks ${CHECKS[item.checks].cls}" title="${CHECKS[item.checks].title}"></span>` : '';
  const review = isPull && item.state === 'open' ? reviewHtml(item.reviewDecision) : '';
  const status = checks || review ? `<span class="pr-status">${checks}${review}</span>` : '';

  const comments = item.commentCount > 0
    ? `<span class="comments mono" title="${item.commentCount} comment${item.commentCount === 1 ? '' : 's'}">${icons.comment('icon xs')}${item.commentCount}</span>`
    : '';
  const author = item.author
    ? `<span class="who">${avatar(item.author)}<span class="ellipsis">${esc(item.author.login)}</span></span>`
    : `<span class="who"><span class="ellipsis">ghost</span></span>`;
  const branch = isPull && item.headRef
    ? `<div class="row-branch mono" title="${esc(item.headRef)} into ${esc(item.baseRef ?? '')}"><span class="ellipsis br-head">${esc(item.headRef)}</span>${localIcons.arrow('icon xs')}<span class="base">${esc(item.baseRef ?? '')}</span></div>`
    : '';

  const aria = `${stateText(item)} ${isPull ? 'pull request' : 'issue'} #${item.number}: ${item.title}`;
  return `<div class="row${selected ? ' selected' : ''}" role="option" tabindex="-1" aria-selected="${selected}" data-kind="${item.kind}" data-number="${item.number}" aria-label="${esc(aria)}">
    <span class="row-icon tone-${st.tone}" title="${stateText(item)}">${st.html}</span>
    <div class="row-body">
      <div class="row-top"><span class="row-title">${esc(item.title)}</span>${comments}</div>
      <div class="row-meta">
        <span class="num mono">#${item.number}</span><span class="sep">·</span>${author}<span class="sep">·</span><time datetime="${esc(item.updatedAt)}" title="Updated ${esc(fullDate(item.updatedAt))}">${esc(relTime(item.updatedAt))}</time>${status}
      </div>
      ${tagRow}${branch}
    </div>
  </div>`;
}

export function skeletonRows(n: number): string {
  const widths = [86, 64, 92, 72, 58, 80, 68, 90];
  let out = '';
  for (let i = 0; i < n; i++) {
    const w = widths[i % widths.length];
    out += `<div class="row sk-row" aria-hidden="true">
      <span class="skeleton sk-icon"></span>
      <div class="row-body">
        <span class="skeleton sk-line" style="width:${w}%"></span>
        <span class="skeleton sk-line sm" style="width:${Math.max(36, w - 34)}%"></span>
      </div>
    </div>`;
  }
  return out;
}

// ---- states ----

export function emptyResultsHtml(kind: ItemKind, filter: ListFilter, filtered: boolean): string {
  const what = kind === 'issue' ? 'issues' : 'pull requests';
  const q = filter.query.trim();
  const line = q
    ? `No ${what} match <span class="q">“${esc(q)}”</span>`
    : filtered
      ? `No ${filter.state === 'all' ? '' : STATE_LABELS[filter.state].toLowerCase() + ' '}${what} for this filter`
      : `No open ${what}. Nice and quiet.`;
  return `<div class="calm">
    <p>${line}</p>
    ${filtered ? '<button class="link-btn" data-action="clear">Clear filters</button>' : ''}
  </div>`;
}

export function errorBanner(message: string, compact = false): string {
  return `<div class="banner${compact ? ' compact' : ''}" role="alert">
    <span class="banner-icon">${localIcons.alert('icon sm')}</span>
    <span class="banner-msg">${esc(message)}</span>
    <button class="btn sm" data-action="retry">${icons.refresh('icon xs')}Retry</button>
  </div>`;
}

export function signedOutHtml(): string {
  return `<div class="hero">
    <div class="hero-mark">${icons.pullOpen('icon')}</div>
    <h2>Connect to GitHub</h2>
    <p>Sign in to see the issues and pull requests of this repository, right next to your code.</p>
    <button class="btn primary" data-action="signin">Sign in to GitHub</button>
    <p class="fine">Uses VS Code’s built-in GitHub account. Nothing is stored by this extension.</p>
  </div>`;
}

export function noRepoHtml(reason: string | undefined): string {
  return `<div class="hero">
    <div class="hero-mark">${localIcons.folder('icon')}</div>
    <h2>No GitHub repository</h2>
    <p>${esc(reason || 'This workspace has no repository with a GitHub remote.')}</p>
    <p class="fine">Open a folder whose git <span class="mono">origin</span> points to GitHub, or pick a repository in Source Control.</p>
  </div>`;
}
