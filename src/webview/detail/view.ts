// Header, tabs, sidebar, files and checks views, skeleton and empty states.

import type { Session } from '../../shared/protocol';
import type { ChangedFile, CheckRun, ItemDetail, PullDetail, ReviewState, UserLite } from '../../shared/types';
import { avatar, esc, icons, labelPill, stateIcon, stateText } from '../shared/ui';
import { reviewMeta, time, who } from './timeline';

export type Tab = 'conversation' | 'files' | 'checks';

export const isPull = (item: ItemDetail): item is PullDetail => item.kind === 'pull';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const num = (n: number) => n.toLocaleString('en-US');

// ---------- checks ----------

export type CheckTone = 'ok' | 'fail' | 'pending' | 'skip';

export function checkTone(c: CheckRun): CheckTone {
  if (c.status !== 'COMPLETED' && !c.conclusion) return 'pending';
  switch (c.conclusion) {
    case 'SUCCESS': return 'ok';
    case 'FAILURE': case 'TIMED_OUT': case 'CANCELLED': case 'ACTION_REQUIRED': case 'STARTUP_FAILURE': return 'fail';
    case 'NEUTRAL': case 'SKIPPED': case 'STALE': return 'skip';
    default: return c.conclusion ? 'skip' : 'pending';
  }
}

function checkIcon(tone: CheckTone): string {
  if (tone === 'ok') return icons.check('icon sm');
  if (tone === 'fail') return icons.cross('icon sm');
  if (tone === 'pending') return icons.dot('icon sm');
  return `<svg class="icon sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.5 11.5l7-7"/></svg>`;
}

function checkLabel(c: CheckRun, tone: CheckTone): string {
  if (tone === 'pending') return c.status === 'IN_PROGRESS' ? 'In progress' : c.status === 'QUEUED' ? 'Queued' : 'Pending';
  const s = (c.conclusion ?? '').toLowerCase().replace(/_/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function checkCounts(runs: CheckRun[]) {
  const c = { ok: 0, fail: 0, pending: 0, skip: 0 };
  for (const r of runs) c[checkTone(r)]++;
  return c;
}

// ---------- header ----------

function mergeState(pr: PullDetail): string {
  if (pr.state !== 'open') return '';
  if (pr.mergeable === 'CONFLICTING') return `<span class="merge-state fail">${icons.cross('icon sm')}Has conflicts</span>`;
  if (pr.mergeable === 'MERGEABLE') return `<span class="merge-state ok">${icons.check('icon sm')}No conflicts</span>`;
  return `<span class="merge-state muted">${icons.dot('icon sm')}Checking mergeability</span>`;
}

function branchRow(pr: PullDetail, session: Session | null): string {
  const current = session?.repo?.currentBranch === pr.headRef;
  return `<div class="branch-row">
    <span class="refs">
      <span class="ref" title="${esc(pr.headRef)}">${icons.branch('icon sm')}<span class="ref-name">${esc(pr.headRef)}</span></span>
      <span class="arrow" aria-label="into">→</span>
      <span class="ref" title="${esc(pr.baseRef)}">${icons.branch('icon sm')}<span class="ref-name">${esc(pr.baseRef)}</span></span>
      ${current ? `<span class="tag current">checked out</span>` : ''}
    </span>
    <span class="stats">
      <span class="diffstat"><span class="add">+${num(pr.additions)}</span><span class="del">−${num(pr.deletions)}</span></span>
      <span class="stat">${plural(pr.commitCount, 'commit')}</span>
      <span class="stat">${plural(pr.changedFiles, 'file')}</span>
      ${mergeState(pr)}
    </span>
  </div>`;
}

export function headerHTML(item: ItemDetail, session: Session | null, refreshing: boolean): string {
  const st = stateIcon(item, 'icon sm');
  const pr = isPull(item) ? item : null;
  const current = pr && session?.repo?.currentBranch === pr.headRef;
  let extra = '';
  if (pr?.state === 'merged') extra = `<span><span class="sep">· </span>merged${pr.mergedBy ? ` by ${who(pr.mergedBy)}` : ''} ${time(pr.mergedAt)}</span>`;
  else if (item.state === 'closed' && item.closedAt) extra = `<span><span class="sep">· </span>closed ${time(item.closedAt)}</span>`;
  return `<header class="island head">
    <div class="head-top">
      <div class="head-main">
        <h1 class="title">${esc(item.title)} <span class="num">#${item.number}</span></h1>
        <div class="meta">
          <span class="state-pill ${st.tone}">${st.html}${stateText(item)}</span>
          <span class="meta-who">${avatar(item.author)}${who(item.author)}</span>
          <span>opened ${time(item.createdAt)}</span>
          ${extra}
          <span class="meta-count" title="${plural(item.commentCount, 'comment')}"><span class="sep">·</span>${icons.comment('icon sm')}${num(item.commentCount)}</span>
        </div>
      </div>
      <div class="head-actions">
        ${pr && pr.state === 'open' ? `<button class="btn" data-action="checkout"${current ? ' disabled title="Already on this branch"' : ' title="Check out the head branch locally"'}>${icons.branch('icon sm')}${current ? 'Checked out' : 'Checkout'}</button>` : ''}
        <button class="btn" data-action="open-github" title="${esc(item.url)}">${icons.external('icon sm')}Open on GitHub</button>
        <button class="btn icon-btn${refreshing ? ' spinning' : ''}" data-action="refresh" title="Refresh" aria-label="Refresh">${icons.refresh('icon sm')}</button>
      </div>
    </div>
    ${pr ? branchRow(pr, session) : ''}
  </header>`;
}

// ---------- tabs ----------

export function tabsHTML(pr: PullDetail, tab: Tab): string {
  const t = (id: Tab, label: string, count?: number) =>
    `<button class="seg${tab === id ? ' active' : ''}" role="tab" aria-selected="${tab === id}" data-tab="${id}">${label}${count !== undefined ? `<span class="seg-count">${num(count)}</span>` : ''}</button>`;
  const comments = pr.timeline.filter((e) => e.type !== 'event').length;
  return `<nav class="segmented" role="tablist" aria-label="Pull request sections">
    ${t('conversation', 'Conversation', comments)}${t('files', 'Files changed', pr.changedFiles)}${t('checks', 'Checks', pr.checkRuns.length)}
  </nav>`;
}

// ---------- files ----------

function diffBar(f: ChangedFile): string {
  const total = f.additions + f.deletions;
  let g = 0, r = 0;
  if (total > 0) {
    const blocks = Math.min(5, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
    g = Math.round((f.additions / total) * blocks);
    r = blocks - g;
    if (f.additions && !g) { g = 1; r = Math.max(0, r - 1); }
    if (f.deletions && !r && blocks > 1) { r = 1; g -= 1; }
  }
  const cells = [...Array(g).fill('add'), ...Array(r).fill('del')];
  while (cells.length < 5) cells.push('none');
  return `<span class="diffbar" aria-hidden="true">${cells.map((c) => `<i class="${c}"></i>`).join('')}</span>`;
}

const CHANGE: Record<string, { text: string; tone: string }> = {
  ADDED: { text: 'Added', tone: 'add' },
  DELETED: { text: 'Deleted', tone: 'del' },
  MODIFIED: { text: 'Modified', tone: 'mod' },
  RENAMED: { text: 'Renamed', tone: 'ren' },
  COPIED: { text: 'Copied', tone: 'ren' },
  CHANGED: { text: 'Changed', tone: 'mod' },
};

export function filesHTML(pr: PullDetail): string {
  if (!pr.files.length) {
    return `<section class="island list-island"><div class="empty small">${icons.file('icon')}<div>No changed files to show.</div></div></section>`;
  }
  const rows = pr.files.map((f) => {
    const i = f.path.lastIndexOf('/');
    const dir = i >= 0 ? f.path.slice(0, i + 1) : '';
    const name = f.path.slice(i + 1);
    const c = CHANGE[f.changeType] ?? { text: f.changeType.toLowerCase(), tone: 'mod' };
    return `<button class="row file-row" data-action="diff" data-path="${esc(f.path)}" title="Open diff: ${esc(f.path)}">
      <span class="file-icon ${c.tone}">${icons.file('icon sm')}</span>
      <span class="path"><span class="dir">${esc(dir)}</span><span class="name">${esc(name)}</span></span>
      ${c.tone === 'mod' ? '<span></span>' : `<span class="ctag ${c.tone}">${esc(c.text)}</span>`}
      <span class="diffstat"><span class="add">+${num(f.additions)}</span><span class="del">−${num(f.deletions)}</span></span>
      ${diffBar(f)}
    </button>`;
  });
  const more = pr.changedFiles > pr.files.length
    ? `<div class="list-note">Showing ${num(pr.files.length)} of ${num(pr.changedFiles)} files. <a href="${esc(pr.url)}/files">View all on GitHub</a></div>`
    : '';
  return `<section class="island list-island">
    <div class="list-head">
      <span class="list-title">${plural(pr.changedFiles, 'file')} changed</span>
      <span class="diffstat"><span class="add">+${num(pr.additions)}</span><span class="del">−${num(pr.deletions)}</span></span>
    </div>
    <div class="rows">${rows.join('')}</div>
    ${more}
  </section>`;
}

// ---------- checks ----------

function checksSummaryText(runs: CheckRun[]): string {
  const c = checkCounts(runs);
  const parts: string[] = [];
  if (c.fail) parts.push(`<span class="fail">${c.fail} failing</span>`);
  if (c.pending) parts.push(`<span class="pending">${c.pending} pending</span>`);
  if (c.ok) parts.push(`<span class="ok">${c.ok} passed</span>`);
  if (c.skip) parts.push(`<span class="skip">${c.skip} skipped</span>`);
  return parts.join('<span class="sep">·</span>');
}

export function checksHTML(pr: PullDetail): string {
  if (!pr.checkRuns.length) {
    return `<section class="island list-island"><div class="empty small">${icons.check('icon')}<div>No checks reported for this pull request.</div></div></section>`;
  }
  const order: Record<CheckTone, number> = { fail: 0, pending: 1, ok: 2, skip: 3 };
  const runs = [...pr.checkRuns].sort((a, b) => order[checkTone(a)] - order[checkTone(b)]);
  const rows = runs.map((c) => {
    const tone = checkTone(c);
    const inner = `<span class="check-icon ${tone}">${checkIcon(tone)}</span>
      <span class="check-name">${esc(c.name)}</span>
      <span class="check-state ${tone}">${esc(checkLabel(c, tone))}</span>
      ${c.url ? `<span class="row-trail">${icons.external('icon sm')}</span>` : '<span class="row-trail"></span>'}`;
    return c.url
      ? `<a class="row check-row" href="${esc(c.url)}" title="Open details on GitHub">${inner}</a>`
      : `<div class="row check-row static">${inner}</div>`;
  });
  return `<section class="island list-island">
    <div class="list-head"><span class="list-title">${plural(pr.checkRuns.length, 'check')}</span><span class="check-sum">${checksSummaryText(pr.checkRuns)}</span></div>
    <div class="rows">${rows.join('')}</div>
  </section>`;
}

// ---------- sidebar ----------

function block(title: string, body: string, extraCls = ''): string {
  return `<section class="side-block ${extraCls}"><h2 class="side-h">${title}</h2>${body}</section>`;
}

const none = `<div class="none">None</div>`;

function people(users: UserLite[]): string {
  if (!users.length) return none;
  return `<ul class="people">${users.map((u) => `<li>${avatar(u)}${who(u)}</li>`).join('')}</ul>`;
}

function reviewers(pr: PullDetail): string {
  const rows = new Map<string, { user: UserLite | null; state: ReviewState | 'REQUESTED' }>();
  for (const r of pr.latestReviews) rows.set(r.author?.login ?? 'ghost', { user: r.author, state: r.state });
  for (const u of pr.reviewRequests) rows.set(u.login, { user: u, state: 'REQUESTED' });
  if (!rows.size) return none;
  return `<ul class="people">${[...rows.values()]
    .map(({ user, state }) => {
      let icon: string, tone: string, title: string;
      if (state === 'REQUESTED') { icon = icons.dot('icon sm'); tone = 'pending'; title = 'Awaiting review'; }
      else { const m = reviewMeta(state); icon = state === 'APPROVED' ? icons.check('icon sm') : state === 'CHANGES_REQUESTED' ? icons.cross('icon sm') : icons.comment('icon sm'); tone = m.tone; title = state === 'APPROVED' ? 'Approved' : state === 'CHANGES_REQUESTED' ? 'Requested changes' : state === 'DISMISSED' ? 'Dismissed' : 'Commented'; }
      return `<li>${avatar(user)}${who(user)}<span class="rv ${tone}" title="${title}">${icon}</span></li>`;
    })
    .join('')}</ul>`;
}

function checksBlock(pr: PullDetail): string {
  if (!pr.checkRuns.length) return none;
  const c = checkCounts(pr.checkRuns);
  const total = pr.checkRuns.length;
  const tone: CheckTone = c.fail ? 'fail' : c.pending ? 'pending' : c.ok ? 'ok' : 'skip';
  const headline = c.fail ? 'Some checks failed' : c.pending ? 'Checks in progress' : c.ok ? 'All checks passed' : 'Checks skipped';
  const seg = (n: number, cls: string) => (n ? `<i class="${cls}" style="flex:${n}"></i>` : '');
  return `<button class="checks-card" data-tab="checks" title="Show checks">
    <span class="checks-line"><span class="check-icon ${tone}">${checkIcon(tone)}</span><span class="checks-headline">${headline}</span></span>
    <span class="checks-meter" aria-hidden="true">${seg(c.ok, 'ok')}${seg(c.fail, 'fail')}${seg(c.pending, 'pending')}${seg(c.skip, 'skip')}</span>
    <span class="checks-sum" title="${total} checks">${checksSummaryText(pr.checkRuns)}</span>
  </button>`;
}

function participants(users: UserLite[]): string {
  if (!users.length) return none;
  const max = 12;
  const shown = users.slice(0, max).map((u) => `<a class="stack-item" href="${esc(u.url)}" title="${esc(u.login)}">${avatar(u)}</a>`).join('');
  const more = users.length > max ? `<span class="stack-more">+${users.length - max}</span>` : '';
  return `<div class="stack">${shown}${more}</div>`;
}

export function sidebarHTML(item: ItemDetail): string {
  const pr = isPull(item) ? item : null;
  const blocks = [
    pr ? block('Reviewers', reviewers(pr)) : '',
    block('Assignees', people(item.assignees)),
    block('Labels', item.labels.length ? `<div class="labels">${item.labels.map(labelPill).join('')}</div>` : none),
    block('Milestone', item.milestone ? `<a class="milestone" href="${esc(item.milestone.url)}">${icons.milestone('icon sm')}<span>${esc(item.milestone.title)}</span></a>` : none),
    pr ? block('Checks', checksBlock(pr)) : '',
    block('Participants', participants(item.participants)),
  ];
  return `<aside class="island side" aria-label="Details">${blocks.join('')}</aside>`;
}

// ---------- skeleton and empty states ----------

export function skeletonHTML(kind: 'issue' | 'pull' | null): string {
  const line = (w: string, h = 12) => `<div class="skeleton" style="width:${w};height:${h}px"></div>`;
  const card = (lines: string[]) => `<div class="tl-item"><div class="tl-gutter"><div class="skeleton round"></div></div>
    <div class="card sk-card">${line('32%', 10)}${lines.map((w) => line(w)).join('')}</div></div>`;
  const sideBlock = (w: string) => `<div class="side-block">${line('40%', 9)}${line(w, 18)}</div>`;
  return `<div class="page loading" aria-busy="true" aria-label="Loading">
    <header class="island head">
      <div class="head-top"><div class="head-main">${line('62%', 22)}<div class="sk-row">${line('72px', 24)}${line('180px', 12)}</div></div>
      <div class="head-actions">${line('120px', 28)}${line('28px', 28)}</div></div>
      ${kind === 'pull' ? `<div class="branch-row">${line('260px', 22)}</div>` : ''}
    </header>
    <div class="main">
      ${kind === 'pull' ? `<div class="sk-row">${line('300px', 32)}</div>` : ''}
      <div class="timeline">${card(['92%', '84%', '60%'])}${card(['70%', '45%'])}${card(['88%', '52%'])}</div>
    </div>
    <aside class="island side">${sideBlock('70%')}${sideBlock('55%')}${sideBlock('40%')}${sideBlock('65%')}</aside>
  </div>`;
}

export function emptyHTML(opts: { icon: string; title: string; sub?: string; action?: string; tone?: string }): string {
  return `<div class="empty-page"><div class="empty-card island">
    <span class="empty-icon ${opts.tone ?? ''}">${opts.icon}</span>
    <div class="empty-title">${opts.title}</div>
    ${opts.sub ? `<div class="empty-sub">${opts.sub}</div>` : ''}
    ${opts.action ?? ''}
  </div></div>`;
}

export function bannerHTML(message: string): string {
  return `<div class="banner" role="alert">
    <span class="banner-icon">${icons.cross('icon sm')}</span>
    <span class="banner-text">${esc(message)}</span>
    <button class="btn" data-action="retry">${icons.refresh('icon sm')}Retry</button>
  </div>`;
}
