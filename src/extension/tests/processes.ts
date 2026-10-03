// Finds and stops Gradle processes on this machine: clients (gradlew / gradle), daemons and the
// test JVMs they start. Used by "Islet: Stop All Gradle Processes".
import * as cp from 'child_process';

export type GradleProcessKind = 'client' | 'daemon' | 'worker';

export interface GradleProcess {
  pid: number;
  kind: GradleProcessKind;
}

/** Classifies a Java command line; undefined for anything that is not a Gradle build process. */
export function classify(commandLine: string): GradleProcessKind | undefined {
  // The Gradle for Java extension's helper server is not a build; stopping it breaks the extension.
  if (/com\.github\.badsyntax\.gradle\.GradleServer/.test(commandLine)) return undefined;
  if (/org\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon/.test(commandLine)) return 'daemon';
  if (/worker\.org\.gradle\.process\.internal\.worker\.GradleWorkerMain|Gradle Test Executor/.test(commandLine)) return 'worker';
  if (/org\.gradle\.wrapper\.GradleWrapperMain|org\.gradle\.launcher\.GradleMain|org\.gradle\.launcher\.Main\b/.test(commandLine)) return 'client';
  return undefined;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(command, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

export async function findGradleProcesses(): Promise<GradleProcess[]> {
  const found: GradleProcess[] = [];
  if (process.platform === 'win32') {
    const json = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    let rows: { ProcessId: number; CommandLine: string | null }[] = [];
    try {
      const parsed = JSON.parse(json.trim() || '[]');
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      rows = [];
    }
    for (const r of rows) {
      const kind = r.CommandLine ? classify(r.CommandLine) : undefined;
      if (kind) found.push({ pid: r.ProcessId, kind });
    }
  } else {
    const out = await run('ps', ['-axo', 'pid=,args=']);
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !/java/.test(m[2])) continue;
      const kind = classify(m[2]);
      if (kind) found.push({ pid: Number(m[1]), kind });
    }
  }
  return found.filter((p) => p.pid !== process.pid);
}

/** Stops a process and everything it started. */
export function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return run('taskkill', ['/pid', String(pid), '/T', '/F']).then(() => undefined);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  return Promise.resolve();
}
