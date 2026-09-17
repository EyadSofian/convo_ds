import { describe, expect, it } from 'vitest';
import { createLogger, readLogLevel, redactedName, type Logger } from './logger.js';

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = createLogger({
    service: 'convo-api',
    processRole: 'api',
    ...(level === undefined ? {} : { level }),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-09-17T10:00:00.000Z'),
  });
  return { logger, lines };
}

describe('the shape of a line', () => {
  it('carries the fields a collector groups by', () => {
    const { logger, lines } = capture();
    logger.info('request_completed', { route: '/api/v1/conversations', status: 200, duration_ms: 12 });
    expect(lines[0]).toEqual({
      timestamp: '2026-09-17T10:00:00.000Z',
      level: 'info',
      service: 'convo-api',
      process_role: 'api',
      event: 'request_completed',
      route: '/api/v1/conversations',
      status: 200,
      duration_ms: 12,
    });
  });

  it('is one JSON object per line', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 's', processRole: 'api', write: (line) => lines.push(line) });
    logger.info('a');
    logger.info('b');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it('omits fields that were not set rather than writing nulls', () => {
    const { logger, lines } = capture();
    logger.info('event', { tenant_id: undefined, user_id: 'u1' });
    expect(lines[0]).not.toHaveProperty('tenant_id');
    expect(lines[0]).toHaveProperty('user_id', 'u1');
  });
});

describe('correlation', () => {
  it('carries a child logger’s fields onto every line', () => {
    const { logger, lines } = capture();
    const request = logger.child({ request_id: 'req-1', tenant_id: 't-1' });
    request.info('started');
    request.warn('slow');
    expect(lines.map((line) => line['request_id'])).toEqual(['req-1', 'req-1']);
    expect(lines.map((line) => line['tenant_id'])).toEqual(['t-1', 't-1']);
  });

  it('lets a call override an inherited field', () => {
    const { logger, lines } = capture();
    logger.child({ tenant_id: 't-1' }).info('cross', { tenant_id: 't-2' });
    expect(lines[0]?.['tenant_id']).toBe('t-2');
  });

  it('nests', () => {
    const { logger, lines } = capture();
    logger.child({ request_id: 'r' }).child({ job_id: 'j' }).info('e');
    expect(lines[0]).toMatchObject({ request_id: 'r', job_id: 'j' });
  });
});

describe('what never reaches a line', () => {
  it.each([
    'password',
    'token',
    'recovery_token',
    'invitation_token',
    'authorization',
    'cookie',
    'x-csrf-token',
    'apiKey',
    'CONVO_RESEND_API_KEY',
    'credential',
    'verifier_hash',
    'signature',
    'text_body',
    'message_content',
    'payload',
  ])('redacts %s', (field) => {
    const { logger, lines } = capture();
    logger.info('event', { [field]: 'the-actual-secret-value' });
    expect(JSON.stringify(lines[0])).not.toContain('the-actual-secret-value');
    expect(lines[0]?.[field]).toBe('[redacted]');
  });

  it('never expands an object, so a headers bag cannot leak by accident', () => {
    const { logger, lines } = capture();
    logger.info('event', { request: { headers: { cookie: 'convo_session=abc' } } });
    expect(JSON.stringify(lines[0])).not.toContain('convo_session');
    expect(lines[0]?.['request']).toBe('[object]');
  });

  it('logs an error’s message but never its stack', () => {
    const { logger, lines } = capture();
    const error = new Error('connection to 10.0.0.5:5432 refused');
    logger.error('failed', { cause: error });
    expect(lines[0]?.['cause']).toBe('connection to 10.0.0.5:5432 refused');
    expect(JSON.stringify(lines[0])).not.toContain('at ');
  });

  it('never expands an array', () => {
    const { logger, lines } = capture();
    logger.info('event', { recipients: ['a@b.example', 'c@d.example'] });
    expect(JSON.stringify(lines[0])).not.toContain('a@b.example');
  });
});

describe('levels', () => {
  it('drops everything below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((line) => line['level'])).toEqual(['warn', 'error']);
  });

  it('defaults to info, never to debug', () => {
    expect(readLogLevel({})).toBe('info');
    expect(readLogLevel({ CONVO_LOG_LEVEL: 'nonsense' })).toBe('info');
    expect(readLogLevel({ CONVO_LOG_LEVEL: ' DEBUG ' })).toBe('debug');
  });
});

describe('the redaction rule itself', () => {
  it('matches by substring and ignores case', () => {
    expect(redactedName('Authorization')).toBe(true);
    expect(redactedName('x-csrf-token')).toBe(true);
    expect(redactedName('duration_ms')).toBe(false);
    expect(redactedName('status')).toBe(false);
  });
});
