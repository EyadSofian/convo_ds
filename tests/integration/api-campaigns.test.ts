import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { CampaignPlannerService } from '../../apps/api/src/campaigns/campaign-planner.service.js';
import { ChannelDispatcherService } from '../../apps/api/src/channels/dispatcher.service.js';
import { ChannelCredentialService } from '../../apps/api/src/channels/credential.service.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { SendOutcome } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import { clusterCredentials, createScratchDatabase, migrateScratch, scratchRuntimePool } from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'campaign-bootstrap-token-value-000001';
const PASSWORD = 'campaign owner password';
const providerOutcomes: SendOutcome[] = [];

interface Harness {
  readonly app: NestFastifyApplication;
  readonly pool: Pool;
  readonly server: FastifyInstance;
  readonly tenantId: string;
  readonly ownerMembershipId: string;
  readonly connectionId: string;
  readonly cookie: string;
  readonly csrf: string;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'saas', CONVO_INSTALLATION_NAME: 'Campaign Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test', CONVO_PROCESS_ROLE: 'api', CONVO_API_PORT: '0',
    CONVO_AUTH_HASH_SECRET: 'campaign-auth-hash-secret-0000001', CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'campaign-idempotency-secret-00001',
    CONVO_CREDENTIAL_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
    CONVO_PG_HOST: cluster.host, CONVO_PG_PORT: String(cluster.port), CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole, CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function setup(): Promise<Harness> {
  const names = await createScratchDatabase('convo_campaign_api');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 6);
  await applyInstallationConfig(asExecutor(pool), 'saas');
  const app = await createApiApplication(parseApiConfig(envFor(names)), pool, {
    channelTransport: {
      name: 'campaign-test-stub',
      validateConnection: (_kind, _credential, assetIdentity) => Promise.resolve({
        ok: true, assetIdentity, code: null, message: null,
      }),
      send: () => Promise.resolve(providerOutcomes.shift() ?? {
        status: 'definitely_rejected', code: 'unexpected_test_send',
        message: 'The campaign test did not arrange a provider outcome.', retryable: false,
      }),
    },
  });
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const boot = await server.inject({
    method: 'POST', url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'campaign-bootstrap' },
    payload: { companyName: 'Digital School', companySlug: `school-${randomUUID().slice(0, 8)}`, ownerEmail: 'owner@campaign.test', ownerPassword: PASSWORD },
  });
  expect(boot.statusCode).toBe(201);
  const tenantId = (boot.json() as { data: { tenantId: string } }).data.tenantId;
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@campaign.test', password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie'];
  const lines = cookies === undefined ? [] : Array.isArray(cookies) ? cookies : [cookies];
  const cookie = lines.map((line) => line.split(';')[0]).join('; ');
  const csrf = cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith('convo_csrf='))?.slice(11) ?? '';
  const seeded = await withTenant(pool, tenantId, async (sql) => {
    const owner = await sql.query<{ id: string }>(`SELECT id::text FROM memberships LIMIT 1`);
    const connection = await sql.query<{ id: string }>(
      `INSERT INTO channel_connections
         (tenant_id,kind,external_asset_id,display_name,status,asset_verified_at,credential_verified_at,
          webhook_subscribed_at,first_inbound_at,first_outbound_at)
       VALUES ($1,'whatsapp','phone-campaign','WhatsApp Courses','healthy',now(),now(),now(),now(),now()) RETURNING id::text`,
      [tenantId],
    );
    for (const [index, consent] of [true, false].entries()) {
      const contact = await sql.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id,display_name,search_name) VALUES ($1,$2,$3) RETURNING id::text`,
        [tenantId, `Student ${index + 1}`, `student ${index + 1}`],
      );
      await sql.query(
        `INSERT INTO contact_identities (tenant_id,contact_id,kind,scope_id,external_id)
         VALUES ($1,$2,'whatsapp',$3,$4)`,
        [tenantId, contact.rows[0]!.id, connection.rows[0]!.id, `20100000000${index}`],
      );
      if (consent) await sql.query(
        `INSERT INTO consents (tenant_id,contact_id,channel,purpose,state,source)
         VALUES ($1,$2,'whatsapp','marketing','granted','web_form')`,
        [tenantId, contact.rows[0]!.id],
      );
    }
    return { ownerMembershipId: owner.rows[0]!.id, connectionId: connection.rows[0]!.id };
  });
  return { app, pool, server, tenantId, cookie, csrf, ...seeded };
}

async function send(api: Harness, method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>, key?: string): Promise<LightMyRequestResponse> {
  return api.server.inject({ method, url: `/api/v1/tenants/${api.tenantId}${path}`,
    headers: { cookie: api.cookie, 'x-csrf-token': api.csrf, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    ...(payload === undefined ? {} : { payload }),
  });
}

function draft(api: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'September course intake', objective: 'Enrolment', connectionId: api.connectionId,
    content: { text: 'Your course starts soon, {{display_name}}' }, variables: { display_name: 'display_name' },
    audienceFilter: {}, timezone: 'Africa/Cairo', budgetAmountMinor: 70000, budgetCurrency: 'USD',
    ...overrides,
  };
}

function dataOf(response: LightMyRequestResponse): { id: string; state: string } {
  return (response.json() as { data: { id: string; state: string } }).data;
}

describe('campaign API', () => {
  let api: Harness;

  beforeAll(async () => { api = await setup(); }, 120_000);
  afterAll(async () => { if (api !== undefined) await api.app.close(); });

  it('creates, freezes, approves and launches one exact campaign revision', async () => {
    const body = draft(api, { audienceFilter: { search: 'student' } });
    const created = await send(api, 'POST', '/campaigns', body, 'create-september');
    expect(created.statusCode).toBe(201);
    const campaignId = (created.json() as { data: { id: string; state: string } }).data.id;
    expect((created.json() as { data: { state: string } }).data.state).toBe('draft');

    const validated = await send(api, 'POST', `/campaigns/${campaignId}/validate`);
    expect(validated.statusCode, validated.body).toBe(201);
    expect((validated.json() as { data: { state: string; audience: unknown } }).data).toMatchObject({
      state: 'ready', audience: { total: 2, eligible: 1, excluded: 1 },
    });

    const approved = await send(api, 'POST', `/campaigns/${campaignId}/approve`);
    expect(approved.statusCode).toBe(201);
    expect((approved.json() as { data: { approved: boolean } }).data.approved).toBe(true);

    const launched = await send(api, 'POST', `/campaigns/${campaignId}/launch`, { mode: 'now' }, 'launch-september');
    expect(launched.statusCode, launched.body).toBe(202);
    expect((launched.json() as { data: { state: string } }).data.state).toBe('running');
    const replay = await send(api, 'POST', `/campaigns/${campaignId}/launch`, { mode: 'now' }, 'launch-september');
    expect(replay.statusCode).toBe(202);
    expect((replay.json() as { data: unknown }).data).toEqual((launched.json() as { data: unknown }).data);

    const recipients = await send(api, 'GET', `/campaigns/${campaignId}/recipients`);
    expect(recipients.statusCode).toBe(200);
    const recipientRows = (recipients.json() as { data: readonly { state: string; estimated_amount_minor: string }[] }).data;
    expect(recipientRows).toHaveLength(1);
    expect(recipientRows[0]).toMatchObject({ state: 'planned', estimated_amount_minor: '70000.000000' });

    for (const [action, state] of [['pause', 'paused'], ['resume', 'running'], ['cancel', 'cancelled']] as const) {
      const changed = await send(api, 'POST', `/campaigns/${campaignId}/control`, { action });
      expect(changed.statusCode, changed.body).toBe(201);
      expect((changed.json() as { data: { state: string } }).data.state).toBe(state);
    }
    const after = await send(api, 'GET', '/campaigns');
    expect(after.statusCode).toBe(200);
    expect((after.json() as { data: readonly { state: string }[] }).data[0]?.state).toBe('cancelled');
  });

  it('enforces CSRF and idempotency headers at the HTTP boundary', async () => {
    const missingKey = await send(api, 'POST', '/campaigns', draft(api), undefined);
    expect(missingKey.statusCode).toBe(400);
    const noCsrf = await api.server.inject({ method: 'POST', url: `/api/v1/tenants/${api.tenantId}/campaigns`,
      headers: { cookie: api.cookie, 'idempotency-key': 'no-csrf' }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('rejects stale workflow operations with typed conflicts', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, { name: 'Conflict paths' }), 'create-conflicts');
    const id = dataOf(created).id;

    const approvalTooSoon = await send(api, 'POST', `/campaigns/${id}/approve`);
    expect(approvalTooSoon.statusCode).toBe(409);
    expect(approvalTooSoon.json()).toMatchObject({ error: { code: 'campaign_not_ready' } });

    expect((await send(api, 'POST', `/campaigns/${id}/validate`)).statusCode).toBe(201);
    const revalidate = await send(api, 'POST', `/campaigns/${id}/validate`);
    expect(revalidate.statusCode).toBe(409);
    expect(revalidate.json()).toMatchObject({ error: { code: 'invalid_campaign_transition' } });

    const withoutApproval = await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, 'launch-without-approval');
    expect(withoutApproval.statusCode).toBe(409);
    expect(withoutApproval.json()).toMatchObject({ error: { code: 'approval_required' } });

    expect((await send(api, 'POST', `/campaigns/${id}/approve`)).statusCode).toBe(201);
    const duplicateApproval = await send(api, 'POST', `/campaigns/${id}/approve`);
    expect(duplicateApproval.statusCode).toBe(409);
    expect(duplicateApproval.json()).toMatchObject({ error: { code: 'campaign_already_approved' } });
  });

  it('rejects missing and unhealthy channel assets without exposing another record', async () => {
    const missing = await send(api, 'POST', '/campaigns', draft(api, { name: 'Unknown channel', connectionId: randomUUID() }), 'create-missing-channel');
    expect(missing.statusCode).toBe(404);

    const unhealthyId = await withTenant(api.pool, api.tenantId, async (sql) => {
      const row = await sql.query<{ id: string }>(
        `INSERT INTO channel_connections (tenant_id,kind,external_asset_id,display_name,status,asset_verified_at)
         VALUES ($1,'whatsapp',$2,'Pending line','authorization_needed',now()) RETURNING id::text`,
        [api.tenantId, `pending-${randomUUID()}`],
      );
      return row.rows[0]!.id;
    });
    const created = await send(api, 'POST', '/campaigns', draft(api, { name: 'Pending channel', connectionId: unhealthyId }), 'create-unhealthy');
    expect(created.statusCode).toBe(201);
    const refused = await send(api, 'POST', `/campaigns/${dataOf(created).id}/validate`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'channel_not_ready' } });
  });

  it('rejects expired definitions and launches a future schedule exactly once', async () => {
    const expired = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Expired campaign', expiresAt: '2025-01-01T00:00:00.000Z',
    }), 'create-expired');
    const expiredId = dataOf(expired).id;
    await send(api, 'POST', `/campaigns/${expiredId}/validate`);
    await send(api, 'POST', `/campaigns/${expiredId}/approve`);
    const expiredLaunch = await send(api, 'POST', `/campaigns/${expiredId}/launch`, { mode: 'now' }, 'launch-expired');
    expect(expiredLaunch.statusCode).toBe(409);
    expect(expiredLaunch.json()).toMatchObject({ error: { code: 'campaign_expired' } });

    const scheduled = await send(api, 'POST', '/campaigns', draft(api, { name: 'Scheduled campaign' }), 'create-scheduled');
    const scheduledId = dataOf(scheduled).id;
    await send(api, 'POST', `/campaigns/${scheduledId}/validate`);
    await send(api, 'POST', `/campaigns/${scheduledId}/approve`);
    const scheduledFor = '2099-02-03T04:05:06.000Z';
    const launched = await send(api, 'POST', `/campaigns/${scheduledId}/launch`, { mode: 'scheduled', scheduledFor }, 'launch-scheduled');
    expect(launched.statusCode).toBe(202);
    expect(launched.json()).toMatchObject({ data: { state: 'scheduled', execution: { state: 'scheduled', scheduled_for: scheduledFor } } });

    const reused = await send(api, 'POST', `/campaigns/${scheduledId}/launch`, { mode: 'scheduled', scheduledFor: '2099-03-03T04:05:06.000Z' }, 'launch-scheduled');
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
  });

  it('requires a frozen audience and applies exact label filters', async () => {
    const noAudience = await send(api, 'POST', '/campaigns', draft(api, { name: 'Missing audience' }), 'create-no-audience');
    const noAudienceId = dataOf(noAudience).id;
    await withTenant(api.pool, api.tenantId, async (sql) => {
      await sql.query(`UPDATE campaigns SET control_state='ready' WHERE id=$1`, [noAudienceId]);
    });
    await send(api, 'POST', `/campaigns/${noAudienceId}/approve`);
    const refused = await send(api, 'POST', `/campaigns/${noAudienceId}/launch`, { mode: 'now' }, 'launch-no-audience');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'audience_required' } });

    const labelId = await withTenant(api.pool, api.tenantId, async (sql) => {
      const label = await sql.query<{ id: string }>(`INSERT INTO labels (tenant_id,name,color) VALUES ($1,'Enrolled','#123456') RETURNING id::text`, [api.tenantId]);
      await sql.query(
        `INSERT INTO contact_labels (tenant_id,contact_id,label_id,assigned_by_membership_id)
         SELECT $1,c.id,$2,$3 FROM contacts c WHERE c.display_name='Student 1'`,
        [api.tenantId, label.rows[0]!.id, api.ownerMembershipId],
      );
      return label.rows[0]!.id;
    });
    const labelled = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Label audience', audienceFilter: { labelIds: [labelId] },
    }), 'create-label-audience');
    const validation = await send(api, 'POST', `/campaigns/${dataOf(labelled).id}/validate`);
    expect(validation.json()).toMatchObject({ data: { audience: { total: 1, eligible: 1, excluded: 0 } } });
  });

  it('detects idempotency-key reuse and hides an unknown campaign', async () => {
    expect((await send(api, 'POST', '/campaigns', draft(api, { name: 'Original key body' }), 'same-create-key')).statusCode).toBe(201);
    const conflict = await send(api, 'POST', '/campaigns', draft(api, { name: 'Different key body' }), 'same-create-key');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    expect((await send(api, 'GET', `/campaigns/${randomUUID()}/recipients`)).statusCode).toBe(404);
    const missingMutation = await send(api, 'POST', `/campaigns/${randomUUID()}/validate`);
    expect(missingMutation.statusCode).toBe(404);
  });

  it('clones definition only into a new draft and protects the clone command with idempotency', async () => {
    const source = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Clone source', audienceFilter: { search: 'student 1' },
    }), 'create-clone-source');
    const sourceId = dataOf(source).id;
    await send(api, 'POST', `/campaigns/${sourceId}/validate`);
    await send(api, 'POST', `/campaigns/${sourceId}/approve`);
    const clone = await send(api, 'POST', `/campaigns/${sourceId}/clone`, { name: 'Clone target' }, 'clone-source-once');
    expect(clone.statusCode, clone.body).toBe(201);
    const cloned = clone.json() as { data: { id: string; name: string; state: string; approved: boolean; audience: unknown; execution: unknown; revision_hash: string } };
    expect(cloned.data).toMatchObject({ name: 'Clone target', state: 'draft', approved: false, audience: null, execution: null });
    expect(cloned.data.id).not.toBe(sourceId);
    expect(cloned.data.revision_hash).toBe((source.json() as { data: { revision_hash: string } }).data.revision_hash);

    const replay = await send(api, 'POST', `/campaigns/${sourceId}/clone`, { name: 'Clone target' }, 'clone-source-once');
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { data: { id: string } }).data.id).toBe(cloned.data.id);
    const reused = await send(api, 'POST', `/campaigns/${sourceId}/clone`, { name: 'Different target' }, 'clone-source-once');
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    expect((await send(api, 'POST', `/campaigns/${randomUUID()}/clone`, { name: 'Missing' }, 'clone-missing')).statusCode).toBe(404);

    const evidence = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ approvals: string; executions: string; snapshots: string }>(
        `SELECT (SELECT count(*)::text FROM campaign_approvals WHERE campaign_id=$1) AS approvals,
                (SELECT count(*)::text FROM campaign_executions WHERE campaign_id=$1) AS executions,
                (SELECT count(*)::text FROM audience_snapshots WHERE campaign_id=$1) AS snapshots`,
        [cloned.data.id],
      );
      return rows.rows[0];
    });
    expect(evidence).toEqual({ approvals: '0', executions: '0', snapshots: '0' });
  });

  it('plans frozen recipients as fenced bulk commands and rechecks consent at dispatch', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, { name: 'Dispatch consent fence' }), 'create-dispatch-fence');
    const id = dataOf(created).id;
    await send(api, 'POST', `/campaigns/${id}/validate`);
    await send(api, 'POST', `/campaigns/${id}/approve`);
    await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, 'launch-dispatch-fence');

    const planner = api.app.get(CampaignPlannerService);
    expect(await planner.pendingTenants()).toContain(api.tenantId);
    expect(await planner.plan(api.tenantId, 10)).toBe(1);
    const planned = await withTenant(api.pool, api.tenantId, async (sql) => {
      const row = await sql.query<{ recipient_id: string; command_id: string; state: string; traffic_class: string; campaign_stop_version: string; text_body: string }>(
        `SELECT r.id::text AS recipient_id,r.command_id::text,r.state,o.traffic_class,m.campaign_stop_version::text,m.text_body
           FROM campaign_recipients r JOIN outbound_messages m ON m.id=r.command_id JOIN outbox o ON o.message_id=m.id
           JOIN campaign_executions e ON e.id=r.execution_id WHERE e.campaign_id=$1`, [id],
      );
      await sql.query(
        `INSERT INTO consents (tenant_id,contact_id,channel,purpose,state,source)
         SELECT $1,contact_id,'whatsapp','marketing','withdrawn','customer_message'
           FROM campaign_recipients WHERE id=$2`, [api.tenantId, row.rows[0]!.recipient_id],
      );
      return row.rows[0]!;
    });
    expect(planned).toMatchObject({
      state: 'queued', traffic_class: 'bulk', campaign_stop_version: '0',
      text_body: 'Your course starts soon, Student 1',
    });

    const dispatched = await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk');
    expect(dispatched).toMatchObject({ claimed: 1, skipped: 1, accepted: 0 });
    const after = await withTenant(api.pool, api.tenantId, async (sql) => {
      const recipient = await sql.query<{ state: string; reason: string }>(
        `SELECT state,dispatch_eligibility->>'reason' AS reason FROM campaign_recipients WHERE id=$1`, [planned.recipient_id],
      );
      const budget = await sql.query<{ state: string; reserved: string }>(
        `SELECT state,reserved_amount_minor::text AS reserved FROM budget_reservations WHERE recipient_id=$1`, [planned.recipient_id],
      );
      return { recipient: recipient.rows[0], budget: budget.rows[0] };
    });
    expect(after).toEqual({
      recipient: { state: 'skipped', reason: 'marketing_consent_missing' },
      budget: { state: 'released', reserved: '0.000000' },
    });
    // Keep the shared harness eligible for the independent scheduling cases
    // below. The withdrawal itself remains in the ledger; a newer grant is
    // how production restores consent as well.
    await withTenant(api.pool, api.tenantId, async (sql) => {
      await sql.query(
        `INSERT INTO consents (tenant_id,contact_id,channel,purpose,state,source)
         SELECT $1,contact_id,'whatsapp','marketing','granted','web_form'
           FROM campaign_recipients WHERE id=$2`,
        [api.tenantId, planned.recipient_id],
      );
    });
  });

  it('holds queued work across pause, refreshes the fence on resume and removes it on cancel', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Pause fence',
      content: { template: { name: 'course_reminder', language: 'ar' } },
    }), 'create-pause-fence');
    const id = dataOf(created).id;
    await send(api, 'POST', `/campaigns/${id}/validate`);
    await send(api, 'POST', `/campaigns/${id}/approve`);
    await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, 'launch-pause-fence');
    const planner = api.app.get(CampaignPlannerService);
    await planner.plan(api.tenantId, 10);
    const dispatcher = api.app.get(ChannelDispatcherService);

    expect((await send(api, 'POST', `/campaigns/${id}/control`, { action: 'pause' })).statusCode).toBe(201);
    expect((await dispatcher.dispatch(api.tenantId, 10, 'campaign-test', 'bulk')).claimed).toBe(0);
    expect((await send(api, 'POST', `/campaigns/${id}/control`, { action: 'resume' })).statusCode).toBe(201);
    const retried = await dispatcher.dispatch(api.tenantId, 10, 'campaign-test', 'bulk');
    expect(retried).toMatchObject({ claimed: 1, retried: 1 });

    expect((await send(api, 'POST', `/campaigns/${id}/control`, { action: 'cancel' })).statusCode).toBe(201);
    const counts = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ outbox: string; cancelled: string; released: string }>(
        `SELECT (SELECT count(*)::text FROM outbox o JOIN campaign_recipients r ON r.command_id=o.message_id
                  JOIN campaign_executions e ON e.id=r.execution_id WHERE e.campaign_id=$1) AS outbox,
                (SELECT count(*)::text FROM campaign_recipients r JOIN campaign_executions e ON e.id=r.execution_id
                  WHERE e.campaign_id=$1 AND r.state='cancelled') AS cancelled,
                (SELECT count(*)::text FROM budget_reservations b JOIN campaign_executions e ON e.id=b.execution_id
                  WHERE e.campaign_id=$1 AND b.state='released') AS released`, [id],
      );
      return rows.rows[0];
    });
    expect(counts).toEqual({ outbox: '0', cancelled: '1', released: '1' });
  });

  it('starts a due scheduled execution and rejects content that cannot form a command', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, { name: 'Scheduled invalid', content: { unsupported: true } }), 'create-scheduled-invalid');
    const id = dataOf(created).id;
    await send(api, 'POST', `/campaigns/${id}/validate`);
    await send(api, 'POST', `/campaigns/${id}/approve`);
    await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'scheduled', scheduledFor: '2099-01-01T00:00:00.000Z' }, 'launch-scheduled-invalid');
    await withTenant(api.pool, api.tenantId, (sql) => sql.query(`UPDATE campaign_work_queue SET available_at=now() WHERE execution_id=(SELECT id FROM campaign_executions WHERE campaign_id=$1)`, [id]));
    expect(await api.app.get(CampaignPlannerService).plan(api.tenantId, 10)).toBe(1);
    const state = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ campaign: string; execution: string; recipient: string; budget: string }>(
        `SELECT c.control_state AS campaign,e.state AS execution,r.state AS recipient,b.state AS budget
           FROM campaigns c JOIN campaign_executions e ON e.campaign_id=c.id
           JOIN campaign_recipients r ON r.execution_id=e.id JOIN budget_reservations b ON b.recipient_id=r.id
          WHERE c.id=$1`, [id],
      );
      return rows.rows[0];
    });
    expect(state).toEqual({ campaign: 'running', execution: 'running', recipient: 'skipped', budget: 'released' });
  });

  it('projects accepted, rejected and unknown provider outcomes into recipient and budget ledgers', async () => {
    await withTenant(api.pool, api.tenantId, async (sql) => {
      await api.app.get(ChannelCredentialService).store(
        sql,
        { tenantId: api.tenantId, connectionId: api.connectionId, purpose: 'access_token' },
        'campaign-provider-token',
        null,
      );
      await sql.query(
        `INSERT INTO consents (tenant_id,contact_id,channel,purpose,state,source)
         SELECT $1,id,'whatsapp','marketing','granted','web_form'
           FROM contacts WHERE display_name='Student 2'`,
        [api.tenantId],
      );
    });

    const accepted = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Accepted projection', audienceFilter: { search: 'student' },
      content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-accepted-projection');
    const acceptedId = dataOf(accepted).id;
    await send(api, 'POST', `/campaigns/${acceptedId}/validate`);
    await send(api, 'POST', `/campaigns/${acceptedId}/approve`);
    await send(api, 'POST', `/campaigns/${acceptedId}/launch`, { mode: 'now' }, 'launch-accepted-projection');
    expect(await api.app.get(CampaignPlannerService).plan(api.tenantId, 10)).toBe(2);
    providerOutcomes.push(
      { status: 'accepted', providerMessageId: 'wamid.campaign.accepted.1', raw: {} },
      { status: 'accepted', providerMessageId: 'wamid.campaign.accepted.2', raw: {} },
    );
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 1, 'campaign-test', 'bulk'))
      .toMatchObject({ claimed: 1, accepted: 1 });
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk'))
      .toMatchObject({ claimed: 1, accepted: 1 });

    const terminalCases = [
      {
        label: 'Rejected', key: 'rejected',
        outcome: { status: 'definitely_rejected', code: 'provider_refused', message: 'refused', retryable: false } as const,
        recipient: 'failed', budget: 'released', result: 'rejected',
      },
      {
        label: 'Unknown', key: 'unknown',
        outcome: { status: 'outcome_unknown', code: 'ETIMEDOUT', message: 'answer lost' } as const,
        recipient: 'outcome_unknown', budget: 'held_unknown', result: 'unknown',
      },
    ];
    for (const item of terminalCases) {
      const created = await send(api, 'POST', '/campaigns', draft(api, {
        name: `${item.label} projection`, audienceFilter: { search: 'student 1' },
        content: { template: { name: 'course_open', language: 'ar' } },
      }), `create-${item.key}-projection`);
      const id = dataOf(created).id;
      await send(api, 'POST', `/campaigns/${id}/validate`);
      await send(api, 'POST', `/campaigns/${id}/approve`);
      await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, `launch-${item.key}-projection`);
      expect(await api.app.get(CampaignPlannerService).plan(api.tenantId, 10)).toBe(1);
      providerOutcomes.push(item.outcome);
      const dispatched = await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk');
      expect(dispatched).toMatchObject({ claimed: 1, [item.result]: 1 });
      const ledger = await withTenant(api.pool, api.tenantId, async (sql) => {
        const rows = await sql.query<{ recipient: string; budget: string; campaign: string; outbox: string }>(
          `SELECT r.state AS recipient,b.state AS budget,c.control_state AS campaign,
                  (SELECT count(*)::text FROM outbox o WHERE o.message_id=r.command_id) AS outbox
             FROM campaigns c JOIN campaign_executions e ON e.campaign_id=c.id
             JOIN campaign_recipients r ON r.execution_id=e.id
             JOIN budget_reservations b ON b.recipient_id=r.id WHERE c.id=$1`, [id],
        );
        return rows.rows[0];
      });
      expect(ledger).toEqual({ recipient: item.recipient, budget: item.budget, campaign: 'dispatch_completed', outbox: '0' });
    }

    const acceptedLedger = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ recipients: string; committed: string; campaign: string }>(
        `SELECT count(*)::text AS recipients,count(*) FILTER (WHERE b.state='committed')::text AS committed,
                min(c.control_state) AS campaign
           FROM campaigns c JOIN campaign_executions e ON e.campaign_id=c.id
           JOIN campaign_recipients r ON r.execution_id=e.id JOIN budget_reservations b ON b.recipient_id=r.id
          WHERE c.id=$1`, [acceptedId],
      );
      return rows.rows[0];
    });
    expect(acceptedLedger).toEqual({ recipients: '2', committed: '2', campaign: 'dispatch_completed' });
  });

  it('refuses a campaign if channel readiness changes after planning', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Readiness fence', audienceFilter: { search: 'student 1' },
      content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-readiness-fence');
    const id = dataOf(created).id;
    await send(api, 'POST', `/campaigns/${id}/validate`);
    await send(api, 'POST', `/campaigns/${id}/approve`);
    await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, 'launch-readiness-fence');
    expect(await api.app.get(CampaignPlannerService).plan(api.tenantId, 10)).toBe(1);
    await withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE channel_connections SET status='degraded' WHERE id=$1`, [api.connectionId],
    ));
    const dispatched = await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk');
    expect(dispatched).toMatchObject({ claimed: 1, skipped: 1 });
    await withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE channel_connections SET status='healthy' WHERE id=$1`, [api.connectionId],
    ));
  });

  it('serializes a planner racing pause without deadlock or post-pause dispatch', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Planner pause race', audienceFilter: { search: 'student 1' },
      content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-planner-pause-race');
    const id = dataOf(created).id;
    await send(api, 'POST', `/campaigns/${id}/validate`);
    await send(api, 'POST', `/campaigns/${id}/approve`);
    await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, 'launch-planner-pause-race');

    const [planned, paused] = await Promise.all([
      api.app.get(CampaignPlannerService).plan(api.tenantId, 10),
      send(api, 'POST', `/campaigns/${id}/control`, { action: 'pause' }),
    ]);
    expect([0, 1]).toContain(planned);
    expect(paused.statusCode, paused.body).toBe(201);
    expect(dataOf(paused).state).toBe('paused');
    expect((await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk')).claimed).toBe(0);
    expect((await send(api, 'POST', `/campaigns/${id}/control`, { action: 'cancel' })).statusCode).toBe(201);
  });

  it('drops stale and terminal planner entries and reports an empty due queue', async () => {
    const planner = api.app.get(CampaignPlannerService);
    const executionId = await withTenant(api.pool, api.tenantId, async (sql) => {
      const row = await sql.query<{ execution_id: string }>(
        `UPDATE campaign_work_queue SET available_at=now()
          WHERE execution_id=(SELECT id FROM campaign_executions WHERE state='scheduled' LIMIT 1)
          RETURNING execution_id::text`,
      );
      return row.rows[0]!.execution_id;
    });

    const blocker = await api.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT set_config('convo.tenant_id',$1,true)`, [api.tenantId]);
      await blocker.query(`SELECT 1 FROM campaign_work_queue WHERE execution_id=$1 FOR UPDATE`, [executionId]);
      expect(await planner.plan(api.tenantId, 10)).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    await withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE campaign_work_queue SET stop_version=stop_version+1 WHERE execution_id=$1`, [executionId],
    ));
    expect(await planner.plan(api.tenantId, 10)).toBe(1);

    await withTenant(api.pool, api.tenantId, async (sql) => {
      await sql.query(
        `INSERT INTO campaign_work_queue (execution_id,tenant_id,available_at,stop_version)
         SELECT id,tenant_id,now(),stop_version FROM campaign_executions WHERE state='cancelled' LIMIT 1`,
      );
    });
    expect(await planner.plan(api.tenantId, 10)).toBe(1);
    expect(await planner.pendingTenants()).toEqual([]);
    expect(await planner.plan(api.tenantId, 10)).toBe(0);
  });
});
