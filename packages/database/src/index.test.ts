import { describe, expect, it } from 'vitest';
import * as database from './index.js';

describe('@convo/database public surface', () => {
  it('exports exactly the documented runtime members', () => {
    expect(Object.keys(database).sort()).toEqual([
      'EXIT_FAILED',
      'EXIT_OK',
      'EXIT_USAGE',
      'MIGRATIONS_DIR',
      'TenantContextError',
      'asExecutor',
      'bootstrapCluster',
      'enableInstallationContext',
      'migrate',
      'productionDeps',
      'runCli',
      'setTenantContext',
      'tenantTransaction',
      'withCredentialResolvedTenant',
      'withTenant',
    ]);
  });

  it('keeps the exit codes distinct, because operators branch on them', () => {
    expect(new Set([database.EXIT_OK, database.EXIT_FAILED, database.EXIT_USAGE]).size).toBe(3);
  });

  it('does not export the pg test double', () => {
    expect(Object.keys(database)).not.toContain('fakePool');
  });
});
