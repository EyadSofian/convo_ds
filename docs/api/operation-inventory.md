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
| Conversation | `POST T/conversations/{id}/handoffs` | `requestHandoff` | `conversation.handoff.request` + version | P2 |
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
| Contacts | `POST T/contacts/import` | `importContacts` | `contact.edit` scoped to connection | P2 |
| Contacts | `GET T/contacts/export` | `exportContacts` | `contact.export` + `contact.read` scope | P2 |
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
| Contacts | `POST T/contacts/{id}/identities` | `addContactIdentity` | `contact.edit` + CSRF | P2 |
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
| Campaigns | `POST T/campaigns/audience-preview` | `previewCampaignAudience` | `campaign.draft` | P4 |
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
| Reports | `GET T/reports/campaigns` | `getCampaignReport` | `report.read` scope | P4/P6 |
| Reports | `POST T/reports/campaigns/exports` | `createCampaignReportExport` | `report.read`; requester-owned async job | P4/P6 |
| Reports | `GET T/reports/campaigns/exports/{id}` | `getCampaignReportExport` | `report.read`; requesting membership only | P4/P6 |
| Reports | `GET T/reports/campaigns/exports/{id}/content` | `downloadCampaignReportExport` | completed + unexpired + requesting membership only | P4/P6 |
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
| Automation | `GET T/automation-templates` | `listAutomationTemplates` | `automation.read` | implemented |
| Automation | `POST T/automation-templates/{key}/use` | `useAutomationTemplate` | `automation.create` | implemented |
| Automation | `GET T/whatsapp-templates` | `listApprovedWhatsAppTemplates` | `automation.read` | implemented; provider sync asset-dependent |
| Automation | `GET T/automations` | `listAutomations` | `automation.read` | implemented |
| Automation | `POST T/automations` | `createAutomation` | `automation.create` | implemented |
| Automation | `PATCH T/automations/{id}` | `updateAutomation` | `automation.edit` + version fence | implemented |
| Automation | `POST T/automations/{id}/{act}` | `transitionAutomation` | activate/pause permission by act | implemented |
| Automation | `POST T/automation-events` | `ingestAutomationEvent` | `automation.create` + idempotency | implemented |
| Automation | `GET T/automation-runs` | `listAutomationRuns` | `automation.read` | implemented |
| Automation | `POST T/automations/{id}/test` | `testAutomation` | `automation.test`; approved recipients only | remaining |
| Automation | `GET T/automation-runs/{id}/recipients` | `listAutomationRecipients` | `automation.read` | remaining |
| Automation | `GET T/automation-runs/{id}/logs` | `listAutomationLogs` | `automation.read` | remaining |
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

## Channel operations (P2)

Implemented in Milestone C, pinned in the spec, and covered in both directions by the drift test.

| Group | Method + path | operationId | Permission / scope | Phase |
|---|---|---|---|---|
| Channels | `GET T/channels` | `listChannelConnections` | `channel.manage` | P2 |
| Channels | `GET T/channels/catalogue` | `listChannelCatalogue` | `channel.manage` | P2 |
| Channels | `POST T/channels` | `connectChannel` | `channel.manage` + CSRF + `Idempotency-Key` | P2 |
| Channels | `POST T/channels/{id}/test` | `testChannelConnection` | `channel.manage` + CSRF | P2 |
| Channels | `POST T/channels/{id}/credential` | `rotateChannelCredential` | **`credential.rotate`** + CSRF | P2 |
| Channels | `POST T/channels/{id}/settings` | `updateChannelSettings` | `channel.manage` + CSRF | P2 |
| Channels | `GET T/channels/{id}/test-recipients` | `listChannelTestRecipients` | `campaign.read` | P4 |
| Channels | `POST T/channels/{id}/test-recipients` | `authorizeChannelTestRecipient` | `channel.manage` + CSRF | P4 |
| Channels | `DELETE T/channels/{id}/test-recipients/{authorizationId}` | `revokeChannelTestRecipient` | `channel.manage` + CSRF | P4 |
| Channels | `DELETE T/channels/{id}` | `disconnectChannel` | `channel.manage` + CSRF | P2 |

Only `connectChannel` carries an `Idempotency-Key`: it is the one operation whose
replay would duplicate an effect — a second connection racing the first for the
same inbound messages. Test, rotate and disconnect converge on the same state, so
requiring a key there would be ceremony without a reason.

The test-recipient routes are an explicit allowlist. A manager can authorize only
an active contact identity already seen on that exact connection. Campaign
authors may read the resulting choices, but cannot put an arbitrary destination
in a test-send request. Revocation is recorded rather than deleting its history.

### Outbound (P2)

| Group | Method + path | operationId | Permission / scope | Phase |
|---|---|---|---|---|
| Outbound | `POST T/channels/{id}/messages` | `queueOutboundMessage` | `conversation.reply` + CSRF | P2 |
| Outbound | `GET T/channels/{id}/messages` | `listOutboundMessages` | `conversation.read` | P2 |
| Outbound | `GET T/outbound-messages/{id}` | `getOutboundMessage` | `conversation.read` | P2 |

`queueOutboundMessage` answers **202**, never 200 or 201, and only after the
command and its outbox row have committed. It carries no `Idempotency-Key`: the
body's `clientMessageId` is the caller's own identifier for the message and is
unique per company, so a header saying the same thing would be a second thing to
get wrong.

Sending requires `conversation.reply`, not `channel.manage`. Replying is the
agent's daily act; reconfiguring a channel is not, and the catalogue already
separates them.

Rotation is separated from management by permission key on purpose. Reaching a
provider credential is the narrower act, and the catalogue already distinguishes
`credential.rotate` from `channel.manage`; an operator who may reorganise
channels is not thereby an operator who may replace the token that sends as the
company.

### Conversations and realtime (P2)

| Group | Method + path | operationId | Permission / scope | Phase |
|---|---|---|---|---|
| Inbox | `GET T/conversations/unassigned` | `listUnassignedConversations` | `conversation.unassigned.preview`, per row | P2 |
| Inbox | `GET T/conversations/{id}` | `getConversation` | `conversation.read` for that conversation | P2 |
| Inbox | `POST T/conversations/{id}/claim` | `claimConversation` | `conversation.claim` + CSRF | P2 |
| Inbox | `GET T/conversations` | `listConversations` | `conversation.read`, per row | P2 |
| Inbox | `GET T/conversations/{id}/messages` | `listConversationMessages` | `conversation.read` for that conversation | P2 |
| Inbox | `POST T/conversations/{id}/messages` | `replyToConversation` | `conversation.reply` + CSRF | P2 |
| Inbox | `GET T/conversations/{id}/whatsapp-templates` | `listConversationWhatsAppTemplates` | `conversation.reply`, tenant + conversation connection scope | implemented; bounded local catalogue page, explicit sync only |
| Lifecycle | `POST T/conversations/{id}/transitions` | `transitionConversation` | `conversation.close` (wait/snooze/resolve/reopen/archive) + CSRF + version | P2 |
| Lifecycle | `POST T/conversations/archived` | `manageArchivedConversations` | restore: `conversation.close` per conversation; delete: `retention.manage` + CSRF | P2 |
| Lifecycle | `GET T/conversations/{id}/episodes` | `listConversationEpisodes` | `conversation.read` for that conversation | P2 |
| Notes | `GET T/conversations/{id}/notes` | `listConversationNotes` | `conversation.note` for that conversation | P2 |
| Notes | `POST T/conversations/{id}/notes` | `createConversationNote` | `conversation.note` + CSRF | P2 |
| Notes | `PATCH T/notes/{noteId}` | `updateNote` | `conversation.note` **and** authorship + CSRF | P2 |
| Notes | `DELETE T/notes/{noteId}` | `deleteNote` | `conversation.note` **and** authorship + CSRF | P2 |
| Reading | `POST T/conversations/{id}/read` | `markConversationRead` | `conversation.read` + CSRF | P2 |
| Routing | `GET T/directory/agents?conversation_id=` | `listAssignableAgents` | routing reader; allowlisted fields | P2 |
| Routing | `POST T/conversations/{id}/assignments` | `assignConversation` | `conversation.assign` + CSRF + version | P2 |
| Routing | `GET T/conversations/{id}/handoffs` | `listConversationHandoffs` | routing reader | P2 |
| Routing | `POST T/conversations/{id}/handoffs` | `requestHandoff` | `conversation.handoff.request` + CSRF + version | P2 |
| Routing | `POST T/handoffs/{id}/{accept\|decline\|cancel}` | `settleHandoff` | named party or assigner, action-specific | P2 |
| Routing | `PATCH T/conversations/{id}/priority` | `setConversationPriority` | `conversation.assign` + CSRF + version | P2 |
| Routing | `GET T/conversations/{id}/collaborators` | `listConversationCollaborators` | routing reader | P2 |
| Routing | `POST T/conversations/{id}/collaborators` | `addConversationCollaborator` | `conversation.assign` + CSRF + version | P2 |
| Routing | `DELETE T/conversations/{id}/collaborators/{membershipId}` | `removeConversationCollaborator` | `conversation.assign` + CSRF + version | P2 |
| Realtime | `GET T/realtime/events` | `catchUpRealtimeEvents` | session; each event authorized individually | P2 |
| Realtime | `GET T/realtime/stream` | `streamRealtimeEvents` | session; each event authorized individually | P2 |
| Metadata | `GET T/labels` | `listLabels` | `catalog.read` | P2 |
| Metadata | `POST T/labels` | `createLabel` | `catalog.manage` + CSRF | P2 |
| Metadata | `PATCH T/labels/{labelId}` | `updateLabel` | `catalog.manage` + CSRF + version | P2 |
| Metadata | `DELETE T/labels/{labelId}` | `retireLabel` | `catalog.manage` + CSRF + version | P2 |
| Metadata | `GET T/custom-fields` | `listCustomFields` | `catalog.read`; optional target | P2 |
| Metadata | `POST T/custom-fields` | `createCustomField` | `catalog.manage` + CSRF | P2 |
| Metadata | `PATCH T/custom-fields/{fieldId}` | `updateCustomField` | `catalog.manage` + CSRF + version | P2 |
| Metadata | `DELETE T/custom-fields/{fieldId}` | `retireCustomField` | `catalog.manage` + CSRF + version | P2 |
| Metadata | `PATCH T/conversations/{id}/metadata` | `mutateConversationMetadata` | record reach + CSRF + version | P2 |
| Metadata | `PATCH T/contacts/{id}/metadata` | `mutateContactMetadata` | `contact.edit` + CSRF + version | P2 |

The queue and the conversation are **two endpoints, not one with a flag**. A
queue card and a conversation are different things with different permissions,
and an endpoint that returns either depending on a query parameter is one bug
away from returning the wrong one. The card is built field by field on the
server from `QUEUE_CARD_FIELDS`; it is not a conversation with fields hidden in
the browser (IAM-11).

`claimConversation` requires the `version` the caller saw on the card. A claim
without one would be "take this from whoever has it", which is a different
operation with a different permission (`conversation.assign`). Two agents
claiming at the same version produce exactly one winner; the loser is told
`conversation_version_conflict` (IAM-13). It carries no `Idempotency-Key`
because the version already makes a replay a no-op conflict rather than a second
claim.

Assignment and handoff stay separate operations. Assignment moves work immediately
and requires `conversation.assign`; a handoff is an offer that leaves the current
assignee responsible until the named recipient accepts. Both creation paths carry
the conversation version the operator saw. The assignee directory returns only a
membership id, display label and current-assignee flag, and the write re-derives
the target's eligibility inside its transaction. Handoff expiry is a durable queue
consumed by `worker-inbound`, not a browser timer.

Labels and custom fields are catalogued separately from the entities that use
them. Retiring a definition prevents new assignments without deleting history.
An entity metadata mutation is one version-fenced command containing label adds,
label removals and typed field changes, so a partially applied form cannot leave
the visible record between two operator intents. Contact and conversation lists
accept repeatable label ids and typed field filters; the server performs the
filtering under tenant RLS.

**One transitions endpoint, not five verbs.** `transitionConversation` takes a
`command` — `wait`, `snooze`, `resolve`, `reopen` or `archive` — because they are
one decision fenced on one version, and five routes would be five places to get
that fencing subtly different. Every one of them carries the `version` the agent
saw; losing that race is a typed `conversation_version_conflict`, not an error
the agent could have avoided. A command the lifecycle table refuses from the
conversation's current state comes back as a **409 named after the refusal**
(`already_open`, `not_resolved`, `not_waiting_on_a_customer`,
`archived_conversation_is_immutable`), so the browser can say what actually
happened rather than "something went wrong". A snooze whose wake time is in the
past, more than a year out, or in a zone this server does not recognise is a
**422** named the same way — checked at the door rather than in a worker at wake
time, in front of the person who chose it.

**A note is not a message, and the routes say so.** Notes live under the
conversation for reading and writing, but a single note is addressed as
`T/notes/{noteId}` because editing one is an act on the note, not on the
conversation. Only the author may change or remove one: that is a **403
`not_the_author`**, not a 404, because the caller may read it and pretending it
does not exist would be a worse answer than the true one. A deletion keeps the
row and its attribution and drops only the text.

**`markConversationRead` is not a receipt.** It moves one person's cursor, never
backwards, and refuses a read of the future. Nothing it does reaches the customer
and nothing it does moves the conversation — reading a thread is bookkeeping for
one person, and folding it into either of the other two would let one agent's
reading change what a colleague or a customer sees.

`listConversations` and `listUnassignedConversations` are the same distinction
one level up: the first returns records the caller passed `conversation.read`
for, decided **per row**; the second returns cards for work nobody holds. A
single endpoint switching between them on a query parameter would put a card and
a transcript one bug apart.

`replyToConversation` takes the recipient from the conversation record. A
`peerIdentity` in the body is ignored, because an agent permitted to reply to
one customer must not be able to reach another by editing a field. It answers
**202** on the same terms as `queueOutboundMessage`, and carries no
`Idempotency-Key` for the same reason: `clientMessageId` in the body is already
the caller's own identifier for the message.

`listConversationMessages` pages **backwards** into the history with an opaque
cursor that is signed, bound to the company, the conversation and the sort, and
expiring. A stale or foreign one is answered `cursor_invalid` / `cursor_expired`
with a safe refresh path rather than silently restarting at the top of somebody's
conversation.

`streamRealtimeEvents` is **Server-Sent Events**, not a WebSocket. The traffic is
one-directional, the session cookie authenticates it like any other request,
`Last-Event-ID` resumes from a cursor with no bespoke handshake, and any proxy
that speaks HTTP speaks it. Commands travel the other way as ordinary
authenticated `POST`s, where CSRF and idempotency already live. Neither realtime
operation is a capability: presenting a cursor authorizes nothing, and every
event is authorized again on the way out against a principal re-read from the
database.

## Deliberate divergences from the minimum inventory

The rows above are the minimum from MASTER-PROMPT §19. Where the implementation
differs, it is recorded here rather than by quietly editing the requirement. The
route/spec drift test (API-02) still holds in both directions for every route
that exists today.

| Inventory row | As implemented | Why |
|---|---|---|
| `POST /webhooks/meta/{app_connection_id}` | same path; the parameter is a **channel app id**, not a connection id | The delivery names the app it came from, which is what selects the secret to verify with. The *connection* is resolved afterwards, from the asset id inside the verified payload — a path parameter is never authority (DEL-02). The inventory's name is kept so the route matches; this row records what the value actually is. |
| `DELETE T/teams/{id}` | `PATCH T/teams/{id}` with `{"archived": true}` | A team is the addressee of past routing and assignment. Deleting one would orphan that history or force a cascade that rewrites it; archiving keeps the record and frees the name, and `{"archived": false}` restores it. |
| `PUT T/teams/{id}/members/{member_id}` | `POST T/teams/{id}/members` with `{"membershipId": …}` | The member is identified by a *membership* id, which is tenant-scoped and not the caller's to choose. Putting it in the path invites a caller to treat it as a name it may create; the body makes it an existing row that is looked up and refused with a 404 when it is not this tenant's. Adding the same membership twice is still idempotent. |
| `GET T/directory/agents?inbox_id=` | `GET T/directory/agents?conversation_id=` | Eligibility depends on the actual conversation's inbox, team and current assignee. Passing the conversation lets the directory use the same `authorize` decision as the write instead of rebuilding a weaker inbox-only approximation. |
| `POST T/contacts` (`createContact`) | explicit identity creation, scoped to a selected channel connection, or a contact with no channel yet | Requires `contact.edit` (for the selected inbox/connection when one is given) and accepts `displayName` with optional `connectionId` + `externalId`. It creates at most one channel-scoped identity (`POST T/contacts/{id}/identities` attaches more later), rejects an already-live duplicate instead of merging, and never creates consent. The caller must enter the external identity explicitly; no identity is inferred from name or phone similarity. |
| `POST T/contacts/import` (`importContacts`) | atomic explicit-identity batch import | Requires `contact.edit` scoped to the chosen connection; accepts up to 500 rows with display name and exact external identity. The UI previews a CSV up to 1 MB locally. Existing/repeated identities reject the entire transaction with row details; no rows imply consent. This is a bounded batch importer, not the resumable million-row stream required by CT-09. |
| `GET T/contacts/export` (`exportContacts`) | scoped, bounded CSV download | Requires `contact.export` and an effective `contact.read` scope. Exports no more than 10,000 rows and neutralizes spreadsheet formulas. This synchronous bounded endpoint does not implement the durable async export job required by CT-10. |
| `GET T/contacts/{id}/consents` (`listConsents`) | folded into `GET T/contacts/{id}` | The consent history and the suppressions come back **with** the record, because every question worth asking of them ("may we message this person?") is a question about the person. A separate endpoint would let a screen render a contact with its consent still loading, and an operator would read the gap as "no consent recorded". |
| `POST T/contacts/{id}/suppression` (`recordSuppression`) | not built; a withdrawal is recorded through `POST T/contacts/{id}/consents` | Suppression is written by the opt-out path, keyed by identity in `channel_suppressions`. Exposing a write endpoint for it before CT-13's explicit re-opt-in workflow exists would offer a way *out* of a suppression with no way to audit it. |
| Separate `POST T/campaigns/{id}/pause`, `/resume`, `/cancel` | `POST T/campaigns/{id}/control` with a closed `action` union | The three commands share one authorization rule and one transition table. The body cannot name any other action, while one route keeps the state command and its audit behavior from drifting across three controllers. |

`PATCH T/teams/{id}` is a genuine partial patch: an absent field is left alone
and an empty body is a 400. Making a caller resend a team's name in order to
archive it is how a team gets renamed by accident.

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
