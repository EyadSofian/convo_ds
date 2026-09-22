import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '../../packages/database/src/index.js';

/**
 * Realistic volume, written directly.
 *
 * A load test against three rows measures nothing: every query plan is a
 * sequential scan on a table that fits in one page, and every index looks
 * unnecessary. The numbers only mean something once the tables are big enough
 * that the planner has to choose.
 *
 * Seeding goes through SQL rather than the API on purpose. There is no
 * contact-creation or conversation-creation endpoint — both come into existence
 * from inbound provider events — and driving a hundred thousand signed webhook
 * deliveries would be measuring the ingress, not the inbox. The rows written
 * here are the same shapes `ChannelNormalizationService` produces.
 *
 * Batched inserts with `unnest`, because a hundred thousand round trips would
 * make seeding take longer than the measurement.
 */

export interface SeedVolume {
  readonly conversations: number;
  /** Timeline messages per conversation. */
  readonly messagesPerConversation: number;
  readonly contacts: number;
}

export interface SeedResult {
  readonly connectionId: string;
  readonly conversationIds: readonly string[];
  readonly contactIds: readonly string[];
  readonly elapsedMs: number;
}

/** Related evidence used by the Inbox predicate-plan harness. */
export interface InboxEvidence {
  readonly membershipIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly connectionIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly campaignId: string;
  readonly customFieldIds: Readonly<Record<'text' | 'singleSelect' | 'boolean' | 'date', string>>;
  readonly activityCursor: Readonly<{ id: string; value: string }>;
}

const BATCH = 1_000;

export async function seedVolume(
  pool: Pool,
  admin: Pool,
  tenantId: string,
  volume: SeedVolume,
): Promise<SeedResult> {
  const started = Date.now();
  const connectionId = await ensureConnection(pool, admin, tenantId);

  const conversationIds: string[] = [];
  const contactIds: string[] = [];
  await withTenant(pool, tenantId, async (client) => {
    // Contacts first: the search path is one of the measured scenarios and it
    // needs names with enough variety that a prefix match is not a whole-table
    // match.
    for (let offset = 0; offset < volume.contacts; offset += BATCH) {
      const size = Math.min(BATCH, volume.contacts - offset);
      const names = Array.from({ length: size }, (_unused, index) => personName(offset + index));
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, display_name, search_name)
         SELECT $1, name, lower(name) FROM unnest($2::text[]) AS t(name)
         RETURNING id::text`,
        [tenantId, names],
      );
      contactIds.push(...inserted.rows.map((row) => row.id));
    }

    for (let offset = 0; offset < volume.conversations; offset += BATCH) {
      const size = Math.min(BATCH, volume.conversations - offset);
      const ids = Array.from({ length: size }, () => randomUUID());
      const peers = Array.from({ length: size }, (_unused, index) =>
        `2010000${String(offset + index).padStart(7, '0')}`,
      );
      // A spread of ages, so "recent activity first" is a real ordering rather
      // than every row sharing one timestamp.
      const ages = Array.from({ length: size }, (_unused, index) => (offset + index) % 20_000);
      const statuses = Array.from({ length: size }, (_unused, index) =>
        (offset + index) % 7 === 0 ? 'resolved' : 'open',
      );
      await client.query(
        `INSERT INTO conversations
           (id, tenant_id, connection_id, peer_identity, status, last_inbound_at,
            last_activity_at, waiting_since)
         SELECT t.id, $1, $2, t.peer, t.status,
                now() - make_interval(mins => t.age),
                now() - make_interval(mins => t.age),
                CASE WHEN t.status = 'open' THEN now() - make_interval(mins => t.age) END
           FROM unnest($3::uuid[], $4::text[], $5::int[], $6::text[])
                AS t(id, peer, age, status)`,
        [tenantId, connectionId, ids, peers, ages, statuses],
      );
      conversationIds.push(...ids);
    }

    // The timeline.
    //
    // A normalized `inbound_events` row is not free-standing: it references the
    // `channel_events` row it was made from, which in turn references the
    // webhook receipt that carried it. That chain is the evidence trail the
    // ingress maintains (ADR-0005), and the seeder honours it rather than
    // disabling constraints — a load test against rows the schema would have
    // rejected measures a database this product never runs on.
    if (volume.messagesPerConversation > 0) {
      const receipt = await client.query<{ id: string }>(
        `INSERT INTO webhook_receipts
           (app_id, route_key, body_sha256, body_bytes, signature_valid, outcome, tenant_id, event_count)
         VALUES (NULL, 'load-seed', repeat('c', 64), 0, true, 'routed', $1, 0)
         RETURNING id::text`,
        [tenantId],
      );
      const receiptId = receipt.rows[0]?.id;
      if (receiptId === undefined) {
        throw new Error('seed receipt insert returned no row');
      }

      for (const [position, id] of conversationIds.entries()) {
        const size = volume.messagesPerConversation;
        const peer = `2010000${String(position).padStart(7, '0')}`;
        const keys = Array.from({ length: size }, (_unused, index) => `${id}:${String(index)}`);
        const bodies = Array.from({ length: size }, (_unused, index) =>
          index % 2 === 0 ? 'السلام عليكم، عندي سؤال عن الدورة.' : 'Thank you, that answers it.',
        );
        const ages = Array.from({ length: size }, (_unused, index) => size - index);

        const events = await client.query<{ id: string; dedupe_key: string }>(
          `INSERT INTO channel_events
             (tenant_id, connection_id, receipt_id, dedupe_key, event_type, payload, status, processed_at)
           SELECT $1, $2, $3, t.key, 'message', '{}'::jsonb, 'normalized', now()
             FROM unnest($4::text[]) AS t(key)
           ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
           RETURNING id::text, dedupe_key`,
          [tenantId, connectionId, receiptId, keys],
        );
        if (events.rows.length === 0) {
          continue;
        }
        const order = new Map(keys.map((key, index) => [key, index]));
        const eventIds = events.rows.map((row) => row.id);
        const positions = events.rows.map((row) => order.get(row.dedupe_key) ?? 0);

        await client.query(
          `INSERT INTO inbound_events
             (tenant_id, connection_id, event_id, kind, provider_message_id,
              peer_identity, asset_identity, content_type, text_body, occurred_at, observed_at)
           SELECT $1, $2, t.event_id, 'message', 'wamid.' || t.event_id::text,
                  $3, $4, 'text', t.body,
                  now() - make_interval(mins => t.age), now() - make_interval(mins => t.age)
             FROM unnest($5::uuid[], $6::text[], $7::int[]) AS t(event_id, body, age)`,
          [
            tenantId,
            connectionId,
            peer,
            connectionId,
            eventIds,
            positions.map((index) => bodies[index] ?? ''),
            positions.map((index) => ages[index] ?? 0),
          ],
        );
      }
    }

    // Without this the planner is working from statistics taken when every
    // table was empty, and every measurement below would be of the wrong plan.
    await client.query('ANALYZE');
  });

  return { connectionId, conversationIds, contactIds, elapsedMs: Date.now() - started };
}

/**
 * Adds deterministic, non-empty relation tables to the existing volume seed.
 *
 * The identities themselves are random database keys, but every assignment is
 * selected by its stable row position. That makes predicate selectivity (rather
 * than an incidental UUID order) repeatable on every scratch database.
 */
export async function seedInboxEvidence(
  pool: Pool,
  admin: Pool,
  tenantId: string,
  seed: SeedResult,
): Promise<InboxEvidence> {
  const membershipIds = Array.from({ length: 16 }, () => randomUUID());
  const userIds = Array.from({ length: 16 }, () => randomUUID());
  const teamIds = Array.from({ length: 6 }, () => randomUUID());
  const labelIds = Array.from({ length: 24 }, () => randomUUID());
  const extraConnections = [
    { id: randomUUID(), appId: randomUUID(), provider: 'meta', kind: 'messenger', name: 'Performance Messenger' },
    { id: randomUUID(), appId: randomUUID(), provider: 'meta', kind: 'instagram', name: 'Performance Instagram' },
    { id: randomUUID(), appId: randomUUID(), provider: 'web_chat', kind: 'web_chat', name: 'Performance Web Chat' },
  ] as const;
  const customFieldIds = { text: randomUUID(), singleSelect: randomUUID(), boolean: randomUUID(), date: randomUUID() };
  const roleId = randomUUID();
  const campaignId = randomUUID();
  const revisionId = randomUUID();
  const snapshotId = randomUUID();
  const executionId = randomUUID();

  await admin.query(
    `INSERT INTO users (id,email,status)
     SELECT id, email, 'active'
       FROM unnest($1::uuid[], $2::citext[]) AS t(id,email)`,
    [userIds, userIds.map((_, index) => `performance-agent-${String(index + 1)}@convo.test`)],
  );
  await admin.query(
    `INSERT INTO channel_apps (id,provider,external_app_id,secret_ref,secret_fingerprint,verify_token_hash,graph_version)
     SELECT id, provider, external_app_id, 'PERF_APP', repeat('a',64), repeat('b',64), 'v21.0'
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id,provider,external_app_id)`,
    [extraConnections.map((connection) => connection.appId), extraConnections.map((connection) => connection.provider), extraConnections.map((connection, index) => `perf-app-${String(index + 1)}-${connection.kind}`)],
  );

  return withTenant(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO roles (id,tenant_id,key,name,is_builtin) VALUES ($1,$2,'performance_reader','Performance reader',false)`, [roleId, tenantId]);
    await client.query(
      `INSERT INTO memberships (id,tenant_id,user_id,role_id,status)
       SELECT membership_id,$1,user_id,$2,'active'
         FROM unnest($3::uuid[], $4::uuid[]) AS t(membership_id,user_id)`,
      [tenantId, roleId, membershipIds, userIds],
    );
    await client.query(
      `INSERT INTO teams (id,tenant_id,name)
       SELECT id,$1,name FROM unnest($2::uuid[], $3::text[]) AS t(id,name)`,
      [tenantId, teamIds, teamIds.map((_, index) => `Performance team ${String(index + 1)}`)],
    );
    await client.query(
      `INSERT INTO team_members (tenant_id,team_id,membership_id)
       SELECT $1, ($2::uuid[])[(position - 1) % cardinality($2::uuid[]) + 1], membership_id
         FROM unnest($3::uuid[]) WITH ORDINALITY AS t(membership_id,position)`,
      [tenantId, teamIds, membershipIds],
    );
    await client.query(
      `INSERT INTO channel_connections (id,tenant_id,app_id,kind,external_asset_id,display_name,status)
       SELECT id,$1,app_id,kind,'perf-asset-' || kind,name,'healthy'
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[]) AS t(id,app_id,kind,name)`,
      [tenantId, extraConnections.map((connection) => connection.id), extraConnections.map((connection) => connection.appId), extraConnections.map((connection) => connection.kind), extraConnections.map((connection) => connection.name)],
    );
    const connectionIds = [seed.connectionId, ...extraConnections.map((connection) => connection.id)];
    const conversationIds = seed.conversationIds;
    const contactIds = seed.contactIds;
    await client.query(
      `UPDATE conversations AS c
          SET connection_id = input.connection_id,
              contact_id = input.contact_id,
              team_id = input.team_id,
              assignee_membership_id = input.membership_id
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[])
              AS input(conversation_id,connection_id,contact_id,team_id,membership_id)
        WHERE c.id = input.conversation_id`,
      [
        conversationIds,
        conversationIds.map((_, index) => connectionIds[index % connectionIds.length]!),
        conversationIds.map((_, index) => contactIds[index % contactIds.length]!),
        conversationIds.map((_, index) => teamIds[index % teamIds.length]!),
        conversationIds.map((_, index) => membershipIds[index % membershipIds.length]!),
      ],
    );
    await client.query(
      `INSERT INTO labels (id,tenant_id,name,color,state)
       SELECT id,$1,name,color,'active'
         FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(id,name,color)`,
      [tenantId, labelIds, labelIds.map((_, index) => index === 0 ? 'VIP' : index === 1 ? 'Hot Lead' : `Performance label ${String(index + 1)}`), labelIds.map((_, index) => `#${(0x2255aa + index * 131).toString(16).slice(-6)}`)],
    );
    const labelConversationIds: string[] = [];
    const assignedLabelIds: string[] = [];
    for (const [index, conversationId] of conversationIds.entries()) {
      if (index % 5 === 0) { labelConversationIds.push(conversationId); assignedLabelIds.push(labelIds[0]!); }
      if (index % 7 === 0) { labelConversationIds.push(conversationId); assignedLabelIds.push(labelIds[1]!); }
      if (index % 11 === 0) { labelConversationIds.push(conversationId); assignedLabelIds.push(labelIds[2]!); }
      if (index % 13 === 0) { labelConversationIds.push(conversationId); assignedLabelIds.push(labelIds[3]!); }
    }
    await client.query(
      `INSERT INTO conversation_labels (tenant_id,conversation_id,label_id,assigned_by_membership_id)
       SELECT $1,conversation_id,label_id,$2
         FROM unnest($3::uuid[], $4::uuid[]) AS t(conversation_id,label_id)`,
      [tenantId, membershipIds[0], labelConversationIds, assignedLabelIds],
    );
    const readConversationIds: string[] = [];
    const readThrough: string[] = [];
    for (const [index, conversationId] of conversationIds.entries()) {
      if (index % 10 < 3) continue;
      readConversationIds.push(conversationId);
      readThrough.push(index % 10 === 3 ? new Date(0).toISOString() : new Date(Date.now() + 60_000).toISOString());
    }
    await client.query(
      `INSERT INTO conversation_reads (tenant_id,conversation_id,membership_id,read_through)
       SELECT $1,conversation_id,$2,read_through::timestamptz
         FROM unnest($3::uuid[], $4::text[]) AS t(conversation_id,read_through)`,
      [tenantId, membershipIds[0], readConversationIds, readThrough],
    );
    await client.query(
      `INSERT INTO custom_fields (id,tenant_id,target,key,name,type,options,state)
       VALUES
         ($1,$5,'conversation','performance_text','Performance text','text','[]','active'),
         ($2,$5,'conversation','performance_segment','Performance segment','single_select','["gold","silver","bronze"]','active'),
         ($3,$5,'conversation','performance_flag','Performance flag','boolean','[]','active'),
         ($4,$5,'conversation','performance_date','Performance date','date','[]','active')`,
      [customFieldIds.text, customFieldIds.singleSelect, customFieldIds.boolean, customFieldIds.date, tenantId],
    );
    await client.query(
      `INSERT INTO conversation_custom_field_values (tenant_id,conversation_id,field_id,value_json,search_value,updated_by_membership_id)
       SELECT $1,conversation_id,$2,to_jsonb('segment-' || (position % 20)::text),'segment-' || (position % 20)::text,$3
         FROM unnest($4::uuid[]) WITH ORDINALITY AS t(conversation_id,position)`,
      [tenantId, customFieldIds.text, membershipIds[0], conversationIds],
    );
    await client.query(
      `INSERT INTO conversation_custom_field_values (tenant_id,conversation_id,field_id,value_json,search_value,updated_by_membership_id)
       SELECT $1,conversation_id,$2,to_jsonb(CASE position % 3 WHEN 0 THEN 'gold' WHEN 1 THEN 'silver' ELSE 'bronze' END),CASE position % 3 WHEN 0 THEN 'gold' WHEN 1 THEN 'silver' ELSE 'bronze' END,$3
         FROM unnest($4::uuid[]) WITH ORDINALITY AS t(conversation_id,position)`,
      [tenantId, customFieldIds.singleSelect, membershipIds[0], conversationIds],
    );
    await client.query(
      `INSERT INTO conversation_custom_field_values (tenant_id,conversation_id,field_id,value_json,search_value,updated_by_membership_id)
       SELECT $1,conversation_id,$2,to_jsonb((position % 2) = 0),CASE WHEN position % 2 = 0 THEN 'true' ELSE 'false' END,$3
         FROM unnest($4::uuid[]) WITH ORDINALITY AS t(conversation_id,position)`,
      [tenantId, customFieldIds.boolean, membershipIds[0], conversationIds],
    );
    await client.query(
      `INSERT INTO conversation_custom_field_values (tenant_id,conversation_id,field_id,value_json,search_value,updated_by_membership_id)
       SELECT $1,conversation_id,$2,to_jsonb(('2026-01-' || lpad(((position % 28) + 1)::text,2,'0'))),('2026-01-' || lpad(((position % 28) + 1)::text,2,'0')),$3
         FROM unnest($4::uuid[]) WITH ORDINALITY AS t(conversation_id,position)`,
      [tenantId, customFieldIds.date, membershipIds[0], conversationIds],
    );
    const outboundIds: string[] = [];
    const outboundConversationIds: string[] = [];
    for (const [index, conversationId] of conversationIds.entries()) {
      if (index % 10 === 0 || index % 10 === 5) continue;
      outboundIds.push(randomUUID());
      outboundConversationIds.push(conversationId);
    }
    await client.query(
      `INSERT INTO outbound_messages (id,tenant_id,connection_id,peer_identity,author_membership,message_type,text_body,client_message_id,command_state,created_at)
       SELECT t.id,$1,c.connection_id,c.peer_identity,
              CASE WHEN t.position % 10 = 3 THEN NULL ELSE $2::uuid END,
              'text','Performance reply','performance-' || t.id::text,'queued',
              CASE WHEN t.position % 10 = 1 THEN now() - interval '5 minutes' ELSE now() END
         FROM unnest($3::uuid[], $4::uuid[]) WITH ORDINALITY AS t(id,conversation_id,position)
         JOIN conversations c ON c.id = t.conversation_id`,
      [tenantId, membershipIds[0], outboundIds, outboundConversationIds],
    );
    await client.query(
      `INSERT INTO conversation_participants (tenant_id,conversation_id,membership_id)
       SELECT $1,conversation_id,$2 FROM unnest($3::uuid[]) AS t(conversation_id)`,
      [tenantId, membershipIds[0], conversationIds.filter((_, index) => index % 4 === 0)],
    );

    const campaignIndexes = outboundConversationIds.slice(0, 1_200);
    const campaignRecipientIds = campaignIndexes.map(() => randomUUID());
    const identityIds = campaignIndexes.map(() => randomUUID());
    const campaignOutboundIds = outboundIds.slice(0, campaignIndexes.length);
    const byConversation = new Map(conversationIds.map((id, index) => [id, index]));
    await client.query(
      `INSERT INTO campaigns (id,tenant_id,name,connection_id,control_state)
       VALUES ($1,$2,'Performance campaign',$3,'running')`,
      [campaignId, tenantId, connectionIds[0]],
    );
    await client.query(
      `INSERT INTO campaign_revisions (id,tenant_id,campaign_id,revision,variables,audience_filter,content,schedule,revision_hash)
       VALUES ($1,$2,$3,1,'{}','{}','{}','{}',repeat('c',64))`,
      [revisionId, tenantId, campaignId],
    );
    await client.query(`UPDATE campaigns SET current_revision_id=$1 WHERE id=$2`, [revisionId, campaignId]);
    await client.query(
      `INSERT INTO audience_snapshots (id,tenant_id,campaign_id,revision_id,source,counts)
       VALUES ($1,$2,$3,$4,'{}','{}')`,
      [snapshotId, tenantId, campaignId, revisionId],
    );
    await client.query(
      `INSERT INTO campaign_executions (id,tenant_id,campaign_id,revision_id,audience_snapshot_id,state)
       VALUES ($1,$2,$3,$4,$5,'running')`,
      [executionId, tenantId, campaignId, revisionId, snapshotId],
    );
    await client.query(
      `INSERT INTO contact_identities (id,tenant_id,contact_id,kind,scope_id,external_id)
       SELECT identity_id,$1,contact_id,kind,connection_id,peer_identity
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::text[])
              AS t(identity_id,contact_id,kind,connection_id,peer_identity)`,
      [
        tenantId,
        identityIds,
        campaignIndexes.map((conversationId) => contactIds[byConversation.get(conversationId)!]!),
        campaignIndexes.map((conversationId) => ['whatsapp', 'messenger', 'instagram', 'web_chat'][byConversation.get(conversationId)! % 4]!),
        campaignIndexes.map((conversationId) => connectionIds[byConversation.get(conversationId)! % connectionIds.length]!),
        campaignIndexes.map((conversationId) => `2010000${String(byConversation.get(conversationId)!).padStart(7, '0')}`),
      ],
    );
    await client.query(
      `INSERT INTO campaign_recipients (id,tenant_id,execution_id,contact_id,identity_id,rendered_variables,snapshot_eligibility,state,command_id)
       SELECT recipient_id,$1,$2,contact_id,identity_id,'{}','{}','accepted',outbound_id
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[]) AS t(recipient_id,contact_id,identity_id,outbound_id)`,
      [tenantId, executionId, campaignRecipientIds, campaignIndexes.map((conversationId) => contactIds[byConversation.get(conversationId)!]!), identityIds, campaignOutboundIds],
    );
    await client.query(
      `INSERT INTO campaign_conversation_attributions (tenant_id,campaign_id,execution_id,recipient_id,outbound_message_id,connection_id,peer_identity,sent_at,conversation_id,bound_at)
       SELECT $1,$2,$3,recipient_id,outbound_id,c.connection_id,c.peer_identity,now(),conversation_id,now()
         FROM unnest($4::uuid[], $5::uuid[], $6::uuid[]) AS t(recipient_id,outbound_id,conversation_id)
         JOIN conversations c ON c.id=t.conversation_id`,
      [tenantId, campaignId, executionId, campaignRecipientIds, campaignOutboundIds, campaignIndexes],
    );
    await client.query('ANALYZE');
    const cursor = await client.query<{ id: string; last_activity_at: Date }>(
      `SELECT id::text, last_activity_at
         FROM conversations
        WHERE status <> 'archived'
        ORDER BY last_activity_at DESC, id DESC
        OFFSET 49 LIMIT 1`,
    );
    const cursorRow = cursor.rows[0];
    if (cursorRow === undefined) throw new Error('performance seed did not create an activity cursor');
    return {
      membershipIds, teamIds, connectionIds, labelIds, campaignId, customFieldIds,
      activityCursor: { id: cursorRow.id, value: cursorRow.last_activity_at.toISOString() },
    };
  });
}

/**
 * One connected channel for the company, created if it is not already there.
 *
 * The `channel_apps` row goes through an admin connection because the runtime
 * role deliberately has no write grant on it: a provider app registration is an
 * installation-level act, not something a tenant request may perform. That the
 * seeder had to be told so is the grant working.
 */
async function ensureConnection(pool: Pool, admin: Pool, tenantId: string): Promise<string> {
  const appId = randomUUID();
  await admin.query(
    `INSERT INTO channel_apps
       (id, provider, external_app_id, secret_ref, secret_fingerprint, verify_token_hash, graph_version)
     VALUES ($1, 'meta', $2, 'LOAD_TEST_APP', repeat('a', 64), repeat('b', 64), 'v21.0')
     ON CONFLICT (provider, external_app_id) DO NOTHING`,
    [appId, `load-${appId}`],
  );
  return withTenant(pool, tenantId, async (client) => {
    const existing = await client.query<{ id: string }>(
      'SELECT id::text FROM channel_connections WHERE tenant_id = $1 LIMIT 1',
      [tenantId],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      return found.id;
    }
    const created = await client.query<{ id: string }>(
      `INSERT INTO channel_connections
         (tenant_id, app_id, kind, external_asset_id, display_name, status)
       VALUES ($1, $2, 'whatsapp', $3, 'Load test number', 'healthy')
       RETURNING id::text`,
      [tenantId, appId, `1555${Date.now()}`],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error('channel connection insert returned no row');
    }
    return row.id;
  });
}

const FIRST = ['Nadia', 'Omar', 'Huda', 'Sami', 'Layla', 'Karim', 'Rania', 'Tarek', 'Dina', 'Yusuf'];
const LAST = ['Hassan', 'Khaled', 'Salem', 'Mansour', 'Aziz', 'Farid', 'Nabil', 'Sabry'];

/** Varied enough that a prefix search is not a whole-table match. */
function personName(index: number): string {
  const first = FIRST[index % FIRST.length] ?? 'Nadia';
  const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Hassan';
  return `${first} ${last} ${String(index)}`;
}
