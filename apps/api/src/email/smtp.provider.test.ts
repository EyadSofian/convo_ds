import { describe, expect, it } from 'vitest';
import type { EmailMessage } from './email-provider.port.js';
import { SmtpEmailProvider, type SmtpTransport } from './smtp.provider.js';

const MESSAGE: EmailMessage = {
  to: 'nadia@digital-school.example',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
  idempotencyKey: 'delivery-id-0001',
};

const SMTP_PASSWORD = 'smtp-test-secret';

function provider(answer: () => Promise<unknown> | unknown) {
  const calls: Parameters<SmtpTransport['sendMail']>[0][] = [];
  const transport: SmtpTransport = {
    async sendMail(message) {
      calls.push(message);
      return (await answer()) as Awaited<ReturnType<SmtpTransport['sendMail']>>;
    },
  };
  return {
    calls,
    adapter: new SmtpEmailProvider({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      username: 'ops@digital-school.example',
      password: SMTP_PASSWORD,
      from: 'Digital School <ops@digital-school.example>',
      transport,
    }),
  };
}

function smtpError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe('SMTP successful delivery', () => {
  it('maps the accepted recipient and SMTP message id', async () => {
    const { adapter } = provider(() => ({ accepted: [MESSAGE.to], messageId: '<smtp-1@example.test>' }));
    expect(await adapter.send(MESSAGE)).toEqual({
      status: 'accepted',
      providerMessageId: '<smtp-1@example.test>',
    });
  });

  it('passes both rendered bodies and a deterministic message id to the transport', async () => {
    const { adapter, calls } = provider(() => ({ accepted: [MESSAGE.to], messageId: '<smtp-1@example.test>' }));
    await adapter.send(MESSAGE);
    await adapter.send(MESSAGE);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      from: 'Digital School <ops@digital-school.example>',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
    expect(calls[0]?.messageId).toMatch(/^<convo\.[a-f0-9]{64}@digital-school\.example>$/);
    expect(calls[1]?.messageId).toBe(calls[0]?.messageId);
  });

  it('treats a transport response without acceptance evidence as unknown', async () => {
    const { adapter } = provider(() => ({ accepted: [], messageId: '<smtp-1@example.test>' }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'unknown',
      code: 'provider_response_unusable',
    });
  });

  it('treats an SMTP acceptance without a message id as unknown', async () => {
    const { adapter } = provider(() => ({ accepted: [MESSAGE.to] }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'unknown',
      code: 'provider_response_unusable',
    });
  });

  it('accepts a bare sender identity and uses its sender domain in Message-ID', async () => {
    let messageId = '';
    const transport: SmtpTransport = {
      sendMail: async (message) => {
        messageId = message.messageId;
        return { accepted: [MESSAGE.to], messageId: '<smtp-1@example.test>' };
      },
    };
    const adapter = new SmtpEmailProvider({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      username: 'ops@digital-school.example',
      password: SMTP_PASSWORD,
      from: 'ops@digital-school.example',
      transport,
    });
    expect((await adapter.send(MESSAGE)).status).toBe('accepted');
    expect(messageId).toMatch(/@digital-school\.example>$/);
  });

  it('falls back to a safe Message-ID domain if an invalid sender bypasses configuration', async () => {
    let messageId = '';
    const transport: SmtpTransport = {
      sendMail: async (message) => {
        messageId = message.messageId;
        return { accepted: [MESSAGE.to], messageId: '<smtp-1@example.test>' };
      },
    };
    const adapter = new SmtpEmailProvider({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      username: 'ops',
      password: SMTP_PASSWORD,
      from: 'invalid-sender',
      transport,
    });
    await adapter.send(MESSAGE);
    expect(messageId).toMatch(/@convo\.invalid>$/);
  });

  it('can construct Nodemailer with the secure mode supplied by configuration', () => {
    const adapter = new SmtpEmailProvider({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      username: 'ops@digital-school.example',
      password: SMTP_PASSWORD,
      from: 'ops@digital-school.example',
    });
    expect(adapter.name).toBe('smtp');
  });
});

describe('SMTP failures', () => {
  it('does not retry invalid SMTP credentials', async () => {
    const { adapter } = provider(() => {
      throw smtpError(`535 credentials ${SMTP_PASSWORD} for ${MESSAGE.to} rejected`, {
        code: 'EAUTH',
        responseCode: 535,
      });
    });
    const outcome = await adapter.send(MESSAGE);
    expect(outcome).toMatchObject({
      status: 'refused',
      code: 'provider_credentials_rejected',
      retryable: false,
    });
    if (outcome.status !== 'refused') throw new Error('expected refusal');
    expect(outcome.message).not.toContain(SMTP_PASSWORD);
    expect(outcome.message).not.toContain(MESSAGE.to);
    expect(outcome.message).toContain('[redacted]');
    expect(outcome.message).toContain('n***@digital-school.example');
  });

  it('retries a temporary SMTP response', async () => {
    const { adapter } = provider(() => {
      throw smtpError('421 temporary service failure', { responseCode: 421 });
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'smtp_temporary_failure',
      retryable: true,
    });
  });

  it('does not retry a recipient rejection', async () => {
    const { adapter } = provider(() => {
      throw smtpError(`${MESSAGE.to} does not exist`, { responseCode: 550 });
    });
    const outcome = await adapter.send(MESSAGE);
    expect(outcome).toMatchObject({ status: 'refused', code: 'recipient_rejected', retryable: false });
    if (outcome.status !== 'refused') throw new Error('expected refusal');
    expect(outcome.message).not.toContain(MESSAGE.to);
  });

  it('reports a timeout as unknown so the durable outbox retries it', async () => {
    const { adapter } = provider(() => {
      throw smtpError('timed out', { code: 'ETIMEDOUT' });
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({ status: 'unknown', code: 'provider_timeout' });
  });

  it('reports connection errors as unknown without storing raw transport text', async () => {
    const { adapter } = provider(() => {
      throw smtpError('connect ECONNREFUSED smtp.example.test', { code: 'ECONNREFUSED' });
    });
    expect(await adapter.send(MESSAGE)).toEqual({
      status: 'unknown',
      code: 'provider_unreachable',
      message: 'SMTP could not be reached.',
    });
  });

  it('does not retry a rejected recipient returned in a successful transport response', async () => {
    const { adapter } = provider(() => ({
      accepted: [],
      rejected: [MESSAGE.to],
      messageId: '<smtp-1@example.test>',
      response: `${MESSAGE.to} rejected`,
    }));
    const outcome = await adapter.send(MESSAGE);
    expect(outcome).toMatchObject({ status: 'refused', code: 'recipient_rejected', retryable: false });
    if (outcome.status !== 'refused') throw new Error('expected refusal');
    expect(outcome.message).not.toContain(MESSAGE.to);
  });

  it('uses the generic recipient rejection message when SMTP gives no response text', async () => {
    const { adapter } = provider(() => ({ rejected: [MESSAGE.to] }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'recipient_rejected',
      message: 'The SMTP server rejected the recipient.',
    });
  });

  it('does not retry a permanent SMTP failure that is not a recipient rejection', async () => {
    const { adapter } = provider(() => {
      throw smtpError('554 message refused', { responseCode: 554 });
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'smtp_permanent_failure',
      retryable: false,
    });
  });

  it('does not retry a locally rejected malformed message', async () => {
    const { adapter } = provider(() => {
      throw smtpError('message syntax invalid', { code: 'EMESSAGE' });
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'smtp_message_rejected',
      retryable: false,
    });
  });

  it('keeps an untyped transport failure unknown rather than inventing a refusal', async () => {
    const { adapter } = provider(() => {
      throw { response: 'unexpected socket close' };
    });
    expect(await adapter.send(MESSAGE)).toEqual({
      status: 'unknown',
      code: 'provider_unreachable',
      message: 'SMTP delivery did not complete.',
    });
  });

  it('keeps non-object transport failures unknown without copying their value', async () => {
    const { adapter } = provider(() => {
      throw null;
    });
    expect(await adapter.send(MESSAGE)).toEqual({
      status: 'unknown',
      code: 'provider_unreachable',
      message: 'SMTP delivery did not complete.',
    });
  });
});
