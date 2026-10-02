// Data model shared by the extension host, the GitHub API layer and both webviews.
// This file is the contract between all parts. Change it only in coordination.

export type ItemKind = 'issue' | 'pull';
export type ItemState = 'open' | 'closed' | 'merged';

export interface RepoRef {
  owner: string;
  name: string;
  /** https://github.com/owner/name */
  url: string;
  /** Absolute path of the local repository root. */
  rootPath: string;
  /** Currently checked-out local branch, if any. */
  currentBranch?: string;
}

export interface UserLite {
  login: string;
  avatarUrl: string;
  url: string;
}

export interface Label {
  name: string;
  /** Hex colour without '#', as GitHub returns it, e.g. "d73a4a". */
  color: string;
  description?: string | null;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type ChecksState = 'SUCCESS' | 'FAILURE' | 'PENDING' | null;

/** One row in the sidebar list. */
export interface ItemSummary {
  kind: ItemKind;
  number: number;
  title: string;
  state: ItemState;
  isDraft: boolean;
  author: UserLite | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  commentCount: number;
  labels: Label[];
  assignees: UserLite[];
  url: string;
  // Pull requests only (null/undefined for issues):
  reviewDecision?: ReviewDecision;
  checks?: ChecksState;
  headRef?: string;
  baseRef?: string;
}

export interface Reaction {
  /** GitHub ReactionContent, e.g. THUMBS_UP, HEART, ROCKET. */
  content: string;
  count: number;
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface TimelineEntry {
  id: string;
  type: 'comment' | 'review' | 'event';
  author: UserLite | null;
  /** Rendered, sanitised HTML from GitHub (bodyHTML). May be empty for events/reviews without text. */
  bodyHTML: string;
  createdAt: string;
  url?: string;
  reactions: Reaction[];
  /** For type === 'review'. */
  reviewState?: ReviewState;
  /** For type === 'review': number of inline code comments in that review. */
  reviewCommentCount?: number;
  /**
   * For type === 'event': short machine name, e.g. 'labeled', 'unlabeled', 'assigned', 'closed',
   * 'reopened', 'merged', 'referenced', 'renamed', 'review_requested', 'head_ref_force_pushed'.
   */
  event?: string;
  /** For events: human readable detail, e.g. label name, new title, assignee login. */
  eventDetail?: string;
  /** For 'labeled'/'unlabeled' events. */
  eventLabel?: Label;
}

export interface CheckRun {
  name: string;
  /** QUEUED | IN_PROGRESS | COMPLETED | PENDING ... */
  status: string;
  /** SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | null */
  conclusion: string | null;
  url?: string;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  /** ADDED | DELETED | MODIFIED | RENAMED | COPIED | CHANGED */
  changeType: string;
}

export interface IssueDetail extends ItemSummary {
  bodyHTML: string;
  milestone: { title: string; url: string } | null;
  participants: UserLite[];
  closedAt: string | null;
  /** Comments, reviews and events, sorted oldest first. */
  timeline: TimelineEntry[];
  /** True when the signed-in user may comment. */
  viewerCanComment: boolean;
}

export interface PullDetail extends IssueDetail {
  kind: 'pull';
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  reviewRequests: UserLite[];
  /** Latest review per reviewer. */
  latestReviews: { author: UserLite | null; state: ReviewState }[];
  checkRuns: CheckRun[];
  files: ChangedFile[];
  mergedAt: string | null;
  mergedBy: UserLite | null;
}

export type ItemDetail = IssueDetail | PullDetail;

export type StateFilter = 'open' | 'closed' | 'all';
/** all = everything; mine = created by me; assigned = assigned to me; review = PRs awaiting my review */
export type ScopeFilter = 'all' | 'mine' | 'assigned' | 'review';

export interface ListFilter {
  state: StateFilter;
  scope: ScopeFilter;
  /** Free text search, may be empty. */
  query: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ListPage {
  items: ItemSummary[];
  pageInfo: PageInfo;
  totalCount: number;
}
