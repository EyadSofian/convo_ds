/**
 * The first row of a result that must have produced one.
 *
 * `INSERT ... RETURNING` and an `UPDATE` guarded by a row this transaction
 * already locked always yield a row. Writing `rows[0] ?? throw` inline at each
 * call site scatters the same impossible case through the services and leaves a
 * branch nothing can reach in each of them.
 *
 * Keeping it here makes the guard one total function with one test that
 * exercises both paths — and, when a schema change does make it possible, one
 * message that says which write went wrong instead of a `TypeError` about
 * reading a property of undefined.
 */
export function requireRow<T>(rows: readonly T[], detail: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`convo: ${detail}`);
  }
  return row;
}
