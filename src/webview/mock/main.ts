// Fake extension host for previewing the webviews in a normal browser (dev/*.html).
// Serves data from fixtures.json, which scripts/dump-fixtures.ts generates from the real GitHub API.

import type { ToExtension, ToWebview } from '../../shared/protocol';
import type { ItemDetail, ItemSummary, ListPage, Session, TimelineEntry } from '../../shared/types';
import fixtures from './fixtures.json';

const data = fixtures as unknown as {
  session: Session;
  issues: ItemSummary[];
  pulls: ItemSummary[];
  details: Record<string, ItemDetail>;
};

function page(items: ItemSummary[]): ListPage {
  return { items, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: items.length };
}

window.__airMock = {
  post(msg: ToExtension, reply: (m: ToWebview) => void) {
    switch (msg.type) {
      case 'ready':
        reply({ type: 'session', session: data.session });
        break;
      case 'list': {
        let items = msg.kind === 'issue' ? data.issues : data.pulls;
        if (msg.filter.state !== 'all') items = items.filter((i) => (msg.filter.state === 'open' ? i.state === 'open' : i.state !== 'open'));
        const q = msg.filter.query.trim().toLowerCase();
        if (q) items = items.filter((i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q));
        reply({ type: 'listResult', requestId: msg.requestId, kind: msg.kind, page: page(items), append: !!msg.cursor });
        break;
      }
      case 'detail': {
        const d = data.details[`${msg.kind}-${msg.number}`];
        if (d) reply({ type: 'detailResult', requestId: msg.requestId, item: d });
        else reply({ type: 'error', requestId: msg.requestId, message: `No fixture for ${msg.kind} #${msg.number}` });
        break;
      }
      case 'addComment': {
        const entry: TimelineEntry = {
          id: 'mock-' + Date.now(), type: 'comment', author: data.session.user, bodyHTML: `<p>${msg.body.replace(/</g, '&lt;')}</p>`,
          createdAt: new Date().toISOString(), reactions: [],
        };
        reply({ type: 'commentAdded', requestId: msg.requestId, entry });
        break;
      }
      case 'openItem': {
        // In the browser, open the detail preview page for that item.
        window.open(`detail.html?kind=${msg.kind}&number=${msg.number}`, '_blank');
        break;
      }
      default:
        console.log('[mock] unhandled', msg);
    }
  },
};
