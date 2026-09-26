import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CampaignState, SqlExecutor } from '@convo/domain';
import { applyCampaignTrigger, bindingsComplete, campaignEditTarget, defineWhatsAppTemplate, normalizeSearchText } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requestHash, type JsonValue } from '../idempotency/canonical-json.js';
import { IdempotencyService, type IdempotencyResult } from '../idempotency/idempotency.service.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG } from '../tokens.js';
import { fieldText, prepareTemplate } from '../channels/template-send.js';
import { campaignCommandContent } from './campaign-dispatch.js';
import { boundTemplateOf } from './campaign-request.js';
import type { AudiencePreviewInput, CampaignDraftInput, CampaignTestSendInput, CampaignUpdateInput, TestRecipientInput } from './campaign-request.js';

/** What a campaign on one channel would reach, before anything is frozen. */
export interface AudiencePreview {
  readonly total: number;
  readonly eligible: number;
  readonly excluded: number;
  /** Why the excluded are excluded; one reason each, in order of authority. */
  readonly reasons: {
    readonly suppressed: number;
    readonly no_consent: number;
    readonly identity_inactive: number;
  };
  /** Up to five eligible display names, so the operator can sanity-check the list. */
  readonly sample: readonly string[];
}

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
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audience_filter: Readonly<Record<string, unknown>>;
  readonly timezone: string;
  readonly expires_at: string | null;
  readonly budget_amount_minor: string;
  readonly budget_currency: string;
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
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audience_filter: Readonly<Record<string, unknown>>;
  readonly timezone: string;
  readonly expires_at: Date | null;
  readonly budget_amount_minor: string;
  readonly budget_currency: string;
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
  readonly revision: number;
  readonly version: number;
  readonly revision_hash: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audience_filter: Readonly<Record<string, unknown>>;
  readonly expires_at: Date | null;
  readonly budget_amount_minor: string;
  readonly budget_currency: string;
}

export interface TestRecipientView {
  readonly id: string;
  readonly connection_id: string;
  readonly identity_id: string;
  readonly peer_identity: string;
  readonly display_name: string;
  readonly label: string;
  readonly authorized_at: string;
}

export interface CampaignTestSendView {
  readonly id: string;
  readonly campaign_id: string;
  readonly revision_id: string;
  readonly test_recipient_id: string;
  readonly recipient_label: string;
  readonly peer_identity: string;
  readonly message_id: string;
  readonly state: string;
  readonly state_reason: string | null;
  readonly created_at: string;
}

export interface CampaignRetryView {
  readonly id: string;
  readonly campaign_id: string;
  readonly execution_id: string;
  readonly recipient_count: number;
  readonly state: 'running';
  readonly requested_at: string;
}

interface FailedRecipientRow {
  readonly id: string;
  readonly command_id: string;
  readonly last_error: Readonly<Record<string, unknown>> | null;
  readonly connection_id: string;
  readonly peer_identity: string;
  readonly message_type: string;
  readonly text_body: string | null;
  readonly template_name: string | null;
  readonly template_language: string | null;
}

interface CloneSource {
  readonly objective: string | null;
  readonly connection_id: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audience_filter: Readonly<Record<string, unknown>>;
  readonly content: Readonly<Record<string, unknown>>;
  readonly timezone: string;
  readonly expires_at: Date | null;
  readonly budget_amount_minor: string;
  readonly budget_currency: string;
  readonly revision_hash: string;
}

@Injectable()
export class CampaignService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * The audience a filter would freeze, counted but not frozen: the same
   * candidates and the same eligibility rules as `validate`, with nothing
   * written, so an operator can shape the audience before creating a draft.
   */
  previewAudience(session: AuthenticatedSession, tenantId: string, input: AudiencePreviewInput): Promise<AudiencePreview> {
    return this.authorization.authorized(session, tenantId, 'campaign.draft', async ({ sql }) => {
      await requireConnection(sql, input.connectionId, false);
      const filter = input.audienceFilter;
      const rows = await sql.query<AudiencePreview>(
        `WITH candidates AS MATERIALIZED (
           SELECT c.display_name, ${ELIGIBILITY} AS eligibility
           ${audienceScope({ connection: '$1', search: '$2', labels: '$3', conversationLabels: '$4', contacts: '$5' })}
         )
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE eligibility='eligible')::int AS eligible,
                count(*) FILTER (WHERE eligibility<>'eligible')::int AS excluded,
                jsonb_build_object(
                  'suppressed', count(*) FILTER (WHERE eligibility='suppressed'),
                  'no_consent', count(*) FILTER (WHERE eligibility='no_consent'),
                  'identity_inactive', count(*) FILTER (WHERE eligibility IN ('identity_inactive','contact_deleted'))
                ) AS reasons,
                coalesce((SELECT jsonb_agg(name) FROM (
                  SELECT display_name AS name FROM candidates WHERE eligibility='eligible' ORDER BY lower(display_name) LIMIT 5
                ) sample), '[]'::jsonb) AS sample
           FROM candidates`,
        [input.connectionId, normalizeSearchText(filter.search ?? ''), filter.labelIds ?? [],
          filter.conversationLabelIds ?? [], filter.contactIds ?? []],
      );
      return requireRow(rows.rows, 'audience preview returned no row');
    });
  }

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
      input = await withCatalogueTemplate(sql, input);
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
    return idempotentBody(outcome) as CampaignView;
  }

  async update(
    session: AuthenticatedSession,
    tenantId: string,
    campaignId: string,
    input: CampaignUpdateInput,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignView> {
    this.authorization.assertTenantId(campaignId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId, tenantId, principalId: session.userId,
      operation: `campaign.update:${campaignId}`, key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'campaign.draft');
      const campaign = await locked(sql, campaignId);
      const target = campaignEditTarget(campaign.control_state);
      if (target === null) throw conflict('campaign_edit_locked', 'A launched campaign cannot be edited. Clone it into a new draft.');
      if (campaign.version !== input.expectedVersion) throw conflict('version_conflict', 'The campaign changed after you opened it. Reload before saving.');
      await requireConnection(sql, input.connectionId, false);
      input = { ...await withCatalogueTemplate(sql, input), expectedVersion: input.expectedVersion };
      const hash = revisionHash(input);
      if (hash === campaign.revision_hash) {
        await sql.query(
          `UPDATE campaigns SET name=$2,objective=$3,version=version+1,updated_at=now() WHERE id=$1`,
          [campaignId, input.name, input.objective],
        );
        await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId, 'revised', { revision: campaign.revision, definition_changed: false });
      } else {
        const revision = await sql.query<{ id: string }>(
          `INSERT INTO campaign_revisions
             (tenant_id,campaign_id,revision,variables,audience_filter,content,timezone,expires_at,
              budget_amount_minor,budget_currency,revision_hash,created_by_membership_id)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12) RETURNING id::text`,
          [tenantId, campaignId, campaign.revision + 1, JSON.stringify(input.variables), JSON.stringify(input.audienceFilter),
            JSON.stringify(input.content), input.timezone, input.expiresAt, input.budgetAmountMinor,
            input.budgetCurrency, hash, principal.membershipId],
        );
        const revisionId = requireRow(revision.rows, 'campaign update revision insert returned no row').id;
        await sql.query(
          `UPDATE campaigns SET name=$2,objective=$3,connection_id=$4,current_revision_id=$5,
                  control_state=$6,version=version+1,updated_at=now() WHERE id=$1`,
          [campaignId, input.name, input.objective, input.connectionId, revisionId, target],
        );
        await audit(sql, tenantId, campaignId, revisionId, principal.membershipId, 'revised', { from_revision: campaign.revision, to_revision: campaign.revision + 1, definition_changed: true });
      }
      return { statusCode: 200, body: viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign update disappeared')) };
    });
    return idempotentBody(outcome) as CampaignView;
  }

  async listTestRecipients(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
  ): Promise<readonly TestRecipientView[]> {
    this.authorization.assertTenantId(connectionId);
    return this.authorization.authorized(session, tenantId, 'campaign.read', async ({ sql }) => {
      await requireConnection(sql, connectionId, false);
      return readTestRecipients(sql, connectionId);
    });
  }

  async authorizeTestRecipient(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
    input: TestRecipientInput,
  ): Promise<TestRecipientView> {
    this.authorization.assertTenantId(connectionId);
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql, principal }) => {
      await requireConnection(sql, connectionId, false);
      const identity = await sql.query<{ id: string }>(
        `SELECT i.id::text FROM contact_identities i JOIN contacts c ON c.id=i.contact_id
          WHERE i.scope_id=$1 AND i.external_id=$2 AND i.valid_to IS NULL AND c.deleted_at IS NULL`,
        [connectionId, input.peerIdentity],
      );
      const identityId = identity.rows[0]?.id;
      if (identityId === undefined) {
        throw new ApiHttpError(422, 'test_recipient_unknown', 'The test recipient must be a live contact identity on this channel.');
      }
      const inserted = await unlessConstraint(
        'channel_test_recipients_live_uq',
        conflict('test_recipient_already_authorized', 'That identity is already authorized for test sends.'),
        () => sql.query<{ id: string }>(
          `INSERT INTO channel_test_recipients
             (tenant_id,connection_id,identity_id,label,authorized_by_membership_id)
           VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
          [tenantId, connectionId, identityId, input.label, principal.membershipId],
        ),
      );
      return requireRow(await readTestRecipients(sql, connectionId, requireRow(inserted.rows, 'test recipient insert returned no row').id), 'test recipient disappeared');
    });
  }

  async revokeTestRecipient(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
    authorizationId: string,
  ): Promise<void> {
    this.authorization.assertTenantId(connectionId);
    this.authorization.assertTenantId(authorizationId);
    await this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql, principal }) => {
      const revoked = await sql.query(
        `UPDATE channel_test_recipients
            SET revoked_at=now(),revoked_by_membership_id=$3
          WHERE id=$1 AND connection_id=$2 AND revoked_at IS NULL`,
        [authorizationId, connectionId, principal.membershipId],
      );
      if (revoked.rowCount !== 1) throw notFound();
    });
  }

  async testSend(
    session: AuthenticatedSession,
    tenantId: string,
    campaignId: string,
    input: CampaignTestSendInput,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignTestSendView> {
    this.authorization.assertTenantId(campaignId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId, tenantId, principalId: session.userId,
      operation: `campaign.test-send:${campaignId}`, key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'campaign.draft');
      const campaign = await locked(sql, campaignId);
      if (campaignEditTarget(campaign.control_state) === null) {
        throw conflict('campaign_test_send_locked', 'Test the current definition before launch, or clone this campaign.');
      }
      if (campaign.version !== input.expectedVersion) {
        throw conflict('version_conflict', 'The campaign changed after you opened it. Reload before sending a test.');
      }
      await requireConnection(sql, campaign.connection_id, true);
      const recipient = await sql.query<{ authorization_id: string; external_id: string; label: string; rendered_variables: Readonly<Record<string, unknown>> }>(
        `SELECT tr.id::text AS authorization_id,i.external_id,tr.label,
                ${renderedVariables('$3::jsonb')} AS rendered_variables
           FROM channel_test_recipients tr
           JOIN contact_identities i ON i.id=tr.identity_id AND i.scope_id=tr.connection_id
           JOIN contacts c ON c.id=i.contact_id
          WHERE tr.id=$1 AND tr.connection_id=$2 AND tr.revoked_at IS NULL
            AND i.valid_to IS NULL AND c.deleted_at IS NULL`,
        [input.testRecipientId, campaign.connection_id, JSON.stringify(campaign.variables)],
      );
      const target = recipient.rows[0];
      if (target === undefined) {
        throw new ApiHttpError(422, 'test_recipient_not_authorized', 'Choose an active test recipient authorized for this channel.');
      }
      // The test recipient is rendered exactly as a frozen audience member would be.
      const rendered = campaignCommandContent(campaign.content, target.rendered_variables);
      const template = rendered?.templateId === undefined ? undefined : await prepareTemplate(sql, rendered.templateId, rendered.templateValues!);
      if (rendered === null || template === null) {
        throw new ApiHttpError(422, 'invalid_campaign_content', 'The current campaign content cannot be sent through the adapter.');
      }
      const testSendId = randomUUID();
      const messageId = randomUUID();
      await sql.query(
        `INSERT INTO outbound_messages
           (id,tenant_id,connection_id,peer_identity,author_membership,message_type,text_body,
            template_name,template_language,template_provider_id,template_components,template_preview,client_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
        [messageId, tenantId, campaign.connection_id, target.external_id, principal.membershipId,
          rendered.type, rendered.text, template?.name ?? rendered.templateName, template?.language ?? rendered.templateLanguage,
          template?.providerId ?? null, JSON.stringify(template?.components ?? []), template?.preview ?? null,
          `campaign-test:${testSendId}`],
      );
      await sql.query(
        `INSERT INTO campaign_test_sends
           (id,tenant_id,campaign_id,revision_id,authorization_id,message_id,requested_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [testSendId, tenantId, campaignId, campaign.current_revision_id, target.authorization_id, messageId, principal.membershipId],
      );
      await sql.query(
        `INSERT INTO outbox (message_id,tenant_id,connection_id,peer_identity,traffic_class)
         VALUES ($1,$2,$3,$4,'interactive')`,
        [messageId, tenantId, campaign.connection_id, target.external_id],
      );
      await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId,
        'test_sent', { test_send_id: testSendId, authorization_id: target.authorization_id });
      return { statusCode: 202, body: requireRow(await readTestSends(sql, testSendId), 'test send disappeared') };
    });
    return idempotentBody(outcome) as CampaignTestSendView;
  }

  async validate(session: AuthenticatedSession, tenantId: string, campaignId: string): Promise<CampaignView> {
    this.authorization.assertTenantId(campaignId);
    return this.authorization.authorized(session, tenantId, 'campaign.draft', async ({ sql, principal }) => {
      const campaign = await locked(sql, campaignId);
      const started = transition(campaign.control_state, 'validate');
      await requireConnection(sql, campaign.connection_id, true);
      await requireCatalogueTemplate(sql, campaign.connection_id, campaign.content);
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
    return idempotentBody(outcome) as CampaignView;
  }

  async clone(
    session: AuthenticatedSession,
    tenantId: string,
    sourceCampaignId: string,
    name: string,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignView> {
    this.authorization.assertTenantId(sourceCampaignId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId, tenantId, principalId: session.userId,
      operation: `campaign.clone:${sourceCampaignId}`, key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'campaign.draft');
      const sourceResult = await sql.query<CloneSource>(
        `SELECT c.objective,c.connection_id::text,r.variables,r.audience_filter,r.content,r.timezone,
                r.expires_at,r.budget_amount_minor::text,r.budget_currency,r.revision_hash
           FROM campaigns c JOIN campaign_revisions r ON r.id=c.current_revision_id
          WHERE c.id=$1`, [sourceCampaignId],
      );
      const source = sourceResult.rows[0];
      if (source === undefined) throw notFound();
      await requireConnection(sql, source.connection_id, false);
      const campaign = await sql.query<{ id: string }>(
        `INSERT INTO campaigns (tenant_id,name,objective,connection_id,created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
        [tenantId, name, source.objective, source.connection_id, principal.membershipId],
      );
      const campaignId = requireRow(campaign.rows, 'campaign clone insert returned no row').id;
      const revision = await sql.query<{ id: string }>(
        `INSERT INTO campaign_revisions
           (tenant_id,campaign_id,revision,variables,audience_filter,content,timezone,expires_at,
            budget_amount_minor,budget_currency,revision_hash,created_by_membership_id)
         VALUES ($1,$2,1,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING id::text`,
        [tenantId, campaignId, JSON.stringify(source.variables), JSON.stringify(source.audience_filter),
          JSON.stringify(source.content), source.timezone, source.expires_at,
          source.budget_amount_minor, source.budget_currency, source.revision_hash, principal.membershipId],
      );
      const revisionId = requireRow(revision.rows, 'campaign clone revision insert returned no row').id;
      await sql.query(`UPDATE campaigns SET current_revision_id=$1 WHERE id=$2`, [revisionId, campaignId]);
      await audit(sql, tenantId, campaignId, revisionId, principal.membershipId, 'cloned', { source_campaign_id: sourceCampaignId });
      return { statusCode: 201, body: viewOf(requireRow(await readCampaigns(sql, campaignId), 'campaign clone disappeared')) };
    });
    return idempotentBody(outcome) as CampaignView;
  }

  async retryFailures(
    session: AuthenticatedSession,
    tenantId: string,
    campaignId: string,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignRetryView> {
    this.authorization.assertTenantId(campaignId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId, tenantId, principalId: session.userId,
      operation: `campaign.retry-failures:${campaignId}`, key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'campaign.control');
      const campaign = await locked(sql, campaignId);
      const executionResult = await sql.query<{ id: string; state: string; stop_version: string }>(
        `SELECT id::text,state,stop_version::text FROM campaign_executions
          WHERE campaign_id=$1 FOR UPDATE`, [campaignId],
      );
      const execution = executionResult.rows[0];
      if (execution === undefined) {
        throw conflict('campaign_retry_not_launched', 'Launch this campaign before retrying failed recipients.');
      }
      const campaignRetryState = failedRetryTarget(campaign.control_state);
      const executionRetryState = failedRetryTarget(execution.state as CampaignState);
      const failed = await sql.query<FailedRecipientRow>(
        `SELECT cr.id::text,cr.command_id::text,cr.last_error,
                m.connection_id::text,m.peer_identity,m.message_type,m.text_body,
                m.template_name,m.template_language
           FROM campaign_recipients cr
           JOIN outbound_messages m ON m.id=cr.command_id
          WHERE cr.execution_id=$1 AND cr.state='failed'
          ORDER BY cr.id FOR UPDATE OF cr`, [execution.id],
      );
      if (failed.rows.length === 0) {
        throw conflict('no_failed_recipients', 'This campaign has no failed recipients to retry.');
      }

      const retryId = randomUUID();
      const retry = await sql.query<{ requested_at: Date }>(
        `INSERT INTO campaign_retry_runs
           (id,tenant_id,campaign_id,execution_id,requested_by_membership_id,recipient_count)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING requested_at`,
        [retryId, tenantId, campaignId, execution.id, principal.membershipId, failed.rows.length],
      );
      const resumed = await sql.query<{ stop_version: string }>(
        `UPDATE campaign_executions
            SET state=$2,completed_at=NULL,stop_version=stop_version+1
          WHERE id=$1 RETURNING stop_version::text`, [execution.id, executionRetryState],
      );
      const stopVersion = requireRow(resumed.rows, 'campaign retry did not resume execution').stop_version;

      for (const recipient of failed.rows) {
        const messageId = randomUUID();
        await sql.query(
          `INSERT INTO outbound_messages
             (id,tenant_id,connection_id,peer_identity,message_type,text_body,template_name,
              template_language,client_message_id,campaign_stop_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [messageId, tenantId, recipient.connection_id, recipient.peer_identity, recipient.message_type,
            recipient.text_body, recipient.template_name, recipient.template_language,
            `campaign-retry:${retryId}:${recipient.id}`, stopVersion],
        );
        await sql.query(
          `INSERT INTO campaign_retry_recipients
             (tenant_id,retry_run_id,recipient_id,previous_command_id,replacement_command_id,previous_error)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [tenantId, retryId, recipient.id, recipient.command_id, messageId,
            JSON.stringify(recipient.last_error ?? {})],
        );
        const reserved = await sql.query(
          `UPDATE budget_reservations
              SET state='reserved',reserved_amount_minor=estimated_amount_minor,
                  committed_amount_minor=NULL,reconciled_amount_minor=NULL,reconciled_at=NULL
            WHERE execution_id=$1 AND recipient_id=$2 AND state='released'`,
          [execution.id, recipient.id],
        );
        if (reserved.rowCount !== 1) {
          throw conflict('campaign_retry_budget_unavailable', 'The failed recipient no longer has a released budget reservation.');
        }
        await sql.query(
          `UPDATE campaign_recipients
              SET command_id=$2,state='queued',dispatch_eligibility=NULL,last_error=NULL,updated_at=now()
            WHERE id=$1`, [recipient.id, messageId],
        );
        await sql.query(
          `INSERT INTO outbox (message_id,tenant_id,connection_id,peer_identity,traffic_class)
           VALUES ($1,$2,$3,$4,'bulk')`,
          [messageId, tenantId, recipient.connection_id, recipient.peer_identity],
        );
      }

      await sql.query(
        `UPDATE campaigns SET control_state=$2,version=version+1,updated_at=now() WHERE id=$1`,
        [campaignId, campaignRetryState],
      );
      await audit(sql, tenantId, campaignId, campaign.current_revision_id, principal.membershipId,
        'retried', { retry_id: retryId, recipient_count: failed.rows.length });
      return {
        statusCode: 202,
        body: {
          id: retryId,
          campaign_id: campaignId,
          execution_id: execution.id,
          recipient_count: failed.rows.length,
          state: 'running',
          requested_at: requireRow(retry.rows, 'campaign retry run disappeared').requested_at.toISOString(),
        },
      };
    });
    return idempotentBody(outcome) as CampaignRetryView;
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

/**
 * One eligibility per candidate, in order of authority: a deleted contact or a
 * closed identity cannot be reached at all, an opt-out outranks any consent,
 * and only a latest marketing consent of `granted` makes a contact eligible.
 */
const ELIGIBILITY = `CASE WHEN c.deleted_at IS NOT NULL THEN 'contact_deleted'
            WHEN i.valid_to IS NOT NULL THEN 'identity_inactive'
            WHEN s.id IS NOT NULL THEN 'suppressed'
            WHEN consent.state IS DISTINCT FROM 'granted' THEN 'no_consent'
            ELSE 'eligible' END`;

/**
 * The contacts a campaign on one channel addresses: every contact with an
 * identity on the connection, narrowed by the filter. Shared by the freeze and
 * the preview so the two can never count different people. The arguments are
 * the positional parameters that carry each value.
 */
function audienceScope(p: {
  readonly connection: string;
  readonly search: string;
  readonly labels: string;
  readonly conversationLabels: string;
  readonly contacts: string;
}): string {
  return `FROM contacts c JOIN contact_identities i ON i.contact_id=c.id AND i.scope_id=${p.connection}
     LEFT JOIN channel_suppressions s ON s.kind=i.kind AND s.peer_identity=i.external_id
     LEFT JOIN LATERAL (
       SELECT state FROM consents x WHERE x.contact_id=c.id AND x.channel=i.kind AND x.purpose='marketing'
       ORDER BY recorded_at DESC,id DESC LIMIT 1
     ) consent ON true
     WHERE (${p.search}::text='' OR c.search_name LIKE '%' || ${p.search} || '%')
       AND (cardinality(${p.labels}::uuid[])=0 OR NOT EXISTS (
         SELECT 1 FROM unnest(${p.labels}::uuid[]) wanted(label_id)
          WHERE NOT EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=c.id
            AND cl.label_id=wanted.label_id AND cl.removed_at IS NULL)))
       AND (cardinality(${p.conversationLabels}::uuid[])=0 OR EXISTS (
         SELECT 1 FROM conversations v JOIN conversation_labels vl ON vl.conversation_id=v.id AND vl.removed_at IS NULL
          WHERE v.contact_id=c.id AND vl.label_id=ANY(${p.conversationLabels}::uuid[])))
       AND (cardinality(${p.contacts}::uuid[])=0 OR c.id=ANY(${p.contacts}::uuid[]))`;
}

/** A stored list, already validated as UUIDs when the revision was written. */
function uuidList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value as readonly string[] : [];
}

async function freezeAudience(
  sql: SqlExecutor,
  tenantId: string,
  campaignId: string,
  revisionId: string,
  connectionId: string,
  filter: Readonly<Record<string, unknown>>,
): Promise<{ readonly id: string; readonly counts: { readonly total: number; readonly eligible: number; readonly excluded: number } }> {
  const search = typeof filter['search'] === 'string' ? normalizeSearchText(filter['search']) : '';
  const frozen = await sql.query<{ id: string; counts: { total: number; eligible: number; excluded: number } }>(
    `WITH candidates AS MATERIALIZED (
       SELECT c.id AS contact_id,i.id AS identity_id,
       ${ELIGIBILITY} AS eligibility,
       jsonb_build_object('consent',coalesce(consent.state,'missing'),'suppressed',s.id IS NOT NULL) AS reason,
       ${renderedVariables('(SELECT variables FROM campaign_revisions WHERE id=$5)')} AS rendered_variables
     ${audienceScope({ connection: '$3', search: '$6', labels: '$7', conversationLabels: '$8', contacts: '$9' })}
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
    [tenantId, JSON.stringify(filter), connectionId, campaignId, revisionId, search,
      uuidList(filter['labelIds']), uuidList(filter['conversationLabelIds']), uuidList(filter['contactIds'])],
  );
  return requireRow(frozen.rows, 'audience freeze returned no row');
}

/**
 * Each variable of a revision, resolved for the contact `c` on identity `i`:
 * their name, the number the message goes to, a custom field, or fixed text.
 * A variable the contact has no value for is left out, so the fallback the
 * content names — or a skipped recipient — decides what happens.
 */
function renderedVariables(variables: string): string {
  return `(SELECT coalesce(jsonb_object_agg(variable.key,rendered.value) FILTER (WHERE rendered.value IS NOT NULL),'{}'::jsonb)
          FROM jsonb_each_text(${variables}) variable
          CROSS JOIN LATERAL (SELECT CASE
            WHEN variable.value='display_name' THEN to_jsonb(c.display_name)
            WHEN variable.value='phone' THEN to_jsonb(i.external_id)
            WHEN variable.value LIKE 'static:%' THEN to_jsonb(substr(variable.value,8))
            WHEN variable.value LIKE 'field:%' THEN (SELECT to_jsonb(${fieldText('fv.value_json')})
              FROM contact_custom_field_values fv WHERE fv.contact_id=c.id AND fv.field_id=substr(variable.value,7)::uuid)
          END AS value) rendered)`;
}

/**
 * A draft that names a catalogue template, checked against the catalogue: an
 * approved template on this campaign's number, every variable given a source,
 * and every field it reads a live contact field. The stored name and language
 * are the catalogue's, never a client's.
 */
async function withCatalogueTemplate<T extends CampaignDraftInput>(sql: SqlExecutor, input: T): Promise<T> {
  const bound = boundTemplateOf(input.content);
  if (bound === null) return input;
  const template = (await sql.query<{ template_name: string; language: string; components: unknown }>(
    `SELECT template_name,language,components FROM whatsapp_templates WHERE id=$1 AND connection_id=$2 AND status='approved'`,
    [bound.id, input.connectionId],
  )).rows[0];
  const fields = Object.values(bound.parameters).flatMap((binding) => (binding.source === 'field' ? [binding.fieldId!] : []));
  const live = fields.length === 0 ? 0 : (await sql.query(
    `SELECT 1 FROM custom_fields WHERE id=ANY($1::uuid[]) AND target='contact' AND state='active'`, [fields],
  )).rows.length;
  if (template === undefined || !bindingsComplete(defineWhatsAppTemplate(template.components), bound.parameters) || live !== new Set(fields).size) {
    throw new ApiHttpError(422, 'campaign_template_invalid', 'Choose an approved template on this WhatsApp number and give every variable a value.');
  }
  return { ...input, content: { type: 'template', template: { id: bound.id, name: template.template_name, language: template.language, parameters: bound.parameters } } };
}

/** A catalogue template can be paused or disabled after the draft was saved. */
async function requireCatalogueTemplate(sql: SqlExecutor, connectionId: string, content: Readonly<Record<string, unknown>>): Promise<void> {
  const bound = boundTemplateOf(content);
  if (bound === null) return;
  const found = await sql.query(`SELECT 1 FROM whatsapp_templates WHERE id=$1 AND connection_id=$2 AND status='approved'`, [bound.id, connectionId]);
  if (found.rows.length === 0) throw conflict('campaign_template_unavailable', 'The template is no longer approved on this number. Choose another before validating.');
}

async function requireConnection(sql: SqlExecutor, connectionId: string, requireHealthy: boolean): Promise<void> {
  const row = await sql.query<{ status: string }>(`SELECT status FROM channel_connections WHERE id=$1 AND disconnected_at IS NULL`, [connectionId]);
  if (row.rows[0] === undefined) throw notFound();
  if (requireHealthy && row.rows[0].status !== 'healthy') throw conflict('channel_not_ready', 'Test and connect the selected channel before launch.');
}

async function locked(sql: SqlExecutor, campaignId: string): Promise<LockedCampaign> {
  const campaign = await sql.query<Pick<LockedCampaign, 'id' | 'connection_id' | 'control_state' | 'current_revision_id' | 'version'>>(
    `SELECT id::text,connection_id::text,control_state,current_revision_id::text,version
       FROM campaigns WHERE id=$1 FOR UPDATE`, [campaignId],
  );
  const row = campaign.rows[0];
  if (row === undefined) throw notFound();
  const revision = await sql.query<Pick<LockedCampaign, 'revision' | 'revision_hash' | 'content' | 'variables' | 'audience_filter' | 'expires_at' | 'budget_amount_minor' | 'budget_currency'>>(
    `SELECT revision,revision_hash,content,variables,audience_filter,expires_at,budget_amount_minor::text,budget_currency
       FROM campaign_revisions WHERE id=$1`, [row.current_revision_id],
  );
  return { ...row, ...requireRow(revision.rows, 'locked campaign revision disappeared') };
}

async function readTestRecipients(sql: SqlExecutor, connectionId: string, id: string | null = null): Promise<readonly TestRecipientView[]> {
  const rows = await sql.query<{
    id: string; connection_id: string; identity_id: string; peer_identity: string;
    display_name: string; label: string; authorized_at: Date;
  }>(
    `SELECT tr.id::text,tr.connection_id::text,tr.identity_id::text,i.external_id AS peer_identity,
            c.display_name,tr.label,tr.authorized_at
       FROM channel_test_recipients tr JOIN contact_identities i ON i.id=tr.identity_id
       JOIN contacts c ON c.id=i.contact_id
      WHERE tr.connection_id=$1 AND tr.revoked_at IS NULL AND i.valid_to IS NULL
        AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR tr.id=$2)
      ORDER BY tr.authorized_at,tr.id`,
    [connectionId, id],
  );
  return rows.rows.map((row) => ({ ...row, authorized_at: row.authorized_at.toISOString() }));
}

async function readTestSends(sql: SqlExecutor, id: string): Promise<readonly CampaignTestSendView[]> {
  const rows = await sql.query<{
    id: string; campaign_id: string; revision_id: string; test_recipient_id: string;
    recipient_label: string; peer_identity: string; message_id: string; state: string;
    state_reason: string | null; created_at: Date;
  }>(
    `SELECT s.id::text,s.campaign_id::text,s.revision_id::text,
            s.authorization_id::text AS test_recipient_id,tr.label AS recipient_label,
            i.external_id AS peer_identity,s.message_id::text,m.command_state AS state,
            m.state_reason,s.requested_at AS created_at
       FROM campaign_test_sends s JOIN channel_test_recipients tr ON tr.id=s.authorization_id
       JOIN contact_identities i ON i.id=tr.identity_id JOIN outbound_messages m ON m.id=s.message_id
      WHERE s.id=$1`,
    [id],
  );
  return rows.rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
}

function transition(state: CampaignState, trigger: Parameters<typeof applyCampaignTrigger>[1]) {
  const result = applyCampaignTrigger(state, trigger);
  if (result.refusal !== null) throw conflict(result.refusal, `Campaign cannot ${trigger.replaceAll('_', ' ')} from ${state}.`);
  return result;
}

function failedRetryTarget(state: CampaignState): CampaignState {
  const result = applyCampaignTrigger(state, 'retry_failed');
  if (result.refusal !== null) {
    throw conflict('campaign_retry_not_terminal', 'Only a completed campaign can retry failed recipients.');
  }
  return result.to;
}

async function readCampaigns(sql: SqlExecutor, id: string | null): Promise<readonly CampaignRow[]> {
  const result = await sql.query<CampaignRow>(
    `SELECT c.id::text,c.name,c.objective,c.connection_id::text,c.control_state,c.version,
            r.id::text AS revision_id,r.revision,r.revision_hash,r.content,r.variables,r.audience_filter,
            r.timezone,r.expires_at,r.budget_amount_minor::text,r.budget_currency,
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
    content: row.content, variables: row.variables, audience_filter: row.audience_filter,
    timezone: row.timezone, expires_at: row.expires_at?.toISOString() ?? null,
    budget_amount_minor: row.budget_amount_minor, budget_currency: row.budget_currency,
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
function idempotentBody(outcome: IdempotencyResult): unknown {
  if (outcome.status === 'conflict') throw idempotencyConflict();
  return outcome.response.body;
}
