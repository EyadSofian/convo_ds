import type { ChannelKind, ConnectionCheck, SendCommand, SendOutcome } from '@convo/domain';

/**
 * The transport half of a channel adapter — the part that talks to a provider.
 *
 * It is a port with a named implementation chosen at the composition root, for
 * the same reason the delivery ports are: the thing that reaches the outside
 * world should be swappable without any other file knowing.
 *
 * **A simulator is not a live integration.** The default implementation below
 * refuses every call. It does not pretend to send, it does not return a fake
 * message id, and it does not report a connection as valid. Until a real
 * provider transport is configured with authorized assets, every outbound
 * attempt is `not_available` with a reason that says exactly why — which is the
 * truth, and is what the Channels screen shows.
 */
export interface ChannelTransportPort {
  readonly name: string;
  validateConnection(
    kind: ChannelKind,
    credential: string,
    assetIdentity: string,
    facebookPageId?: string | null,
    /** A Custom Channel's reply URL, which is what verifying it means. */
    endpoint?: string | null,
  ): Promise<ConnectionCheck>;
  send(kind: ChannelKind, credential: string, command: SendCommand): Promise<SendOutcome>;
  /** Optional provider profile lookup. A missing name must never block inbound. */
  fetchPeerProfile?(kind: ChannelKind, credential: string, peerIdentity: string): Promise<string | null>;
  /** Optional because only WhatsApp exposes the template catalogue. */
  fetchTemplates?(
    kind: ChannelKind,
    credential: string,
    assetIdentity: string,
  ): Promise<TemplateFetchResult>;
}

export interface ProviderTemplate {
  readonly providerId: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: 'approved' | 'pending' | 'paused' | 'rejected' | 'disabled';
  readonly components: readonly unknown[];
  readonly variables: readonly string[];
}

export type TemplateFetchResult =
  | { readonly ok: true; readonly templates: readonly ProviderTemplate[] }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean };

export const NO_PROVIDER_CODE = 'provider_not_connected';

const NO_PROVIDER_MESSAGE =
  'No provider transport is configured. Connect authorized provider assets to enable sending.';

/**
 * The default transport: none.
 *
 * Every method refuses with `definitely_rejected`, not `outcome_unknown`. That
 * distinction matters: nothing was sent, we know nothing was sent, and a
 * message that never left must never enter the ambiguous state that suppresses
 * automatic retry forever (ADR-0006).
 */
export const unconfiguredTransport: ChannelTransportPort = {
  name: 'unconfigured',

  validateConnection(): Promise<ConnectionCheck> {
    return Promise.resolve({
      ok: false,
      assetIdentity: null,
      code: NO_PROVIDER_CODE,
      message: NO_PROVIDER_MESSAGE,
    });
  },

  send(): Promise<SendOutcome> {
    return Promise.resolve({
      status: 'definitely_rejected',
      code: NO_PROVIDER_CODE,
      message: NO_PROVIDER_MESSAGE,
      // Retryable: the configuration can be supplied later, and the message is
      // still worth sending then. This is not a permanent rejection of the
      // content.
      retryable: true,
    });
  },
};
