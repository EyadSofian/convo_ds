import { describe, expect, it } from 'vitest';
import * as domain from './index.js';

describe('@convo/domain public surface', () => {
  it('exports exactly the documented runtime members', () => {
    expect(Object.keys(domain).sort()).toEqual([
      'BOOTSTRAP_STATES',
      'ConfigurationError',
      'applyInstallationConfig',
      'bootstrapInstallation',
      'parseInstallationConfig',
      'readBootstrapState',
    ]);
  });

  it('does not export the test doubles that live beside the domain code', () => {
    expect(Object.keys(domain)).not.toContain('fakeSql');
    expect(Object.keys(domain)).not.toContain('fakeTransaction');
  });
});
