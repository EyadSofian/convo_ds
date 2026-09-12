import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../packages/database/src/context.js';
import { runtimePool, seedTenant, type SeededTenant } from '../support/pools.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

interface Graph {
  campaignId: string;
  revisionId: string;
  snapshotId: string;
  connectionId: string;
}

describe('campaign database foundation', () => {
  let pool: Pool;
  let first: SeededTenant;
  let second: SeededTenant;
  let suffix = 0;

  beforeAll(async () => {
    pool = runtimePool(6);
    first = await seedTenant(pool, `campaign-a-${randomUUID()}`);
    second = await seedTenant(pool, `campaign-b-${randomUUID()}`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function graph(tenant = first): Promise<Graph> {
    suffix += 1;
    return withTenant(pool, tenant.tenantId, async (client) => {
      const connection = await client.query<{ id: string }>(
        `INSERT INTO channel_connections
           (tenant_id,kind,external_asset_id,display_name)
         VALUES ($1,'whatsapp',$2,$3) RETURNING id::text`,
        [tenant.tenantId, `phone-${suffix}`, `WhatsApp ${suffix}`],
      );
      const connectionId = connection.rows[0]!.id;
      const campaign = await client.query<{ id: string }>(
        `INSERT INTO campaigns (tenant_id,name,connection_id,created_by_membership_id)
         VALUES ($1,$2,$3,$4) RETURNING id::text`,
        [tenant.tenantId, `Campaign ${suffix}`, connectionId, tenant.ownerMembershipId],
      );
      const campaignId = campaign.rows[0]!.id;
      const revision = await client.query<{ id: string }>(
        `INSERT INTO campaign_revisions
           (tenant_id,campaign_id,revision,content,revision_hash,created_by_membership_id)
         VALUES ($1,$2,1,$3,$4,$5) RETURNING id::text`,
        [tenant.tenantId, campaignId, { text: 'Welcome {{name}}' }, HASH_A, tenant.ownerMembershipId],
      );
      const revisionId = revision.rows[0]!.id;
      await client.query(
        `UPDATE campaigns SET current_revision_id=$1,control_state='ready' WHERE id=$2`,
        [revisionId, campaignId],
      );
      const snapshot = await client.query<{ id: string }>(
        `INSERT INTO audience_snapshots (tenant_id,campaign_id,revision_id,source,counts)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
        [tenant.tenantId, campaignId, revisionId, { filter: 'all' }, { eligible: 1, excluded: 0 }],
      );
      return { campaignId, revisionId, snapshotId: snapshot.rows[0]!.id, connectionId };
    });
  }

  it('keeps revisions and audience snapshots immutable', async () => {
    const item = await graph();
    await expect(withTenant(pool, first.tenantId, (client) =>
      client.query(`UPDATE campaign_revisions SET content='{}' WHERE id=$1`, [item.revisionId]),
    )).rejects.toThrow(/permission denied for table campaign_revisions/);
    await expect(withTenant(pool, first.tenantId, (client) =>
      client.query(`DELETE FROM audience_snapshots WHERE id=$1`, [item.snapshotId]),
    )).rejects.toThrow(/permission denied for table audience_snapshots/);
  });

  it('binds approval to the exact revision hash and allows only one live approval', async () => {
    const item = await graph();
    await expect(withTenant(pool, first.tenantId, (client) => client.query(
        `INSERT INTO campaign_approvals
           (tenant_id,campaign_id,revision_id,revision_hash,approver_membership_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [first.tenantId, item.campaignId, item.revisionId, HASH_B, first.ownerMembershipId],
      ))).rejects.toThrow(/campaign_approvals_revision_fk/);
    await withTenant(pool, first.tenantId, async (client) => {
      await client.query(
        `INSERT INTO campaign_approvals
           (tenant_id,campaign_id,revision_id,revision_hash,approver_membership_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [first.tenantId, item.campaignId, item.revisionId, HASH_A, first.ownerMembershipId],
      );
    });
    await expect(withTenant(pool, first.tenantId, (client) => client.query(
        `INSERT INTO campaign_approvals
           (tenant_id,campaign_id,revision_id,revision_hash,approver_membership_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [first.tenantId, item.campaignId, item.revisionId, HASH_A, first.ownerMembershipId],
      ))).rejects.toThrow(/campaign_approvals_live_uq/);
  });

  it('creates exactly one execution under concurrent launch attempts', async () => {
    const item = await graph();
    const launch = () => withTenant(pool, first.tenantId, (client) => client.query(
      `INSERT INTO campaign_executions
         (tenant_id,campaign_id,revision_id,audience_snapshot_id,state,started_at)
       VALUES ($1,$2,$3,$4,'running',now()) RETURNING id`,
      [first.tenantId, item.campaignId, item.revisionId, item.snapshotId],
    ));
    const results = await Promise.allSettled([launch(), launch()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const count = await withTenant(pool, first.tenantId, (client) => client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_executions WHERE campaign_id=$1`,
      [item.campaignId],
    ));
    expect(count.rows[0]!.count).toBe('1');
  });

  it('rejects an execution whose snapshot belongs to another campaign', async () => {
    const one = await graph();
    const two = await graph();
    await expect(withTenant(pool, first.tenantId, (client) => client.query(
        `INSERT INTO campaign_executions
           (tenant_id,campaign_id,revision_id,audience_snapshot_id,state,started_at)
         VALUES ($1,$2,$3,$4,'running',now())`,
        [first.tenantId, one.campaignId, one.revisionId, two.snapshotId],
      ))).rejects.toThrow(/execution revision and audience must belong to campaign/);
  });

  it('keeps recipient identity unique and budget quantities exact', async () => {
    const item = await graph();
    const ids = await withTenant(pool, first.tenantId, async (client) => {
      const execution = await client.query<{ id: string }>(
        `INSERT INTO campaign_executions
           (tenant_id,campaign_id,revision_id,audience_snapshot_id,state,started_at)
         VALUES ($1,$2,$3,$4,'running',now()) RETURNING id::text`,
        [first.tenantId, item.campaignId, item.revisionId, item.snapshotId],
      );
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id,display_name) VALUES ($1,'A customer') RETURNING id::text`,
        [first.tenantId],
      );
      const identity = await client.query<{ id: string }>(
        `INSERT INTO contact_identities (tenant_id,contact_id,kind,scope_id,external_id)
         VALUES ($1,$2,'whatsapp',$3,'201000000001') RETURNING id::text`,
        [first.tenantId, contact.rows[0]!.id, item.connectionId],
      );
      const recipient = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (tenant_id,execution_id,contact_id,identity_id,snapshot_eligibility)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
        [first.tenantId, execution.rows[0]!.id, contact.rows[0]!.id, identity.rows[0]!.id, { eligible: true }],
      );
      return {
        executionId: execution.rows[0]!.id,
        contactId: contact.rows[0]!.id,
        identityId: identity.rows[0]!.id,
        recipientId: recipient.rows[0]!.id,
      };
    });
    await expect(withTenant(pool, first.tenantId, (client) => client.query(
        `INSERT INTO campaign_recipients
           (tenant_id,execution_id,contact_id,identity_id,snapshot_eligibility)
         VALUES ($1,$2,$3,$4,$5)`,
        [first.tenantId, ids.executionId, ids.contactId, ids.identityId, { eligible: true }],
      ))).rejects.toThrow(/campaign_recipients_identity_uq/);
    await withTenant(pool, first.tenantId, async (client) => {
      await client.query(
        `INSERT INTO budget_reservations
           (tenant_id,execution_id,recipient_id,estimated_amount_minor,reserved_amount_minor,currency)
         VALUES ($1,$2,$3,'0.123456','0.123456','USD')`,
        [first.tenantId, ids.executionId, ids.recipientId],
      );
      const amount = await client.query<{ amount: string }>(
        `SELECT reserved_amount_minor::text AS amount FROM budget_reservations WHERE recipient_id=$1`,
        [ids.recipientId],
      );
      expect(amount.rows[0]!.amount).toBe('0.123456');
    });
  });

  it('enforces tenant isolation on every campaign record', async () => {
    const item = await graph(first);
    const visible = await withTenant(pool, second.tenantId, (client) => Promise.all([
      client.query(`SELECT id FROM campaigns WHERE id=$1`, [item.campaignId]),
      client.query(`SELECT id FROM campaign_revisions WHERE id=$1`, [item.revisionId]),
      client.query(`SELECT id FROM audience_snapshots WHERE id=$1`, [item.snapshotId]),
    ]));
    expect(visible.map((result) => result.rowCount)).toEqual([0, 0, 0]);
  });
});
