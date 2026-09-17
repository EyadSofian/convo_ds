import { describe, expect, it } from 'vitest';
import {
  EMAIL_NOT_CONFIGURED,
  LoggingEmailProvider,
  redactEmail,
  unconfiguredEmailProvider,
  type EmailMessage,
} from './email-provider.port.js';

const MESSAGE: EmailMessage = {
  to: 'nadia@digital-school.example',
  subject: 'Your invitation',
  html: '<p>token-value-in-here</p>',
  text: 'token-value-in-here',
  idempotencyKey: 'delivery-0001',
};

describe('the default provider: none', () => {
  it('refuses, rather than pretending to have sent', async () => {
    const outcome = await unconfiguredEmailProvider.send(MESSAGE);
    expect(outcome).toMatchObject({ status: 'refused', code: EMAIL_NOT_CONFIGURED });
  });

  it('refuses non-retryably, so a misconfigured environment fails on the first attempt', async () => {
    // Retrying six times into a provider that does not exist wastes the backoff
    // and hides the real problem behind `attempts_exhausted`.
    const outcome = await unconfiguredEmailProvider.send(MESSAGE);
    if (outcome.status !== 'refused') throw new Error('expected a refusal');
    expect(outcome.retryable).toBe(false);
  });

  it('names itself, so the stored `provider` column is honest', () => {
    expect(unconfiguredEmailProvider.name).toBe('unconfigured');
  });
});

describe('the logging provider', () => {
  it('accepts with a synthetic id, so the outbox still reaches a terminal state', async () => {
    const provider = new LoggingEmailProvider(() => undefined);
    expect(await provider.send(MESSAGE)).toEqual({
      status: 'accepted',
      providerMessageId: 'logging:delivery-0001',
    });
  });

  it('logs a redacted address and never the subject, body or key material', async () => {
    const lines: string[] = [];
    await new LoggingEmailProvider((line) => lines.push(line)).send(MESSAGE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('n***@digital-school.example');
    expect(lines[0]).not.toContain('nadia@digital-school.example');
    expect(lines[0]).not.toContain('token-value-in-here');
    expect(lines[0]).not.toContain('Your invitation');
  });

  it('defaults its sink without touching the console in this test', () => {
    // Constructing it must not itself write anything.
    expect(new LoggingEmailProvider().name).toBe('logging');
  });
});

describe('address redaction', () => {
  it.each([
    ['nadia@digital-school.example', 'n***@digital-school.example'],
    ['a@b.example', 'a***@b.example'],
  ])('reduces %s to %s', (input, expected) => {
    expect(redactEmail(input)).toBe(expected);
  });

  it.each(['', 'not-an-address', '@leading', 'trailing@'])(
    'gives up entirely on %s rather than emitting something partial',
    (input) => {
      expect(redactEmail(input)).toBe(input.endsWith('@') ? 't***@' : '***');
    },
  );
});
