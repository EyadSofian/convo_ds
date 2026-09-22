import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { readableScope } from '../conversations/inbox-query-compiler.js';
import { scopedReportableAgents } from '../conversations/supervisor-directory.js';
import type { OperationalReportFilters } from './operational-report.service.js';
import { validateReportEntities } from './operational-report.service.js';

export interface TimingAgentRow {
  readonly membershipId: string;
  readonly name: string;
  readonly measured: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
}

export interface TimingChannelRow {
  readonly channel: string;
  readonly measured: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
}

export interface ResponseReport {
  readonly measured: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
  readonly buckets: readonly { readonly bucket: '<5m' | '5–15m' | '15–30m' | '30–60m' | '>60m'; readonly count: number }[];
  readonly byAgent: readonly (TimingAgentRow | { readonly membershipId: null; readonly name: 'Unattributed'; readonly measured: number; readonly averageSeconds: number | null; readonly medianSeconds: number | null })[];
  readonly byChannel: readonly TimingChannelRow[];
}

export interface ResolutionReport {
  readonly resolvedEpisodes: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
  readonly reopenedEpisodes: number;
  readonly byAgent: readonly (TimingAgentRow | { readonly membershipId: null; readonly name: 'Unattributed'; readonly measured: number; readonly averageSeconds: number | null; readonly medianSeconds: number | null })[];
  readonly byChannel: readonly TimingChannelRow[];
}

@Injectable()
export class LifecycleReportService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  response(session: AuthenticatedSession, tenantId: string, filters: OperationalReportFilters): Promise<ResponseReport> {
    return this.authorization.authorizedOwnReport(session, tenantId, async ({ sql, principal }) => {
      const agents = await scopedReportableAgents(sql, principal);
      await validateReportEntities(sql, principal, filters, agents.map((agent) => agent.membershipId));
      const values: unknown[] = [tenantId, filters.fromAt, filters.toExclusiveAt, filters.agentId, filters.teamId,
        filters.channel, filters.connectionId, filters.labelId, filters.campaignId, filters.priority, filters.status,
        agents.map((agent) => agent.membershipId)];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const result = await sql.query<{ report: ResponseReport }>(`
        WITH eligible AS (
          SELECT e.first_response_by_membership_id AS actor_id,n.kind AS channel,
                 extract(epoch FROM e.first_response_at-e.first_inbound_at)::float8 AS seconds
            FROM conversation_episodes e
            JOIN conversations c ON c.tenant_id=e.tenant_id AND c.id=e.conversation_id
            JOIN channel_connections n ON n.tenant_id=c.tenant_id AND n.id=c.connection_id
           WHERE e.tenant_id=$1::uuid AND ${scope}
             AND e.first_inbound_at IS NOT NULL AND e.first_response_at IS NOT NULL
             AND ($2::timestamptz IS NULL OR e.first_response_at >= $2::timestamptz)
             AND ($3::timestamptz IS NULL OR e.first_response_at < $3::timestamptz)
             AND ($4::uuid IS NULL OR e.first_response_by_membership_id=$4::uuid)
             AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.membership_id=e.first_response_by_membership_id AND tm.team_id=$5::uuid))
             AND ($6::text IS NULL OR n.kind=$6::text)
             AND ($7::uuid IS NULL OR c.connection_id=$7::uuid)
             AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=$8::uuid AND cl.removed_at IS NULL))
             AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=$9::uuid))
             AND ($10::text IS NULL OR c.priority=$10::text)
             AND ($11::text IS NULL OR c.status=$11::text)
        ), totals AS (
          SELECT count(*)::int AS measured,avg(seconds)::float8 AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS median_seconds FROM eligible
        ), buckets AS (
          SELECT CASE WHEN seconds < 300 THEN '<5m' WHEN seconds < 900 THEN '5–15m'
                      WHEN seconds < 1800 THEN '15–30m' WHEN seconds < 3600 THEN '30–60m' ELSE '>60m' END AS bucket,
                 count(*)::int AS count FROM eligible GROUP BY bucket
        ), agent_rows AS (
          SELECT e.actor_id AS membership_id,coalesce(m.display_name,'Unattributed') AS name,count(*)::int AS measured,
                 avg(e.seconds)::float8 AS average_seconds,percentile_cont(0.5) WITHIN GROUP (ORDER BY e.seconds)::float8 AS median_seconds
            FROM eligible e LEFT JOIN memberships m ON m.tenant_id=$1::uuid AND m.id=e.actor_id
           WHERE e.actor_id IS NULL OR e.actor_id=ANY($12::uuid[]) GROUP BY e.actor_id,m.display_name
        ), channel_rows AS (
          SELECT channel,count(*)::int AS measured,avg(seconds)::float8 AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS median_seconds
            FROM eligible GROUP BY channel
        )
        SELECT jsonb_build_object(
          'measured',totals.measured,'averageSeconds',totals.average_seconds,'medianSeconds',totals.median_seconds,
          'buckets',coalesce((SELECT jsonb_agg(jsonb_build_object('bucket',bucket,'count',count) ORDER BY CASE bucket WHEN '<5m' THEN 1 WHEN '5–15m' THEN 2 WHEN '15–30m' THEN 3 WHEN '30–60m' THEN 4 ELSE 5 END) FROM buckets),'[]'::jsonb),
          'byAgent',coalesce((SELECT jsonb_agg(jsonb_build_object('membershipId',membership_id::text,'name',name,'measured',measured,'averageSeconds',average_seconds,'medianSeconds',median_seconds) ORDER BY lower(name),membership_id) FROM agent_rows),'[]'::jsonb),
          'byChannel',coalesce((SELECT jsonb_agg(jsonb_build_object('channel',channel,'measured',measured,'averageSeconds',average_seconds,'medianSeconds',median_seconds) ORDER BY channel) FROM channel_rows),'[]'::jsonb)
        ) AS report FROM totals`, values);
      // The final SELECT reads an aggregate CTE without GROUP BY and therefore
      // returns exactly one row, including for an empty eligible set.
      return result.rows[0]!.report;
    });
  }

  resolution(session: AuthenticatedSession, tenantId: string, filters: OperationalReportFilters): Promise<ResolutionReport> {
    return this.authorization.authorizedOwnReport(session, tenantId, async ({ sql, principal }) => {
      const agents = await scopedReportableAgents(sql, principal);
      await validateReportEntities(sql, principal, filters, agents.map((agent) => agent.membershipId));
      const values: unknown[] = [tenantId, filters.fromAt, filters.toExclusiveAt, filters.agentId, filters.teamId,
        filters.channel, filters.connectionId, filters.labelId, filters.campaignId, filters.priority, filters.status,
        agents.map((agent) => agent.membershipId)];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const result = await sql.query<{ report: ResolutionReport }>(`
        WITH eligible AS (
          SELECT e.closed_by_membership_id AS actor_id,n.kind AS channel,e.seq,
                 extract(epoch FROM e.closed_at-e.opened_at)::float8 AS seconds
            FROM conversation_episodes e
            JOIN conversations c ON c.tenant_id=e.tenant_id AND c.id=e.conversation_id
            JOIN channel_connections n ON n.tenant_id=c.tenant_id AND n.id=c.connection_id
           WHERE e.tenant_id=$1::uuid AND ${scope}
             AND e.closed_at IS NOT NULL
             AND ($2::timestamptz IS NULL OR e.closed_at >= $2::timestamptz)
             AND ($3::timestamptz IS NULL OR e.closed_at < $3::timestamptz)
             AND ($4::uuid IS NULL OR e.closed_by_membership_id=$4::uuid)
             AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.membership_id=e.closed_by_membership_id AND tm.team_id=$5::uuid))
             AND ($6::text IS NULL OR n.kind=$6::text)
             AND ($7::uuid IS NULL OR c.connection_id=$7::uuid)
             AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=$8::uuid AND cl.removed_at IS NULL))
             AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=$9::uuid))
             AND ($10::text IS NULL OR c.priority=$10::text)
             AND ($11::text IS NULL OR c.status=$11::text)
        ), totals AS (
          SELECT count(*)::int AS resolved_episodes,avg(seconds)::float8 AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS median_seconds,
                 count(*) FILTER (WHERE seq > 1)::int AS reopened_episodes FROM eligible
        ), agent_rows AS (
          SELECT e.actor_id AS membership_id,coalesce(m.display_name,'Unattributed') AS name,count(*)::int AS measured,
                 avg(e.seconds)::float8 AS average_seconds,percentile_cont(0.5) WITHIN GROUP (ORDER BY e.seconds)::float8 AS median_seconds
            FROM eligible e LEFT JOIN memberships m ON m.tenant_id=$1::uuid AND m.id=e.actor_id
           WHERE e.actor_id IS NULL OR e.actor_id=ANY($12::uuid[])
           GROUP BY e.actor_id,m.display_name
        ), channel_rows AS (
          SELECT channel,count(*)::int AS measured,avg(seconds)::float8 AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS median_seconds
            FROM eligible GROUP BY channel
        )
        SELECT jsonb_build_object(
          'resolvedEpisodes',totals.resolved_episodes,'averageSeconds',totals.average_seconds,'medianSeconds',totals.median_seconds,'reopenedEpisodes',totals.reopened_episodes,
          'byAgent',coalesce((SELECT jsonb_agg(jsonb_build_object('membershipId',membership_id::text,'name',name,'measured',measured,'averageSeconds',average_seconds,'medianSeconds',median_seconds) ORDER BY membership_id NULLS LAST) FROM agent_rows),'[]'::jsonb),
          'byChannel',coalesce((SELECT jsonb_agg(jsonb_build_object('channel',channel,'measured',measured,'averageSeconds',average_seconds,'medianSeconds',median_seconds) ORDER BY channel) FROM channel_rows),'[]'::jsonb)
        ) AS report FROM totals`, values);
      // The final SELECT reads an aggregate CTE without GROUP BY and therefore
      // returns exactly one row, including for an empty eligible set.
      return result.rows[0]!.report;
    });
  }
}
