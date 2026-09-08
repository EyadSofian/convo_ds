# CONVO — `/api/v1` operation inventory

The **minimum** inventory from MASTER-PROMPT §19. This is not permission to add undocumented helper endpoints: CI diffs registered routes against the OpenAPI spec in both directions (API-02).

`T` = `/tenants/{tenant_id}` (expanded in the spec). IDs are opaque strings. Timestamps are UTC ISO 8601. Timezones are IANA names. An inbox ID, a provider asset ID and a company ID are never the same identifier.

Every operation below needs: one `operationId`, request/response/error schemas, at least one example, a written authorization rule, and a contract test.

## Conventions

- Pagination: `{ "data": [], "page": { "next_cursor": null, "has_more": false }, "request_id": "…" }`. Cursors are opaque, tamper-resistant, and bound to tenant + filter + sort. Expiry returns a typed error with a safe refresh path. Exact totals are avoided; approximate counts are labelled with their freshness.
- Errors: `{ "error": { "code": "…", "message": "…", "request_id": "…", "details": [] } }`. Stable codes exist for: permission denial, validation, expired window, unsupported capability, invalid template, missing consent, budget, idempotency conflict, stale revision, disconnected channel, outcome unknown, provider throttle.
- 401 unauthenticated · 403 permitted-resource action denial · **404 (same shape as nonexistent) for resources unknown to the caller** · 409 conflict · 429 with guidance · 202 accepted async · 201 sync create. **Never 200 with a hidden error.**
- `Idempotency-Key` on mutating retryable commands. `If-Match` on contested updates.
- State-changing endpoints never use GET.

## Inventory

| Group | Method + path | operationId | Permission / scope | Phase |
|---|---|---|---|---|
| Bootstrap | `GET /instance` | `getInstance` | public, sanitized | P1 |
| Bootstrap | `POST /instance/bootstrap` | `bootstrapInstallation` | one-use local bootstrap secret | P1 |
| Session | `POST /auth/login` | `login` | public + abuse protection | P1 |
| Session | `POST /auth/logout` | `logout` | session | P1 |
| Session | `POST /auth/recovery` | `startRecovery` | public, generic response | P1 |
| Session | `POST /auth/recovery/complete` | `completeRecovery` | single-use token | P1 |
| Session | `GET /auth/session` | `getSession` | session | P1 |
| Session | `GET /auth/sessions` | `listSessions` | session | P1 |
| Session | `GET /auth/sessions/{id}` | `getSessionById` | own session | P1 |
| Session | `DELETE /auth/sessions/{id}` | `revokeSession` | own session | P1 |
| SSO/MFA | `GET /auth/oidc/start` | `startOidc` | public; state+nonce+PKCE | P8 |
| SSO/MFA | `GET /auth/oidc/callback` | `oidcCallback` | validated state | P8 |
| SSO/MFA | `POST /auth/mfa/enroll` | `enrollMfa` | fresh auth | P1 |
| SSO/MFA | `POST /auth/mfa/verify` | `verifyMfa` | one-use challenge | P1 |
| SSO/MFA | `POST /auth/mfa/recovery-codes` | `regenerateRecoveryCodes` | fresh auth | P1 |
| Tenant | `GET /me/memberships` | `listMyMemberships` | session | P1 |
| Tenant | `GET T/settings` | `getTenantSettings` | membership | P1 |
| Tenant | `PATCH T/settings` | `updateTenantSettings` | authorized settings grant | P1 |
| Platform | `GET /platform/tenants` | `listPlatformTenants` | platform grant | P1 |
| Platform | `POST /platform/tenants` | `provisionTenant` | platform grant; rejected in `self_hosted_single` | P1 |
| Platform | `GET /platform/tenants/{id}` | `getPlatformTenant` | platform grant | P1 |
| Platform | `PATCH /platform/tenants/{id}` | `updatePlatformTenant` | platform grant | P1 |
| Platform | `POST /platform/tenants/{id}/suspend` | `suspendTenant` | platform grant | P4 |
| Platform | `POST /platform/tenants/{id}/reactivate` | `reactivateTenant` | platform grant | P4 |
| Platform | `GET /platform/health` | `getPlatformHealth` | platform grant | P1 |
| Ownership | `POST T/ownership-transfers` | `createOwnershipTransfer` | Owner + fresh MFA | P1 |
| Ownership | `POST /ownership-transfers/{token}/accept` | `acceptOwnershipTransfer` | named recipient | P1 |
| Ownership | `POST T/deletion-requests` | `requestTenantDeletion` | `tenant.delete` + fresh MFA | P8 |
| People | `GET T/members` | `listMembers` | `member.manage` or scoped read | P1 |
| People | `POST T/invitations` | `createInvitation` | `member.manage` + ceiling | P1 |
| People | `DELETE T/invitations/{id}` | `revokeInvitation` | `member.manage` | P1 |
| People | `POST /invitations/{token}/accept` | `acceptInvitation` | single-use token | P1 |
| People | `PATCH T/members/{id}` | `updateMember` | `member.manage`, last-Owner check | P1 |
| People | `DELETE T/members/{id}` | `removeMember` | `member.manage`, last-Owner check | P1 |
| Roles | `GET T/permissions` | `listPermissions` | `role.manage` | P1 |
| Roles | `GET T/roles` | `listRoles` | `role.manage` | P1 |
| Roles | `POST T/roles` | `createRole` | `role.manage`, delegable-only | P1 |
| Roles | `PATCH T/roles/{id}` | `updateRole` | `role.manage`, delegable-only | P1 |
| Roles | `DELETE T/roles/{id}` | `deleteRole` | `role.manage` | P1 |
| Teams | `GET T/teams` | `listTeams` | scoped | P1 |
| Teams | `POST T/teams` | `createTeam` | `member.manage` | P1 |
| Teams | `PATCH T/teams/{id}` | `updateTeam` | `member.manage` | P1 |
| Teams | `DELETE T/teams/{id}` | `deleteTeam` | `member.manage` | P1 |
| Teams | `PUT T/teams/{id}/members/{member_id}` | `addTeamMember` | `member.manage` | P1 |
| Teams | `DELETE T/teams/{id}/members/{member_id}` | `removeTeamMember` | `member.manage` | P1 |
| Channels | `GET T/channels` | `listChannels` | `channel.manage` or scoped read | P2 |
| Channels | `POST T/channels` | `createChannel` | `channel.manage` | P2 |
| Channels | `GET T/channels/{id}` | `getChannel` | `channel.manage` | P2 |
| Channels | `PATCH T/channels/{id}` | `updateChannel` | `channel.manage`; credentials write-only | P2 |
| Channels | `POST T/channels/{id}/connect` | `connectChannel` | `channel.manage` | P2 |
| Channels | `POST T/channels/{id}/test` | `testChannel` | `channel.manage` | P2 |
| Channels | `POST T/channels/{id}/reconnect` | `reconnectChannel` | `channel.manage` | P2 |
| Channels | `POST T/channels/{id}/disconnect` | `disconnectChannel` | `channel.manage` | P2 |
| Channels | `GET T/channels/{id}/capabilities` | `getChannelCapabilities` | scoped read | P2 |
| Channels | `GET T/channels/{id}/health` | `getChannelHealth` | `channel.manage` | P2 |
| Channels | `POST T/channels/{id}/template-sync` | `syncChannelTemplates` | `channel.manage` | P3 |
| OAuth | `GET /oauth/{provider}/callback` | `providerOauthCallback` | single-use signed state bound to session + tenant + asset | P2 |
| Inboxes | `GET T/inboxes` | `listInboxes` | scoped | P2 |
| Inboxes | `POST T/inboxes` | `createInbox` | inbox admin | P2 |
| Inboxes | `GET T/inboxes/{id}` | `getInbox` | scoped | P2 |
| Inboxes | `PATCH T/inboxes/{id}` | `updateInbox` | inbox admin | P2 |
| Inboxes | `PUT T/inboxes/{id}/members/{member_id}` | `addInboxMember` | inbox admin | P2 |
| Inboxes | `DELETE T/inboxes/{id}/members/{member_id}` | `removeInboxMember` | inbox admin | P2 |
| Views | `GET T/views` | `listViews` | scoped | P2 |
| Views | `POST T/views` | `createView` | scoped | P2 |
| Views | `PATCH T/views/{id}` | `updateView` | owner of view | P2 |
| Views | `DELETE T/views/{id}` | `deleteView` | owner of view | P2 |
| Search | `GET T/search` | `search` | per-resource scope; queue projection rules apply | P2 |
| Conversations | `GET T/conversations` | `listConversations` | `conversation.read` scope | P2 |
| Conversations | `GET T/conversation-queue` | `listConversationQueue` | `conversation.unassigned.preview` — **projected card only** | P2 |
| Directory | `GET T/directory/agents?inbox_id=` | `listAssignableAgents` | member of that inbox; allowlisted fields | P2 |
| Conversation | `GET T/conversations/{id}` | `getConversation` | `conversation.read` after claim/participation | P2 |
| Conversation | `PATCH T/conversations/{id}` | `updateConversation` | action-specific + `If-Match` | P2 |
| Conversation | `POST T/conversations/{id}/claim` | `claimConversation` | `conversation.claim`, atomic | P2 |
| Conversation | `POST T/conversations/{id}/assignments` | `assignConversation` | `conversation.assign` | P2 |
| Conversation | `POST T/conversations/{id}/handoffs` | `requestHandoff` | ownership policy | P2 |
| Conversation | `POST T/conversations/{id}/read` | `updateReadCursor` | participant | P2 |
| Messages | `GET T/conversations/{id}/messages` | `listMessages` | `conversation.read` | P2 |
| Messages | `POST T/conversations/{id}/messages` | `sendMessage` | `conversation.reply` + `Idempotency-Key` + `If-Match` | P2 |
| Messages | `GET T/messages/{id}` | `getMessage` | `conversation.read` | P2 |
| Notes | `POST T/conversations/{id}/notes` | `createNote` | `conversation.note` — **no send command** | P2 |
| Notes | `PATCH T/notes/{id}` | `updateNote` | author + edit policy | P2 |
| Notes | `DELETE T/notes/{id}` | `deleteNote` | author/admin; tombstone + audit | P2 |
| Drafts | `GET T/conversations/{id}/draft` | `getDraft` | own draft | P2 |
| Drafts | `PUT T/conversations/{id}/draft` | `putDraft` | own draft | P2 |
| Drafts | `DELETE T/conversations/{id}/draft` | `deleteDraft` | own draft | P2 |
| Notifications | `GET T/notifications` | `listNotifications` | own | P3 |
| Notifications | `GET T/notifications/{id}` | `getNotification` | own | P3 |
| Notifications | `PATCH T/notifications/{id}` | `updateNotification` | own | P3 |
| Canned | `GET T/canned-replies` | `listCannedReplies` | scoped | P3 |
| Canned | `POST T/canned-replies` | `createCannedReply` | scoped manage | P3 |
| Canned | `PATCH T/canned-replies/{id}` | `updateCannedReply` | scoped manage | P3 |
| Canned | `DELETE T/canned-replies/{id}` | `deleteCannedReply` | scoped manage | P3 |
| Macros | `GET T/macros` | `listMacros` | scoped | P3 |
| Macros | `POST T/macros` | `createMacro` | scoped manage | P3 |
| Macros | `PATCH T/macros/{id}` | `updateMacro` | scoped manage | P3 |
| Macros | `DELETE T/macros/{id}` | `deleteMacro` | scoped manage | P3 |
| Macros | `POST T/macros/{id}/execute` | `executeMacro` | each action reauthorized individually | P3 |
| Media | `POST T/uploads` | `createUpload` | parent object + quota/type policy | P2 |
| Media | `POST T/uploads/{id}/complete` | `completeUpload` | uploader | P2 |
| Media | `GET T/attachments/{id}/access` | `getAttachmentAccess` | parent-object permission; short-lived URL | P2 |
| Contacts | `GET T/contacts` | `listContacts` | `contact.read` scope | P2 |
| Contacts | `POST T/contacts` | `createContact` | `contact.edit` | P2 |
| Contacts | `GET T/contacts/{id}` | `getContact` | `contact.read` scope | P2 |
| Contacts | `PATCH T/contacts/{id}` | `updateContact` | `contact.edit` scope | P2 |
| Contacts | `POST T/contacts/{id}/merge-preview` | `previewContactMerge` | `contact.merge` | P3 |
| Contacts | `POST T/contacts/{id}/merge` | `commitContactMerge` | `contact.merge` | P3 |
| Contacts | `POST T/contacts/{id}/deletion-request` | `requestContactDeletion` | privacy grant | P8 |
| Contacts | `GET T/contacts/{id}/identities` | `listContactIdentities` | `contact.read` | P3 |
| Catalog | `GET T/custom-fields` | `listCustomFields` | scoped | P3 |
| Catalog | `POST T/custom-fields` | `createCustomField` | scoped manage | P3 |
| Catalog | `PATCH T/custom-fields/{id}` | `updateCustomField` | scoped manage | P3 |
| Catalog | `DELETE T/custom-fields/{id}` | `deleteCustomField` | scoped manage | P3 |
| Catalog | `GET T/tags` | `listTags` | scoped | P3 |
| Catalog | `POST T/tags` | `createTag` | scoped manage | P3 |
| Catalog | `PATCH T/tags/{id}` | `updateTag` | scoped manage | P3 |
| Catalog | `DELETE T/tags/{id}` | `deleteTag` | scoped manage | P3 |
| Consent | `GET T/contacts/{id}/consents` | `listConsents` | `consent.read` scope | P3 |
| Consent | `POST T/contacts/{id}/consents` | `recordConsent` | `consent.record` | P3 |
| Consent | `POST T/contacts/{id}/suppression` | `recordSuppression` | `suppression.write` | P3 |
| Segments | `GET T/segments` | `listSegments` | scoped | P3 |
| Segments | `POST T/segments` | `createSegment` | scoped; validated AST | P3 |
| Segments | `PATCH T/segments/{id}` | `updateSegment` | scoped | P3 |
| Segments | `DELETE T/segments/{id}` | `deleteSegment` | scoped | P3 |
| Segments | `POST T/segments/{id}/preview` | `previewSegment` | scoped | P3 |
| Jobs | `POST T/imports` | `createImport` | contact edit + import grant | P3 |
| Jobs | `GET T/imports/{id}/errors` | `listImportErrors` | job owner | P3 |
| Jobs | `POST T/exports` | `createExport` | `contact.export` / report grant | P3 |
| Jobs | `GET T/operations/{id}` | `getOperation` | job owner or service scope — no global ID bypass | P3 |
| Templates | `GET T/templates` | `listTemplates` | scoped | P3 |
| Templates | `POST T/templates` | `createTemplate` | channel/template grant | P3 |
| Templates | `GET T/templates/{id}` | `getTemplate` | scoped | P3 |
| Templates | `PATCH T/templates/{id}` | `updateTemplate` | channel/template grant | P3 |
| Templates | `POST T/templates/{id}/submit` | `submitTemplate` | channel/template grant | P3 |
| Campaigns | `GET T/campaigns` | `listCampaigns` | `campaign.read` scope | P4 |
| Campaigns | `POST T/campaigns` | `createCampaign` | `campaign.draft` | P4 |
| Campaigns | `GET T/campaigns/{id}` | `getCampaign` | `campaign.read` | P4 |
| Campaigns | `PATCH T/campaigns/{id}` | `updateCampaign` | `campaign.draft`; rejected post-launch | P4 |
| Campaigns | `POST T/campaigns/{id}/validate` | `validateCampaign` | `campaign.draft` | P4 |
| Campaigns | `POST T/campaigns/{id}/test-send` | `testSendCampaign` | `campaign.draft` + authorized test recipient | P4 |
| Campaigns | `POST T/campaigns/{id}/approve` | `approveCampaign` | `campaign.approve`; self-approval policy | P4 |
| Campaigns | `POST T/campaigns/{id}/launch` | `launchCampaign` | `campaign.launch` + `Idempotency-Key`; creates the single execution | P4 |
| Campaigns | `POST T/campaigns/{id}/pause` | `pauseCampaign` | `campaign.control` | P4 |
| Campaigns | `POST T/campaigns/{id}/resume` | `resumeCampaign` | `campaign.control` | P4 |
| Campaigns | `POST T/campaigns/{id}/cancel` | `cancelCampaign` | `campaign.control` | P4 |
| Campaigns | `POST T/campaigns/{id}/retry` | `retryCampaignFailures` | `campaign.control`; failed-only | P4 |
| Campaigns | `POST T/campaigns/{id}/clone` | `cloneCampaign` | `campaign.draft`; new ID, no execution state | P4 |
| Campaigns | `GET T/campaigns/{id}/recipients` | `listCampaignRecipients` | `campaign.read` scope | P4 |
| Integrations | `GET T/integrations` | `listIntegrations` | `integration.manage` | P5 |
| Integrations | `POST T/integrations` | `createIntegration` | `integration.manage` + ceiling | P5 |
| Integrations | `GET T/integrations/{id}` | `getIntegration` | `integration.manage` | P5 |
| Integrations | `PATCH T/integrations/{id}` | `updateIntegration` | `integration.manage` | P5 |
| Integrations | `POST T/integrations/{id}/test` | `testIntegration` | `integration.manage` | P5 |
| Integrations | `POST T/integrations/{id}/pause` | `pauseIntegration` | `integration.manage` | P5 |
| Integrations | `POST T/integrations/{id}/resume` | `resumeIntegration` | `integration.manage` | P5 |
| Integrations | `GET T/integrations/{id}/mappings` | `getIntegrationMappings` | `integration.manage` | P5 |
| Integrations | `PUT T/integrations/{id}/mappings` | `putIntegrationMappings` | `integration.manage` | P5 |
| Integrations | `GET T/integrations/{id}/conflicts` | `listIntegrationConflicts` | `integration.manage` | P5 |
| Integrations | `POST T/integrations/{id}/conflicts/{conflict_id}/resolve` | `resolveIntegrationConflict` | `integration.manage` | P5 |
| Developer | `GET T/api-keys` | `listApiKeys` | `api_key.manage`; metadata only, never the secret | P5 |
| Developer | `POST T/api-keys` | `createApiKey` | `api_key.manage` + delegation ceiling; secret shown once | P5 |
| Developer | `POST T/api-keys/{id}/rotate` | `rotateApiKey` | `credential.rotate` | P5 |
| Developer | `DELETE T/api-keys/{id}` | `revokeApiKey` | `api_key.manage` | P5 |
| Developer | `GET T/webhook-subscriptions` | `listWebhookSubscriptions` | `integration.manage` | P5 |
| Developer | `POST T/webhook-subscriptions` | `createWebhookSubscription` | `integration.manage` + SSRF validation | P5 |
| Developer | `PATCH T/webhook-subscriptions/{id}` | `updateWebhookSubscription` | `integration.manage` | P5 |
| Developer | `DELETE T/webhook-subscriptions/{id}` | `deleteWebhookSubscription` | `integration.manage` | P5 |
| Developer | `GET T/webhook-deliveries` | `listWebhookDeliveries` | `integration.manage` | P5 |
| Developer | `POST T/webhook-deliveries/{id}/replay` | `replayWebhookDelivery` | explicit replay grant | P5 |
| Automation | `GET T/automations` | `listAutomations` | automation manage | P6 |
| Automation | `POST T/automations` | `createAutomation` | automation manage + action ceiling | P6 |
| Automation | `GET T/automations/{id}` | `getAutomation` | automation manage | P6 |
| Automation | `PATCH T/automations/{id}` | `updateAutomation` | automation manage | P6 |
| Automation | `POST T/automations/{id}/simulate` | `simulateAutomation` | automation manage; **no side effects** | P6 |
| Automation | `POST T/automations/{id}/publish` | `publishAutomation` | automation manage | P6 |
| Automation | `POST T/automations/{id}/rollback` | `rollbackAutomation` | automation manage | P6 |
| Automation | `GET T/automation-runs/{id}` | `getAutomationRun` | automation manage | P6 |
| Ops config | `GET T/business-hours` | `getBusinessHours` | ops settings | P6 |
| Ops config | `PUT T/business-hours` | `putBusinessHours` | ops settings | P6 |
| Ops config | `GET T/routing` | `getRouting` | ops settings | P6 |
| Ops config | `PUT T/routing` | `putRouting` | ops settings | P6 |
| Ops config | `GET T/sla-policies` | `getSlaPolicies` | ops settings | P6 |
| Ops config | `PUT T/sla-policies` | `putSlaPolicies` | ops settings | P6 |
| Ops config | `GET T/holidays` | `listHolidays` | ops settings | P6 |
| Ops config | `POST T/holidays` | `createHoliday` | ops settings | P6 |
| Ops config | `PATCH T/holidays/{id}` | `updateHoliday` | ops settings | P6 |
| Ops config | `DELETE T/holidays/{id}` | `deleteHoliday` | ops settings | P6 |
| Analytics | `GET T/reports/{report_key}` | `getReport` | `report.read` scope; fixed allowed keys | P6 |
| Analytics | `GET T/usage` | `getUsage` | usage scope | P6 |
| Analytics | `GET T/audit-events` | `listAuditEvents` | `audit.read` | P6 |
| AI | `GET T/knowledge-sources` | `listKnowledgeSources` | AI scope | P7 |
| AI | `POST T/knowledge-sources` | `createKnowledgeSource` | AI scope + SSRF validation | P7 |
| AI | `GET T/ai-settings` | `getAiSettings` | AI scope | P7 |
| AI | `PATCH T/ai-settings` | `updateAiSettings` | AI scope | P7 |
| AI | `POST T/conversations/{id}/ai-drafts` | `createAiDraft` | `conversation.reply` + AI scope | P7 |
| AI | `GET T/ai-runs/{id}` | `getAiRun` | AI scope | P7 |
| AI | `POST T/tool-approvals/{id}/approve` | `approveTool` | the underlying domain permission | P7 |
| AI | `POST T/tool-approvals/{id}/reject` | `rejectTool` | the underlying domain permission | P7 |
| Realtime | `GET T/events?after=&limit=` | `listEvents` | reauthorized per tenant + topic; returns `reset_required` when a cursor is unusable | P2 |
| Ingress | `GET /webhooks/meta/{app_connection_id}` | `verifyMetaWebhook` | challenge only | P2 |
| Ingress | `POST /webhooks/meta/{app_connection_id}` | `receiveMetaWebhook` | raw-byte HMAC + trusted asset mapping | P2 |
| Privacy | `POST /provider-callbacks/meta/deauthorize` | `metaDeauthorize` | provider's own signed-callback contract | P3 |
| Privacy | `POST /provider-callbacks/meta/data-deletion` | `metaDataDeletion` | provider's own signed-callback contract | P3 |
| Privacy | `GET /privacy/requests/{confirmation_code}` | `getPrivacyRequest` | opaque code; minimal info; rate-limited | P3 |
| Probes | `GET /health/live` | `healthLive` | public, minimal | P1 |
| Probes | `GET /health/ready` | `healthReady` | public, minimal; diagnostics private | P1 |

## Canonical send example

```http
POST /api/v1/tenants/{tenant_id}/conversations/{conversation_id}/messages
Content-Type: application/json
Idempotency-Key: {unique-command-key}
If-Match: "{conversation_version}"

{
  "client_message_id": "{client-generated-uuid}",
  "type": "text",
  "text": "تم استلام طلبك، وسنراجع التفاصيل.",
  "attachment_ids": [],
  "reply_to_message_id": null
}
```

```json
{
  "data": {
    "message_id": "message_opaque_id",
    "command_id": "command_opaque_id",
    "operation_id": "operation_opaque_id",
    "command_status": "queued",
    "delivery_status": null,
    "provider_message_id": null
  },
  "request_id": "request_opaque_id"
}
```

202 is returned **only after** the durable transaction. The frontend shows `queued` — never `delivered`. The server resolves actor, tenant, recipient, provider and connection from authorized resources and rejects any attempt to supply `author_id`, `tenant_id`, `provider_token`, `is_admin` or `billing_status`. Text/media/template payloads are a discriminated union. Provider message IDs stay opaque strings.
