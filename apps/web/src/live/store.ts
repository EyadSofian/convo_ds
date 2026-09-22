import type { ChannelCatalogueEntry, ChannelConnection, ChannelTestRecipient, ChannelsApi } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import type {
  Collaborator,
  Conversation,
  ConversationsApi,
  DirectoryAgent,
  Episode,
  Handoff,
  Note,
  QueueCard,
  TimelineMessage,
} from '../api/conversations.js';
import { INBOX_QUERY_DEFAULT, type InboxQuery } from '@convo/domain';
import type { Contact, ContactsApi, ContactSummary } from '../api/contacts.js';
import type { CustomField, Label, MetadataApi } from '../api/metadata.js';
import type { Campaign, CampaignRecipient, CampaignReport, CampaignReportExport, CampaignsApi } from '../api/campaigns.js';
import { disconnectedCampaignsApi } from '../api/campaigns.js';
import type { Automation, AutomationRun, AutomationTemplate, AutomationsApi, WhatsAppTemplate } from '../api/automations.js';
import { disconnectedAutomationsApi } from '../api/automations.js';
import { disconnectedMetadataApi } from '../api/people.js';
import { disconnectedSavedViewsApi } from '../api/people.js';
import type { SavedView, SavedViewsApi } from '../api/saved-views.js';
import type { RealtimeSubscription } from './realtime.js';
import type {
  Invitation,
  MembershipSummary,
  OwnershipTransfer,
  PeopleApi,
  Permission,
  Person,
  Role,
  SessionSummary,
  Team,
} from '../api/people.js';

/**
 * Server-backed state for the People, Channels and Inbox screens.
 *
 * Everything here describes what the *server* said, and when. Nothing in this
 * file reads the demo dataset, and nothing in it is invented locally — an
 * inbox that filled a gap with a plausible value would be showing an operator
 * something no server ever said.
 *
 * A resource is deliberately a four-state value rather than `data | null`. The
 * screens have to tell "not asked yet" from "asked and empty" from "asked and
 * refused", because those are three different things to put in front of an
 * operator, and a nullable field collapses them into one.
 */
export type Resource<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T; readonly loadedAt: number }
  | { readonly status: 'error'; readonly error: ApiError };

export const IDLE: Resource<never> = { status: 'idle' };
export const LOADING: Resource<never> = { status: 'loading' };

export function ready<T>(value: T, loadedAt: number): Resource<T> {
  return { status: 'ready', value, loadedAt };
}

export function failed<T>(error: ApiError): Resource<T> {
  return { status: 'error', error };
}

/** Folds a result into a resource, so no caller writes the same branch twice. */
/**
 * The state a list takes while it is read again.
 *
 * A list already on screen stays there while a change is confirmed, so a click
 * does not blank the page into placeholders; one that never loaded shows them.
 */
export function reloading<T>(resource: Resource<T>, keep: boolean): Resource<T> {
  return keep && resource.status === 'ready' ? resource : LOADING;
}

export function fromResult<T>(result: ApiResult<T>, now: number): Resource<T> {
  return result.ok ? ready(result.data, now) : failed(result.error);
}

export type SessionState =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'signed_out';
      readonly error: ApiError | null;
      /** True when a session that was open stopped being accepted by the server. */
      readonly expired?: boolean;
      /** The session probe itself failed, so nobody knows yet whether there is one. */
      readonly probeError?: ApiError;
    }
  | {
      readonly status: 'signed_in';
      readonly email: string;
      readonly memberships: readonly MembershipSummary[];
      readonly tenantId: string | null;
    };

/**
 * The one place a mutation's progress is recorded.
 *
 * `busy` names the operation in flight so exactly the control that started it
 * can show a pending state and refuse a second click, rather than the whole
 * screen greying out. `error` is the server's answer to the last attempt, kept
 * beside the form that caused it.
 */
export interface LiveState {
  readonly api: PeopleApi;
  readonly channels: ChannelsApi;
  readonly conversationsApi: ConversationsApi;
  readonly contactsApi: ContactsApi;
  readonly metadataApi: MetadataApi;
  readonly campaignsApi: CampaignsApi;
  readonly automationsApi: AutomationsApi;
  readonly savedViewsApi: SavedViewsApi;
  session: SessionState;
  people: Resource<readonly Person[]>;
  roles: Resource<readonly Role[]>;
  teams: Resource<readonly Team[]>;
  invitations: Resource<readonly Invitation[]>;
  permissions: Resource<readonly Permission[]>;
  transfers: Resource<readonly OwnershipTransfer[]>;
  connections: Resource<readonly ChannelConnection[]>;
  catalogue: Resource<readonly ChannelCatalogueEntry[]>;
  testRecipients: Resource<readonly ChannelTestRecipient[]>;
  /**
   * The Unassigned queue, as **cards**.
   *
   * A separate field from `conversations` because it is a separate shape: a
   * card carries a masked label and no message text, and the two must never be
   * able to substitute for one another in a view.
   */
  unassigned: Resource<readonly QueueCard[]>;
  /** Conversations this caller may read. Records, not cards. */
  conversations: Resource<readonly Conversation[]>;
  openConversationId: string | null;
  openConversation: Resource<Conversation>;
  timeline: Resource<readonly TimelineMessage[]>;
  /** The position to page further back from, or `null` at the beginning. */
  timelineCursor: string | null;
  /** What the operator has typed but not sent. Never sent on their behalf. */
  composer: string;
  /**
   * The private notes on the open conversation, and what is being written.
   *
   * A separate draft from `composer` on purpose: a note and a reply go to
   * different places, and one field for both is how an internal remark ends up
   * sent to a customer.
   */
  notes: Resource<readonly Note[]>;
  noteDraft: string;
  /**
   * The note being corrected, and the text of the correction.
   *
   * Separate from `noteDraft` so opening an edit does not consume what somebody
   * had started writing as a new note, and so cancelling an edit gives that
   * draft back untouched.
   */
  editingNoteId: string | null;
  noteEdit: string;
  /** The reporting episodes of the open conversation. */
  episodes: Resource<readonly Episode[]>;
  /** Which lifecycle control is expanded, if any. Never two at once. */
  lifecyclePanel: 'wait' | 'snooze' | 'resolve' | null;
  /**
   * Work routing on the open conversation.
   *
   * The directory is loaded only when somebody opens the picker: it is a list
   * of colleagues computed per conversation, and fetching it for every thread
   * an agent glances at would be a request per glance. It is also deliberately
   * a *suggestion* — the server re-checks the target inside the write, so a
   * stale entry costs a typed refusal rather than a wrong assignment.
   */
  assignees: Resource<readonly DirectoryAgent[]>;
  handoffs: Resource<readonly Handoff[]>;
  collaborators: Resource<readonly Collaborator[]>;
  /** Which routing control is expanded. Never two at once, for the same reason. */
  routingPanel: 'assign' | 'handoff' | 'priority' | 'collaborators' | null;
  /** What the operator picked in the assignee or collaborator list, before they pressed anything. */
  routingChoice: string;
  handoffNote: string;
  /**
   * True when a conversation this person **was** reading became unreadable.
   *
   * Different from any other denial, and worth its own flag: a first read that
   * is refused means the conversation was never theirs, while a re-read that is
   * refused means it moved — a handoff was accepted, or a supervisor reassigned
   * it out from under them. Telling somebody "this moved" about a thread they
   * never had would be a lie about what just happened.
   */
  lostAccess: boolean;
  realtime: RealtimeState;
  subscription: RealtimeSubscription | null;
  /** The contact behind the open conversation, for the customer panel. */
  openContact: Resource<Contact>;
  /** The Contacts screen's list, and the search behind it. */
  contacts: Resource<readonly ContactSummary[]>;
  contactQuery: string;
  selectedContactId: string | null;
  selectedContact: Resource<Contact>;
  labels: Resource<readonly Label[]>;
  customFields: Resource<readonly CustomField[]>;
  /** This user's active sessions, for the Settings screen. */
  sessions: Resource<readonly SessionSummary[]>;
  campaigns: Resource<readonly Campaign[]>;
  campaignRecipients: Resource<readonly CampaignRecipient[]>;
  campaignReport: Resource<CampaignReport>;
  /** The campaigns the Analytics campaign filter can offer. */
  reportCampaigns: readonly { readonly id: string; readonly name: string }[];
  campaignReportExport: Resource<CampaignReportExport>;
  automationTemplates: Resource<readonly AutomationTemplate[]>;
  automations: Resource<readonly Automation[]>;
  automationRuns: Resource<readonly AutomationRun[]>;
  whatsappTemplates: Resource<readonly WhatsAppTemplate[]>;
  selectedCampaignId: string | null;
  /** Single authoritative readable-Inbox query, shared by load and realtime. */
  inboxQuery: InboxQuery;
  /** Text currently being typed before the debounced server search commits it. */
  inboxSearchDraft: string;
  /** Opaque continuation returned for the current readable Inbox query. */
  inboxNextCursor: string | null;
  /** Views loaded from the guarded API; never browser-local query presets. */
  savedViews: Resource<readonly SavedView[]>;
  selectedSavedViewId: string | null;
  contactFilters: { labelId: string; fieldId: string; fieldValue: string };
  busy: string | null;
  error: ApiError | null;
  /** Incremented on every settled mutation, so a view can key off freshness. */
  revision: number;
}

/**
 * What the live connection is doing, in the operator's terms.
 *
 * `stale` is the one that matters: the stream is not delivering, so what is on
 * screen is a snapshot from a moment ago. Saying so is the difference between a
 * quiet inbox and a broken one, and an operator cannot tell those apart by
 * looking.
 */
export type RealtimeState =
  | { readonly status: 'idle' }
  | { readonly status: 'live'; readonly since: number }
  | { readonly status: 'stale'; readonly reason: string; readonly retryAt: number }
  | { readonly status: 'stopped'; readonly reason: string };

export function createLiveState(
  api: PeopleApi,
  channels: ChannelsApi,
  conversations: ConversationsApi,
  contacts: ContactsApi,
  metadata: MetadataApi = disconnectedMetadataApi(),
  campaignsApi: CampaignsApi = disconnectedCampaignsApi(),
  automationsApi: AutomationsApi = disconnectedAutomationsApi(),
  savedViewsApi: SavedViewsApi = disconnectedSavedViewsApi(),
): LiveState {
  return {
    api,
    channels,
    conversations: IDLE,
    session: { status: 'unknown' },
    people: IDLE,
    roles: IDLE,
    teams: IDLE,
    invitations: IDLE,
    permissions: IDLE,
    transfers: IDLE,
    connections: IDLE,
    catalogue: IDLE,
    testRecipients: IDLE,
    unassigned: IDLE,
    openConversationId: null,
    openConversation: IDLE,
    timeline: IDLE,
    timelineCursor: null,
    composer: '',
    notes: IDLE,
    noteDraft: '',
    editingNoteId: null,
    noteEdit: '',
    episodes: IDLE,
    lifecyclePanel: null,
    assignees: IDLE,
    handoffs: IDLE,
    collaborators: IDLE,
    routingPanel: null,
    routingChoice: '',
    handoffNote: '',
    lostAccess: false,
    realtime: { status: 'idle' },
    subscription: null,
    openContact: IDLE,
    contacts: IDLE,
    contactQuery: '',
    selectedContactId: null,
    selectedContact: IDLE,
    labels: IDLE,
    customFields: IDLE,
    sessions: IDLE,
    campaigns: IDLE,
    campaignRecipients: IDLE,
    campaignReport: IDLE,
    reportCampaigns: [],
    campaignReportExport: IDLE,
    automationTemplates: IDLE,
    automations: IDLE,
    automationRuns: IDLE,
    whatsappTemplates: IDLE,
    selectedCampaignId: null,
    inboxQuery: INBOX_QUERY_DEFAULT,
    inboxSearchDraft: '',
    inboxNextCursor: null,
    savedViews: IDLE,
    selectedSavedViewId: null,
    contactFilters: { labelId: '', fieldId: '', fieldValue: '' },
    conversationsApi: conversations,
    contactsApi: contacts,
    metadataApi: metadata,
    campaignsApi,
    automationsApi,
    savedViewsApi,
    busy: null,
    error: null,
    revision: 0,
  };
}

/**
 * A fresh state over the same transport.
 *
 * Used when a session ends. A new object rather than a reset of the old one:
 * a request still in flight holds the old object, so whatever it brings back
 * lands somewhere nothing renders instead of in the next person's workspace.
 */
export function renewLiveState(previous: LiveState): LiveState {
  return createLiveState(
    previous.api,
    previous.channels,
    previous.conversationsApi,
    previous.contactsApi,
    previous.metadataApi,
    previous.campaignsApi,
    previous.automationsApi,
    previous.savedViewsApi,
  );
}

/** The tenant the screens are working in, or `null` when not signed in. */
export function currentTenantId(live: LiveState): string | null {
  return live.session.status === 'signed_in' ? live.session.tenantId : null;
}

/**
 * Runs `work` for the company being viewed, or does nothing.
 *
 * One guard for every action in every module rather than one per module. Each
 * of them needs a company and none of them can invent one; a session with no
 * active membership renders screens with no controls, so this is the single
 * place that says "there is nothing here to act on" — and the single place a
 * test has to reach to prove it.
 */
export async function forTenant<T>(
  context: { readonly live: LiveState },
  fallback: T,
  work: (tenantId: string) => Promise<T>,
): Promise<T> {
  const tenantId = currentTenantId(context.live);
  return tenantId === null ? fallback : work(tenantId);
}

/**
 * True when the failure means "not for you" rather than "went wrong". A 404 is
 * included: the API conceals a non-membership as "not found", so from the
 * browser's side access to it has gone either way.
 */
export function isDenial(error: ApiError): boolean {
  return error.status === 403 || error.status === 404;
}

/** The session of an open workspace. Only screens drawn inside the shell ask, and the shell requires one. */
export function openSession(live: LiveState): Extract<SessionState, { readonly status: 'signed_in' }> {
  return live.session as Extract<SessionState, { readonly status: 'signed_in' }>;
}

/**
 * The rows a resource holds, or none.
 *
 * Every list view needs the same thing — the rows if they are here, an empty
 * list otherwise — and writing that as a ternary at each call site is how one
 * of them ends up reading `resource.value` while it is still loading.
 */
export function rowsOf<T>(resource: Resource<readonly T[]>): readonly T[] {
  return resource.status === 'ready' ? resource.value : [];
}
