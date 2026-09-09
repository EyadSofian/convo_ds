/**
 * Catch-up cursors (DEL-20).
 *
 * A cursor is not just a position. It is a position **plus the authority it was
 * issued under**, because resuming a stream is only safe if the caller's reach
 * has not changed in the meantime. If it has, the events already delivered and
 * the events skipped were both chosen against a different set of rules, and the
 * client's view is wrong in a way that no amount of catching up repairs. The
 * honest answer then is `reset_required`, not a best-effort resume.
 *
 * Four ways a cursor can be unusable, each with its own reason so the client
 * (and the operator reading a log) knows which one happened:
 *
 * - `malformed` — not a cursor this build issued.
 * - `other_tenant` — a cursor for another company, replayed here. It names a
 *   position, never a permission, so this is a bug or a probe; either way it
 *   restarts rather than resolving to something.
 * - `permissions_changed` — the caller's grants, scopes, membership or company
 *   status moved.
 * - `expired` — the position is older than what the feed still holds, so the
 *   gap between then and now cannot be filled.
 *
 * The cursor is opaque to the client and carries no secret: everything in it is
 * something the client already knows or a digest of it. It is not a capability,
 * and presenting one authorizes nothing — every event is authorized again on
 * the way out.
 */

const CURSOR_VERSION = 'v1';

export interface Cursor {
  readonly tenantId: string;
  readonly seq: number;
  /** Digest of the authority the cursor was issued under. */
  readonly authority: string;
}

export type CursorRejection = 'malformed' | 'other_tenant' | 'permissions_changed' | 'expired';

export type CursorCheck =
  | { readonly status: 'ok'; readonly seq: number }
  | { readonly status: 'reset_required'; readonly reason: CursorRejection };

export function encodeCursor(cursor: Cursor): string {
  const raw = [CURSOR_VERSION, cursor.tenantId, String(cursor.seq), cursor.authority].join('|');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Reads a cursor without trusting any part of it.
 *
 * Total: every malformed input returns `null` rather than throwing, because
 * this parses a value a client supplies and a stream that dies on a bad cursor
 * is a stream a client can kill with a bad cursor.
 */
export function decodeCursor(value: string): Cursor | null {
  // Node's base64url decoder does not reject anything: input that is not
  // base64url simply produces bytes, and those bytes fail the checks below.
  // There is nothing here to throw, so there is nothing to catch.
  const parts = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const [version, tenantId, seq, authority] = parts;
  if (
    parts.length !== 4 ||
    version !== CURSOR_VERSION ||
    tenantId === undefined ||
    tenantId === '' ||
    seq === undefined ||
    !/^\d{1,19}$/.test(seq) ||
    authority === undefined ||
    authority === ''
  ) {
    return null;
  }
  return { tenantId, seq: Number(seq), authority };
}

/**
 * Decides whether a client may resume from this cursor.
 *
 * `oldestRetainedSeq` is the lowest sequence the feed can still produce. A
 * cursor below it names a position whose successors have been pruned, so the
 * client cannot be told what it missed — only that it must start again.
 */
export function checkCursor(
  value: string | null,
  context: {
    readonly tenantId: string;
    readonly authority: string;
    readonly oldestRetainedSeq: number;
  },
): CursorCheck {
  if (value === null) {
    // No cursor is not an error: it is a first connection, which starts at the
    // beginning of what is retained.
    return { status: 'ok', seq: context.oldestRetainedSeq - 1 };
  }
  const cursor = decodeCursor(value);
  if (cursor === null) {
    return { status: 'reset_required', reason: 'malformed' };
  }
  if (cursor.tenantId !== context.tenantId) {
    return { status: 'reset_required', reason: 'other_tenant' };
  }
  if (cursor.authority !== context.authority) {
    return { status: 'reset_required', reason: 'permissions_changed' };
  }
  // Equal is fine: the client holds the last event before the pruned window and
  // has missed nothing. Below it, the gap is unfillable.
  if (cursor.seq < context.oldestRetainedSeq - 1) {
    return { status: 'reset_required', reason: 'expired' };
  }
  return { status: 'ok', seq: cursor.seq };
}
