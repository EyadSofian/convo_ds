/**
 * The email transport port.
 *
 * Exactly the same shape of boundary as `ChannelTransportPort`: one interface,
 * one implementation chosen at the composition root, and a default that refuses
 * rather than pretends. No business service ever imports a provider SDK, so
 * adding SMTP later is a new file here and one line in `ApiModule` — not a
 * change to IAM.
 *
 * The three outcomes are the same three the message path uses, and for the same
 * reason. `accepted` means the provider confirmed and gave us an id. `refused`
 * means it said no and will say no again to identical bytes. `unknown` means the
 * connection died somewhere between the request and the answer, so the email may
 * or may not be on its way.
 *
 * Unlike a customer-facing WhatsApp message, an `unknown` email **is** retried:
 * a duplicate invitation is a mild annoyance, a lost one is a person who cannot
 * join. That asymmetry is a product decision and it lives here, not in the
 * adapter.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /**
   * The provider's own idempotency handle, when it supports one. It is the
   * delivery row's id, so a retry after an `unknown` cannot become two emails
   * at any provider that honours it.
   */
  readonly idempotencyKey: string;
}

export type EmailSendOutcome =
  | { readonly status: 'accepted'; readonly providerMessageId: string }
  | {
      readonly status: 'refused';
      readonly code: string;
      readonly message: string;
      /** Whether waiting could change the answer. A bad API key: no. A 503: yes. */
      readonly retryable: boolean;
    }
  | { readonly status: 'unknown'; readonly code: string; readonly message: string };

export interface EmailProviderPort {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendOutcome>;
}

export const EMAIL_NOT_CONFIGURED = 'email_provider_not_configured';

/**
 * The default: none.
 *
 * It is the explicit `disabled` binding. It refuses non-retryably, so no caller
 * can mistake absent provider configuration for a successful delivery.
 */
export const unconfiguredEmailProvider: EmailProviderPort = {
  name: 'unconfigured',
  send(): Promise<EmailSendOutcome> {
    return Promise.resolve({
      status: 'refused',
      code: EMAIL_NOT_CONFIGURED,
      message: 'No email provider is configured for this installation.',
      retryable: false,
    });
  },
};

/**
 * The local/test adapter.
 *
 * It records that a message would have been sent, with the address redacted and
 * **never** the subject, body or token, and reports a synthetic id so the outbox
 * still reaches a terminal state and the state machine is exercised end to end.
 *
 * It is not a working integration. The config parser permits it only for a
 * non-production integration worker.
 */
export class LoggingEmailProvider implements EmailProviderPort {
  readonly name = 'logging';

  constructor(private readonly log: (line: string) => void = console.info) {}

  send(message: EmailMessage): Promise<EmailSendOutcome> {
    this.log(
      `convo: email suppressed for ${redactEmail(message.to)} ` +
        `(logging provider; nothing was sent) key=${message.idempotencyKey}`,
    );
    return Promise.resolve({
      status: 'accepted',
      providerMessageId: `logging:${message.idempotencyKey}`,
    });
  }
}

/** `hana@school.example` becomes `h***@school.example`. */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
