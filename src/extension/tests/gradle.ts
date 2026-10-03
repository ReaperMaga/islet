// Gradle project layout helpers: which build and module a file belongs to, and how to run tests.
import * as fs from 'fs';
import * as path from 'path';

const SETTINGS = ['settings.gradle.kts', 'settings.gradle'];
const BUILD = ['build.gradle.kts', 'build.gradle'];

function hasAny(dir: string, names: string[]): boolean {
  return names.some((n) => fs.existsSync(path.join(dir, n)));
}

/** Nearest directory at or above `start` that contains one of `names`, not above `limit`. */
function findUp(start: string, names: string[], limit?: string): string | undefined {
  let dir = start;
  for (;;) {
    if (hasAny(dir, names)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || (limit && !isInside(parent, limit))) return undefined;
    dir = parent;
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface GradleModule {
  /** Directory of the module (contains build.gradle(.kts), or the root itself). */
  dir: string;
  /** Root of the Gradle build (contains settings.gradle(.kts) or the wrapper). */
  rootDir: string;
  /** Gradle project path: '' for the root project, ':api', ':services:billing', … */
  projectPath: string;
}

/** The Gradle module that owns `file` (a source file or a test result file), within `workspaceDir`. */
export function moduleFor(file: string, workspaceDir: string): GradleModule | undefined {
  const start = path.dirname(file);
  const dir = findUp(start, BUILD, workspaceDir) ?? findUp(start, SETTINGS, workspaceDir);
  if (!dir) return undefined;
  const rootDir = findUp(dir, SETTINGS, workspaceDir) ?? findUp(dir, ['gradlew', 'gradlew.bat'], workspaceDir) ?? dir;
  const rel = path.relative(rootDir, dir);
  const projectPath = rel ? ':' + rel.split(path.sep).join(':') : '';
  return { dir, rootDir, projectPath };
}

/** For a result file .../<module>/build/test-results/<task>/TEST-x.xml: the module directory and task name. */
export function resultLocation(xmlPath: string): { moduleDir: string; task: string } | undefined {
  const parts = xmlPath.split(/[\\/]/);
  const idx = parts.lastIndexOf('test-results');
  if (idx < 2 || parts[idx - 1] !== 'build' || idx + 2 >= parts.length) return undefined;
  return { moduleDir: parts.slice(0, idx - 1).join(path.sep), task: parts[idx + 1] };
}

/**
 * How to start Gradle in `rootDir` with `args`: the wrapper if present, else `gradle` from PATH.
 * On Windows the .bat wrapper needs cmd.exe; the command line is quoted by hand (cmd's /s mode)
 * so test names with spaces survive even when the project path has spaces too.
 */
export function gradleSpawn(rootDir: string, args: string[]): { command: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') {
    const wrapper = path.join(rootDir, 'gradlew.bat');
    const exe = fs.existsSync(wrapper) ? wrapper : 'gradle';
    const quote = (a: string) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const line = [exe, ...args].map(quote).join(' ');
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  const wrapper = path.join(rootDir, 'gradlew');
  return { command: fs.existsSync(wrapper) ? wrapper : 'gradle', args, verbatim: false };
}

/** Arguments for running `task` of one module, optionally limited to test filters (Gradle --tests patterns). */
export function testArgs(mod: GradleModule, task: string, filters: string[]): string[] {
  // --rerun makes Gradle run the tests even when the task is up to date (Gradle 7.6+).
  const args = [`${mod.projectPath}:${task}`, '--rerun'];
  for (const f of filters) args.push('--tests', f);
  return args;
}
