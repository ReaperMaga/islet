// Detail editor tab: one issue or pull request.
import '../shared/theme.css';
import './detail.css';

import type { Session, ToWebview } from '../../shared/protocol';
import type { ItemDetail, ItemKind } from '../../shared/types';
import { getState, inVsCode, onMessage, post, request, setState } from '../shared/bridge';
import { esc, icons } from '../shared/ui';
import { composerHTML, timelineHTML } from './timeline';
import {
  bannerHTML, checksHTML, emptyHTML, filesHTML, headerHTML, isPull, sidebarHTML, skeletonHTML, tabsHTML, type Tab,
} from './view';

interface State {
  session: Session | null;
  target: { kind: ItemKind; number: number } | null;
  item: ItemDetail | null;
  loading: boolean;
  error: string | null;
  tab: Tab;
  draft: string;
  sending: boolean;
  commentError: string | null;
  freshId: string | null;
  /** Waiting for the host to tell us which item to show. */
  waiting: boolean;
}

interface Persisted { kind: ItemKind; number: number; tab: Tab; draft: string }

const app = document.getElementById('app')!;
const saved = getState<Persisted>();

const state: State = {
  session: null,
  target: null,
  item: null,
  loading: false,
  error: null,
  tab: 'conversation',
  draft: '',
  sending: false,
  commentError: null,
  freshId: null,
  waiting: true,
};

let seq = 0;

function persist() {
  if (!state.target) return;
  setState<Persisted>({ ...state.target, tab: state.tab, draft: state.draft });
}

// ---------- data ----------

async function load(keepScroll: boolean) {
  const t = state.target;
  if (!t) return;
  const my = ++seq;
  state.loading = true;
  state.error = null;
  render(keepScroll);
  try {
    const res = await request<Extract<ToWebview, { type: 'detailResult' }>>({ type: 'detail', kind: t.kind, number: t.number });
    if (my !== seq) return;
    state.item = res.item;
    if (!isPull(res.item) && state.tab !== 'conversation') state.tab = 'conversation';
  } catch (err) {
    if (my !== seq) return;
    state.error = err instanceof Error ? err.message : String(err);
  }
  state.loading = false;
  render(keepScroll);
}

function show(kind: ItemKind, number: number) {
  const same = state.target?.kind === kind && state.target.number === number;
  state.waiting = false;
  if (!same) {
    state.target = { kind, number };
    state.item = null;
    const restore = saved && saved.kind === kind && saved.number === number ? saved : null;
    state.tab = restore?.tab ?? 'conversation';
    state.draft = restore?.draft ?? '';
    state.commentError = null;
    state.freshId = null;
    window.scrollTo(0, 0);
  }
  persist();
  void load(same);
}

async function submitComment() {
  const item = state.item;
  const body = state.draft.trim();
  if (!item || !body || state.sending) return;
  state.sending = true;
  state.commentError = null;
  renderComposer();
  try {
    const res = await request<Extract<ToWebview, { type: 'commentAdded' }>>({ type: 'addComment', kind: item.kind, number: item.number, body });
    if (state.item === item) {
      item.timeline.push(res.entry);
      item.commentCount += 1;
    }
    state.freshId = res.entry.id;
    state.draft = '';
    state.sending = false;
    persist();
    render(true);
    const el = app.querySelector(`[data-id="${CSS.escape(res.entry.id)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    state.sending = false;
    state.commentError = err instanceof Error ? err.message : String(err);
    renderComposer();
    focusComposer();
  }
}

// ---------- rendering ----------

function conversationHTML(item: ItemDetail): string {
  return `${timelineHTML(item, state.freshId)}<div class="composer-slot">${composerHTML(item, state.session?.user ?? null, state.draft, state.sending, state.commentError)}</div>`;
}

function mainHTML(item: ItemDetail): string {
  if (!isPull(item)) return conversationHTML(item);
  const body = state.tab === 'files' ? filesHTML(item) : state.tab === 'checks' ? checksHTML(item) : conversationHTML(item);
  return `${tabsHTML(item, state.tab)}<div class="tab-body" role="tabpanel">${body}</div>`;
}

function render(keepScroll = false) {
  const y = window.scrollY;
  app.innerHTML = pageHTML();
  if (keepScroll) window.scrollTo(0, y);
  sizeComposer();
}

function pageHTML(): string {
  const s = state.session;
  if (s && !s.signedIn) {
    return emptyHTML({
      icon: icons.user('icon'), title: 'Sign in to GitHub',
      sub: 'Sign in to see issues and pull requests for this repository.',
      action: `<button class="btn primary" data-action="sign-in">Sign in</button>`,
    });
  }
  if (s && s.signedIn && !s.repo) {
    return emptyHTML({ icon: icons.branch('icon'), title: 'No GitHub repository', sub: esc(s.reason ?? 'Open a folder whose git remote points to GitHub.') });
  }
  if (!state.target) {
    if (state.waiting && inVsCode) return skeletonHTML(null);
    return emptyHTML({
      icon: icons.issueOpen('icon'), title: 'No item selected',
      sub: inVsCode
        ? 'Pick an issue or pull request in the GitHub sidebar to see it here.'
        : 'Add <code>?kind=issue&amp;number=N</code> or <code>?kind=pull&amp;number=N</code> to the URL to preview an item.',
    });
  }
  const item = state.item;
  if (!item) {
    if (state.error) {
      const noun = state.target.kind === 'pull' ? 'pull request' : 'issue';
      return emptyHTML({
        icon: icons.cross('icon'), tone: 'fail', title: `Couldn't load ${noun} #${state.target.number}`, sub: esc(state.error),
        action: `<button class="btn" data-action="retry">${icons.refresh('icon sm')}Retry</button>`,
      });
    }
    return skeletonHTML(state.target.kind);
  }
  return `<div class="page${isPull(item) ? ' is-pull' : ''}">
    ${state.error ? `<div class="banner-slot">${bannerHTML(state.error)}</div>` : ''}
    ${headerHTML(item, s, state.loading)}
    <div class="main">${mainHTML(item)}</div>
    ${sidebarHTML(item)}
  </div>`;
}

function renderComposer() {
  const slot = app.querySelector('.composer-slot');
  if (!slot || !state.item) return;
  const hadFocus = document.activeElement?.id === 'composer';
  slot.innerHTML = composerHTML(state.item, state.session?.user ?? null, state.draft, state.sending, state.commentError);
  sizeComposer();
  if (hadFocus && !state.sending) focusComposer();
}

function composer(): HTMLTextAreaElement | null {
  return app.querySelector<HTMLTextAreaElement>('#composer');
}

function focusComposer() {
  const ta = composer();
  if (!ta) return;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function sizeComposer() {
  const ta = composer();
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(Math.max(ta.scrollHeight + 2, 76), 420)}px`;
}

// ---------- events ----------

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const actionEl = target.closest<HTMLElement>('[data-action], [data-tab]');
  if (actionEl && app.contains(actionEl)) {
    if (actionEl.dataset.tab) {
      e.preventDefault();
      state.tab = actionEl.dataset.tab as Tab;
      persist();
      render(true);
      const tabs = app.querySelector('.segmented');
      if (tabs && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: 'start' });
      return;
    }
    const item = state.item;
    switch (actionEl.dataset.action) {
      case 'refresh':
      case 'retry':
        e.preventDefault();
        void load(true);
        return;
      case 'open-github':
        if (item) post({ type: 'openExternal', url: item.url });
        return;
      case 'checkout':
        if (item) post({ type: 'checkoutPull', number: item.number });
        return;
      case 'diff':
        if (item && actionEl.dataset.path) post({ type: 'openFileDiff', number: item.number, path: actionEl.dataset.path });
        return;
      case 'sign-in':
        post({ type: 'signIn' });
        return;
      case 'comment':
        // handled by the form submit
        return;
    }
  }
  // Every link (GitHub bodyHTML, profiles, checks) opens outside the webview.
  const a = target.closest<HTMLAnchorElement>('a[href]');
  if (a) {
    e.preventDefault();
    const href = a.href;
    if (/^https?:/i.test(href)) post({ type: 'openExternal', url: href });
  }
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  void submitComment();
});

app.addEventListener('input', (e) => {
  const ta = e.target as HTMLElement;
  if (ta.id !== 'composer') return;
  state.draft = (ta as HTMLTextAreaElement).value;
  sizeComposer();
  const btn = app.querySelector<HTMLButtonElement>('.composer [data-action="comment"]');
  if (btn) btn.disabled = state.sending || !state.draft.trim();
  persist();
});

app.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'composer' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void submitComment();
    return;
  }
  // Arrow keys move between segmented tabs.
  if (t.classList.contains('seg') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const segs = [...app.querySelectorAll<HTMLElement>('.seg')];
    const i = segs.indexOf(t);
    const next = segs[(i + (e.key === 'ArrowRight' ? 1 : segs.length - 1)) % segs.length];
    state.tab = next.dataset.tab as Tab;
    persist();
    render(true);
    app.querySelector<HTMLElement>(`.seg[data-tab="${state.tab}"]`)?.focus();
  }
});

// Clear the "just added" highlight after its animation so re-renders don't replay it.
app.addEventListener('animationend', (e) => {
  if ((e as AnimationEvent).animationName !== 'fresh') return;
  const el = (e.target as HTMLElement).closest('.fresh');
  if (el) {
    el.classList.remove('fresh');
    state.freshId = null;
  }
});

onMessage((msg) => {
  switch (msg.type) {
    case 'session':
      state.session = msg.session;
      if (!state.target) render();
      else render(true);
      break;
    case 'showItem':
      show(msg.kind, msg.number);
      break;
    case 'refresh':
      if (state.target) void load(true);
      break;
    case 'error':
      if (!msg.requestId) {
        state.error = msg.message;
        render(true);
      }
      break;
  }
});

// ---------- startup ----------

render();
post({ type: 'ready' });

if (!inVsCode) {
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind');
  const number = Number(q.get('number'));
  if ((kind === 'issue' || kind === 'pull') && Number.isInteger(number) && number > 0) show(kind, number);
  else {
    state.waiting = false;
    render();
  }
}
