// Sidebar list webview: issues and pull requests of the current repository.
import '../shared/theme.css';
import './sidebar.css';

import type { Session, ToWebview } from '../../shared/protocol';
import type { ItemKind, ItemSummary, ListFilter, PageInfo } from '../../shared/types';
import { onMessage, post, request } from '../shared/bridge';
import { icons } from '../shared/ui';
import { isDefaultFilter, loadPersisted, savePersisted } from './state';
import {
  emptyResultsHtml, errorBanner, filtersHtml, headerHtml, localIcons, noRepoHtml, rowHtml, signedOutHtml, skeletonRows, tabsHtml,
} from './view';

type ListResult = Extract<ToWebview, { type: 'listResult' }>;
type Phase = 'boot' | 'signedOut' | 'noRepo' | 'ready';

const app = document.getElementById('app')!;

const ui = {
  phase: 'boot' as Phase,
  session: null as Session | null,
  p: loadPersisted(),
  items: [] as ItemSummary[],
  pageInfo: { hasNextPage: false, endCursor: null } as PageInfo,
  loaded: false,
  loading: null as null | 'reset' | 'refresh' | 'more',
  error: null as string | null,
  moreError: null as string | null,
  gen: 0,
  selected: '' as string,
  menuOpen: false,
  counts: new Map<string, number>(),
  restoreScroll: true,
};

// ---------- DOM skeleton ----------

app.innerHTML = `<div class="shell">
  <header class="head">
    <div class="repo-host"></div>
    <div class="tabs-host"></div>
  </header>
  <div class="toolbar">
    <label class="search">
      ${icons.search('icon sm search-icon')}
      <input type="text" spellcheck="false" autocomplete="off" aria-label="Search">
      <button class="search-clear" data-action="clear-search" title="Clear (Esc)" aria-label="Clear search" hidden>${localIcons.close('icon sm')}</button>
    </label>
    <div class="filters"></div>
  </div>
  <div class="progress" aria-hidden="true"></div>
  <div class="list" role="listbox" aria-label="Items">
    <div class="rows"></div>
    <div class="tail"></div>
  </div>
  <div class="stage" hidden></div>
</div>`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
const shell = $('.shell');
const repoHost = $('.repo-host');
const tabsHost = $('.tabs-host');
const filtersHost = $('.filters');
const searchInput = $<HTMLInputElement>('.search input');
const searchClear = $<HTMLButtonElement>('.search-clear');
const list = $('.list');
const rowsEl = $('.rows');
const tail = $('.tail');
const stage = $('.stage');

searchInput.value = ui.p.filter.query;

// ---------- helpers ----------

const scopeFor = (kind: ItemKind, f: ListFilter): ListFilter =>
  kind === 'issue' && f.scope === 'review' ? { ...f, scope: 'all' } : f;
const countKey = (kind: ItemKind, f: ListFilter) => {
  const g = scopeFor(kind, f);
  return `${kind}|${g.state}|${g.scope}|${g.query.trim()}`;
};
const itemKey = (kind: ItemKind, n: number) => `${kind}-${n}`;
const otherKind = (k: ItemKind): ItemKind => (k === 'issue' ? 'pull' : 'issue');

function persist() {
  savePersisted(ui.p);
}

// ---------- rendering ----------

function setPhase(phase: Phase) {
  ui.phase = phase;
  shell.dataset.phase = phase;
  const showStage = phase === 'signedOut' || phase === 'noRepo';
  stage.hidden = !showStage;
  if (phase === 'signedOut') stage.innerHTML = signedOutHtml();
  else if (phase === 'noRepo') stage.innerHTML = noRepoHtml(ui.session?.reason);
  renderHeader();
}

function renderHeader() {
  repoHost.innerHTML = headerHtml(ui.session);
  renderTabs();
  renderFilters();
  searchInput.placeholder = ui.p.kind === 'issue' ? 'Search issues' : 'Search pull requests';
  searchClear.hidden = !searchInput.value;
}

function renderTabs() {
  const counts: Partial<Record<ItemKind, number>> = {};
  for (const k of ['issue', 'pull'] as const) {
    const n = ui.counts.get(countKey(k, ui.p.filter));
    if (n !== undefined) counts[k] = n;
  }
  const focused = document.activeElement?.closest<HTMLElement>('[data-tab]')?.dataset.tab;
  tabsHost.innerHTML = tabsHtml(ui.p.kind, counts);
  if (focused) tabsHost.querySelector<HTMLElement>(`[data-tab="${focused}"]`)?.focus();
}

function renderFilters() {
  const active = document.activeElement as HTMLElement | null;
  const focusSel = active?.dataset.state ? `[data-state="${active.dataset.state}"]` : active?.dataset.action === 'scope' ? '[data-action="scope"]' : '';
  filtersHost.innerHTML = filtersHtml(ui.p.kind, ui.p.filter, ui.menuOpen);
  if (focusSel && filtersHost.contains(active) === false) filtersHost.querySelector<HTMLElement>(focusSel)?.focus();
}

function renderRows() {
  rowsEl.innerHTML = ui.items.map((i) => rowHtml(i, ui.selected === itemKey(i.kind, i.number))).join('');
  fixRoving();
}

function renderTail() {
  const busy = ui.loading === 'reset' || ui.loading === 'refresh';
  list.classList.toggle('stale', busy && ui.items.length > 0);
  shell.classList.toggle('busy', !!ui.loading && ui.loading !== 'more' && ui.items.length > 0);

  if (!ui.loaded && ui.error) { tail.innerHTML = errorBanner(ui.error); return; }
  if (!ui.loaded || (ui.loading === 'reset' && ui.items.length === 0)) { tail.innerHTML = skeletonRows(7); return; }
  if (ui.items.length === 0) {
    tail.innerHTML = ui.error ? errorBanner(ui.error) : emptyResultsHtml(ui.p.kind, ui.p.filter, !isDefaultFilter(ui.p.filter));
    return;
  }
  if (ui.error) { tail.innerHTML = errorBanner(ui.error, true); return; }
  if (ui.moreError) { tail.innerHTML = errorBanner(ui.moreError, true); return; }
  if (ui.loading === 'more') { tail.innerHTML = skeletonRows(1); return; }
  tail.innerHTML = ui.pageInfo.hasNextPage ? '<div class="sentinel"></div>' : ui.items.length > 6 ? '<div class="end mono">end of list</div>' : '';
  const s = tail.querySelector('.sentinel');
  if (s) observer.observe(s);
}

// ---------- loading ----------

async function load(mode: 'reset' | 'refresh' | 'more') {
  if (ui.phase !== 'ready') return;
  if (mode === 'more' && (ui.loading || !ui.pageInfo.hasNextPage || ui.moreError)) return;
  const gen = mode === 'more' ? ui.gen : ++ui.gen;
  const kind = ui.p.kind;
  const filter = scopeFor(kind, ui.p.filter);
  ui.loading = mode;
  if (mode !== 'more') ui.error = null;
  ui.moreError = null;
  if (mode === 'reset' && !ui.items.length) ui.loaded = false;
  renderTail();
  try {
    const res = await request<ListResult>({ type: 'list', kind, filter, cursor: mode === 'more' ? ui.pageInfo.endCursor : null });
    if (gen !== ui.gen) return;
    const page = res.page;
    ui.items = mode === 'more' ? ui.items.concat(page.items) : page.items;
    ui.pageInfo = page.pageInfo;
    ui.counts.set(countKey(kind, ui.p.filter), page.totalCount);
    ui.loaded = true;
    ui.loading = null;
    if (mode === 'more') {
      const start = ui.items.length - page.items.length;
      rowsEl.insertAdjacentHTML('beforeend', ui.items.slice(start).map((i) => rowHtml(i, ui.selected === itemKey(i.kind, i.number))).join(''));
      fixRoving();
    } else {
      const keep = mode === 'refresh' ? list.scrollTop : 0;
      renderRows();
      list.scrollTop = ui.restoreScroll ? ui.p.scrollTop : keep;
      ui.restoreScroll = false;
      prefetchOtherCount();
    }
    renderTabs();
    renderTail();
    requestAnimationFrame(nearBottomCheck);
  } catch (e) {
    if (gen !== ui.gen) return;
    const msg = e instanceof Error ? e.message : String(e);
    ui.loading = null;
    if (mode === 'more') ui.moreError = msg;
    else { ui.error = msg; if (mode === 'reset') { ui.items = []; renderRows(); ui.loaded = false; } }
    renderTail();
  }
}

let prefetchTimer = 0;
function prefetchOtherCount() {
  clearTimeout(prefetchTimer);
  const kind = otherKind(ui.p.kind);
  const key = countKey(kind, ui.p.filter);
  if (ui.counts.has(key)) return;
  prefetchTimer = window.setTimeout(() => {
    const gen = ui.gen;
    request<ListResult>({ type: 'list', kind, filter: scopeFor(kind, ui.p.filter), cursor: null })
      .then((res) => {
        if (gen !== ui.gen && countKey(kind, ui.p.filter) !== key) return;
        ui.counts.set(key, res.page.totalCount);
        renderTabs();
      })
      .catch(() => { /* count stays unknown */ });
  }, 600);
}

function nearBottomCheck() {
  if (!ui.pageInfo.hasNextPage || ui.loading) return;
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 240) load('more');
}

const observer = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) load('more');
}, { root: list, rootMargin: '0px 0px 240px 0px' });

function resetList(kindChanged = false) {
  persist();
  if (kindChanged) {
    ui.items = [];
    ui.loaded = false;
    rowsEl.innerHTML = '';
  }
  list.scrollTop = 0;
  ui.p.scrollTop = 0;
  load('reset');
}

// ---------- actions ----------

function setKind(kind: ItemKind) {
  if (kind === ui.p.kind) return;
  ui.p.kind = kind;
  if (kind === 'issue' && ui.p.filter.scope === 'review') ui.p.filter.scope = 'all';
  ui.menuOpen = false;
  renderHeader();
  resetList(true);
}

function setFilter(patch: Partial<ListFilter>) {
  ui.p.filter = { ...ui.p.filter, ...patch };
  renderTabs();
  renderFilters();
  resetList();
}

function clearFilters() {
  searchInput.value = '';
  searchClear.hidden = true;
  setFilter({ state: 'open', scope: 'all', query: '' });
}

function openItem(row: HTMLElement) {
  const kind = row.dataset.kind as ItemKind;
  const number = Number(row.dataset.number);
  ui.selected = itemKey(kind, number);
  rowsEl.querySelectorAll('.row.selected').forEach((r) => { r.classList.remove('selected'); r.setAttribute('aria-selected', 'false'); });
  row.classList.add('selected');
  row.setAttribute('aria-selected', 'true');
  post({ type: 'openItem', kind, number });
}

function setMenu(open: boolean, focusFirst = false) {
  ui.menuOpen = open;
  renderFilters();
  if (open && focusFirst) filtersHost.querySelector<HTMLElement>('.menu-item.on, .menu-item')?.focus();
  if (!open && focusFirst) filtersHost.querySelector<HTMLElement>('[data-action="scope"]')?.focus();
}

// roving tabindex: one row is tabbable
function fixRoving() {
  const rows = rowsEl.querySelectorAll<HTMLElement>('.row');
  if (!rows.length) return;
  const current = rowsEl.querySelector<HTMLElement>('.row[tabindex="0"]') ?? rowsEl.querySelector<HTMLElement>('.row.selected') ?? rows[0];
  rows.forEach((r) => (r.tabIndex = r === current ? 0 : -1));
}

function focusRow(row: HTMLElement | null | undefined) {
  if (!row) return;
  rowsEl.querySelectorAll<HTMLElement>('.row').forEach((r) => (r.tabIndex = -1));
  row.tabIndex = 0;
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
}

// ---------- events ----------

app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const tab = t.closest<HTMLElement>('[data-tab]');
  if (tab) return setKind(tab.dataset.tab as ItemKind);
  const st = t.closest<HTMLElement>('[data-state]');
  if (st) return setFilter({ state: st.dataset.state as ListFilter['state'] });
  const sc = t.closest<HTMLElement>('[data-scope]');
  if (sc) { ui.menuOpen = false; setFilter({ scope: sc.dataset.scope as ListFilter['scope'] }); filtersHost.querySelector<HTMLElement>('[data-action="scope"]')?.focus(); return; }
  const act = t.closest<HTMLElement>('[data-action]')?.dataset.action;
  switch (act) {
    case 'scope': return setMenu(!ui.menuOpen);
    case 'clear': return clearFilters();
    case 'clear-search': e.preventDefault(); searchInput.value = ''; onSearchInput(true); searchInput.focus(); return;
    case 'retry': ui.moreError ? (ui.moreError = null, load('more')) : load(ui.loaded ? 'refresh' : 'reset'); return;
    case 'signin': return post({ type: 'signIn' });
  }
  const row = t.closest<HTMLElement>('.row[data-number]');
  if (row) openItem(row);
});

document.addEventListener('mousedown', (e) => {
  if (ui.menuOpen && !(e.target as HTMLElement).closest('.scope-wrap')) setMenu(false);
});

filtersHost.addEventListener('keydown', (e) => {
  if (!ui.menuOpen) {
    if (e.key === 'ArrowDown' && (e.target as HTMLElement).dataset.action === 'scope') { e.preventDefault(); setMenu(true, true); }
    return;
  }
  const items = [...filtersHost.querySelectorAll<HTMLElement>('.menu-item')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') { e.preventDefault(); setMenu(false, true); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Tab') setMenu(false);
});

tabsHost.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    setKind(otherKind(ui.p.kind));
    tabsHost.querySelector<HTMLElement>('.tab.on')?.focus();
  }
});

list.addEventListener('keydown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row[data-number]');
  if (!row) return;
  const rows = [...rowsEl.querySelectorAll<HTMLElement>('.row')];
  const i = rows.indexOf(row);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusRow(rows[i + 1]); if (i + 1 >= rows.length - 3) nearBottomCheck(); break;
    case 'ArrowUp': e.preventDefault(); if (i === 0) searchInput.focus(); else focusRow(rows[i - 1]); break;
    case 'Home': e.preventDefault(); focusRow(rows[0]); break;
    case 'End': e.preventDefault(); focusRow(rows[rows.length - 1]); break;
    case 'Enter': case ' ': e.preventDefault(); openItem(row); break;
  }
});

let searchTimer = 0;
function onSearchInput(immediate = false) {
  searchClear.hidden = !searchInput.value;
  clearTimeout(searchTimer);
  const run = () => { if (searchInput.value !== ui.p.filter.query) setFilter({ query: searchInput.value }); };
  if (immediate) run();
  else searchTimer = window.setTimeout(run, 300);
}
searchInput.addEventListener('input', () => onSearchInput());
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (searchInput.value) { searchInput.value = ''; onSearchInput(true); } else searchInput.blur();
  } else if (e.key === 'Enter') {
    onSearchInput(true);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusRow(rowsEl.querySelector<HTMLElement>('.row[tabindex="0"]') ?? rowsEl.querySelector<HTMLElement>('.row'));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea') && ui.phase === 'ready') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

let scrollRaf = 0;
list.addEventListener('scroll', () => {
  shell.classList.toggle('scrolled', list.scrollTop > 2);
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (ui.restoreScroll) return;
    ui.p.scrollTop = Math.round(list.scrollTop);
    persist();
  });
}, { passive: true });

// ---------- host messages ----------

function sameRepo(a: Session | null, b: Session) {
  return !!a?.repo && !!b.repo && a.repo.owner === b.repo.owner && a.repo.name === b.repo.name && a.user?.login === b.user?.login;
}

onMessage((msg) => {
  switch (msg.type) {
    case 'session': {
      const s = msg.session;
      const unchanged = ui.phase === 'ready' && sameRepo(ui.session, s);
      ui.session = s;
      if (!s.signedIn) return setPhase('signedOut');
      if (!s.repo) return setPhase('noRepo');
      setPhase('ready');
      if (!unchanged) {
        ui.counts.clear();
        ui.items = [];
        ui.loaded = false;
        rowsEl.innerHTML = '';
        load('reset');
      }
      return;
    }
    case 'refresh':
      if (ui.phase !== 'ready') return;
      ui.counts.clear();
      renderTabs();
      load(ui.loaded ? 'refresh' : 'reset');
      return;
    case 'error':
      if (!msg.requestId && ui.phase === 'ready') { ui.error = msg.message; renderTail(); }
      return;
  }
});

setPhase('boot');
renderTail();
post({ type: 'ready' });
