import { describe, expect, it } from 'vitest';
import { BROKER_UNAVAILABLE_CODE, unconfiguredBroker } from './broker.port.js';

/**
 * The default broker: none.
 *
 * The only thing worth asserting about it is that it refuses honestly, and
 * refuses in the *right* way — an unknown outcome rather than a rejection, so
 * the relay retries and the outbox grows visibly instead of quietly discarding
 * events because nobody configured a transport.
 */
describe('the unconfigured broker', () => {
  it('reports itself unhealthy rather than pretending', async () => {
    expect(await unconfiguredBroker.healthy()).toBe(false);
  });

  it('answers a publish as unknown, not as a refusal', async () => {
    const outcome = await unconfiguredBroker.publish({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      topic: 'inbound.event',
      payload: { eventId: 'e1' },
    });
    // `refused` would be a permanent rejection of this envelope. "Nobody
    // configured a broker" is a temporary fact about the installation, not a
    // fact about the message, so the relay must keep it.
    expect(outcome).toMatchObject({ status: 'unknown', code: BROKER_UNAVAILABLE_CODE });
  });

  it('names itself, so a health page can say which transport is in use', () => {
    expect(unconfiguredBroker.name).toBe('unconfigured');
  });
});
