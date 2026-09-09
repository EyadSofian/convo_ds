import type { ChannelCatalogueEntry, ChannelConnection, ChannelsApi } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import type {
  Conversation,
  ConversationsApi,
  QueueCard,
  TimelineMessage,
} from '../api/conversations.js';
import type { RealtimeSubscription } from './realtime.js';
import type {
  Invitation,
  MembershipSummary,
  OwnershipTransfer,
  PeopleApi,
  Permission,
  Person,
  Role,
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
export function fromResult<T>(result: ApiResult<T>, now: number): Resource<T> {
  return result.ok ? ready(result.data, now) : failed(result.error);
}

export type SessionState =
  | { readonly status: 'unknown' }
  | { readonly status: 'signed_out'; readonly error: ApiError | null }
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
  session: SessionState;
  people: Resource<readonly Person[]>;
  roles: Resource<readonly Role[]>;
  teams: Resource<readonly Team[]>;
  invitations: Resource<readonly Invitation[]>;
  permissions: Resource<readonly Permission[]>;
  transfers: Resource<readonly OwnershipTransfer[]>;
  connections: Resource<readonly ChannelConnection[]>;
  catalogue: Resource<readonly ChannelCatalogueEntry[]>;
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
  realtime: RealtimeState;
  subscription: RealtimeSubscription | null;
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
    unassigned: IDLE,
    openConversationId: null,
    openConversation: IDLE,
    timeline: IDLE,
    timelineCursor: null,
    composer: '',
    realtime: { status: 'idle' },
    subscription: null,
    conversationsApi: conversations,
    busy: null,
    error: null,
    revision: 0,
  };
}

/** The tenant the screens are working in, or `null` when not signed in. */
export function currentTenantId(live: LiveState): string | null {
  return live.session.status === 'signed_in' ? live.session.tenantId : null;
}

/**
 * True when the failure means "you are not allowed", which the screens render
 * as a permission state rather than as an error. A 404 is included: the API
 * conceals a non-membership as "not found", so from the browser's side the two
 * are the same fact.
 */
export function isDenial(error: ApiError): boolean {
  return (
    error.code === 'permission_denied' ||
    error.code === 'resource_not_found' ||
    error.status === 403 ||
    error.status === 404
  );
}

/** True when the caller has no session, so the screen offers a sign-in. */
export function isUnauthenticated(error: ApiError): boolean {
  return error.status === 401;
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
