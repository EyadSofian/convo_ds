import { ChannelsApi } from './channels.js';
import { ContactsApi } from './contacts.js';
import { ConversationsApi } from './conversations.js';
import { MetadataApi } from './metadata.js';
import { SavedViewsApi } from './saved-views.js';
import type { ApiResult } from './client.js';
import { ApiClient, API_BASE_URL } from './client.js';

/**
 * The People, Roles and Teams operations, typed against the pinned OpenAPI.
 *
 * Every function is a thin, named mapping from an intent to one documented
 * endpoint. Screens call these; nothing in the UI builds a URL.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

export interface CurrentSession {
  readonly user: SessionUser;
}

/** One of this user's sessions. `current` is the one making the request. */
export interface SessionSummary {
  readonly id: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
  readonly current: boolean;
}

export interface MembershipSummary {
  readonly id: string;
  readonly tenant: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly permissions: readonly string[];
}

export interface ScopeRef {
  readonly type: string;
  readonly id: string | null;
}

export interface Person {
  readonly membership_id: string;
  readonly email: string;
  readonly status: string;
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly scopes: readonly ScopeRef[];
}

export interface RoleGrant {
  readonly permission_key: string;
  readonly scope_level: 'tenant' | 'scoped' | 'own';
}

export interface Role {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly is_builtin: boolean;
  /** Author's description; empty for built-in roles. */
  readonly description: string;
  readonly updated_at: string;
  readonly grants: readonly RoleGrant[];
}

export interface TeamMember {
  readonly membership_id: string;
  readonly email: string;
}

export interface Team {
  readonly id: string;
  readonly name: string;
  readonly member_count: number;
  readonly archived: boolean;
  readonly members: readonly TeamMember[];
}

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly status: 'pending' | 'accepted' | 'revoked';
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly created_at: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly revoked_at: string | null;
  readonly scopes: readonly ScopeRef[];
}

export interface OwnershipTransfer {
  readonly id: string;
  readonly status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  readonly from_membership: string;
  readonly to_membership: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly settled_at: string | null;
}

export interface Permission {
  readonly key: string;
  readonly description: string;
  readonly delegable: boolean;
}

export class PeopleApi {
  constructor(private readonly client: ApiClient) {}

  session(): Promise<ApiResult<CurrentSession>> {
    return this.client.get<CurrentSession>('/auth/session');
  }

  login(email: string, password: string): Promise<ApiResult<CurrentSession>> {
    return this.client.post<CurrentSession>('/auth/login', { body: { email, password } });
  }

  requestRecovery(email: string): Promise<ApiResult<{ readonly status: string; readonly message: string }>> {
    return this.client.post('/auth/recovery', { body: { email } });
  }

  completeRecovery(token: string, password: string): Promise<ApiResult<undefined>> {
    return this.client.post<undefined>('/auth/recovery/complete', { body: { token, password } });
  }

  acceptInvitation(token: string, password: string): Promise<ApiResult<{ readonly tenant_id: string; readonly membership_id: string }>> {
    return this.client.post(`/invitations/${encodeURIComponent(token)}/accept`, { body: { password } });
  }

  logout(): Promise<ApiResult<undefined>> {
    return this.client.post<undefined>('/auth/logout');
  }

  sessions(): Promise<ApiResult<readonly SessionSummary[]>> {
    return this.client.get<readonly SessionSummary[]>('/auth/sessions');
  }

  revokeSession(id: string): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/auth/sessions/${id}`);
  }

  changePassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<ApiResult<undefined>> {
    return this.client.post<undefined>('/auth/password/change', {
      body: { currentPassword, newPassword, confirmPassword },
    });
  }

  memberships(): Promise<ApiResult<readonly MembershipSummary[]>> {
    return this.client.get<readonly MembershipSummary[]>('/me/memberships');
  }

  people(tenantId: string): Promise<ApiResult<readonly Person[]>> {
    return this.client.get<readonly Person[]>(`/tenants/${tenantId}/people`);
  }

  roles(tenantId: string): Promise<ApiResult<readonly Role[]>> {
    return this.client.get<readonly Role[]>(`/tenants/${tenantId}/roles`);
  }

  teams(tenantId: string): Promise<ApiResult<readonly Team[]>> {
    return this.client.get<readonly Team[]>(`/tenants/${tenantId}/teams`);
  }

  invitations(tenantId: string): Promise<ApiResult<readonly Invitation[]>> {
    return this.client.get<readonly Invitation[]>(`/tenants/${tenantId}/invitations`);
  }

  permissions(tenantId: string): Promise<ApiResult<readonly Permission[]>> {
    return this.client.get<readonly Permission[]>(`/tenants/${tenantId}/permissions`);
  }

  ownershipTransfers(tenantId: string): Promise<ApiResult<readonly OwnershipTransfer[]>> {
    return this.client.get<readonly OwnershipTransfer[]>(`/tenants/${tenantId}/ownership-transfers`);
  }

  /**
   * Creating an invitation mints a credential, so the caller supplies a stable
   * idempotency key: a retry must replay the first answer rather than issue a
   * second live token.
   */
  invite(
    tenantId: string,
    body: { email: string; roleId: string; scopes: readonly ScopeRef[] },
    idempotencyKey: string,
  ): Promise<ApiResult<Invitation>> {
    return this.client.post<Invitation>(`/tenants/${tenantId}/invitations`, {
      body,
      idempotencyKey,
    });
  }

  revokeInvitation(tenantId: string, invitationId: string): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/invitations/${invitationId}`);
  }

  updateMembership(
    tenantId: string,
    membershipId: string,
    body: { roleId?: string; status?: string; scopes?: readonly ScopeRef[] },
  ): Promise<ApiResult<Person>> {
    return this.client.patch<Person>(`/tenants/${tenantId}/people/${membershipId}`, { body });
  }

  createRole(
    tenantId: string,
    body: { name: string; description: string; grants: readonly { permission: string; scope: string }[] },
  ): Promise<ApiResult<Role>> {
    return this.client.post<Role>(`/tenants/${tenantId}/roles`, { body });
  }

  updateRole(
    tenantId: string,
    roleId: string,
    body: { name: string; description: string; grants: readonly { permission: string; scope: string }[] },
  ): Promise<ApiResult<Role>> {
    return this.client.patch<Role>(`/tenants/${tenantId}/roles/${roleId}`, { body });
  }

  deleteRole(tenantId: string, roleId: string): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/roles/${roleId}`);
  }

  createTeam(tenantId: string, name: string): Promise<ApiResult<Team>> {
    return this.client.post<Team>(`/tenants/${tenantId}/teams`, { body: { name } });
  }

  /** Partial: send only what is changing. An empty patch is rejected. */
  updateTeam(
    tenantId: string,
    teamId: string,
    changes: { readonly name?: string; readonly archived?: boolean },
  ): Promise<ApiResult<Team>> {
    return this.client.patch<Team>(`/tenants/${tenantId}/teams/${teamId}`, { body: changes });
  }

  addTeamMember(tenantId: string, teamId: string, membershipId: string): Promise<ApiResult<Team>> {
    return this.client.post<Team>(`/tenants/${tenantId}/teams/${teamId}/members`, {
      body: { membershipId },
    });
  }

  removeTeamMember(
    tenantId: string,
    teamId: string,
    membershipId: string,
  ): Promise<ApiResult<Team>> {
    return this.client.delete<Team>(
      `/tenants/${tenantId}/teams/${teamId}/members/${membershipId}`,
    );
  }

  offerOwnership(tenantId: string, membershipId: string): Promise<ApiResult<OwnershipTransfer>> {
    return this.client.post<OwnershipTransfer>(`/tenants/${tenantId}/ownership-transfers`, {
      body: { membershipId },
    });
  }

  acceptOwnership(tenantId: string, transferId: string): Promise<ApiResult<OwnershipTransfer>> {
    return this.client.post<OwnershipTransfer>(
      `/tenants/${tenantId}/ownership-transfers/${transferId}/accept`,
    );
  }

  declineOwnership(tenantId: string, transferId: string): Promise<ApiResult<OwnershipTransfer>> {
    return this.client.post<OwnershipTransfer>(
      `/tenants/${tenantId}/ownership-transfers/${transferId}/decline`,
    );
  }

  cancelOwnership(tenantId: string, transferId: string): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/ownership-transfers/${transferId}`);
  }
}

/**
 * A `PeopleApi` with no transport: every call fails as a network error.
 *
 * This is what the workspace gets when no `fetch` is injected — a page served
 * with no API behind it. It exists as a named thing rather than an inline
 * fallback so the demo screens' unit tests, which never reach the server, get
 * exactly the same object the browser would, instead of a stub that quietly
 * behaves better than production.
 */
export function disconnectedApi(): PeopleApi {
  return new PeopleApi(deadClient());
}

/** The same, for the channel operations. */
export function disconnectedChannelsApi(): ChannelsApi {
  return new ChannelsApi(deadClient());
}

/** The same, for the inbox. */
export function disconnectedConversationsApi(): ConversationsApi {
  return new ConversationsApi(deadClient());
}

/** The same, for contacts. */
export function disconnectedContactsApi(): ContactsApi {
  return new ContactsApi(deadClient());
}

/** The same, for labels and typed fields. */
export function disconnectedMetadataApi(): MetadataApi {
  return new MetadataApi(deadClient());
}

/** The same, for durable saved conversation views. */
export function disconnectedSavedViewsApi(): SavedViewsApi {
  return new SavedViewsApi(deadClient());
}

function deadClient(): ApiClient {
  return new ApiClient({
    baseUrl: API_BASE_URL,
    fetch: () => Promise.reject(new Error('No HTTP transport is configured.')),
    readCsrfToken: () => null,
  });
}
