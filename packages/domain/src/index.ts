export { ConfigurationError, parseInstallationConfig } from './installation/config.js';
export type { EnvironmentSource, InstallationConfig } from './installation/config.js';

export { BOOTSTRAP_STATES, applyInstallationConfig, readBootstrapState } from './installation/state.js';
export type { BootstrapState, InstallationStateResult } from './installation/state.js';

export { bootstrapInstallation } from './installation/bootstrap.js';
export type {
  InstallationBootstrapDeps,
  InstallationBootstrapInput,
  InstallationBootstrapRejection,
  InstallationBootstrapResult,
} from './installation/bootstrap.js';

export type { SqlExecutor, SqlResult, TenantTransaction } from './ports/sql.js';

/* ------------------------------------------------------------------- IAM -- */

export {
  isDelegable,
  isPermissionKey,
  NON_DELEGABLE_PERMISSIONS,
  PERMISSION_KEYS,
} from './iam/permissions.js';
export type { PermissionKey } from './iam/permissions.js';

export {
  BUILTIN_ROLE_KEYS,
  BUILTIN_ROLES,
  grantsOf,
  narrowest,
  scopeCovers,
  scopeFor,
  SCOPE_LEVELS,
} from './iam/roles.js';
export type { BuiltinRole, BuiltinRoleKey, ScopeLevel } from './iam/roles.js';

export {
  authorize,
  projectFields,
  QUEUE_CARD_FIELDS,
  reachFor,
} from './iam/authorize.js';
export type {
  Decision,
  DenialReason,
  Principal,
  ResourceRef,
  ScopeGrant,
} from './iam/authorize.js';

export { canAssignRole, canAuthorRole, canGrantScopes } from './iam/delegation.js';
export type {
  DelegationRefusal,
  DelegationResult,
  GrantMap,
  ScopeRequest,
} from './iam/delegation.js';
