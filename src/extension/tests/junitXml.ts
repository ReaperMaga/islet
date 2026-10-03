// Minimal parser for the JUnit XML reports Gradle writes to build/test-results/<task>/TEST-*.xml.
// Only the parts Islet shows are read: suite, test cases, outcome, time, failure message and trace.

export type CaseStatus = 'passed' | 'failed' | 'errored' | 'skipped';

export interface TestCaseResult {
  /** As reported, e.g. "should work()" or "parses(String)[2]". */
  name: string;
  /** Binary class name, e.g. "com.acme.FooTest$Nested". */
  className: string;
  /** Seconds. */
  time: number;
  status: CaseStatus;
  /** Short failure message (message attribute). */
  message?: string;
  /** Full failure text, usually the stack trace. */
  details?: string;
}

export interface SuiteResult {
  name: string;
  timestamp?: string;
  cases: TestCaseResult[];
  systemOut?: string;
  systemErr?: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? '';
  });
}

/** Text content of an element body: CDATA sections are taken verbatim, everything else is decoded. */
function textContent(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const start = body.indexOf('<![CDATA[', i);
    if (start < 0) {
      out += decodeXml(body.slice(i));
      break;
    }
    out += decodeXml(body.slice(i, start));
    const end = body.indexOf(']]>', start + 9);
    if (end < 0) {
      out += body.slice(start + 9);
      break;
    }
    out += body.slice(start + 9, end);
    i = end + 3;
  }
  return out;
}

interface Tag {
  attrs: Record<string, string>;
  /** Inner XML, or null for a self-closing tag. */
  body: string | null;
  /** Index just after the whole element. */
  end: number;
}

/** Reads the element starting at `from` (which points at "<name"). Attribute values may contain '>'. */
function readTag(xml: string, name: string, from: number): Tag | null {
  let i = from + 1 + name.length;
  const attrs: Record<string, string> = {};
  const attrRe = /\s*([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  for (;;) {
    attrRe.lastIndex = i;
    const m = attrRe.exec(xml);
    if (!m) break;
    attrs[m[1]] = decodeXml(m[2] ?? m[3] ?? '');
    i = attrRe.lastIndex;
  }
  while (i < xml.length && /\s/.test(xml[i])) i++;
  if (xml.startsWith('/>', i)) return { attrs, body: null, end: i + 2 };
  if (xml[i] !== '>') return null;
  const close = `</${name}>`;
  const closeAt = xml.indexOf(close, i + 1);
  if (closeAt < 0) return null;
  return { attrs, body: xml.slice(i + 1, closeAt), end: closeAt + close.length };
}

/** Finds `<name` as a whole tag name (not a prefix of a longer name). */
function findTag(xml: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    i = xml.indexOf('<' + name, i);
    if (i < 0) return -1;
    const next = xml[i + 1 + name.length];
    if (next === undefined || /[\s/>]/.test(next)) return i;
    i += 1;
  }
}

function firstChild(body: string, name: string): Tag | null {
  const at = findTag(body, name, 0);
  return at < 0 ? null : readTag(body, name, at);
}

export function parseJUnitXml(xml: string): SuiteResult | null {
  const suiteAt = findTag(xml, 'testsuite', 0);
  if (suiteAt < 0) return null;
  const suite = readTag(xml, 'testsuite', suiteAt);
  if (!suite) return null;
  const body = suite.body ?? '';

  const cases: TestCaseResult[] = [];
  let i = 0;
  for (;;) {
    const at = findTag(body, 'testcase', i);
    if (at < 0) break;
    const tc = readTag(body, 'testcase', at);
    if (!tc) break;
    i = tc.end;

    const inner = tc.body ?? '';
    const failure = firstChild(inner, 'failure');
    const error = failure ? null : firstChild(inner, 'error');
    const skipped = failure || error ? null : firstChild(inner, 'skipped');
    const problem = failure ?? error;

    cases.push({
      name: tc.attrs.name ?? '',
      className: tc.attrs.classname ?? suite.attrs.name ?? '',
      time: Number(tc.attrs.time) || 0,
      status: failure ? 'failed' : error ? 'errored' : skipped ? 'skipped' : 'passed',
      message: problem?.attrs.message ?? (skipped?.attrs.message || undefined),
      details: problem?.body ? textContent(problem.body).trim() : undefined,
    });
  }

  // Suite-level output sits after the test cases.
  const out = firstChild(body.slice(i), 'system-out');
  const err = firstChild(body.slice(i), 'system-err');
  return {
    name: suite.attrs.name ?? '',
    timestamp: suite.attrs.timestamp,
    cases,
    systemOut: out?.body ? textContent(out.body) : undefined,
    systemErr: err?.body ? textContent(err.body) : undefined,
  };
}

/**
 * Splits a reported test case name into the method part and the invocation part.
 * "should work()" -> { method: "should work" }
 * "parses(String)[2]" -> { method: "parses", invocation: "[2]" }
 * "[1] input=a" (JUnit display name style) -> { method: "", invocation: "[1] input=a" }
 */
export function splitCaseName(name: string): { method: string; invocation?: string } {
  let rest = name;
  let invocation: string | undefined;
  const inv = /\)(\[\d+\].*)$/.exec(rest);
  if (inv) {
    invocation = inv[1];
    rest = rest.slice(0, inv.index + 1);
  } else if (/^\[\d+\]/.test(rest)) {
    return { method: '', invocation: rest };
  }
  if (rest.endsWith(')')) {
    const open = rest.lastIndexOf('(');
    if (open > 0) rest = rest.slice(0, open);
  }
  return { method: rest, invocation };
}
