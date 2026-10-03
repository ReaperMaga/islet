// "Gradle Run" view in the Testing sidebar: only the tests of the current run, in the order they
// start, with live state (running, passed, failed, skipped) and durations, like JetBrains' run tree.
import * as vscode from 'vscode';

export type RunState = 'running' | 'passed' | 'failed' | 'skipped';

interface Node {
  id: string;
  label: string;
  /** The Testing item this row stands for (for "go to test"). */
  item: vscode.TestItem;
  state: RunState;
  ms?: number;
  children: Map<string, Node>;
  parent?: Node;
  /** Leaf = an actual test or invocation, not a class/module group. */
  leaf: boolean;
}

const ORDER: Record<RunState, number> = { failed: 0, running: 1, skipped: 2, passed: 3 };

export class RunTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly roots = new Map<string, Node>();
  private readonly byItem = new Map<string, Node>();
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private refreshTimer: NodeJS.Timeout | undefined;
  private title = '';
  private finished = false;

  constructor(private readonly describeChain: (item: vscode.TestItem) => vscode.TestItem[]) {
    this.view = vscode.window.createTreeView('islet.gradleRun', { treeDataProvider: this, showCollapseAll: true });
    this.view.message = 'Run Gradle tests to see them here as they run.';
  }

  reset(title: string): void {
    this.roots.clear();
    this.byItem.clear();
    this.title = title;
    this.finished = false;
    this.view.message = undefined;
    this.schedule();
  }

  started(item: vscode.TestItem): void {
    const node = this.ensure(item);
    node.state = 'running';
    node.ms = undefined;
    this.schedule();
  }

  result(item: vscode.TestItem, state: Exclude<RunState, 'running'>, ms?: number): void {
    const node = this.ensure(item);
    node.state = state;
    node.ms = ms;
    this.schedule();
  }

  /** Run ended: tests still marked running did not finish (stopped or cancelled). */
  done(): void {
    this.finished = true;
    for (const n of this.byItem.values()) if (n.leaf && n.state === 'running') n.state = 'skipped';
    this.schedule();
  }

  /** Creates the row for a test and its class/module parents, in the order first seen. */
  private ensure(item: vscode.TestItem): Node {
    const existing = this.byItem.get(item.id);
    if (existing) return existing;
    const chain = this.describeChain(item); // outermost first, ending with `item`
    let parent: Node | undefined;
    let level = this.roots;
    let node: Node | undefined;
    chain.forEach((link, i) => {
      node = level.get(link.id);
      if (!node) {
        node = { id: link.id, label: link.label, item: link, state: 'running', children: new Map(), parent, leaf: i === chain.length - 1 };
        level.set(link.id, node);
        this.byItem.set(link.id, node);
      }
      if (i === chain.length - 1) node.leaf = true;
      parent = node;
      level = node.children;
    });
    return node!;
  }

  /** A group's state from its tests: failed > running > skipped-only > passed. */
  private stateOf(n: Node): RunState {
    if (n.leaf && !n.children.size) return n.state;
    let failed = false, running = false, allSkipped = true, any = false;
    for (const c of n.children.values()) {
      const s = this.stateOf(c);
      any = true;
      if (s === 'failed') failed = true;
      if (s === 'running') running = true;
      if (s !== 'skipped') allSkipped = false;
    }
    if (n.leaf && (n.state === 'failed' || n.state === 'running')) return n.state;
    if (failed) return 'failed';
    if (running) return 'running';
    return any && allSkipped ? 'skipped' : 'passed';
  }

  private durationOf(n: Node): number | undefined {
    if (!n.children.size) return n.ms;
    let total = 0, some = false;
    for (const c of n.children.values()) {
      const d = this.durationOf(c);
      if (d !== undefined) {
        total += d;
        some = true;
      }
    }
    return some ? total : n.ms;
  }

  private schedule(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.updateHeader();
      this.changed.fire(undefined);
    }, 150);
  }

  private updateHeader(): void {
    let running = 0, passed = 0, failed = 0, skipped = 0;
    for (const n of this.byItem.values()) {
      if (!n.leaf || n.children.size) continue;
      if (n.state === 'running') running++;
      else if (n.state === 'passed') passed++;
      else if (n.state === 'failed') failed++;
      else skipped++;
    }
    const parts = [
      running ? `${running} running` : '',
      `${passed} ✓`,
      failed ? `${failed} ✗` : '',
      skipped ? `${skipped} skipped` : '',
    ].filter(Boolean);
    this.view.description = this.title ? `${this.finished ? 'done · ' : ''}${parts.join(' · ')}` : undefined;
  }

  getChildren(parent?: Node): Node[] {
    const list = [...(parent ? parent.children : this.roots).values()];
    // Failed first, then running, then the rest in run order.
    return list
      .map((n, i) => ({ n, i }))
      .sort((a, b) => ORDER[this.stateOf(a.n)] - ORDER[this.stateOf(b.n)] || a.i - b.i)
      .map((x) => x.n);
  }

  getParent(n: Node): Node | undefined {
    return n.parent;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const state = this.stateOf(n);
    const group = n.children.size > 0;
    const t = new vscode.TreeItem(
      n.label,
      !group
        ? vscode.TreeItemCollapsibleState.None
        : state === 'failed' || state === 'running'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    t.id = `${n.id}|${group ? (state === 'failed' || state === 'running' ? 'open' : 'closed') : ''}`;
    const ms = this.durationOf(n);
    t.description = ms !== undefined && state !== 'running' ? formatMs(ms) : undefined;
    t.iconPath =
      state === 'running'
        ? new vscode.ThemeIcon('loading~spin')
        : state === 'passed'
          ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
          : state === 'failed'
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
            : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconSkipped'));
    if (n.item.uri) {
      t.command = {
        command: 'vscode.open',
        title: 'Go to test',
        arguments: [n.item.uri, n.item.range ? { selection: new vscode.Range(n.item.range.start, n.item.range.start) } : undefined],
      };
    }
    t.tooltip = `${n.label} · ${state}${ms !== undefined ? ` · ${formatMs(ms)}` : ''}`;
    return t;
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.view.dispose();
    this.changed.dispose();
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
