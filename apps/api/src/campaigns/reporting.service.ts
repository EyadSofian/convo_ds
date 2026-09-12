import { Inject, Injectable } from '@nestjs/common';
import type { SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { requireRow } from '../require-row.js';

export interface CampaignReport {
  readonly generated_at: string;
  readonly fresh_through: string;
  readonly timezone: 'UTC';
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
  readonly campaigns: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly denominator: number;
    readonly accepted: number;
    readonly delivered: number;
    readonly read: number;
    readonly failed: number;
    readonly outcome_unknown: number;
    readonly fresh_through: string;
  }[];
}

interface ReportRow { readonly report: CampaignReport }

@Injectable()
export class CampaignReportingService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  report(session: AuthenticatedSession, tenantId: string): Promise<CampaignReport> {
    return this.authorization.authorized(session, tenantId, 'report.read', async ({ sql }) =>
      requireRow((await reportQuery(sql)).rows, 'campaign report returned no row').report);
  }
}

export function reportQuery(sql: SqlExecutor) {
  return sql.query<ReportRow>(`
    WITH
    definitions AS (
      SELECT count(*)::int AS campaigns,
             count(e.id)::int AS executions,
             coalesce(max(greatest(c.updated_at,coalesce(e.completed_at,e.started_at,e.launched_at))),now()) AS fresh_through
        FROM campaigns c LEFT JOIN campaign_executions e ON e.campaign_id=c.id
    ),
    audience AS (
      SELECT coalesce(sum((counts->>'total')::int),0)::int AS denominator,
             coalesce(sum((counts->>'eligible')::int),0)::int AS eligible,
             coalesce(sum((counts->>'excluded')::int),0)::int AS excluded
        FROM audience_snapshots
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
        FROM campaign_report_rows
    ),
    milestone_counts AS (
      SELECT count(*)::int AS denominator,
             count(*) FILTER (WHERE accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE read_milestone)::int AS read
        FROM campaign_report_rows
    ),
    cost_rows AS (
      SELECT currency,
             coalesce(sum(estimated_amount_minor),0)::text AS estimated_amount_minor,
             coalesce(sum(committed_amount_minor),0)::text AS committed_amount_minor,
             coalesce(sum(reconciled_amount_minor),0)::text AS reconciled_amount_minor
        FROM campaign_report_rows WHERE currency IS NOT NULL GROUP BY currency ORDER BY currency
    ),
    channel_rows AS (
      SELECT channel_kind AS kind,count(*)::int AS denominator,
             count(*) FILTER (WHERE accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE read_milestone)::int AS read,
             bool_and(delivery_receipts) AS delivery_receipts,
             bool_and(read_receipts) AS read_receipts
        FROM campaign_report_rows GROUP BY channel_kind ORDER BY channel_kind
    ),
    error_rows AS (
      SELECT coalesce(error_code,'unspecified') AS code,count(*)::int AS count
        FROM campaign_report_rows
       WHERE current_state IN ('failed','skipped','outcome_unknown')
       GROUP BY coalesce(error_code,'unspecified') ORDER BY count DESC,code
    ),
    campaign_rows AS (
      SELECT c.id::text,c.name,c.control_state AS state,count(r.recipient_id)::int AS denominator,
             count(*) FILTER (WHERE r.accepted_milestone)::int AS accepted,
             count(*) FILTER (WHERE r.delivered_milestone)::int AS delivered,
             count(*) FILTER (WHERE r.read_milestone)::int AS read,
             count(*) FILTER (WHERE r.current_state='failed')::int AS failed,
             count(*) FILTER (WHERE r.current_state='outcome_unknown')::int AS outcome_unknown,
             greatest(c.updated_at,coalesce(max(r.fresh_through),c.updated_at)) AS fresh_through
        FROM campaigns c LEFT JOIN campaign_report_rows r ON r.campaign_id=c.id
       GROUP BY c.id,c.name,c.control_state,c.updated_at ORDER BY c.created_at DESC,c.id
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
      'campaigns',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM campaign_rows x),'[]'::jsonb)
    ) AS report
    FROM definitions d CROSS JOIN audience a CROSS JOIN current_counts cc CROSS JOIN milestone_counts mc
  `);
}
