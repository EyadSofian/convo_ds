import type { ChannelKind, ConnectionCheck, SendCommand, SendOutcome } from '@convo/domain';
import { META_HISTORY_MESSAGE_FIELDS, PINNED_GRAPH_VERSION } from '@convo/domain';
import { ProfileLookupError } from './channel-transport.js';
import type { ChannelTransportPort, InboundMediaResult, MetaPageSync, ProviderMutationResult, ProviderTemplate, TemplateFetchResult } from './channel-transport.js';

/**
 * The WhatsApp Cloud API transport.
 *
 * This is the file that turns "the product can model a message" into "the
 * product can send one". Everything above it — the permit, the outbox, the
 * lease, the attempt ledger — already existed and was already correct; what did
 * not exist was anything on the other end of `ChannelTransportPort.send`.
 *
 * ## The classification is the entire job
 *
 * `ChannelDispatcherService` acts on three outcomes and the difference between
 * them decides whether a real customer receives a message twice, once, or never:
 *
 * - `accepted` — Meta holds the message and gave us an id. The id is what every
 *   later delivery receipt is folded onto, so a send we cannot evidence is not
 *   an accept.
 * - `definitely_rejected` — Meta answered, and the answer was no. `retryable`
 *   then separates "no, because of something an operator can fix" (an expired
 *   token: the message is still worth sending afterwards) from "no, and it will
 *   always be no" (outside the 24-hour window with no template: retrying can
 *   only produce the same refusal forever).
 * - `outcome_unknown` — the request left this process and nothing came back.
 *   The message may be on a customer's phone. Nothing automatic ever retries
 *   this, by design (ADR-0006), which is why it must never be returned for a
 *   failure we can actually attribute.
 *
 * Getting `outcome_unknown` wrong in the generous direction strands messages
 * that plainly failed; getting it wrong in the other direction sends a school's
 * parents the same message twice. Both are visible to customers, so every
 * branch below says which one it is defending against.
 *
 * ## What this adapter deliberately does not do
 *
 * It does not retry. The outbox owns retry, with a lease, a bounded attempt
 * count and exponential backoff, and a second retry loop inside the transport
 * would multiply against it invisibly.
 *
 * It handles the three Meta Graph channels, but never by treating them as the
 * same protocol.  WhatsApp uses a phone-number-id endpoint and a `to` field;
 * Messenger and Instagram use an asset-scoped conversations endpoint and a
 * recipient object.  Their policies are still enforced above this transport
 * from their own capability matrices.  Keeping the wire shapes here makes a
 * future channel unable to accidentally inherit WhatsApp's contract.
 */

/** Meta is given this long to answer before the attempt is abandoned. */
export const META_TIMEOUT_MS = 15_000;

export interface MetaWhatsAppOptions {
  /** Overridden only by tests. Production pins the Graph version (ADR-0009). */
  readonly graphBase?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface GraphError {
  readonly message?: unknown;
  readonly type?: unknown;
  readonly code?: unknown;
  readonly error_subcode?: unknown;
  readonly fbtrace_id?: unknown;
}

interface ProfileBody {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly username?: unknown;
  readonly first_name?: unknown;
  readonly last_name?: unknown;
  readonly error?: GraphError;
}

/**
 * Profile outcomes the conversation participants can still answer. A rejected
 * token, a rate limit or an unavailable Graph would fail the same way there.
 */
const PARTICIPANT_FALLBACK: ReadonlySet<string> = new Set([
  'profile_withheld', 'profile_permission_denied', 'profile_invalid_request', 'profile_unavailable',
]);

function profileFailureCode(status: number, error: GraphError | undefined): string {
  if (status === 429 || error?.code === 4 || error?.code === 80007) return 'profile_rate_limited';
  if (status === 401 || error?.code === 190) return 'profile_credential_rejected';
  if (status === 403 || error?.code === 10 || error?.code === 200) return 'profile_permission_denied';
  if (status >= 500) return 'profile_provider_unavailable';
  if (error?.code === 100) return 'profile_invalid_request';
  return 'profile_unavailable';
}

/** Every event this product reads for a Page, whichever channel asked. */
const META_PAGE_FIELDS = [
  'messages', 'message_echoes', 'message_deliveries', 'message_reads', 'message_reactions',
  'messaging_postbacks', 'messaging_handovers', 'standby',
] as const;

/** The most any Meta channel lets a customer send: a WhatsApp document is 100 MB. */
const MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;
const MEDIA_NOT_AVAILABLE = { ok: false, code: 'media_not_available', message: 'This attachment is no longer available from Meta.', retryable: false } as const;
const MEDIA_TOO_LARGE = { ok: false, code: 'media_too_large', message: 'This attachment is too large to open here.', retryable: false } as const;

/** Only HTTPS on Meta's own media hosts, with nothing hidden in the authority. */
function isMetaMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === ''
      && ['.fbcdn.net', '.fbsbx.com', '.cdninstagram.com', '.whatsapp.net'].some((host) => url.hostname.endsWith(host));
  } catch {
    return false;
  }
}

const META_HISTORY_CONVERSATIONS = 100;
const META_HISTORY_READ_BUDGET_MS = 40_000;
const META_HISTORY_TIMEOUT = {
  ok: false, code: 'provider_timeout', message: 'Meta took too long to return the message history.', retryable: true,
} as const;

export class MetaWhatsAppTransport implements ChannelTransportPort {
  readonly name = 'meta-whatsapp-cloud';

  private readonly graphBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MetaWhatsAppOptions = {}) {
    this.graphBase = options.graphBase ?? `https://graph.facebook.com/${PINNED_GRAPH_VERSION}`;
    this.timeoutMs = options.timeoutMs ?? META_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Page-scoped Meta identities need a Page credential; webhook IDs are not names.
   *
   * `pageId` is the Page the conversation runs through: the connection's own
   * asset for Messenger, the linked Page for Instagram. It enables the
   * participants fallback below and is never required for the profile lookup.
   */
  async fetchPeerProfile(kind: ChannelKind, credential: string, peerIdentity: string, pageId?: string | null): Promise<string | null> {
    if (kind !== 'messenger' && kind !== 'instagram') return null;
    if (!/^[0-9]{1,32}$/.test(peerIdentity)) return null;
    // A single unsupported field makes Graph reject the whole profile lookup.
    // Messenger's Page-scoped profile uses first/last name; Instagram may also
    // offer a display name, but its username alone is a safe fallback.
    const request = async (fields: string): Promise<{ response: Response; body: ProfileBody | null }> => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.graphBase}/${peerIdentity}?fields=${fields}`, {
          method: 'GET', headers: { authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new ProfileLookupError('profile_provider_unavailable');
      }
      return { response, body: await readJson(response) as ProfileBody | null };
    };
    let result = await request(kind === 'messenger' ? 'id,first_name,last_name' : 'id,name,username');
    if (kind === 'instagram' && !result.response.ok && result.body?.error?.code === 100) {
      result = await request('id,username');
    }
    let failure: string;
    if (result.response.ok) {
      const body = result.body;
      // Another id is another person. That answer is wrong, not withheld, so
      // nothing below is asked to guess who this sender might be instead.
      if (body?.id !== undefined && body.id !== peerIdentity) return null;
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const first = typeof body?.first_name === 'string' ? body.first_name.trim() : '';
      const last = typeof body?.last_name === 'string' ? body.last_name.trim() : '';
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const candidate = name || [first, last].filter(Boolean).join(' ') || username;
      if (candidate.length > 0) return candidate.length <= 200 ? candidate : null;
      // Without Advanced Access to "Business Asset User Profile Access", Graph
      // answers 200 with an empty profile rather than an error. That used to
      // look like a transient miss and was retried until it gave up for good.
      failure = 'profile_withheld';
    } else {
      failure = profileFailureCode(result.response.status, result.body?.error);
    }
    if (PARTICIPANT_FALLBACK.has(failure)) {
      const participant = await this.fetchParticipantName(kind, credential, peerIdentity, pageId);
      if (participant !== null) return participant;
    }
    throw new ProfileLookupError(failure);
  }

  /**
   * The sender's name as a participant of the Page's conversation with them.
   *
   * It needs only what a connected Page already has to receive and answer
   * messages (`pages_messaging`, `pages_manage_metadata`), not the separate
   * profile feature, so it still names senders when the profile lookup cannot.
   * Any failure here is a miss: the profile lookup's reason is the one reported.
   */
  private async fetchParticipantName(
    kind: 'messenger' | 'instagram', credential: string, peerIdentity: string, pageId: string | null | undefined,
  ): Promise<string | null> {
    if (pageId === null || pageId === undefined || !/^[0-9]{1,32}$/.test(pageId)) return null;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.graphBase}/${pageId}/conversations?platform=${kind}&user_id=${peerIdentity}&fields=participants`,
        { method: 'GET', headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const conversations = record(await readJson(response))?.['data'];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      const participants = record(record(conversation)?.['participants'])?.['data'];
      for (const participant of Array.isArray(participants) ? participants : []) {
        const entry = record(participant);
        if (entry?.['id'] !== peerIdentity) continue;
        // Graph names Page-messaging participants and gives Instagram ones a username.
        const value = kind === 'instagram' ? entry['username'] : entry['name'];
        const candidate = typeof value === 'string' ? value.trim() : '';
        return candidate.length > 0 && candidate.length <= 200 ? candidate : null;
      }
    }
    return null;
  }

  /**
   * Reads the phone number back from Graph.
   *
   * A connection test that only checks the token would pass for a token that is
   * valid but has no access to *this* number, which is the most common way a
   * connection is configured wrongly. Reading the asset proves both.
   */
  async validateConnection(
    kind: ChannelKind,
    credential: string,
    assetIdentity: string,
    facebookPageId?: string | null,
  ): Promise<ConnectionCheck> {
    if (!isMetaGraphKind(kind)) return unsupportedConnection(kind);
    if (kind === 'instagram' && !facebookPageId) return {
      ok: false, assetIdentity: null, code: 'instagram_page_required',
      message: 'Configure the Facebook Page linked to this Instagram account.',
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        kind === 'instagram'
          ? `${this.graphBase}/me?fields=id,instagram_business_account{id}`
          : kind === 'messenger'
            // Reading /{page-id} also succeeds with some User tokens. /me
            // proves that this credential itself is scoped to the Page.
            ? `${this.graphBase}/me?fields=id`
            : `${this.graphBase}/${encodeURIComponent(assetIdentity)}?fields=id,display_phone_number,verified_name`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      return {
        ok: false,
        assetIdentity: null,
        code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable',
        message: 'The Meta Graph API could not be reached.',
      };
    }

    const body = (await readJson(response)) as { id?: unknown; instagram_business_account?: { id?: unknown }; error?: GraphError } | null;
    if (!response.ok) {
      const failure = classify(response.status, body?.error);
      return {
        ok: false,
        assetIdentity: null,
        code: failure.code,
        message: failure.message,
      };
    }
    const id = typeof body?.id === 'string' ? body.id : null;
    if (kind === 'instagram' && (id !== facebookPageId || body?.instagram_business_account?.id !== assetIdentity)) {
      return { ok: false, assetIdentity: id, code: 'asset_mismatch', message: 'The Page token does not belong to the Page linked to this Instagram account.' };
    }
    if (kind !== 'instagram' && id !== assetIdentity) {
      // A token that reads *a* number but not *this* one. Reporting ok here
      // would let a connection go live pointed at somebody else's asset.
      return {
        ok: false,
        assetIdentity: id,
        code: 'asset_mismatch',
        message: 'The token does not grant access to the configured provider asset.',
      };
    }
    return { ok: true, assetIdentity, code: null, message: null };
  }

  async send(kind: ChannelKind, credential: string, command: SendCommand): Promise<SendOutcome> {
    if (!isMetaGraphKind(kind)) return unsupportedSend(kind);
    if (kind === 'instagram' && !command.facebookPageId) return {
      status: 'definitely_rejected', code: 'instagram_page_required',
      message: 'The linked Facebook Page is not configured.', retryable: true,
    };

    let mediaId: string | undefined;
    if (command.media !== undefined) {
      const media = command.media;
      const upload = new FormData();
      const isWhatsApp = kind === 'whatsapp';
      const asset = kind === 'instagram' ? command.facebookPageId! : command.assetIdentity;
      const file = new Blob([new Uint8Array(media.data)], { type: media.mimeType });
      if (isWhatsApp) {
        upload.set('messaging_product', 'whatsapp');
        upload.set('type', media.mimeType.split(';')[0]!);
        upload.set('file', file, media.filename);
      } else {
        if (kind === 'instagram') upload.set('platform', 'instagram');
        upload.set('message', JSON.stringify({
          attachment: { type: command.messageType, payload: { is_reusable: true } },
        }));
        upload.set('filedata', file, media.filename);
      }
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.graphBase}/${encodeURIComponent(asset)}/${isWhatsApp ? 'media' : 'message_attachments'}`, {
          method: 'POST', headers: { authorization: `Bearer ${credential}` }, body: upload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        return { status: 'definitely_rejected', code: 'media_upload_unreachable', message: 'The attachment could not be uploaded to Meta.', retryable: true };
      }
      const body = record(await readJson(response));
      if (!response.ok) return { status: 'definitely_rejected', ...classify(response.status, body?.['error'] as GraphError | undefined) };
      const id = body?.[isWhatsApp ? 'id' : 'attachment_id'];
      if (typeof id !== 'string' || !/^\d+$/.test(id)) {
        return { status: 'definitely_rejected', code: 'media_upload_invalid', message: 'Meta did not return an attachment ID.', retryable: true };
      }
      mediaId = id;
    }
    const payload = this.payloadFor(kind, command, mediaId);
    if (payload === null) {
      return {
        status: 'definitely_rejected',
        code: 'unsupported_message_type',
        message: `This transport cannot send "${command.messageType}" yet.`,
        retryable: false,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.graphBase}/${encodeURIComponent(kind === 'instagram' ? command.facebookPageId! : command.assetIdentity)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      // The request left and nothing came back. Meta may well have it. This is
      // the case `outcome_unknown` exists for, and the one place returning it
      // is correct — the message leaves the outbox and waits for a human.
      return {
        status: 'outcome_unknown',
        code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable',
        message: isTimeout(error)
          ? `The Meta Graph API did not answer within ${String(this.timeoutMs)}ms.`
          : 'The Meta Graph API could not be reached.',
      };
    }

    const body = (await readJson(response)) as
      | { messages?: unknown; error?: GraphError }
      | null;

    if (response.ok) {
      const id = firstMessageId(body);
      if (id === null) {
        // A 200 with no message id. We cannot evidence it and we cannot fold a
        // receipt onto it, so it is not an accept — but Meta may still have
        // sent it, so it is not a rejection either.
        return {
          status: 'outcome_unknown',
          code: 'provider_response_unusable',
          message: 'The provider accepted the request but returned no message id.',
        };
      }
      return { status: 'accepted', providerMessageId: id, raw: body };
    }

    const failure = classify(response.status, body?.error);
    return {
      status: 'definitely_rejected',
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    };
  }

  /** Templates belong to a WABA, not a phone. The WABA ID is supplied at setup. */
  async fetchTemplates(kind: ChannelKind, credential: string, wabaId: string): Promise<TemplateFetchResult> {
    if (kind !== 'whatsapp') return { ok: false, code: 'channel_not_supported', message: 'Templates are available for WhatsApp only.', retryable: false };
    if (!/^[0-9]{1,32}$/.test(wabaId)) return { ok: false, code: 'waba_not_configured', message: 'Enter the WhatsApp Business Account ID for this number before syncing templates.', retryable: false };
    const templates: ProviderTemplate[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const suffix = after === null ? '' : `&after=${encodeURIComponent(after)}`;
      const result = await this.graphGet(`${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,category,status,components&limit=100${suffix}`, credential);
      if (!result.ok) return result;
      const body = record(result.body);
      const data = body?.['data'];
      if (!Array.isArray(data)) return { ok: false, code: 'provider_response_unusable', message: 'Meta returned an invalid template catalogue.', retryable: true };
      templates.push(...data.flatMap(normalizeTemplate));
      const next = record(record(body?.['paging'])?.['cursors'])?.['after'];
      if (typeof next !== 'string' || next === '') return { ok: true, templates };
      after = next;
    }
    return { ok: false, code: 'provider_pagination_limit', message: 'Meta returned more than 2000 templates; synchronization stopped safely.', retryable: true };
  }

  /** A successful Graph response is the evidence of subscription, not a saved form. */
  async subscribeWhatsAppWaba(credential: string, wabaId: string): Promise<ProviderMutationResult> {
    if (!/^[0-9]{1,32}$/.test(wabaId)) {
      return { ok: false, code: 'waba_not_configured', message: 'Configure the WhatsApp Business Account ID first.', retryable: false };
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.graphBase}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable', message: 'The WhatsApp Cloud API could not be reached.', retryable: true };
    }
    const body = await readJson(response);
    if (!response.ok) {
      const failure = classify(response.status, record(body)?.['error'] as GraphError | undefined);
      return { ok: false, ...failure };
    }
    if (record(body)?.['success'] !== true && record(body)?.['success'] !== 'true') {
      return { ok: false, code: 'provider_response_unusable', message: 'Meta did not confirm the WABA subscription.', retryable: true };
    }
    return { ok: true };
  }

  /**
   * Two things a Page needs and that nothing else here does.
   *
   * The dashboard's webhook fields say what this app may hear about; only this
   * call tells Meta to send it for this Page. It replaces this app's own field
   * list and never touches another app's, and Messenger and Instagram can share
   * one Page, so both ask for the same full list.
   *
   * The read is independent: a token without `pages_manage_metadata` can often
   * still read, and that answer is worth having with the refusal beside it.
   */
  async syncMetaPage(kind: ChannelKind, credential: string, pageId: string, since: Date): Promise<MetaPageSync> {
    if (!/^[0-9]{1,32}$/.test(pageId)) {
      return { ok: false, code: 'page_not_configured', message: 'Configure the Facebook Page ID first.', retryable: false };
    }
    const subscription = await this.subscribePage(credential, pageId);
    const deadline = Date.now() + META_HISTORY_READ_BUDGET_MS;
    const read = (path: string) => {
      const remaining = deadline - Date.now();
      return remaining <= 0
        ? Promise.resolve(META_HISTORY_TIMEOUT)
        : this.graphGet(path, credential, Math.min(this.timeoutMs, remaining));
    };
    const threadFields = `messages.limit(20){${META_HISTORY_MESSAGE_FIELDS}}`;
    // Instagram times out when its conversation list carries the messages, even
    // five at a time, and a retry starts from the same newest page and stops in
    // the same place. So for Instagram the list is read bare, which is quick,
    // and each thread's messages are a small read of their own: one slow
    // thread then costs that thread, not every conversation after it.
    const perThread = kind === 'instagram';
    const listFields = encodeURIComponent(perThread ? 'id,updated_time' : `updated_time,${threadFields}`);
    const pageSize = 25;
    const messages: unknown[] = [];
    let conversations = 0;
    let after: string | null = null;
    let historyIncomplete = false;
    for (let page = 0; page < META_HISTORY_CONVERSATIONS / pageSize; page += 1) {
      const cursor: string = after === null ? '' : `&after=${encodeURIComponent(after)}`;
      const answer = await read(`${pageId}/conversations?platform=${kind}&limit=${String(pageSize)}&fields=${listFields}${cursor}`);
      if (!answer.ok) {
        if (conversations === 0) return answer.code === 'provider_timeout' ? META_HISTORY_TIMEOUT : answer;
        historyIncomplete = true;
        break;
      }
      const body = record(answer.body);
      const rows: readonly unknown[] = Array.isArray(body?.['data']) ? body['data'] as unknown[] : [];
      // Graph lists the most recently active first, so the first old one ends it.
      const recent = rows.flatMap((row) => {
        const conversation = record(row);
        return conversation !== null && Date.parse(String(conversation['updated_time'])) >= since.getTime() ? [conversation] : [];
      });
      conversations += recent.length;
      for (const listed of recent) {
        let conversation: Record<string, unknown> | null = listed;
        if (perThread) {
          const thread = await read(`${encodeURIComponent(String(listed['id']))}?fields=${encodeURIComponent(threadFields)}`);
          // A thread Meta would not return is skipped, and the sync says it is
          // partial; the threads around it are still worth having.
          if (!thread.ok) historyIncomplete = true;
          conversation = thread.ok ? record(thread.body) : null;
        }
        const data = record(conversation?.['messages'])?.['data'];
        messages.push(...(Array.isArray(data) ? data as unknown[] : []));
      }
      const paging = record(body?.['paging']);
      const next = record(paging?.['cursors'])?.['after'];
      if (recent.length < rows.length || paging?.['next'] === undefined || typeof next !== 'string') break;
      after = next;
    }
    return {
      ok: true, subscriptionError: subscription.ok ? null : subscription.message, conversations, messages,
      ...(historyIncomplete ? { historyIncomplete: true } : {}),
    };
  }

  /**
   * WhatsApp holds media behind an id that resolves to a link needing the token.
   * Messenger and Instagram hand over a signed link directly, and that link came
   * from a webhook, so it is only ever followed to Meta's own hosts.
   */
  async fetchInboundMedia(kind: ChannelKind, credential: string, providerId: string): Promise<InboundMediaResult> {
    if (kind === 'whatsapp') {
      if (!/^[0-9]{1,32}$/.test(providerId)) return MEDIA_NOT_AVAILABLE;
      const located = await this.graphGet(providerId, credential);
      if (!located.ok) return { ok: false, code: located.code, message: located.message, retryable: located.retryable };
      const url = record(located.body)?.['url'];
      return typeof url === 'string' ? this.downloadMedia(url, { authorization: `Bearer ${credential}` }) : MEDIA_NOT_AVAILABLE;
    }
    return kind === 'messenger' || kind === 'instagram' ? this.downloadMedia(providerId, {}) : MEDIA_NOT_AVAILABLE;
  }

  private async downloadMedia(url: string, headers: Readonly<Record<string, string>>): Promise<InboundMediaResult> {
    if (!isMetaMediaUrl(url)) return MEDIA_NOT_AVAILABLE;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      return { ok: false, code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable', message: 'The media could not be fetched from Meta.', retryable: true };
    }
    // Signed links expire, so a refusal here is ordinary: it is simply gone.
    if (!response.ok || (response.url !== '' && !isMetaMediaUrl(response.url))) return MEDIA_NOT_AVAILABLE;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_INBOUND_MEDIA_BYTES) return MEDIA_TOO_LARGE;
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > MAX_INBOUND_MEDIA_BYTES) return MEDIA_TOO_LARGE;
    return { ok: true, data, mimeType: response.headers.get('content-type') };
  }

  private async subscribePage(credential: string, pageId: string): Promise<ProviderMutationResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.graphBase}/${pageId}/subscribed_apps?subscribed_fields=${META_PAGE_FIELDS.join(',')}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable', message: 'The Meta Graph API could not be reached.', retryable: true };
    }
    const body = await readJson(response);
    if (!response.ok) return { ok: false, ...classify(response.status, record(body)?.['error'] as GraphError | undefined) };
    return record(body)?.['success'] === true
      ? { ok: true }
      : { ok: false, code: 'provider_response_unusable', message: 'Meta did not confirm the Page subscription.', retryable: true };
  }

  private async graphGet(path: string, credential: string, timeoutMs = this.timeoutMs): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.graphBase}/${path}`, { method: 'GET', headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ok: false, code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable', message: 'The WhatsApp Cloud API could not be reached.', retryable: true };
    }
    const body = await readJson(response);
    if (response.ok) return { ok: true, body };
    const failure = classify(response.status, record(body)?.['error'] as GraphError | undefined);
    return { ok: false, ...failure };
  }

  /** A media message references the ID returned by a successful upload. */
  private payloadFor(kind: ChannelKind, command: SendCommand, mediaId?: string): Record<string, unknown> | null {
    if (kind === 'messenger' || kind === 'instagram') {
      const envelope = {
        recipient: { id: command.peerIdentity },
        ...(kind === 'messenger' ? { messaging_type: 'RESPONSE' } : {}),
      };
      if (mediaId !== undefined) return {
        ...envelope,
        message: { attachment: { type: command.messageType, payload: { attachment_id: mediaId } } },
      };
      if (command.messageType !== 'text' || command.text === null || command.text === '') return null;
      return { ...envelope, message: { text: command.text } };
    }
    const base = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: command.peerIdentity,
    };
    if (mediaId !== undefined) return {
      ...base, type: command.messageType,
      [command.messageType]: {
        id: mediaId,
        ...(command.media?.isVoice === true ? { voice: true } : {}),
        ...(command.messageType === 'document' ? { filename: command.media!.filename } : {}),
      },
    };
    if (command.template !== null) {
      return {
        ...base,
        type: 'template',
        template: {
          name: command.template.name,
          language: { code: command.template.language },
          ...(command.template.components === undefined || command.template.components.length === 0
            ? {}
            : { components: command.template.components.map((component) => ({
                type: component.type,
                ...(component.subType === undefined ? {} : { sub_type: component.subType }),
                ...(component.index === undefined ? {} : { index: component.index }),
                parameters: component.parameters,
              })) }),
        },
      };
    }
    if (command.messageType === 'text' && command.text !== null && command.text !== '') {
      return { ...base, type: 'text', text: { preview_url: false, body: command.text } };
    }
    return null;
  }
}

function normalizeTemplate(value: unknown): ProviderTemplate[] {
  const item = record(value);
  const providerId = item?.['id'];
  const name = item?.['name'];
  const language = item?.['language'];
  const category = item?.['category'];
  const rawStatus = item?.['status'];
  const components = item?.['components'];
  if (typeof providerId !== 'string' || typeof name !== 'string' || typeof language !== 'string' || typeof category !== 'string' || typeof rawStatus !== 'string' || !Array.isArray(components)) return [];
  const status = templateStatus(rawStatus);
  const variables = Array.from(new Set(JSON.stringify(components).match(/\{\{(?:[1-9]\d{0,2}|[a-z][a-z0-9_]{0,63})\}\}/g) ?? [])).sort();
  return [{ providerId, name, language, category: category.toLowerCase(), status, components, variables }];
}

function templateStatus(value: string): ProviderTemplate['status'] {
  const status = value.toUpperCase();
  if (status === 'APPROVED') return 'approved';
  if (status === 'PENDING' || status === 'IN_APPEAL') return 'pending';
  if (status === 'REJECTED') return 'rejected';
  if (status === 'PAUSED') return 'paused';
  return 'disabled';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface Classification {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * A Graph failure, turned into something the outbox can act on.
 *
 * The codes are Meta's own and each is here because it means something
 * operationally different:
 *
 * - **4, 80007, 130429** — throughput limits. Purely a matter of time.
 * - **190** — the access token expired or was revoked. An operator reconnects
 *   the channel and the message is still worth sending, so it retries; the
 *   outbox's bounded attempts stop it becoming a loop.
 * - **131047** — outside the 24-hour customer service window, so a free-form
 *   message is not allowed. Retrying cannot help; only a template can, and
 *   choosing one is a decision the sender has to make.
 * - **131026** — Meta will not deliver to that number at all.
 * - **131 / 100 family** — a malformed request. The same bytes will be refused
 *   the same way forever.
 */
function classify(status: number, error: GraphError | undefined): Classification {
  const code = typeof error?.code === 'number' ? error.code : null;
  const message =
    typeof error?.message === 'string' && error.message !== ''
      ? error.message
      : `The provider answered ${String(status)}.`;

  if (status === 429 || code === 4 || code === 80007 || code === 130429) {
    return { code: 'rate_limited', message, retryable: true };
  }
  if (status >= 500) {
    return { code: 'provider_unavailable', message, retryable: true };
  }
  if (code === 190 || status === 401) {
    return {
      code: 'credential_rejected',
      message,
      // Retryable on purpose: this is an installation problem, not a fact about
      // the message. Reconnect the channel and it should still go.
      retryable: true,
    };
  }
  if (code === 131047) {
    return { code: 'outside_service_window', message, retryable: false };
  }
  if (code === 131026) {
    return { code: 'recipient_undeliverable', message, retryable: false };
  }
  if (code === 131009 || code === 100) {
    return { code: 'invalid_request', message, retryable: false };
  }
  return {
    code: code === null ? `provider_error_${String(status)}` : `provider_error_${String(code)}`,
    message,
    // Unknown 4xx: treated as permanent. A refusal we do not recognise is far
    // more likely to be a contract problem than a transient one, and retrying
    // an unrecognised refusal five times is how a rate limit becomes a ban.
    retryable: false,
  };
}

function firstMessageId(body: unknown): string | null {
  const recordBody = record(body);
  const direct = recordBody?.['message_id'];
  if (typeof direct === 'string' && direct !== '') return direct;
  const messages = recordBody?.['messages'];
  if (!Array.isArray(messages)) return null;
  const first = record(messages[0]);
  return typeof first?.['id'] === 'string' && first['id'] !== '' ? first['id'] : null;
}

function isMetaGraphKind(kind: ChannelKind): kind is 'whatsapp' | 'messenger' | 'instagram' {
  return kind === 'whatsapp' || kind === 'messenger' || kind === 'instagram';
}

function unsupportedConnection(kind: ChannelKind): ConnectionCheck {
  return { ok: false, assetIdentity: null, code: 'channel_not_supported', message: `The Meta Graph transport does not serve ${kind}.` };
}

function unsupportedSend(kind: ChannelKind): SendOutcome {
  return { status: 'definitely_rejected', code: 'channel_not_supported', message: `The Meta Graph transport does not serve ${kind}.`, retryable: false };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
