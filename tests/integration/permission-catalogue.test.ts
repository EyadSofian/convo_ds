import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runtimePool } from '../support/pools.js';

/**
 * IAM-08: authorization is checked by permission key. This asserts the
 * catalogue exists and that the keys the specification names are all present --
 * a missing key would silently become a check nobody can write.
 */
describe('permission catalogue', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = runtimePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  const required = [
    'conversation.read',
    'conversation.unassigned.preview',
    'conversation.reply',
    'conversation.note',
    'conversation.claim',
    'conversation.assign',
    'conversation.close',
    'contact.read',
    'contact.edit',
    'contact.merge',
    'contact.export',
    'consent.read',
    'consent.record',
    'suppression.write',
    'campaign.read',
    'campaign.draft',
    'campaign.approve',
    'campaign.launch',
    'campaign.control',
    'automation.read',
    'automation.create',
    'automation.edit',
    'automation.activate',
    'automation.pause',
    'automation.test',
    'channel.manage',
    'credential.rotate',
    'member.manage',
    'role.manage',
    'integration.manage',
    'api_key.manage',
    'report.read',
    'audit.read',
    'retention.manage',
    'tenant.delete',
  ];

  it('contains every permission key named by the specification', async () => {
    const { rows } = await pool.query<{ key: string }>('SELECT key FROM permissions ORDER BY key');
    const present = rows.map((r) => r.key);

    for (const key of required) {
      expect(present, `missing permission key: ${key}`).toContain(key);
    }
  });

  it('marks privileged keys as non-delegable', async () => {
    const { rows } = await pool.query<{ key: string; delegable: boolean }>(
      'SELECT key, delegable FROM permissions WHERE key = ANY($1)',
      [['channel.manage', 'role.manage', 'api_key.manage', 'tenant.delete', 'campaign.approve']],
    );

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.delegable, `${row.key} must not be delegable`).toBe(false);
    }
  });

  it('is read-only for the runtime role', async () => {
    await expect(
      pool.query("INSERT INTO permissions (key, description) VALUES ('made.up', 'nope')"),
    ).rejects.toThrow(/permission denied/i);
  });
});
