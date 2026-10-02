// Persisted UI state of the sidebar (survives the view being hidden via the webview state API).

import type { ItemKind, ListFilter, ScopeFilter, StateFilter } from '../../shared/types';
import { getState, setState } from '../shared/bridge';

export interface Persisted {
  kind: ItemKind;
  filter: ListFilter;
  scrollTop: number;
}

const STATES: StateFilter[] = ['open', 'closed', 'all'];
const SCOPES: ScopeFilter[] = ['all', 'mine', 'assigned', 'review'];

export function loadPersisted(): Persisted {
  const s = getState<Partial<Persisted>>() ?? {};
  const f: Partial<ListFilter> = s.filter ?? {};
  const kind: ItemKind = s.kind === 'pull' ? 'pull' : 'issue';
  let scope: ScopeFilter = SCOPES.includes(f.scope as ScopeFilter) ? (f.scope as ScopeFilter) : 'all';
  if (scope === 'review' && kind === 'issue') scope = 'all';
  return {
    kind,
    filter: {
      state: STATES.includes(f.state as StateFilter) ? (f.state as StateFilter) : 'open',
      scope,
      query: typeof f.query === 'string' ? f.query : '',
    },
    scrollTop: typeof s.scrollTop === 'number' ? s.scrollTop : 0,
  };
}

export function savePersisted(p: Persisted): void {
  setState<Persisted>(p);
}

export const SCOPE_LABELS: Record<ScopeFilter, string> = {
  all: 'Everything',
  mine: 'Created by me',
  assigned: 'Assigned to me',
  review: 'Review requested',
};

export const STATE_LABELS: Record<StateFilter, string> = { open: 'Open', closed: 'Closed', all: 'All' };

export function isDefaultFilter(f: ListFilter): boolean {
  return f.state === 'open' && f.scope === 'all' && !f.query.trim();
}
