import { Inject, Injectable } from '@nestjs/common';
import type { ChannelKind } from '@convo/domain';
import { authorize } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { conversationEventBoundary } from '../conversations/event-boundary.js';
import { readDetail } from '../conversations/record.js';
import { ApiHttpError } from '../http-error.js';
import { CHANNEL_TRANSPORT } from '../tokens.js';
import type { ChannelTransportPort } from './channel-transport.js';
import { ChannelCredentialService } from './credential.service.js';

/** What the browser may render itself. Anything else is only ever downloaded. */
const INLINE_MEDIA = /^(image\/(jpeg|png|gif|webp)|audio\/[a-z0-9.+-]+|video\/(mp4|3gpp|webm|quicktime))$/;

export interface InboundMedia {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly inline: boolean;
}

const unavailable = (): ApiHttpError => new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');

/**
 * What a customer sent, fetched on request and never stored.
 *
 * A provider holds these: WhatsApp behind a media id that needs the connection's
 * token, Messenger and Instagram behind a signed link. The browser can use neither
 * directly, so it asks here, and this checks on every request that the caller may
 * read this conversation and that the message really belongs to it.
 */
@Injectable()
export class InboundMediaService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ChannelCredentialService) private readonly credentials: ChannelCredentialService,
    @Inject(CHANNEL_TRANSPORT) private readonly transport: ChannelTransportPort,
  ) {}

  async read(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    eventId: string,
    index: string,
  ): Promise<InboundMedia> {
    this.authorization.assertTenantId(conversationId);
    this.authorization.assertTenantId(eventId);
    const fetchMedia = this.transport.fetchInboundMedia;
    if (fetchMedia === undefined || !/^[0-9]{1,2}$/.test(index)) throw unavailable();
    const fetched = await this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null || !authorize(principal, 'conversation.read', {
        inboxId: detail.connectionId, ...(detail.teamId === null ? {} : { teamId: detail.teamId }),
        assigneeMembershipId: detail.assigneeMembershipId, participantMembershipIds: detail.participantMembershipIds,
      }).allowed) throw unavailable();
      const rows = await sql.query<{ attachments: readonly { readonly providerId?: unknown; readonly mimeType?: unknown }[]; kind: ChannelKind }>(
        `SELECT x.attachments, connection.kind
           FROM inbound_events x
           JOIN conversations c ON c.id = $2
           JOIN channel_connections connection ON connection.id = x.connection_id
          WHERE x.id = $1 AND x.kind IN ('message', 'echo')
            AND ${conversationEventBoundary('c', 'x', 'x.occurred_at', { inboundOpeningEvent: true })}`,
        [eventId, conversationId],
      );
      const row = rows.rows[0];
      const attachment = row?.attachments[Number(index)];
      const providerId = attachment?.providerId;
      if (row === undefined || typeof providerId !== 'string' || providerId === '') throw unavailable();
      const result = await this.credentials.withActive(
        sql,
        { tenantId, connectionId: detail.connectionId, purpose: 'access_token' },
        (token) => fetchMedia.call(this.transport, row.kind, token, providerId),
      );
      return { result, declared: typeof attachment?.mimeType === 'string' ? attachment.mimeType : null };
    });
    if (fetched.result === null) throw unavailable();
    if (!fetched.result.ok) {
      throw new ApiHttpError(fetched.result.retryable ? 503 : 404, fetched.result.code, fetched.result.message);
    }
    // What the provider declared when the message arrived, then what it answers
    // with now; parameters such as `codecs=opus` are for the player, not for this.
    const mimeType = (fetched.declared ?? fetched.result.mimeType ?? '').split(';')[0]!.trim().toLowerCase();
    const inline = INLINE_MEDIA.test(mimeType);
    return { data: fetched.result.data, mimeType: inline ? mimeType : 'application/octet-stream', inline };
  }
}
