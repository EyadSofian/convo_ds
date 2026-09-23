import { Inject, Injectable } from '@nestjs/common';
import type {
  CapabilityMatrix,
  ChannelKind,
  OwnerState,
  OwnershipRefusal,
  ResourceRef,
  SqlExecutor,
  WhatsAppTemplateDefinition,
} from '@convo/domain';
import { authorize, buildWhatsAppTemplateComponents, defineWhatsAppTemplate, renderWhatsAppTemplatePreview, capabilitiesFor, ownershipPermits, permitSend } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { LifecycleService } from '../conversations/lifecycle.service.js';
import { readConversation, readDetail } from '../conversations/record.js';
import { latestConversationInbound } from '../conversations/event-boundary.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { parseSendMessage } from './outbound-request.js';

/**
 * Accepting an outbound command.
 *
 * The one rule here, from DEL-10: **202 only after the durable transaction**.
 * The command row and its outbox entry commit together, so there is no moment
 * at which a caller has been told "queued" and nothing is scheduled to send it,
 * and no moment at which a message is scheduled with no record of who asked.
 *
 * Nothing is *sent* here. The permit that decides whether this message may
 * actually go out is re-evaluated by the dispatcher at the moment it dispatches
 * (DEL-11), because a window that is open now can be shut by then. What is
 * checked here is only what would be pointless to queue: a channel that cannot
 * carry this message type at all, and a note, which is never deliverable.
 */

export interface OutboundMessageSummary {
  readonly id: string;
  readonly connection_id: string;
  readonly peer_identity: string;
  readonly message_type: string;
  readonly client_message_id: string;
  readonly command_state: string;
  readonly state_reason: string | null;
  readonly delivery_state: string | null;
  readonly delivery_anomaly: string | null;
  readonly provider_message_id: string | null;
  readonly created_at: string;
  readonly settled_at: string | null;
  readonly attempts: readonly OutboundAttemptView[];
}

export interface OutboundAttemptView {
  readonly attempt_no: number;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly outcome: string | null;
  readonly error_code: string | null;
}

interface ConnectionRow {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly capabilities: unknown;
  readonly disconnected_at: Date | null;
}

interface StoredWhatsAppTemplate {
  readonly id: string;
  readonly provider_template_id: string;
  readonly template_name: string;
  readonly language: string;
  readonly status: string;
  readonly components: unknown;
}

export interface WhatsAppTemplateCatalogueItem {
  readonly id: string;
  readonly providerTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: string;
  readonly components: WhatsAppTemplateDefinition['components'];
  readonly parameters: WhatsAppTemplateDefinition['parameters'];
  readonly sendSupported: boolean;
  readonly unsupportedReason: string | null;
  readonly lastSyncedAt: string;
}

export interface WhatsAppTemplateCataloguePage {
  readonly items: readonly WhatsAppTemplateCatalogueItem[];
  readonly nextCursor: string | null;
}

@Injectable()
export class OutboundService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
  ) {}

  /** A bounded, connection-scoped catalogue for an authorized conversation. */
  async templates(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    query: { readonly search: string; readonly language: string; readonly category: string; readonly status: string; readonly cursor: string | null },
  ): Promise<WhatsAppTemplateCataloguePage> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const conversation = await readDetail(sql, conversationId);
      if (conversation === null || conversation.status === 'archived') throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
      const resource: ResourceRef = {
        inboxId: conversation.connectionId,
        ...(conversation.teamId === null ? {} : { teamId: conversation.teamId }),
        assigneeMembershipId: conversation.assigneeMembershipId,
        participantMembershipIds: conversation.participantMembershipIds,
      };
      if (!authorize(principal, 'conversation.reply', resource).allowed) throw new ApiHttpError(403, 'permission_denied', 'You do not have access to reply to this conversation.');
      const connectionId = conversation.connectionId;
      const connection = await requireLiveConnection(sql, connectionId);
      if (connection.kind !== 'whatsapp') throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
      const offset = query.cursor === null ? 0 : Number(query.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000) throw new ApiHttpError(400, 'invalid_cursor', 'Refresh the template catalogue to continue.');
      const values: unknown[] = [tenantId, connectionId];
      const where = ['tenant_id=$1', 'connection_id=$2'];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      if (query.search !== '') where.push(`(lower(template_name) LIKE ${add(`%${escapeLike(query.search.toLowerCase())}%`)} ESCAPE '\\' OR lower(language) LIKE ${add(`%${escapeLike(query.search.toLowerCase())}%`)} ESCAPE '\\' OR lower(category) LIKE ${add(`%${escapeLike(query.search.toLowerCase())}%`)} ESCAPE '\\')`);
      if (query.language !== '') where.push(`language=${add(query.language)}`);
      if (query.category !== '') where.push(`category=${add(query.category.toLowerCase())}`);
      if (query.status !== '') where.push(`status=${add(query.status)}`);
      const rows = await sql.query<{
        id: string; provider_template_id: string; template_name: string; language: string; category: string;
        status: string; components: unknown; last_synced_at: Date;
      }>(`SELECT id::text,provider_template_id,template_name,language,category,status,components,last_synced_at
            FROM whatsapp_templates WHERE ${where.join(' AND ')}
            ORDER BY lower(template_name),language,id OFFSET ${add(offset)} LIMIT 51`, values);
      const page = rows.rows.slice(0, 50);
      return {
        items: page.map((row) => {
          const definition = defineWhatsAppTemplate(row.components);
          return { id: row.id, providerTemplateId: row.provider_template_id, name: row.template_name, language: row.language, category: row.category, status: row.status, ...definition, lastSyncedAt: row.last_synced_at.toISOString() };
        }),
        nextCursor: rows.rows.length > 50 ? String(offset + 50) : null,
      };
    });
  }

  /**
   * Queues one message, or refuses it now.
   *
   * `conversation.reply` rather than `channel.manage`: sending is the agent's
   * daily act, and it is deliberately not the same permission as reconfiguring
   * a channel.
   */
  /**
   * Queues a send.
   *
   * `resource` carries the ownership terms when the caller reached this through
   * a conversation. Without them an `own`-level `conversation.reply` grant —
   * which is what an Agent holds — can never be satisfied, because "your
   * conversation" is not a fact about a channel. The conversation route passes
   * them; the channel route has none to pass, and an Agent replying there is
   * correctly refused.
   */
  async queue(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
    body: unknown,
    resource: ResourceRef = {},
    /**
     * The conversation this reply answers, when there is one.
     *
     * Present for a reply through the inbox, absent for a send addressed
     * straight at a connection. It is what lets the first-response clock start
     * **inside the same transaction as the command**: a clock started after the
     * commit would be a second write that can fail on its own, and a report
     * whose numbers depend on whether a follow-up query succeeded is not a
     * report.
     */
    conversationId: string | null = null,
  ): Promise<OutboundMessageSummary> {
    const parsed = parseSendMessage(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The request is not valid.', parsed.details);
    }
    const request = parsed.value;

    return this.authorization.authorized(
      session,
      tenantId,
      'conversation.reply',
      async ({ sql, principal }) => {
        const existing = await sql.query<{ id: string; author_membership: string | null }>(
          'SELECT id::text,author_membership::text FROM outbound_messages WHERE tenant_id=$1 AND client_message_id=$2',
          [tenantId, request.clientMessageId],
        );
        const already = existing.rows[0];
        if (already !== undefined) {
          if (already.author_membership !== principal.membershipId) throw new ApiHttpError(409, 'idempotency_key_conflict', 'This message key is already in use. Use a new key for a new message.');
          return requireRow(await readMessages(sql, already.id), 'the message vanished');
        }
        const connection = await requireLiveConnection(sql, connectionId);
        const capabilities = capabilitiesOf(connection);
        let templateName: string | null = request.template?.name ?? null;
        let templateLanguage: string | null = request.template?.language ?? null;
        let templateProviderId: string | null = null;
        let templateComponents: readonly { readonly type: 'header' | 'body' | 'button'; readonly subType?: 'url'; readonly index?: string; readonly parameters: readonly { readonly type: 'text'; readonly text: string }[] }[] = [];
        let templatePreview: string | null = null;
        if ((request.messageType === 'template') !== (request.template !== null)) {
          throw new ApiHttpError(400, 'invalid_input', 'A template message must select a WhatsApp catalogue entry.');
        }
        if (request.template !== null && request.template.id === undefined) {
          throw new ApiHttpError(422, 'template_selection_required', 'Select an approved template from this conversation’s WhatsApp catalogue.');
        }
        if (request.template?.id !== undefined) {
          if (connection.kind !== 'whatsapp') throw new ApiHttpError(422, 'template_not_sendable', 'WhatsApp templates can only be sent on a WhatsApp connection.');
          const stored = (await sql.query<StoredWhatsAppTemplate>(
            `SELECT id::text,provider_template_id,template_name,language,status,components FROM whatsapp_templates
              WHERE id=$1 AND tenant_id=$2 AND connection_id=$3`,
            [request.template.id, tenantId, connectionId],
          )).rows[0];
          if (stored === undefined || stored.status !== 'approved') throw new ApiHttpError(409, 'template_not_sendable', 'This WhatsApp template is no longer approved. Refresh the catalogue and choose an approved template.');
          const definition = defineWhatsAppTemplate(stored.components);
          const values = request.template.parameters ?? {};
          const built = buildWhatsAppTemplateComponents(definition, values);
          if (built === null) throw new ApiHttpError(422, 'template_parameters_invalid', definition.unsupportedReason ?? 'Provide every required template parameter and no extra values.');
          templateName = stored.template_name;
          templateLanguage = stored.language;
          templateProviderId = stored.provider_template_id;
          templateComponents = built;
          templatePreview = renderWhatsAppTemplatePreview(definition, values);
        }

        // Refused at the door, not queued to fail later: a note is never
        // deliverable and a channel that cannot carry this type never will
        // (CH-01, DEL-11).
        const shape = permitSend({
          kind: connection.kind,
          capabilities,
          messageType: request.messageType,
          isPrivateNote: request.isPrivateNote,
          text: request.text,
          // Deliberately generous: the *window* is the dispatcher's decision,
          // and refusing here on a window that may reopen would throw away a
          // message an agent legitimately wrote.
          lastInboundAt: new Date(),
          now: new Date(),
          template: templateName === null ? null : { name: templateName, kind: connection.kind },
          consentWithdrawn: false,
        });
        if (!shape.allowed) {
          throw new ApiHttpError(422, shape.reason, shape.detail);
        }

        // ── ownership (ADR-0008) ────────────────────────────────────────
        // Read from the row, not from the request: a generation that started
        // while a bot held the conversation must not become a valid send
        // because a screen changed in between. Centralised here so every send
        // passes the same barrier, and bound to `owner_version` so the audit
        // says which ownership the permit was issued under.
        const ownership = await requireOwnership(sql, conversationId);
        const barrier = ownershipPermits(ownership.state, 'human');
        if (barrier !== null) {
          throw new ApiHttpError(409, barrier, OWNERSHIP_MESSAGE[barrier]);
        }

        if (conversationId !== null) {
          const boundConversation = await sql.query<{ id: string }>(
            `SELECT id::text FROM conversations
              WHERE id=$1 AND tenant_id=$2 AND connection_id=$3 AND peer_identity=$4 AND status <> 'archived'`,
            [conversationId, tenantId, connectionId, request.peerIdentity],
          );
          if (boundConversation.rows[0] === undefined) {
            throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
          }
        }

        // Replies addressed to a WhatsApp conversation are checked against
        // inbound evidence for that exact conversation. Dispatch repeats this
        // check later, because a queued message can outlive its service window.
        if (connection.kind === 'whatsapp' && conversationId !== null && request.template === null) {
          const window = await latestConversationInbound(sql, conversationId);
          const expiresAt = window.lastInboundAt === null
            ? null
            : new Date(window.lastInboundAt.getTime() + 24 * 60 * 60 * 1000);
          if (expiresAt === null || expiresAt.getTime() <= window.serverNow.getTime()) {
            throw new ApiHttpError(
              422,
              'outside_service_window',
              'The WhatsApp 24-hour service window is closed. Choose an approved template to continue.',
            );
          }
        }

        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO outbound_messages
             (tenant_id, connection_id, peer_identity, conversation_id, author_membership, message_type,
              text_body, template_name, template_language, template_provider_id, template_components, template_preview, client_message_id,
              permitted_owner_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
           RETURNING id::text`,
          [
            tenantId,
            connectionId,
            request.peerIdentity,
            conversationId,
            principal.membershipId,
            request.messageType,
            request.text === '' ? null : request.text,
            templateName,
            templateLanguage,
            templateProviderId,
            JSON.stringify(templateComponents),
            templatePreview,
            request.clientMessageId,
            // The permit is bound to the ownership it was granted under, so a
            // dispatch-time re-check has something to compare against. Nothing
            // re-checks it today: the only sender is a person, and a human
            // reply must not be dropped because a colleague was reassigned
            // between the queue and the wire. The re-check lands with the AI
            // path it exists for (OWN-02, OWN-03).
            ownership.version === 0 ? null : ownership.version,
          ],
        );
        const messageId = requireRow(inserted.rows, 'message insert returned no id').id;

        await sql.query(
          `INSERT INTO outbox (message_id, tenant_id, connection_id, peer_identity, traffic_class)
           VALUES ($1, $2, $3, $4, $5)`,
          [messageId, tenantId, connectionId, request.peerIdentity, request.trafficClass],
        );

        if (conversationId !== null) {
          // The first response is the first: `noteResponse` coalesces, so a
          // second reply cannot move the number a report is computed from.
          await this.lifecycle.noteResponse(sql, conversationId, new Date(), principal.membershipId);
        }

        return requireRow(await readMessages(sql, messageId), 'the message vanished');
      },
      resource,
    );
  }

  async read(
    session: AuthenticatedSession,
    tenantId: string,
    messageId: string,
  ): Promise<OutboundMessageSummary> {
    return this.authorization.authorized(session, tenantId, 'conversation.read', async ({ sql }) => {
      const rows = await readMessages(sql, messageId);
      const row = rows[0];
      if (row === undefined) {
        throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
      }
      return row;
    });
  }

  async list(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
  ): Promise<readonly OutboundMessageSummary[]> {
    return this.authorization.authorized(session, tenantId, 'conversation.read', async ({ sql }) =>
      readMessages(sql, null, connectionId),
    );
  }
}

/* ------------------------------------------------------------- shared sql -- */

export async function requireLiveConnection(
  sql: SqlExecutor,
  connectionId: string,
): Promise<ConnectionRow> {
  const rows = await sql.query<ConnectionRow>(
    `SELECT id::text, kind, capabilities, disconnected_at
       FROM channel_connections WHERE id = $1`,
    [connectionId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
  }
  if (row.disconnected_at !== null) {
    throw new ApiHttpError(
      409,
      'channel_disconnected',
      'That channel is disconnected and cannot send.',
    );
  }
  return row;
}

/**
 * The matrix this connection was frozen against, falling back to the build's.
 *
 * A connection created before a matrix was stored, or one whose stored value is
 * not a matrix, uses the current one rather than failing to send: an old row is
 * not a reason to refuse an agent's reply.
 */
export function capabilitiesOf(connection: {
  readonly kind: ChannelKind;
  readonly capabilities: unknown;
}): CapabilityMatrix {
  const stored = connection.capabilities;
  return typeof stored === 'object' && stored !== null && 'outboundTypes' in stored
    ? (stored as CapabilityMatrix)
    : capabilitiesFor(connection.kind);
}

async function readMessages(
  sql: SqlExecutor,
  messageId: string | null,
  connectionId?: string,
): Promise<readonly OutboundMessageSummary[]> {
  const rows = await sql.query<{
    id: string;
    connection_id: string;
    peer_identity: string;
    message_type: string;
    client_message_id: string;
    command_state: string;
    state_reason: string | null;
    delivery_state: string | null;
    delivery_anomaly: string | null;
    provider_message_id: string | null;
    created_at: Date;
    settled_at: Date | null;
  }>(
    `SELECT id::text, connection_id::text, peer_identity, message_type, client_message_id,
            command_state, state_reason, delivery_state, delivery_anomaly,
            provider_message_id, created_at, settled_at
       FROM outbound_messages
      WHERE ($1::uuid IS NULL OR id = $1)
        AND ($2::uuid IS NULL OR connection_id = $2)
      ORDER BY created_at`,
    [messageId, connectionId ?? null],
  );
  if (rows.rows.length === 0) {
    return [];
  }
  const attempts = await sql.query<{
    message_id: string;
    attempt_no: number;
    started_at: Date;
    completed_at: Date | null;
    outcome: string | null;
    error_code: string | null;
  }>(
    `SELECT message_id::text, attempt_no, started_at, completed_at, outcome, error_code
       FROM outbound_attempts
      WHERE message_id = ANY($1::uuid[])
      ORDER BY attempt_no`,
    [rows.rows.map((row) => row.id)],
  );

  return rows.rows.map((row) => ({
    id: row.id,
    connection_id: row.connection_id,
    peer_identity: row.peer_identity,
    message_type: row.message_type,
    client_message_id: row.client_message_id,
    command_state: row.command_state,
    state_reason: row.state_reason,
    delivery_state: row.delivery_state,
    delivery_anomaly: row.delivery_anomaly,
    provider_message_id: row.provider_message_id,
    created_at: row.created_at.toISOString(),
    settled_at: row.settled_at?.toISOString() ?? null,
    attempts: attempts.rows
      .filter((attempt) => attempt.message_id === row.id)
      .map((attempt) => ({
        attempt_no: attempt.attempt_no,
        started_at: attempt.started_at.toISOString(),
        completed_at: attempt.completed_at?.toISOString() ?? null,
        outcome: attempt.outcome,
        error_code: attempt.error_code,
      })),
  }));
}

/**
 * The conversation's ownership, or the permissive default.
 *
 * A send addressed straight at a connection has no conversation to own it —
 * a campaign-neutral contact activity, or the first outbound to somebody nobody
 * has heard from — and there is nothing for the barrier to be about. Absent is
 * treated as `human_active`, which is what it is: a person is sending it.
 */
async function requireOwnership(
  sql: SqlExecutor,
  conversationId: string | null,
): Promise<{ readonly state: OwnerState; readonly version: number }> {
  if (conversationId === null) {
    return { state: 'human_active', version: 0 };
  }
  // `readConversation` narrows the stored state to ADR-0008's four and throws
  // loudly on anything else, so the barrier is never handed a state it has no
  // rule for. A missing row is a conversation that is not there to send into.
  const conversation = await readConversation(sql, conversationId);
  if (conversation === null) {
    throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
  }
  return { state: conversation.ownerState, version: conversation.ownerVersion };
}

const OWNERSHIP_MESSAGE: Readonly<Record<OwnershipRefusal, string>> = {
  // Deliberately not "the message was cancelled": ADR-0008 exists because
  // nobody can recall a request a provider has already accepted.
  handoff_barrier_pending:
    'An automated reply may already be with the provider. Human ownership is confirmed once that clears.',
  ownership_is_human: 'A person is handling this conversation.',
  bot_is_paused: 'Automated replies are paused on this conversation.',
};

function escapeLike(value: string): string { return value.replace(/[\\%_]/g, '\\$&'); }
