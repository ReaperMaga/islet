// Small rendering helpers shared by both webviews. Plain strings, no framework.
// Every helper that takes user content escapes it.

import type { ItemState, ItemSummary, Label, UserLite } from '../../shared/types';

export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** "3m", "5h", "2d", "Mar 4", "Mar 4, 2023" */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function fullDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

export function avatar(user: UserLite | null | undefined, size: 'sm' | 'lg' = 'sm'): string {
  if (!user) return `<span class="avatar ${size === 'lg' ? 'lg' : ''}"></span>`;
  return `<img class="avatar ${size === 'lg' ? 'lg' : ''}" src="${esc(user.avatarUrl)}" alt="" title="${esc(user.login)}" loading="lazy">`;
}

/**
 * GitHub label pill. Label colours are arbitrary, so the pill uses the label colour
 * for text and border (lightened for contrast on dark) over a faint tint of it.
 */
export function labelPill(label: Label): string {
  const hex = /^[0-9a-f]{6}$/i.test(label.color) ? label.color : '8b8e94';
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  // lighten towards white until readable on #1e1f22
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const mix = lum < 0.55 ? (0.55 - lum) / 0.45 : 0;
  const fr = Math.round(r + (255 - r) * mix), fg = Math.round(g + (255 - g) * mix), fb = Math.round(b + (255 - b) * mix);
  const style = `--label-fg: rgb(${fr},${fg},${fb}); --label-bg: rgba(${r},${g},${b},0.14); --label-border: rgba(${r},${g},${b},0.38);`;
  return `<span class="label-pill" style="${style}" title="${esc(label.description ?? label.name)}">${esc(label.name)}</span>`;
}

// ---- icons (16x16, stroke = currentColor) ----

const svg = (body: string, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  issueOpen: (c?: string) => svg('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/>', c),
  issueClosed: (c?: string) => svg('<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.2-3.6"/>', c),
  pullOpen: (c?: string) => svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6"/><path d="M11.5 11V6.5a2 2 0 0 0-2-2H7.5"/><path d="M9 3l-1.5 1.5L9 6"/>', c),
  pullMerged: (c?: string) => svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6"/><path d="M4.5 5c0 2.5 2.5 4 5.5 4"/>', c),
  pullClosed: (c?: string) => svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6"/><path d="M10 3.5l3 3M13 3.5l-3 3"/><path d="M11.5 9v2"/>', c),
  pullDraft: (c?: string) => svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6"/><path d="M11.5 4v.5M11.5 7v.5"/>', c),
  comment: (c?: string) => svg('<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>', c),
  check: (c?: string) => svg('<path d="M3.5 8.5l3 3 6-7"/>', c),
  cross: (c?: string) => svg('<path d="M4 4l8 8M12 4l-8 8"/>', c),
  dot: (c?: string) => svg('<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>', c),
  search: (c?: string) => svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>', c),
  refresh: (c?: string) => svg('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>', c),
  external: (c?: string) => svg('<path d="M9 3h4v4"/><path d="M13 3L7.5 8.5"/><path d="M11 9.5V13H3V5h3.5"/>', c),
  branch: (c?: string) => svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6"/><path d="M11.5 6.5c0 2.5-3 3-7 4.5"/>', c),
  file: (c?: string) => svg('<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>', c),
  tag: (c?: string) => svg('<path d="M2.5 8.5V3a.5.5 0 0 1 .5-.5h5.5l5 5-6 6z"/><circle cx="5.5" cy="5.5" r="1"/>', c),
  user: (c?: string) => svg('<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.5 2.7-3.5 5-3.5s4.2 1 5 3.5"/>', c),
  milestone: (c?: string) => svg('<path d="M8 2v12"/><path d="M8 3h5l-1.5 2L13 7H8"/>', c),
  eye: (c?: string) => svg('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>', c),
  chevronDown: (c?: string) => svg('<path d="M4 6l4 4 4-4"/>', c),
};

/** Icon + colour class for an item's state, e.g. for list rows and the detail header. */
export function stateIcon(item: Pick<ItemSummary, 'kind' | 'state' | 'isDraft'>, cls?: string): { html: string; tone: 'open' | 'closed' | 'merged' | 'draft' } {
  if (item.kind === 'issue') {
    return item.state === 'open' ? { html: icons.issueOpen(cls), tone: 'open' } : { html: icons.issueClosed(cls), tone: 'merged' };
  }
  if (item.state === 'merged') return { html: icons.pullMerged(cls), tone: 'merged' };
  if (item.state === 'closed') return { html: icons.pullClosed(cls), tone: 'closed' };
  if (item.isDraft) return { html: icons.pullDraft(cls), tone: 'draft' };
  return { html: icons.pullOpen(cls), tone: 'open' };
}

export function stateText(item: Pick<ItemSummary, 'kind' | 'state' | 'isDraft'>): string {
  if (item.kind === 'pull' && item.state === 'open' && item.isDraft) return 'Draft';
  const s: Record<ItemState, string> = { open: 'Open', closed: 'Closed', merged: 'Merged' };
  return s[item.state];
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
