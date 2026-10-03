// "Gradle Tests" console: a terminal shown as an editor tab (or in the panel) that streams a test
// run like JetBrains' Run window: Gradle's own output for Islet's runs, everything the tests print,
// each failure with its stack trace, and a summary at the end.
import * as vscode from 'vscode';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

export type ConsoleLocation = 'editor' | 'panel' | 'off';

export interface RunCounts {
  passed: number;
  failed: number;
  skipped: number;
}

/** Terminal text: CRLF line endings. */
function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export class TestConsole implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly subs: vscode.Disposable[] = [this.writer];
  /** Text written before the terminal finished opening. */
  private pending: string[] = [];
  private ready = false;
  /** Whether the last written character ended a line, so headings start on a fresh line. */
  private atLineStart = true;
  /** Everything written for the current/last run, replayed when the console is reopened. */
  private history: string[] = [];
  private historySize = 0;

  constructor() {
    this.subs.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) {
          this.terminal = undefined;
          this.ready = false;
          this.pending = [];
        }
      }),
    );
  }

  private location(): ConsoleLocation {
    return vscode.workspace.getConfiguration('islet.gradleTests').get<ConsoleLocation>('console', 'editor');
  }

  /** Opens (or reuses) the console and clears it for a new run. */
  startRun(title: string): void {
    this.history = [];
    this.historySize = 0;
    if (this.location() === 'off') return;
    if (this.terminal) this.emit('\x1b[2J\x1b[3J\x1b[H', false); // clear screen and scrollback
    else this.open(false);
    this.terminal?.show(true);
    this.atLineStart = true;
    this.line(`${CYAN}${BOLD}▶ ${title}${RESET}  ${DIM}${new Date().toLocaleTimeString()}${RESET}`);
    this.line('');
  }

  /** Raw output (Gradle or tests), streamed as is. */
  write(text: string, stderr = false): void {
    if (!text) return;
    const t = crlf(text);
    this.emit(stderr ? `${RED}${t}${RESET}` : t);
    this.atLineStart = /\n$/.test(t);
  }

  failure(label: string, message: string | undefined, trace: string | undefined): void {
    this.newline();
    this.line(`${RED}${BOLD}✗ ${label}${RESET}`);
    const body = trace || message;
    if (body) this.line(`${RED}${crlf(body).replace(/\r\n$/, '')}${RESET}`);
    this.line('');
  }

  summary(counts: RunCounts, ms: number, note?: string): void {
    this.newline();
    const parts = [
      `${GREEN}${counts.passed} passed${RESET}`,
      counts.failed ? `${RED}${counts.failed} failed${RESET}` : `${DIM}0 failed${RESET}`,
      counts.skipped ? `${YELLOW}${counts.skipped} skipped${RESET}` : `${DIM}0 skipped${RESET}`,
    ];
    const secs = ms / 1000;
    const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`;
    this.line('');
    this.line(`${BOLD}Tests:${RESET} ${parts.join(', ')}  ${DIM}· ${time}${RESET}${note ? `  ${DIM}${note}${RESET}` : ''}`);
  }

  private newline(): void {
    if (!this.atLineStart) this.emit('\r\n');
    this.atLineStart = true;
  }

  private line(text: string): void {
    this.emit(text + '\r\n');
    this.atLineStart = true;
  }

  /** Command: shows the console, reopening it with the current/last run if it was closed. */
  show(): void {
    if (!this.terminal) this.open(true);
    this.terminal?.show(false);
  }

  /** Creates the terminal; with `replay`, it starts with everything written for the last run. */
  private open(replay: boolean): void {
    const where = this.location();
    this.ready = false;
    this.pending = replay ? [...this.history] : [];
    if (replay && !this.history.length) this.pending.push(`${DIM}No Gradle test run yet. Run tests from the Testing panel.${RESET}\r\n`);
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writer.event,
      open: () => {
        this.ready = true;
        for (const chunk of this.pending) this.writer.fire(chunk);
        this.pending = [];
      },
      close: () => {
        this.terminal = undefined;
        this.ready = false;
      },
    };
    this.terminal = vscode.window.createTerminal({
      name: 'Gradle Tests',
      pty,
      iconPath: new vscode.ThemeIcon('beaker'),
      location:
        where === 'panel' ? vscode.TerminalLocation.Panel : { viewColumn: vscode.ViewColumn.Active, preserveFocus: !replay },
    });
  }

  private emit(chunk: string, record = true): void {
    if (record) {
      // Keep up to ~8 MB of the run for replay; drop the oldest output beyond that.
      this.history.push(chunk);
      this.historySize += chunk.length;
      while (this.historySize > 8_000_000 && this.history.length > 1) this.historySize -= this.history.shift()!.length;
    }
    if (!this.terminal) return;
    if (this.ready) this.writer.fire(chunk);
    else this.pending.push(chunk);
  }

  dispose(): void {
    this.terminal?.dispose();
    for (const d of this.subs) d.dispose();
  }
}
