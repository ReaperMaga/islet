// GraphQL documents for the GitHub v4 API. Only fields that src/api/map.ts maps are requested.

const ACTOR = 'login avatarUrl url';
const REACTIONS = 'reactionGroups { content reactors { totalCount } }';
const LABEL = 'name color description';

const ISSUE_SUMMARY = `
  id number title state url createdAt updatedAt
  author { ${ACTOR} }
  comments { totalCount }
  labels(first: 10) { nodes { ${LABEL} } }
  assignees(first: 5) { nodes { ${ACTOR} } }
`;

const PULL_SUMMARY = `
  ${ISSUE_SUMMARY}
  isDraft reviewDecision headRefName baseRefName
`;

const ROLLUP_STATE = 'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';

export const VIEWER = `query { viewer { ${ACTOR} } }`;

export const SEARCH = `
query Search($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { ${ISSUE_SUMMARY} }
      ... on PullRequest { ${PULL_SUMMARY} ${ROLLUP_STATE} }
    }
  }
}`;

// Timeline item fragments. Issue-valid ones first, PR-only ones after.
const COMMENT_FIELDS = `id author { ${ACTOR} } bodyHTML createdAt url ${REACTIONS}`;
const ASSIGNEE = '... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Organization { login }';
const REF_SOURCE = 'number title url repository { nameWithOwner }';

const TIMELINE_COMMON = `
  __typename
  ... on IssueComment { ${COMMENT_FIELDS} }
  ... on LabeledEvent { id createdAt actor { ${ACTOR} } label { ${LABEL} } }
  ... on UnlabeledEvent { id createdAt actor { ${ACTOR} } label { ${LABEL} } }
  ... on AssignedEvent { id createdAt actor { ${ACTOR} } assignee { ${ASSIGNEE} } }
  ... on UnassignedEvent { id createdAt actor { ${ACTOR} } assignee { ${ASSIGNEE} } }
  ... on ClosedEvent { id createdAt actor { ${ACTOR} } closer { __typename ... on PullRequest { number } ... on Commit { abbreviatedOid } } }
  ... on ReopenedEvent { id createdAt actor { ${ACTOR} } }
  ... on RenamedTitleEvent { id createdAt actor { ${ACTOR} } previousTitle currentTitle }
  ... on CrossReferencedEvent { id createdAt actor { ${ACTOR} } source { __typename ... on Issue { ${REF_SOURCE} } ... on PullRequest { ${REF_SOURCE} } } }
`;

const TIMELINE_PULL = `
  ${TIMELINE_COMMON}
  ... on PullRequestReview { ${COMMENT_FIELDS} state comments { totalCount } }
  ... on MergedEvent { id createdAt actor { ${ACTOR} } mergeRefName commit { abbreviatedOid } }
  ... on ReviewRequestedEvent { id createdAt actor { ${ACTOR} } requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
  ... on HeadRefForcePushedEvent { id createdAt actor { ${ACTOR} } afterCommit { abbreviatedOid } }
  ... on ReadyForReviewEvent { id createdAt actor { ${ACTOR} } }
  ... on ConvertToDraftEvent { id createdAt actor { ${ACTOR} } }
`;

const ISSUE_TYPES = 'ISSUE_COMMENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, CLOSED_EVENT, REOPENED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT';
const PULL_TYPES = `${ISSUE_TYPES}, PULL_REQUEST_REVIEW, MERGED_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT`;

// `last: 100` keeps the most recent activity on long threads; nodes still come oldest first.
const DETAIL_COMMON = `
  bodyHTML closedAt locked
  milestone { title url }
  participants(first: 10) { nodes { ${ACTOR} } }
`;

export const ISSUE_DETAIL = `
query IssueDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    isArchived
    issue(number: $number) {
      ${ISSUE_SUMMARY}
      ${DETAIL_COMMON}
      timelineItems(last: 100, itemTypes: [${ISSUE_TYPES}]) { nodes { ${TIMELINE_COMMON} } }
    }
  }
}`;

export const PULL_DETAIL = `
query PullDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    isArchived
    pullRequest(number: $number) {
      ${PULL_SUMMARY}
      ${DETAIL_COMMON}
      additions deletions changedFiles mergeable mergedAt
      mergedBy { ${ACTOR} }
      commits(last: 1) {
        totalCount
        nodes { commit { statusCheckRollup {
          state
          contexts(first: 100) { nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl }
            ... on StatusContext { context state targetUrl }
          } }
        } } }
      }
      reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { ${ACTOR} } } } }
      latestReviews(first: 10) { nodes { author { ${ACTOR} } state } }
      files(first: 100) { nodes { path additions deletions changeType } }
      timelineItems(last: 100, itemTypes: [${PULL_TYPES}]) { nodes { ${TIMELINE_PULL} } }
    }
  }
}`;

export const NODE_ID = `
query NodeId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) { ... on Issue { id } ... on PullRequest { id } }
  }
}`;

export const ADD_COMMENT = `
mutation AddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { ${COMMENT_FIELDS} } }
  }
}`;
