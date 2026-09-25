import type { TransitionCommand } from '../api/conversations.js';
import type { ScopeRef } from '../api/people.js';
import { NO_ANALYTICS_FILTERS } from '../state.js';
import type { LiveContext } from './actions.js';
import {
  loadContactsScreen,
  openContact,
  recordConsent,
  saveContact,
} from './contact-actions.js';
import {
  claimConversation,
  loadSupervisorAgents,
  loadSupervisorInbox,
  loadInboxScreen,
  loadMoreInbox,
  loadMoreWhatsAppTemplates,
  loadOlderMessages,
  openConversation,
  openWhatsAppTemplates,
  refreshWhatsAppTemplates,
  searchWhatsAppTemplates,
  sendWhatsAppTemplate,
  sendReply,
} from './inbox-actions.js';
import {
  addNote,
  deleteNote,
  editNote,
  loadNotes,
  markConversationUnread,
  transitionConversation,
} from './lifecycle-actions.js';
import {
  assignConversation,
  releaseOwnConversation,
  loadAssignees,
  requestHandoff,
  setCollaborator,
  setPriority,
  settleHandoff,
} from './routing-actions.js';
import { createAndAssignLabel, createField, createLabel, retireLabel, setEntityLabel, setFieldValue, updateLabel } from './metadata-actions.js';
import { rowsOf } from './store.js';
import { setSimpleFilter } from './inbox-query.js';
import { INBOX_FILTER_CATALOGUE, INBOX_SORTS, type InboxFilter, type InboxSort } from '@convo/domain';
import { applySavedView, retireSavedView, saveCurrentInboxView } from './saved-view-actions.js';
import {
  approveCampaign,
  cloneCampaign,
  controlCampaign,
  createCampaign,
  createCampaignReportExport,
  launchCampaign,
  loadCampaignRecipients,
  loadAssignmentReport,
  loadAnalyticsReport,
  loadCampaignsScreen,
  refreshCampaignReportExport,
  retryCampaignFailures,
  testSendCampaign,
  updateCampaign,
  validateCampaign,
} from './campaign-actions.js';
import {
  addAutomationStep,
  createBlankAutomation,
  deleteAutomationDraft,
  loadAutomationPage,
  loadAutomationRunsPage,
  loadAutomationsScreen,
  removeAutomationStep,
  saveAutomation,
  setAutomationQuery,
  setAutomationRunsQuery,
  transitionAutomation,
  useAutomationTemplate,
} from './automation-actions.js';
import {
  addTeamMember,
  archiveTeam,
  assignRole,
  authorizeTestRecipient,
  changeRole,
  changeScopes,
  changeStatus,
  connectChannel,
  createRole,
  createTeam,
  deleteRole,
  disconnectChannel,
  invitePerson,
  loadChannelsScreen,
  loadPeopleScreen,
  changePassword,
  loadSession,
  loadSettingsScreen,
  revokeSession,
  syncWhatsAppTemplates,
  switchTenant,
  offerOwnership,
  removeTeamMember,
  renameRole,
  renameTeam,
  rotateChannelCredential,
  setInstagramPage,
  saveRoleGrants,
  revokeInvitation,
  revokeTestRecipient,
  settleOwnership,
  signIn,
  signOut,
  testChannel,
} from './actions.js';

/**
 * The `live-*` half of the action table.
 *
 * These are kept apart from the demo actions because they are asynchronous and
 * because it should be obvious, from the name of a control, whether clicking it
 * reaches the server. Every handler returns a promise; the caller re-renders
 * when it settles, and each handler has already re-rendered once to show its
 * own pending state.
 */
export type LiveHandler = (context: LiveContext, arg: string) => Promise<unknown>;

/**
 * Splits `"<id>:<value>"`, which is how a select carries both.
 *
 * Total by construction: an argument with no separator is all id and no value,
 * which is what a control rendered without a form key would produce. Returning
 * that rather than throwing keeps a malformed control from taking the screen
 * down, and the empty value is then rejected by the parser on the server.
 */
/**
 * The form key a contact's name field writes into.
 *
 * An underscore rather than a colon: the shared `form` action splits its
 * argument on the first colon, so a key containing one would swallow half the
 * typed value.
 */
export function contactNameField(contactId: string): string {
  return `contactName_${contactId}`;
}

/**
 * Saves whatever was typed into a contact's name field.
 *
 * The attributes are not sent: this build offers no editor for them, and
 * sending the ones it read back would make a round-trip look like an edit.
 */
async function saveContactName(context: LiveContext, contactId: string): Promise<boolean> {
  const typed = (context.state.dialogForm[contactNameField(contactId)] ?? '').trim();
  if (typed === '') {
    return false;
  }
  const saved = await saveContact(context, contactId, { displayName: typed });
  if (saved) {
    clearForm(context, [contactNameField(contactId)]);
    context.refresh();
  }
  return saved;
}

/**
 * Records consent or a withdrawal for the service purpose.
 *
 * One purpose, because that is the one an agent in a conversation is in a
 * position to observe. Marketing consent is a campaign decision and belongs to
 * a surface that does not exist yet, so it is not offered here rather than
 * offered and quietly meaning something else.
 */
async function recordConsentFrom(context: LiveContext, arg: string): Promise<boolean> {
  const { id, value } = splitArg(arg);
  if (value !== 'granted' && value !== 'withdrawn') {
    return false;
  }
  const channel = channelOfOpenContact(context, id);
  if (channel === null) {
    return false;
  }
  return recordConsent(context, id, {
    channel,
    purpose: 'service',
    state: value,
    source: 'agent_recorded',
  });
}

/**
 * The channel a consent record is about.
 *
 * Taken from the contact's live identities rather than typed: consent is per
 * channel, and letting somebody pick a channel the contact has no identity on
 * would record a fact about nothing.
 */
function channelOfOpenContact(context: LiveContext, contactId: string): string | null {
  const { live } = context;
  for (const resource of [live.selectedContact, live.openContact]) {
    if (resource.status === 'ready' && resource.value.id === contactId) {
      const identity = resource.value.identities.find((entry) => entry.validTo === null);
      return identity?.kind ?? null;
    }
  }
  return null;
}

export function splitArg(arg: string): { readonly id: string; readonly value: string } {
  const separator = arg.indexOf(':');
  return separator === -1
    ? { id: arg, value: '' }
    : { id: arg.slice(0, separator), value: arg.slice(separator + 1) };
}

function asAutomationState(value: string): '' | 'draft' | 'active' | 'paused' | 'archived' {
  return value === 'draft' || value === 'active' || value === 'paused' || value === 'archived' ? value : '';
}

function asAutomationSort(value: string): 'updated_desc' | 'name_asc' | 'name_desc' {
  return value === 'name_asc' || value === 'name_desc' ? value : 'updated_desc';
}

function validLabelColor(context: LiveContext): string | null {
  const color = form(context, 'labelColor').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
    delete context.state.formErrors['labelColor'];
    return color.toUpperCase();
  }
  context.state.formErrors = { ...context.state.formErrors, labelColor: text(context, 'استخدم لون HEX مثل #3B82F6.', 'Use a HEX colour such as #3B82F6.') };
  context.refresh();
  return null;
}

/** The fields the transition forms own, cleared whenever one opens or closes. */
const LIFECYCLE_FIELDS = ['lifecycleReason', 'lifecycleWakeAt', 'lifecycleResolution'] as const;

const LIFECYCLE_COMMANDS: ReadonlySet<string> = new Set([
  'wait',
  'snooze',
  'resolve',
  'reopen',
  'archive',
]);

/**
 * Narrows a control's argument to a command the API accepts.
 *
 * A control rendered with something else is a bug in this repository, and the
 * answer is to do nothing rather than to post an unknown command and read the
 * server's 400 back as though the operator had made a mistake.
 */
function lifecycleCommand(value: string): TransitionCommand['command'] | null {
  return LIFECYCLE_COMMANDS.has(value) ? (value as TransitionCommand['command']) : null;
}

/**
 * Builds the transition body from what is in the form.
 *
 * Returns `null` when a required field is empty, and the button that would have
 * sent it stays a no-op: a wait with no reason and a resolution with no text
 * are the two records that make the whole lifecycle table useless to read
 * later, and the server rejects both anyway.
 *
 * `preset` carries the minutes from a snooze shortcut. It is turned into an
 * instant here rather than sent as a duration, because a duration would be
 * resolved against the server's clock and the operator picked it against theirs.
 */
function transitionBody(
  context: LiveContext,
  command: TransitionCommand['command'],
  preset: string,
): TransitionCommand | null {
  if (command === 'reopen' || command === 'archive') {
    return { command };
  }
  if (command === 'wait') {
    const reason = form(context, 'lifecycleReason');
    return reason === '' ? null : { command, reason };
  }
  if (command === 'resolve') {
    const resolution = form(context, 'lifecycleResolution');
    return resolution === '' ? null : { command, resolution };
  }
  const wakeAt = snoozeInstant(context, preset);
  return wakeAt === null
    ? null
    : { command, wakeAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/**
 * The instant a snooze wakes at, from a preset or from the typed field.
 *
 * A `datetime-local` value has no zone in it — `2026-09-11T09:00` means nine in
 * the morning *here*. `new Date` reads exactly that, in the browser's zone,
 * which is the one the operator is sitting in. Appending a `Z` would silently
 * shift every snooze by the offset.
 */
function snoozeInstant(context: LiveContext, preset: string): string | null {
  const minutes = Number(preset);
  if (preset !== '' && Number.isFinite(minutes) && minutes > 0) {
    return new Date(context.now() + minutes * 60_000).toISOString();
  }
  const typed = form(context, 'lifecycleWakeAt');
  if (typed === '') {
    return null;
  }
  const at = new Date(typed);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function form(context: LiveContext, key: string): string {
  return (context.state.dialogForm[key] ?? '').trim();
}

function rawForm(context: LiveContext, key: string): string {
  return context.state.dialogForm[key] ?? '';
}

function text(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/**
 * Records field problems found before sending, and says whether there were any.
 * An empty map clears what the last attempt left behind.
 */
function invalid(context: LiveContext, errors: Record<string, string>): boolean {
  context.state.formErrors = errors;
  const found = Object.keys(errors).length > 0;
  if (found) context.refresh();
  return found;
}

/** A field's typed value, or what the server holds when it was never touched. */
function edited(context: LiveContext, key: string, saved: string): string {
  return context.state.dialogForm[key] === undefined ? saved : form(context, key);
}

function campaignErrors(
  context: LiveContext,
  values: { readonly campaignName: string; readonly campaignMessage: string },
): Record<string, string> {
  return {
    ...(values.campaignName === '' ? { campaignName: text(context, 'أدخل اسم الحملة.', 'Enter a campaign name.') } : {}),
    ...(values.campaignMessage === '' ? { campaignMessage: text(context, 'اكتب نص الرسالة.', 'Write the message.') } : {}),
  };
}

/** Clears the fields a form owns once the server has accepted it. */
function clearForm(context: LiveContext, keys: readonly string[]): void {
  const next = { ...context.state.dialogForm };
  for (const key of keys) {
    delete next[key];
  }
  context.state.dialogForm = next;
}

const TENANT_SCOPE: readonly ScopeRef[] = [{ type: 'tenant', id: null }];

/**
 * The form key for a team's "add a member" select.
 *
 * It is built in one place because the DOM carries a form value as
 * `"<key>:<value>"` and the generic collector splits on the first colon — so a
 * key containing one silently stores the wrong thing under the wrong name.
 */
export function teamMemberField(teamId: string): string {
  return `teamMember_${teamId}`;
}

/** The form key for a custom role's rename field, for the same reason. */
export function roleNameField(roleId: string): string {
  return `roleName_${roleId}`;
}

/** The form key holding a team's proposed new name in the rename dialog. */
export function teamNameField(teamId: string): string {
  return `teamName_${teamId}`;
}

/** Closes the dialog a successful change came from, if it is still open. */
function closeDialogAfter(context: LiveContext, done: boolean): boolean {
  if (done && context.state.dialog !== null) {
    context.state.dialog = null;
    context.state.dialogForm = {};
    context.refresh();
  }
  return done;
}

/**
 * A Refresh somebody pressed. What is on screen stays there while the lists
 * are read again, and only that Refresh control reports busy: no placeholder swap, no
 * toolbar or header movement. A list that was not on screen yet (never loaded,
 * or refused) still shows its placeholder, because there is nothing to keep.
 */
async function manualRefresh(context: LiveContext, act: string, load: () => Promise<void>): Promise<void> {
  context.live.refreshing = act;
  context.refresh();
  try {
    await load();
  } finally {
    context.live.refreshing = null;
    context.refresh();
  }
}

async function exitSupervisor(context: LiveContext): Promise<boolean> {
  context.state.supervisorPickerOpen = false;
  context.live.supervisorAgentId = null;
  context.live.supervisorWorkload = { status: 'idle' };
  const { agent: ignoredAgent, ...params } = context.state.route.params;
  // Discard the bookmarked lens so the next Inbox read cannot restore it.
  void ignoredAgent;
  context.state.route = { ...context.state.route, params };
  await loadInboxScreen(context);
  return true;
}

/** The form key for a connection's credential-rotation field. */
export function channelTokenField(connectionId: string): string {
  return `channelToken_${connectionId}`;
}

export function channelPageField(connectionId: string): string {
  return `channelPage_${connectionId}`;
}

export function channelTestIdentityField(connectionId: string): string {
  return `channelTestIdentity_${connectionId}`;
}

export function channelTestLabelField(connectionId: string): string {
  return `channelTestLabel_${connectionId}`;
}

export function metadataFieldValue(target: string, entityId: string, fieldId: string): string {
  return `metadata_${target}_${entityId}_${fieldId}`;
}

export const LIVE_ACTIONS: Readonly<Record<string, LiveHandler>> = {
  'analytics-view': async (context, arg) => {
    if (arg !== 'campaigns' && arg !== 'overview' && arg !== 'agents' && arg !== 'teams' && arg !== 'responses' && arg !== 'resolutions' && arg !== 'assignments' && arg !== 'channels') return false;
    context.state.analyticsView = arg;
    const params = { ...context.state.route.params };
    if (arg === 'campaigns') delete params.view;
    else params.view = arg;
    context.state.route = { ...context.state.route, params };
    await loadAnalyticsReport(context);
    return true;
  },

  'live-request-recovery': async (context) => {
    if (context.live.busy !== null) return false;
    const email = form(context, 'recoveryEmail');
    const errors = email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? { recoveryEmail: text(context, 'أدخل بريدًا إلكترونيًا صحيحًا.', 'Enter a valid email address.') }
      : {};
    if (invalid(context, errors)) return false;
    context.live.busy = 'recovery-request'; context.live.error = null; context.refresh();
    const result = await context.live.api.requestRecovery(email);
    context.live.busy = null;
    if (!result.ok) context.live.error = result.error;
    else context.state.authFlowComplete = 'recovery-request';
    context.refresh(); return result.ok;
  },

  'live-accept-invitation': async (context) => submitCredentialFlow(context, 'invitation'),
  'live-complete-recovery': async (context) => submitCredentialFlow(context, 'recovery'),
  /**
   * Checks the form before sending anything, then signs in.
   *
   * The checks are only about shape — something typed, something that looks
   * like an address. Whether the credentials are right is the server's answer,
   * and it gives the same one for a wrong email and a wrong password.
   */
  'live-signin': async (context) => {
    const { state } = context;
    if (context.live.busy === 'sign-in') return false;
    const email = form(context, 'signinEmail');
    // Not trimmed: a password is whatever was typed.
    const password = state.dialogForm['signinPassword'] ?? '';
    const errors: Record<string, string> = {};
    if (email === '') {
      errors['signinEmail'] = text(context, 'أدخل بريدك الإلكتروني.', 'Enter your email address.');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors['signinEmail'] = text(context, 'أدخل بريدًا إلكترونيًا صحيحًا.', 'Enter a valid email address.');
    }
    if (password === '') {
      errors['signinPassword'] = text(context, 'أدخل كلمة المرور.', 'Enter your password.');
    }
    if (invalid(context, errors)) {
      return false;
    }
    const signedIn = await signIn(context, email, password);
    // The password never stays in state after the attempt, whatever the answer.
    clearForm(context, ['signinPassword']);
    state.passwordVisible = false;
    context.refresh();
    return signedIn;
  },

  'live-session-retry': async (context) => {
    context.live.busy = 'session-retry';
    context.refresh();
    await loadSession(context);
    context.live.busy = null;
    context.refresh();
  },

  'live-signout': async (context) => signOut(context),

  'live-tenant-switch': (context, arg) => Promise.resolve(switchTenant(context, arg)),

  'live-sessions-reload': async (context) => loadSettingsScreen(context),

  'live-revoke-session': async (context, arg) => revokeSession(context, arg),

  'live-change-password': async (context) => {
    // Password whitespace is significant. Keep these values byte-for-byte the
    // same as the operator entered them, just as the sign-in form does.
    const currentPassword = rawForm(context, 'currentPassword');
    const newPassword = rawForm(context, 'newPassword');
    const confirmPassword = rawForm(context, 'confirmPassword');
    if (invalid(context, {
      ...(currentPassword === '' ? { currentPassword: text(context, 'أدخل كلمة المرور الحالية.', 'Enter your current password.') } : {}),
      ...(newPassword.length < 12 ? { newPassword: text(context, 'استخدم 12 حرفًا على الأقل.', 'Use at least 12 characters.') } : {}),
      ...(confirmPassword !== newPassword ? { confirmPassword: text(context, 'كلمتا المرور غير متطابقتين.', 'The passwords do not match.') } : {}),
      ...(currentPassword !== '' && newPassword === currentPassword ? { newPassword: text(context, 'اختر كلمة مرور مختلفة.', 'Choose a different password.') } : {}),
    })) return false;
    return changePassword(context, currentPassword, newPassword, confirmPassword);
  },

  // A reload re-reads the screen's lists, never the session: the workspace is
  // already open, and any 401 on the way closes it through the client.
  'live-reload': async (context) => manualRefresh(context, 'live-reload', () => loadPeopleScreen(context, true)),

  'live-channels-reload': async (context) => manualRefresh(context, 'live-channels-reload', () => loadChannelsScreen(context, true)),

  'live-authorize-test-recipient': async (context, arg) => {
    const peerIdentity = form(context, channelTestIdentityField(arg));
    const label = form(context, channelTestLabelField(arg));
    if (peerIdentity === '' || label === '') return false;
    const saved = await authorizeTestRecipient(context, arg, peerIdentity, label);
    if (saved) {
      clearForm(context, [channelTestIdentityField(arg), channelTestLabelField(arg)]);
      context.refresh();
    }
    return saved;
  },

  'live-revoke-test-recipient': async (context, arg) => {
    const { id: connectionId, value: authorizationId } = splitArg(arg);
    return connectionId === '' || authorizationId === '' ? false : revokeTestRecipient(context, connectionId, authorizationId);
  },

  'live-campaigns-reload': async (context) => manualRefresh(context, 'live-campaigns-reload', () => loadCampaignsScreen(context)),

  'live-automations-reload': async (context) => manualRefresh(context, 'live-automations-reload', () => loadAutomationsScreen(context)),
  'live-automation-use': async (context, arg) => useAutomationTemplate(context, arg),
  'live-automation-create': async (context) => {
    const name = context.state.dialogForm['automationBlankName']?.trim() ?? '';
    if (name === '') return false;
    const created = await createBlankAutomation(context, name);
    if (created) context.state.dialogForm = {};
    return created;
  },
  'live-automation-save': async (context, arg) => saveAutomation(context, arg),
  'live-automation-add-step': async (context, arg) => addAutomationStep(context, arg),
  'live-automation-remove-step': async (context, arg) => removeAutomationStep(context, arg),
  'live-automation-transition': async (context, arg) => transitionAutomation(context, arg),
  'live-automation-delete-confirm': async (context, arg) => {
    const deleted = await deleteAutomationDraft(context, arg);
    if (deleted) context.state.dialog = null;
    return deleted;
  },
  'live-automation-filter': async (context) => setAutomationQuery(context, {
    search: (context.state.dialogForm['automationSearch'] ?? '').trim(),
    state: asAutomationState(context.state.dialogForm['automationState'] ?? ''),
    sort: asAutomationSort(context.state.dialogForm['automationSort'] ?? 'updated_desc'),
    limit: 25,
  }),
  'live-automation-load-more': async (context) => loadAutomationPage(context, false),
  'live-automation-runs-filter': async (context) => setAutomationRunsQuery(context, {
    limit: context.state.dialogForm['automationRunsLimit'] === '50' ? 50 : 25,
  }),
  'live-automation-runs-load-more': async (context) => loadAutomationRunsPage(context, false),

  'live-campaign-create': async (context) => {
    const name = form(context, 'campaignName');
    // The channel select shows the first healthy connection until it is changed.
    const connectionId = form(context, 'campaignConnection') || (rowsOf(context.live.connections).find((connection) => connection.status === 'healthy')?.id ?? '');
    const message = form(context, 'campaignMessage');
    if (invalid(context, campaignErrors(context, { campaignName: name, campaignMessage: message }))) return false;
    // The create button is disabled without a healthy connection; the server
    // refuses a draft without one either way.
    if (connectionId === '') return false;
    const created = await createCampaign(context, {
      name,
      objective: form(context, 'campaignObjective') || null,
      connectionId,
      content: { text: message },
      variables: { display_name: 'display_name' },
      audienceFilter: { search: form(context, 'campaignSearch') },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      budgetAmountMinor: 0,
      budgetCurrency: 'USD',
    });
    if (created) {
      context.state.dialog = null;
      clearForm(context, ['campaignName','campaignConnection','campaignMessage','campaignObjective','campaignSearch']);
      context.refresh();
    }
    return created;
  },

  'live-campaign-update': async (context, arg) => {
    const campaign = rowsOf(context.live.campaigns).find((entry) => entry.id === arg);
    if (campaign === undefined) return false;
    // The editor shows the saved values until they are changed, so an untouched
    // field means "keep what the server has". Reading an untouched field as
    // empty used to clear the audience search and the objective on a rename —
    // turning a cosmetic edit into a new revision — and silently refused any
    // save that did not retype the message.
    const savedText = typeof campaign.content['text'] === 'string' ? campaign.content['text'] : '';
    const savedSearch = typeof campaign.audience_filter['search'] === 'string' ? campaign.audience_filter['search'] : '';
    const name = edited(context, 'campaignName', campaign.name);
    const message = edited(context, 'campaignMessage', savedText);
    if (invalid(context, campaignErrors(context, { campaignName: name, campaignMessage: message }))) return false;
    const updated = await updateCampaign(context, arg, {
      name,
      objective: edited(context, 'campaignObjective', campaign.objective ?? '') || null,
      connectionId: edited(context, 'campaignConnection', campaign.connection_id),
      content: { ...campaign.content, text: message },
      variables: campaign.variables,
      audienceFilter: { ...campaign.audience_filter, search: edited(context, 'campaignSearch', savedSearch) },
      timezone: campaign.timezone,
      expiresAt: campaign.expires_at,
      budgetAmountMinor: Number(campaign.budget_amount_minor),
      budgetCurrency: campaign.budget_currency,
    }, campaign.version);
    if (updated) {
      context.state.dialog = null;
      clearForm(context, ['campaignName','campaignConnection','campaignMessage','campaignObjective','campaignSearch']);
      context.refresh();
    }
    return updated;
  },

  'live-campaign-validate': async (context, arg) => validateCampaign(context, arg),
  'live-campaign-approve': async (context, arg) => approveCampaign(context, arg),
  'live-campaign-launch': async (context, arg) => launchCampaign(context, arg),
  'live-campaign-retry': async (context, arg) => retryCampaignFailures(context, arg),
  'live-campaign-control': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (value !== 'pause' && value !== 'resume' && value !== 'cancel') return false;
    return controlCampaign(context, id, value);
  },
  'live-campaign-clone': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return id === '' || value === '' ? false : cloneCampaign(context, id, value);
  },
  'live-campaign-test-send': async (context, arg) => {
    const campaign = rowsOf(context.live.campaigns).find((entry) => entry.id === arg);
    const testRecipientId = form(context, 'campaignTestRecipient') ||
      (campaign === undefined ? '' : rowsOf(context.live.testRecipients).find((entry) => entry.connection_id === campaign.connection_id)?.id ?? '');
    if (campaign === undefined || testRecipientId === '') return false;
    const queued = await testSendCampaign(context, campaign.id, testRecipientId, campaign.version);
    if (queued) {
      context.state.dialog = null;
      clearForm(context, ['campaignTestRecipient']);
      context.refresh();
    }
    return queued;
  },
  'live-campaign-ledger': async (context, arg) => loadCampaignRecipients(context, arg),

  /**
   * Shows one campaign's detail, and its recipients when it has an execution.
   * A campaign that never launched has no ledger to ask for.
   */
  'live-campaign-open': async (context, arg) => {
    const campaign = rowsOf(context.live.campaigns).find((entry) => entry.id === arg);
    if (campaign === undefined) return false;
    if (campaign.execution === null) {
      context.live.selectedCampaignId = campaign.id;
      context.live.campaignRecipients = { status: 'idle' };
      context.refresh();
      return true;
    }
    await loadCampaignRecipients(context, campaign.id);
    return true;
  },

  'live-campaign-schedule': async (context, arg) => {
    const typed = form(context, 'campaignScheduleAt');
    // `datetime-local` has no zone: it means that wall-clock time *here*, which
    // is exactly how `new Date` reads it.
    const at = typed === '' ? Number.NaN : new Date(typed).getTime();
    if (invalid(context, Number.isNaN(at) || at <= context.now()
      ? { campaignScheduleAt: text(context, 'اختر وقتًا مستقبليًا.', 'Choose a time in the future.') }
      : {})) return false;
    const scheduled = await launchCampaign(context, arg, new Date(at).toISOString());
    if (scheduled) {
      context.state.dialog = null;
      clearForm(context, ['campaignScheduleAt']);
      context.refresh();
    }
    return scheduled;
  },

  /**
   * Narrows the report and reads it again. The scope goes into the address bar,
   * so a filtered report can be shared and survives a reload.
   */
  'live-report-filter': async (context, arg) => {
    const { id, value } = splitArg(arg);
    const filters = context.state.analyticsFilters;
    if (!(id === 'from' || id === 'to' || id === 'agentId' || id === 'teamId' || id === 'channel' || id === 'connectionId' || id === 'labelId' || id === 'campaignId' || id === 'priority' || id === 'status') || filters[id] === value) return false;
    context.state.analyticsFilters = { ...filters, [id]: value };
    await loadAnalyticsReport(context);
    return true;
  },

  'live-report-filter-clear': async (context) => {
    context.state.analyticsFilters = NO_ANALYTICS_FILTERS;
    await loadAnalyticsReport(context);
  },

  'live-report-reload': async (context) => manualRefresh(context, 'live-report-reload', () => loadAnalyticsReport(context)),
  'live-assignments-more': async (context) => loadAssignmentReport(context, true),
  'live-report-export': async (context) => createCampaignReportExport(context),
  'live-report-export-refresh': async (context) => refreshCampaignReportExport(context),

  /* ----------------------------------------------------------------- inbox -- */

  'live-inbox-reload': async (context) => manualRefresh(context, 'live-inbox-reload', () => loadInboxScreen(context)),
  'live-supervisor-open': async (context) => {
    if (context.live.supervisorAgentId !== null) return exitSupervisor(context);
    if (context.state.supervisorPickerOpen) {
      context.state.supervisorPickerOpen = false;
      context.refresh();
      return true;
    }
    context.state.supervisorPickerOpen = true;
    await loadSupervisorAgents(context);
    return true;
  },
  'live-supervisor-agent': async (context, arg) => loadSupervisorInbox(context, arg),
  'live-supervisor-open-report': async (context, arg) => {
    // Preserve the opaque membership ID, rather than a display name, so two
    // people with the same name cannot share a report or a drill-down route.
    if (!rowsOf(context.live.supervisorAgents).some((agent) => agent.membershipId === arg)) return false;
    context.state.analyticsView = 'overview';
    context.state.route = {
      screen: 'analytics',
      conversationId: null,
      params: { ...context.state.route.params, view: 'operations', agent: arg },
    };
    await loadAnalyticsReport(context);
    return true;
  },
  'live-supervisor-exit': exitSupervisor,

  'live-inbox-queue': (context, arg) => {
    // A local view switch, not a request: both halves are already loaded, and
    // re-fetching on a tab click would make the queue flicker for nothing.
    context.state.inboxQueue = arg === 'mine' ? 'mine' : 'unassigned';
    context.refresh();
    return Promise.resolve();
  },

  'live-inbox-open': async (context, arg) => openConversation(context, arg),

  'live-inbox-claim': async (context, arg) => {
    const { id, value } = splitArg(arg);
    const version = Number(value);
    if (!Number.isInteger(version) || version < 1) {
      // A control rendered without its version is a bug, and sending a guess
      // would defeat the conflict check rather than trip it.
      return false;
    }
    return claimConversation(context, id, version);
  },

  'live-inbox-older': async (context) => loadOlderMessages(context),

  'live-inbox-load-more': async (context) => loadMoreInbox(context),

  'live-inbox-saved-view-apply': async (context, arg) => applySavedView(context, arg),

  'live-inbox-saved-view-create': async (context) => saveCurrentInboxView(context, 'create'),

  'live-inbox-saved-view-update': async (context) => saveCurrentInboxView(context, 'update'),

  'live-inbox-saved-view-retire': async (context, arg) => retireSavedView(context, arg),

  'live-inbox-search': (context, arg) => {
    scheduleInboxSearch(context, arg);
    return Promise.resolve();
  },

  // Label "any of" and "none of" values are chosen as visible names. This
  // avoids both opaque-ID entry and the common mistake of treating `in` as an
  // OR: the server's label predicate intentionally requires every selected
  // label to be present.
  'live-inbox-filter-value-toggle': (context, arg) => {
    const selected = new Set((context.state.dialogForm['inboxFilterValue'] ?? '').split(',').filter(Boolean));
    if (selected.has(arg)) selected.delete(arg);
    else selected.add(arg);
    context.state.dialogForm = { ...context.state.dialogForm, inboxFilterValue: [...selected].join(',') };
    context.refresh();
    return Promise.resolve();
  },

  'live-inbox-filter-apply': async (context) => {
    const filter = inboxFilterFromForm(context);
    if (filter === null) return false;
    context.live.inboxQuery = { ...context.live.inboxQuery, filters: [...context.live.inboxQuery.filters, filter], cursor: null };
    context.state.inboxQueue = 'mine';
    context.state.dialogForm = {};
    return loadInboxScreen(context);
  },

  'live-inbox-filter-remove': async (context, arg) => {
    const index = Number(arg);
    if (!Number.isInteger(index) || index < 0 || index >= context.live.inboxQuery.filters.length) return false;
    context.live.inboxQuery = { ...context.live.inboxQuery, filters: context.live.inboxQuery.filters.filter((_, candidate) => candidate !== index), cursor: null };
    context.live.selectedSavedViewId = null;
    context.state.inboxQueue = 'mine';
    return loadInboxScreen(context);
  },

  'live-inbox-filter-clear': async (context) => {
    context.live.inboxQuery = { ...context.live.inboxQuery, filters: [], cursor: null };
    context.live.selectedSavedViewId = null;
    context.state.inboxQueue = 'mine';
    return loadInboxScreen(context);
  },

  'live-inbox-sort': async (context, arg) => {
    if (!(INBOX_SORTS as readonly string[]).includes(arg)) return false;
    context.live.inboxQuery = { ...context.live.inboxQuery, sort: arg as InboxSort, cursor: null };
    context.state.inboxQueue = 'mine';
    return loadInboxScreen(context);
  },

  /* ------------------------------------------------------------- lifecycle -- */

  /**
   * Opens one of the transition forms.
   *
   * Opening clears the fields the last one left behind. A resolution typed,
   * abandoned and still sitting there when the same operator later presses
   * "Waiting on customer" is how the wrong sentence gets recorded against the
   * wrong fact.
   */
  'live-lifecycle-open': (context, arg) => {
    if (arg !== 'wait' && arg !== 'snooze' && arg !== 'resolve') {
      // The other two transitions carry no input, so there is no form to open.
      return Promise.resolve();
    }
    context.live.lifecyclePanel = arg;
    clearForm(context, LIFECYCLE_FIELDS);
    context.refresh();
    return Promise.resolve();
  },

  'live-lifecycle-close': (context) => {
    context.live.lifecyclePanel = null;
    clearForm(context, LIFECYCLE_FIELDS);
    context.refresh();
    return Promise.resolve();
  },

  'live-lifecycle-do': async (context, arg) => {
    const { id, value } = splitArg(arg);
    const command = lifecycleCommand(id);
    if (command === null) {
      return false;
    }
    const body = transitionBody(context, command, value);
    if (body === null) {
      return false;
    }
    const moved = await transitionConversation(context, body);
    if (moved) {
      clearForm(context, LIFECYCLE_FIELDS);
      context.refresh();
    }
    return moved;
  },

  /* --------------------------------------------------------------- routing -- */

  /**
   * Opens one of the routing controls.
   *
   * Opening the assignee or collaborator picker loads the directory, because it
   * is a per-conversation list and fetching it for every thread somebody
   * glances at would be a request per glance. The previous choice is cleared:
   * a colleague selected for one act and abandoned must not still be selected
   * when a different one is opened.
   */
  'live-routing-open': async (context, arg) => {
    if (arg !== 'assign' && arg !== 'handoff' && arg !== 'priority' && arg !== 'collaborators') {
      return;
    }
    const { live } = context;
    live.routingPanel = arg;
    live.routingChoice = '';
    context.refresh();
    if (arg !== 'priority') {
      await loadAssignees(context);
    }
  },

  'live-routing-close': (context) => {
    const { live } = context;
    live.routingPanel = null;
    live.routingChoice = '';
    live.handoffNote = '';
    context.refresh();
    return Promise.resolve();
  },

  /**
   * The colleague a picker has selected.
   *
   * Re-renders, unlike the text drafts: the confirm button beside it is
   * disabled until somebody is chosen, so a choice nobody redrew would leave a
   * live selection behind a dead button.
   */
  'live-routing-choice': (context, arg) => {
    context.live.routingChoice = arg;
    context.refresh();
    return Promise.resolve();
  },

  'live-routing-assign': async (context) =>
    assignConversation(context, context.live.routingChoice),

  'live-routing-unassign': async (context) => assignConversation(context, null),
  'live-routing-release-own': async (context) => releaseOwnConversation(context),
  'live-inbox-mark-unread': async (context) => markConversationUnread(context),

  'live-routing-ask': async (context) => requestHandoff(context, context.live.routingChoice),

  'live-routing-priority': async (context, arg) => setPriority(context, arg),

  'live-handoff-settle': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (value !== 'accept' && value !== 'decline' && value !== 'cancel') {
      return false;
    }
    return settleHandoff(context, id, value);
  },

  /** The handoff note's text, recorded without a re-render like every draft. */
  'live-handoff-note': (context, arg) => {
    context.live.handoffNote = arg;
    return Promise.resolve();
  },

  'live-collaborator-add': async (context) =>
    setCollaborator(context, context.live.routingChoice, true),

  'live-collaborator-remove': async (context, arg) => setCollaborator(context, arg, false),

  /* ----------------------------------------------------------------- notes -- */

  'live-notes-reload': async (context) => {
    const id = context.live.openConversationId;
    return id === null ? Promise.resolve() : loadNotes(context, id);
  },

  'live-note-add': async (context) => addNote(context),

  'live-note-delete': async (context, arg) => deleteNote(context, arg),

  /**
   * Starts correcting a note, seeded with what it currently says.
   *
   * Seeded rather than blank: an edit is a correction to a sentence, and making
   * somebody retype it to fix a word is how the correction ends up shorter than
   * the original.
   */
  'live-note-edit': (context, arg) => {
    const { live } = context;
    const existing =
      live.notes.status === 'ready' ? live.notes.value.find((note) => note.id === arg) : undefined;
    live.editingNoteId = arg;
    live.noteEdit = existing?.body ?? '';
    context.refresh();
    return Promise.resolve();
  },

  'live-note-edit-cancel': (context) => {
    context.live.editingNoteId = null;
    context.live.noteEdit = '';
    context.refresh();
    return Promise.resolve();
  },

  'live-note-edit-draft': (context, arg) => {
    context.live.noteEdit = arg;
    return Promise.resolve();
  },

  'live-note-edit-save': async (context, arg) => editNote(context, arg),

  /**
   * The note draft's text.
   *
   * Recorded without a re-render, exactly like the composer, and into its own
   * field. Sharing one draft between a note and a reply is how an internal
   * remark reaches a customer.
   */
  'live-note-draft': (context, arg) => {
    context.live.noteDraft = arg;
    return Promise.resolve();
  },

  /* -------------------------------------------------------------- contacts -- */

  'live-contacts-reload': async (context) => manualRefresh(context, 'live-contacts-reload', () => loadContactsScreen(context)),

  'live-contacts-search': async (context) => {
    context.live.contactQuery = form(context, 'contactQuery');
    return loadContactsScreen(context);
  },

  'live-inbox-filter': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (!['unread', 'priority', 'channel', 'labelId'].includes(id)) return false;
    context.live.inboxQuery = setSimpleFilter(context.live.inboxQuery, id as 'unread' | 'priority' | 'channel' | 'labelId', value);
    return loadInboxScreen(context);
  },

  'live-contact-filter': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (!['labelId', 'fieldId'].includes(id)) return false;
    context.live.contactFilters = {
      ...context.live.contactFilters,
      [id]: value,
      ...(id === 'fieldId' ? { fieldValue: '' } : {}),
    };
    context.refresh();
    return value === '' || id === 'labelId' ? loadContactsScreen(context) : true;
  },

  'live-contact-field-filter': async (context) => {
    context.live.contactFilters = {
      ...context.live.contactFilters,
      fieldValue: form(context, 'contactFieldFilter'),
    };
    return loadContactsScreen(context);
  },

  'live-label-create': async (context) => {
    const ok = await createLabel(
      context,
      form(context, 'labelName'),
      form(context, 'labelColor') || '#3B82F6',
    );
    if (ok) clearForm(context, ['labelName', 'labelColor']);
    return ok;
  },

  'live-workspace-label-create': async (context) => {
    const color = validLabelColor(context);
    if (color === null) return false;
    const ok = await createLabel(context, form(context, 'labelName'), color);
    if (ok) { context.state.dialog = null; clearForm(context, ['labelName', 'labelColor']); }
    return ok;
  },

  'live-workspace-label-update': async (context) => {
    const label = rowsOf(context.live.workspaceLabels).find((item) => item.id === context.state.dialog?.arg);
    if (label === undefined) return false;
    const color = validLabelColor(context);
    if (color === null) return false;
    const ok = await updateLabel(context, label, form(context, 'labelName'), color);
    if (ok) context.state.dialog = null;
    return ok;
  },

  'live-workspace-label-retire-confirm': async (context, arg) => {
    const label = rowsOf(context.live.workspaceLabels).find((item) => item.id === arg);
    const retired = label === undefined ? false : await retireLabel(context, label);
    if (retired) context.state.dialog = null;
    return retired;
  },

  'live-inline-label-create': async (context, arg) => {
    const [target, entityId] = arg.split('|');
    if ((target !== 'contact' && target !== 'conversation') || entityId === undefined) return false;
    const color = validLabelColor(context);
    if (color === null) return false;
    const created = await createAndAssignLabel(context, target, entityId, form(context, 'labelName'), color);
    if (created) {
      context.state.dialog = null;
      clearForm(context, ['labelName', 'labelColor']);
    }
    return created;
  },

  'live-field-create': async (context) => {
    const target = form(context, 'fieldTarget') || 'contact';
    const type = form(context, 'fieldType') || 'text';
    if (
      (target !== 'contact' && target !== 'conversation') ||
      !['text', 'number', 'boolean', 'date', 'email', 'phone', 'single_select', 'multi_select'].includes(type)
    ) return false;
    const ok = await createField(context, {
      target,
      key: form(context, 'fieldKey'),
      name: form(context, 'fieldName'),
      type: type as 'text' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'single_select' | 'multi_select',
      options: ['single_select', 'multi_select'].includes(type)
        ? form(context, 'fieldOptions').split(',').map((value) => value.trim()).filter(Boolean)
        : [],
    });
    if (ok) clearForm(context, ['fieldTarget', 'fieldType', 'fieldKey', 'fieldName', 'fieldOptions']);
    return ok;
  },

  'live-metadata-label': async (context, arg) => {
    const separator = arg.indexOf(':');
    const direct = separator === -1 ? arg : `${arg.slice(0, separator)}|${arg.slice(separator + 1)}`;
    const [target, entityId, labelId, act] = direct.split('|');
    if (
      (target !== 'contact' && target !== 'conversation') ||
      entityId === undefined ||
      labelId === undefined
    ) return false;
    return setEntityLabel(context, target, entityId, labelId, act !== 'remove');
  },

  'live-metadata-field': async (context, arg) => {
    const [target, entityId, fieldId] = arg.split('|');
    if (
      (target !== 'contact' && target !== 'conversation') ||
      entityId === undefined ||
      fieldId === undefined
    ) return false;
    return setFieldValue(
      context,
      target,
      entityId,
      fieldId,
      form(context, metadataFieldValue(target, entityId, fieldId)),
    );
  },

  'live-contact-open': async (context, arg) => openContact(context, arg),

  'live-contact-save-panel': async (context, arg) => saveContactName(context, arg),
  'live-contact-save-screen': async (context, arg) => saveContactName(context, arg),

  'live-consent-panel': async (context, arg) => recordConsentFrom(context, arg),
  'live-consent-screen': async (context, arg) => recordConsentFrom(context, arg),

  /**
   * The composer's text.
   *
   * Recorded without a re-render: redrawing a textarea on every keystroke moves
   * the caret, and what the operator has typed is theirs until they press Send.
   */
  'live-composer': (context, arg) => {
    context.live.composer = arg;
    return Promise.resolve();
  },

  'live-inbox-send': async (context) => sendReply(context),
  'live-whatsapp-template-open': async (context) => openWhatsAppTemplates(context),
  'live-whatsapp-template-search': async (context) => searchWhatsAppTemplates(context),
  'live-whatsapp-template-more': async (context) => loadMoreWhatsAppTemplates(context),
  'live-whatsapp-template-refresh': async (context) => refreshWhatsAppTemplates(context),
  'live-whatsapp-template-send': async (context) => sendWhatsAppTemplate(context),
  'live-whatsapp-template-select': async (context, arg) => {
    if (context.state.dialog?.kind !== 'whatsapp-template' || !rowsOf(context.live.conversationTemplates).some((template) => template.id === arg)) return false;
    const retained = Object.fromEntries(Object.entries(context.state.dialogForm).filter(([key]) => !key.startsWith('whatsappTemplateParameter_') && key !== 'whatsappTemplateClientMessageId'));
    context.state.dialogForm = { ...retained, whatsappTemplateId: arg };
    context.live.error = null;
    context.refresh();
    return true;
  },

  /**
   * Connects the kind the dialog was opened for.
   *
   * Required fields are checked before anything is sent. A success closes the
   * dialog and opens the new connection, which starts unverified — the next
   * step is to verify it, and the screen puts that step in front of the
   * operator rather than a success badge the server has not earned.
   */
  'live-connect-channel': async (context) => {
    const { state } = context;
    const selectedKind = state.dialog?.kind === 'connect-channel' ? state.dialog.arg : '';
    if (!['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'].includes(selectedKind)) return false;
    const meta = ['whatsapp', 'messenger', 'instagram'].includes(selectedKind);
    const errors = {
      ...(meta && form(context, 'channelProviderApp') === '' ? { channelProviderApp: text(context, 'أدخل معرّف تطبيق Meta.', 'Enter the Meta App ID.') } : {}),
      ...(form(context, 'channelAsset') === '' ? { channelAsset: text(context, 'أدخل معرّف الأصل.', 'Enter the asset ID.') } : {}),
      ...(form(context, 'channelName') === '' ? { channelName: text(context, 'أدخل اسمًا للعرض.', 'Enter a display name.') } : {}),
      ...(form(context, 'channelToken').length < 8 ? { channelToken: text(context, 'أدخل رمزًا من 8 أحرف على الأقل.', 'Enter at least 8 characters.') } : {}),
      ...(selectedKind === 'instagram' && !/^[0-9]{1,32}$/.test(form(context, 'channelPage'))
        ? { channelPage: text(context, 'أدخل معرّف صفحة فيسبوك المرتبطة.', 'Enter the linked Facebook Page ID.') } : {}),
    };
    if (invalid(context, errors)) return false;
    const connected = await connectChannel(context, {
      kind: selectedKind as 'whatsapp' | 'messenger' | 'instagram' | 'web_chat' | 'custom',
      externalAssetId: form(context, 'channelAsset'),
      displayName: form(context, 'channelName'),
      accessToken: form(context, 'channelToken'),
      providerAppId: meta ? form(context, 'channelProviderApp') : null,
      ...(selectedKind === 'instagram' ? { settings: { facebookPageId: form(context, 'channelPage') } } : {}),
    });
    // The token is dropped from state whatever the answer was — a credential
    // left in a form field is a credential in a screenshot. The rest is kept on a
    // refusal, so the attempt can be corrected rather than retyped.
    clearForm(context, ['channelToken']);
    if (connected !== null) {
      state.dialog = null;
      state.dialogForm = {};
      state.channelKind = selectedKind;
      state.expandedConnection = connected;
      state.focusTarget = `[data-connection="${connected}"] [data-act="connection-toggle"]`;
    }
    context.refresh();
    return connected !== null;
  },

  'live-test-channel': async (context, arg) => testChannel(context, arg),
  'live-sync-channel-templates': async (context, arg) => syncWhatsAppTemplates(context, arg),

  'live-rotate-channel': async (context, arg) => {
    const rotated = await rotateChannelCredential(
      context,
      arg,
      form(context, channelTokenField(arg)),
    );
    if (rotated) {
      clearForm(context, [channelTokenField(arg)]);
      context.refresh();
    }
    return rotated;
  },

  'live-instagram-page': async (context, arg) => {
    const value = form(context, channelPageField(arg));
    if (!/^[0-9]{1,32}$/.test(value)) {
      context.live.error = { status: 400, code: 'invalid_input', message: text(context, 'أدخل معرّف صفحة فيسبوك الرقمي.', 'Enter the numeric Facebook Page ID.'), requestId: null, details: [] };
      context.refresh();
      return false;
    }
    const saved = await setInstagramPage(context, arg, value);
    if (saved) clearForm(context, [channelPageField(arg)]);
    return saved;
  },

  'live-disconnect-channel': async (context, arg) => {
    const disconnected = await disconnectChannel(context, arg);
    if (disconnected && context.state.dialog?.kind === 'disconnect-channel') {
      context.state.dialog = null;
      context.refresh();
    }
    return disconnected;
  },

  'live-invite': async (context) => {
    const email = form(context, 'inviteEmail');
    const roleId = form(context, 'inviteRole');
    if (invalid(context, {
      ...(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { inviteEmail: text(context, 'أدخل بريدًا إلكترونيًا صحيحًا.', 'Enter a valid email address.') } : {}),
      ...(roleId === '' ? { inviteRole: text(context, 'اختر دورًا.', 'Choose a role.') } : {}),
    })) return false;
    const accepted = await invitePerson(context, email, roleId, []);
    if (accepted) {
      context.state.dialog = null;
      clearForm(context, ['inviteEmail', 'inviteRole']);
      context.refresh();
    }
    return accepted;
  },

  'live-revoke-invite': async (context, arg) => revokeInvitation(context, arg),

  'live-status': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return changeStatus(context, id, value);
  },

  'live-scope-tenant': async (context, arg) => changeScopes(context, arg, TENANT_SCOPE),

  'live-create-role': async (context) => {
    // A role starts with no grants; its permissions are chosen on its own page,
    // where each one is decided by the server when the role is saved.
    const name = form(context, 'roleName');
    const created = await createRole(context, name, form(context, 'roleDescription'), []);
    if (created) {
      const role = rowsOf(context.live.roles).find((entry) => entry.name === name);
      closeDialogAfter(context, true);
      if (role !== undefined) {
        context.state.route = { screen: 'roles', conversationId: null, params: { ...context.state.route.params, role: role.id } };
        context.refresh();
      }
    }
    return created;
  },

  'live-save-role': async (context, arg) => {
    const role = rowsOf(context.live.roles).find((entry) => entry.id === arg);
    const draft = context.state.roleDraft;
    if (role === undefined || draft === null || draft.roleId !== role.id) return false;
    const saved = await saveRoleGrants(context, role, Object.entries(draft.grants).map(([permission, scope]) => ({ permission, scope })));
    if (saved) {
      context.state.roleDraft = null;
      context.refresh();
    }
    return saved;
  },

  'live-role-assign': async (context, arg) => {
    const picked = form(context, 'assignPicked').split(',').filter((id) => id !== '');
    if (picked.length === 0) return false;
    return closeDialogAfter(context, await assignRole(context, arg, picked));
  },

  'live-member-role': async (context, arg) => {
    const roleId = form(context, 'memberRole');
    if (roleId === '') return false;
    return closeDialogAfter(context, await changeRole(context, arg, roleId));
  },

  'live-member-revoke': async (context, arg) => closeDialogAfter(context, await changeStatus(context, arg, 'revoked')),

  'live-member-team': async (context, arg) => {
    const [teamId = '', membershipId = '', change = ''] = arg.split(':');
    if (change === 'add') return addTeamMember(context, teamId, membershipId);
    if (change === 'remove') return removeTeamMember(context, teamId, membershipId);
    return false;
  },

  'live-rename-team': async (context, arg) => {
    const name = form(context, teamNameField(arg));
    if (name === '') return false;
    return closeDialogAfter(context, await renameTeam(context, arg, name));
  },

  'live-delete-role': async (context, arg) => {
    const deleted = await deleteRole(context, arg);
    if (deleted) {
      if (context.state.roleDraft?.roleId === arg) context.state.roleDraft = null;
      // Its page no longer exists; return to the list rather than a dead end.
      if (context.state.route.params['role'] === arg) {
        const params = Object.fromEntries(Object.entries(context.state.route.params).filter(([name]) => name !== 'role' && name !== 'tab'));
        context.state.route = { ...context.state.route, params };
      }
    }
    return closeDialogAfter(context, deleted);
  },

  'live-create-team': async (context) => {
    const created = await createTeam(context, form(context, 'teamName'));
    if (created) {
      clearForm(context, ['teamName']);
      closeDialogAfter(context, true);
      context.refresh();
    }
    return created;
  },

  'live-archive-team': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return archiveTeam(context, id, value !== 'restore');
  },

  'live-remove-member': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return removeTeamMember(context, id, value);
  },

  'live-rename-role': async (context, arg) => {
    // The grants are resent from the role the server reported, so the rename
    // is refused outright if this browser has never seen that role.
    const role = rowsOf(context.live.roles).find((entry) => entry.id === arg);
    if (role === undefined) {
      return false;
    }
    const key = roleNameField(arg);
    const description = context.state.dialogForm[`${key}_description`];
    const renamed = await renameRole(context, role, edited(context, key, role.name), description === undefined ? role.description : description.trim());
    if (renamed) {
      clearForm(context, [key, `${key}_description`]);
      closeDialogAfter(context, true);
      context.refresh();
    }
    return renamed;
  },

  'live-team-add': async (context, arg) => {
    const membershipId = form(context, teamMemberField(arg));
    const added = await addTeamMember(context, arg, membershipId);
    if (added) {
      clearForm(context, [teamMemberField(arg)]);
      context.refresh();
    }
  },

  'live-offer-ownership': async (context, arg) => {
    const offered = await offerOwnership(context, arg);
    if (offered) {
      context.state.dialog = null;
      context.refresh();
    }
    return offered;
  },

  'live-ownership': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (value !== 'accept' && value !== 'decline' && value !== 'cancel') {
      return false;
    }
    return settleOwnership(context, id, value);
  },
};

let inboxSearchTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced free-text search; filters are only committed after typing pauses. */
function scheduleInboxSearch(context: LiveContext, value: string): void {
  // Keep the controlled input stable through unrelated renders while the
  // request is debounced. Search itself stays intentionally out of the URL.
  context.live.inboxSearchDraft = value;
  if (inboxSearchTimer !== null) clearTimeout(inboxSearchTimer);
  inboxSearchTimer = setTimeout(() => {
    inboxSearchTimer = null;
    const search = value.trim().slice(0, 200);
    context.live.inboxSearchDraft = search;
    if (context.live.inboxQuery.search === (search === '' ? null : search)) return;
    context.live.inboxQuery = { ...context.live.inboxQuery, search: search === '' ? null : search, cursor: null };
    context.live.selectedSavedViewId = null;
    context.state.inboxQueue = 'mine';
    void loadInboxScreen(context);
  }, 250);
}

/** Builds only a catalogue-defined filter. The API remains final validator. */
function inboxFilterFromForm(context: LiveContext): InboxFilter | null {
  const key = form(context, 'inboxFilterKey');
  const requestedOperator = form(context, 'inboxFilterOperator');
  const definition = INBOX_FILTER_CATALOGUE.find((entry) => entry.key === key);
  if (definition === undefined) return null;
  let operator = requestedOperator;
  let customFieldType: string | undefined;
  const fieldId = form(context, 'inboxFilterFieldId');
  if (definition.key === 'custom_field') {
    const field = rowsOf(context.live.customFields).find((candidate) => candidate.id === fieldId && candidate.target === 'conversation' && candidate.state === 'active');
    if (field === undefined) return null;
    customFieldType = field.type;
    const operators = customFieldOperators(field.type);
    operator = operators.includes(requestedOperator) ? requestedOperator : operators[0]!;
  }
  if (!definition.operators.includes(operator)) return null;
  const valuelessOperator = operator === 'is_set' || operator === 'is_not_set';
  if (valuelessOperator) {
    return {
      key: definition.key,
      operator,
      ...(definition.key === 'custom_field' ? { fieldId } : {}),
    };
  }
  const raw = form(context, 'inboxFilterValue');
  if (raw === '') return null;
  const valueType = definition.valueType === 'custom_field' ? customFieldType : definition.valueType;
  const value = valueType === 'boolean'
    ? raw === 'true' ? true : raw === 'false' ? false : null
    : (operator === 'in' || operator === 'not_in')
      ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
      : raw;
  if (value === null || Array.isArray(value) && value.length === 0) return null;
  return {
    key: definition.key,
    operator,
    value,
    ...(definition.key === 'custom_field' ? { fieldId } : {}),
  };
}

function customFieldOperators(type: string): readonly string[] {
  if (type === 'boolean') return ['eq', 'neq', 'is_set', 'is_not_set'];
  if (type === 'number' || type === 'date' || type === 'single_select') return ['eq', 'neq', 'is_set', 'is_not_set'];
  if (type === 'text' || type === 'email' || type === 'phone') return ['eq', 'contains', 'is_set', 'is_not_set'];
  return ['is_set', 'is_not_set'];
}

async function submitCredentialFlow(context: LiveContext, kind: 'invitation' | 'recovery'): Promise<boolean> {
  if (context.live.busy !== null) return false;
  const token = context.state.route.params['token'] ?? '';
  const password = context.state.dialogForm['authPassword'] ?? '';
  const confirm = context.state.dialogForm['authPasswordConfirm'] ?? '';
  const errors: Record<string, string> = {};
  if (password.length < 12) errors['authPassword'] = text(context, 'استخدم 12 حرفًا على الأقل.', 'Use at least 12 characters.');
  if (confirm !== password) errors['authPasswordConfirm'] = text(context, 'كلمتا المرور غير متطابقتين.', 'Passwords do not match.');
  if (invalid(context, errors)) return false;
  const busy = kind === 'invitation' ? 'live-accept-invitation' : 'live-complete-recovery';
  context.live.busy = busy; context.live.error = null; context.refresh();
  const result = kind === 'invitation'
    ? await context.live.api.acceptInvitation(token, password)
    : await context.live.api.completeRecovery(token, password);
  context.live.busy = null;
  context.state.dialogForm = {};
  if (!result.ok) context.live.error = result.error;
  else context.state.authFlowComplete = kind;
  context.refresh(); return result.ok;
}

/** Runs a `live-*` action, or reports that the name is not one. */
export function runLiveAction(context: LiveContext, name: string, arg: string): Promise<unknown> | null {
  const handler = LIVE_ACTIONS[name];
  return handler === undefined ? null : handler(context, arg);
}
