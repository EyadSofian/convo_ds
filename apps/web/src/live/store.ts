import type { ApiError, ApiResult } from '../api/client.js';
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
 * Server-backed state for the People, Roles and Teams screens.
 *
 * Everything here describes what the *server* said, and when. The demo dataset
 * in `data.ts` still backs the inbox until its API exists; nothing in this file
 * reads it, and nothing in it is invented locally.
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
  session: SessionState;
  people: Resource<readonly Person[]>;
  roles: Resource<readonly Role[]>;
  teams: Resource<readonly Team[]>;
  invitations: Resource<readonly Invitation[]>;
  permissions: Resource<readonly Permission[]>;
  transfers: Resource<readonly OwnershipTransfer[]>;
  busy: string | null;
  error: ApiError | null;
  /** Incremented on every settled mutation, so a view can key off freshness. */
  revision: number;
}

export function createLiveState(api: PeopleApi): LiveState {
  return {
    api,
    session: { status: 'unknown' },
    people: IDLE,
    roles: IDLE,
    teams: IDLE,
    invitations: IDLE,
    permissions: IDLE,
    transfers: IDLE,
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
