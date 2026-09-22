import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { readableScope } from '../conversations/inbox-query-compiler.js';
import { scopedReportableAgents } from '../conversations/supervisor-directory.js';
import { ApiHttpError } from '../http-error.js';

export interface OperationalReportFilters { readonly fromAt: Date | null; readonly toExclusiveAt: Date | null; }
export interface OperationalReport {
  readonly generatedAt: string;
  readonly filters: { readonly from: string | null; readonly to: string | null };
  readonly conversations: { readonly open: number; readonly new: number; readonly resolved: number; readonly backlogByStatus: readonly { readonly status: string; readonly count: number }[]; readonly backlogByChannel: readonly { readonly channel: string; readonly count: number }[]; readonly backlogByTeam: readonly { readonly team: string; readonly count: number }[]; readonly assignmentWorkload: readonly { readonly name: string; readonly count: number }[] };
  readonly timing: { readonly firstResponseMeasured: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null; readonly resolutionMeasured: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null };
  readonly agents: readonly {
    readonly membershipId: string; readonly name: string; readonly email: string; readonly teams: readonly string[];
    readonly currentAssigned: number; readonly currentOpen: number; readonly currentPending: number; readonly currentSnoozed: number;
    readonly assignedInPeriod: number; readonly handledConversations: number; readonly humanMessages: number; readonly internalNotes: number;
    readonly firstResponses: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null;
    readonly resolutions: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null;
    readonly reassignments: number;
  }[];
}

@Injectable()
export class OperationalReportingService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  async report(session: AuthenticatedSession, tenantId: string, filters: OperationalReportFilters): Promise<OperationalReport> {
    return this.authorization.authorized(session, tenantId, 'report.read', async ({ sql, principal }) => {
      // The directory is shared with Supervisor View. It represents people the
      // reporting principal can inspect, not everyone who happens to have an
      // event row in the selected time range.
      const visibleAgents = await scopedReportableAgents(sql, principal);
      const values: unknown[] = [filters.fromAt, filters.toExclusiveAt, visibleAgents.map((agent) => agent.membershipId)];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const row = (await sql.query<{ report: Omit<OperationalReport, 'filters'> }>(`
        WITH params AS (SELECT $1::timestamptz AS from_at,$2::timestamptz AS to_at),
        conversation_scope AS (
          SELECT c.*,n.kind FROM conversations c JOIN channel_connections n ON n.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND (p.from_at IS NULL OR c.created_at>=p.from_at) AND (p.to_at IS NULL OR c.created_at<p.to_at)
        ),
        current_backlog AS (
          SELECT c.*,n.kind FROM conversations c JOIN channel_connections n ON n.id=c.connection_id WHERE ${scope} AND c.status IN ('open','pending','snoozed')
        ),
        first_response_episodes AS (
          SELECT e.* FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id CROSS JOIN params p
           WHERE ${scope} AND e.first_inbound_at IS NOT NULL AND e.first_response_at IS NOT NULL
             AND (p.from_at IS NULL OR e.first_response_at>=p.from_at) AND (p.to_at IS NULL OR e.first_response_at<p.to_at)
        ),
        resolution_episodes AS (
          SELECT e.* FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id CROSS JOIN params p
           WHERE ${scope} AND e.closed_at IS NOT NULL
             AND (p.from_at IS NULL OR e.closed_at>=p.from_at) AND (p.to_at IS NULL OR e.closed_at<p.to_at)
        ),
        first_response_timing AS (
          SELECT count(*)::int AS measured,avg(extract(epoch FROM first_response_at-first_inbound_at)) AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at-first_inbound_at)) AS median_seconds
            FROM first_response_episodes
        ),
        resolution_timing AS (
          SELECT count(*)::int AS measured,avg(extract(epoch FROM closed_at-opened_at)) AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at-opened_at)) AS median_seconds
            FROM resolution_episodes
        ),
        agent_directory AS (
          SELECT m.id,m.display_name AS name,u.email::text AS email,
                 coalesce(array_agg(DISTINCT t.name) FILTER (WHERE t.archived_at IS NULL), '{}') AS teams
            FROM memberships m JOIN users u ON u.id=m.user_id
            LEFT JOIN team_members tm ON tm.membership_id=m.id LEFT JOIN teams t ON t.id=tm.team_id
           WHERE m.id = ANY($3::uuid[]) GROUP BY m.id,m.display_name,u.email
        ),
        current_agent_workload AS (
          SELECT c.assignee_membership_id AS membership_id,count(*)::int AS assigned,
                 count(*) FILTER (WHERE c.status='open')::int AS open,count(*) FILTER (WHERE c.status='pending')::int AS pending,
                 count(*) FILTER (WHERE c.status='snoozed')::int AS snoozed
            FROM current_backlog c WHERE c.assignee_membership_id IS NOT NULL GROUP BY c.assignee_membership_id
        ),
        agent_human_messages AS (
          SELECT o.author_membership AS membership_id,count(*)::int AS messages,count(DISTINCT c.id)::int AS handled
            FROM outbound_messages o JOIN conversations c ON c.connection_id=o.connection_id AND c.peer_identity=o.peer_identity
            CROSS JOIN params p WHERE ${scope} AND o.author_membership IS NOT NULL
              AND (p.from_at IS NULL OR o.created_at>=p.from_at) AND (p.to_at IS NULL OR o.created_at<p.to_at)
           GROUP BY o.author_membership
        ),
        agent_notes AS (
          SELECT n.author_membership_id AS membership_id,count(*)::int AS notes
            FROM conversation_notes n JOIN conversations c ON c.id=n.conversation_id CROSS JOIN params p
           WHERE ${scope} AND n.author_membership_id IS NOT NULL AND n.deleted_at IS NULL
             AND (p.from_at IS NULL OR n.created_at>=p.from_at) AND (p.to_at IS NULL OR n.created_at<p.to_at)
           GROUP BY n.author_membership_id
        ),
        agent_assignments AS (
          SELECT a.to_value::uuid AS membership_id,count(*) FILTER (WHERE a.act IN ('claim','assign','handoff'))::int AS assigned,
                 count(*) FILTER (WHERE a.act IN ('assign','handoff') AND a.from_value IS NOT NULL)::int AS reassignments
            FROM conversation_audit a JOIN conversations c ON c.id=a.conversation_id CROSS JOIN params p
           WHERE ${scope} AND a.to_value IS NOT NULL AND a.act IN ('claim','assign','handoff')
             AND (p.from_at IS NULL OR a.at>=p.from_at) AND (p.to_at IS NULL OR a.at<p.to_at)
           GROUP BY a.to_value
        ),
        agent_first_responses AS (
          SELECT first_response_by_membership_id AS membership_id,count(*)::int AS measured,
                 avg(extract(epoch FROM first_response_at-first_inbound_at)) AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at-first_inbound_at)) AS median_seconds
            FROM first_response_episodes WHERE first_response_by_membership_id IS NOT NULL GROUP BY first_response_by_membership_id
        ),
        agent_resolutions AS (
          SELECT closed_by_membership_id AS membership_id,count(*)::int AS measured,
                 avg(extract(epoch FROM closed_at-opened_at)) AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at-opened_at)) AS median_seconds
            FROM resolution_episodes WHERE closed_by_membership_id IS NOT NULL GROUP BY closed_by_membership_id
        ),
        agent_rows AS (
          SELECT d.id::text AS membership_id,d.name,d.email,d.teams,
                 coalesce(cw.assigned,0)::int AS current_assigned,coalesce(cw.open,0)::int AS current_open,
                 coalesce(cw.pending,0)::int AS current_pending,coalesce(cw.snoozed,0)::int AS current_snoozed,
                 coalesce(aa.assigned,0)::int AS assigned_in_period,coalesce(hm.handled,0)::int AS handled_conversations,
                 coalesce(hm.messages,0)::int AS human_messages,coalesce(an.notes,0)::int AS internal_notes,
                 coalesce(fr.measured,0)::int AS first_responses,fr.average_seconds AS first_response_average_seconds,fr.median_seconds AS first_response_median_seconds,
                 coalesce(re.measured,0)::int AS resolutions,re.average_seconds AS resolution_average_seconds,re.median_seconds AS resolution_median_seconds,
                 coalesce(aa.reassignments,0)::int AS reassignments
            FROM agent_directory d
            LEFT JOIN current_agent_workload cw ON cw.membership_id=d.id
            LEFT JOIN agent_human_messages hm ON hm.membership_id=d.id
            LEFT JOIN agent_notes an ON an.membership_id=d.id
            LEFT JOIN agent_assignments aa ON aa.membership_id=d.id
            LEFT JOIN agent_first_responses fr ON fr.membership_id=d.id
            LEFT JOIN agent_resolutions re ON re.membership_id=d.id
           ORDER BY resolutions DESC,first_responses DESC,d.name,d.id
        ),
        team_backlog AS (
          SELECT coalesce(t.name, 'Unassigned') AS team,count(*)::int AS count FROM current_backlog c
            LEFT JOIN teams t ON t.id=c.team_id GROUP BY t.name ORDER BY count DESC,team
        ),
        assignment_workload AS (
          SELECT m.display_name AS name,count(*)::int AS count FROM current_backlog c
            JOIN memberships m ON m.id=c.assignee_membership_id GROUP BY m.id,m.display_name ORDER BY count DESC,name
        )
        SELECT jsonb_build_object(
          'generatedAt',now(),
          'conversations',jsonb_build_object(
            'open',(SELECT count(*)::int FROM current_backlog),
            'new',(SELECT count(*)::int FROM conversation_scope),
            'resolved',(SELECT count(*)::int FROM resolution_episodes),
            'backlogByStatus',coalesce((SELECT jsonb_agg(jsonb_build_object('status',status,'count',count) ORDER BY status) FROM (SELECT status,count(*)::int AS count FROM current_backlog GROUP BY status) x),'[]'::jsonb),
            'backlogByChannel',coalesce((SELECT jsonb_agg(jsonb_build_object('channel',kind,'count',count) ORDER BY kind) FROM (SELECT kind,count(*)::int AS count FROM current_backlog GROUP BY kind) x),'[]'::jsonb),
            'backlogByTeam',coalesce((SELECT jsonb_agg(jsonb_build_object('team',team,'count',count)) FROM team_backlog),'[]'::jsonb),
            'assignmentWorkload',coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'count',count)) FROM assignment_workload),'[]'::jsonb)
          ),
          'timing',jsonb_build_object('firstResponseMeasured',fr.measured,'firstResponseAverageSeconds',fr.average_seconds,'firstResponseMedianSeconds',fr.median_seconds,'resolutionMeasured',rt.measured,'resolutionAverageSeconds',rt.average_seconds,'resolutionMedianSeconds',rt.median_seconds),
          'agents',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'membershipId',membership_id,'name',name,'email',email,'teams',teams,
            'currentAssigned',current_assigned,'currentOpen',current_open,'currentPending',current_pending,'currentSnoozed',current_snoozed,
            'assignedInPeriod',assigned_in_period,'handledConversations',handled_conversations,'humanMessages',human_messages,'internalNotes',internal_notes,
            'firstResponses',first_responses,'firstResponseAverageSeconds',first_response_average_seconds,'firstResponseMedianSeconds',first_response_median_seconds,
            'resolutions',resolutions,'resolutionAverageSeconds',resolution_average_seconds,'resolutionMedianSeconds',resolution_median_seconds,'reassignments',reassignments
          )) FROM agent_rows),'[]'::jsonb)
        ) AS report FROM first_response_timing fr CROSS JOIN resolution_timing rt`, values)).rows[0];
      if (row === undefined) throw new Error('operational report returned no row');
      return { ...row.report, filters: { from: filters.fromAt?.toISOString() ?? null, to: filters.toExclusiveAt?.toISOString() ?? null } };
    });
  }
}

export function parseOperationalReportFilters(query: unknown): OperationalReportFilters {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const value = query as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'from' && key !== 'to')) throw invalid();
  const fromAt = date(value['from'], false); const toExclusiveAt = date(value['to'], true);
  if (fromAt !== null && toExclusiveAt !== null && fromAt >= toExclusiveAt) throw invalid();
  return { fromAt, toExclusiveAt };
}
function date(value: unknown, exclusive: boolean): Date | null { if (value === undefined || value === '') return null; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(); const at = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(at.getTime()) || at.toISOString().slice(0,10) !== value) throw invalid(); if (exclusive) at.setUTCDate(at.getUTCDate()+1); return at; }
function invalid(): ApiHttpError { return new ApiHttpError(400,'validation_failed','The report date range is invalid.'); }
