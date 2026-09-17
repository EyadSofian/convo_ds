import { describe, expect, it } from 'vitest';
import { createLogger } from './observability/logger.js';
import { MetaWhatsAppTransport } from './channels/meta-whatsapp.transport.js';
import { ResendEmailProvider } from './email/resend.provider.js';
import { runWorkerLoop } from './workers/worker-loop.js';
import type { SendCommand } from '@convo/domain';

/**
 * The branches the behavioural suites do not reach.
 *
 * Each of these is a real path with a real consequence — they are simply
 * reached by inputs the happy-path tests have no reason to produce. Gathered in
 * one file rather than scattered, so it is obvious what is being covered and
 * why, and so nobody is tempted to lower a threshold instead.
 */

const TEXT: SendCommand = {
  assetIdentity: '15550001111',
  peerIdentity: '201234567890',
  messageType: 'text',
  text: 'hello',
  template: null,
  attachments: [],
  idempotencyKey: 'attempt-1',
};

function metaWith(responder: () => Response | Error) {
  const fetchImpl = (() => {
    const answer = responder();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as unknown as typeof fetch;
  return new MetaWhatsAppTransport({ graphBase: 'https://graph.example/v21.0', fetchImpl });
}

function resendWith(responder: () => Response) {
  const fetchImpl = (() => Promise.resolve(responder())) as unknown as typeof fetch;
  return new ResendEmailProvider({ apiKey: 're_key_0123456789', from: 'ops@convo.test', fetchImpl });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the WhatsApp transport, at its edges', () => {
  it('distinguishes a timeout from an unreachable host when validating', async () => {
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    const outcome = await metaWith(() => timeout).validateConnection('whatsapp', 't', '15550001111');
    expect(outcome).toMatchObject({ ok: false, code: 'provider_timeout' });
  });

  it('refuses a validate response whose id is not a string', async () => {
    // Graph returning something unexpected must not read as "valid".
    const outcome = await metaWith(() => json(200, { id: 12345 })).validateConnection(
      'whatsapp',
      't',
      '15550001111',
    );
    expect(outcome).toMatchObject({ ok: false, code: 'asset_mismatch', assetIdentity: null });
  });

  it('falls back to the HTTP status when the error carries no Graph code', async () => {
    const outcome = await metaWith(() => json(418, { error: { message: 'no' } })).send(
      'whatsapp',
      't',
      TEXT,
    );
    expect(outcome).toMatchObject({ code: 'provider_error_418', retryable: false });
  });

  it('treats an empty message id as no message id', async () => {
    // A blank id cannot have a delivery receipt folded onto it, so accepting it
    // would strand the message in a state nothing can advance.
    const outcome = await metaWith(() =>
      json(200, { messages: [{ id: '' }] }),
    ).send('whatsapp', 't', TEXT);
    expect(outcome).toMatchObject({ status: 'outcome_unknown', code: 'provider_response_unusable' });
  });

  it('uses the provider message when Graph supplies one, and a status line when it does not', async () => {
    const named = await metaWith(() => json(400, { error: { code: 100, message: 'Bad param' } })).send(
      'whatsapp',
      't',
      TEXT,
    );
    expect(named).toMatchObject({ message: 'Bad param' });

    const unnamed = await metaWith(() => json(400, { error: { code: 100 } })).send('whatsapp', 't', TEXT);
    expect(unnamed).toMatchObject({ message: 'The provider answered 400.' });
  });
});

describe('the Resend adapter, at its edges', () => {
  it('names the validation problem when the provider supplies one', async () => {
    const outcome = await resendWith(() =>
      json(422, { name: 'validation_error', message: 'bad from' }),
    ).send({ to: 'a@b.example', subject: 's', html: 'h', text: 't', idempotencyKey: 'k' });
    expect(outcome).toMatchObject({ code: 'invalid_request:validation_error' });
  });

  it('falls back to a bare code when it does not', async () => {
    const outcome = await resendWith(() => json(400, { message: 'bad' })).send({
      to: 'a@b.example',
      subject: 's',
      html: 'h',
      text: 't',
      idempotencyKey: 'k',
    });
    expect(outcome).toMatchObject({ code: 'invalid_request' });
  });

  it('reports an unclassified status by number', async () => {
    const outcome = await resendWith(() => json(404, {})).send({
      to: 'a@b.example',
      subject: 's',
      html: 'h',
      text: 't',
      idempotencyKey: 'k',
    });
    expect(outcome).toMatchObject({ code: 'provider_error_404', retryable: false });
  });

  it('uses a status line when the provider gives no message', async () => {
    const outcome = await resendWith(() => json(404, { name: 'not_found' })).send({
      to: 'a@b.example',
      subject: 's',
      html: 'h',
      text: 't',
      idempotencyKey: 'k',
    });
    if (outcome.status !== 'refused') throw new Error('expected a refusal');
    expect(outcome.message).toBe('Resend answered 404.');
  });
});

describe('the logger, at its edges', () => {
  it('writes null as null rather than as a type name', () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({
      service: 's',
      processRole: 'api',
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    log.info('event', { assignee: null });
    expect(lines[0]?.['assignee']).toBeNull();
  });

  it('writes a Date as an ISO instant', () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({
      service: 's',
      processRole: 'api',
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    log.info('event', { due: new Date('2026-09-17T10:00:00.000Z') });
    expect(lines[0]?.['due']).toBe('2026-09-17T10:00:00.000Z');
  });
});

describe('the worker loop, at its edges', () => {
  it('describes a thrown non-Error without crashing the loop', async () => {
    // A `throw 'string'` from a dependency must not become a second failure.
    let ticks = 0;
    const loop = runWorkerLoop({
      role: 'worker-inbound',
      idleDelayMs: 0,
      errorDelayMs: 0,
      tick: () => {
        ticks += 1;
        if (ticks >= 2) loop.stop();
        throw 'not an error object';
      },
      sleep: () => Promise.resolve(),
    });
    const summary = await loop.done;
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.lastErrorMessage).toBe('unknown worker failure');
  });
});
