import { describe, expect, it } from 'vitest';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig, type InboxQuery, type Principal } from '../../packages/domain/src/index.js';
import { compileInboxQuery } from '../../apps/api/src/conversations/inbox-query-compiler.js';
import { conversationEventBoundary, conversationUnrepliedPredicate, qualifyingHumanOutbound } from '../../apps/api/src/conversations/event-boundary.js';
import {
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
  superuserPool,
} from '../support/scratch.js';
import { seedInboxEvidence, seedVolume, type InboxEvidence } from './seed.js';

/**
 * `EXPLAIN ANALYZE` on the queries the load run showed to be expensive.
 *
 * This exists because a load test tells you *that* something is slow and never
 * *why*. The first attempt at fixing contact search added a trigram index on the
 * strength of a plausible-sounding argument about leading wildcards, and it
 * changed the measured latency by under 3% — which is the difference between a
 * diagnosis and a guess that happened to sound like one.
 *
 * The plans printed here are the diagnosis. They run against the same seeded
 * volume the load run uses, so the numbers are comparable.
 */

const TENANT_SQL = `SELECT id::text FROM tenants LIMIT 1`;

describe('query plans at volume', () => {
  it('prints the plan for contact search and for the conversation list', async () => {
    const names = await createScratchDatabase('convo_explain');
    await migrateScratch(names);
    const pool = scratchRuntimePool(names, 4);
    const admin = superuserPool(names.database, 2);

    try {
      // The tenant insert trips a trigger without it.
      await applyInstallationConfig(asExecutor(pool), 'saas');
      // A company to own the rows. Created directly: this file is about plans,
      // not about the bootstrap path.
      const tenant = await admin.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, status) VALUES ('Explain', 'explain', 'active')
         RETURNING id::text`,
      );
      const tenantId = tenant.rows[0]?.id ?? '';
      expect(tenantId).not.toBe('');

      const seeded = await seedVolume(pool, admin, tenantId, {
        conversations: 10_000,
        contacts: 10_000,
        messagesPerConversation: 2,
      });
      const evidence = await seedInboxEvidence(pool, admin, tenantId, seeded);

      const plans: string[] = [];
      await withTenant(pool, tenantId, async (client) => {
        const check = await client.query<{ id: string }>(TENANT_SQL);
        expect(check.rowCount).toBe(1);

        for (const [label, sql, params] of queries(seeded, evidence)) {
          const explained = await client.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (ANALYZE, BUFFERS, COSTS) ${sql}`,
            params,
          );
          plans.push(
            `\n=== ${label} ===\n${explained.rows.map((row) => row['QUERY PLAN']).join('\n')}`,
          );
        }
      });

      process.stdout.write(`${plans.join('\n')}\n`);
      expect(plans.length).toBeGreaterThan(0);
    } finally {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 600_000);
});

/**
 * The queries, reduced to the shape the service actually issues.
 *
 * Tenant-wide, scoped, and own-access principals are all compiled here. The
 * plan has to include the authorization predicate before pagination: applying
 * it after `LIMIT` can make a legal Inbox page look randomly short.
 */
function queries(seeded: { readonly conversationIds: readonly string[] }, evidence: InboxEvidence): readonly [string, string, unknown[]][] {
  const tenantPrincipal: Principal = {
    membershipId: evidence.membershipIds[0]!, membershipStatus: 'active', tenantStatus: 'active',
    grants: { 'conversation.read': 'tenant' }, scopes: [], delegationCeiling: null,
  };
  const scopedPrincipal: Principal = {
    membershipId: evidence.membershipIds[1]!, membershipStatus: 'active', tenantStatus: 'active',
    grants: { 'conversation.read': 'scoped' }, scopes: [{ type: 'team', id: evidence.teamIds[0]! }], delegationCeiling: null,
  };
  const inboxScopedPrincipal: Principal = {
    membershipId: evidence.membershipIds[1]!, membershipStatus: 'active', tenantStatus: 'active',
    grants: { 'conversation.read': 'scoped' }, scopes: [{ type: 'inbox', id: evidence.connectionIds[0]! }], delegationCeiling: null,
  };
  const ownPrincipal: Principal = {
    membershipId: evidence.membershipIds[0]!, membershipStatus: 'active', tenantStatus: 'active',
    grants: { 'conversation.read': 'own' }, scopes: [{ type: 'team', id: evidence.teamIds[0]! }], delegationCeiling: null,
  };
  const customFields = new Map([
    [evidence.customFieldIds.text, { id: evidence.customFieldIds.text, type: 'text' as const }],
    [evidence.customFieldIds.singleSelect, { id: evidence.customFieldIds.singleSelect, type: 'single_select' as const }],
    [evidence.customFieldIds.boolean, { id: evidence.customFieldIds.boolean, type: 'boolean' as const }],
    [evidence.customFieldIds.date, { id: evidence.customFieldIds.date, type: 'date' as const }],
  ]);
  const inbox = (
    label: string,
    query: InboxQuery,
    principal: Principal = tenantPrincipal,
    cursor: Readonly<{ id: string; value: string }> | null = null,
  ): [string, string, unknown[]] => {
    const compiled = compileInboxQuery(query, principal, customFields);
    const params = [...compiled.params];
    const add = (value: unknown): string => { params.push(value); return `$${String(params.length)}`; };
    const cursorSql = cursor === null ? '' : keysetCursor(query.sort, cursor, add);
    const viewer = add(principal.membershipId);
    const limit = add(51);
    return [
      label,
      `SELECT c.id::text, c.status, c.priority, c.last_activity_at
         FROM conversations c
         JOIN channel_connections n ON n.id = c.connection_id
         LEFT JOIN conversation_reads r ON r.conversation_id=c.id AND r.membership_id=${viewer}::uuid
        WHERE ${compiled.where}${cursorSql}
        ORDER BY ${compiled.order}
        LIMIT ${limit}::integer`,
      params,
    ];
  };
  const base: InboxQuery = { queue: 'all', filters: [], search: null, sort: 'activity_desc', cursor: null, limit: 50 };
  const page = (sort: 'activity_desc' | 'created_desc' | 'priority_desc' | 'waiting_desc', depth: 'middle' | 'late') =>
    inbox(
      `Inbox, ${sort} — ${depth} cursor`,
      { ...base, sort },
      tenantPrincipal,
      evidence.paginationCursors[sort][depth],
    );
  const assignmentPage = (depth: 'first' | 'middle' | 'late'): [string, string, unknown[]] => {
    const cursor = depth === 'first' ? null : evidence.assignmentCursors[depth];
    return [
      `report assignments — ${depth} page`,
      `SELECT a.id::text,a.at,c.id::text AS conversation_id,c.peer_identity,a.from_value,a.to_value
         FROM conversation_audit a JOIN conversations c ON c.id=a.conversation_id
        WHERE a.act IN ('claim','assign','handoff')
          AND ($1::timestamptz IS NULL OR (a.at<$1::timestamptz OR (a.at=$1::timestamptz AND a.id<$2::uuid)))
        ORDER BY a.at DESC,a.id DESC LIMIT 51`,
      [cursor?.at ?? null,cursor?.id ?? null],
    ];
  };
  return [
    [
      'report overview — current backlog and period creation volume',
      `SELECT count(*) FILTER (WHERE c.status IN ('open','pending','snoozed'))::int AS current_active,
              count(*) FILTER (WHERE c.assignee_membership_id IS NULL AND c.status IN ('open','pending','snoozed'))::int AS unassigned,
              count(*) FILTER (WHERE c.created_at>=now()-interval '30 days')::int AS new_in_period
         FROM conversations c JOIN channel_connections n ON n.id=c.connection_id`,
      [],
    ],
    [
      'report agents — zero-inclusive directory plus activity',
      `WITH current_work AS (SELECT assignee_membership_id,count(*)::int AS active FROM conversations
                               WHERE status IN ('open','pending','snoozed') GROUP BY assignee_membership_id),
            authored AS (SELECT o.author_membership,count(*)::int AS messages FROM outbound_messages o
                           JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
                          WHERE ${qualifyingHumanOutbound('o')} GROUP BY o.author_membership)
       SELECT m.id,coalesce(w.active,0)::int,coalesce(a.messages,0)::int FROM memberships m
        LEFT JOIN current_work w ON w.assignee_membership_id=m.id LEFT JOIN authored a ON a.author_membership=m.id
        WHERE m.id=$1::uuid`,
      [evidence.membershipIds[0]],
    ],
    [
      'report agent detail — current active workload',
      `SELECT c.id::text,c.status,c.priority FROM conversations c
        WHERE c.assignee_membership_id=$1::uuid AND c.status IN ('open','pending','snoozed')`,
      [evidence.membershipIds[0]],
    ],
    [
      'report teams — current workload by authorized team',
      `SELECT c.team_id,count(*)::int,count(*) FILTER (WHERE c.status='open')::int
         FROM conversations c JOIN channel_connections n ON n.id=c.connection_id
        WHERE c.team_id=ANY($1::uuid[]) AND c.status IN ('open','pending','snoozed') GROUP BY c.team_id`,
      [evidence.teamIds],
    ],
    [
      'report responses — measured episode timings',
      `SELECT count(*)::int,avg(extract(epoch FROM e.first_response_at-e.first_inbound_at))::float8,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.first_response_at-e.first_inbound_at))::float8
         FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id
        WHERE e.first_inbound_at IS NOT NULL AND e.first_response_at IS NOT NULL`,
      [],
    ],
    [
      'report resolutions — closed episode timings',
      `SELECT count(*)::int,avg(extract(epoch FROM e.closed_at-e.opened_at))::float8,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.closed_at-e.opened_at))::float8
         FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id
        WHERE e.closed_at IS NOT NULL`,
      [],
    ],
    assignmentPage('first'), assignmentPage('middle'), assignmentPage('late'),
    [
      'report channels — operational activity by channel',
      `WITH current_work AS (SELECT n.kind,count(*)::int AS current_active FROM conversations c
                               JOIN channel_connections n ON n.id=c.connection_id
                              WHERE c.status IN ('open','pending','snoozed') GROUP BY n.kind),
            authored AS (SELECT n.kind,count(*)::int AS messages,count(DISTINCT c.id)::int AS handled
                           FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
                           JOIN channel_connections n ON n.id=c.connection_id
                          WHERE ${qualifyingHumanOutbound('o')} GROUP BY n.kind)
       SELECT n.kind,coalesce(w.current_active,0),coalesce(a.messages,0),coalesce(a.handled,0)
         FROM channel_connections n LEFT JOIN current_work w ON w.kind=n.kind LEFT JOIN authored a ON a.kind=n.kind
        GROUP BY n.kind,w.current_active,a.messages,a.handled`,
      [],
    ],
    [
      'supervisor workload — assigned + conversation-bound unreplied',
      `SELECT count(*) FILTER (WHERE c.status IN ('open','pending','snoozed'))::int AS assigned,
              count(*) FILTER (WHERE c.status IN ('open','pending','snoozed') AND ${conversationUnrepliedPredicate('c')})::int AS unreplied
         FROM conversations c
        WHERE c.assignee_membership_id=$1::uuid AND c.status IN ('open','pending','snoozed')`,
      [evidence.membershipIds[0]],
    ],
    [
      'agent human messages — conversation-bound event attribution',
      `SELECT o.author_membership,count(*)::int AS messages
         FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
        WHERE ${qualifyingHumanOutbound('o')} AND o.author_membership=$1::uuid
        GROUP BY o.author_membership`,
      [evidence.membershipIds[0]],
    ],
    [
      'agent handled conversations — distinct conversation ownership',
      `SELECT count(DISTINCT c.id)::int AS handled
         FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
        WHERE ${qualifyingHumanOutbound('o')} AND o.author_membership=$1::uuid`,
      [evidence.membershipIds[0]],
    ],
    [
      'channel performance — bounded human message attribution',
      `SELECT n.kind,count(*)::int AS human_messages,count(DISTINCT c.id)::int AS handled
         FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
         JOIN channel_connections n ON n.id=c.connection_id
        WHERE ${qualifyingHumanOutbound('o')}
        GROUP BY n.kind`,
      [],
    ],
    [
      'contact search — infix LIKE only',
      `SELECT id::text, display_name FROM contacts
        WHERE deleted_at IS NULL AND search_name LIKE '%' || $1 || '%'
        ORDER BY created_at DESC, id LIMIT 200`,
      ['nadia'],
    ],
    [
      'contact search — full list query, tenant reach',
      `SELECT id::text, display_name, attributes, version, created_at
         FROM contacts
        WHERE deleted_at IS NULL
          AND ($1::text IS NULL OR search_name LIKE '%' || $1 || '%')
          AND (cardinality($2::uuid[]) = 0 OR (
            SELECT count(DISTINCT cl.label_id) FROM contact_labels cl
             WHERE cl.contact_id = contacts.id AND cl.removed_at IS NULL
               AND cl.label_id = ANY($2::uuid[])
          ) = cardinality($2::uuid[]))
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM contact_custom_field_values cfv
             WHERE cfv.contact_id = contacts.id AND cfv.field_id = $3
               AND (($5::boolean AND cfv.search_value LIKE '%' || $4 || '%')
                 OR (NOT $5::boolean AND cfv.search_value = $4))
          ))
          AND ($6::text = 'tenant' OR true)
        ORDER BY created_at DESC, id
        LIMIT 200`,
      ['nadia', [], null, '', false, 'tenant'],
    ],
    [
      'contact list — no search term',
      `SELECT id::text, display_name FROM contacts
        WHERE deleted_at IS NULL AND ($1::text IS NULL OR search_name LIKE '%' || $1 || '%')
        ORDER BY created_at DESC, id LIMIT 200`,
      [null],
    ],
    [
      ...inbox('normal Inbox — recent activity', base),
    ],
    inbox('Inbox, created_desc — first page', { ...base, sort: 'created_desc' }),
    inbox('Inbox, priority_desc — first page', { ...base, sort: 'priority_desc' }),
    inbox('Inbox, waiting_desc — first page', { ...base, sort: 'waiting_desc' }),
    page('activity_desc', 'middle'), page('activity_desc', 'late'),
    page('created_desc', 'middle'), page('created_desc', 'late'),
    page('priority_desc', 'middle'), page('priority_desc', 'late'),
    page('waiting_desc', 'middle'), page('waiting_desc', 'late'),
    inbox('scoped read — one team', base, scopedPrincipal),
    inbox('scoped read — one inbox', base, inboxScopedPrincipal),
    inbox('own read — one team', base, ownPrincipal),
    inbox('label — VIP', { ...base, filters: [{ key: 'label_id', operator: 'eq', value: evidence.labelIds[0]! }] }),
    inbox('labels ALL — VIP + Hot Lead', { ...base, filters: [{ key: 'label_id', operator: 'in', value: evidence.labelIds.slice(0, 2) }] }),
    inbox('labels ALL — three labels', { ...base, filters: [{ key: 'label_id', operator: 'in', value: evidence.labelIds.slice(0, 3) }] }),
    inbox('unread — true', { ...base, filters: [{ key: 'unread', operator: 'eq', value: true }] }),
    inbox('unreplied — true', { ...base, filters: [{ key: 'unreplied', operator: 'eq', value: true }] }),
    inbox('unreplied — false', { ...base, filters: [{ key: 'unreplied', operator: 'eq', value: false }] }),
    inbox('agent + open + activity', { ...base, filters: [{ key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }, { key: 'status', operator: 'eq', value: 'open' }] }),
    inbox('team + WhatsApp', { ...base, filters: [{ key: 'team_id', operator: 'eq', value: evidence.teamIds[0]! }, { key: 'channel', operator: 'eq', value: 'whatsapp' }] }),
    inbox('agent + connection', { ...base, filters: [{ key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }, { key: 'connection_id', operator: 'eq', value: evidence.connectionIds[0]! }] }),
    inbox('agent + VIP', { ...base, filters: [{ key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }, { key: 'label_id', operator: 'eq', value: evidence.labelIds[0]! }] }),
    inbox('agent + unreplied', { ...base, filters: [{ key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }, { key: 'unreplied', operator: 'eq', value: true }] }),
    inbox('connection — specific inbox', { ...base, filters: [{ key: 'connection_id', operator: 'eq', value: evidence.connectionIds[1]! }] }),
    inbox('campaign + open', { ...base, filters: [{ key: 'campaign_id', operator: 'eq', value: evidence.campaignId }, { key: 'status', operator: 'eq', value: 'open' }] }),
    inbox('campaign + agent + open', { ...base, filters: [{ key: 'campaign_id', operator: 'eq', value: evidence.campaignId }, { key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }, { key: 'status', operator: 'eq', value: 'open' }] }),
    inbox('campaign + agent + label', { ...base, filters: [{ key: 'campaign_id', operator: 'eq', value: evidence.campaignId }, { key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }, { key: 'label_id', operator: 'eq', value: evidence.labelIds[0]! }] }),
    inbox('campaign + unreplied', { ...base, filters: [{ key: 'campaign_id', operator: 'eq', value: evidence.campaignId }, { key: 'unreplied', operator: 'eq', value: true }] }),
    inbox('custom text — exact', { ...base, filters: [{ key: 'custom_field', fieldId: evidence.customFieldIds.text, operator: 'eq', value: 'segment-1' }] }),
    inbox('custom text — contains', { ...base, filters: [{ key: 'custom_field', fieldId: evidence.customFieldIds.text, operator: 'contains', value: 'segment-1' }] }),
    inbox('custom single select — gold', { ...base, filters: [{ key: 'custom_field', fieldId: evidence.customFieldIds.singleSelect, operator: 'eq', value: 'gold' }] }),
    inbox('custom boolean — true', { ...base, filters: [{ key: 'custom_field', fieldId: evidence.customFieldIds.boolean, operator: 'eq', value: true }] }),
    inbox('custom date — after', { ...base, filters: [{ key: 'custom_field', fieldId: evidence.customFieldIds.date, operator: 'after', value: '2026-01-10' }] }),
    inbox('search — conversation UUID', { ...base, search: seeded.conversationIds[1]! }),
    inbox('search — customer name common', { ...base, search: 'Nadia' }),
    inbox('search — peer identity rare', { ...base, search: '201000000000' }),
    inbox('search — peer identity common', { ...base, search: '2010000' }),
    inbox('customer phone — exact', { ...base, filters: [{ key: 'customer_phone', operator: 'eq', value: '201000000000' }] }),
    inbox('team + unreplied + waiting', { ...base, sort: 'waiting_desc', filters: [{ key: 'team_id', operator: 'eq', value: evidence.teamIds[0]! }, { key: 'unreplied', operator: 'eq', value: true }] }),
    inbox('unread + high + WhatsApp', { ...base, filters: [{ key: 'unread', operator: 'eq', value: true }, { key: 'priority', operator: 'eq', value: 'high' }, { key: 'channel', operator: 'eq', value: 'whatsapp' }] }),
    inbox('two labels ALL + agent', { ...base, filters: [{ key: 'label_id', operator: 'in', value: evidence.labelIds.slice(0, 2) }, { key: 'assigned_agent_id', operator: 'eq', value: evidence.membershipIds[0]! }] }),
  ];
}

function keysetCursor(
  sort: InboxQuery['sort'],
  cursor: Readonly<{ id: string; value: string }>,
  add: (value: unknown) => string,
): string {
  const value = add(cursor.value);
  const id = add(cursor.id);
  if (sort === 'created_desc') return ` AND (c.created_at,c.id)<(${value}::timestamptz,${id}::uuid)`;
  if (sort === 'priority_desc') return ` AND ((CASE c.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END),c.id)<(${value}::integer,${id}::uuid)`;
  if (sort === 'waiting_desc') return ` AND (coalesce(c.waiting_since,'-infinity'::timestamptz),c.id)<(${value}::timestamptz,${id}::uuid)`;
  return ` AND (c.last_activity_at,c.id)<(${value}::timestamptz,${id}::uuid)`;
}
