import { Inject, Injectable } from '@nestjs/common';
import type { SqlExecutor } from '@convo/domain';
import type { ApiConfig } from '../config.js';
import { API_CONFIG } from '../tokens.js';
import type { RecoveryDeliveryPort, RecoveryMessage } from '../auth/recovery-delivery.js';
import type { InvitationDeliveryPort, InvitationMessage } from '../people/invitation-delivery.js';
import { enqueueEmail } from './email-outbox.service.js';

/**
 * The production bindings for the two delivery ports.
 *
 * Each one does exactly one thing: write a row on the caller's executor. No
 * rendering, no network, no branching on provider. That is what makes the
 * business services above them provider-agnostic in fact rather than in
 * intention — neither `InvitationService` nor `RecoveryService` can tell whether
 * this installation sends through Resend, SMTP or nothing at all.
 *
 * The locale is the installation's email language (CONVO_EMAIL_LOCALE,
 * English unless set). The product has no per-person language preference yet,
 * and guessing one from an `Accept-Language` header would be wrong for exactly
 * the case that matters: an invitation is read by someone who has never
 * visited this installation.
 */

@Injectable()
export class OutboxInvitationDelivery implements InvitationDeliveryPort {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async deliver(sql: SqlExecutor, message: InvitationMessage): Promise<void> {
    await enqueueEmail(sql, {
      kind: 'invitation',
      tenantId: message.tenantId,
      // The invitation's id. Superseding an invitation creates a new row and
      // therefore a new key, so a re-invite is a second email — which is what
      // an operator pressing "invite again" means.
      idempotencyKey: message.invitationId,
      email: message.email,
      locale: this.config.emailLocale,
      workspaceName: message.tenantName,
      roleName: message.roleName,
      token: message.token,
      expiresAt: message.expiresAt,
    });
  }
}

@Injectable()
export class OutboxRecoveryDelivery implements RecoveryDeliveryPort {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async deliver(sql: SqlExecutor, message: RecoveryMessage): Promise<void> {
    await enqueueEmail(sql, {
      kind: 'password_recovery',
      idempotencyKey: message.challengeId,
      email: message.email,
      locale: this.config.emailLocale,
      token: message.token,
      expiresAt: message.expiresAt,
    });
  }
}
