import type { SqlExecutor } from '@convo/domain';
import { redactEmail } from '../auth/recovery-delivery.js';

/**
 * Where an invitation token goes.
 *
 * The same rule as password recovery: the token is generated on the server,
 * fingerprinted for storage, and handed to a delivery adapter. It is never
 * returned in an HTTP response and never written to a log, because an
 * invitation token is a credential — holding one is how you become a member.
 *
 * **`deliver` takes the caller's transaction, and that is the whole design.**
 * The invitation row and the record that says "send this email" commit together
 * or not at all. Handing the token to something that performs a network call
 * here would mean an invitation committed with no email (the provider was down)
 * or an email for an invitation that rolled back (the transaction failed after
 * the send). Neither is recoverable after the fact; a row in the same
 * transaction makes both impossible.
 */
export interface InvitationMessage {
  readonly tenantId: string;
  /** The invitation's own id. It is the outbox idempotency key. */
  readonly invitationId: string;
  readonly email: string;
  readonly token: string;
  readonly tenantName: string;
  readonly roleName: string;
  readonly expiresAt: Date;
}

export interface InvitationDeliveryPort {
  deliver(sql: SqlExecutor, message: InvitationMessage): Promise<void>;
}

/**
 * The adapter used when no outbox is wanted: local development and tests that
 * are not about email.
 *
 * Logs that an invitation *would* be sent, with the address redacted and
 * without the token, and returns. It does not throw, because the caller has
 * already built the invitation and failing the request afterwards would leave a
 * live invitation the operator was told had failed.
 *
 * This is not a working email integration and must not be described as one. The
 * composition root binds `OutboxInvitationDelivery` instead; this is kept only
 * so a test can assert on delivery without a table.
 */
export class LoggingInvitationDelivery implements InvitationDeliveryPort {
  constructor(private readonly log: (line: string) => void = console.info) {}

  deliver(_sql: SqlExecutor, message: InvitationMessage): Promise<void> {
    this.log(
      `convo: invitation prepared for ${redactEmail(message.email)} as ${message.roleName}; ` +
        `no delivery adapter is configured, so nothing was sent. ` +
        `It expires at ${message.expiresAt.toISOString()}.`,
    );
    return Promise.resolve();
  }
}
