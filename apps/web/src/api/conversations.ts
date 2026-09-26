import type { ApiClient, ApiResult } from './client.js';
import type { EntityMetadata } from './metadata.js';
import type { InboxQuery } from '@convo/domain';
export { INBOX_QUERY_DEFAULT as DEFAULT_INBOX_QUERY } from '@convo/domain';

/**
 * The inbox operations, typed against the pinned OpenAPI.
 *
 * Two list shapes, deliberately, because they are two different things:
 *
 * - **A queue card** is what an agent sees before anybody has claimed a
 *   conversation. It carries a masked label and no message text at all, and it
 *   is built that way on the server — this file could not reassemble a
 *   transcript from one if it tried.
 * - **A conversation** is the record, and the API only returns one to a caller
 *   who may read it.
 *
 * Keeping them apart in the client mirrors keeping them apart on the wire, so
 * a screen cannot accidentally render a card where it meant a conversation and
 * quietly show more than it should.
 */

export interface QueueCard {
  readonly id: string;
  readonly inboxLabel: string;
  readonly channel: string;
  readonly maskedLabel: string;
  readonly priority: string;
  readonly status: string;
  readonly waitingSinceAt: string | null;
  readonly claimable: boolean;
  /** The version a claim must carry. An agent never reads the record to find it. */
  readonly version: number;
}

export interface Conversation extends EntityMetadata {
  readonly id: string;
  readonly connectionId: string;
  readonly peerIdentity: string;
  readonly teamId: string | null;
  readonly assigneeMembershipId: string | null;
  readonly status: string;
  readonly priority: string;
  readonly version: number;
  readonly waitingSince: string | null;
  readonly inboxLabel: string;
  readonly channel: string;
  readonly participantMembershipIds: readonly string[];
  /** Resolved from the customer's first message; null until somebody writes. */
  readonly contactId: string | null;
  readonly contactDisplayName?: string | null;
  /** Why an agent said they were waiting. Only while the status is `pending`. */
  readonly pendingReason: string | null;
  readonly snoozedUntil: string | null;
  /** The zone the wake time was chosen in. The instant alone cannot say what was meant. */
  readonly snoozeTimezone: string | null;
  readonly resolution: string | null;
  readonly resolvedAt: string | null;
  readonly lastActivityAt: string;
  /** ADR-0008's bot-versus-human dimension. Always `human_active` in this build. */
  readonly ownerState: string;
  readonly ownerVersion: number;
  readonly serviceWindow?: {
    readonly status: 'not_applicable' | 'open' | 'closed' | 'unknown';
    readonly lastCustomerInboundAt: string | null;
    readonly serviceWindowExpiresAt: string | null;
  };
  /**
   * Whether **this** caller has seen the newest activity.
   *
   * Only the list carries it. It is not a property of the conversation, and a
   * screen that cached it from a single read would end up showing one agent
   * another's unread state.
   */
  readonly unread?: boolean;
}

export interface DirectoryAgent {
  readonly membershipId: string;
  readonly label: string;
  readonly assigned: boolean;
}
export interface SupervisorAgent { readonly membershipId: string; readonly name: string; readonly email: string; readonly teams: readonly string[]; }
export interface SupervisorWorkload {
  readonly agent: SupervisorAgent;
  readonly current: { readonly assigned: number; readonly open: number; readonly pending: number; readonly snoozed: number; readonly unreplied: number; readonly urgent: number; readonly high: number };
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly byChannel: readonly { readonly channel: string; readonly count: number }[];
}

export interface Handoff {
  readonly id: string;
  readonly conversationId: string;
  readonly fromMembershipId: string;
  readonly fromLabel: string;
  readonly toMembershipId: string;
  readonly toLabel: string;
  readonly state: string;
  readonly note: string | null;
  readonly basedOnVersion: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly settledByMembershipId: string | null;
}

export interface Collaborator {
  readonly membershipId: string;
  readonly label: string;
  readonly addedAt: string;
  /** True when this person actually acted. No removal can undo that. */
  readonly participated: boolean;
}

export interface Episode {
  readonly id: string;
  readonly seq: number;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly firstInboundAt: string | null;
  readonly firstResponseAt: string | null;
  readonly closedAt: string | null;
  readonly resolution: string | null;
}

export interface Note {
  readonly id: string;
  readonly conversationId: string;
  readonly authorMembershipId: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

/**
 * The five agent-driven rows of the lifecycle table.
 *
 * A union rather than five methods, because the server has one endpoint for the
 * same reason: they are one decision, and five call sites would be five places
 * to get the version fencing subtly different.
 */
export type TransitionCommand =
  | { readonly command: 'wait'; readonly reason: string }
  | { readonly command: 'snooze'; readonly wakeAt: string; readonly timezone: string }
  | { readonly command: 'resolve'; readonly resolution: string }
  | { readonly command: 'reopen' }
  | { readonly command: 'archive' };

export interface TimelineMessage {
  readonly id: string;
  readonly direction: 'in' | 'out' | 'reaction';
  readonly at: string;
  readonly content_type: string | null;
  readonly text: string | null;
  readonly attachments: readonly unknown[];
  readonly author_membership_id: string | null;
  readonly command_state: string | null;
  readonly delivery_state: string | null;
  readonly delivery_anomaly: string | null;
  readonly provider_message_id: string | null;
  readonly template_name?: string | null;
  readonly template_language?: string | null;
  readonly template_preview?: string | null;
  readonly reaction_action?: string | null;
}

export interface WhatsAppTemplateParameterDefinition {
  readonly key: string;
  readonly component: 'header' | 'body' | 'button';
  readonly index: number | null;
  readonly position: number;
  readonly example: string | null;
}
export interface WhatsAppTemplateCatalogueItem {
  readonly id: string;
  readonly providerTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: 'approved' | 'pending' | 'paused' | 'rejected' | 'disabled';
  readonly components: readonly { readonly type: 'header' | 'body' | 'footer' | 'buttons'; readonly text: string | null; readonly format: string | null; readonly buttons: readonly { readonly type: string; readonly text: string }[] }[];
  readonly parameters: readonly WhatsAppTemplateParameterDefinition[];
  readonly sendSupported: boolean;
  readonly unsupportedReason: string | null;
  readonly lastSyncedAt: string;
}
export interface WhatsAppTemplatePage { readonly items: readonly WhatsAppTemplateCatalogueItem[]; readonly nextCursor: string | null; }

export interface TimelinePage {
  readonly messages: readonly TimelineMessage[];
  readonly nextCursor: string | null;
}

export interface OutboundMessage {
  readonly id: string;
  readonly command_state: string;
  readonly state_reason: string | null;
  readonly delivery_state: string | null;
}

export type { InboxFilter, InboxQuery, InboxSort } from '@convo/domain';

export interface ConversationPage {
  readonly items: readonly Conversation[];
  readonly nextCursor: string | null;
}


export class ConversationsApi {
  constructor(private readonly client: ApiClient) {}

  /** Conversations the caller may read. Never a card. */
  async list(tenantId: string, inboxQuery: InboxQuery): Promise<ApiResult<ConversationPage>> {
    const query = new URLSearchParams({ queue: inboxQuery.queue });
    if (inboxQuery.sort !== 'activity_desc') query.set('sort', inboxQuery.sort);
    if (inboxQuery.limit !== 50) query.set('limit', String(inboxQuery.limit));
    if (inboxQuery.cursor !== null) query.set('cursor', inboxQuery.cursor);
    if (inboxQuery.search !== null && inboxQuery.search !== '') query.set('search', inboxQuery.search);
    for (const filter of inboxQuery.filters) query.append('filter', JSON.stringify(filter));
    const page = await this.client.page<Conversation>(`/tenants/${tenantId}/conversations?${query.toString()}`);
    return page.ok ? { ok: true, data: { items: page.data.data, nextCursor: page.data.nextCursor } } : page;
  }

  supervisorAgents(tenantId: string): Promise<ApiResult<readonly SupervisorAgent[]>> {
    return this.client.get(`/tenants/${tenantId}/supervisor/agents`);
  }

  supervisorWorkload(tenantId: string, agentMembershipId: string): Promise<ApiResult<SupervisorWorkload>> {
    return this.client.get(`/tenants/${tenantId}/supervisor/workload?agent=${encodeURIComponent(agentMembershipId)}`);
  }

  async supervisorList(tenantId: string, agentMembershipId: string, inboxQuery: InboxQuery): Promise<ApiResult<ConversationPage>> {
    const query = new URLSearchParams({ agent: agentMembershipId, queue: 'all' });
    if (inboxQuery.sort !== 'activity_desc') query.set('sort', inboxQuery.sort);
    if (inboxQuery.limit !== 50) query.set('limit', String(inboxQuery.limit));
    if (inboxQuery.cursor !== null) query.set('cursor', inboxQuery.cursor);
    if (inboxQuery.search !== null && inboxQuery.search !== '') query.set('search', inboxQuery.search);
    for (const filter of inboxQuery.filters) query.append('filter', JSON.stringify(filter));
    const page = await this.client.page<Conversation>(`/tenants/${tenantId}/supervisor/conversations?${query.toString()}`);
    return page.ok ? { ok: true, data: { items: page.data.data, nextCursor: page.data.nextCursor } } : page;
  }

  /** The Unassigned queue. Never a transcript. */
  unassigned(
    tenantId: string,
    filters: { readonly priority: string; readonly channel: string; readonly labelId: string } = { priority: '', channel: '', labelId: '' },
  ): Promise<ApiResult<readonly QueueCard[]>> {
    const query = new URLSearchParams();
    if (filters.priority !== '') query.set('priority', filters.priority);
    if (filters.channel !== '') query.set('channel', filters.channel);
    if (filters.labelId !== '') query.append('label', filters.labelId);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get<readonly QueueCard[]>(`/tenants/${tenantId}/conversations/unassigned${suffix}`);
  }

  read(tenantId: string, conversationId: string): Promise<ApiResult<Conversation>> {
    return this.client.get<Conversation>(`/tenants/${tenantId}/conversations/${conversationId}`);
  }

  /**
   * One page of the timeline, and the position to continue from.
   *
   * The page envelope carries the cursor, so it is read here rather than in the
   * screen: a view that had to know how paging is encoded would be a second
   * place for that to be wrong.
   */
  async timeline(
    tenantId: string,
    conversationId: string,
    cursor: string | null,
  ): Promise<ApiResult<TimelinePage>> {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const result = await this.client.page<TimelineMessage>(
      `/tenants/${tenantId}/conversations/${conversationId}/messages${query}`,
    );
    return result.ok
      ? { ok: true, data: { messages: result.data.data, nextCursor: result.data.nextCursor } }
      : result;
  }

  async whatsappTemplates(tenantId: string, conversationId: string, query: { search?: string; language?: string; category?: string; status?: string; cursor?: string | null } = {}): Promise<ApiResult<WhatsAppTemplatePage>> {
    const params = new URLSearchParams();
    for (const key of ['search', 'language', 'category', 'status'] as const) if (query[key] !== undefined && query[key] !== '') params.set(key, query[key]!);
    if (query.cursor) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    const response = await this.client.page<WhatsAppTemplateCatalogueItem>(`/tenants/${tenantId}/conversations/${conversationId}/whatsapp-templates${suffix}`);
    return response.ok ? { ok: true, data: { items: response.data.data, nextCursor: response.data.nextCursor } } : response;
  }

  /**
   * Claims a conversation at the version the agent actually saw.
   *
   * The version comes from the card in front of them, not from a re-read: a
   * claim that re-fetched first would race the very conflict this exists to
   * report.
   */
  claim(
    tenantId: string,
    conversationId: string,
    version: number,
  ): Promise<ApiResult<Conversation>> {
    return this.client.post<Conversation>(
      `/tenants/${tenantId}/conversations/${conversationId}/claim`,
      { body: { version } },
    );
  }

  /**
   * Moves a conversation through its lifecycle, at the version the agent saw.
   *
   * The version is required for the same reason a claim's is: two agents acting
   * on the same stale screen must not both succeed.
   */
  /** Restores or removes a selection of archived conversations; each is answered on its own. */
  archived(
    tenantId: string,
    action: 'restore' | 'delete',
    conversationIds: readonly string[],
  ): Promise<ApiResult<{ readonly done: readonly string[]; readonly refused: readonly { readonly id: string; readonly code: string }[] }>> {
    return this.client.post(`/tenants/${tenantId}/conversations/archived`, { body: { action, conversationIds } });
  }

  transition(
    tenantId: string,
    conversationId: string,
    version: number,
    command: TransitionCommand,
  ): Promise<ApiResult<Conversation>> {
    return this.client.post<Conversation>(
      `/tenants/${tenantId}/conversations/${conversationId}/transitions`,
      { body: { version, ...command } },
    );
  }

  episodes(tenantId: string, conversationId: string): Promise<ApiResult<readonly Episode[]>> {
    return this.client.get<readonly Episode[]>(
      `/tenants/${tenantId}/conversations/${conversationId}/episodes`,
    );
  }

  notes(tenantId: string, conversationId: string): Promise<ApiResult<readonly Note[]>> {
    return this.client.get<readonly Note[]>(
      `/tenants/${tenantId}/conversations/${conversationId}/notes`,
    );
  }

  addNote(tenantId: string, conversationId: string, body: string): Promise<ApiResult<Note>> {
    return this.client.post<Note>(
      `/tenants/${tenantId}/conversations/${conversationId}/notes`,
      { body: { body } },
    );
  }

  editNote(tenantId: string, noteId: string, body: string): Promise<ApiResult<Note>> {
    return this.client.patch<Note>(`/tenants/${tenantId}/notes/${noteId}`, { body: { body } });
  }

  deleteNote(tenantId: string, noteId: string): Promise<ApiResult<Note>> {
    return this.client.delete<Note>(`/tenants/${tenantId}/notes/${noteId}`);
  }

  /**
   * Moves this person's read cursor. Never a receipt.
   *
   * The body is empty because the common case is "I have seen all of it", and
   * an endpoint that made the browser compute a timestamp would be a second
   * place for the cursor to be wrong.
   */
  markRead(
    tenantId: string,
    conversationId: string,
  ): Promise<ApiResult<{ readonly readThrough: string }>> {
    return this.client.post<{ readonly readThrough: string }>(
      `/tenants/${tenantId}/conversations/${conversationId}/read`,
      { body: {} },
    );
  }

  markUnread(tenantId: string, conversationId: string): Promise<ApiResult<{ readonly unread: true }>> {
    return this.client.post(`/tenants/${tenantId}/conversations/${conversationId}/unread`);
  }

  releaseOwn(tenantId: string, conversationId: string, version: number): Promise<ApiResult<Conversation>> {
    return this.client.post(`/tenants/${tenantId}/conversations/${conversationId}/release`, { body: { version } });
  }

  /* -------------------------------------------------------------- routing -- */

  /**
   * The people who could actually take this conversation.
   *
   * Deliberately not the People screen's endpoint: that needs `member.manage`
   * and carries roles, scopes and login emails, none of which belongs in an
   * assignee picker.
   */
  assignableAgents(
    tenantId: string,
    conversationId: string,
  ): Promise<ApiResult<readonly DirectoryAgent[]>> {
    return this.client.get<readonly DirectoryAgent[]>(
      `/tenants/${tenantId}/directory/agents?conversation_id=${encodeURIComponent(conversationId)}`,
    );
  }

  /** `null` takes it off every desk, which is an operation and not a gap. */
  assign(
    tenantId: string,
    conversationId: string,
    version: number,
    assigneeMembershipId: string | null,
  ): Promise<ApiResult<Conversation>> {
    return this.client.post<Conversation>(
      `/tenants/${tenantId}/conversations/${conversationId}/assignments`,
      { body: { version, assigneeMembershipId } },
    );
  }

  handoffs(tenantId: string, conversationId: string): Promise<ApiResult<readonly Handoff[]>> {
    return this.client.get<readonly Handoff[]>(
      `/tenants/${tenantId}/conversations/${conversationId}/handoffs`,
    );
  }

  requestHandoff(
    tenantId: string,
    conversationId: string,
    input: {
      readonly version: number;
      readonly toMembershipId: string;
      readonly note: string | null;
    },
  ): Promise<ApiResult<Handoff>> {
    return this.client.post<Handoff>(
      `/tenants/${tenantId}/conversations/${conversationId}/handoffs`,
      { body: input },
    );
  }

  settleHandoff(
    tenantId: string,
    handoffId: string,
    action: 'accept' | 'decline' | 'cancel',
  ): Promise<ApiResult<Handoff>> {
    return this.client.post<Handoff>(`/tenants/${tenantId}/handoffs/${handoffId}/${action}`, {
      body: {},
    });
  }

  setPriority(
    tenantId: string,
    conversationId: string,
    version: number,
    priority: string,
  ): Promise<ApiResult<Conversation>> {
    return this.client.patch<Conversation>(
      `/tenants/${tenantId}/conversations/${conversationId}/priority`,
      { body: { version, priority } },
    );
  }

  collaborators(
    tenantId: string,
    conversationId: string,
  ): Promise<ApiResult<readonly Collaborator[]>> {
    return this.client.get<readonly Collaborator[]>(
      `/tenants/${tenantId}/conversations/${conversationId}/collaborators`,
    );
  }

  addCollaborator(
    tenantId: string,
    conversationId: string,
    version: number,
    membershipId: string,
  ): Promise<ApiResult<readonly Collaborator[]>> {
    return this.client.post<readonly Collaborator[]>(
      `/tenants/${tenantId}/conversations/${conversationId}/collaborators`,
      { body: { version, membershipId } },
    );
  }

  removeCollaborator(
    tenantId: string,
    conversationId: string,
    version: number,
    membershipId: string,
  ): Promise<ApiResult<readonly Collaborator[]>> {
    return this.client.delete<readonly Collaborator[]>(
      `/tenants/${tenantId}/conversations/${conversationId}/collaborators/${membershipId}?version=${String(version)}`,
    );
  }

  /** Replies inside a conversation. The recipient comes from the record. */
  reply(
    tenantId: string,
    conversationId: string,
    input: { readonly text: string; readonly clientMessageId: string },
  ): Promise<ApiResult<OutboundMessage>> {
    return this.client.post<OutboundMessage>(
      `/tenants/${tenantId}/conversations/${conversationId}/messages`,
      { body: { messageType: 'text', text: input.text, clientMessageId: input.clientMessageId } },
    );
  }

  replyTemplate(tenantId: string, conversationId: string, input: { templateId: string; parameters: Readonly<Record<string, string>>; clientMessageId: string }): Promise<ApiResult<OutboundMessage>> {
    return this.client.post<OutboundMessage>(`/tenants/${tenantId}/conversations/${conversationId}/messages`, {
      body: { messageType: 'template', text: '', template: { id: input.templateId, parameters: input.parameters }, clientMessageId: input.clientMessageId },
    });
  }
}
