import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';

/**
 * The published surface of a package is a contract with every other package.
 * Asserting it here means a rename or an accidental export shows up as a
 * failing test rather than as a downstream import that quietly still resolves.
 */
describe('@convo/contracts public surface', () => {
  it('exports exactly the documented runtime members', () => {
    expect(Object.keys(contracts).sort()).toEqual([
      'DEPLOYMENT_MODES',
      'INSTANCE_CAPABILITY_KEYS',
      'INSTANCE_DESCRIPTOR_KEYS',
      'UI_LOCALES',
      'describeInstance',
      'errorEnvelope',
      'isDeploymentMode',
      'isUiLocale',
    ]);
  });

  it('re-exports working implementations, not empty bindings', () => {
    expect(contracts.isDeploymentMode('saas')).toBe(true);
    expect(contracts.describeInstance).toBeTypeOf('function');
  });
});
