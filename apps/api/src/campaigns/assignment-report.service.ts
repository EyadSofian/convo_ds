import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { OpaqueCursorCodec } from '../pagination.js';
import { API_CONFIG } from '../tokens.js';
import { readableScope } from '../conversations/inbox-query-compiler.js';
import { scopedReportableAgents } from '../conversations/supervisor-directory.js';
import { parseOperationalReportFilters, validateReportEntities, type OperationalReportFilters } from './operational-report.service.js';

export interface AssignmentReportQuery {
  readonly filters: OperationalReportFilters;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface AssignmentReportRow {
  readonly id: string;
  readonly timestamp: string;
  readonly conversationId: string;
  readonly customer: string | null;
  readonly action: 'claim' | 'assign' | 'handoff';
  readonly previousAssignee: { readonly membershipId: string; readonly displayName: string } | null;
  readonly assignedTo: { readonly membershipId: string; readonly displayName: string };
  readonly actor: { readonly membershipId: string; readonly displayName: string } | null;
}

export interface AssignmentReportPage {
  readonly items: readonly AssignmentReportRow[];
  readonly nextCursor: string | null;
}

@Injectable()
export class AssignmentReportService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  page(session: AuthenticatedSession, tenantId: string, query: AssignmentReportQuery): Promise<AssignmentReportPage> {
    return this.authorization.authorizedOwnReport(session, tenantId, async ({ sql, principal }) => {
      const agents = await scopedReportableAgents(sql, principal);
      await validateReportEntities(sql, principal, query.filters, agents.map((agent) => agent.membershipId));
      const binding = assignmentBinding(tenantId, query.filters);
      const codec = new OpaqueCursorCodec(this.config.secrets.idempotencyHash);
      const after = decodeCursor(codec, query.cursor, binding);
      const values: unknown[] = [tenantId, query.filters.fromAt, query.filters.toExclusiveAt,
        query.filters.agentId, query.filters.teamId, query.filters.channel, query.filters.connectionId,
        query.filters.labelId, query.filters.campaignId, query.filters.priority, query.filters.status];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const dimensions = `($6::text IS NULL OR n.kind=$6::text)
        AND ($7::uuid IS NULL OR c.connection_id=$7::uuid)
        AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=$8::uuid AND cl.removed_at IS NULL))
        AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=$9::uuid))
        AND ($10::text IS NULL OR c.priority=$10::text)
        AND ($11::text IS NULL OR c.status=$11::text)`;
      const conditions = [
        'a.tenant_id=$1::uuid', scope,
        "a.act IN ('claim','assign','handoff')",
        '($2::timestamptz IS NULL OR a.at >= $2::timestamptz)',
        '($3::timestamptz IS NULL OR a.at < $3::timestamptz)',
        '($4::uuid IS NULL OR a.to_value=$4::text)',
        '($5::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members target_team WHERE target_team.membership_id=a.to_value::uuid AND target_team.team_id=$5::uuid))',
        dimensions,
      ];
      if (after !== null) {
        conditions.push(`(a.at,a.id) < (${add(after.value)}::timestamptz,${add(after.id)}::uuid)`);
      }
      const limit = add(query.limit + 1);
      const rows = await sql.query<AssignmentReportRow & { cursor_at: string }>(`
        SELECT a.id::text AS id,a.at::text AS timestamp,a.at::text AS cursor_at,
               c.id::text AS "conversationId",customer.display_name AS customer,a.act AS action,
               CASE WHEN previous_member.id IS NULL THEN NULL ELSE jsonb_build_object('membershipId',previous_member.id::text,'displayName',previous_member.display_name) END AS "previousAssignee",
               jsonb_build_object('membershipId',assigned_member.id::text,'displayName',assigned_member.display_name) AS "assignedTo",
               CASE WHEN a.actor_membership_id IS NULL THEN NULL ELSE jsonb_build_object('membershipId',actor_member.id::text,'displayName',actor_member.display_name) END AS actor
          FROM conversation_audit a
          JOIN conversations c ON c.tenant_id=a.tenant_id AND c.id=a.conversation_id
          JOIN channel_connections n ON n.tenant_id=c.tenant_id AND n.id=c.connection_id
          LEFT JOIN contacts customer ON customer.tenant_id=c.tenant_id AND customer.id=c.contact_id
          LEFT JOIN memberships previous_member ON previous_member.tenant_id=a.tenant_id AND previous_member.id=a.from_value::uuid
          JOIN memberships assigned_member ON assigned_member.tenant_id=a.tenant_id AND assigned_member.id=a.to_value::uuid
          LEFT JOIN memberships actor_member ON actor_member.tenant_id=a.tenant_id AND actor_member.id=a.actor_membership_id
         WHERE ${conditions.join('\n AND ')}
         ORDER BY a.at DESC,a.id DESC LIMIT ${limit}::int`, values);
      const page = rows.rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id, timestamp: row.timestamp, conversationId: row.conversationId, customer: row.customer,
          action: row.action, previousAssignee: row.previousAssignee, assignedTo: row.assignedTo, actor: row.actor,
        })),
        nextCursor: rows.rows.length > query.limit && last !== undefined
          ? codec.encode(binding, { value: last.cursor_at, id: last.id }, 900)
          : null,
      };
    });
  }
}

export function parseAssignmentReportQuery(query: unknown): AssignmentReportQuery {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw invalidQuery();
  const raw = query as Record<string, unknown>;
  const allowed = new Set(['from','to','agentId','teamId','channel','connectionId','labelId','campaignId','priority','status','cursor','limit']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidQuery();
  const filterInput: Record<string, unknown> = {};
  for (const key of ['from','to','agentId','teamId','channel','connectionId','labelId','campaignId','priority','status']) {
    if (raw[key] !== undefined) filterInput[key] = raw[key];
  }
  const cursor = raw['cursor'] === undefined || raw['cursor'] === '' ? null : raw['cursor'];
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096)) throw invalidQuery();
  let limit = 50;
  if (raw['limit'] !== undefined && raw['limit'] !== '') {
    const parsed = typeof raw['limit'] === 'number' ? raw['limit'] : typeof raw['limit'] === 'string' && /^\d+$/.test(raw['limit']) ? Number(raw['limit']) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw invalidQuery();
    limit = parsed;
  }
  return { filters: parseOperationalReportFilters(filterInput), cursor, limit };
}

function assignmentBinding(tenantId: string, filters: OperationalReportFilters) {
  const stableFilters = {
    from: filters.fromAt?.toISOString() ?? null, to: filters.toExclusiveAt?.toISOString() ?? null,
    agentId: filters.agentId, teamId: filters.teamId, channel: filters.channel, connectionId: filters.connectionId,
    labelId: filters.labelId, campaignId: filters.campaignId, priority: filters.priority, status: filters.status,
  };
  return { tenantId, filterHash: createHash('sha256').update(JSON.stringify(stableFilters)).digest('hex'), sort: 'assignments_at_desc' };
}

function decodeCursor(codec: OpaqueCursorCodec, cursor: string | null, binding: ReturnType<typeof assignmentBinding>) {
  if (cursor === null) return null;
  const result = codec.decode(cursor, binding);
  if (result.status === 'rejected') throw new ApiHttpError(400, result.code, result.message);
  return result.after;
}

function invalidQuery(): ApiHttpError { return new ApiHttpError(400, 'validation_failed', 'The assignment report query is invalid.'); }
