/**
 * The browser half of the realtime feed.
 *
 * The server does the hard part — it decides what this session may see, event
 * by event, and refuses a cursor that was issued under different permissions.
 * What is left here is the part a client has to get right anyway:
 *
 * 1. **Dedupe.** Delivery is at-least-once by design (ADR-0004), and a reconnect
 *    can overlap a catch-up, so the same event can arrive twice. Every event
 *    carries a stable id; a repeat is dropped rather than applied twice.
 * 2. **Order.** Events carry a dense per-company sequence. One that arrives
 *    behind a sequence already applied is stale and is dropped — a screen that
 *    applied it would roll backwards.
 * 3. **Resume.** The last cursor is kept, so a reconnect continues rather than
 *    restarting. `EventSource` re-sends it as `Last-Event-ID` on its own; the
 *    cursor is also kept here for the catch-up path and for a deliberate
 *    reconnect.
 * 4. **Reset.** When the server says `reset_required`, the client throws its
 *    view away and reloads instead of patching. After a permission change the
 *    events already delivered and the events skipped were both chosen under
 *    rules that no longer apply, so patching would be quietly wrong.
 * 5. **Reconnection belongs to `EventSource`.** It retries on its own, using
 *    the `retry:` floor the server sends. This client does not schedule a
 *    second attempt beside it — two reconnect loops racing is how one restart
 *    becomes a request storm. What it does do is **close** the stream when
 *    coming back is pointless, which is the one case the browser cannot know.
 *
 * `EventSource` is injected rather than reached for, so this is testable
 * without a browser and without a live server.
 */

export interface RealtimeEvent {
  readonly schemaVersion: number;
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly entity: { readonly type: string; readonly id: string; readonly version: number };
  readonly scope: {
    readonly conversationId: string;
    readonly inboxId: string;
    readonly teamId: string | null;
    readonly assigneeMembershipId: string | null;
  };
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly cursor?: string;
}

/** The minimum of `EventSource` this client uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface RealtimeHandlers {
  /** An authorized event, already deduped and in order. */
  onEvent(event: RealtimeEvent): void;
  /** The view is unusable and must be reloaded from scratch. */
  onReset(reason: string): void;
  /**
   * The connection ended.
   *
   * `willRetry` says whether `EventSource` is coming back on its own. It is
   * false only when reconnecting cannot help — a revoked membership asks the
   * same question and gets the same answer — and the stream has been closed.
   */
  onDisconnect(reason: string, willRetry: boolean): void;
}

export interface RealtimeOptions {
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly open: EventSourceFactory;
  readonly handlers: RealtimeHandlers;
}

export interface RealtimeSubscription {
  /** The last position applied, for a catch-up request after a reset. */
  cursor(): string | null;
  close(): void;
}

/** The types this build knows how to apply. Anything else is ignored. */
const KNOWN_TYPES = new Set([
  'message.inbound',
  'message.delivery',
  'conversation.assigned',
  'conversation.state',
  'conversation.note',
  'conversation.handoff',
  'conversation.routing',
]);

export function subscribe(options: RealtimeOptions): RealtimeSubscription {
  const seen = new Set<string>();
  let cursor: string | null = null;
  let highestSeq = 0;
  let closed = false;

  // No cursor on the URL: a fresh subscription starts from what the feed still
  // holds, and a *reconnect* resumes through `Last-Event-ID`, which
  // `EventSource` sends by itself from the last frame id it saw. Catching up
  // across a longer gap is the HTTP endpoint's job, not this one's.
  const source = options.open(`${options.baseUrl}/tenants/${options.tenantId}/realtime/stream`);

  const apply = (raw: string): void => {
    const event = parseEvent(raw);
    if (event === null || !KNOWN_TYPES.has(event.type)) {
      // A type this build does not know is not an error: a newer server may
      // emit one, and a client that threw would stop applying the events it
      // does understand.
      return;
    }
    if (seen.has(event.id) || event.seq <= highestSeq) {
      // Seen already, or older than what is applied. Either way, applying it
      // would move the screen backwards.
      return;
    }
    seen.add(event.id);
    highestSeq = event.seq;
    if (typeof event.cursor === 'string') {
      cursor = event.cursor;
    }
    options.handlers.onEvent(event);
  };

  for (const type of KNOWN_TYPES) {
    source.addEventListener(type, (message) => {
      if (!closed) {
        apply(message.data);
      }
    });
  }

  source.addEventListener('reset_required', (message) => {
    if (closed) {
      return;
    }
    // Everything applied so far was chosen under rules that no longer hold.
    seen.clear();
    highestSeq = 0;
    cursor = null;
    options.handlers.onReset(reasonOf(message.data));
  });

  for (const ending of ['stream_cycled', 'stream_closed'] as const) {
    source.addEventListener(ending, (message) => {
      if (closed) {
        return;
      }
      const reason = reasonOf(message.data);
      if (reason === 'access_revoked') {
        // Coming back would ask the same question and get the same answer, so
        // the stream is closed rather than left to retry forever.
        closed = true;
        source.close();
        options.handlers.onDisconnect(reason, false);
        return;
      }
      options.handlers.onDisconnect(reason, true);
    });
  }

  source.addEventListener('error', () => {
    if (!closed) {
      // `EventSource` is already coming back; this only reports that the screen
      // is a snapshot until it does.
      options.handlers.onDisconnect('connection_lost', true);
    }
  });

  return {
    cursor: () => cursor,
    close: () => {
      closed = true;
      source.close();
    },
  };
}

function parseEvent(raw: string): RealtimeEvent | null {
  const value: unknown = safeParse(raw);
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const scope = asRecord(record['scope']);
  const entity = asRecord(record['entity']);
  if (
    typeof record['id'] !== 'string' ||
    typeof record['type'] !== 'string' ||
    typeof record['seq'] !== 'number' ||
    scope === null ||
    entity === null
  ) {
    return null;
  }
  return {
    schemaVersion: typeof record['schemaVersion'] === 'number' ? record['schemaVersion'] : 0,
    id: record['id'],
    seq: record['seq'],
    type: record['type'],
    entity: {
      type: typeof entity['type'] === 'string' ? entity['type'] : 'conversation',
      id: typeof entity['id'] === 'string' ? entity['id'] : '',
      version: typeof entity['version'] === 'number' ? entity['version'] : 0,
    },
    scope: {
      conversationId: typeof scope['conversationId'] === 'string' ? scope['conversationId'] : '',
      inboxId: typeof scope['inboxId'] === 'string' ? scope['inboxId'] : '',
      teamId: typeof scope['teamId'] === 'string' ? scope['teamId'] : null,
      assigneeMembershipId:
        typeof scope['assigneeMembershipId'] === 'string' ? scope['assigneeMembershipId'] : null,
    },
    occurredAt: typeof record['occurredAt'] === 'string' ? record['occurredAt'] : '',
    payload: asRecord(record['payload']) ?? {},
    ...(typeof record['cursor'] === 'string' ? { cursor: record['cursor'] } : {}),
  };
}

function reasonOf(raw: string): string {
  const record = asRecord(safeParse(raw));
  const reason = record?.['reason'];
  return typeof reason === 'string' ? reason : 'unknown';
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A frame we cannot read is dropped, not thrown: one malformed frame must
    // not take the subscription down with it.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
