import {
  redactEmail,
  type EmailMessage,
  type EmailProviderPort,
  type EmailSendOutcome,
} from './email-provider.port.js';

/**
 * The Resend transport.
 *
 * Written against the HTTP API directly rather than the SDK. The whole surface
 * we need is one POST, and taking a dependency would mean its retry policy, its
 * timeout defaults and its error taxonomy all sitting underneath ours, invisibly
 * — which is precisely the layer where every one of this file's decisions
 * matters.
 *
 * What the classification below is for: a delivery that can be fixed by waiting
 * must be retried, and a delivery that can only be fixed by an operator must
 * stop burning attempts and say so. Collapsing those two into "failed" produces
 * either an unbounded retry loop against a wrong API key, or a real 503 that
 * quietly gives up.
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** The provider is given this long to answer before the attempt is abandoned. */
export const RESEND_TIMEOUT_MS = 10_000;

export interface ResendOptions {
  readonly apiKey: string;
  /** `Name <address@domain>` or a bare address. Validated at boot. */
  readonly from: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Injected so the adapter is testable without a network. */
  readonly fetchImpl?: typeof fetch;
}

interface ResendAccepted {
  readonly id?: unknown;
}

interface ResendError {
  readonly name?: unknown;
  readonly message?: unknown;
}

export class ResendEmailProvider implements EmailProviderPort {
  readonly name = 'resend';

  private readonly apiKey: string;
  private readonly from: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // Resend honours this, so an `unknown` retry does not become two
          // emails. A provider that ignores it costs us nothing.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The request left this process and no answer came back. We genuinely do
      // not know whether it was delivered, and for email the safe reading is
      // "retry" — see the note on `EmailSendOutcome`.
      return {
        status: 'unknown',
        code: isTimeout(error) ? 'provider_timeout' : 'provider_unreachable',
        // Deliberately not the raw error: a DNS or TLS message can carry the
        // endpoint and, on some runtimes, request headers.
        message: isTimeout(error)
          ? `Resend did not answer within ${String(this.timeoutMs)}ms.`
          : 'Resend could not be reached.',
      };
    }

    if (response.ok) {
      const body = (await readJson(response)) as ResendAccepted | null;
      const id = typeof body?.id === 'string' && body.id !== '' ? body.id : null;
      if (id === null) {
        // A 2xx with no id is a success we cannot evidence. Treated as unknown
        // rather than accepted, because `sent` in this product means "we hold
        // the provider's id for it".
        return {
          status: 'unknown',
          code: 'provider_response_unusable',
          message: 'Resend accepted the request but returned no message id.',
        };
      }
      return { status: 'accepted', providerMessageId: id };
    }

    const body = (await readJson(response)) as ResendError | null;
    const detail =
      typeof body?.message === 'string' && body.message !== ''
        ? body.message
        : `Resend answered ${String(response.status)}.`;
    return {
      status: 'refused',
      code: classify(response.status, body),
      // Provider text about *our* configuration is the single most useful thing
      // an operator can be shown, but it is still text a third party chose. It
      // is scrubbed of anything it should not be carrying before it becomes a
      // stored column: the recipient address, which providers routinely quote
      // back, and our own API key, which an authentication error may well
      // include verbatim.
      message: this.scrub(detail),
      // Only time-fixable failures are retried. A 403 for an unverified sending
      // domain is not one of them: it needs a person.
      retryable: response.status === 429 || response.status >= 500,
    };
  }

  /**
   * Everything a provider error is not allowed to keep.
   *
   * The key is removed by exact match rather than by pattern: we hold the real
   * value, so there is no need to guess at what a credential looks like and no
   * chance of missing one that does not match the guess.
   */
  private scrub(text: string): string {
    return redactAddresses(text.split(this.apiKey).join('[redacted]'));
  }
}

function classify(status: number, body: ResendError | null): string {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  if (status === 401 || status === 403) return 'provider_credentials_rejected';
  if (status === 422 || status === 400) {
    return typeof body?.name === 'string' && body.name !== '' ? `invalid_request:${body.name}` : 'invalid_request';
  }
  return `provider_error_${String(status)}`;
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

/**
 * Redacts any address the provider echoed back into its error text.
 *
 * Provider errors routinely quote the recipient. That string ends up in
 * `last_error_message`, which an operator reads and a log may carry, so the
 * address is reduced the same way it is everywhere else in this product.
 */
function redactAddresses(text: string): string {
  return text.replace(/[^\s<>@,;"]+@[^\s<>@,;"]+/g, (address) => redactEmail(address));
}
