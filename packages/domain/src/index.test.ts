import { describe, expect, it } from 'vitest';
import * as domain from './index.js';

describe('@convo/domain public surface', () => {
  it('exports exactly the documented runtime members', () => {
    expect(Object.keys(domain).sort()).toEqual([
      'ADAPTER_PORT_VERSION',
      'BOOTSTRAP_STATES',
      'BUILTIN_ROLES',
      'BUILTIN_ROLE_KEYS',
      'CAPABILITY_MATRICES',
      'CHANNEL_KINDS',
      'CHANNEL_PROVIDERS',
      'ConfigurationError',
      'EVIDENCE_KINDS',
      'INBOUND_KINDS',
      'NON_DELEGABLE_PERMISSIONS',
      'PERMISSION_KEYS',
      'PINNED_GRAPH_VERSION',
      'PROVIDER_OF',
      'QUEUE_CARD_FIELDS',
      'READINESS_STATES',
      'REFUSAL_REASONS',
      'REPLAY_WINDOW_SECONDS',
      'SCOPE_LEVELS',
      'SIGNATURE_REFUSALS',
      'WhatsAppAdapter',
      'answerMetaChallenge',
      'applyInstallationConfig',
      'authorize',
      'bootstrapInstallation',
      'canAssignRole',
      'canAuthorRole',
      'canGrantScopes',
      'capabilitiesFor',
      'grantsOf',
      'isChannelKind',
      'isDelegable',
      'isPermissionKey',
      'measureText',
      'missingEvidence',
      'narrowest',
      'parseInstallationConfig',
      'permitSend',
      'projectFields',
      'reachFor',
      'readBootstrapState',
      'readinessOf',
      'scopeCovers',
      'scopeFor',
      'utf8Length',
      'verifyMetaSignature',
    ]);
  });

  it('does not export the test doubles that live beside the domain code', () => {
    expect(Object.keys(domain)).not.toContain('fakeSql');
    expect(Object.keys(domain)).not.toContain('fakeTransaction');
  });
});
