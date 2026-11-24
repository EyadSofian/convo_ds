import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import { authorize, defineWhatsAppTemplate, normalizeSearchText, type Principal, type SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { tokenFingerprint } from '../auth/auth-tokens.js';
import { AuthorizationService, loadPrincipalForMembership } from '../authorization/authorization.service.js';
import { parseSendMessage } from '../channels/outbound-request.js';
import { OutboundService } from '../channels/outbound.service.js';
import { templateAccessPredicate } from '../channels/template-access.js';
import type { ApiConfig } from '../config.js';
import { latestConversationInbound } from '../conversations/event-boundary.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG, API_POOL } from '../tokens.js';

export interface CrmSender {
  readonly id: string;
  readonly displayName: string;
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string | null;
  readonly sendReady: boolean;
}

interface CrmContext {
  readonly sql: SqlExecutor;
  readonly principal: Principal;
  readonly key: { readonly id: string; readonly connection_ids: readonly string[] };
  readonly tenantId: string;
}

export interface CrmTarget {
  readonly phone: string;
  readonly contactId: string | null;
  readonly conversations: readonly { readonly id: string; readonly connectionId: string; readonly status: string }[];
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PHONE = /^[1-9][0-9]{7,14}$/;
export interface CrmKey {
  readonly id: string;
  readonly label: string;
  readonly connection_ids: readonly string[];
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

const KEY_COLUMNS = 'id::text,label,connection_ids,created_at,expires_at,revoked_at';

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Provide a JSON object.');
  return body as Record<string, unknown>;
}

function invalid(message: string): ApiHttpError {
  return new ApiHttpError(400, 'invalid_input', message);
}

function notFound(): ApiHttpError {
  return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist in this integration.');
}

function badKey(): ApiHttpError {
  return new ApiHttpError(401, 'crm_key_invalid', 'Provide an active CRM integration key.');
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`Provide a valid ${field} UUID.`);
  return value.toLowerCase();
}

@Injectable()
export class CrmWhatsAppService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
  ) {}

  async settings(session: AuthenticatedSession, tenantId: string) {
    return this.authorization.authorized(session, tenantId, 'api_key.manage', async ({ sql, principal }) => {
      const keys = await sql.query<CrmKey>(`SELECT ${KEY_COLUMNS} FROM crm_whatsapp_keys
        WHERE revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`);
      return { tenantId, senders: await senders(sql, principal), keys: keys.rows };
    });
  }

  async createKey(session: AuthenticatedSession, tenantId: string, body: unknown) {
    const input = object(body);
    const label = typeof input['label'] === 'string' ? input['label'].trim() : '';
    const connections = input['connectionIds'];
    if (label.length === 0 || label.length > 80 || !Array.isArray(connections) || connections.length < 1 || connections.length > 50) {
      throw invalid('Provide a label and between 1 and 50 WhatsApp senders.');
    }
    const ids = [...new Set(connections.map((id: unknown) => uuid(id, 'connectionId')))];
    return this.authorization.authorized(session, tenantId, 'api_key.manage', async ({ sql, principal }) => {
      const allowed = await senders(sql, principal);
      if (ids.some((id) => !allowed.some((sender) => sender.id === id))) throw notFound();
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crm-keys:${tenantId}`]);
      const capacity = await sql.query('SELECT 1 FROM crm_whatsapp_keys WHERE revoked_at IS NULL AND expires_at>now() OFFSET 49 LIMIT 1');
      if (capacity.rows.length > 0) throw new ApiHttpError(409, 'crm_key_limit', 'Revoke a key before creating another.');
      const token = 'convo_crm_' + randomBytes(32).toString('base64url');
      const inserted = await sql.query<CrmKey>(
        `INSERT INTO crm_whatsapp_keys (tenant_id,created_by,label,token_hash,connection_ids)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${KEY_COLUMNS}`,
        [tenantId, principal.membershipId, label, this.fingerprint(token), ids],
      );
      const key = requireRow(inserted.rows, 'CRM key was not created');
      await recordKeyChange(sql, tenantId, principal.membershipId, session.email, key.id, 'created', { connectionIds: ids });
      return { key, token };
    });
  }

  async revokeKey(session: AuthenticatedSession, tenantId: string, keyId: string): Promise<void> {
    const id = uuid(keyId, 'keyId');
    await this.authorization.authorized(session, tenantId, 'api_key.manage', async ({ sql, principal }) => {
      const result = await sql.query('UPDATE crm_whatsapp_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id', [id]);
      if (result.rows.length === 0) throw notFound();
      await recordKeyChange(sql, tenantId, principal.membershipId, session.email, id, 'revoked', {});
    });
  }

  async listSenders(context: CrmContext) {
    return senders(context.sql, context.principal, context.key.connection_ids);
  }

  async templates(context: CrmContext, connectionId: string, cursor: string | undefined) {
    const connection = await this.sender(context, connectionId);
    const after = cursor === undefined ? null : uuid(cursor, 'cursor');
    const values: unknown[] = [connection.id, after];
    const access = templateAccessPredicate(context.principal, (value) => {
      values.push(value);
      return `$${values.length}`;
    });
    const rows = await context.sql.query<{
      id: string; template_name: string; language: string; category: string; status: string; components: unknown; last_synced_at: Date;
    }>(`SELECT id::text,template_name,language,category,status,components,last_synced_at
      FROM whatsapp_templates WHERE connection_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) AND ${access}
      ORDER BY id LIMIT 101`, values);
    return {
      items: rows.rows.slice(0, 100).map((row) => ({
        id: row.id, connectionId: connection.id, name: row.template_name, language: row.language,
        category: row.category, status: row.status, ...defineWhatsAppTemplate(row.components),
        lastSyncedAt: row.last_synced_at.toISOString(),
      })),
      nextCursor: rows.rows.length > 100 ? rows.rows[99]!.id : null,
    };
  }

  async lookup(context: CrmContext, body: unknown): Promise<CrmTarget> {
    const input = object(body);
    const allowed = await this.listSenders(context);
    const contactId = input['contactId'] === undefined ? null : uuid(input['contactId'], 'contactId');
    const raw = input['phone'];
    if (raw !== undefined && (typeof raw !== 'string' || !/^\+?[1-9][0-9]{7,14}$/.test(raw))) {
      throw invalid('Use an international WhatsApp number, including country code.');
    }
    const phone = typeof raw === 'string' ? raw.replace(/^\+/, '') : null;
    if (phone === null && contactId === null) throw invalid('Provide phone or contactId.');
    return resolveTarget(context.sql, allowed.map((sender) => sender.id), phone, contactId);
  }

  async send(context: CrmContext, body: unknown) {
    const input = object(body);
    const connection = await this.sender(context, uuid(input['connectionId'], 'connectionId'));
    const proof = typeof input['optInReference'] === 'string' ? input['optInReference'].trim() : '';
    const displayName = input['displayName'] === undefined ? null : input['displayName'];
    if (proof.length === 0 || proof.length > 240) throw invalid('Provide an opt-in reference of 1–240 characters.');
    if (displayName !== null && (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 190)) {
      throw invalid('Display name must be between 1 and 190 characters.');
    }
    const expected = input['conversationId'] === undefined ? null : uuid(input['conversationId'], 'conversationId');
    const parsed = parseSendMessage({
      peerIdentity: 'placeholder', messageType: 'template', template: input['template'], clientMessageId: input['clientMessageId'],
    });
    if (!parsed.ok) throw new ApiHttpError(400, 'invalid_input', 'Provide a valid message ID and template.', parsed.details);
    const template = parsed.value.template;
    if (template?.id === undefined || template.parameters === undefined) throw invalid('Select a template by its Omni ID.');
    const clientId = parsed.value.clientMessageId;
    const phone = typeof input['phone'] === 'string' ? input['phone'].replace(/^\+/, '') : input['phone'];
    const fingerprint = createHash('sha256').update(JSON.stringify([
      connection.id, phone, input['contactId'], expected, displayName, proof, template.id,
      Object.entries(template.parameters).sort(([left], [right]) => left.localeCompare(right)),
    ])).digest('hex');
    const { sql, tenantId, principal } = context;
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crm-send:${context.key.id}:${clientId}`]);
    const previous = (await sql.query<{ message_id: string; request_hash: string }>(
      'SELECT message_id::text,request_hash FROM crm_whatsapp_sends WHERE key_id=$1 AND client_message_id=$2',
      [context.key.id, clientId],
    )).rows[0];
    if (previous !== undefined) {
      if (previous.request_hash !== fingerprint) throw new ApiHttpError(409, 'idempotency_key_conflict', 'This clientMessageId already identifies a different request.');
      return this.status(context, previous.message_id);
    }
    if (!connection.sendReady) throw new ApiHttpError(409, 'channel_not_ready', 'Verify the WhatsApp credential and subscribe to messages in Channels.');

    const beforeLock = await this.lookup(context, input);
    const peer = beforeLock.phone.slice(1);
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`quick-whatsapp:${tenantId}:${peer}`]);
    const current = await this.lookup(context, { ...input, phone: peer });
    const suppressed = await sql.query(`SELECT 1 FROM channel_suppressions WHERE kind='whatsapp' AND peer_identity=$1`, [peer]);
    if (suppressed.rows.length > 0) throw new ApiHttpError(409, 'consent_withdrawn', 'This number opted out of WhatsApp messages.');

    const conversation = await this.conversations.ensure(sql, tenantId, connection.id, peer, 'outbound_contact');
    if (expected !== null && expected !== conversation.id) throw new ApiHttpError(409, 'conversation_mismatch', 'This is no longer the current conversation on the selected sender.');
    const contactId = await resolveContactForSender(sql, tenantId, connection.id, peer, conversation.id, current.contactId, displayName);
    await this.outbound.linkOutboundContact(sql, tenantId, connection.id, peer, contactId, {
      id: conversation.id, contact_id: conversation.contactId,
    });
    const message = await this.outbound.queueAuthorized(sql, principal, tenantId, connection.id, {
      ...parsed.value, peerIdentity: peer, clientMessageId: `crm:${context.key.id}:${createHash('sha256').update(clientId).digest('hex')}`,
    }, conversation.id, false);
    await sql.query(`INSERT INTO crm_whatsapp_sends
      (tenant_id,key_id,client_message_id,request_hash,message_id,contact_id,opt_in_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, context.key.id, clientId, fingerprint, message.id, contactId, proof]);
    return this.status(context, message.id);
  }

  async status(context: CrmContext, messageId: string) {
    const message = (await context.sql.query<{
      id: string; clientMessageId: string; connectionId: string; contactId: string; conversationId: string;
      conversationStatus: string; commandState: string; stateReason: string | null;
      deliveryState: string | null; deliveryAnomaly: string | null; providerMessageId: string | null;
      queuedAt: Date; settledAt: Date | null;
    }>(`SELECT m.id::text, s.client_message_id AS "clientMessageId", m.connection_id::text AS "connectionId",
       COALESCE(c.contact_id,s.contact_id)::text AS "contactId", m.conversation_id::text AS "conversationId",
       c.status AS "conversationStatus", m.command_state AS "commandState", m.state_reason AS "stateReason",
       m.delivery_state AS "deliveryState", m.delivery_anomaly AS "deliveryAnomaly",
       m.provider_message_id AS "providerMessageId", m.created_at AS "queuedAt", m.settled_at AS "settledAt"
       FROM crm_whatsapp_sends s JOIN outbound_messages m ON m.id=s.message_id
       JOIN conversations c ON c.id=m.conversation_id
       WHERE s.key_id=$1 AND s.message_id=$2 AND m.connection_id=ANY($3::uuid[])`,
      [context.key.id, uuid(messageId, 'messageId'), context.key.connection_ids],
    )).rows[0];
    if (message === undefined || !authorize(context.principal, 'conversation.reply', {
      inboxId: message.connectionId,
    }).allowed) throw notFound();
    const inbound = await latestConversationInbound(context.sql, message.conversationId);
    return { ...message, lastCustomerMessageAt: inbound.lastInboundAt };
  }

  async withKey<T>(tenantId: string, header: string | undefined, work: (context: CrmContext) => Promise<T>): Promise<T> {
    const token = /^Bearer (convo_crm_[A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1];
    if (token === undefined || !UUID.test(tenantId)) throw badKey();
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const key = (await sql.query<{ id: string; created_by: string; connection_ids: string[] }>(
        `SELECT k.id::text,k.created_by::text,k.connection_ids FROM crm_whatsapp_keys k
         JOIN memberships m ON m.id=k.created_by AND m.status='active'
         JOIN users u ON u.id=m.user_id AND u.status='active'
         WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now()
         FOR SHARE OF k,m,u`, [this.fingerprint(token)],
      )).rows[0];
      if (key === undefined) throw badKey();
      // The key query locks its active membership, whose tenant is required by FK.
      const principal = (await loadPrincipalForMembership(sql, key.created_by))!;
      if (!authorize(principal, 'api_key.manage').allowed) throw badKey();
      return work({ sql, principal, key, tenantId });
    });
  }

  private fingerprint(token: string): string {
    return tokenFingerprint(this.config.secrets.authHash, 'crm-whatsapp', token);
  }

  private async sender(context: CrmContext, id: string): Promise<CrmSender> {
    const sender = (await this.listSenders(context)).find((item) => item.id === id);
    if (sender === undefined) throw notFound();
    return sender;
  }
}

async function senders(sql: SqlExecutor, principal: Principal, ids: readonly string[] | null = null): Promise<CrmSender[]> {
  const rows = await sql.query<CrmSender>(`SELECT c.id::text,c.display_name AS "displayName",c.external_asset_id AS "phoneNumberId",
    c.settings->>'display_phone_number' AS "displayPhoneNumber",
    (c.credential_verified_at IS NOT NULL AND c.webhook_subscribed_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM channel_credentials credential
        WHERE credential.connection_id=c.id AND credential.status='active' AND credential.purpose='access_token'
          AND (credential.expires_at IS NULL OR credential.expires_at>now()))) AS "sendReady"
    FROM channel_connections c WHERE c.kind='whatsapp' AND c.disconnected_at IS NULL
      AND ($1::uuid[] IS NULL OR c.id=ANY($1))
    ORDER BY lower(c.display_name),c.id`, [ids]);
  return rows.rows.filter((sender) => authorize(principal, 'conversation.reply', { inboxId: sender.id }).allowed);
}

async function resolveTarget(sql: SqlExecutor, ids: readonly string[], phone: string | null, contactId: string | null): Promise<CrmTarget> {
  const identities = await sql.query<{ contact_id: string; phone: string }>(
    `SELECT DISTINCT i.contact_id::text,ltrim(i.external_id,'+') AS phone
       FROM contact_identities i JOIN contacts c ON c.id=i.contact_id
       WHERE i.kind='whatsapp' AND i.valid_to IS NULL AND c.deleted_at IS NULL AND i.scope_id=ANY($1::uuid[])
         AND ($2::text IS NULL OR i.external_id IN ($2,'+' || $2))
         AND ($3::uuid IS NULL OR i.contact_id=$3) LIMIT 2`, [ids, phone, contactId],
  );
  if (identities.rows.length > 1) throw new ApiHttpError(409, 'ambiguous_contact', 'Multiple contacts or numbers match. Specify both contactId and phone.');
  const identity = identities.rows[0];
  if (contactId !== null && identity === undefined) throw notFound();
  const peer = phone ?? requireRow(identities.rows, 'The requested CRM identity vanished').phone;
  if (!PHONE.test(peer)) throw invalid('The contact has no valid international WhatsApp number.');
  const threads = await sql.query<CrmTarget['conversations'][number]>(
    `SELECT id::text,connection_id::text AS "connectionId",status FROM conversations
     WHERE connection_id=ANY($1::uuid[]) AND peer_identity=$2 AND status<>'archived' AND deleted_at IS NULL
       AND ($3::uuid IS NULL OR contact_id IS NULL OR contact_id=$3)
     ORDER BY connection_id`, [ids, peer, identity?.contact_id ?? null],
  );
  return { phone: '+' + peer, contactId: identity?.contact_id ?? null, conversations: threads.rows };
}

async function resolveContactForSender(
  sql: SqlExecutor, tenantId: string, connectionId: string, peer: string,
  conversationId: string, matchedId: string | null, displayName: string | null,
): Promise<string> {
  const existing = await sql.query<{ id: string }>(
    `SELECT i.contact_id::text AS id FROM contact_identities i JOIN contacts c ON c.id=i.contact_id
     WHERE i.scope_id=$1 AND i.kind='whatsapp' AND i.external_id IN ($2,'+' || $2)
       AND i.valid_to IS NULL AND c.deleted_at IS NULL
     UNION
     SELECT c.id::text FROM conversations v JOIN contacts c ON c.id=v.contact_id
     WHERE v.id=$3 AND c.deleted_at IS NULL`, [connectionId, peer, conversationId],
  );
  const candidates = new Set(existing.rows.map((row) => row.id));
  if (matchedId !== null) candidates.add(matchedId);
  const conflict = () => new ApiHttpError(409, 'contact_identity_conflict', 'The selected sender already links this number to a different contact.');
  if (candidates.size > 1) throw conflict();
  let contactId = [...candidates][0];
  if (contactId === undefined) {
    const name = displayName?.trim() ?? peer;
    contactId = requireRow((await sql.query<{ id: string }>(
      'INSERT INTO contacts (tenant_id,display_name,search_name) VALUES ($1,$2,$3) RETURNING id::text',
      [tenantId, name, normalizeSearchText(name)],
    )).rows, 'CRM contact was not created').id;
  }
  return contactId;
}

async function recordKeyChange(
  sql: SqlExecutor, tenantId: string, actor: string, email: string, id: string,
  action: 'created' | 'revoked', detail: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    `INSERT INTO admin_audit_events (tenant_id,actor_membership,actor_email,action,subject_type,subject_id,detail)
     VALUES ($1,$2,$3,$4,'crm_whatsapp_key',$5,$6::jsonb)`,
    [tenantId, actor, email, `crm_whatsapp_key.${action}`, id, JSON.stringify(detail)],
  );
}
