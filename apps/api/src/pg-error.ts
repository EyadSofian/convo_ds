import type { ApiHttpError } from './http-error.js';

/**
 * Turns one named constraint violation into the API error it means.
 *
 * A unique index is the authoritative answer to "is this name taken" — it holds
 * under concurrency, where a `SELECT` first does not. But an unhandled
 * violation surfaces as a 500, which tells the caller nothing and blames the
 * server for a conflict it created. This translates exactly one constraint and
 * rethrows everything else untouched: a helper that swallowed unrelated
 * failures would turn every future bug in the same query into a plausible-
 * looking 409.
 */
export async function unlessConstraint<T>(
  constraint: string,
  conflict: ApiHttpError,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (violatedConstraint(cause) !== constraint) {
      throw cause;
    }
    throw conflict;
  }
}

/** The constraint a PostgreSQL error names, when it is one and it names one. */
export function violatedConstraint(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null || !('constraint' in cause)) {
    return null;
  }
  const named = (cause as { constraint?: unknown }).constraint;
  return typeof named === 'string' ? named : null;
}
