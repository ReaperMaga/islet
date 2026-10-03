// Finds JUnit test methods in Kotlin and Java source files with a light line scanner
// (no compiler): package, nested classes by brace depth, and methods annotated as tests.

export interface DiscoveredTest {
  /** Method name as written, without backticks. */
  method: string;
  /** 0-based line of the method declaration. */
  line: number;
  /** @ParameterizedTest / @RepeatedTest / @TestFactory / @TestTemplate: reported as several invocations. */
  multi: boolean;
}

export interface DiscoveredClass {
  /** Binary name, e.g. "com.acme.FooTest$Nested". */
  className: string;
  /** 0-based line of the class declaration. */
  line: number;
  tests: DiscoveredTest[];
}

const TEST_ANNOTATION = /@(?:org\.junit\.(?:jupiter\.api\.|jupiter\.params\.)?)?(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
const CLASS_DECL = /\b(?:class|object)\s+([A-Za-z_][\w]*)/;
const KOTLIN_FUN = /\bfun\s+(?:<[^>]*>\s*)?(?:`([^`]+)`|([A-Za-z_][\w]*))\s*\(/;
const JAVA_METHOD = /\b(?:void|[\w<>,\[\]?\s]+?)\s+([A-Za-z_][\w]*)\s*\(/;

/** Removes string literals and comments so braces inside them are not counted. */
interface ScanState {
  inBlockComment: boolean;
  /** Inside a Kotlin raw string / Java text block ("""…"""), which may span lines and hold braces. */
  inTripleString: boolean;
}

function stripCode(line: string, state: ScanState): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf('*/', i);
      if (end < 0) return out;
      state.inBlockComment = false;
      i = end + 2;
      continue;
    }
    if (state.inTripleString) {
      const end = line.indexOf('"""', i);
      if (end < 0) return out;
      state.inTripleString = false;
      out += '""';
      i = end + 3;
      continue;
    }
    const c = line[i];
    const n = line[i + 1];
    if (c === '/' && n === '/') break;
    if (c === '/' && n === '*') {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (line.startsWith('"""', i)) {
      state.inTripleString = true;
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      // Skip a single-line string or char literal.
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      out += c + c;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Keep backtick names intact (they may contain spaces) but they never contain braces that matter.
      const j = line.indexOf('`', i + 1);
      const end = j < 0 ? line.length : j + 1;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function discoverTests(source: string, language: 'kotlin' | 'java'): DiscoveredClass[] {
  const pkg = /^\s*package\s+([\w.]+)/m.exec(source)?.[1];
  const lines = source.split(/\r?\n/);
  const state: ScanState = { inBlockComment: false, inTripleString: false };

  const classes: DiscoveredClass[] = [];
  // Stack of open classes with the brace depth their body starts at.
  const stack: { cls: DiscoveredClass; bodyDepth: number }[] = [];
  let depth = 0;
  // A class whose body '{' has not been seen yet, and the open '(' count of its header
  // (Kotlin constructors often span several lines).
  let pendingClass: DiscoveredClass | null = null;
  let headerParens = 0;
  let pendingTest = false;
  let pendingMulti = false;

  for (let ln = 0; ln < lines.length; ln++) {
    const code = stripCode(lines[ln], state);

    const ann = TEST_ANNOTATION.exec(code);
    if (ann) {
      pendingTest = true;
      pendingMulti = ann[1] !== 'Test';
    }

    const cls = CLASS_DECL.exec(code);
    if (cls && !/\bfun\b/.test(code.slice(0, cls.index))) {
      const outer = stack.length ? stack[stack.length - 1].cls.className : pkg ?? '';
      const className = stack.length ? `${outer}$${cls[1]}` : outer ? `${outer}.${cls[1]}` : cls[1];
      pendingClass = { className, line: ln, tests: [] };
      headerParens = 0;
      classes.push(pendingClass);
    }

    if (pendingTest && stack.length && !pendingClass) {
      const m = language === 'kotlin' ? KOTLIN_FUN.exec(code) : JAVA_METHOD.exec(code);
      const name = m ? (language === 'kotlin' ? (m[1] ?? m[2]) : m[1]) : undefined;
      if (name && !(language === 'java' && /^(if|for|while|switch|catch|return|new)$/.test(name))) {
        stack[stack.length - 1].cls.tests.push({ method: name, line: ln, multi: pendingMulti });
        pendingTest = false;
      }
    }

    for (const ch of code) {
      if (pendingClass && ch === '(') headerParens++;
      else if (pendingClass && ch === ')') headerParens--;
      else if (ch === '{') {
        depth++;
        if (pendingClass) {
          stack.push({ cls: pendingClass, bodyDepth: depth });
          pendingClass = null;
        }
      } else if (ch === '}') {
        if (stack.length && stack[stack.length - 1].bodyDepth === depth) stack.pop();
        depth = Math.max(0, depth - 1);
      }
    }

    // Header finished without a body on this line: either the body opens on the next line
    // (`class Foo :` / `class Foo(...)\n{`), or the class has no body at all (`data class Row(val a: Int)`).
    if (pendingClass && headerParens <= 0 && !/[:,(]\s*$/.test(code)) {
      const next = lines.slice(ln + 1).find((l) => l.trim()) ?? '';
      if (!/^\s*[{:]/.test(next)) pendingClass = null;
    }
  }

  return classes.filter((c) => c.tests.length > 0);
}
