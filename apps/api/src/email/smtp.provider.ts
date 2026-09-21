import { createHash } from 'node:crypto';
import { createTransport, type Transporter } from 'nodemailer';
import {
  redactEmail,
  type EmailMessage,
  type EmailProviderPort,
  type EmailSendOutcome,
} from './email-provider.port.js';

/** A bounded connection attempt prevents one unavailable SMTP host stalling the worker forever. */
export const SMTP_TIMEOUT_MS = 10_000;

interface SmtpSendResult {
  readonly accepted?: readonly string[];
  readonly rejected?: readonly string[];
  readonly messageId?: string;
  readonly response?: string;
}

export interface SmtpTransport {
  sendMail(message: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly html: string;
    readonly text: string;
    readonly messageId: string;
  }): Promise<SmtpSendResult>;
}

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  /** `true` means implicit TLS; port 465 is validated to require this at boot. */
  readonly secure: boolean;
  readonly username: string;
  /** Environment-only secret. It is never emitted from this module. */
  readonly password: string;
  readonly from: string;
  readonly timeoutMs?: number;
  /** Injectable boundary for deterministic provider tests. */
  readonly transport?: SmtpTransport;
}

/**
 * Generic SMTP transport. Hostinger is configuration, not an application
 * concept: any standards-compliant SMTP relay can be selected by deployment.
 *
 * SMTP has no provider idempotency protocol comparable to Resend's HTTP
 * header. We therefore make the RFC Message-ID deterministic from the durable
 * delivery key. A retry has the same message identity for correlation and
 * mailbox-level de-duplication, while the existing transactional outbox keeps
 * the database-side single-send guarantee.
 */
export class SmtpEmailProvider implements EmailProviderPort {
  readonly name = 'smtp';

  private readonly password: string;
  private readonly from: string;
  private readonly transport: SmtpTransport;

  constructor(options: SmtpOptions) {
    this.password = options.password;
    this.from = options.from;
    const timeoutMs = options.timeoutMs ?? SMTP_TIMEOUT_MS;
    this.transport =
      options.transport ??
      (createTransport({
        host: options.host,
        port: options.port,
        // `secure: true` starts TLS immediately. In particular this does not
        // attempt STARTTLS on Hostinger's implicit-TLS port 465.
        secure: options.secure,
        auth: { user: options.username, pass: options.password },
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      }) as Transporter<SmtpSendResult>);
  }

  async send(message: EmailMessage): Promise<EmailSendOutcome> {
    let result: SmtpSendResult;
    try {
      result = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: deterministicMessageId(message.idempotencyKey, this.from),
      });
    } catch (error) {
      return this.fromError(error);
    }

    if (result.rejected?.length !== undefined && result.rejected.length > 0) {
      return {
        status: 'refused',
        code: 'recipient_rejected',
        message: this.scrub(result.response ?? 'The SMTP server rejected the recipient.'),
        retryable: false,
      };
    }
    if (result.accepted?.includes(message.to) !== true) {
      return {
        status: 'unknown',
        code: 'provider_response_unusable',
        message: 'SMTP returned no accepted recipient.',
      };
    }
    if (typeof result.messageId !== 'string' || result.messageId === '') {
      return {
        status: 'unknown',
        code: 'provider_response_unusable',
        message: 'SMTP accepted the message but returned no message id.',
      };
    }
    return { status: 'accepted', providerMessageId: result.messageId };
  }

  private fromError(error: unknown): EmailSendOutcome {
    const details = smtpErrorDetails(error);
    const message = this.scrub(details.message ?? details.response ?? 'SMTP delivery failed.');
    if (details.code === 'EAUTH' || details.responseCode === 535) {
      return {
        status: 'refused',
        code: 'provider_credentials_rejected',
        message,
        retryable: false,
      };
    }
    if (details.code === 'ETIMEDOUT' || details.code === 'ESOCKETTIMEDOUT') {
      return { status: 'unknown', code: 'provider_timeout', message: 'SMTP did not answer before the timeout.' };
    }
    if (isConnectionError(details.code)) {
      return { status: 'unknown', code: 'provider_unreachable', message: 'SMTP could not be reached.' };
    }
    if (details.responseCode !== undefined && details.responseCode >= 400 && details.responseCode < 500) {
      return { status: 'refused', code: 'smtp_temporary_failure', message, retryable: true };
    }
    if (details.responseCode !== undefined && isRecipientRejection(details.responseCode)) {
      return { status: 'refused', code: 'recipient_rejected', message, retryable: false };
    }
    if (details.responseCode !== undefined && details.responseCode >= 500) {
      return { status: 'refused', code: 'smtp_permanent_failure', message, retryable: false };
    }
    if (details.code === 'EMESSAGE') {
      return { status: 'refused', code: 'smtp_message_rejected', message, retryable: false };
    }
    // Without an SMTP reply the message might have crossed the network before
    // the socket failed, so preserve the outbox's safe unknown/retry outcome.
    return { status: 'unknown', code: 'provider_unreachable', message: 'SMTP delivery did not complete.' };
  }

  private scrub(text: string): string {
    return redactAddresses(text.split(this.password).join('[redacted]'));
  }
}

function deterministicMessageId(idempotencyKey: string, from: string): string {
  const domain = senderAddress(from).split('@')[1] ?? 'convo.invalid';
  const key = createHash('sha256').update(idempotencyKey).digest('hex');
  return `<convo.${key}@${domain}>`;
}

function senderAddress(from: string): string {
  const named = /<([^<>]+)>$/.exec(from);
  return named?.[1] ?? from;
}

interface SmtpErrorDetails {
  readonly code: string | undefined;
  readonly responseCode: number | undefined;
  readonly response: string | undefined;
  readonly message: string | undefined;
}

function smtpErrorDetails(error: unknown): SmtpErrorDetails {
  if (error === null || typeof error !== 'object') {
    return { code: undefined, responseCode: undefined, response: undefined, message: undefined };
  }
  const record = error as Record<string, unknown>;
  return {
    code: typeof record['code'] === 'string' ? record['code'] : undefined,
    responseCode: typeof record['responseCode'] === 'number' ? record['responseCode'] : undefined,
    response: typeof record['response'] === 'string' ? record['response'] : undefined,
    message: error instanceof Error ? error.message : undefined,
  };
}

function isConnectionError(code: string | undefined): boolean {
  return CONNECTION_ERROR_CODES.has(code ?? '');
}

function isRecipientRejection(status: number): boolean {
  return RECIPIENT_REJECTION_CODES.has(status);
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ESOCKET',
]);
const RECIPIENT_REJECTION_CODES = new Set([550, 551, 553]);

function redactAddresses(text: string): string {
  return text.replace(/[^\s<>@,;"]+@[^\s<>@,;"]+/g, (address) => redactEmail(address));
}
