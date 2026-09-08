/**
 * Deployment mode is installation configuration, never request data.
 *
 * The literal union lives in the contracts package because three consumers
 * need the same vocabulary -- the boot-time configuration parser, the
 * `GET /instance` descriptor and the database CHECK constraint in
 * `0001_foundation.sql`. Keeping one definition is what stops a fourth
 * spelling ("single", "onprem") from appearing in a later phase.
 */
export const DEPLOYMENT_MODES = ['saas', 'self_hosted_single'] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export function isDeploymentMode(value: unknown): value is DeploymentMode {
  return typeof value === 'string' && (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

export const UI_LOCALES = ['ar', 'en'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value);
}
