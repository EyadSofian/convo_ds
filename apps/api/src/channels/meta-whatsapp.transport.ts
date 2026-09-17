import type { ChannelKind, ConnectionCheck, SendCommand, SendOutcome } from '@convo/domain';
import { PINNED_GRAPH_VERSION } from '@convo/domain';
import type { ChannelTransportPort, ProviderTemplate, TemplateFetchResult } from './channel-transport.js';

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
 * It handles `whatsapp` only. Messenger and Instagram share this app
 * registration and this signature scheme, but their send contracts, their
 * windows and their template rules are genuinely different, and one adapter
 * pretending otherwise is how Instagram ends up governed by WhatsApp's rules
 * (ADR-0009). Both are refused here by name, so an operator who connects one
 * gets a clear reason rather than a subtly wrong message.
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
  ): Promise<ConnectionCheck> {
    if (kind !== 'whatsapp') {
      return {
        ok: false,
        assetIdentity: null,
        code: 'channel_not_supported',
        message: `This transport serves WhatsApp only; ${kind} needs its own adapter.`,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.graphBase}/${encodeURIComponent(assetIdentity)}?fields=id,display_phone_number,verified_name`,
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
        message: 'The WhatsApp Cloud API could not be reached.',
      };
    }

    const body = (await readJson(response)) as { id?: unknown; error?: GraphError } | null;
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
    if (id !== assetIdentity) {
      // A token that reads *a* number but not *this* one. Reporting ok here
      // would let a connection go live pointed at somebody else's asset.
      return {
        ok: false,
        assetIdentity: id,
        code: 'asset_mismatch',
        message: 'The token does not grant access to the configured phone number id.',
      };
    }
    return { ok: true, assetIdentity: id, code: null, message: null };
  }

  async send(kind: ChannelKind, credential: string, command: SendCommand): Promise<SendOutcome> {
    if (kind !== 'whatsapp') {
      return {
        status: 'definitely_rejected',
        code: 'channel_not_supported',
        message: `This transport serves WhatsApp only; ${kind} needs its own adapter.`,
        // Not retryable: no amount of waiting turns this into a WhatsApp
        // channel. It needs an adapter that does not exist yet.
        retryable: false,
      };
    }

    const payload = this.payloadFor(command);
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
        `${this.graphBase}/${encodeURIComponent(command.assetIdentity)}/messages`,
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
          ? `The WhatsApp Cloud API did not answer within ${String(this.timeoutMs)}ms.`
          : 'The WhatsApp Cloud API could not be reached.',
      };
    }

    const body = (await readJson(response)) as
      | { messages?: unknown; error?: GraphError }
      | null;

    if (response.ok) {
      const id = firstMessageId(body?.messages);
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

  /** Fetches every Meta template page after resolving the WABA from the phone number. */
  async fetchTemplates(kind: ChannelKind, credential: string, assetIdentity: string): Promise<TemplateFetchResult> {
    if (kind !== 'whatsapp') return { ok: false, code: 'channel_not_supported', message: 'Templates are available for WhatsApp only.', retryable: false };
    const waba = await this.graphGet(`${encodeURIComponent(assetIdentity)}?fields=whatsapp_business_account`, credential);
    if (!waba.ok) return waba;
    const account = record(record(waba.body)?.['whatsapp_business_account']);
    const wabaId = typeof account?.['id'] === 'string' ? account['id'] : null;
    if (wabaId === null) return { ok: false, code: 'waba_not_found', message: 'Meta did not return the WhatsApp Business Account for this phone number.', retryable: false };
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

  private async graphGet(path: string, credential: string): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.graphBase}/${path}`, { method: 'GET', headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      return { ok: false, code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable', message: 'The WhatsApp Cloud API could not be reached.', retryable: true };
    }
    const body = await readJson(response);
    if (response.ok) return { ok: true, body };
    const failure = classify(response.status, record(body)?.['error'] as GraphError | undefined);
    return { ok: false, ...failure };
  }

  /**
   * The Graph request body.
   *
   * Only the two message shapes the product actually models. Media is not here
   * because sending it requires uploading to Meta first and holding a media id,
   * which is a separate flow with its own failure modes — and an adapter that
   * silently dropped an attachment would be worse than one that says it cannot
   * send that type.
   */
  private payloadFor(command: SendCommand): Record<string, unknown> | null {
    const base = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: command.peerIdentity,
    };
    if (command.template !== null) {
      return {
        ...base,
        type: 'template',
        template: {
          name: command.template.name,
          language: { code: command.template.language },
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
  const variables = Array.from(new Set(JSON.stringify(components).match(/\{\{\d+\}\}/g) ?? [])).sort();
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

function firstMessageId(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  const first = messages[0] as { id?: unknown } | undefined;
  return typeof first?.id === 'string' && first.id !== '' ? first.id : null;
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
