// Turns any thrown value into a short message suitable for the webviews.

export class UserError extends Error {}

export function errorMessage(err: unknown): string {
  if (err instanceof UserError) return err.message;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  const raw = typeof e?.message === 'string' ? e.message : String(err);
  const lower = raw.toLowerCase();
  const causeCode = (e?.cause as { code?: unknown } | undefined)?.code;
  const code = typeof e?.code === 'string' ? e.code : typeof causeCode === 'string' ? causeCode : '';

  if (status === 401 || /\b401\b|bad credentials|requires authentication/.test(lower)) return 'Sign in again: GitHub rejected the token.';
  if (lower.includes('not signed in')) return 'Sign in to GitHub to continue.';
  if (lower.includes('rate limit') || (status === 403 && lower.includes('limit')) || status === 429) {
    return 'GitHub rate limit reached. Try again in a few minutes.';
  }
  if (status === 403 || /\b403\b|forbidden|resource not accessible/.test(lower)) return 'GitHub denied access to this resource.';
  if (status === 404 || /\b404\b|could not resolve to/.test(lower)) return 'Not found on GitHub (or no access).';
  if (
    /^(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_\w+)$/.test(code) ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return 'Network error: could not reach GitHub.';
  }
  if (status !== undefined && status >= 500) return `GitHub is having trouble (HTTP ${status}). Try again.`;
  const oneLine = raw.split('\n')[0].trim() || 'Something went wrong.';
  return oneLine.length > 200 ? oneLine.slice(0, 197) + '…' : oneLine;
}
