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

/* -------------------------------------------------------------- channels -- */

export {
  CHANNEL_KINDS,
  CHANNEL_PROVIDERS,
  EVIDENCE_KINDS,
  isChannelKind,
  missingEvidence,
  PROVIDER_OF,
  READINESS_STATES,
  readinessOf,
} from './channels/kinds.js';
export type {
  ChannelKind,
  ChannelProvider,
  EvidenceKind,
  EvidenceRecord,
  Readiness,
  ReadinessInput,
} from './channels/kinds.js';

export {
  CAPABILITY_MATRICES,
  capabilitiesFor,
  measureText,
  PINNED_GRAPH_VERSION,
  utf8Length,
} from './channels/capabilities.js';
export type { CapabilityMatrix, TextLimit, TextMeasurement } from './channels/capabilities.js';

export type { ChannelCrypto } from './channels/crypto.js';

export { permitSend, REFUSAL_REASONS } from './channels/policy.js';
export type { RefusalReason, SendPermit, SendRequest } from './channels/policy.js';

export { ADAPTER_PORT_VERSION, INBOUND_KINDS, SIGNATURE_REFUSALS } from './channels/port.js';
export type {
  ChannelAdapter,
  ChannelTransport,
  ConnectionCheck,
  InboundAttachment,
  InboundKind,
  NormalizedBatch,
  NormalizedEvent,
  QuarantinedElement,
  SendCommand,
  SendOutcome,
  SignatureInput,
  SignatureRefusal,
  SignatureVerdict,
} from './channels/port.js';

export {
  answerMetaChallenge,
  REPLAY_WINDOW_SECONDS,
  verifyMetaSignature,
} from './channels/meta-signature.js';

export {
  classifyOutcome,
  COMMAND_STATES,
  DELIVERY_STATES,
  foldDelivery,
  mayAutoRetry,
} from './channels/outcome.js';
export type {
  ClassifierInput,
  CommandState,
  DeliveryFold,
  DeliveryState,
  TransportObservation,
} from './channels/outcome.js';

export { WhatsAppAdapter } from './channels/whatsapp.js';
export { MessengerAdapter } from './channels/messenger.js';
export { InstagramAdapter } from './channels/instagram.js';
export {
  originAllowed,
  WEB_CHAT_REPLAY_WINDOW_SECONDS,
  WEB_CHAT_SIGNATURE_HEADER,
  WEB_CHAT_TIMESTAMP_HEADER,
  WebChatAdapter,
} from './channels/web-chat.js';
export {
  CUSTOM_CHANNEL_VERSIONS,
  CUSTOM_EVENT_TYPES,
  CUSTOM_REPLAY_WINDOW_SECONDS,
  CUSTOM_SIGNATURE_HEADER,
  CUSTOM_TIMESTAMP_HEADER,
  CustomChannelAdapter,
  negotiateCustomTypes,
} from './channels/custom-channel.js';
