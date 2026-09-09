import { redactEmail } from '../auth/recovery-delivery.js';

/**
 * Where an invitation token goes.
 *
 * The same rule as password recovery: the token is generated on the server,
 * fingerprinted for storage, and handed to a delivery adapter. It is never
 * returned in an HTTP response and never written to a log, because an
 * invitation token is a credential — holding one is how you become a member.
 */
export interface InvitationMessage {
  readonly email: string;
  readonly token: string;
  readonly tenantName: string;
  readonly roleName: string;
  readonly expiresAt: Date;
}

export interface InvitationDeliveryPort {
  deliver(message: InvitationMessage): Promise<void>;
}

/**
 * The default adapter until an email provider is configured.
 *
 * Logs that an invitation *would* be sent, with the address redacted and
 * without the token, and returns. It does not throw: the caller has already
 * committed the invitation, and failing the request afterwards would leave a
 * live invitation the operator was told had failed.
 *
 * This is not a working email integration and must not be described as one.
 */
export class LoggingInvitationDelivery implements InvitationDeliveryPort {
  constructor(private readonly log: (line: string) => void = console.info) {}

  async deliver(message: InvitationMessage): Promise<void> {
    this.log(
      `convo: invitation prepared for ${redactEmail(message.email)} as ${message.roleName}; ` +
        `no delivery adapter is configured, so nothing was sent. ` +
        `It expires at ${message.expiresAt.toISOString()}.`,
    );
    return Promise.resolve();
  }
}
