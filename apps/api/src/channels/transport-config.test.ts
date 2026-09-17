import type { ErrorDetail } from '@convo/contracts';
import { describe, expect, it } from 'vitest';
import { CHANNEL_TRANSPORTS, readChannelTransport } from './transport-config.js';

function read(value: string | undefined) {
  const issues: ErrorDetail[] = [];
  return { value: readChannelTransport({ CONVO_CHANNEL_TRANSPORT: value }, issues), issues };
}

describe('the channel transport selection', () => {
  it('defaults to none, which refuses every send with a typed reason', () => {
    expect(read(undefined).value).toBe('none');
    expect(read('').value).toBe('none');
    expect(read('  ').value).toBe('none');
  });

  it('raises no issue when it is absent', () => {
    // Unlike email, this one does not fail closed: an installation may run for
    // weeks before its Meta assets are approved, and refusing to start until a
    // WhatsApp number exists would make the product unusable during setup.
    expect(read(undefined).issues).toHaveLength(0);
  });

  it.each(CHANNEL_TRANSPORTS)('accepts %s', (name) => {
    expect(read(name).value).toBe(name);
    expect(read(name).issues).toHaveLength(0);
  });

  it('refuses an unknown provider rather than silently falling back', () => {
    const result = read('twilio');
    expect(result.value).toBe('none');
    expect(result.issues.map((issue) => issue.code)).toContain('unsupported_value');
    expect(result.issues[0]?.field).toBe('CONVO_CHANNEL_TRANSPORT');
  });

  it('lists what is accepted, so the fix is in the message', () => {
    expect(read('twilio').issues[0]?.message).toContain('none, meta');
  });
});
