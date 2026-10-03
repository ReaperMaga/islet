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
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';
import { discoverTests } from './discovery';
import { GradleModule, gradleSpawn, moduleFor, resultLocation, testArgs } from './gradle';
import { RunCounts, TestConsole } from './console';
import { INIT_SCRIPT, INIT_SCRIPT_MARKER, INIT_SCRIPT_NAME } from './initScript';
import { findGradleProcesses, killProcessTree } from './processes';
import { RunTree } from './runTree';
import { CaseStatus, parseJUnitXml, splitCaseName, SuiteResult, TestCaseResult } from './junitXml';

const SOURCE_GLOB = '**/src/*[tT]est*/{kotlin,java}/**/*.{kt,java}';
const RESULT_GLOB = '**/build/test-results/**';
const EVENTS_GLOB = '**/build/islet/test-events/*.jsonl';
const EXCLUDE_GLOB = '{**/node_modules/**,**/build/**,**/.gradle/**}';
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
  /** Output arrived live in this run, so the copy stored in the XML report is not shown again. */
  liveOutput: boolean;
  /** Time of the last result or event (runs Islet did not start). */
  lastActivity?: number;
  counts: RunCounts;
  /** Result per item in this run. */
  status: Map<vscode.TestItem, CaseStatus>;
  startedAt: number;
  /** Whether this run is shown in the Gradle Tests console. */
  toConsole: boolean;
}

export class GradleTests implements vscode.Disposable {
  private readonly ctrl = vscode.tests.createTestController('islet.gradle', 'Gradle');
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  private readonly modules = new Map<string, GradleModule>();
  /** Last task name seen in results per module dir (e.g. "test", "integrationTest"). */
  private readonly moduleTask = new Map<string, string>();
  /** Class ids discovered per source file, to clean up when a file changes. */
  private readonly fileClasses = new Map<string, Set<string>>();
  private readonly console = new TestConsole();
  private readonly runTree = new RunTree((item) => this.chainOf(item));
  /** Gradle process of the current Islet run, if any. */
  private gradleChild: cp.ChildProcess | undefined;
  /** Set by "Stop All Gradle Processes" so a running Islet run does not start its next batch. */
  private stopRequested = false;
  private readonly subs: vscode.Disposable[] = [this.console, this.runTree];
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

    void this.skipOldEvents();
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

  /** Event files left from earlier runs are not replayed: start reading at their current end. */
  private async skipOldEvents(): Promise<void> {
    const files = await vscode.workspace.findFiles(EVENTS_GLOB, '{**/node_modules/**}', 1000);
    for (const f of files) {
      try {
        if (!this.eventOffsets.has(f.fsPath)) this.eventOffsets.set(f.fsPath, fs.statSync(f.fsPath).size);
      } catch {
        // gone
      }
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
        if (active.toConsole) this.console.write(ev.text, ev.std === 'StdErr');
        active.liveOutput = true;
        continue;
      }
      if (!ev.cls || !ev.name) continue;
      const item = this.itemForCase(mod, { name: ev.name, className: ev.cls, time: 0, status: 'passed' });
      if (ev.e === 'start') {
        active.run.started(item);
        active.running.add(item);
        if (active.toConsole) this.runTree.started(item);
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
    if (!active.liveOutput && (suite.systemOut || suite.systemErr)) {
      const cls = this.classItem(mod, suite.name);
      if (suite.systemOut) active.run.appendOutput(toTerminal(suite.systemOut, false), undefined, cls);
      if (suite.systemErr) active.run.appendOutput(toTerminal(suite.systemErr, true), undefined, cls);
      if (active.toConsole) {
        if (suite.systemOut) this.console.write(suite.systemOut);
        if (suite.systemErr) this.console.write(suite.systemErr, true);
      }
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
    active.status.set(item, status);
    if (active.toConsole) this.runTree.result(item, status === 'errored' ? 'failed' : status, ms);
    if (status === 'passed') {
      active.run.passed(item, ms);
      active.counts.passed++;
    } else if (status === 'skipped') {
      active.run.skipped(item);
      active.counts.skipped++;
    } else {
      const msg = this.failureMessage(item, c);
      if (status === 'failed') active.run.failed(item, msg, ms);
      else active.run.errored(item, msg, ms);
      if (c.details) active.run.appendOutput(c.details.replace(/\r?\n/g, '\r\n') + '\r\n', msg.location, item);
      active.counts.failed++;
      if (active.toConsole) this.console.failure(this.describe(item), c.message, c.details);
    }
  }

  /** The item and its parents up to its module, outermost first (for the Gradle Run view). */
  private chainOf(item: vscode.TestItem): vscode.TestItem[] {
    const chain: vscode.TestItem[] = [];
    for (let i: vscode.TestItem | undefined = item; i; i = i.parent) chain.unshift(i);
    return chain;
  }

  /** "OuterTest › Nested › test name" for console headings. */
  private describe(item: vscode.TestItem): string {
    const parts: string[] = [];
    for (let i: vscode.TestItem | undefined = item; i; i = i.parent) {
      if (this.data.get(i)?.kind === 'module') break;
      parts.unshift(i.label);
    }
    return parts.join(' › ');
  }

  /** Ends a run and writes the summary line to the console. */
  private finish(active: ActiveRun, note?: string): void {
    active.run.end();
    if (active.toConsole) this.runTree.done();
    if (active.toConsole) this.console.summary(active.counts, Date.now() - active.startedAt, note);
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
    const active: ActiveRun = { run, own: true, tasks: 0, reported: new Set(), running: new Set(), liveOutput: false, counts: { passed: 0, failed: 0, skipped: 0 }, status: new Map(), startedAt: Date.now(), toConsole: false };
    for (const f of files) this.applyResultFile(f.fsPath, active);
    run.end();
  }

  // ------------------------------------------------------------------ runs started outside Islet

  private ensureRun(): ActiveRun {
    if (this.active) return this.active;
    const run = this.ctrl.createTestRun(new vscode.TestRunRequest(), 'Gradle test', true);
    this.active = { run, own: false, tasks: 0, reported: new Set(), running: new Set(), liveOutput: false, counts: { passed: 0, failed: 0, skipped: 0 }, status: new Map(), startedAt: Date.now(), toConsole: true };
    log.info('Gradle tests: detected a test run');
    this.console.startRun('Gradle test · started outside Islet');
    this.runTree.reset('started outside Islet');
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
      this.finish(active);
    }, IDLE_END_MS);
  }

  private isGradleTestTask(task: vscode.Task): boolean {
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
    const active: ActiveRun = { run, own: true, tasks: 0, reported: new Set(), running: new Set(), liveOutput: false, counts: { passed: 0, failed: 0, skipped: 0 }, status: new Map(), startedAt: Date.now(), toConsole: true };
    this.active = active;
    const what = request.include?.length === 1 ? this.describe(request.include[0]) || request.include[0].label : 'all tests';
    this.console.startRun(`Gradle test · ${what}`);
    this.runTree.reset(what);
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


    // One Gradle call per build when its selected modules all run completely (saves Gradle's startup
    // per module); otherwise one call per module, because --tests filters apply to every task.
    type Batch = { rootDir: string; taskArgs: string[]; leaves: vscode.TestItem[]; eventFiles: string[] };
    const batches: Batch[] = [];
    const whole = new Map<string, Batch>();
    for (const entry of plan.values()) {
      const task = this.moduleTask.get(entry.module.dir) ?? 'test';
      if (entry.all) {
        let b = whole.get(entry.module.rootDir);
        if (!b) {
          b = { rootDir: entry.module.rootDir, taskArgs: [], leaves: [], eventFiles: [] };
          whole.set(entry.module.rootDir, b);
          batches.push(b);
        }
        b.taskArgs.push(...testArgs(entry.module, task, []));
        b.leaves.push(...entry.leaves);
        b.eventFiles.push(eventFile(entry.module, task));
      } else {
        batches.push({
          rootDir: entry.module.rootDir,
          taskArgs: testArgs(entry.module, task, [...entry.filters]),
          leaves: entry.leaves,
          eventFiles: [eventFile(entry.module, task)],
        });
      }
    }

    let note: string | undefined;
    try {
      this.stopRequested = false;
      for (const entry of batches) {
        if (token.isCancellationRequested || this.stopRequested) {
          note = this.stopRequested ? 'stopped' : 'cancelled';
          break;
        }
        // Old events from the previous run must not show up in this one.
        for (const file of entry.eventFiles) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // in use or gone; Gradle truncates it when the task starts anyway
          }
          this.eventOffsets.set(vscode.Uri.file(file).fsPath, 0);
        }
        // Read the live event files often while Gradle runs, so test output keeps its place among
        // Gradle's own output (file watcher events alone can lag behind).
        const poll = setInterval(() => {
          for (const file of entry.eventFiles) if (fs.existsSync(file)) this.onEventFile(vscode.Uri.file(file));
        }, 250);
        let exitCode: number | undefined;
        try {
          exitCode = await this.runGradle(entry.rootDir, entry.taskArgs, token);
        } finally {
          clearInterval(poll);
          for (const file of entry.eventFiles) if (fs.existsSync(file)) this.onEventFile(vscode.Uri.file(file));
        }
        await new Promise((r) => setTimeout(r, XML_BATCH_MS + 300));
        await this.flushed;
        // A queued test whose invocations only appeared during the run (parameterized tests in a
        // fresh window) takes its result from them; otherwise VS Code would show it as skipped.
        for (const l of entry.leaves) {
          if (active.reported.has(l) || !this.hasReportedChild(l, active)) continue;
          const states: CaseStatus[] = [];
          l.children.forEach((c) => {
            const s = active.status.get(c);
            if (s) states.push(s);
          });
          if (states.some((s) => s === 'failed' || s === 'errored')) {
            active.run.failed(l, new vscode.TestMessage('One or more invocations failed.'));
          } else if (states.length && states.every((s) => s === 'skipped')) active.run.skipped(l);
          else active.run.passed(l);
          active.reported.add(l);
        }
        const missing = entry.leaves.filter((l) => !active.reported.has(l) && !this.hasReportedChild(l, active));
        if (token.isCancellationRequested) note = 'cancelled';
        if (missing.length && exitCode !== 0 && !token.isCancellationRequested) {
          const msg = new vscode.TestMessage(
            `Gradle exited with code ${exitCode ?? 'unknown'} before reporting this test. See the "Gradle Tests" console for the build output.`,
          );
          for (const l of missing) run.errored(l, msg);
          note = `Gradle exited with code ${exitCode ?? 'unknown'}`;
        } else {
          for (const l of missing) run.skipped(l);
        }
      }
    } finally {
      if (this.active === active) this.active = undefined;
      this.finish(active, note);
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

  /** Runs Gradle directly so its whole output streams into the Gradle Tests console. */
  private runGradle(rootDir: string, taskArgs: string[], token: vscode.CancellationToken): Promise<number | undefined> {
    // --continue: like JetBrains, run every module's tests even when an earlier module has failures.
    const gradleArgs = ['--init-script', this.initScriptPath, '--console=plain', '--continue', ...taskArgs];
    const { command, args, verbatim } = gradleSpawn(rootDir, gradleArgs);
    log.info(`Gradle tests: ${command} ${args.join(' ')} (in ${rootDir})`);
    this.console.write(`\x1b[2m> gradlew ${gradleArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\x1b[0m\n\n`);

    return new Promise((resolve) => {
      let child: cp.ChildProcess;
      try {
        child = cp.spawn(command, args, { cwd: rootDir, env: process.env, windowsHide: true, windowsVerbatimArguments: verbatim });
        this.gradleChild = child;
      } catch (err) {
        log.error('Gradle tests: could not start Gradle', err);
        this.console.write(`Could not start Gradle: ${err instanceof Error ? err.message : String(err)}\n`, true);
        resolve(undefined);
        return;
      }
      child.stdout?.setEncoding('utf8').on('data', (d: string) => this.console.write(d));
      child.stderr?.setEncoding('utf8').on('data', (d: string) => this.console.write(d, true));
      const cancel = token.onCancellationRequested(() => killTree(child));
      child.on('error', (err) => {
        log.error('Gradle tests: Gradle failed to run', err);
        this.console.write(`Could not start Gradle: ${err.message}\n`, true);
      });
      child.on('close', (code) => {
        cancel.dispose();
        if (this.gradleChild === child) this.gradleChild = undefined;
        resolve(code ?? undefined);
      });
    });
  }

  /** Command: stop every Gradle process on this machine (clients, daemons, test JVMs), after asking. */
  async stopAllGradle(): Promise<void> {
    const procs = await findGradleProcesses();
    const own = this.gradleChild && this.gradleChild.exitCode === null ? 1 : 0;
    if (!procs.length && !own) {
      void vscode.window.showInformationMessage('No Gradle processes are running.');
      return;
    }
    const count = (k: string) => procs.filter((p) => p.kind === k).length;
    const parts = [
      count('client') + own ? `${count('client') + own} running build${count('client') + own === 1 ? '' : 's'}` : '',
      count('worker') ? `${count('worker')} test JVM${count('worker') === 1 ? '' : 's'}` : '',
      count('daemon') ? `${count('daemon')} daemon${count('daemon') === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const choice = await vscode.window.showWarningMessage(
      `Stop all Gradle processes on this computer? (${parts.join(', ')})`,
      { modal: true, detail: 'Every running Gradle build and test run stops. Gradle starts a new daemon on the next build.' },
      'Stop All',
    );
    if (choice !== 'Stop All') return;

    this.stopRequested = true;
    if (this.gradleChild) killTree(this.gradleChild);
    for (const e of vscode.tasks.taskExecutions) if (this.isGradleTestTask(e.task)) e.terminate();
    // Clients first (cancels their builds), then test JVMs, then daemons.
    for (const kind of ['client', 'worker', 'daemon'] as const) {
      await Promise.all(procs.filter((p) => p.kind === kind).map((p) => killProcessTree(p.pid)));
    }
    this.console.write(`\n\x1b[31m■ Stopped all Gradle processes (${parts.join(', ')}).\x1b[0m\n`);
    log.info(`Gradle tests: stopped all Gradle processes (${parts.join(', ')})`);
    if (this.active && !this.active.own) {
      const active = this.active;
      this.active = undefined;
      this.finish(active, 'stopped');
    }
    void vscode.window.showInformationMessage(`Stopped ${parts.join(', ')}.`);
  }

  /** Command: show the Gradle Tests console, reopening it if it was closed. */
  showConsole(): void {
    this.console.show();
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

/** Stops Gradle and everything it started (the test JVM included). */
function killTree(child: cp.ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** Live event file the init script writes for a module's test task. */
function eventFile(mod: GradleModule, task: string): string {
  return path.join(mod.dir, 'build', 'islet', 'test-events', `${task}.jsonl`);
}
