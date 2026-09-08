import { describe, expect, it } from 'vitest';
import { fakeSql } from '../testing/fake-sql.js';
import { applyInstallationConfig, readBootstrapState } from './state.js';

describe('applyInstallationConfig', () => {
  it('creates the singleton row on a fresh installation', async () => {
    const sql = fakeSql([
      { match: /INSERT INTO installations/, rows: [{ deployment_mode: 'saas', bootstrap_state: 'pending' }] },
    ]);
    const result = await applyInstallationConfig(sql, 'saas');
    expect(result).toEqual({ status: 'created', deploymentMode: 'saas' });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.text).toContain('ON CONFLICT (singleton) DO NOTHING');
  });

  it('is a no-op on a subsequent boot in the same mode', async () => {
    const sql = fakeSql([
      { match: /SELECT deployment_mode/, rows: [{ deployment_mode: 'saas', bootstrap_state: 'completed' }] },
    ]);
    const result = await applyInstallationConfig(sql, 'saas');
    expect(result).toEqual({
      status: 'unchanged',
      deploymentMode: 'saas',
      bootstrapState: 'completed',
    });
  });

  /**
   * The behaviour that matters: an operator cannot convert a provisioned SaaS
   * installation into a single-company one by editing an environment variable.
   */
  it('refuses to boot into a mode the stored data was not provisioned for', async () => {
    const sql = fakeSql([
      { match: /SELECT deployment_mode/, rows: [{ deployment_mode: 'saas', bootstrap_state: 'completed' }] },
    ]);
    const result = await applyInstallationConfig(sql, 'self_hosted_single');
    expect(result).toMatchObject({
      status: 'mismatch',
      code: 'installation_mode_mismatch',
      configured: 'self_hosted_single',
      recorded: 'saas',
    });
  });

  it('reports a vanished installation row instead of asserting it exists', async () => {
    const result = await applyInstallationConfig(fakeSql(), 'saas');
    expect(result).toMatchObject({ status: 'mismatch', recorded: 'missing' });
  });
});

describe('readBootstrapState', () => {
  it('returns the recorded state', async () => {
    const sql = fakeSql([{ match: /SELECT bootstrap_state/, rows: [{ bootstrap_state: 'pending' }] }]);
    await expect(readBootstrapState(sql)).resolves.toBe('pending');
  });

  it('returns null when there is no installation row', async () => {
    await expect(readBootstrapState(fakeSql())).resolves.toBeNull();
  });
});
