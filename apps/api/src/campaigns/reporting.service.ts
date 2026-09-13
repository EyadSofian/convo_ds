import { Inject, Injectable } from '@nestjs/common';
import type { SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { requireRow } from '../require-row.js';
import type { CampaignReportFilters } from './campaign-request.js';

export interface CampaignReport {
  readonly generated_at: string;
  readonly fresh_through: string;
  readonly timezone: 'UTC';
  /** The scope the numbers below were computed over, echoed as requested. */
  readonly filters: {
    readonly from: string | null;
    readonly to: string | null;
    readonly channel: string | null;
    readonly campaign_id: string | null;
  };
  readonly definitions: {
    readonly campaigns: number;
    readonly executions: number;
  };
  readonly audience: {
    readonly denominator: number;
    readonly eligible: number;
    readonly excluded: number;
  };
  readonly current: {
    readonly denominator: number; readonly planned: number; readonly queued: number; readonly in_flight: number;
    readonly accepted: number; readonly delivered: number; readonly read: number; readonly failed: number;
    readonly skipped: number; readonly cancelled: number; readonly outcome_unknown: number;
  };
  readonly milestones: {
    readonly denominator: number;
    readonly accepted: number;
    readonly delivered: number;
    readonly read: number;
  };
  readonly costs: readonly {
    readonly currency: string;
    readonly estimated_amount_minor: string;
    readonly committed_amount_minor: string;
    readonly reconciled_amount_minor: string;
  }[];
  readonly channels: readonly {
    readonly kind: string;
    readonly denominator: number;
    readonly accepted: number;
    readonly delivered: number;
    readonly read: number;
    readonly delivery_receipts: boolean;
    readonly read_receipts: boolean;
  }[];
  readonly errors: readonly { readonly code: string; readonly count: number }[];
  /**
   * Recipients grouped by the UTC day their execution launched.
   *
   * The launch day, not the last-update day: a recipient delivered on Tuesday
   * for a Monday launch belongs to Monday's volume, or every late receipt would
   * move volume between days after the fact.
   */
  readonly trend: readonly {
    readonly day: string;
    readonly recipients: number;
    readonly accepted: number;
    readonly delivered: number;
    readonly read: number;
    readonly failed: number;
  }[];
  readonly campaigns: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly denominator: number;
    readonly pending: number;
    readonly accepted: number;
    readonly delivered: number;
    readonly read: number;
    readonly failed: number;
    readonly outcome_unknown: number;
    /** From the execution's frozen audience snapshot; null before launch. */
    readonly included: number | null;
    readonly excluded: number | null;
    readonly fresh_through: string;
  }[];
}

type ReportProjection = Omit<CampaignReport, 'filters'>;

interface ReportRow { readonly report: ReportProjection }

export const UNFILTERED_REPORT: CampaignReportFilters = {
  from: null, to: null, channel: null, campaignId: null, fromAt: null, toExclusiveAt: null,
};

@Injectable()
export class CampaignReportingService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  report(
    session: AuthenticatedSession,
    tenantId: string,
    filters: CampaignReportFilters = UNFILTERED_REPORT,
  ): Promise<CampaignReport> {
    return this.authorization.authorized(session, tenantId, 'report.read', async ({ sql }) => {
      const projection = requireRow((await reportQuery(sql, filters)).rows, 'campaign report returned no row').report;
      return {
        ...projection,
        filters: { from: filters.from, to: filters.to, channel: filters.channel, campaign_id: filters.campaignId },
      };
    });
  }
}

/**
 * One aggregate over one scope.
 *
 * Every figure is computed from the same scoped recipients, so a filtered KPI
 * and the filtered breakdown beneath it cannot disagree about their
 * denominator. The date filter selects executions by launch instant; channel
 * and campaign select campaigns. With no filter the scope is everything the
 * tenant's RLS lets this transaction read, exactly as before.
 */
export function reportQuery(sql: SqlExecutor, filters: CampaignReportFilters) {
  return sql.query<ReportRow>(`
    WITH
    params AS (
      SELECT $1::timestamptz AS from_at, $2::timestamptz AS to_at, $3::text AS channel, $4::uuid AS campaign_id,
             ($1::timestamptz IS NOT NULL OR $2::timestamptz IS NOT NULL) AS dated
    ),
    scoped_campaigns AS (
      SELECT c.id,c.name,c.control_state,c.created_at,c.updated_at
        FROM campaigns c
        JOIN channel_connections connection ON connection.id=c.connection_id
        CROSS JOIN params p
       WHERE (p.channel IS NULL OR connection.kind=p.channel)
         AND (p.campaign_id IS NULL OR c.id=p.campaign_id)
    ),
    scoped_executions AS (
      SELECT e.id,e.campaign_id,e.audience_snapshot_id,e.launched_at,e.started_at,e.completed_at
        FROM campaign_executions e
        JOIN scoped_campaigns c ON c.id=e.campaign_id
        CROSS JOIN params p
       WHERE (p.from_at IS NULL OR e.launched_at >= p.from_at)
         AND (p.to_at IS NULL OR e.launched_at < p.to_at)
    ),
    report_campaigns AS (
      SELECT c.* FROM scoped_campaigns c CROSS JOIN params p
       WHERE NOT p.dated OR EXISTS (SELECT 1 FROM scoped_executions e WHERE e.campaign_id=c.id)
    ),
    scoped_rows AS (
      SELECT r.*,e.launched_at FROM campaign_report_rows r JOIN scoped_executions e ON e.id=r.execution_id
    ),
    definitions AS (
      SELECT count(DISTINCT c.id)::int AS campaigns,
             count(e.id)::int AS executions,
             coalesce(max(greatest(c.updated_at,coalesce(e.completed_at,e.started_at,e.launched_at))),now()) AS fresh_through
        FROM report_campaigns c LEFT JOIN scoped_executions e ON e.campaign_id=c.id
    ),
    audience AS (
      SELECT coalesce(sum((s.counts->>'total')::int),0)::int AS denominator,
             coalesce(sum((s.counts->>'eligible')::int),0)::int AS eligible,
             coalesce(sum((s.counts->>'excluded')::int),0)::int AS excluded
        FROM audience_snapshots s
        JOIN report_campaigns c ON c.id=s.campaign_id
        CROSS JOIN params p
       WHERE NOT p.dated OR EXISTS (SELECT 1 FROM scoped_executions e WHERE e.audience_snapshot_id=s.id)
    ),
    current_counts AS (
      SELECT count(*)::int AS denominator,
             count(*) FILTER (WHERE current_state='planned')::int AS planned,
             count(*) FILTER (WHERE current_state='queued')::int AS queued,
             count(*) FILTER (WHERE current_state='in_flight')::int AS in_flight,
             count(*) FILTER (WHERE current_state='accepted')::int AS accepted,
             count(*) FILTER (WHERE current_state='delivered')::int AS delivered,
             count(*) FILTER (WHERE current_state='read')::int AS read,
             count(*) FILTER (WHERE current_state='failed')::int AS failed,
             count(*) FILTER (WHERE current_state='skipped')::int AS skipped,
             count(*) FILTER (WHERE current_state='cancelled')::int AS cancelled,
             count(*) FILTER (WHERE current_state='outcome_unknown')::int AS outcome_unknown,
             coalesce(max(fresh_through),now()) AS fresh_through
        FROM scoped_rows
    ),
    milestone_counts AS (
      SELECT count(*)::int AS denominator,
             count(*) FILTER (WHERE accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE read_milestone)::int AS read
        FROM scoped_rows
    ),
    cost_rows AS (
      SELECT currency,
             coalesce(sum(estimated_amount_minor),0)::text AS estimated_amount_minor,
             coalesce(sum(committed_amount_minor),0)::text AS committed_amount_minor,
             coalesce(sum(reconciled_amount_minor),0)::text AS reconciled_amount_minor
        FROM scoped_rows WHERE currency IS NOT NULL GROUP BY currency ORDER BY currency
    ),
    channel_rows AS (
      SELECT channel_kind AS kind,count(*)::int AS denominator,
             count(*) FILTER (WHERE accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE read_milestone)::int AS read,
             bool_and(delivery_receipts) AS delivery_receipts,
             bool_and(read_receipts) AS read_receipts
        FROM scoped_rows GROUP BY channel_kind ORDER BY channel_kind
    ),
    error_rows AS (
      SELECT coalesce(error_code,'unspecified') AS code,count(*)::int AS count
        FROM scoped_rows
       WHERE current_state IN ('failed','skipped','outcome_unknown')
       GROUP BY coalesce(error_code,'unspecified') ORDER BY count DESC,code
    ),
    trend_rows AS (
      SELECT to_char(launched_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
             count(*)::int AS recipients,
             count(*) FILTER (WHERE accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE read_milestone)::int AS read,
             count(*) FILTER (WHERE current_state='failed')::int AS failed
        FROM scoped_rows GROUP BY 1 ORDER BY 1
    ),
    campaign_rows AS (
      SELECT c.id::text,c.name,c.control_state AS state,count(r.recipient_id)::int AS denominator,
             count(*) FILTER (WHERE r.current_state IN ('planned','queued','in_flight'))::int AS pending,
             count(*) FILTER (WHERE r.accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE r.delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE r.read_milestone)::int AS read,
             count(*) FILTER (WHERE r.current_state='failed')::int AS failed,
             count(*) FILTER (WHERE r.current_state='outcome_unknown')::int AS outcome_unknown,
             (s.counts->>'eligible')::int AS included,
             (s.counts->>'excluded')::int AS excluded,
             greatest(c.updated_at,coalesce(max(r.fresh_through),c.updated_at)) AS fresh_through
        FROM report_campaigns c
        LEFT JOIN scoped_executions e ON e.campaign_id=c.id
        LEFT JOIN audience_snapshots s ON s.id=e.audience_snapshot_id
        LEFT JOIN scoped_rows r ON r.execution_id=e.id
       GROUP BY c.id,c.name,c.control_state,c.created_at,c.updated_at,s.counts
       ORDER BY c.created_at DESC,c.id
    )
    SELECT jsonb_build_object(
      'generated_at',now(),
      'fresh_through',greatest(d.fresh_through,cc.fresh_through),
      'timezone','UTC',
      'definitions',jsonb_build_object('campaigns',d.campaigns,'executions',d.executions),
      'audience',to_jsonb(a),
      'current',to_jsonb(cc) - 'fresh_through',
      'milestones',to_jsonb(mc),
      'costs',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM cost_rows x),'[]'::jsonb),
      'channels',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM channel_rows x),'[]'::jsonb),
      'errors',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM error_rows x),'[]'::jsonb),
      'trend',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM trend_rows x),'[]'::jsonb),
      'campaigns',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM campaign_rows x),'[]'::jsonb)
    ) AS report
    FROM definitions d CROSS JOIN audience a CROSS JOIN current_counts cc CROSS JOIN milestone_counts mc
  `, [filters.fromAt, filters.toExclusiveAt, filters.channel, filters.campaignId]);
}
