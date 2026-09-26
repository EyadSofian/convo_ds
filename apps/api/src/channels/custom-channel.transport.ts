import { createHmac } from 'node:crypto';
import type { ChannelKind, ConnectionCheck, SendCommand, SendOutcome } from '@convo/domain';
import { CUSTOM_SIGNATURE_HEADER, CUSTOM_TIMESTAMP_HEADER } from '@convo/domain';
import type { ChannelTransportPort } from './channel-transport.js';

/**
 * The Custom Channel API's outbound half.
 *
 * The operator's system posts customer messages to us signed with the
 * connection's key; we post replies to the URL they gave us, signed with the
 * same key the same way (`v1=` HMAC-SHA256 over `timestamp.body`), so one
 * verifier on their side reads both directions of the contract.
 *
 * The outcome classification follows the Meta transport's: a 2xx is accepted,
 * an answer that says no is a rejection (retryable when it is the kind of no an
 * operator can fix), and a request that left with nothing coming back is
 * `outcome_unknown` — their system may already have shown it to the customer.
 */

export const CUSTOM_TIMEOUT_MS = 10_000;

export interface CustomChannelOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export class CustomChannelTransport {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: CustomChannelOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? CUSTOM_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** Posts a signed ping; a 2xx proves the URL answers and holds the key. */
  async validate(key: string, assetIdentity: string, endpoint: string | null): Promise<ConnectionCheck> {
    if (endpoint === null) return { ok: false, assetIdentity: null, ...ENDPOINT_MISSING };
    const answer = await this.post(key, endpoint, { object: 'convo_custom', version: '1', asset_id: assetIdentity, type: 'ping' });
    if (answer.kind === 'unreachable') {
      return { ok: false, assetIdentity: null, code: answer.code, message: answer.message };
    }
    return answer.response.ok
      ? { ok: true, assetIdentity, code: null, message: null }
      : { ok: false, assetIdentity: null, code: `endpoint_error_${String(answer.response.status)}`, message: `Your system answered ${String(answer.response.status)}.` };
  }

  async send(key: string, command: SendCommand): Promise<SendOutcome> {
    const endpoint = command.endpoint ?? null;
    if (endpoint === null) {
      // Retryable: the URL can be added later and the reply is still worth sending.
      return { status: 'definitely_rejected', ...ENDPOINT_MISSING, retryable: true };
    }
    if (command.messageType !== 'text' || command.text === null) {
      return { status: 'definitely_rejected', code: 'unsupported_message_type', message: `A Custom Channel carries text, not "${command.messageType}".`, retryable: false };
    }
    const answer = await this.post(key, endpoint, {
      object: 'convo_custom',
      version: '1',
      asset_id: command.assetIdentity,
      messages: [{ id: command.idempotencyKey, to: command.peerIdentity, type: 'text', text: command.text }],
    });
    if (answer.kind === 'unreachable') {
      return { status: 'outcome_unknown', code: answer.code, message: answer.message };
    }
    const { response } = answer;
    if (response.ok) {
      const body = await readJson(response);
      const id = typeof body?.['message_id'] === 'string' && body['message_id'] !== '' ? body['message_id'] : command.idempotencyKey;
      return { status: 'accepted', providerMessageId: id, raw: body };
    }
    const message = `Your system answered ${String(response.status)}.`;
    if (response.status === 429 || response.status >= 500) {
      return { status: 'definitely_rejected', code: response.status === 429 ? 'rate_limited' : 'provider_unavailable', message, retryable: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'definitely_rejected', code: 'credential_rejected', message, retryable: true };
    }
    return { status: 'definitely_rejected', code: `provider_error_${String(response.status)}`, message, retryable: false };
  }

  private async post(
    key: string,
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly kind: 'answered'; readonly response: Response } | { readonly kind: 'unreachable'; readonly code: string; readonly message: string }> {
    const body = JSON.stringify(payload);
    const stamp = String(Math.floor(this.now().getTime() / 1000));
    const signature = createHmac('sha256', key).update(`${stamp}.${body}`).digest('hex');
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CUSTOM_SIGNATURE_HEADER]: `v1=${signature}`,
          [CUSTOM_TIMESTAMP_HEADER]: stamp,
        },
        body,
        // A redirect would carry a signed body somewhere nobody configured.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { kind: 'answered', response };
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return timeout
        ? { kind: 'unreachable', code: 'provider_timeout', message: `Your system did not answer within ${String(this.timeoutMs)}ms.` }
        : { kind: 'unreachable', code: 'provider_unreachable', message: 'Your system could not be reached.' };
    }
  }
}

const ENDPOINT_MISSING = { code: 'custom_endpoint_missing', message: 'Add the URL your system receives replies on.' } as const;

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The installation's transport with the Custom Channel's own outbound half in
 * front of it. The provider transport never sees a custom send, and a custom
 * connection never depends on which provider transport is configured.
 */
export function withOwnChannels(base: ChannelTransportPort, own: CustomChannelTransport = new CustomChannelTransport()): ChannelTransportPort {
  const routed: ChannelTransportPort = {
    name: base.name,
    validateConnection: (kind: ChannelKind, credential, assetIdentity, facebookPageId, endpoint) =>
      kind === 'custom' ? own.validate(credential, assetIdentity, endpoint ?? null) : base.validateConnection(kind, credential, assetIdentity, facebookPageId),
    send: (kind: ChannelKind, credential, command) => (kind === 'custom' ? own.send(credential, command) : base.send(kind, credential, command)),
  };
  return {
    ...routed,
    ...(base.fetchPeerProfile === undefined ? {} : { fetchPeerProfile: base.fetchPeerProfile.bind(base) }),
    ...(base.fetchTemplates === undefined ? {} : { fetchTemplates: base.fetchTemplates.bind(base) }),
  };
}
