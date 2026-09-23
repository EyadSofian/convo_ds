import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { readableScope } from '../conversations/inbox-query-compiler.js';
import { scopedReportableAgents, scopedReportableTeams } from '../conversations/supervisor-directory.js';
import { conversationEventBoundary, qualifyingHumanOutbound } from '../conversations/event-boundary.js';
import type { OperationalReportFilters } from './operational-report.service.js';
import { validateReportEntities } from './operational-report.service.js';

export interface TeamReportRow {
  readonly teamId: string;
  readonly name: string;
  readonly activeAgentCount: number;
  readonly currentActive: number;
  readonly currentOpen: number;
  readonly currentPending: number;
  readonly currentSnoozed: number;
  readonly handledConversations: number;
  readonly humanMessages: number;
  readonly firstResponses: number;
  readonly firstResponseAverageSeconds: number | null;
  readonly firstResponseMedianSeconds: number | null;
  readonly resolutions: number;
  readonly resolutionAverageSeconds: number | null;
  readonly resolutionMedianSeconds: number | null;
}

@Injectable()
export class TeamReportService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  report(session: AuthenticatedSession, tenantId: string, filters: OperationalReportFilters): Promise<readonly TeamReportRow[]> {
    return this.authorization.authorizedOwnReport(session, tenantId, async ({ sql, principal }) => {
      const agents = await scopedReportableAgents(sql, principal);
      const teams = await scopedReportableTeams(sql, principal);
      await validateReportEntities(sql, principal, filters, agents.map((agent) => agent.membershipId));
      const visibleTeamIds = teams.map((team) => team.teamId);
      if (filters.teamId !== null && !visibleTeamIds.includes(filters.teamId)) {
        // Do not distinguish a nonexistent team from one outside this report scope.
        throw new ApiHttpError(404, 'resource_not_found', 'The requested report filter is not available.');
      }
      const values: unknown[] = [filters.fromAt, filters.toExclusiveAt, filters.agentId, filters.teamId,
        filters.channel, filters.connectionId, filters.labelId, filters.campaignId, filters.priority, filters.status,
        visibleTeamIds, agents.map((agent) => agent.membershipId)];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const rows = await sql.query<TeamReportRow>(`
        WITH params AS (SELECT $1::timestamptz AS from_at,$2::timestamptz AS to_at,$3::uuid AS agent_id,$4::uuid AS team_id,
          $5::text AS channel,$6::uuid AS connection_id,$7::uuid AS label_id,$8::uuid AS campaign_id,$9::text AS priority,$10::text AS status),
        visible_teams AS (
          SELECT t.id,t.name FROM teams t WHERE t.id=ANY($11::uuid[]) AND (SELECT team_id FROM params) IS NOT NULL
            AND t.id=(SELECT team_id FROM params)
          UNION ALL SELECT t.id,t.name FROM teams t WHERE t.id=ANY($11::uuid[]) AND (SELECT team_id FROM params) IS NULL
        ),
        current_work AS (
          SELECT c.team_id,count(*)::int AS active,
                 count(*) FILTER (WHERE c.status='open')::int AS open,
                 count(*) FILTER (WHERE c.status='pending')::int AS pending,
                 count(*) FILTER (WHERE c.status='snoozed')::int AS snoozed
            FROM conversations c JOIN channel_connections n ON n.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND c.status IN ('open','pending','snoozed')
             AND (p.agent_id IS NULL OR c.assignee_membership_id=p.agent_id)
             AND (p.team_id IS NULL OR c.team_id=p.team_id)
             AND (p.channel IS NULL OR n.kind=p.channel) AND (p.connection_id IS NULL OR c.connection_id=p.connection_id)
             AND (p.label_id IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=p.label_id AND cl.removed_at IS NULL))
             AND (p.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=p.campaign_id))
             AND (p.priority IS NULL OR c.priority=p.priority) AND (p.status IS NULL OR c.status=p.status)
           GROUP BY c.team_id
        ),
        human_activity AS (
          SELECT tm.team_id,count(*)::int AS messages,count(DISTINCT c.id)::int AS handled
            FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
            JOIN channel_connections n ON n.id=c.connection_id JOIN team_members tm ON tm.membership_id=o.author_membership
            JOIN visible_teams vt ON vt.id=tm.team_id CROSS JOIN params p
           WHERE ${scope} AND ${qualifyingHumanOutbound('o')} AND o.author_membership=ANY($12::uuid[])
             AND (p.agent_id IS NULL OR o.author_membership=p.agent_id)
             AND (p.from_at IS NULL OR o.created_at>=p.from_at) AND (p.to_at IS NULL OR o.created_at<p.to_at)
             AND (p.channel IS NULL OR n.kind=p.channel) AND (p.connection_id IS NULL OR c.connection_id=p.connection_id)
             AND (p.label_id IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=p.label_id AND cl.removed_at IS NULL))
             AND (p.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=p.campaign_id))
             AND (p.priority IS NULL OR c.priority=p.priority) AND (p.status IS NULL OR c.status=p.status)
           GROUP BY tm.team_id
        ),
        response_activity AS (
          SELECT tm.team_id,count(*)::int AS measured,avg(extract(epoch FROM e.first_response_at-e.first_inbound_at))::float8 AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.first_response_at-e.first_inbound_at))::float8 AS median_seconds
            FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id JOIN channel_connections n ON n.id=c.connection_id
            JOIN team_members tm ON tm.membership_id=e.first_response_by_membership_id JOIN visible_teams vt ON vt.id=tm.team_id CROSS JOIN params p
           WHERE ${scope} AND e.first_inbound_at IS NOT NULL AND e.first_response_at IS NOT NULL
             AND e.first_response_by_membership_id=ANY($12::uuid[]) AND (p.agent_id IS NULL OR e.first_response_by_membership_id=p.agent_id)
             AND (p.from_at IS NULL OR e.first_response_at>=p.from_at) AND (p.to_at IS NULL OR e.first_response_at<p.to_at)
             AND (p.channel IS NULL OR n.kind=p.channel) AND (p.connection_id IS NULL OR c.connection_id=p.connection_id)
             AND (p.label_id IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=p.label_id AND cl.removed_at IS NULL))
             AND (p.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=p.campaign_id))
             AND (p.priority IS NULL OR c.priority=p.priority) AND (p.status IS NULL OR c.status=p.status)
           GROUP BY tm.team_id
        ),
        resolution_activity AS (
          SELECT tm.team_id,count(*)::int AS measured,avg(extract(epoch FROM e.closed_at-e.opened_at))::float8 AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.closed_at-e.opened_at))::float8 AS median_seconds
            FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id JOIN channel_connections n ON n.id=c.connection_id
            JOIN team_members tm ON tm.membership_id=e.closed_by_membership_id JOIN visible_teams vt ON vt.id=tm.team_id CROSS JOIN params p
           WHERE ${scope} AND e.closed_at IS NOT NULL AND e.closed_by_membership_id=ANY($12::uuid[])
             AND (p.agent_id IS NULL OR e.closed_by_membership_id=p.agent_id)
             AND (p.from_at IS NULL OR e.closed_at>=p.from_at) AND (p.to_at IS NULL OR e.closed_at<p.to_at)
             AND (p.channel IS NULL OR n.kind=p.channel) AND (p.connection_id IS NULL OR c.connection_id=p.connection_id)
             AND (p.label_id IS NULL OR EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=p.label_id AND cl.removed_at IS NULL))
             AND (p.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions cca WHERE cca.conversation_id=c.id AND cca.campaign_id=p.campaign_id))
             AND (p.priority IS NULL OR c.priority=p.priority) AND (p.status IS NULL OR c.status=p.status)
           GROUP BY tm.team_id
        )
        SELECT vt.id::text AS "teamId",vt.name,
          (SELECT count(DISTINCT tm.membership_id)::int FROM team_members tm JOIN memberships m ON m.id=tm.membership_id
            WHERE tm.team_id=vt.id AND m.status='active' AND tm.membership_id=ANY($12::uuid[])) AS "activeAgentCount",
          coalesce(cw.active,0)::int AS "currentActive",coalesce(cw.open,0)::int AS "currentOpen",
          coalesce(cw.pending,0)::int AS "currentPending",coalesce(cw.snoozed,0)::int AS "currentSnoozed",
          coalesce(ha.handled,0)::int AS "handledConversations",coalesce(ha.messages,0)::int AS "humanMessages",
          coalesce(ra.measured,0)::int AS "firstResponses",ra.average_seconds AS "firstResponseAverageSeconds",ra.median_seconds AS "firstResponseMedianSeconds",
          coalesce(xa.measured,0)::int AS resolutions,xa.average_seconds AS "resolutionAverageSeconds",xa.median_seconds AS "resolutionMedianSeconds"
        FROM visible_teams vt LEFT JOIN current_work cw ON cw.team_id=vt.id LEFT JOIN human_activity ha ON ha.team_id=vt.id
          LEFT JOIN response_activity ra ON ra.team_id=vt.id LEFT JOIN resolution_activity xa ON xa.team_id=vt.id
        ORDER BY lower(vt.name),vt.id`, values);
      return rows.rows;
    });
  }
}
