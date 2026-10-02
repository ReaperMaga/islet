// Conversation tab: description, timeline entries (comments, reviews, events) and the composer.

import type { ItemDetail, Reaction, ReviewState, TimelineEntry, UserLite } from '../../shared/types';
import { avatar, esc, fullDate, icons, labelPill, relTime } from '../shared/ui';

const REACTIONS: Record<string, string> = {
  THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉',
  CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀',
};

const REACTION_NAMES: Record<string, string> = {
  THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'laugh', HOORAY: 'hooray',
  CONFUSED: 'confused', HEART: 'heart', ROCKET: 'rocket', EYES: 'eyes',
};

/** Relative time with the full date as tooltip. */
export function time(iso: string | null | undefined): string {
  if (!iso) return '';
  return `<time class="t" datetime="${esc(iso)}" title="${esc(fullDate(iso))}">${esc(relTime(iso))}</time>`;
}

/** Login as a link to the profile (opened externally by the click handler). */
export function who(u: UserLite | null | undefined): string {
  if (!u) return `<span class="who ghost">ghost</span>`;
  return `<a class="who" href="${esc(u.url)}">${esc(u.login)}</a>`;
}

function reactions(list: Reaction[]): string {
  const shown = list.filter((r) => r.count > 0);
  if (!shown.length) return '';
  return `<div class="reactions">${shown
    .map((r) => {
      const emoji = REACTIONS[r.content] ?? '·';
      const name = REACTION_NAMES[r.content] ?? r.content.toLowerCase();
      return `<span class="reaction" title="${esc(`${r.count} × ${name}`)}"><span class="emoji">${emoji}</span><span class="n">${r.count}</span></span>`;
    })
    .join('')}</div>`;
}

function authorTag(entry: { author: UserLite | null }, item: ItemDetail): string {
  return entry.author && item.author && entry.author.login === item.author.login ? `<span class="tag">Author</span>` : '';
}

function permalink(url: string | undefined): string {
  return url ? `<a class="permalink" href="${esc(url)}" title="Open on GitHub" aria-label="Open on GitHub">${icons.external('icon sm')}</a>` : '';
}

function descriptionCard(item: ItemDetail): string {
  const body = item.bodyHTML.trim()
    ? `<div class="card-body markdown">${item.bodyHTML}</div>`
    : `<div class="card-body"><p class="empty-body">No description provided.</p></div>`;
  return `<article class="tl-item">
    <div class="tl-gutter">${avatar(item.author, 'lg')}</div>
    <div class="card">
      <header class="card-head">${who(item.author)}<span class="tag">Author</span><span class="sep">·</span>${time(item.createdAt)}${permalink(item.url)}</header>
      ${body}
    </div>
  </article>`;
}

function commentCard(e: TimelineEntry, item: ItemDetail, fresh: boolean): string {
  return `<article class="tl-item${fresh ? ' fresh' : ''}" data-id="${esc(e.id)}">
    <div class="tl-gutter">${avatar(e.author, 'lg')}</div>
    <div class="card">
      <header class="card-head">${who(e.author)}${authorTag(e, item)}<span class="sep">·</span>${time(e.createdAt)}${permalink(e.url)}</header>
      <div class="card-body markdown">${e.bodyHTML || '<p class="empty-body">No content.</p>'}</div>
      ${reactions(e.reactions)}
    </div>
  </article>`;
}

const REVIEW: Record<ReviewState, { text: string; tone: string; icon: () => string }> = {
  APPROVED: { text: 'approved these changes', tone: 'ok', icon: () => icons.check('icon sm') },
  CHANGES_REQUESTED: { text: 'requested changes', tone: 'fail', icon: () => icons.cross('icon sm') },
  COMMENTED: { text: 'reviewed', tone: 'plain', icon: () => icons.eye('icon sm') },
  DISMISSED: { text: 'review was dismissed', tone: 'muted', icon: () => icons.eye('icon sm') },
  PENDING: { text: 'started a review', tone: 'muted', icon: () => icons.eye('icon sm') },
};

export function reviewMeta(state: ReviewState) {
  return REVIEW[state] ?? REVIEW.COMMENTED;
}

function reviewCard(e: TimelineEntry, item: ItemDetail): string {
  const r = reviewMeta(e.reviewState ?? 'COMMENTED');
  const n = e.reviewCommentCount ?? 0;
  const body = e.bodyHTML.trim() ? `<div class="card-body markdown">${e.bodyHTML}</div>` : '';
  const foot = n
    ? `<footer class="review-foot">${icons.comment('icon sm')}<span>${n} code comment${n === 1 ? '' : 's'}</span></footer>`
    : '';
  return `<article class="tl-item review" data-id="${esc(e.id)}">
    <div class="tl-gutter">${avatar(e.author, 'lg')}</div>
    <div class="card compact ${r.tone}">
      <header class="card-head"><span class="review-state ${r.tone}">${r.icon()}</span>${who(e.author)}${authorTag(e, item)}<span class="review-text ${r.tone}">${r.text}</span><span class="sep">·</span>${time(e.createdAt)}${permalink(e.url)}</header>
      ${body}${foot}
      ${reactions(e.reactions)}
    </div>
  </article>`;
}

/** Text and icon for a timeline event. The text may contain HTML (already escaped). */
function eventParts(e: TimelineEntry, item: ItemDetail): { icon: string; tone: string; text: string } {
  const d = esc(e.eventDetail);
  const strong = d ? `<span class="ev-strong">${d}</span>` : '';
  const pr = item.kind === 'pull' ? (item as { headRef?: string; baseRef?: string }) : null;
  switch (e.event) {
    case 'labeled':
      return { icon: icons.tag('icon sm'), tone: '', text: `added ${e.eventLabel ? labelPill(e.eventLabel) : strong}` };
    case 'unlabeled':
      return { icon: icons.tag('icon sm'), tone: '', text: `removed ${e.eventLabel ? labelPill(e.eventLabel) : strong}` };
    case 'assigned':
      return { icon: icons.user('icon sm'), tone: '', text: d && d !== esc(e.author?.login) ? `assigned ${strong}` : 'self-assigned this' };
    case 'unassigned':
      return { icon: icons.user('icon sm'), tone: '', text: `unassigned ${strong}` };
    case 'closed':
      return item.kind === 'pull'
        ? { icon: icons.pullClosed('icon sm'), tone: 'closed', text: 'closed this' }
        : { icon: icons.issueClosed('icon sm'), tone: 'merged', text: `closed this${d ? ` as ${strong}` : ''}` };
    case 'reopened':
      return { icon: item.kind === 'pull' ? icons.pullOpen('icon sm') : icons.issueOpen('icon sm'), tone: 'open', text: 'reopened this' };
    case 'merged': {
      const into = pr?.headRef && pr.baseRef
        ? ` <span class="ref-inline">${esc(pr.headRef)}</span> into <span class="ref-inline">${esc(pr.baseRef)}</span>`
        : d ? ` commit <span class="ref-inline">${d}</span>` : '';
      return { icon: icons.pullMerged('icon sm'), tone: 'merged', text: `merged${into}` };
    }
    case 'renamed': {
      const raw = e.eventDetail ?? '';
      const i = raw.indexOf(' → ');
      if (i >= 0) {
        return { icon: icons.comment('icon sm'), tone: '', text: `changed the title <span class="ev-old">${esc(raw.slice(0, i))}</span> <span class="ev-arrow">→</span> <span class="ev-strong">${esc(raw.slice(i + 3))}</span>` };
      }
      return { icon: icons.comment('icon sm'), tone: '', text: d ? `changed the title to ${strong}` : 'changed the title' };
    }
    case 'review_requested':
      return { icon: icons.eye('icon sm'), tone: '', text: `requested a review from ${strong || 'someone'}` };
    case 'review_request_removed':
      return { icon: icons.eye('icon sm'), tone: '', text: `removed the review request for ${strong || 'someone'}` };
    case 'referenced':
      return { icon: icons.external('icon sm'), tone: '', text: d ? `referenced this in ${strong}` : 'referenced this' };
    case 'cross_referenced':
    case 'mentioned':
      return { icon: icons.external('icon sm'), tone: '', text: d ? `mentioned this in ${strong}` : 'mentioned this' };
    case 'head_ref_force_pushed':
      return { icon: icons.branch('icon sm'), tone: '', text: d ? `force-pushed the head branch to <span class="ref-inline">${d}</span>` : 'force-pushed the head branch' };
    case 'head_ref_deleted':
      return { icon: icons.branch('icon sm'), tone: '', text: 'deleted the head branch' };
    case 'head_ref_restored':
      return { icon: icons.branch('icon sm'), tone: '', text: 'restored the head branch' };
    case 'base_ref_changed':
      return { icon: icons.branch('icon sm'), tone: '', text: d ? `changed the base branch to ${strong}` : 'changed the base branch' };
    case 'milestoned':
      return { icon: icons.milestone('icon sm'), tone: '', text: `added this to ${strong || 'a milestone'}` };
    case 'demilestoned':
      return { icon: icons.milestone('icon sm'), tone: '', text: `removed this from ${strong || 'a milestone'}` };
    case 'ready_for_review':
      return { icon: icons.eye('icon sm'), tone: 'open', text: 'marked this as ready for review' };
    case 'convert_to_draft':
    case 'converted_to_draft':
      return { icon: icons.pullDraft('icon sm'), tone: '', text: 'marked this as draft' };
    case 'locked':
      return { icon: icons.dot('icon sm'), tone: '', text: 'locked the conversation' };
    case 'unlocked':
      return { icon: icons.dot('icon sm'), tone: '', text: 'unlocked the conversation' };
    case 'committed':
      return { icon: icons.branch('icon sm'), tone: '', text: d ? `added a commit ${strong}` : 'added a commit' };
    default: {
      const name = esc((e.event ?? 'updated').replace(/_/g, ' '));
      return { icon: icons.dot('icon sm'), tone: '', text: d ? `${name} ${strong}` : name };
    }
  }
}

function eventRow(e: TimelineEntry, item: ItemDetail): string {
  const p = eventParts(e, item);
  const actor = e.author ? `${avatar(e.author)}${who(e.author)}` : '';
  return `<div class="tl-event" data-id="${esc(e.id)}">
    <div class="tl-gutter"><span class="tl-badge ${p.tone}">${p.icon}</span></div>
    <div class="ev-text">${actor}<span class="ev-body">${p.text}</span><span class="sep">·</span>${time(e.createdAt)}</div>
  </div>`;
}

export function timelineHTML(item: ItemDetail, freshId: string | null): string {
  const parts = [descriptionCard(item)];
  for (const e of item.timeline) {
    if (e.type === 'comment') parts.push(commentCard(e, item, e.id === freshId));
    else if (e.type === 'review') parts.push(reviewCard(e, item));
    else parts.push(eventRow(e, item));
  }
  return `<div class="timeline">${parts.join('')}</div>`;
}

export function composerHTML(item: ItemDetail, viewer: UserLite | null, draft: string, sending: boolean, error: string | null): string {
  if (!item.viewerCanComment) {
    return `<div class="tl-item composer-row">
      <div class="tl-gutter">${avatar(viewer, 'lg')}</div>
      <div class="island composer locked">
        <span class="locked-icon">${icons.comment('icon')}</span>
        <div><div class="locked-title">Commenting is not available</div>
        <div class="locked-sub">This conversation may be locked, or your account can't comment on this repository.</div></div>
      </div>
    </div>`;
  }
  const noun = item.kind === 'pull' ? 'pull request' : 'issue';
  return `<div class="tl-item composer-row">
    <div class="tl-gutter">${avatar(viewer, 'lg')}</div>
    <form class="island composer" data-form="comment">
      <textarea id="composer" class="composer-input" placeholder="Leave a comment" aria-label="Comment on this ${noun}" rows="3"${sending ? ' disabled' : ''}>${esc(draft)}</textarea>
      <div class="composer-foot">
        <span class="hint">Markdown supported · <kbd>Ctrl</kbd><kbd>Enter</kbd> to send</span>
        ${error ? `<span class="composer-err" role="alert">${esc(error)}</span>` : ''}
        <button type="submit" class="btn primary" data-action="comment"${sending || !draft.trim() ? ' disabled' : ''}>${sending ? '<span class="spinner"></span>Sending' : 'Comment'}</button>
      </div>
    </form>
  </div>`;
}
