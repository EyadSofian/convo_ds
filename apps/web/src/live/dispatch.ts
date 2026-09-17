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
  loadInboxScreen,
  loadOlderMessages,
  openConversation,
  sendReply,
} from './inbox-actions.js';
import {
  addNote,
  deleteNote,
  editNote,
  loadNotes,
  transitionConversation,
} from './lifecycle-actions.js';
import {
  assignConversation,
  loadAssignees,
  requestHandoff,
  setCollaborator,
  setPriority,
  settleHandoff,
} from './routing-actions.js';
import { createField, createLabel, setEntityLabel, setFieldValue } from './metadata-actions.js';
import { rowsOf } from './store.js';
import {
  approveCampaign,
  cloneCampaign,
  controlCampaign,
  createCampaign,
  createCampaignReportExport,
  launchCampaign,
  loadCampaignRecipients,
  loadCampaignReport,
  loadCampaignsScreen,
  refreshCampaignReportExport,
  retryCampaignFailures,
  testSendCampaign,
  updateCampaign,
  validateCampaign,
} from './campaign-actions.js';
import {
  addTeamMember,
  archiveTeam,
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
  loadSession,
  loadSettingsScreen,
  revokeSession,
  switchTenant,
  offerOwnership,
  removeTeamMember,
  renameRole,
  rotateChannelCredential,
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

/** The form key for a connection's credential-rotation field. */
export function channelTokenField(connectionId: string): string {
  return `channelToken_${connectionId}`;
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

  // A reload re-reads the screen's lists, never the session: the workspace is
  // already open, and any 401 on the way closes it through the client.
  'live-reload': async (context) => loadPeopleScreen(context),

  'live-channels-reload': async (context) => loadChannelsScreen(context),

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

  'live-campaigns-reload': async (context) => loadCampaignsScreen(context),

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
    if (!(id === 'from' || id === 'to' || id === 'channel' || id === 'campaignId') || filters[id] === value) return false;
    context.state.analyticsFilters = { ...filters, [id]: value };
    await loadCampaignReport(context);
    return true;
  },

  'live-report-filter-clear': async (context) => {
    context.state.analyticsFilters = NO_ANALYTICS_FILTERS;
    await loadCampaignReport(context);
  },

  'live-report-reload': async (context) => loadCampaignReport(context),
  'live-report-export': async (context) => createCampaignReportExport(context),
  'live-report-export-refresh': async (context) => refreshCampaignReportExport(context),

  /* ----------------------------------------------------------------- inbox -- */

  'live-inbox-reload': async (context) => loadInboxScreen(context),

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

  'live-contacts-reload': async (context) => loadContactsScreen(context),

  'live-contacts-search': async (context) => {
    context.live.contactQuery = form(context, 'contactQuery');
    return loadContactsScreen(context);
  },

  'live-inbox-filter': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (!['unread', 'priority', 'channel', 'labelId'].includes(id)) return false;
    context.live.inboxFilters = { ...context.live.inboxFilters, [id]: value };
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
    };
    if (invalid(context, errors)) return false;
    const connected = await connectChannel(context, {
      kind: selectedKind as 'whatsapp' | 'messenger' | 'instagram' | 'web_chat' | 'custom',
      externalAssetId: form(context, 'channelAsset'),
      displayName: form(context, 'channelName'),
      accessToken: form(context, 'channelToken'),
      providerAppId: meta ? form(context, 'channelProviderApp') : null,
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

  'live-role': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return changeRole(context, id, value);
  },

  'live-status': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return changeStatus(context, id, value);
  },

  'live-scope-tenant': async (context, arg) => changeScopes(context, arg, TENANT_SCOPE),

  'live-create-role': async (context) => {
    // No fallbacks: the control is disabled until a permission and a scope have
    // been chosen, so a default here would only ever paper over a rendering bug
    // by inventing a grant nobody picked.
    const created = await createRole(context, form(context, 'roleName'), '', [
      { permission: form(context, 'roleGrant'), scope: form(context, 'roleScope') },
    ]);
    if (created) {
      clearForm(context, ['roleName', 'roleGrant', 'roleScope']);
      context.refresh();
    }
  },

  'live-delete-role': async (context, arg) => deleteRole(context, arg),

  'live-create-team': async (context) => {
    const created = await createTeam(context, form(context, 'teamName'));
    if (created) {
      clearForm(context, ['teamName']);
      context.refresh();
    }
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
    const renamed = await renameRole(context, role, form(context, roleNameField(arg)));
    if (renamed) {
      clearForm(context, [roleNameField(arg)]);
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

/** Runs a `live-*` action, or reports that the name is not one. */
export function runLiveAction(context: LiveContext, name: string, arg: string): Promise<unknown> | null {
  const handler = LIVE_ACTIONS[name];
  return handler === undefined ? null : handler(context, arg);
}
