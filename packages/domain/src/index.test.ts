import { describe, expect, it } from 'vitest';
import * as domain from './index.js';

describe('@convo/domain public surface', () => {
  it('exports exactly the documented runtime members', () => {
    expect(Object.keys(domain).sort()).toEqual([
      'BOOTSTRAP_STATES',
      'BUILTIN_ROLES',
      'BUILTIN_ROLE_KEYS',
      'ConfigurationError',
      'NON_DELEGABLE_PERMISSIONS',
      'PERMISSION_KEYS',
      'QUEUE_CARD_FIELDS',
      'SCOPE_LEVELS',
      'applyInstallationConfig',
      'authorize',
      'bootstrapInstallation',
      'canAssignRole',
      'canAuthorRole',
      'canGrantScopes',
      'grantsOf',
      'isDelegable',
      'isPermissionKey',
      'narrowest',
      'parseInstallationConfig',
      'projectFields',
      'reachFor',
      'readBootstrapState',
      'scopeCovers',
      'scopeFor',
    ]);
  });

  it('does not export the test doubles that live beside the domain code', () => {
    expect(Object.keys(domain)).not.toContain('fakeSql');
    expect(Object.keys(domain)).not.toContain('fakeTransaction');
  });
});
