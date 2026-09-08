import { describe, expect, it } from 'vitest';
import {
  INSTANCE_CAPABILITY_KEYS,
  INSTANCE_DESCRIPTOR_KEYS,
  describeInstance,
  type DescribeInstanceInput,
} from './instance.js';

const saasInput: DescribeInstanceInput = {
  deploymentMode: 'saas',
  installationName: 'CONVO Cloud',
  defaultLocale: 'ar',
  supportedLocales: ['ar', 'en'],
  bootstrapRequired: false,
  ssoConfigured: true,
  mfaAvailable: true,
};

describe('describeInstance (MODE-02)', () => {
  it('marks a SaaS installation multi-tenant with self-service signup', () => {
    const descriptor = describeInstance(saasInput);
    expect(descriptor.deploymentMode).toBe('saas');
    expect(descriptor.capabilities.multiTenant).toBe(true);
    expect(descriptor.capabilities.selfServiceSignup).toBe(true);
    expect(descriptor.apiVersion).toBe('v1');
  });

  it('never offers signup on a single-company installation', () => {
    const descriptor = describeInstance({
      ...saasInput,
      deploymentMode: 'self_hosted_single',
      bootstrapRequired: true,
    });
    expect(descriptor.capabilities.multiTenant).toBe(false);
    expect(descriptor.capabilities.selfServiceSignup).toBe(false);
    expect(descriptor.bootstrapRequired).toBe(true);
  });

  it('reports SSO and MFA as presence flags only', () => {
    const descriptor = describeInstance({ ...saasInput, ssoConfigured: false, mfaAvailable: false });
    expect(descriptor.capabilities.ssoConfigured).toBe(false);
    expect(descriptor.capabilities.mfaAvailable).toBe(false);
    expect(Object.keys(descriptor.capabilities).sort()).toEqual([...INSTANCE_CAPABILITY_KEYS]);
  });

  /**
   * The point of this test is not the key list -- it is that adding a field to
   * the pre-authentication descriptor has to be a deliberate edit here, so a
   * config field cannot become public by accident.
   */
  it('exposes exactly the documented public key set and nothing else', () => {
    const descriptor = describeInstance(saasInput);
    expect(Object.keys(descriptor).sort()).toEqual([...INSTANCE_DESCRIPTOR_KEYS]);
  });

  it('leaks no secret that was never handed to it', () => {
    const serialized = JSON.stringify(describeInstance(saasInput));
    for (const forbidden of [
      'password',
      'secret',
      'token',
      'issuer',
      'CONVO_PG',
      'tenants',
      'connectionString',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
