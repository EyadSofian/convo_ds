import type { SqlExecutor } from '@convo/domain';

/**
 * Where a recovery token goes.
 *
 * The token is generated on the server, hashed for storage, and handed to a
 * delivery adapter. It is **never** returned in an HTTP response body: an
 * endpoint that echoes the token turns "I know this email address" into "I can
 * reset this account", which is the whole attack the generic-response rule
 * exists to prevent.
 *
 * **`deliver` takes the caller's transaction.** The challenge row and the record
 * that says "send this email" commit together. That is not only durability: a
 * provider call on this path would make the endpoint's *latency* and its
 * *failure mode* depend on whether the address has an account, and both of those
 * are account-existence oracles. Writing a row costs the same either way.
 *
 * The port stays injectable so tests can observe what was sent without the
 * product ever gaining a code path that leaks it.
 */
export interface RecoveryMessage {
  /** The challenge's own id. It is the outbox idempotency key. */
  readonly challengeId: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface RecoveryDeliveryPort {
  deliver(sql: SqlExecutor, message: RecoveryMessage): Promise<void>;
}

/**
 * The adapter used outside production when no outbox is wanted.
 *
 * It logs that a recovery message *would* be sent, with the address redacted
 * and **without the token**, and returns. It deliberately does not throw: a
 * recovery request must return the same generic response whether or not
 * delivery is configured, or the response itself becomes the oracle.
 *
 * This is not a working email integration and must never be described as one.
 * The composition root binds `OutboxRecoveryDelivery` instead.
 */
export class LoggingRecoveryDelivery implements RecoveryDeliveryPort {
  constructor(private readonly log: (line: string) => void = console.info) {}

  deliver(_sql: SqlExecutor, message: RecoveryMessage): Promise<void> {
    this.log(
      `convo: password recovery prepared for ${redactEmail(message.email)}; ` +
        `no delivery adapter is configured, so nothing was sent. ` +
        `Token expires at ${message.expiresAt.toISOString()}.`,
    );
    return Promise.resolve();
  }
}

/**
 * `hana@digital-school.example` becomes `h***@digital-school.example`.
 *
 * Enough to correlate a support ticket, not enough to harvest an address list
 * from a log file.
 */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}
