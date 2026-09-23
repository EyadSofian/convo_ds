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

export {
  CUSTOM_FIELD_TARGETS,
  CUSTOM_FIELD_TYPES,
  isCustomFieldTarget,
  isCustomFieldType,
  normalizeSearchText,
  validateFieldValue,
} from './metadata/custom-fields.js';

export {
  CONDITION_OPERATORS,
  CONDITION_VERSION,
  validateConditionDocument,
} from './conditions/condition.js';
export type {
  ConditionContext,
  ConditionDocument,
  ConditionGroup,
  ConditionIssue,
  ConditionNode,
  ConditionOperator,
  ConditionPredicate,
  ConditionScalar,
  ConditionValidation,
} from './conditions/condition.js';
export type {
  CustomFieldDefinition,
  CustomFieldTarget,
  CustomFieldType,
  CustomFieldValue,
  FieldValueResult,
} from './metadata/custom-fields.js';

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
export { buildWhatsAppTemplateComponents, defineWhatsAppTemplate, renderWhatsAppTemplatePreview } from './channels/whatsapp-template.js';
export type {
  WhatsAppTemplateComponentKind,
  WhatsAppTemplateDefinition,
  WhatsAppTemplateParameter,
  WhatsAppTemplateParameterDefinition,
  WhatsAppTemplateSendComponent,
  WhatsAppTemplateViewComponent,
} from './channels/whatsapp-template.js';

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

export {
  DEFAULT_INTERACTIVE_RESERVATION,
  interactiveFloor,
  planRound,
} from './channels/fairness.js';
export type { FairnessConfig, FairnessPlan, Grant, Offer } from './channels/fairness.js';

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

/* -------------------------------------------------------------- realtime -- */

export {
  isRealtimeEventType,
  REALTIME_EVENT_TYPES,
  REALTIME_SCHEMA_VERSION,
} from './realtime/events.js';
export type {
  QueueCard,
  RealtimeEnvelope,
  RealtimeEventType,
  RealtimeScope,
} from './realtime/events.js';

export { maskIdentity, projectQueueCard, visibilityOf } from './realtime/visibility.js';
export type { Visibility } from './realtime/visibility.js';

export { canonicalAuthority } from './realtime/authority.js';

export { checkCursor, decodeCursor, encodeCursor } from './realtime/cursor.js';
export type { Cursor, CursorCheck, CursorRejection } from './realtime/cursor.js';

/* --------------------------------------------------------- conversations -- */

export {
  applyTrigger,
  checkSnooze,
  CONVERSATION_STATES,
  isConversationState,
  LIFECYCLE_EFFECTS,
  LIFECYCLE_TRIGGERS,
  occupiesIdentity,
} from './conversations/lifecycle.js';

export { INBOX_FILTER_CATALOGUE, INBOX_FILTER_KEYS, inboxFilterDefinition } from './conversations/inbox-filters.js';
export type { InboxFilterDefinition, InboxFilterGroup, InboxFilterKey, InboxFilterValueType } from './conversations/inbox-filters.js';
export { INBOX_QUERY_DEFAULT, INBOX_SORTS, isInboxQuery } from './conversations/inbox-query.js';
export type { InboxFilter, InboxQuery, InboxQueue, InboxSort } from './conversations/inbox-query.js';
export { adaptSavedViewToInboxFilters, inboxFiltersToSavedViewDocument } from './conversations/inbox-saved-view.js';
export type { SavedViewInboxAdapterResult } from './conversations/inbox-saved-view.js';
export type {
  ConversationState,
  LifecycleEffect,
  LifecycleOutcome,
  LifecycleRefusal,
  LifecycleTrigger,
  SnoozeRefusal,
  SnoozeRequest,
} from './conversations/lifecycle.js';

export {
  ASSIGNMENT_ACTS,
  checkHandoffAction,
  checkHandoffExpiry,
  HANDOFF_ACTIONS,
  HANDOFF_DEFAULT_TTL_MS,
  HANDOFF_MAX_TTL_MS,
  HANDOFF_MIN_TTL_MS,
  HANDOFF_STATES,
  isLiveHandoff,
  isOwnerState,
  OWNER_STATES,
  ownershipPermits,
  settledStateOf,
} from './conversations/routing.js';

/* ------------------------------------------------------------- campaigns -- */

export {
  applyCampaignTrigger,
  campaignEditTarget,
  CAMPAIGN_EFFECTS,
  CAMPAIGN_STATES,
  CAMPAIGN_TRIGGERS,
  isCampaignState,
} from './campaigns/lifecycle.js';
export type {
  CampaignEffect,
  CampaignRefusal,
  CampaignState,
  CampaignTransition,
  CampaignTrigger,
} from './campaigns/lifecycle.js';
export {
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_STEP_TYPES,
  AUTOMATION_TARGETS,
  AUTOMATION_TRIGGERS,
  validateAutomationWorkflow,
  validateVariableMapping,
} from './automations/workflow.js';
export { nextScheduledAt, validateScheduleDefinition } from './automations/schedule.js';
export type { ScheduleDefinition, ScheduleIssue, ScheduleKind } from './automations/schedule.js';
export type {
  AutomationStep,
  AutomationStepType,
  AutomationTargetType,
  AutomationTrigger,
  AutomationWorkflow,
  WorkflowIssue,
  WorkflowValidation,
} from './automations/workflow.js';
export type {
  AssignmentAct,
  HandoffAction,
  HandoffActor,
  HandoffOffer,
  HandoffRefusal,
  HandoffState,
  HandoffTtlRefusal,
  OwnerState,
  OwnershipRefusal,
  SendActor,
} from './conversations/routing.js';

/* ----------------------------------------------------------------- Email -- */

export {
  INVITATION_PATH,
  RECOVERY_PATH,
  escapeHtml,
  invitationUrl,
  recoveryUrl,
  renderInvitationEmail,
  renderRecoveryEmail,
} from './email/messages.js';
export type {
  EmailLocale,
  InvitationEmailInput,
  RecoveryEmailInput,
  RenderedEmail,
} from './email/messages.js';
