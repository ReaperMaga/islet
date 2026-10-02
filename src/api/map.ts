// Maps raw GraphQL responses (see queries.ts) to the shared data model in src/shared/types.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  ChangedFile, CheckRun, ChecksState, IssueDetail, ItemState, ItemSummary, Label, PullDetail, Reaction,
  ReviewDecision, ReviewState, TimelineEntry, UserLite,
} from '../shared/types';

type Raw = any;

export function user(u: Raw): UserLite | null {
  return u && u.login ? { login: u.login, avatarUrl: u.avatarUrl ?? '', url: u.url ?? `https://github.com/${u.login}` } : null;
}

function users(nodes: Raw[] | undefined): UserLite[] {
  return (nodes ?? []).map(user).filter((u): u is UserLite => !!u);
}

function label(l: Raw): Label {
  return { name: l.name, color: l.color, description: l.description ?? null };
}

function reactions(groups: Raw[] | undefined): Reaction[] {
  return (groups ?? [])
    .map((g) => ({ content: g.content as string, count: (g.reactors?.totalCount ?? 0) as number }))
    .filter((r) => r.count > 0);
}

export function checksState(state: string | null | undefined): ChecksState {
  switch (state) {
    case 'SUCCESS': return 'SUCCESS';
    case 'FAILURE': case 'ERROR': return 'FAILURE';
    case 'PENDING': case 'EXPECTED': return 'PENDING';
    default: return null;
  }
}

function lastRollup(n: Raw): Raw | null {
  return n.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
}

export function summary(n: Raw): ItemSummary {
  const isPull = n.__typename === 'PullRequest' || 'headRefName' in n;
  const state: ItemState = n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : 'open';
  const s: ItemSummary = {
    kind: isPull ? 'pull' : 'issue',
    number: n.number,
    title: n.title,
    state,
    isDraft: !!n.isDraft,
    author: user(n.author),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    commentCount: n.comments?.totalCount ?? 0,
    labels: (n.labels?.nodes ?? []).map(label),
    assignees: users(n.assignees?.nodes),
    url: n.url,
  };
  if (isPull) {
    s.reviewDecision = (n.reviewDecision ?? null) as ReviewDecision;
    s.checks = checksState(lastRollup(n)?.state);
    s.headRef = n.headRefName;
    s.baseRef = n.baseRefName;
  }
  return s;
}

export function comment(n: Raw): TimelineEntry {
  return {
    id: n.id, type: 'comment', author: user(n.author), bodyHTML: n.bodyHTML ?? '', createdAt: n.createdAt,
    url: n.url, reactions: reactions(n.reactionGroups),
  };
}

function event(n: Raw, name: string, detail?: string, extra?: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: n.id, type: 'event', author: user(n.actor), bodyHTML: '', createdAt: n.createdAt, reactions: [],
    event: name, eventDetail: detail, ...extra,
  };
}

/** Returns null for entries that should not be shown (pending or empty reviews, unknown types). */
export function timelineEntry(n: Raw): TimelineEntry | null {
  switch (n.__typename) {
    case 'IssueComment':
      return comment(n);
    case 'PullRequestReview': {
      const count = n.comments?.totalCount ?? 0;
      if (n.state === 'PENDING') return null;
      if (n.state === 'COMMENTED' && !n.bodyHTML && count === 0) return null;
      return { ...comment(n), type: 'review', reviewState: n.state as ReviewState, reviewCommentCount: count };
    }
    case 'LabeledEvent':
      return event(n, 'labeled', n.label?.name, { eventLabel: n.label ? label(n.label) : undefined });
    case 'UnlabeledEvent':
      return event(n, 'unlabeled', n.label?.name, { eventLabel: n.label ? label(n.label) : undefined });
    case 'AssignedEvent':
      return event(n, 'assigned', n.assignee?.login);
    case 'UnassignedEvent':
      return event(n, 'unassigned', n.assignee?.login);
    case 'ClosedEvent': {
      const c = n.closer;
      const via = c?.__typename === 'PullRequest' ? `via #${c.number}` : c?.__typename === 'Commit' ? `via ${c.abbreviatedOid}` : undefined;
      return event(n, 'closed', via);
    }
    case 'ReopenedEvent':
      return event(n, 'reopened');
    case 'MergedEvent':
      return event(n, 'merged', [n.commit?.abbreviatedOid, n.mergeRefName && `into ${n.mergeRefName}`].filter(Boolean).join(' ') || undefined);
    case 'RenamedTitleEvent':
      return event(n, 'renamed', `${n.previousTitle} → ${n.currentTitle}`);
    case 'ReviewRequestedEvent': {
      const r = n.requestedReviewer;
      return event(n, 'review_requested', r?.login ?? (r?.__typename === 'Team' ? 'a team' : undefined));
    }
    case 'CrossReferencedEvent': {
      const s = n.source;
      if (!s?.number) return event(n, 'referenced');
      return event(n, 'referenced', `${s.repository?.nameWithOwner ?? ''}#${s.number} ${s.title}`.trim(), { url: s.url });
    }
    case 'HeadRefForcePushedEvent':
      return event(n, 'head_ref_force_pushed', n.afterCommit?.abbreviatedOid);
    case 'ReadyForReviewEvent':
      return event(n, 'ready_for_review');
    case 'ConvertToDraftEvent':
      return event(n, 'convert_to_draft');
    default:
      return null;
  }
}

function timeline(n: Raw): TimelineEntry[] {
  return (n.timelineItems?.nodes ?? [])
    .map(timelineEntry)
    .filter((e: TimelineEntry | null): e is TimelineEntry => !!e)
    .sort((a: TimelineEntry, b: TimelineEntry) => a.createdAt.localeCompare(b.createdAt));
}

export function issueDetail(n: Raw, repoArchived: boolean): IssueDetail {
  return {
    ...summary(n),
    bodyHTML: n.bodyHTML ?? '',
    milestone: n.milestone ? { title: n.milestone.title, url: n.milestone.url } : null,
    participants: users(n.participants?.nodes),
    closedAt: n.closedAt ?? null,
    timeline: timeline(n),
    viewerCanComment: !n.locked && !repoArchived,
  };
}

function checkRun(c: Raw): CheckRun | null {
  if (c.__typename === 'CheckRun') {
    return { name: c.name, status: c.status, conclusion: c.conclusion ?? null, url: c.detailsUrl ?? undefined };
  }
  if (c.__typename === 'StatusContext') {
    const s = checksState(c.state);
    return {
      name: c.context,
      status: s === 'PENDING' ? 'PENDING' : 'COMPLETED',
      conclusion: s === 'PENDING' ? null : s === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
      url: c.targetUrl ?? undefined,
    };
  }
  return null;
}

export function pullDetail(n: Raw, repoArchived: boolean): PullDetail {
  const base = issueDetail({ ...n, __typename: 'PullRequest' }, repoArchived);
  const rollup = lastRollup(n);
  return {
    ...base,
    kind: 'pull',
    headRef: n.headRefName,
    baseRef: n.baseRefName,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    changedFiles: n.changedFiles ?? 0,
    commitCount: n.commits?.totalCount ?? 0,
    mergeable: n.mergeable ?? 'UNKNOWN',
    reviewRequests: users((n.reviewRequests?.nodes ?? []).map((r: Raw) => r.requestedReviewer)),
    latestReviews: (n.latestReviews?.nodes ?? []).map((r: Raw) => ({ author: user(r.author), state: r.state as ReviewState })),
    checkRuns: (rollup?.contexts?.nodes ?? []).map(checkRun).filter((c: CheckRun | null): c is CheckRun => !!c),
    files: (n.files?.nodes ?? []).map((f: Raw): ChangedFile => ({ path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.changeType })),
    mergedAt: n.mergedAt ?? null,
    mergedBy: user(n.mergedBy),
  };
}
