import type { DeploymentMode, UiLocale } from './deployment.js';

/**
 * The body of `GET /instance` (MODE-02).
 *
 * This endpoint is reachable before authentication: the login screen needs it
 * to decide whether to render a first-run bootstrap form, a plain sign-in, or
 * an SSO button. Everything it exposes is therefore public by definition.
 *
 * The descriptor is built field by field from an explicit input rather than by
 * stripping fields off the installation config. That direction matters: a
 * field added to the config in a later phase cannot leak here by accident,
 * because it would have to be typed into this file to appear at all.
 */
export interface InstanceDescriptor {
  readonly apiVersion: 'v1';
  readonly deploymentMode: DeploymentMode;
  readonly installationName: string;
  readonly defaultLocale: UiLocale;
  readonly supportedLocales: readonly UiLocale[];
  /** True while the one-time installation bootstrap has not been completed. */
  readonly bootstrapRequired: boolean;
  readonly capabilities: InstanceCapabilities;
}

export interface InstanceCapabilities {
  /** Whether this installation may hold more than one company. */
  readonly multiTenant: boolean;
  /** Whether an unauthenticated visitor may create a company. */
  readonly selfServiceSignup: boolean;
  /** Presence only. No issuer, client id, secret or discovery URL. */
  readonly ssoConfigured: boolean;
  readonly mfaAvailable: boolean;
}

export interface DescribeInstanceInput {
  readonly deploymentMode: DeploymentMode;
  readonly installationName: string;
  readonly defaultLocale: UiLocale;
  readonly supportedLocales: readonly UiLocale[];
  readonly bootstrapRequired: boolean;
  readonly ssoConfigured: boolean;
  readonly mfaAvailable: boolean;
}

/**
 * The exact key set of the public descriptor. Asserted by a test, so adding a
 * field to `InstanceDescriptor` without deciding that it is public fails the
 * suite instead of shipping.
 */
export const INSTANCE_DESCRIPTOR_KEYS = [
  'apiVersion',
  'bootstrapRequired',
  'capabilities',
  'defaultLocale',
  'deploymentMode',
  'installationName',
  'supportedLocales',
] as const;

export const INSTANCE_CAPABILITY_KEYS = [
  'mfaAvailable',
  'multiTenant',
  'selfServiceSignup',
  'ssoConfigured',
] as const;

export function describeInstance(input: DescribeInstanceInput): InstanceDescriptor {
  const multiTenant = input.deploymentMode === 'saas';
  return {
    apiVersion: 'v1',
    deploymentMode: input.deploymentMode,
    installationName: input.installationName,
    defaultLocale: input.defaultLocale,
    supportedLocales: input.supportedLocales,
    bootstrapRequired: input.bootstrapRequired,
    capabilities: {
      multiTenant,
      // A single-company installation never offers open signup: the one company
      // it may ever hold is created by the one-time bootstrap (MODE-03/MODE-04).
      selfServiceSignup: multiTenant,
      ssoConfigured: input.ssoConfigured,
      mfaAvailable: input.mfaAvailable,
    },
  };
}
