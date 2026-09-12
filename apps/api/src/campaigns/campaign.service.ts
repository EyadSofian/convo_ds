import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CampaignState, SqlExecutor } from '@convo/domain';
import { applyCampaignTrigger, normalizeSearchText } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requestHash, type JsonValue } from '../idempotency/canonical-json.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG } from '../tokens.js';
import type { CampaignDraftInput } from './campaign-request.js';

export interface CampaignView {
  readonly id: string;
  readonly name: string;
  readonly objective: string | null;
  readonly connection_id: string;
  readonly state: CampaignState;
  readonly version: number;
  readonly revision_id: string;
  readonly revision: number;
  readonly revision_hash: string;
  readonly approved: boolean;
  readonly audience: { readonly total: number; readonly eligible: number; readonly excluded: number } | null;
  readonly execution: { readonly id: string; readonly state: string; readonly scheduled_for: string | null } | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly objective: string | null;
  readonly connection_id: string;
  readonly control_state: CampaignState;
  readonly version: number;
  readonly revision_id: string;
  readonly revision: number;
  readonly revision_hash: string;
  readonly approved: boolean;
  readonly counts: { total: number; eligible: number; excluded: number } | null;
  readonly execution_id: string | null;
  readonly execution_state: string | null;
  readonly scheduled_for: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface LockedCampaign {
  readonly id: string;
  readonly connection_id: string;
  readonly control_state: CampaignState;
  readonly current_revision_id: string;
  readonly version: number;
  readonly revision_hash: string;
  readonly audience_filter: Readonly<Record<string, unknown>>;
  readonly expires_at: Date | null;
  readonly budget_amount_minor: string;
  readonly budget_currency: string;
}

@Injectable()
export class CampaignService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  list(session: AuthenticatedSession, tenantId: string): Promise<readonly CampaignView[]> {
    return this.authorization.authorized(session, tenantId, 'campaign.read', async ({ sql }) =>
      (await readCampaigns(sql, null)).map(viewOf));
  }

  async create(
    session: AuthenticatedSession,
    tenantId: string,
    input: CampaignDraftInput,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignView> {
    this.authorization.assertTenantId(tenantId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId,
      tenantId,
      principalId: session.userId,
      operation: 'campaign.create',
      key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'campaign.draft');
      await requireConnection(sql, input.connectionId, false);
      const campaign = await sql.query<{ id: string }>(
        `INSERT INTO campaigns (tenant_id,name,objective,connection_id,created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
        [tenantId, input.name, input.objective, input.connectionId, principal.membershipId],
      );
      const campaignId = requireRow(campaign.rows, 'campaign insert returned no row').id;
      const hash = revisionHash(input);
      const revision = await sql.query<{ id: string }>(
        `INSERT INTO campaign_revisions
           (tenant_id,campaign_id,revision,variables,audience_filter,content,timezone,expires_at,
            budget_amount_minor,budget_currency,revision_hash,created_by_membership_id)
         VALUES ($1,$2,1,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING id::text`,
        [tenantId, campaignId, JSON.stringify(input.variables), JSON.stringify(input.audienceFilter),
          JSON.stringify(input.content), input.timezone, input.expiresAt, input.budgetAmountMinor,
          input.budgetCurrency, hash, principal.membershipId],
      );
      const revisionId = requireRow(revision.rows, 'campaign revision insert returned no row').id;
      await sql.query(`UPDATE campaigns SET current_revision_id=$1 WHERE id=$2`, [revisionId, campaignId]);
      await audit(sql, tenantId, campaignId, revisionId, principal.membershipId, 'created', { revision: 1 });
      return { statusCode: 201, body: viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign disappeared')) };
    });
    if (outcome.status === 'conflict') throw idempotencyConflict();
    return outcome.response.body as CampaignView;
  }

  async validate(session: AuthenticatedSession, tenantId: string, campaignId: string): Promise<CampaignView> {
    this.authorization.assertTenantId(campaignId);
    return this.authorization.authorized(session, tenantId, 'campaign.draft', async ({ sql, principal }) => {
      const campaign = await locked(sql, campaignId);
      const started = transition(campaign.control_state, 'validate');
      await requireConnection(sql, campaign.connection_id, true);
      await sql.query(`UPDATE campaigns SET control_state=$2,version=version+1,updated_at=now() WHERE id=$1`, [campaignId, started.to]);
      const frozen = await freezeAudience(sql, tenantId, campaignId, campaign.current_revision_id,
        campaign.connection_id, campaign.audience_filter);
      const passed = transition(started.to, 'validation_passed');
      await sql.query(`UPDATE campaigns SET control_state=$2,version=version+1,updated_at=now() WHERE id=$1`, [campaignId, passed.to]);
      await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId, 'validated', frozen.counts);
      return viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign disappeared'));
    });
  }

  async approve(session: AuthenticatedSession, tenantId: string, campaignId: string): Promise<CampaignView> {
    this.authorization.assertTenantId(campaignId);
    return this.authorization.authorized(session, tenantId, 'campaign.approve', async ({ sql, principal }) => {
      const campaign = await locked(sql, campaignId);
      if (campaign.control_state !== 'ready') throw conflict('campaign_not_ready', 'Validate this campaign before approving it.');
      await unlessConstraint('campaign_approvals_live_uq', conflict('campaign_already_approved', 'This revision is already approved.'), () =>
        sql.query(
          `INSERT INTO campaign_approvals
             (tenant_id,campaign_id,revision_id,revision_hash,approver_membership_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [tenantId, campaignId, campaign.current_revision_id, campaign.revision_hash, principal.membershipId],
        ));
      await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId, 'approved', {});
      return viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign disappeared'));
    });
  }

  async launch(
    session: AuthenticatedSession,
    tenantId: string,
    campaignId: string,
    scheduledFor: string | null,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignView> {
    this.authorization.assertTenantId(campaignId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId, tenantId, principalId: session.userId,
      operation: `campaign.launch:${campaignId}`, key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'campaign.launch');
      const campaign = await locked(sql, campaignId);
      await requireConnection(sql, campaign.connection_id, true);
      if (campaign.expires_at !== null && campaign.expires_at.getTime() <= Date.now()) {
        throw conflict('campaign_expired', 'This campaign has expired.');
      }
      const approved = await sql.query(
        `SELECT 1 FROM campaign_approvals WHERE campaign_id=$1 AND revision_id=$2
          AND revision_hash=$3 AND revoked_at IS NULL`,
        [campaignId, campaign.current_revision_id, campaign.revision_hash],
      );
      if (approved.rowCount !== 1) throw conflict('approval_required', 'Approve this exact revision before launch.');
      const snapshot = await sql.query<{ id: string; eligible: number }>(
        `SELECT s.id::text, coalesce((s.counts->>'eligible')::int,0) AS eligible
           FROM audience_snapshots s WHERE s.revision_id=$1`, [campaign.current_revision_id],
      );
      const audience = snapshot.rows[0];
      if (audience === undefined) throw conflict('audience_required', 'Validate and freeze the audience before launch.');
      const trigger = scheduledFor === null ? 'launch_now' : 'launch_scheduled';
      const next = transition(campaign.control_state, trigger);
      const execution = await unlessConstraint('campaign_executions_once_uq', conflict('campaign_already_launched', 'A campaign can be launched only once. Clone it for another run.'), () =>
        sql.query<{ id: string }>(
          `INSERT INTO campaign_executions
             (tenant_id,campaign_id,revision_id,audience_snapshot_id,state,scheduled_for,started_at)
           VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6::timestamptz IS NULL THEN now() END) RETURNING id::text`,
          [tenantId, campaignId, campaign.current_revision_id, audience.id, next.to, scheduledFor],
        ));
      const executionId = requireRow(execution.rows, 'campaign execution insert returned no row').id;
      await sql.query(
        `INSERT INTO campaign_work_queue (execution_id,tenant_id,available_at,stop_version)
         VALUES ($1,$2,coalesce($3::timestamptz,now()),0)`,
        [executionId, tenantId, scheduledFor],
      );
      await sql.query(
        `INSERT INTO campaign_recipients
           (tenant_id,execution_id,contact_id,identity_id,rendered_variables,snapshot_eligibility,state)
         SELECT tenant_id,$2,contact_id,identity_id,rendered_variables,
                jsonb_build_object('eligibility',eligibility,'reason',reason),'planned'
           FROM audience_snapshot_members WHERE snapshot_id=$1 AND eligibility='eligible'`,
        [audience.id, executionId],
      );
      await sql.query(
        `INSERT INTO budget_reservations
           (tenant_id,execution_id,recipient_id,estimated_amount_minor,reserved_amount_minor,currency)
         SELECT tenant_id,$1,id,
                CASE WHEN $2::int=0 THEN 0 ELSE $3::numeric/$2::int END,
                CASE WHEN $2::int=0 THEN 0 ELSE $3::numeric/$2::int END,$4
           FROM campaign_recipients WHERE execution_id=$1`,
        [executionId, audience.eligible, campaign.budget_amount_minor, campaign.budget_currency],
      );
      await sql.query(`UPDATE campaigns SET control_state=$2,version=version+1,updated_at=now() WHERE id=$1`, [campaignId, next.to]);
      await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId, 'launched', { execution_id: executionId, scheduled_for: scheduledFor });
      return { statusCode: 202, body: viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign disappeared')) };
    });
    if (outcome.status === 'conflict') throw idempotencyConflict();
    return outcome.response.body as CampaignView;
  }

  async control(session: AuthenticatedSession, tenantId: string, campaignId: string, action: 'pause' | 'resume' | 'cancel'): Promise<CampaignView> {
    this.authorization.assertTenantId(campaignId);
    return this.authorization.authorized(session, tenantId, 'campaign.control', async ({ sql, principal }) => {
      const campaign = await locked(sql, campaignId);
      const first = transition(campaign.control_state, action);
      let state = first.to;
      if (action === 'pause') state = transition(state, 'pause_settled').to;
      if (action === 'cancel') {
        state = transition(state, 'cancel_settled').to;
      }
      await sql.query(`UPDATE campaigns SET control_state=$2,version=version+1,updated_at=now() WHERE id=$1`, [campaignId, state]);
      const execution = await sql.query<{ id: string; stop_version: string }>(
        `UPDATE campaign_executions SET state=$2,stop_version=stop_version+1,
                completed_at=CASE WHEN $2='cancelled' THEN now() END
          WHERE campaign_id=$1 RETURNING id::text,stop_version::text`, [campaignId, state],
      );
      const executionRow = execution.rows[0];
      if (executionRow !== undefined && action === 'resume') {
        await sql.query(
          `INSERT INTO campaign_work_queue (execution_id,tenant_id,available_at,stop_version)
           VALUES ($1,$2,now(),$3)
           ON CONFLICT (execution_id) DO UPDATE SET available_at=now(),stop_version=excluded.stop_version`,
          [executionRow.id, tenantId, executionRow.stop_version],
        );
        await sql.query(
          `UPDATE outbound_messages m SET campaign_stop_version=$2
            FROM campaign_recipients r WHERE r.execution_id=$1 AND r.command_id=m.id
              AND r.state='queued' AND m.command_state IN ('queued','retry_scheduled')`,
          [executionRow.id, executionRow.stop_version],
        );
      } else if (executionRow !== undefined) {
        await sql.query(`DELETE FROM campaign_work_queue WHERE execution_id=$1`, [executionRow.id]);
      }
      if (executionRow !== undefined && action === 'cancel') {
        const cancelled = await sql.query<{ command_id: string | null }>(
          `UPDATE campaign_recipients SET state='cancelled',updated_at=now()
            WHERE execution_id=$1 AND state IN ('planned','queued')
            RETURNING command_id::text`, [executionRow.id],
        );
        const commandIds = cancelled.rows.map((row) => row.command_id).filter((id) => id !== null);
        if (commandIds.length > 0) {
          await sql.query(`DELETE FROM outbox WHERE message_id=ANY($1::uuid[])`, [commandIds]);
          await sql.query(
            `UPDATE outbound_messages SET command_state='cancelled',state_reason='campaign_cancelled',settled_at=now(),dispatch_version=dispatch_version+1
              WHERE id=ANY($1::uuid[]) AND command_state IN ('queued','retry_scheduled')`, [commandIds],
          );
        }
        await sql.query(
          `UPDATE budget_reservations SET state='released',released_at=now(),reserved_amount_minor=0
            WHERE execution_id=$1 AND state='reserved' AND recipient_id IN
              (SELECT id FROM campaign_recipients WHERE execution_id=$1 AND state='cancelled')`, [executionRow.id],
        );
      }
      await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId, 'state_changed', { from: campaign.control_state, to: state });
      return viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign disappeared'));
    });
  }

  recipients(session: AuthenticatedSession, tenantId: string, campaignId: string) {
    this.authorization.assertTenantId(campaignId);
    return this.authorization.authorized(session, tenantId, 'campaign.read', async ({ sql }) => {
      const exists = await readCampaigns(sql, campaignId);
      if (exists.length === 0) throw notFound();
      const rows = await sql.query<{
        id: string; contact_id: string; display_name: string; external_id: string;
        state: string; last_error: unknown; estimated_amount_minor: string | null; currency: string | null;
      }>(
        `SELECT r.id::text,r.contact_id::text,c.display_name,i.external_id,r.state,r.last_error,
                b.estimated_amount_minor::text,b.currency
           FROM campaign_recipients r JOIN campaign_executions e ON e.id=r.execution_id
           JOIN contacts c ON c.id=r.contact_id JOIN contact_identities i ON i.id=r.identity_id
           LEFT JOIN budget_reservations b ON b.recipient_id=r.id
          WHERE e.campaign_id=$1 ORDER BY r.id`, [campaignId],
      );
      return rows.rows;
    });
  }
}

async function freezeAudience(
  sql: SqlExecutor,
  tenantId: string,
  campaignId: string,
  revisionId: string,
  connectionId: string,
  filter: Readonly<Record<string, unknown>>,
): Promise<{ readonly id: string; readonly counts: { readonly total: number; readonly eligible: number; readonly excluded: number } }> {
  const labelIds = Array.isArray(filter['labelIds']) ? filter['labelIds'] : [];
  const search = typeof filter['search'] === 'string' ? normalizeSearchText(filter['search']) : '';
  const frozen = await sql.query<{ id: string; counts: { total: number; eligible: number; excluded: number } }>(
    `WITH candidates AS MATERIALIZED (
       SELECT c.id AS contact_id,i.id AS identity_id,
       CASE WHEN c.deleted_at IS NOT NULL THEN 'contact_deleted'
            WHEN i.valid_to IS NOT NULL THEN 'identity_inactive'
            WHEN s.id IS NOT NULL THEN 'suppressed'
            WHEN consent.state IS DISTINCT FROM 'granted' THEN 'no_consent'
            ELSE 'eligible' END AS eligibility,
       jsonb_build_object('consent',coalesce(consent.state,'missing'),'suppressed',s.id IS NOT NULL) AS reason,
       (SELECT coalesce(jsonb_object_agg(variable.key,to_jsonb(c.display_name)),'{}'::jsonb)
          FROM jsonb_each_text((SELECT variables FROM campaign_revisions WHERE id=$5)) variable
         WHERE variable.value='display_name') AS rendered_variables
     FROM contacts c JOIN contact_identities i ON i.contact_id=c.id AND i.scope_id=$3
     LEFT JOIN channel_suppressions s ON s.kind=i.kind AND s.peer_identity=i.external_id
     LEFT JOIN LATERAL (
       SELECT state FROM consents x WHERE x.contact_id=c.id AND x.channel=i.kind AND x.purpose='marketing'
       ORDER BY recorded_at DESC,id DESC LIMIT 1
     ) consent ON true
     WHERE ($6::text='' OR c.search_name LIKE '%' || $6 || '%')
       AND (cardinality($7::uuid[])=0 OR NOT EXISTS (
         SELECT 1 FROM unnest($7::uuid[]) wanted(label_id)
          WHERE NOT EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=c.id
            AND cl.label_id=wanted.label_id AND cl.removed_at IS NULL)))
     ), totals AS (
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE eligibility='eligible')::int AS eligible,
              count(*) FILTER (WHERE eligibility<>'eligible')::int AS excluded FROM candidates
     ), snapshot AS (
       INSERT INTO audience_snapshots (tenant_id,campaign_id,revision_id,source,counts)
       SELECT $1,$4,$5,$2::jsonb,jsonb_build_object('total',total,'eligible',eligible,'excluded',excluded)
         FROM totals RETURNING id,counts
     ), members AS (
       INSERT INTO audience_snapshot_members
         (tenant_id,snapshot_id,contact_id,identity_id,eligibility,reason,rendered_variables)
       SELECT $1,snapshot.id,c.contact_id,c.identity_id,c.eligibility,c.reason,c.rendered_variables
         FROM candidates c CROSS JOIN snapshot RETURNING id
     )
     SELECT snapshot.id::text,snapshot.counts FROM snapshot`,
    [tenantId, JSON.stringify(filter), connectionId, campaignId, revisionId, search, labelIds],
  );
  return requireRow(frozen.rows, 'audience freeze returned no row');
}

async function requireConnection(sql: SqlExecutor, connectionId: string, requireHealthy: boolean): Promise<void> {
  const row = await sql.query<{ status: string }>(`SELECT status FROM channel_connections WHERE id=$1 AND disconnected_at IS NULL`, [connectionId]);
  if (row.rows[0] === undefined) throw notFound();
  if (requireHealthy && row.rows[0].status !== 'healthy') throw conflict('channel_not_ready', 'Test and connect the selected channel before launch.');
}

async function locked(sql: SqlExecutor, campaignId: string): Promise<LockedCampaign> {
  const result = await sql.query<LockedCampaign>(
    `SELECT c.id::text,c.connection_id::text,c.control_state,c.current_revision_id::text,c.version,
            r.revision_hash,r.audience_filter,r.expires_at,r.budget_amount_minor::text,r.budget_currency
       FROM campaigns c JOIN campaign_revisions r ON r.id=c.current_revision_id
      WHERE c.id=$1 FOR UPDATE OF c`, [campaignId],
  );
  if (result.rows[0] === undefined) throw notFound();
  return result.rows[0];
}

function transition(state: CampaignState, trigger: Parameters<typeof applyCampaignTrigger>[1]) {
  const result = applyCampaignTrigger(state, trigger);
  if (result.refusal !== null) throw conflict(result.refusal, `Campaign cannot ${trigger.replaceAll('_', ' ')} from ${state}.`);
  return result;
}

async function readCampaigns(sql: SqlExecutor, id: string | null): Promise<readonly CampaignRow[]> {
  const result = await sql.query<CampaignRow>(
    `SELECT c.id::text,c.name,c.objective,c.connection_id::text,c.control_state,c.version,
            r.id::text AS revision_id,r.revision,r.revision_hash,
            EXISTS(SELECT 1 FROM campaign_approvals a WHERE a.revision_id=r.id AND a.revision_hash=r.revision_hash AND a.revoked_at IS NULL) AS approved,
            s.counts,e.id::text AS execution_id,e.state AS execution_state,e.scheduled_for,c.created_at,c.updated_at
       FROM campaigns c JOIN campaign_revisions r ON r.id=c.current_revision_id
       LEFT JOIN audience_snapshots s ON s.revision_id=r.id
       LEFT JOIN campaign_executions e ON e.campaign_id=c.id
      WHERE ($1::uuid IS NULL OR c.id=$1) ORDER BY c.created_at DESC,c.id`, [id],
  );
  return result.rows;
}

function viewOf(row: CampaignRow): CampaignView {
  const counts = row.counts;
  return {
    id: row.id, name: row.name, objective: row.objective, connection_id: row.connection_id,
    state: row.control_state, version: row.version, revision_id: row.revision_id,
    revision: row.revision, revision_hash: row.revision_hash, approved: row.approved,
    audience: counts === null ? null : { total: counts.total, eligible: counts.eligible, excluded: counts.excluded },
    execution: row.execution_id === null ? null : { id: row.execution_id, state: row.execution_state as string,
      scheduled_for: row.scheduled_for?.toISOString() ?? null },
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function revisionHash(input: CampaignDraftInput): string {
  return createHash('sha256').update(JSON.stringify({
    connectionId: input.connectionId, content: input.content, variables: input.variables,
    audienceFilter: input.audienceFilter, timezone: input.timezone, expiresAt: input.expiresAt,
    budgetAmountMinor: input.budgetAmountMinor, budgetCurrency: input.budgetCurrency,
  })).digest('hex');
}

async function audit(sql: SqlExecutor, tenantId: string, campaignId: string, revisionId: string, actor: string, act: string, detail: unknown): Promise<void> {
  await sql.query(`INSERT INTO campaign_audit (tenant_id,campaign_id,revision_id,actor_membership_id,act,detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [tenantId, campaignId, revisionId, actor, act, JSON.stringify(detail)]);
}

function notFound(): ApiHttpError { return new ApiHttpError(404, 'resource_not_found', 'The requested campaign does not exist.'); }
function conflict(code: string, message: string): ApiHttpError { return new ApiHttpError(409, code, message); }
function idempotencyConflict(): ApiHttpError { return conflict('idempotency_key_reused', 'This Idempotency-Key was already used with a different request.'); }
