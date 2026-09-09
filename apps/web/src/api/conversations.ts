import type { ApiClient, ApiResult } from './client.js';

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

export interface Conversation {
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
}

export interface TimelineMessage {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly at: string;
  readonly content_type: string | null;
  readonly text: string | null;
  readonly attachments: readonly unknown[];
  readonly author_membership_id: string | null;
  readonly command_state: string | null;
  readonly delivery_state: string | null;
  readonly delivery_anomaly: string | null;
  readonly provider_message_id: string | null;
}

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

export type ConversationQueue = 'mine' | 'all';

export class ConversationsApi {
  constructor(private readonly client: ApiClient) {}

  /** Conversations the caller may read. Never a card. */
  list(tenantId: string, queue: ConversationQueue): Promise<ApiResult<readonly Conversation[]>> {
    return this.client.get<readonly Conversation[]>(
      `/tenants/${tenantId}/conversations?queue=${queue}`,
    );
  }

  /** The Unassigned queue. Never a transcript. */
  unassigned(tenantId: string): Promise<ApiResult<readonly QueueCard[]>> {
    return this.client.get<readonly QueueCard[]>(`/tenants/${tenantId}/conversations/unassigned`);
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
}
