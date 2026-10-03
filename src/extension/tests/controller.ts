// Gradle test results in VS Code's Testing panel.
//
// Tests are discovered from source (so run buttons appear before the first run), and results come
// from the JUnit XML files Gradle writes to build/test-results/<task>/. Because results are read from
// those files, every Gradle test run shows up: started from the terminal, from the Gradle extension's
// Tasks view, or from Islet's own Run buttons.
//
// Live progress (a spinner per running test, results as each test finishes) comes from a small
// Gradle init script that appends events to build/islet/test-events/<task>.jsonl. Islet passes it
// to its own runs; with "islet.gradleTests.trackAllRuns" it is also installed in ~/.gradle/init.d
// so runs started from the terminal or the Gradle extension report live too.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';
import { discoverTests } from './discovery';
import { GradleModule, gradleCommand, moduleFor, resultLocation, testArgs } from './gradle';
import { INIT_SCRIPT, INIT_SCRIPT_MARKER, INIT_SCRIPT_NAME } from './initScript';
import { CaseStatus, parseJUnitXml, splitCaseName, SuiteResult, TestCaseResult } from './junitXml';

const SOURCE_GLOB = '**/src/*[tT]est*/{kotlin,java}/**/*.{kt,java}';
const RESULT_GLOB = '**/build/test-results/**';
const EVENTS_GLOB = '**/build/islet/test-events/*.jsonl';
const EXCLUDE_GLOB = '{**/node_modules/**,**/build/**,**/.gradle/**}';
const TASK_TYPE = 'islet-gradle';
/** A run started by a file change or a foreign Gradle task ends this long after the last activity. */
const IDLE_END_MS = 5000;
/** A run with tests still marked running is ended anyway after this long without any activity. */
const STALE_RUN_MS = 10 * 60_000;
const XML_BATCH_MS = 400;

type ItemKind = 'module' | 'class' | 'test' | 'invocation';

interface ItemData {
  kind: ItemKind;
  module: GradleModule;
  /** Binary class name (class, test, invocation). */
  className?: string;
  /** Method name (test, invocation). */
  method?: string;
  /** Whether the test method reports several invocations (parameterized etc.). */
  multi?: boolean;
}

interface ActiveRun {
  run: vscode.TestRun;
  /** Started by Islet's Run button. */
  own: boolean;
  /** Foreign Gradle tasks currently running; the run stays open while > 0. */
  tasks: number;
  idle?: NodeJS.Timeout;
  /** Items that received a result in this run. */
  reported: Set<vscode.TestItem>;
  /** Tests reported as started but not finished yet (live events). */
  running: Set<vscode.TestItem>;
  /** Classes ("<module dir>|<class>") whose output arrived live, so the report's copy isn't shown twice. */
  liveOutput: Set<string>;
  /** Time of the last result or event (runs Islet did not start). */
  lastActivity?: number;
}

export class GradleTests implements vscode.Disposable {
  private readonly ctrl = vscode.tests.createTestController('islet.gradle', 'Gradle');
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  private readonly modules = new Map<string, GradleModule>();
  /** Last task name seen in results per module dir (e.g. "test", "integrationTest"). */
  private readonly moduleTask = new Map<string, string>();
  /** Class ids discovered per source file, to clean up when a file changes. */
  private readonly fileClasses = new Map<string, Set<string>>();
  private readonly subs: vscode.Disposable[] = [];
  private active: ActiveRun | undefined;
  private xmlQueue = new Set<string>();
  private xmlTimer: NodeJS.Timeout | undefined;
  private flushed: Promise<void> = Promise.resolve();
  /** Bytes of each live event file already processed. */
  private readonly eventOffsets = new Map<string, number>();
  /** Init script passed to Islet's own Gradle runs. */
  private readonly initScriptPath: string;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.initScriptPath = path.join(storageDir, INIT_SCRIPT_NAME);
    fs.writeFileSync(this.initScriptPath, INIT_SCRIPT);
    this.syncGlobalInitScript();

    this.ctrl.createRunProfile('Run with Gradle', vscode.TestRunProfileKind.Run, (req, token) => this.runFromUi(req, token), true);
    this.ctrl.refreshHandler = () => this.discoverAll();

    const sources = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    sources.onDidCreate((u) => this.discoverFile(u));
    sources.onDidChange((u) => this.discoverFile(u));
    sources.onDidDelete((u) => this.forgetFile(u));

    const results = vscode.workspace.createFileSystemWatcher(RESULT_GLOB);
    results.onDidCreate((u) => this.onResultFile(u));
    results.onDidChange((u) => this.onResultFile(u));

    const events = vscode.workspace.createFileSystemWatcher(EVENTS_GLOB);
    events.onDidCreate((u) => this.onEventFile(u));
    events.onDidChange((u) => this.onEventFile(u));

    this.subs.push(
      this.ctrl,
      sources,
      results,
      events,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('islet.gradleTests')) this.syncGlobalInitScript();
      }),
      vscode.tasks.onDidStartTaskProcess((e) => this.onTaskStart(e.execution.task)),
      vscode.tasks.onDidEndTaskProcess((e) => this.onTaskEnd(e.execution.task)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discoverAll()),
    );

    void this.discoverAll().then(() => this.loadExistingResults());
  }

  // ------------------------------------------------------------------ discovery

  private async discoverAll(): Promise<void> {
    const files = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, 10000);
    for (const f of files) await this.discoverFile(f);
    log.info(`Gradle tests: discovered ${files.length} test source files`);
  }

  private async discoverFile(uri: vscode.Uri): Promise<void> {
    const mod = this.moduleOf(uri.fsPath);
    if (!mod) return;
    let text: string;
    try {
      text = (await vscode.workspace.fs.readFile(uri)).toString();
    } catch {
      return;
    }
    const found = discoverTests(text, uri.fsPath.endsWith('.kt') ? 'kotlin' : 'java');
    const before = this.fileClasses.get(uri.fsPath) ?? new Set<string>();
    const now = new Set<string>();

    for (const c of found) {
      const cls = this.classItem(mod, c.className, uri, c.line);
      now.add(cls.id);
      const keep: vscode.TestItem[] = [];
      for (const t of c.tests) {
        const item = this.testItem(cls, t.method);
        item.range = new vscode.Range(t.line, 0, t.line, 0);
        item.sortText = String(t.line).padStart(6, '0');
        this.data.get(item)!.multi = t.multi;
        keep.push(item);
      }
      // Keep nested classes and anything only known from results that still has a match.
      cls.children.forEach((child) => {
        const d = this.data.get(child);
        if (d?.kind === 'class' || (d?.kind === 'invocation' && !keep.length)) keep.push(child);
      });
      cls.children.replace(keep);
    }
    for (const id of before) if (!now.has(id)) this.removeById(id);
    this.fileClasses.set(uri.fsPath, now);
  }

  private forgetFile(uri: vscode.Uri): void {
    for (const id of this.fileClasses.get(uri.fsPath) ?? []) this.removeById(id);
    this.fileClasses.delete(uri.fsPath);
  }

  private removeById(id: string): void {
    const walk = (coll: vscode.TestItemCollection): boolean => {
      if (coll.get(id)) {
        coll.delete(id);
        return true;
      }
      let done = false;
      coll.forEach((c) => {
        if (!done) done = walk(c.children);
      });
      return done;
    };
    walk(this.ctrl.items);
    // Drop modules that became empty.
    this.ctrl.items.forEach((m) => {
      if (m.children.size === 0) this.ctrl.items.delete(m.id);
    });
  }

  // ------------------------------------------------------------------ test tree

  private moduleOf(file: string): GradleModule | undefined {
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    if (!ws) return undefined;
    const mod = moduleFor(file, ws.uri.fsPath);
    if (!mod) return undefined;
    const known = this.modules.get(mod.dir);
    if (known) return known;
    this.modules.set(mod.dir, mod);
    return mod;
  }

  private moduleItem(mod: GradleModule): vscode.TestItem {
    const id = `m|${mod.dir}`;
    let item = this.ctrl.items.get(id);
    if (!item) {
      const label = mod.projectPath ? `${path.basename(mod.rootDir)} ${mod.projectPath}` : path.basename(mod.dir);
      item = this.ctrl.createTestItem(id, label, vscode.Uri.file(mod.dir));
      this.data.set(item, { kind: 'module', module: mod });
      this.ctrl.items.add(item);
    }
    return item;
  }

  private classItem(mod: GradleModule, className: string, uri?: vscode.Uri, line?: number): vscode.TestItem {
    const dollar = className.lastIndexOf('$');
    const parent = dollar > 0 ? this.classItem(mod, className.slice(0, dollar), uri) : this.moduleItem(mod);
    const id = `c|${mod.dir}|${className}`;
    let item = parent.children.get(id);
    if (!item) {
      const simple = dollar > 0 ? className.slice(dollar + 1) : className.slice(className.lastIndexOf('.') + 1);
      item = this.ctrl.createTestItem(id, simple, uri ?? parent.uri);
      if (dollar < 0) item.description = className.slice(0, Math.max(0, className.lastIndexOf('.')));
      this.data.set(item, { kind: 'class', module: mod, className });
      parent.children.add(item);
    }
    if (uri && !item.uri?.fsPath.endsWith('.kt') && !item.uri?.fsPath.endsWith('.java')) {
      // Item was created from results before its source was known; recreate it with the file.
      const replacement = this.ctrl.createTestItem(id, item.label, uri);
      replacement.description = item.description;
      item.children.forEach((c) => replacement.children.add(c));
      this.data.set(replacement, this.data.get(item)!);
      parent.children.add(replacement);
      item = replacement;
    }
    if (line !== undefined) {
      item.range = new vscode.Range(line, 0, line, 0);
      item.sortText = String(line).padStart(6, '0');
    }
    return item;
  }

  private testItem(cls: vscode.TestItem, method: string): vscode.TestItem {
    const d = this.data.get(cls)!;
    const id = `t|${d.module.dir}|${d.className}|${method}`;
    let item = cls.children.get(id);
    if (!item) {
      item = this.ctrl.createTestItem(id, method, cls.uri);
      this.data.set(item, { kind: 'test', module: d.module, className: d.className, method });
      cls.children.add(item);
    }
    return item;
  }

  private invocationItem(parent: vscode.TestItem, name: string): vscode.TestItem {
    const d = this.data.get(parent)!;
    // Live events report "[1]", the XML report "[1] input=a": key by the index so both meet.
    const index = /^\[\d+\]/.exec(name)?.[0] ?? name;
    const id = `i|${parent.id}|${index}`;
    let item = parent.children.get(id);
    if (!item) {
      item = this.ctrl.createTestItem(id, name, parent.uri);
      item.range = parent.range;
      item.sortText = name.replace(/^\[(\d+)\]/, (_, n: string) => n.padStart(6, '0'));
      this.data.set(item, { kind: 'invocation', module: d.module, className: d.className, method: d.method });
      parent.children.add(item);
    } else if (name.length > item.label.length) {
      item.label = name; // prefer the more descriptive name
    }
    return item;
  }

  /** The item a reported test case belongs to, created on the fly if discovery missed it. */
  private itemForCase(mod: GradleModule, c: TestCaseResult): vscode.TestItem {
    const cls = this.classItem(mod, c.className);
    const { method, invocation } = splitCaseName(c.name);
    if (method) {
      const test = this.testItem(cls, method);
      return invocation ? this.invocationItem(test, invocation) : test;
    }
    // Invocation reported without a method name ("[1] input"): attach to the only multi-invocation
    // test of the class if there is exactly one, else to the class.
    const multi: vscode.TestItem[] = [];
    cls.children.forEach((t) => {
      if (this.data.get(t)?.multi) multi.push(t);
    });
    return this.invocationItem(multi.length === 1 ? multi[0] : cls, invocation ?? c.name);
  }

  // ------------------------------------------------------------------ results

  private onResultFile(uri: vscode.Uri): void {
    if (!this.enabled()) return;
    const p = uri.fsPath;
    this.ensureRun(); // any write under test-results means Gradle is testing right now
    if (p.endsWith('.xml') && path.basename(p).startsWith('TEST-')) {
      this.xmlQueue.add(p);
      clearTimeout(this.xmlTimer);
      this.xmlTimer = setTimeout(() => {
        this.flushed = this.flushXml();
      }, XML_BATCH_MS);
    }
  }

  /** Live events: read the lines appended since last time and update the running tests. */
  private onEventFile(uri: vscode.Uri): void {
    if (!this.enabled()) return;
    const file = uri.fsPath;
    let text: string;
    try {
      const size = fs.statSync(file).size;
      let offset = this.eventOffsets.get(file) ?? 0;
      if (size < offset) offset = 0; // truncated: a new run of that task started
      if (size === offset) return;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      // Only consume whole lines; a partially written last line is read next time.
      const end = text.lastIndexOf('\n');
      if (end < 0) return;
      text = text.slice(0, end + 1);
      this.eventOffsets.set(file, offset + Buffer.byteLength(text, 'utf8'));
    } catch {
      return;
    }

    // .../<module>/build/islet/test-events/<task>.jsonl
    const moduleDir = path.dirname(path.dirname(path.dirname(path.dirname(file))));
    const mod = this.moduleOf(path.join(moduleDir, 'build.gradle.kts'));
    if (!mod) return;
    this.moduleTask.set(mod.dir, path.basename(file, '.jsonl'));
    const active = this.ensureRun();

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev: {
        e?: string; cls?: string; name?: string | null; std?: string; text?: string;
        result?: string; ms?: number; msg?: string | null; trace?: string | null;
      };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.e === 'out') {
        // Output printed by a test, by class-level setup, or by the test JVM as a whole (e.g. a
        // Quarkus application booting once for all tests), which goes to the run's own log.
        if (!ev.text) continue;
        const target = !ev.cls
          ? undefined
          : ev.name
            ? this.itemForCase(mod, { name: ev.name, className: ev.cls, time: 0, status: 'passed' })
            : this.classItem(mod, ev.cls);
        active.run.appendOutput(toTerminal(ev.text, ev.std === 'StdErr'), undefined, target);
        if (ev.cls) active.liveOutput.add(`${mod.dir}|${ev.cls}`);
        continue;
      }
      if (!ev.cls || !ev.name) continue;
      const item = this.itemForCase(mod, { name: ev.name, className: ev.cls, time: 0, status: 'passed' });
      if (ev.e === 'start') {
        active.run.started(item);
        active.running.add(item);
      } else if (ev.e === 'done') {
        const status: CaseStatus = ev.result === 'SUCCESS' ? 'passed' : ev.result === 'SKIPPED' ? 'skipped' : 'failed';
        this.report(active, item, {
          name: ev.name,
          className: ev.cls,
          time: (ev.ms ?? 0) / 1000,
          status,
          message: ev.msg ?? undefined,
          details: ev.trace ?? undefined,
        });
      }
    }
    this.touch(active);
  }

  /** Installs or removes the init script in the Gradle user home according to the setting. */
  private syncGlobalInitScript(): void {
    const cfg = vscode.workspace.getConfiguration('islet.gradleTests');
    const want = cfg.get<boolean>('enabled', true) && cfg.get<boolean>('trackAllRuns', false);
    const home = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
    const target = path.join(home, 'init.d', INIT_SCRIPT_NAME);
    try {
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
      if (existing !== undefined && !existing.startsWith(INIT_SCRIPT_MARKER)) {
        log.warn(`Gradle tests: ${target} exists and is not Islet's; leaving it alone`);
        return;
      }
      if (want && existing !== INIT_SCRIPT) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, INIT_SCRIPT);
        log.info(`Gradle tests: installed live progress reporter at ${target}`);
      } else if (!want && existing !== undefined) {
        fs.unlinkSync(target);
        log.info(`Gradle tests: removed live progress reporter from ${target}`);
      }
    } catch (err) {
      log.error('Gradle tests: could not update the Gradle init script', err);
    }
  }

  private async flushXml(): Promise<void> {
    const files = [...this.xmlQueue];
    this.xmlQueue.clear();
    const active = this.ensureRun();
    for (const file of files) this.applyResultFile(file, active);
    this.touch(active);
  }

  private applyResultFile(file: string, active: ActiveRun): void {
    const loc = resultLocation(file);
    if (!loc) return;
    let suite: SuiteResult | null;
    try {
      suite = parseJUnitXml(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log.warn(`Gradle tests: could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!suite) return;
    const mod = this.moduleOf(path.join(loc.moduleDir, 'build.gradle.kts'));
    if (!mod) return;
    this.moduleTask.set(mod.dir, loc.task);
    for (const c of suite.cases) {
      const item = this.itemForCase(mod, c);
      this.report(active, item, c);
    }
    // Output stored in the report, for runs that had no live reporter.
    if (!active.liveOutput.has(`${mod.dir}|${suite.name}`) && (suite.systemOut || suite.systemErr)) {
      const cls = this.classItem(mod, suite.name);
      if (suite.systemOut) active.run.appendOutput(toTerminal(suite.systemOut, false), undefined, cls);
      if (suite.systemErr) active.run.appendOutput(toTerminal(suite.systemErr, true), undefined, cls);
    }
  }

  private report(active: ActiveRun, item: vscode.TestItem, c: TestCaseResult): void {
    const ms = c.time * 1000;
    // Live events and the final XML report the same result: keep the first one only.
    const firstReport = !active.reported.has(item);
    active.reported.add(item);
    active.running.delete(item);
    if (!firstReport) return;
    const status: CaseStatus = c.status;
    if (status === 'passed') active.run.passed(item, ms);
    else if (status === 'skipped') active.run.skipped(item);
    else {
      const msg = this.failureMessage(item, c);
      if (status === 'failed') active.run.failed(item, msg, ms);
      else active.run.errored(item, msg, ms);
      if (c.details) active.run.appendOutput(c.details.replace(/\r?\n/g, '\r\n') + '\r\n', msg.location, item);
    }
  }

  private failureMessage(item: vscode.TestItem, c: TestCaseResult): vscode.TestMessage {
    const text = c.details || c.message || 'Test failed';
    const head = c.message ?? text.split('\n')[0];
    // JUnit's assertEquals: "... ==> expected: <5> but was: <4>" -> show a diff.
    const cmp = /expected:\s*<([\s\S]*?)>\s*but was:\s*<([\s\S]*?)>/.exec(head);
    const msg = cmp ? vscode.TestMessage.diff(text, cmp[1], cmp[2]) : new vscode.TestMessage(text);
    const file = item.uri?.fsPath;
    if (file && /\.(kt|java)$/.test(file)) {
      // First stack frame in the test's own file gives the failing line.
      const frame = new RegExp(`\\(${path.basename(file).replace(/[.]/g, '\\.')}:(\\d+)\\)`).exec(text);
      if (frame) msg.location = new vscode.Location(item.uri!, new vscode.Position(Number(frame[1]) - 1, 0));
      else if (item.range) msg.location = new vscode.Location(item.uri!, item.range);
    }
    return msg;
  }

  /** Shows results Gradle left behind from earlier runs, without opening any view. */
  private async loadExistingResults(): Promise<void> {
    if (!this.enabled()) return;
    const files = await vscode.workspace.findFiles('**/build/test-results/*/TEST-*.xml', '{**/node_modules/**}', 5000);
    if (!files.length) return;
    const run = this.ctrl.createTestRun(new vscode.TestRunRequest(), 'Last Gradle results', true);
    const active: ActiveRun = { run, own: true, tasks: 0, reported: new Set(), running: new Set(), liveOutput: new Set() };
    for (const f of files) this.applyResultFile(f.fsPath, active);
    run.end();
  }

  // ------------------------------------------------------------------ runs started outside Islet

  private ensureRun(): ActiveRun {
    if (this.active) return this.active;
    const run = this.ctrl.createTestRun(new vscode.TestRunRequest(), 'Gradle test', true);
    this.active = { run, own: false, tasks: 0, reported: new Set(), running: new Set(), liveOutput: new Set() };
    log.info('Gradle tests: detected a test run');
    this.reveal();
    this.touch(this.active);
    return this.active;
  }

  /** Ends a run that Islet did not start once Gradle has been quiet for a moment. */
  private touch(active: ActiveRun): void {
    if (active.own) return;
    active.lastActivity = Date.now();
    this.scheduleIdleEnd(active);
  }

  private scheduleIdleEnd(active: ActiveRun): void {
    clearTimeout(active.idle);
    active.idle = setTimeout(() => {
      if (this.active !== active) return;
      // Still busy (a Gradle task runs, or a test started but has not finished): wait, but not
      // forever, in case Gradle was killed mid-test.
      const busy = active.tasks > 0 || active.running.size > 0;
      if (busy && Date.now() - (active.lastActivity ?? 0) < STALE_RUN_MS) return this.scheduleIdleEnd(active);
      this.active = undefined;
      active.run.end();
    }, IDLE_END_MS);
  }

  private isGradleTestTask(task: vscode.Task): boolean {
    if (task.definition.type === TASK_TYPE) return false; // our own runs are tracked directly
    const text = [task.name, task.definition.script, task.definition.task, task.definition.command]
      .filter((v) => typeof v === 'string')
      .join(' ');
    const gradle = task.definition.type === 'gradle' || /gradlew|\bgradle\b/i.test(text);
    return gradle && /(^|[\s:])(test|check|\w*Test)\b/.test(text);
  }

  private onTaskStart(task: vscode.Task): void {
    if (!this.enabled() || !this.isGradleTestTask(task)) return;
    const active = this.ensureRun();
    active.tasks++;
  }

  private onTaskEnd(task: vscode.Task): void {
    if (!this.isGradleTestTask(task) || !this.active || this.active.own) return;
    const active = this.active;
    active.tasks = Math.max(0, active.tasks - 1);
    // Give the last result files a moment to land.
    setTimeout(() => this.touch(active), XML_BATCH_MS + 200);
  }

  private reveal(): void {
    if (!vscode.workspace.getConfiguration('islet.gradleTests').get<boolean>('revealOnRun', true)) return;
    void vscode.commands.executeCommand('workbench.panel.testResults.view.focus').then(undefined, () =>
      vscode.commands.executeCommand('workbench.view.testing.focus'),
    );
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('islet.gradleTests').get<boolean>('enabled', true);
  }

  // ------------------------------------------------------------------ Run button

  private async runFromUi(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    // A run already open from a terminal/task run is closed so this one owns the results.
    if (this.active && !this.active.own) {
      this.active.run.end();
      this.active = undefined;
    }
    const run = this.ctrl.createTestRun(request, 'Gradle test', true);
    const active: ActiveRun = { run, own: true, tasks: 0, reported: new Set(), running: new Set(), liveOutput: new Set() };
    this.active = active;
    this.reveal();

    const roots: vscode.TestItem[] = [];
    if (request.include) roots.push(...request.include);
    else this.ctrl.items.forEach((m) => roots.push(m));
    const excluded = new Set(request.exclude ?? []);

    // Group what to run by module: a whole module, or a list of --tests filters.
    const plan = new Map<string, { module: GradleModule; filters: Set<string>; all: boolean; leaves: vscode.TestItem[] }>();
    for (const item of roots) {
      if (excluded.has(item)) continue;
      const d = this.data.get(item);
      if (!d) continue;
      const entry = plan.get(d.module.dir) ?? { module: d.module, filters: new Set<string>(), all: false, leaves: [] };
      plan.set(d.module.dir, entry);
      if (d.kind === 'module') entry.all = true;
      else if (d.kind === 'class') entry.filters.add(d.className!);
      else entry.filters.add(`${d.className}.${d.method}`);
      this.collectLeaves(item, excluded, entry.leaves);
    }

    for (const entry of plan.values()) for (const leaf of entry.leaves) run.enqueued(leaf);

    try {
      for (const entry of plan.values()) {
        if (token.isCancellationRequested) break;
        for (const leaf of entry.leaves) run.started(leaf);
        const task = this.moduleTask.get(entry.module.dir) ?? 'test';
        const exitCode = await this.runGradle(entry.module, task, entry.all ? [] : [...entry.filters], token);
        await new Promise((r) => setTimeout(r, XML_BATCH_MS + 300));
        await this.flushed;
        const missing = entry.leaves.filter((l) => !active.reported.has(l) && !this.hasReportedChild(l, active));
        if (missing.length && exitCode !== 0 && !token.isCancellationRequested) {
          const note = new vscode.TestMessage(
            `Gradle exited with code ${exitCode ?? 'unknown'} before reporting this test. See the "Islet: Gradle" terminal for the build output.`,
          );
          for (const l of missing) run.errored(l, note);
        } else {
          for (const l of missing) run.skipped(l);
        }
      }
    } finally {
      if (this.active === active) this.active = undefined;
      run.end();
    }
  }

  private hasReportedChild(item: vscode.TestItem, active: ActiveRun): boolean {
    let found = false;
    item.children.forEach((c) => {
      if (!found && (active.reported.has(c) || this.hasReportedChild(c, active))) found = true;
    });
    return found;
  }

  private collectLeaves(item: vscode.TestItem, excluded: Set<vscode.TestItem>, out: vscode.TestItem[]): void {
    if (excluded.has(item)) return;
    const kind = this.data.get(item)?.kind;
    // A parameterized test with known invocations counts its invocations, not itself.
    if (kind === 'invocation' || (kind === 'test' && item.children.size === 0)) {
      out.push(item);
      return;
    }
    item.children.forEach((c) => this.collectLeaves(c, excluded, out));
  }

  private runGradle(mod: GradleModule, task: string, filters: string[], token: vscode.CancellationToken): Promise<number | undefined> {
    const { command, prefixArgs } = gradleCommand(mod.rootDir);
    const args = [...prefixArgs, '--init-script', this.initScriptPath, ...testArgs(mod, task, filters)];
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mod.rootDir)) ?? vscode.TaskScope.Workspace;
    const t = new vscode.Task(
      { type: TASK_TYPE, task, module: mod.projectPath || ':' },
      folder,
      `${path.basename(mod.rootDir)}${mod.projectPath}:${task}`,
      'Islet: Gradle',
      new vscode.ProcessExecution(command, args, { cwd: mod.rootDir }),
    );
    t.presentationOptions = { reveal: vscode.TaskRevealKind.Never, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    log.info(`Gradle tests: ${command} ${args.join(' ')} (in ${mod.rootDir})`);

    return new Promise((resolve) => {
      let execution: vscode.TaskExecution | undefined;
      const end = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === execution) {
          end.dispose();
          cancel.dispose();
          resolve(e.exitCode);
        }
      });
      const cancel = token.onCancellationRequested(() => execution?.terminate());
      vscode.tasks.executeTask(t).then(
        (ex) => (execution = ex),
        (err) => {
          end.dispose();
          cancel.dispose();
          log.error('Gradle tests: could not start Gradle', err);
          resolve(undefined);
        },
      );
    });
  }

  dispose(): void {
    clearTimeout(this.xmlTimer);
    if (this.active) this.active.run.end();
    for (const d of this.subs) d.dispose();
  }
}


/** Test output as terminal text: CRLF line ends, stderr in red. */
function toTerminal(text: string, stderr: boolean): string {
  const t = text.replace(/\r?\n/g, '\r\n');
  return stderr ? `\x1b[31m${t}\x1b[0m` : t;
}
