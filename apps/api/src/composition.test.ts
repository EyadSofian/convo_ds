import { describe, expect, it } from 'vitest';
import { channelTransportFor, emailProviderFor } from './api.module.js';
import type { ApiConfig } from './config.js';

/**
 * The composition root's two choices.
 *
 * Both are total functions over validated configuration, and both are worth
 * testing directly rather than through a booted application: what they return
 * decides whether this installation can send anything at all, and the previous
 * build got exactly this wrong by binding a logging adapter as a silent
 * default.
 */

function configWith(overrides: Partial<ApiConfig>): ApiConfig {
  return {
    deploymentMode: 'self_hosted_single',
    installationName: 'Test',
    publicBaseUrl: 'https://convo.test',
    defaultLocale: 'ar',
    supportedLocales: ['ar', 'en'],
    ssoConfigured: false,
    mfaAvailable: true,
    processRole: 'api',
    secrets: {
      authHash: 'a'.repeat(36),
      bootstrapToken: 'b'.repeat(36),
      idempotencyHash: 'c'.repeat(36),
      credentialKeys: [],
    },
    channelSecrets: {},
    email: { provider: 'logging', from: '', resendApiKey: '' },
    trustedProxyHops: 0,
    channelTransport: 'none',
    logLevel: 'info',
    workerConcurrency: 4,
    realtime: {
      pollMs: 500,
      heartbeatMs: 15_000,
      maxStreamMs: 300_000,
      maxBatch: 200,
      maxBacklog: 5_000,
    },
    host: '127.0.0.1',
    port: 0,
    database: { host: '127.0.0.1', port: 5432, name: 'convo', user: 'convo_app', password: 'x' },
    ...overrides,
  } as ApiConfig;
}

describe('which email provider is bound', () => {
  it('binds Resend when one is configured', () => {
    const provider = emailProviderFor(
      configWith({
        email: { provider: 'resend', from: 'ops@convo.test', resendApiKey: 're_0123456789abcdef' },
      }),
    );
    expect(provider.name).toBe('resend');
  });

  it('binds the logging adapter when the logging provider was chosen', () => {
    // Reachable only outside production: `readEmailConfig` refuses to produce
    // this combination with NODE_ENV=production.
    const provider = emailProviderFor(configWith({}));
    expect(provider.name).toBe('logging');
  });

  it('binds the refusing adapter for a logging provider carrying stray settings', () => {
    // A defensive arm rather than a reachable one: configuration that says
    // "logging" but carries a sender is internally inconsistent, and refusing
    // is safer than logging silently.
    const provider = emailProviderFor(
      configWith({ email: { provider: 'logging', from: 'ops@convo.test', resendApiKey: '' } }),
    );
    expect(provider.name).toBe('unconfigured');
  });
});

describe('which channel transport is bound', () => {
  it('binds the WhatsApp Cloud API adapter when meta is selected', () => {
    const transport = channelTransportFor(configWith({ channelTransport: 'meta' }));
    expect(transport.name).toBe('meta-whatsapp-cloud');
  });

  it('binds the refusing transport by default', () => {
    // It refuses every send with a typed reason rather than pretending, which
    // is the honest state until authorized provider assets exist.
    expect(channelTransportFor(configWith({})).name).toBe('unconfigured');
  });

  it('constructs the Meta adapter with no credentials of its own', async () => {
    // A WhatsApp access token belongs to a connection, is sealed per tenant,
    // and is handed to `send` as an argument. Nothing provider-shaped lives in
    // installation configuration except the choice of adapter.
    const transport = channelTransportFor(configWith({ channelTransport: 'meta' }));
    const outcome = await transport.send('messenger', 'token', {
      assetIdentity: 'a',
      peerIdentity: 'p',
      messageType: 'text',
      text: 'hello',
      template: null,
      attachments: [],
      idempotencyKey: 'k',
    });
    expect(outcome).toMatchObject({ status: 'definitely_rejected', code: 'channel_not_supported' });
  });
});
