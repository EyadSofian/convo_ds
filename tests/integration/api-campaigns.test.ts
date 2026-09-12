import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import { clusterCredentials, createScratchDatabase, migrateScratch, scratchRuntimePool } from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'campaign-bootstrap-token-value-000001';
const PASSWORD = 'campaign owner password';

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
  const app = await createApiApplication(parseApiConfig(envFor(names)), pool);
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
});
