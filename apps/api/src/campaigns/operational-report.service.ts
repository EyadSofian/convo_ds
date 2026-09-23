import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { readableScope } from '../conversations/inbox-query-compiler.js';
import { scopedReportableAgents } from '../conversations/supervisor-directory.js';
import { conversationEventBoundary, conversationUnrepliedPredicate, qualifyingHumanOutbound } from '../conversations/event-boundary.js';
import { ApiHttpError } from '../http-error.js';
import { CHANNEL_KINDS } from '@convo/domain';
import type { Principal, SqlExecutor } from '@convo/domain';

export interface OperationalReportFilters {
  readonly fromAt: Date | null; readonly toExclusiveAt: Date | null;
  readonly agentId: string | null; readonly teamId: string | null; readonly channel: string | null;
  readonly connectionId: string | null; readonly labelId: string | null; readonly campaignId: string | null;
  readonly priority: string | null; readonly status: string | null;
}
export interface OperationalReport {
  readonly generatedAt: string;
  readonly filters: { readonly from: string | null; readonly to: string | null; readonly agentId: string | null; readonly teamId: string | null; readonly channel: string | null; readonly connectionId: string | null; readonly labelId: string | null; readonly campaignId: string | null; readonly priority: string | null; readonly status: string | null };
  readonly agentOptions: readonly { readonly membershipId: string; readonly name: string; readonly teams: readonly string[] }[];
  readonly conversations: { readonly open: number; readonly unassigned: number; readonly new: number; readonly resolved: number; readonly assignedInPeriod: number; readonly humanMessages: number; readonly internalNotes: number; readonly reassignments: number; readonly backlogByStatus: readonly { readonly status: string; readonly count: number }[]; readonly backlogByChannel: readonly { readonly channel: string; readonly count: number }[]; readonly backlogByTeam: readonly { readonly team: string; readonly count: number }[]; readonly assignmentWorkload: readonly { readonly name: string; readonly count: number }[] };
  readonly timing: { readonly firstResponseMeasured: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null; readonly resolutionMeasured: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null };
  readonly responseBuckets: readonly { readonly bucket: string; readonly count: number }[];
  readonly channels: readonly {
    readonly channel: string; readonly currentActive: number; readonly newConversations: number;
    readonly handledConversations: number; readonly humanMessages: number;
    readonly firstResponses: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null;
    readonly resolutions: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null;
  }[];
  readonly agents: readonly {
    readonly membershipId: string; readonly name: string; readonly email: string; readonly teams: readonly string[];
    readonly currentAssigned: number; readonly currentOpen: number; readonly currentPending: number; readonly currentSnoozed: number;
    readonly currentUnreplied: number; readonly currentUrgent: number; readonly currentHigh: number;
    readonly currentByStatus: readonly { readonly status: string; readonly count: number }[];
    readonly currentByChannel: readonly { readonly channel: string; readonly count: number }[];
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
    return this.authorization.authorizedOwnReport(session, tenantId, async ({ sql, principal }) => {
      // The directory is shared with Supervisor View. It represents people the
      // reporting principal can inspect, not everyone who happens to have an
      // event row in the selected time range.
      const visibleAgents = await scopedReportableAgents(sql, principal);
      await validateReportEntities(sql, principal, filters, visibleAgents.map((agent) => agent.membershipId));
      const values: unknown[] = [filters.fromAt, filters.toExclusiveAt, visibleAgents.map((agent) => agent.membershipId),
        filters.agentId, filters.teamId, filters.channel, filters.connectionId, filters.labelId, filters.campaignId, filters.priority, filters.status];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const row = (await sql.query<{ report: Omit<OperationalReport, 'filters'> }>(`
        WITH params AS (SELECT $1::timestamptz AS from_at,$2::timestamptz AS to_at,$4::uuid AS agent_id,$5::uuid AS team_id,
          $6::text AS channel,$7::uuid AS connection_id,$8::uuid AS label_id,$9::uuid AS campaign_id,$10::text AS priority,$11::text AS status),
        conversation_scope AS (
          SELECT c.*,n.kind FROM conversations c JOIN channel_connections n ON n.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${currentConversationDimensions('c','n')} AND (p.agent_id IS NULL OR c.assignee_membership_id=p.agent_id)
             AND (p.from_at IS NULL OR c.created_at>=p.from_at) AND (p.to_at IS NULL OR c.created_at<p.to_at)
        ),
        current_backlog AS (
          SELECT c.*,n.kind FROM conversations c JOIN channel_connections n ON n.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${currentConversationDimensions('c','n')} AND (p.agent_id IS NULL OR c.assignee_membership_id=p.agent_id)
             AND c.status IN ('open','pending','snoozed')
        ),
        first_response_episodes AS (
          SELECT e.* FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id CROSS JOIN params p
           JOIN channel_connections n ON n.id=c.connection_id
           WHERE ${scope} AND ${eventConversationDimensions('c','n')}
             AND (p.agent_id IS NULL OR e.first_response_by_membership_id=p.agent_id)
             AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=e.first_response_by_membership_id AND actor_team.team_id=p.team_id))
             AND e.first_inbound_at IS NOT NULL AND e.first_response_at IS NOT NULL
             AND (p.from_at IS NULL OR e.first_response_at>=p.from_at) AND (p.to_at IS NULL OR e.first_response_at<p.to_at)
        ),
        resolution_episodes AS (
          SELECT e.* FROM conversation_episodes e JOIN conversations c ON c.id=e.conversation_id CROSS JOIN params p
           JOIN channel_connections n ON n.id=c.connection_id
           WHERE ${scope} AND ${eventConversationDimensions('c','n')}
             AND (p.agent_id IS NULL OR e.closed_by_membership_id=p.agent_id)
             AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=e.closed_by_membership_id AND actor_team.team_id=p.team_id))
             AND e.closed_at IS NOT NULL
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
        response_buckets AS (
          SELECT CASE
            WHEN first_response_at-first_inbound_at < interval '5 minutes' THEN '<5m'
            WHEN first_response_at-first_inbound_at < interval '15 minutes' THEN '5–15m'
            WHEN first_response_at-first_inbound_at < interval '30 minutes' THEN '15–30m'
            WHEN first_response_at-first_inbound_at < interval '60 minutes' THEN '30–60m'
            ELSE '>60m' END AS bucket,count(*)::int AS count
            FROM first_response_episodes GROUP BY bucket
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
                 count(*) FILTER (WHERE c.status='snoozed')::int AS snoozed,
                 count(*) FILTER (WHERE ${conversationUnrepliedPredicate('c')})::int AS unreplied,
                 count(*) FILTER (WHERE c.priority='urgent')::int AS urgent,count(*) FILTER (WHERE c.priority='high')::int AS high
            FROM current_backlog c WHERE c.assignee_membership_id IS NOT NULL GROUP BY c.assignee_membership_id
        ),
        agent_current_status AS (
          SELECT c.assignee_membership_id AS membership_id,c.status,count(*)::int AS count
            FROM current_backlog c WHERE c.assignee_membership_id IS NOT NULL GROUP BY c.assignee_membership_id,c.status
        ),
        agent_current_channel AS (
          SELECT c.assignee_membership_id AS membership_id,c.kind AS channel,count(*)::int AS count
            FROM current_backlog c WHERE c.assignee_membership_id IS NOT NULL GROUP BY c.assignee_membership_id,c.kind
        ),
        agent_human_messages AS (
          SELECT o.author_membership AS membership_id,count(*)::int AS messages,count(DISTINCT c.id)::int AS handled
            FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c', 'o', 'o.created_at')}
            JOIN channel_connections n ON n.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${eventConversationDimensions('c','n')}
              AND (p.agent_id IS NULL OR o.author_membership=p.agent_id)
              AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=o.author_membership AND actor_team.team_id=p.team_id))
              AND ${qualifyingHumanOutbound('o')}
              AND (p.from_at IS NULL OR o.created_at>=p.from_at) AND (p.to_at IS NULL OR o.created_at<p.to_at)
           GROUP BY o.author_membership
        ),
        agent_notes AS (
          SELECT n.author_membership_id AS membership_id,count(*)::int AS notes
            FROM conversation_notes n JOIN conversations c ON c.id=n.conversation_id JOIN channel_connections channel ON channel.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${eventConversationDimensions('c','channel')}
             AND (p.agent_id IS NULL OR n.author_membership_id=p.agent_id)
             AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=n.author_membership_id AND actor_team.team_id=p.team_id))
             AND n.author_membership_id IS NOT NULL AND n.deleted_at IS NULL
             AND (p.from_at IS NULL OR n.created_at>=p.from_at) AND (p.to_at IS NULL OR n.created_at<p.to_at)
           GROUP BY n.author_membership_id
        ),
        agent_assignments AS (
          SELECT a.to_value::uuid AS membership_id,count(*) FILTER (WHERE a.act IN ('claim','assign','handoff'))::int AS assigned,
                 count(*) FILTER (WHERE a.act IN ('assign','handoff') AND a.from_value IS NOT NULL AND a.from_value<>a.to_value)::int AS reassignments
            FROM conversation_audit a JOIN conversations c ON c.id=a.conversation_id JOIN channel_connections channel ON channel.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${eventConversationDimensions('c','channel')}
             AND (p.agent_id IS NULL OR a.to_value::uuid=p.agent_id)
             AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=a.to_value::uuid AND actor_team.team_id=p.team_id))
             AND a.to_value IS NOT NULL AND a.act IN ('claim','assign','handoff')
             AND (p.from_at IS NULL OR a.at>=p.from_at) AND (p.to_at IS NULL OR a.at<p.to_at)
           GROUP BY a.to_value
        ),
        assignment_events AS (
          SELECT a.id,a.at,a.act,a.from_value,a.to_value,c.id AS conversation_id
            FROM conversation_audit a JOIN conversations c ON c.id=a.conversation_id JOIN channel_connections channel ON channel.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${eventConversationDimensions('c','channel')}
             AND (p.agent_id IS NULL OR a.to_value::uuid=p.agent_id)
             AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=a.to_value::uuid AND actor_team.team_id=p.team_id))
             AND a.to_value IS NOT NULL AND a.act IN ('claim','assign','handoff')
             AND (p.from_at IS NULL OR a.at>=p.from_at) AND (p.to_at IS NULL OR a.at<p.to_at)
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
        channel_current AS (
          SELECT kind AS channel,count(*)::int AS current_active FROM current_backlog GROUP BY kind
        ),
        channel_new AS (
          SELECT kind AS channel,count(*)::int AS new_conversations FROM conversation_scope GROUP BY kind
        ),
        channel_activity AS (
          SELECT n.kind AS channel,count(*)::int AS human_messages,count(DISTINCT c.id)::int AS handled_conversations
            FROM outbound_messages o JOIN conversations c ON ${conversationEventBoundary('c','o','o.created_at')}
            JOIN channel_connections n ON n.id=c.connection_id CROSS JOIN params p
           WHERE ${scope} AND ${eventConversationDimensions('c','n')} AND ${qualifyingHumanOutbound('o')}
             AND (p.from_at IS NULL OR o.created_at>=p.from_at) AND (p.to_at IS NULL OR o.created_at<p.to_at)
             AND (p.agent_id IS NULL OR o.author_membership=p.agent_id)
             AND (p.team_id IS NULL OR EXISTS (SELECT 1 FROM team_members actor_team WHERE actor_team.membership_id=o.author_membership AND actor_team.team_id=p.team_id))
           GROUP BY n.kind
        ),
        channel_response AS (
          SELECT n.kind AS channel,count(*)::int AS measured,
                 avg(extract(epoch FROM e.first_response_at-e.first_inbound_at)) AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.first_response_at-e.first_inbound_at)) AS median_seconds
            FROM first_response_episodes e JOIN conversations c ON c.id=e.conversation_id JOIN channel_connections n ON n.id=c.connection_id
           GROUP BY n.kind
        ),
        channel_resolution AS (
          SELECT n.kind AS channel,count(*)::int AS measured,
                 avg(extract(epoch FROM e.closed_at-e.opened_at)) AS average_seconds,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.closed_at-e.opened_at)) AS median_seconds
            FROM resolution_episodes e JOIN conversations c ON c.id=e.conversation_id JOIN channel_connections n ON n.id=c.connection_id
           GROUP BY n.kind
        ),
        channel_keys AS (
          SELECT channel FROM channel_current UNION SELECT channel FROM channel_new UNION
          SELECT channel FROM channel_activity UNION SELECT channel FROM channel_response UNION SELECT channel FROM channel_resolution
        ),
        agent_rows AS (
          SELECT d.id::text AS membership_id,d.name,d.email,d.teams,
                 coalesce(cw.assigned,0)::int AS current_assigned,coalesce(cw.open,0)::int AS current_open,
                 coalesce(cw.pending,0)::int AS current_pending,coalesce(cw.snoozed,0)::int AS current_snoozed,
                 coalesce(cw.unreplied,0)::int AS current_unreplied,coalesce(cw.urgent,0)::int AS current_urgent,coalesce(cw.high,0)::int AS current_high,
                 coalesce((SELECT jsonb_agg(jsonb_build_object('status',status,'count',count) ORDER BY status) FROM agent_current_status current_status WHERE current_status.membership_id=d.id),'[]'::jsonb) AS current_by_status,
                 coalesce((SELECT jsonb_agg(jsonb_build_object('channel',channel,'count',count) ORDER BY channel) FROM agent_current_channel current_channel WHERE current_channel.membership_id=d.id),'[]'::jsonb) AS current_by_channel,
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
            'unassigned',(SELECT count(*)::int FROM current_backlog WHERE assignee_membership_id IS NULL),
            'new',(SELECT count(*)::int FROM conversation_scope),
            'resolved',(SELECT count(*)::int FROM resolution_episodes),
            'assignedInPeriod',(SELECT count(*)::int FROM assignment_events),
            'humanMessages',coalesce((SELECT sum(messages)::int FROM agent_human_messages),0),
            'internalNotes',coalesce((SELECT sum(notes)::int FROM agent_notes),0),
            'reassignments',(SELECT count(*)::int FROM assignment_events WHERE act IN ('assign','handoff') AND from_value IS NOT NULL AND from_value<>to_value),
            'backlogByStatus',coalesce((SELECT jsonb_agg(jsonb_build_object('status',status,'count',count) ORDER BY status) FROM (SELECT status,count(*)::int AS count FROM current_backlog GROUP BY status) x),'[]'::jsonb),
            'backlogByChannel',coalesce((SELECT jsonb_agg(jsonb_build_object('channel',kind,'count',count) ORDER BY kind) FROM (SELECT kind,count(*)::int AS count FROM current_backlog GROUP BY kind) x),'[]'::jsonb),
            'backlogByTeam',coalesce((SELECT jsonb_agg(jsonb_build_object('team',team,'count',count)) FROM team_backlog),'[]'::jsonb),
            'assignmentWorkload',coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'count',count)) FROM assignment_workload),'[]'::jsonb)
          ),
          'timing',jsonb_build_object('firstResponseMeasured',fr.measured,'firstResponseAverageSeconds',fr.average_seconds,'firstResponseMedianSeconds',fr.median_seconds,'resolutionMeasured',rt.measured,'resolutionAverageSeconds',rt.average_seconds,'resolutionMedianSeconds',rt.median_seconds),
          'responseBuckets',coalesce((SELECT jsonb_agg(jsonb_build_object('bucket',bucket,'count',count) ORDER BY CASE bucket WHEN '<5m' THEN 1 WHEN '5–15m' THEN 2 WHEN '15–30m' THEN 3 WHEN '30–60m' THEN 4 ELSE 5 END) FROM response_buckets),'[]'::jsonb),
          'channels',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'channel',k.channel,'currentActive',coalesce(cc.current_active,0),'newConversations',coalesce(cn.new_conversations,0),
            'handledConversations',coalesce(ca.handled_conversations,0),'humanMessages',coalesce(ca.human_messages,0),
            'firstResponses',coalesce(cr.measured,0),'firstResponseAverageSeconds',cr.average_seconds,'firstResponseMedianSeconds',cr.median_seconds,
            'resolutions',coalesce(cx.measured,0),'resolutionAverageSeconds',cx.average_seconds,'resolutionMedianSeconds',cx.median_seconds
          ) ORDER BY k.channel) FROM channel_keys k LEFT JOIN channel_current cc ON cc.channel=k.channel
            LEFT JOIN channel_new cn ON cn.channel=k.channel LEFT JOIN channel_activity ca ON ca.channel=k.channel
            LEFT JOIN channel_response cr ON cr.channel=k.channel LEFT JOIN channel_resolution cx ON cx.channel=k.channel),'[]'::jsonb),
          'agentOptions',coalesce((SELECT jsonb_agg(jsonb_build_object('membershipId',d.id::text,'name',d.name,'teams',d.teams) ORDER BY lower(d.name),d.id) FROM agent_directory d),'[]'::jsonb),
          'agents',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'membershipId',membership_id,'name',name,'email',email,'teams',teams,
            'currentAssigned',current_assigned,'currentOpen',current_open,'currentPending',current_pending,'currentSnoozed',current_snoozed,
            'currentUnreplied',current_unreplied,'currentUrgent',current_urgent,'currentHigh',current_high,'currentByStatus',current_by_status,'currentByChannel',current_by_channel,
            'assignedInPeriod',assigned_in_period,'handledConversations',handled_conversations,'humanMessages',human_messages,'internalNotes',internal_notes,
            'firstResponses',first_responses,'firstResponseAverageSeconds',first_response_average_seconds,'firstResponseMedianSeconds',first_response_median_seconds,
            'resolutions',resolutions,'resolutionAverageSeconds',resolution_average_seconds,'resolutionMedianSeconds',resolution_median_seconds,'reassignments',reassignments
          )) FROM agent_rows WHERE ($4::uuid IS NULL OR membership_id::uuid=$4::uuid)),'[]'::jsonb)
        ) AS report FROM first_response_timing fr CROSS JOIN resolution_timing rt`, values)).rows[0];
      // The report query terminates in aggregate CTEs without GROUP BY, so it
      // always returns one row even when no conversations match.
      return { ...row!.report, filters: {
        from: filters.fromAt?.toISOString() ?? null, to: filters.toExclusiveAt?.toISOString() ?? null,
        agentId: filters.agentId, teamId: filters.teamId, channel: filters.channel,
        connectionId: filters.connectionId, labelId: filters.labelId, campaignId: filters.campaignId,
        priority: filters.priority, status: filters.status,
      } };
    });
  }
}

export function parseOperationalReportFilters(query: unknown): OperationalReportFilters {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const value = query as Record<string, unknown>;
  const allowed = new Set(['from','to','agentId','teamId','channel','connectionId','labelId','campaignId','priority','status']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalid();
  const fromAt = date(value['from'], false); const toExclusiveAt = date(value['to'], true);
  if (fromAt !== null && toExclusiveAt !== null && fromAt >= toExclusiveAt) throw invalid();
  const uuid = (key: string): string | null => {
    const candidate = value[key];
    if (candidate === undefined || candidate === '') return null;
    if (typeof candidate !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) throw invalid();
    return candidate.toLowerCase();
  };
  const enumeration = (key: string, choices: readonly string[]): string | null => {
    const candidate = value[key];
    if (candidate === undefined || candidate === '') return null;
    if (typeof candidate !== 'string' || !choices.includes(candidate)) throw invalid();
    return candidate;
  };
  return {
    fromAt, toExclusiveAt, agentId: uuid('agentId'), teamId: uuid('teamId'),
    channel: enumeration('channel', CHANNEL_KINDS), connectionId: uuid('connectionId'),
    labelId: uuid('labelId'), campaignId: uuid('campaignId'),
    priority: enumeration('priority', ['low','normal','high','urgent']),
    status: enumeration('status', ['open','pending','snoozed','resolved','archived']),
  };
}
function date(value: unknown, exclusive: boolean): Date | null { if (value === undefined || value === '') return null; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(); const at = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(at.getTime()) || at.toISOString().slice(0,10) !== value) throw invalid(); if (exclusive) at.setUTCDate(at.getUTCDate()+1); return at; }
function invalid(): ApiHttpError { return new ApiHttpError(400,'validation_failed','The report date range is invalid.'); }

function eventConversationDimensions(conversation: string, channel: string): string {
  return `(p.connection_id IS NULL OR ${conversation}.connection_id=p.connection_id)
    AND (p.channel IS NULL OR ${channel}.kind=p.channel)
    AND (p.label_id IS NULL OR EXISTS (SELECT 1 FROM conversation_labels current_label WHERE current_label.conversation_id=${conversation}.id AND current_label.label_id=p.label_id AND current_label.removed_at IS NULL))
    AND (p.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_conversation_attributions attribution WHERE attribution.conversation_id=${conversation}.id AND attribution.campaign_id=p.campaign_id))
    AND (p.priority IS NULL OR ${conversation}.priority=p.priority)
    AND (p.status IS NULL OR ${conversation}.status=p.status)`;
}

function currentConversationDimensions(conversation: string, channel: string): string {
  return `${eventConversationDimensions(conversation,channel)}
    AND (p.team_id IS NULL OR ${conversation}.team_id=p.team_id)`;
}

export async function validateReportEntities(
  sql: SqlExecutor,
  principal: Principal,
  filters: OperationalReportFilters,
  visibleAgentIds: readonly string[],
): Promise<void> {
  if (filters.agentId !== null && !visibleAgentIds.includes(filters.agentId)) throw notFound();
  const accessibleTeamIds = principal.scopes.filter((scope) => scope.type === 'team').map((scope) => scope.id);
  const accessibleInboxIds = principal.scopes.filter((scope) => scope.type === 'inbox').map((scope) => scope.id);
  const tenantReach = principal.grants['conversation.read'] === 'tenant' || principal.scopes.some((scope) => scope.type === 'tenant');
  const canSeeTeam = async (id: string): Promise<boolean> => {
    if (tenantReach || accessibleTeamIds.includes(id)) {
      const result = await sql.query('SELECT 1 FROM teams WHERE id=$1::uuid', [id]);
      return result.rowCount === 1;
    }
    const values: unknown[] = [id];
    const scope = readableScope(principal, (value) => { values.push(value); return `$${values.length}`; });
    const result = await sql.query(`SELECT 1 FROM conversations c WHERE c.team_id=$1::uuid AND ${scope} LIMIT 1`, values);
    return result.rowCount === 1;
  };
  const canSeeConnection = async (id: string): Promise<boolean> => {
    if (tenantReach || accessibleInboxIds.includes(id)) {
      const result = await sql.query('SELECT 1 FROM channel_connections WHERE id=$1::uuid', [id]);
      return result.rowCount === 1;
    }
    const values: unknown[] = [id];
    const scope = readableScope(principal, (value) => { values.push(value); return `$${values.length}`; });
    const result = await sql.query(`SELECT 1 FROM conversations c WHERE c.connection_id=$1::uuid AND ${scope} LIMIT 1`, values);
    return result.rowCount === 1;
  };
  if (filters.teamId !== null && !(await canSeeTeam(filters.teamId))) throw notFound();
  if (filters.connectionId !== null && !(await canSeeConnection(filters.connectionId))) throw notFound();
  if (filters.labelId !== null && (await sql.query('SELECT 1 FROM labels WHERE id=$1::uuid', [filters.labelId])).rowCount !== 1) throw notFound();
  if (filters.campaignId !== null && (await sql.query('SELECT 1 FROM campaigns WHERE id=$1::uuid', [filters.campaignId])).rowCount !== 1) throw notFound();
}

function notFound(): ApiHttpError { return new ApiHttpError(404,'resource_not_found','The requested report filter is not available.'); }
