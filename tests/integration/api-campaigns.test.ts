import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { CampaignPlannerService } from '../../apps/api/src/campaigns/campaign-planner.service.js';
import { ConversationService } from '../../apps/api/src/conversations/conversation.service.js';
import { parseReportFilters } from '../../apps/api/src/campaigns/campaign-request.js';
import { CampaignReportExportService } from '../../apps/api/src/campaigns/report-export.service.js';
import { reportQuery } from '../../apps/api/src/campaigns/reporting.service.js';
import { ChannelDispatcherService } from '../../apps/api/src/channels/dispatcher.service.js';
import { ChannelCredentialService } from '../../apps/api/src/channels/credential.service.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { SendOutcome } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import { clusterCredentials, createScratchDatabase, migrateScratch, scratchMigrationPool, scratchRuntimePool } from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'campaign-bootstrap-token-value-000001';
const PASSWORD = 'campaign owner password';
const providerOutcomes: SendOutcome[] = [];
const providerRequests: unknown[] = [];

interface Harness {
  readonly app: NestFastifyApplication;
  readonly pool: Pool;
  readonly server: FastifyInstance;
  readonly tenantId: string;
  readonly ownerMembershipId: string;
  readonly connectionId: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly names: DatabaseNames;
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
      send: (kind, _credential, request) => {
        providerRequests.push({ kind, request });
        return Promise.resolve(providerOutcomes.shift() ?? {
          status: 'definitely_rejected', code: 'unexpected_test_send',
          message: 'The campaign test did not arrange a provider outcome.', retryable: false,
        });
      },
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
  return { app, pool, server, tenantId, cookie, csrf, names, ...seeded };
}

async function send(api: Harness, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>, key?: string): Promise<LightMyRequestResponse> {
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
    const malformedRetry = await send(api, 'POST', `/campaigns/${randomUUID()}/retry`, { all: true }, 'bad-retry');
    expect(malformedRetry.statusCode).toBe(400);
    const retryWithoutKey = await send(api, 'POST', `/campaigns/${randomUUID()}/retry`, {});
    expect(retryWithoutKey.statusCode).toBe(400);
  });

  it('rejects stale workflow operations with typed conflicts', async () => {
    const created = await send(api, 'POST', '/campaigns', draft(api, { name: 'Conflict paths' }), 'create-conflicts');
    const id = dataOf(created).id;

    const approvalTooSoon = await send(api, 'POST', `/campaigns/${id}/approve`);
    expect(approvalTooSoon.statusCode).toBe(409);
    expect(approvalTooSoon.json()).toMatchObject({ error: { code: 'campaign_not_ready' } });

    expect((await send(api, 'POST', `/campaigns/${id}/validate`)).statusCode).toBe(201);
    const retryBeforeLaunch = await send(api, 'POST', `/campaigns/${id}/retry`, {}, 'retry-before-launch');
    expect(retryBeforeLaunch.statusCode).toBe(409);
    expect(retryBeforeLaunch.json()).toMatchObject({ error: { code: 'campaign_retry_not_launched' } });
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

  it('previews and freezes audiences narrowed by conversation labels and hand-picked contacts', async () => {
    // Its own channel and people, so the conversations here stay invisible to
    // the dispatch tests that share this company.
    const seeded = await withTenant(api.pool, api.tenantId, async (sql) => {
      const connection = await sql.query<{ id: string }>(
        `INSERT INTO channel_connections
           (tenant_id,kind,external_asset_id,display_name,status,asset_verified_at,credential_verified_at,
            webhook_subscribed_at,first_inbound_at,first_outbound_at)
         VALUES ($1,'whatsapp','phone-audience','WhatsApp Audience','healthy',now(),now(),now(),now(),now()) RETURNING id::text`,
        [api.tenantId],
      );
      const connectionId = connection.rows[0]!.id;
      const label = await sql.query<{ id: string }>(`INSERT INTO labels (tenant_id,name,color) VALUES ($1,'Asked about fees','#654321') RETURNING id::text`, [api.tenantId]);
      const other = await sql.query<{ id: string }>(`INSERT INTO labels (tenant_id,name,color) VALUES ($1,'Unused','#111111') RETURNING id::text`, [api.tenantId]);
      const ids: string[] = [];
      for (const [index, name] of ['Amal Fee', 'Basma Fee'].entries()) {
        const contact = await sql.query<{ id: string }>(
          `INSERT INTO contacts (tenant_id,display_name,search_name) VALUES ($1,$2,$3) RETURNING id::text`,
          [api.tenantId, name, name.toLowerCase()],
        );
        const contactId = contact.rows[0]!.id;
        ids.push(contactId);
        await sql.query(
          `INSERT INTO contact_identities (tenant_id,contact_id,kind,scope_id,external_id) VALUES ($1,$2,'whatsapp',$3,$4)`,
          [api.tenantId, contactId, connectionId, `20199900000${index}`],
        );
        if (index === 0) await sql.query(
          `INSERT INTO consents (tenant_id,contact_id,channel,purpose,state,source) VALUES ($1,$2,'whatsapp','marketing','granted','web_form')`,
          [api.tenantId, contactId],
        );
        const conversation = await sql.query<{ id: string }>(
          `INSERT INTO conversations (tenant_id,connection_id,peer_identity,contact_id) VALUES ($1,$2,$3,$4) RETURNING id::text`,
          [api.tenantId, connectionId, `20199900000${index}`, contactId],
        );
        await sql.query(
          `INSERT INTO conversation_labels (tenant_id,conversation_id,label_id,assigned_by_membership_id,removed_at)
           VALUES ($1,$2,$3,$4,$5)`,
          // The second label was removed again: history, not a current label.
          [api.tenantId, conversation.rows[0]!.id, label.rows[0]!.id, api.ownerMembershipId, index === 1 ? new Date() : null],
        );
      }
      return { connectionId, first: ids[0]!, second: ids[1]!, label: label.rows[0]!.id, other: other.rows[0]!.id };
    });
    const preview = async (audienceFilter?: Record<string, unknown>) => {
      const response = await send(api, 'POST', '/campaigns/audience-preview', {
        connectionId: seeded.connectionId, ...(audienceFilter === undefined ? {} : { audienceFilter }),
      });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { data: Record<string, unknown> }).data;
    };

    expect(await preview()).toEqual({
      total: 2, eligible: 1, excluded: 1, reasons: { no_consent: 1, suppressed: 0, identity_inactive: 0 }, sample: ['Amal Fee'],
    });
    expect(await preview({ conversationLabelIds: [seeded.label] })).toMatchObject({ total: 1, eligible: 1, sample: ['Amal Fee'] });
    expect(await preview({ conversationLabelIds: [seeded.other] })).toMatchObject({ total: 0, eligible: 0, sample: [] });
    expect(await preview({ contactIds: [seeded.second] })).toMatchObject({ total: 1, eligible: 0, excluded: 1 });
    expect(await preview({ search: 'fee', contactIds: [seeded.first, seeded.second] })).toMatchObject({ total: 2 });
    expect(await preview({ labelIds: [seeded.other] })).toMatchObject({ total: 0 });

    const refused = await send(api, 'POST', '/campaigns/audience-preview', { connectionId: seeded.connectionId, audienceFilter: { tags: [] } });
    expect(refused.statusCode).toBe(400);
    const unknownChannel = await send(api, 'POST', '/campaigns/audience-preview', { connectionId: randomUUID() });
    expect(unknownChannel.statusCode).toBe(404);

    const picked = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Picked and labelled', connectionId: seeded.connectionId,
      audienceFilter: { conversationLabelIds: [seeded.label], contactIds: [seeded.first, seeded.second] },
    }), 'create-picked-audience');
    expect(picked.statusCode, picked.body).toBe(201);
    const frozen = await send(api, 'POST', `/campaigns/${dataOf(picked).id}/validate`);
    expect(frozen.json()).toMatchObject({ data: { audience: { total: 1, eligible: 1, excluded: 0 } } });
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

  it('creates a new immutable revision for meaningful edits and rejects stale or launched edits', async () => {
    const original = draft(api, { name: 'Editable campaign', audienceFilter: { search: 'student' } });
    const created = await send(api, 'POST', '/campaigns', original, 'create-editable');
    const first = created.json() as { data: { id: string; version: number; revision: number; revision_hash: string } };

    const renamed = { ...original, name: 'Renamed campaign', objective: 'Updated internal objective', expectedVersion: first.data.version };
    const metadataOnly = await send(api, 'PATCH', `/campaigns/${first.data.id}`, renamed, 'rename-editable');
    expect(metadataOnly.statusCode, metadataOnly.body).toBe(200);
    expect((metadataOnly.json() as { data: { name: string; revision: number; revision_hash: string; version: number } }).data)
      .toMatchObject({ name: 'Renamed campaign', revision: 1, revision_hash: first.data.revision_hash, version: 2 });

    const validated = await send(api, 'POST', `/campaigns/${first.data.id}/validate`);
    expect((validated.json() as { data: { state: string; version: number } }).data).toMatchObject({ state: 'ready', version: 4 });
    expect((await send(api, 'POST', `/campaigns/${first.data.id}/approve`)).statusCode).toBe(201);

    const revisedBody = { ...renamed, content: { text: 'A meaningfully different message' }, expectedVersion: 4 };
    const revised = await send(api, 'PATCH', `/campaigns/${first.data.id}`, revisedBody, 'revise-editable');
    expect(revised.statusCode, revised.body).toBe(200);
    const revision = revised.json() as { data: { state: string; version: number; revision: number; revision_id: string; revision_hash: string; approved: boolean; audience: unknown; content: unknown } };
    expect(revision.data).toMatchObject({ state: 'draft', version: 5, revision: 2, approved: false, audience: null, content: revisedBody.content });
    expect(revision.data.revision_hash).not.toBe(first.data.revision_hash);

    const replay = await send(api, 'PATCH', `/campaigns/${first.data.id}`, revisedBody, 'revise-editable');
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { data: { revision_id: string } }).data.revision_id).toBe(revision.data.revision_id);
    const changedReplay = await send(api, 'PATCH', `/campaigns/${first.data.id}`, { ...revisedBody, name: 'Changed replay' }, 'revise-editable');
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    const stale = await send(api, 'PATCH', `/campaigns/${first.data.id}`, { ...revisedBody, expectedVersion: 4 }, 'stale-editable');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'version_conflict' } });

    const evidence = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ revisions: string; old_approvals: string; old_snapshots: string; current_approvals: string; current_snapshots: string }>(
        `SELECT (SELECT count(*)::text FROM campaign_revisions WHERE campaign_id=$1) AS revisions,
                (SELECT count(*)::text FROM campaign_approvals WHERE campaign_id=$1 AND revision_id<>$2) AS old_approvals,
                (SELECT count(*)::text FROM audience_snapshots WHERE campaign_id=$1 AND revision_id<>$2) AS old_snapshots,
                (SELECT count(*)::text FROM campaign_approvals WHERE revision_id=$2) AS current_approvals,
                (SELECT count(*)::text FROM audience_snapshots WHERE revision_id=$2) AS current_snapshots`,
        [first.data.id, revision.data.revision_id],
      );
      return rows.rows[0];
    });
    expect(evidence).toEqual({ revisions: '2', old_approvals: '1', old_snapshots: '1', current_approvals: '0', current_snapshots: '0' });

    expect((await send(api, 'POST', `/campaigns/${first.data.id}/validate`)).statusCode).toBe(201);
    expect((await send(api, 'POST', `/campaigns/${first.data.id}/approve`)).statusCode).toBe(201);
    expect((await send(api, 'POST', `/campaigns/${first.data.id}/launch`, { mode: 'now' }, 'launch-edited')).statusCode).toBe(202);
    const lockedEdit = await send(api, 'PATCH', `/campaigns/${first.data.id}`, { ...revisedBody, expectedVersion: 8 }, 'edit-launched');
    expect(lockedEdit.statusCode).toBe(409);
    expect(lockedEdit.json()).toMatchObject({ error: { code: 'campaign_edit_locked' } });
    expect((await send(api, 'POST', `/campaigns/${first.data.id}/control`, { action: 'cancel' })).statusCode).toBe(201);
    expect((await send(api, 'PATCH', `/campaigns/${randomUUID()}`, revisedBody, 'edit-missing')).statusCode).toBe(404);
  });

  it('serializes concurrent edits against the version seen by the operator', async () => {
    const body = draft(api, { name: 'Concurrent editing' });
    const created = await send(api, 'POST', '/campaigns', body, 'create-concurrent-edit');
    const campaign = created.json() as { data: { id: string; version: number } };
    const [first, second] = await Promise.all([
      send(api, 'PATCH', `/campaigns/${campaign.data.id}`, { ...body, content: { text: 'First edit' }, expectedVersion: campaign.data.version }, 'concurrent-edit-1'),
      send(api, 'PATCH', `/campaigns/${campaign.data.id}`, { ...body, content: { text: 'Second edit' }, expectedVersion: campaign.data.version }, 'concurrent-edit-2'),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const refusal = first.statusCode === 409 ? first : second;
    expect(refusal.json()).toMatchObject({ error: { code: 'version_conflict' } });
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

    // A bulk send records attribution but cannot manufacture customer work.
    // The later inbound-created conversation is the one that binds the row.
    const beforeInbound = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ id: string; conversation_id: string | null; peer_identity: string; conversations: string }>(
        `SELECT attribution.id::text,attribution.conversation_id::text,attribution.peer_identity,
                (SELECT count(*)::text FROM conversations WHERE connection_id=$2 AND peer_identity=attribution.peer_identity) AS conversations
           FROM campaign_conversation_attributions attribution WHERE attribution.recipient_id=$1`,
        [planned.recipient_id, api.connectionId],
      );
      return rows.rows[0]!;
    });
    expect(beforeInbound).toMatchObject({ conversation_id: null, peer_identity: '201000000000', conversations: '0' });
    const conversation = await withTenant(api.pool, api.tenantId, (sql) =>
      api.app.get(ConversationService).ensure(sql, api.tenantId, api.connectionId, beforeInbound.peer_identity, 'customer_inbound'),
    );
    const afterInbound = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ conversation_id: string | null; bound_at: Date | null }>(
        `SELECT conversation_id::text,bound_at FROM campaign_conversation_attributions WHERE id=$1`, [beforeInbound.id],
      );
      return rows.rows[0]!;
    });
    expect(afterInbound).toMatchObject({ conversation_id: conversation.id });
    expect(afterInbound.bound_at).toBeInstanceOf(Date);
    const campaignFilter = encodeURIComponent(JSON.stringify({ key: 'campaign_id', operator: 'eq', value: id }));
    const attributedInbox = await send(api, 'GET', `/conversations?queue=all&filter=${campaignFilter}`);
    expect(attributedInbox.statusCode).toBe(200);
    expect((attributedInbox.json() as { data: readonly { id: string }[] }).data.map((row) => row.id)).toContain(conversation.id);

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

    const report = await send(api, 'GET', '/reports/campaigns');
    expect(report.statusCode, report.body).toBe(200);
    const value = (report.json() as { data: {
      generated_at: string; fresh_through: string; timezone: string;
      current: Record<string, number>; milestones: { denominator: number; accepted: number; delivered: number; read: number };
      audience: { denominator: number; eligible: number; excluded: number };
      errors: readonly { code: string; count: number }[];
      costs: readonly { currency: string; estimated_amount_minor: string; committed_amount_minor: string; reconciled_amount_minor: string }[];
    } }).data;
    expect(Number.isNaN(new Date(value.generated_at).getTime())).toBe(false);
    expect(Number.isNaN(new Date(value.fresh_through).getTime())).toBe(false);
    expect(value.timezone).toBe('UTC');
    expect(Object.entries(value.current).filter(([key]) => key !== 'denominator').reduce((sum, [, count]) => sum + count, 0)).toBe(value.current['denominator']);
    expect(value.milestones.denominator).toBe(value.current['denominator']);
    expect(value.milestones.accepted).toBeGreaterThanOrEqual(value.milestones.delivered);
    expect(value.milestones.delivered).toBeGreaterThanOrEqual(value.milestones.read);
    expect(value.audience.denominator).toBe(value.audience.eligible + value.audience.excluded);
    expect(value.errors).toContainEqual({ code: 'marketing_consent_missing', count: 1 });
    expect(value.costs.find((row) => row.currency === 'USD')).toMatchObject({
      estimated_amount_minor: expect.any(String), committed_amount_minor: expect.any(String), reconciled_amount_minor: expect.any(String),
    });
    expect((await send(api, 'GET', `/../${randomUUID()}/reports/campaigns`)).statusCode).toBe(404);

    // The same aggregate over a narrower scope. Every figure is recomputed from
    // the scoped recipients, so the KPI, the trend and the campaign row agree.
    type Scoped = {
      filters: Record<string, string | null>;
      definitions: { campaigns: number; executions: number };
      audience: { denominator: number };
      current: { denominator: number };
      milestones: { denominator: number; accepted: number };
      trend: readonly { day: string; recipients: number; accepted: number; delivered: number; read: number; failed: number }[];
      campaigns: readonly { id: string; denominator: number; pending: number; accepted: number; included: number | null; excluded: number | null }[];
    };
    const scoped = async (query: string): Promise<Scoped> => {
      const response = await send(api, 'GET', `/reports/campaigns?${query}`);
      expect(response.statusCode, `${query}: ${response.body}`).toBe(200);
      return (response.json() as { data: Scoped }).data;
    };
    const launchDay = await withTenant(api.pool, api.tenantId, async (sql) => (await sql.query<{ day: string }>(
      `SELECT to_char(launched_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM campaign_executions WHERE campaign_id=$1`, [id],
    )).rows[0]!.day);
    const one = await scoped(`campaignId=${id}`);
    expect(one.filters).toEqual({ from: null, to: null, channel: null, campaign_id: id });
    expect(one.definitions).toEqual({ campaigns: 1, executions: 1 });
    expect(one.campaigns.map((row) => row.id)).toEqual([id]);
    const row = one.campaigns[0]!;
    expect(one.current.denominator).toBe(row.denominator);
    expect(one.milestones.accepted).toBe(row.accepted);
    expect(row.included).toEqual(expect.any(Number));
    expect(row.excluded).toEqual(expect.any(Number));
    expect(row.pending).toBeGreaterThanOrEqual(0);
    expect(one.trend).toEqual([expect.objectContaining({ day: launchDay, recipients: row.denominator, accepted: row.accepted })]);

    const onLaunchDay = await scoped(`from=${launchDay}&to=${launchDay}&channel=whatsapp`);
    expect(onLaunchDay.filters).toMatchObject({ from: launchDay, to: launchDay, channel: 'whatsapp' });
    expect(onLaunchDay.campaigns.map((entry) => entry.id)).toContain(id);
    expect(onLaunchDay.current.denominator).toBe(onLaunchDay.trend.reduce((sum, day) => sum + day.recipients, 0));

    const otherChannel = await scoped('channel=messenger');
    expect(otherChannel).toMatchObject({ current: { denominator: 0 }, audience: { denominator: 0 }, trend: [], campaigns: [] });
    // Knowing another company's campaign id widens nothing: the scoped query
    // runs under that tenant's RLS and the campaign is simply not there.
    const foreign = await withTenant(api.pool, randomUUID(), async (sql) =>
      (await reportQuery(sql, parseReportFilters({ campaignId: id }))).rows[0]!.report);
    expect(foreign).toMatchObject({ definitions: { campaigns: 0, executions: 0 }, current: { denominator: 0 }, campaigns: [], trend: [] });
    const longAgo = await scoped('from=2000-01-01&to=2000-01-31');
    expect(longAgo).toMatchObject({ definitions: { campaigns: 0, executions: 0 }, current: { denominator: 0 }, trend: [], campaigns: [] });
    for (const query of ['from=yesterday', 'from=2026-09-02&to=2026-09-01', 'channel=telegram', 'campaignId=nope', 'period=week']) {
      const refused = await send(api, 'GET', `/reports/campaigns?${query}`);
      expect(refused.statusCode, query).toBe(400);
      expect(refused.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }

    await withTenant(api.pool, api.tenantId, (sql) => sql.query(`UPDATE campaigns SET name='=Formula-safe' WHERE id=$1`, [id]));
    const queued = await send(
      api, 'POST', '/reports/campaigns/exports', { format: 'csv', campaignId: id }, 'campaign-report-export',
    );
    expect(queued.statusCode, queued.body).toBe(202);
    const exportJob = (queued.json() as { data: { id: string; state: string; download_url: string | null } }).data;
    expect(exportJob).toMatchObject({ state: 'queued', download_url: null });
    expect((await send(api, 'POST', '/reports/campaigns/exports', { format: 'csv' })).statusCode).toBe(400);
    expect((await send(api, 'POST', '/reports/campaigns/exports', { format: 'json' }, 'bad-export')).statusCode).toBe(400);
    const replay = await send(
      api, 'POST', '/reports/campaigns/exports', { format: 'csv', campaignId: id }, 'campaign-report-export',
    );
    expect((replay.json() as { data: { id: string } }).data.id).toBe(exportJob.id);
    expect((await send(api, 'POST', '/reports/campaigns/exports', { format: 'csv' }, 'campaign-report-export')).statusCode).toBe(409);
    expect((await send(api, 'GET', `/reports/campaigns/exports/${exportJob.id}/content`)).statusCode).toBe(409);

    const exporter = api.app.get(CampaignReportExportService);
    expect(await exporter.pendingTenants()).toContain(api.tenantId);
    expect(await exporter.process(api.tenantId, 10, 'report-worker-test')).toBe(1);
    expect(await exporter.process(api.tenantId, 10, 'report-worker-test')).toBe(0);

    const complete = await send(api, 'GET', `/reports/campaigns/exports/${exportJob.id}`);
    expect(complete.statusCode, complete.body).toBe(200);
    const completed = (complete.json() as { data: { state: string; row_count: number; download_url: string } }).data;
    expect(completed).toMatchObject({ state: 'completed', row_count: 1 });
    expect(completed.download_url).toContain(exportJob.id);
    const content = await send(api, 'GET', `/reports/campaigns/exports/${exportJob.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['content-type']).toContain('text/csv');
    expect(content.headers['content-disposition']).toContain(exportJob.id);
    expect(content.headers['x-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(content.body).toContain('campaign_id,campaign_name,campaign_state');
    expect(content.body).toContain(id);
    expect(content.body).toContain("'=Formula-safe");

    expect((await send(api, 'POST', '/reports/campaigns/exports', { format: 'csv', campaignId: randomUUID() }, 'missing-campaign-export')).statusCode).toBe(404);
    expect((await send(api, 'GET', `/reports/campaigns/exports/${randomUUID()}`)).statusCode).toBe(404);
    expect((await send(api, 'GET', `/reports/campaigns/exports/${randomUUID()}/content`)).statusCode).toBe(404);
    await withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE campaign_report_exports
          SET completed_at=now()-interval '2 days',expires_at=now()-interval '1 day'
        WHERE id=$1`, [exportJob.id],
    ));
    expect((await send(api, 'GET', `/reports/campaigns/exports/${exportJob.id}/content`)).statusCode).toBe(410);
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

  it('records export generation failures and closes an exhausted stale lease', async () => {
    const exporter = api.app.get(CampaignReportExportService);
    const migrationPool = scratchMigrationPool(api.names);
    try {
      const failedResponse = await send(api, 'POST', '/reports/campaigns/exports', { format: 'csv' }, 'forced-export-failure');
      const failedId = (failedResponse.json() as { data: { id: string } }).data.id;
      await migrationPool.query(`CREATE FUNCTION fail_report_export_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION 'forced export completion failure'; END IF; RETURN NEW; END $$`);
      await migrationPool.query(`CREATE TRIGGER fail_report_export_completion BEFORE UPDATE ON campaign_report_exports
        FOR EACH ROW EXECUTE FUNCTION fail_report_export_completion()`);
      expect(await exporter.process(api.tenantId, 1, 'failure-worker')).toBe(1);
      const failed = await send(api, 'GET', `/reports/campaigns/exports/${failedId}`);
      expect(failed.json()).toMatchObject({ data: { state: 'failed', error_code: 'export_generation_failed' } });
      await migrationPool.query(`DROP TRIGGER fail_report_export_completion ON campaign_report_exports`);
      await migrationPool.query(`DROP FUNCTION fail_report_export_completion()`);

      const exhaustedResponse = await send(api, 'POST', '/reports/campaigns/exports', { format: 'csv' }, 'exhausted-export');
      const exhaustedId = (exhaustedResponse.json() as { data: { id: string } }).data.id;
      await withTenant(api.pool, api.tenantId, (sql) => sql.query(
        `UPDATE campaign_report_exports
            SET state='running',attempt=3,lease_owner='dead-worker',
                lease_expires_at=now()-interval '1 minute',started_at=now()-interval '10 minutes'
          WHERE id=$1`, [exhaustedId],
      ));
      expect(await exporter.process(api.tenantId, 1, 'recovery-worker')).toBe(0);
      const exhausted = await send(api, 'GET', `/reports/campaigns/exports/${exhaustedId}`);
      expect(exhausted.json()).toMatchObject({ data: { state: 'failed', error_code: 'export_attempts_exhausted' } });
    } finally {
      await migrationPool.query(`DROP TRIGGER IF EXISTS fail_report_export_completion ON campaign_report_exports`);
      await migrationPool.query(`DROP FUNCTION IF EXISTS fail_report_export_completion()`);
      await migrationPool.end();
    }
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

  it('retries failed recipients only on the same execution and preserves both commands', async () => {
    await withTenant(api.pool, api.tenantId, async (sql) => {
      for (const suffix of ['a', 'b', 'c']) {
        const contact = await sql.query<{ id: string }>(
          `INSERT INTO contacts (tenant_id,display_name,search_name)
           VALUES ($1,$2,$3) RETURNING id::text`,
          [api.tenantId, `Retry Cohort ${suffix.toUpperCase()}`, `retry cohort ${suffix}`],
        );
        await sql.query(
          `INSERT INTO contact_identities (tenant_id,contact_id,kind,scope_id,external_id)
           VALUES ($1,$2,'whatsapp',$3,$4)`,
          [api.tenantId, contact.rows[0]!.id, api.connectionId, `20109990000${suffix.charCodeAt(0)}`],
        );
        await sql.query(
          `INSERT INTO consents (tenant_id,contact_id,channel,purpose,state,source)
           VALUES ($1,$2,'whatsapp','marketing','granted','web_form')`,
          [api.tenantId, contact.rows[0]!.id],
        );
      }
    });
    const created = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Failed-only retry', audienceFilter: { search: 'retry cohort' },
      content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-failed-only-retry');
    const id = dataOf(created).id;
    await send(api, 'POST', `/campaigns/${id}/validate`);
    await send(api, 'POST', `/campaigns/${id}/approve`);
    await send(api, 'POST', `/campaigns/${id}/launch`, { mode: 'now' }, 'launch-failed-only-retry');
    expect(await api.app.get(CampaignPlannerService).plan(api.tenantId, 10)).toBe(3);

    const providerCallsBefore = providerRequests.length;
    providerOutcomes.push(
      { status: 'accepted', providerMessageId: 'wamid.retry.accepted.original', raw: {} },
      { status: 'definitely_rejected', code: 'provider_refused', message: 'refused', retryable: false },
      { status: 'outcome_unknown', code: 'ETIMEDOUT', message: 'answer lost' },
    );
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk'))
      .toMatchObject({ claimed: 3, accepted: 1, rejected: 1, unknown: 1 });
    expect(providerRequests).toHaveLength(providerCallsBefore + 3);

    const retry = await send(api, 'POST', `/campaigns/${id}/retry`, {}, 'retry-failed-only');
    expect(retry.statusCode, retry.body).toBe(202);
    expect(retry.json()).toMatchObject({ data: { campaign_id: id, recipient_count: 1, state: 'running' } });
    const replay = await send(api, 'POST', `/campaigns/${id}/retry`, {}, 'retry-failed-only');
    expect(replay.statusCode).toBe(202);
    expect((replay.json() as { data: unknown }).data).toEqual((retry.json() as { data: unknown }).data);
    expect(providerRequests).toHaveLength(providerCallsBefore + 3);

    const queued = await withTenant(api.pool, api.tenantId, async (sql) => {
      const result = await sql.query<{
        accepted: string; unknown: string; queued: string; retries: string; outbox: string;
        old_state: string; replacement_state: string; budget_state: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE cr.state='accepted')::text AS accepted,
           count(*) FILTER (WHERE cr.state='outcome_unknown')::text AS unknown,
           count(*) FILTER (WHERE cr.state='queued')::text AS queued,
           (SELECT count(*)::text FROM campaign_retry_recipients rr
             JOIN campaign_retry_runs run ON run.id=rr.retry_run_id WHERE run.campaign_id=$1) AS retries,
           (SELECT count(*)::text FROM outbox o JOIN campaign_retry_recipients rr
             ON rr.replacement_command_id=o.message_id JOIN campaign_retry_runs run ON run.id=rr.retry_run_id
             WHERE run.campaign_id=$1) AS outbox,
           min(old.command_state) FILTER (WHERE rr.id IS NOT NULL) AS old_state,
           min(replacement.command_state) FILTER (WHERE rr.id IS NOT NULL) AS replacement_state,
           min(b.state) FILTER (WHERE rr.id IS NOT NULL) AS budget_state
         FROM campaign_recipients cr
         JOIN campaign_executions e ON e.id=cr.execution_id
         LEFT JOIN campaign_retry_recipients rr ON rr.recipient_id=cr.id
         LEFT JOIN outbound_messages old ON old.id=rr.previous_command_id
         LEFT JOIN outbound_messages replacement ON replacement.id=rr.replacement_command_id
         LEFT JOIN budget_reservations b ON b.recipient_id=cr.id
         WHERE e.campaign_id=$1`, [id],
      );
      return result.rows[0];
    });
    expect(queued).toEqual({
      accepted: '1', unknown: '1', queued: '1', retries: '1', outbox: '1',
      old_state: 'rejected', replacement_state: 'queued', budget_state: 'reserved',
    });

    const whileRunning = await send(api, 'POST', `/campaigns/${id}/retry`, {}, 'retry-while-running');
    expect(whileRunning.statusCode).toBe(409);
    expect(whileRunning.json()).toMatchObject({ error: { code: 'campaign_retry_not_terminal' } });

    providerOutcomes.push({ status: 'accepted', providerMessageId: 'wamid.retry.accepted.replacement', raw: {} });
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk'))
      .toMatchObject({ claimed: 1, accepted: 1 });
    expect(providerRequests).toHaveLength(providerCallsBefore + 4);
    const final = await withTenant(api.pool, api.tenantId, async (sql) => {
      const result = await sql.query<{ accepted: string; unknown: string; campaign: string; budget: string }>(
        `SELECT count(*) FILTER (WHERE cr.state='accepted')::text AS accepted,
                count(*) FILTER (WHERE cr.state='outcome_unknown')::text AS unknown,
                min(c.control_state) AS campaign,
                min(b.state) FILTER (WHERE rr.id IS NOT NULL) AS budget
           FROM campaigns c JOIN campaign_executions e ON e.campaign_id=c.id
           JOIN campaign_recipients cr ON cr.execution_id=e.id
           LEFT JOIN campaign_retry_recipients rr ON rr.recipient_id=cr.id
           LEFT JOIN budget_reservations b ON b.recipient_id=cr.id
          WHERE c.id=$1`, [id],
      );
      return result.rows[0];
    });
    expect(final).toEqual({ accepted: '2', unknown: '1', campaign: 'dispatch_completed', budget: 'committed' });
    const noFailures = await send(api, 'POST', `/campaigns/${id}/retry`, {}, 'retry-no-failures');
    expect(noFailures.statusCode).toBe(409);
    expect(noFailures.json()).toMatchObject({ error: { code: 'no_failed_recipients' } });

    const drifted = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Retry budget drift', audienceFilter: { search: 'student 1' },
      content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-retry-budget-drift');
    const driftedId = dataOf(drifted).id;
    await send(api, 'POST', `/campaigns/${driftedId}/validate`);
    await send(api, 'POST', `/campaigns/${driftedId}/approve`);
    await send(api, 'POST', `/campaigns/${driftedId}/launch`, { mode: 'now' }, 'launch-retry-budget-drift');
    expect(await api.app.get(CampaignPlannerService).plan(api.tenantId, 10)).toBe(1);
    providerOutcomes.push({ status: 'definitely_rejected', code: 'provider_refused', message: 'refused', retryable: false });
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test', 'bulk'))
      .toMatchObject({ claimed: 1, rejected: 1 });
    await withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE budget_reservations SET state='held_unknown'
        WHERE execution_id=(SELECT id FROM campaign_executions WHERE campaign_id=$1)`, [driftedId],
    ));
    const unsafeBudget = await send(api, 'POST', `/campaigns/${driftedId}/retry`, {}, 'retry-unsafe-budget');
    expect(unsafeBudget.statusCode).toBe(409);
    expect(unsafeBudget.json()).toMatchObject({ error: { code: 'campaign_retry_budget_unavailable' } });
    const rolledBack = await withTenant(api.pool, api.tenantId, async (sql) => {
      const result = await sql.query<{ state: string; retry_count: string }>(
        `SELECT c.control_state AS state,
                (SELECT count(*)::text FROM campaign_retry_runs run WHERE run.campaign_id=c.id) AS retry_count
           FROM campaigns c WHERE c.id=$1`, [driftedId],
      );
      return result.rows[0];
    });
    expect(rolledBack).toEqual({ state: 'dispatch_completed', retry_count: '0' });
  });

  it('sends only to an explicitly authorized test recipient through the ordinary dispatcher', async () => {
    const unknown = await send(api, 'POST', `/channels/${api.connectionId}/test-recipients`, {
      peerIdentity: '201099999999', label: 'Unknown phone',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: { code: 'test_recipient_unknown' } });

    const authorized = await send(api, 'POST', `/channels/${api.connectionId}/test-recipients`, {
      peerIdentity: '201000000000', label: 'QA owner',
    });
    expect(authorized.statusCode, authorized.body).toBe(201);
    const testRecipientId = (authorized.json() as { data: { id: string } }).data.id;
    expect((await send(api, 'GET', `/channels/${api.connectionId}/test-recipients`)).json()).toMatchObject({
      data: [{ id: testRecipientId, peer_identity: '201000000000', label: 'QA owner' }],
    });
    await expect(withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE channel_test_recipients SET label='rewritten' WHERE id=$1`, [testRecipientId],
    ))).rejects.toThrow('test recipient authorization history is immutable');
    await expect(withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `DELETE FROM channel_test_recipients WHERE id=$1`, [testRecipientId],
    ))).rejects.toThrow('permission denied');
    const duplicate = await send(api, 'POST', `/channels/${api.connectionId}/test-recipients`, {
      peerIdentity: '201000000000', label: 'Again',
    });
    expect(duplicate.statusCode).toBe(409);

    const created = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Authorized test send',
      content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-authorized-test-send');
    const campaign = (created.json() as { data: { id: string; version: number; revision_id: string } }).data;
    const staleVersion = await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId, expectedVersion: campaign.version + 1,
    }, 'stale-version-test-send');
    expect(staleVersion.statusCode).toBe(409);
    expect(staleVersion.json()).toMatchObject({ error: { code: 'version_conflict' } });
    const refused = await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId: randomUUID(), expectedVersion: campaign.version,
    }, 'unauthorized-test-send');
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: 'test_recipient_not_authorized' } });

    const queued = await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId, expectedVersion: campaign.version,
    }, 'authorized-test-send');
    expect(queued.statusCode, queued.body).toBe(202);
    const queuedData = (queued.json() as { data: { id: string; state: string; revision_id: string; peer_identity: string } }).data;
    expect(queuedData).toMatchObject({ state: 'queued', revision_id: campaign.revision_id, peer_identity: '201000000000' });
    const replay = await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId, expectedVersion: campaign.version,
    }, 'authorized-test-send');
    expect(replay.statusCode).toBe(202);
    expect((replay.json() as { data: unknown }).data).toEqual(queuedData);
    const reusedKey = await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId, expectedVersion: campaign.version + 1,
    }, 'authorized-test-send');
    expect(reusedKey.statusCode).toBe(409);
    expect(reusedKey.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });

    const evidence = await withTenant(api.pool, api.tenantId, async (sql) => {
      const rows = await sql.query<{ executions: string; snapshots: string; recipients: string; traffic_class: string }>(
        `SELECT (SELECT count(*)::text FROM campaign_executions WHERE campaign_id=$1) AS executions,
                (SELECT count(*)::text FROM audience_snapshots WHERE campaign_id=$1) AS snapshots,
                (SELECT count(*)::text FROM campaign_recipients r JOIN campaign_executions e ON e.id=r.execution_id WHERE e.campaign_id=$1) AS recipients,
                o.traffic_class
           FROM campaign_test_sends s JOIN outbox o ON o.message_id=s.message_id WHERE s.id=$2`,
        [campaign.id, queuedData.id],
      );
      return rows.rows[0];
    });
    expect(evidence).toEqual({ executions: '0', snapshots: '0', recipients: '0', traffic_class: 'interactive' });
    await expect(withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE campaign_test_sends SET requested_at=now() WHERE id=$1`, [queuedData.id],
    ))).rejects.toThrow('permission denied');
    await expect(withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `DELETE FROM campaign_test_sends WHERE id=$1`, [queuedData.id],
    ))).rejects.toThrow('permission denied');

    providerOutcomes.push({ status: 'accepted', providerMessageId: 'wamid.campaign.test.1', raw: {} });
    const sent = await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test-send', 'interactive');
    expect(sent).toMatchObject({ claimed: 1, accepted: 1 });
    expect(providerRequests.at(-1)).toMatchObject({
      kind: 'whatsapp',
      request: { peerIdentity: '201000000000', messageType: 'template', template: { name: 'course_open', language: 'ar' } },
    });

    const variableDraft = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Test render alias', content: { text: 'Hello {{first_name}}' },
      variables: { first_name: 'display_name' },
    }), 'create-test-render-alias');
    const variableCampaign = (variableDraft.json() as { data: { id: string; version: number } }).data;
    const variableSend = await send(api, 'POST', `/campaigns/${variableCampaign.id}/test-send`, {
      testRecipientId, expectedVersion: variableCampaign.version,
    }, 'test-render-alias');
    expect(variableSend.statusCode, variableSend.body).toBe(202);
    const variableMessageId = (variableSend.json() as { data: { message_id: string } }).data.message_id;
    const renderedText = await withTenant(api.pool, api.tenantId, async (sql) => {
      const row = await sql.query<{ text_body: string }>(
        `SELECT text_body FROM outbound_messages WHERE id=$1`, [variableMessageId],
      );
      await sql.query(`DELETE FROM outbox WHERE message_id=$1`, [variableMessageId]);
      return row.rows[0]?.text_body;
    });
    expect(renderedText).toBe('Hello Student 1');

    const invalidDraft = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Invalid test content', content: { unsupported: true },
    }), 'create-invalid-test-content');
    const invalidCampaign = (invalidDraft.json() as { data: { id: string; version: number } }).data;
    const invalidSend = await send(api, 'POST', `/campaigns/${invalidCampaign.id}/test-send`, {
      testRecipientId, expectedVersion: invalidCampaign.version,
    }, 'invalid-content-test-send');
    expect(invalidSend.statusCode).toBe(422);
    expect(invalidSend.json()).toMatchObject({ error: { code: 'invalid_campaign_content' } });

    const lockedDraft = await send(api, 'POST', '/campaigns', draft(api, {
      name: 'Locked test campaign', content: { template: { name: 'course_open', language: 'ar' } },
    }), 'create-locked-test-campaign');
    const lockedCampaign = (lockedDraft.json() as { data: { id: string; version: number } }).data;
    await withTenant(api.pool, api.tenantId, (sql) => sql.query(
      `UPDATE campaigns SET control_state='scheduled' WHERE id=$1`, [lockedCampaign.id],
    ));
    const lockedSend = await send(api, 'POST', `/campaigns/${lockedCampaign.id}/test-send`, {
      testRecipientId, expectedVersion: lockedCampaign.version,
    }, 'locked-campaign-test-send');
    expect(lockedSend.statusCode).toBe(409);
    expect(lockedSend.json()).toMatchObject({ error: { code: 'campaign_test_send_locked' } });

    expect((await send(api, 'DELETE', `/channels/${api.connectionId}/test-recipients/${testRecipientId}`)).statusCode).toBe(204);
    expect((await send(api, 'DELETE', `/channels/${api.connectionId}/test-recipients/${testRecipientId}`)).statusCode).toBe(404);
    expect((await send(api, 'GET', `/channels/${api.connectionId}/test-recipients`)).json()).toMatchObject({ data: [] });
    const afterRevoke = await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId, expectedVersion: campaign.version,
    }, 'revoked-test-send');
    expect(afterRevoke.statusCode).toBe(422);

    const reauthorized = await send(api, 'POST', `/channels/${api.connectionId}/test-recipients`, {
      peerIdentity: '201000000000', label: 'QA owner again',
    });
    const secondRecipientId = (reauthorized.json() as { data: { id: string } }).data.id;
    expect((await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId: secondRecipientId, expectedVersion: campaign.version,
    }, 'revoke-before-dispatch')).statusCode).toBe(202);
    expect((await send(api, 'DELETE', `/channels/${api.connectionId}/test-recipients/${secondRecipientId}`)).statusCode).toBe(204);
    const callsBeforeRevokedDispatch = providerRequests.length;
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test-revoked', 'interactive'))
      .toMatchObject({ claimed: 1, skipped: 1 });
    expect(providerRequests).toHaveLength(callsBeforeRevokedDispatch);

    const thirdAuthorization = await send(api, 'POST', `/channels/${api.connectionId}/test-recipients`, {
      peerIdentity: '201000000000', label: 'Revision fence',
    });
    const thirdRecipientId = (thirdAuthorization.json() as { data: { id: string } }).data.id;
    expect((await send(api, 'POST', `/campaigns/${campaign.id}/test-send`, {
      testRecipientId: thirdRecipientId, expectedVersion: campaign.version,
    }, 'stale-test-revision')).statusCode).toBe(202);
    const revised = await send(api, 'PATCH', `/campaigns/${campaign.id}`, {
      ...draft(api, { name: 'Authorized test send', content: { template: { name: 'course_changed', language: 'ar' } } }),
      expectedVersion: campaign.version,
    }, 'revise-after-test-send');
    expect(revised.statusCode).toBe(200);
    const callsBeforeStaleDispatch = providerRequests.length;
    expect(await api.app.get(ChannelDispatcherService).dispatch(api.tenantId, 10, 'campaign-test-stale', 'interactive'))
      .toMatchObject({ claimed: 1, skipped: 1 });
    expect(providerRequests).toHaveLength(callsBeforeStaleDispatch);
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
