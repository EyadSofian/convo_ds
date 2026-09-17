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
  readonly elapsedMs: number;
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
  await withTenant(pool, tenantId, async (client) => {
    // Contacts first: the search path is one of the measured scenarios and it
    // needs names with enough variety that a prefix match is not a whole-table
    // match.
    for (let offset = 0; offset < volume.contacts; offset += BATCH) {
      const size = Math.min(BATCH, volume.contacts - offset);
      const names = Array.from({ length: size }, (_unused, index) => personName(offset + index));
      await client.query(
        `INSERT INTO contacts (tenant_id, display_name, search_name)
         SELECT $1, name, lower(name) FROM unnest($2::text[]) AS t(name)`,
        [tenantId, names],
      );
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

  return { connectionId, conversationIds, elapsedMs: Date.now() - started };
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
