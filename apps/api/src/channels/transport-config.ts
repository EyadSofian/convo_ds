import type { ErrorDetail } from '@convo/contracts';
import type { EnvironmentSource } from '@convo/domain';

/**
 * Which channel transport this installation uses.
 *
 * Unlike email, this one does **not** fail closed in production, and the reason
 * is worth stating because it looks inconsistent otherwise.
 *
 * Email is required by the product itself: an installation that cannot send an
 * invitation cannot onboard anybody, so booting without it is booting broken. A
 * channel transport is required by a *customer's* configuration. An installation
 * may legitimately run for weeks before its Meta assets are approved, with
 * operators using the inbox for channels that are already connected, and
 * refusing to start until a WhatsApp number exists would make the product
 * unusable during exactly the period when it is being set up.
 *
 * So the default stays `none`, the unconfigured transport refuses every send
 * with a typed reason, the Channels screen shows that reason, and nothing
 * anywhere pretends a message went out. What production does enforce is that
 * `meta` is a deliberate choice: an operator who selects it and has not supplied
 * credentials learns at the point of use, per channel, which is where the
 * missing thing actually is.
 */

export const CHANNEL_TRANSPORTS = ['none', 'meta'] as const;
export type ChannelTransportName = (typeof CHANNEL_TRANSPORTS)[number];

export function readChannelTransport(
  env: EnvironmentSource,
  issues: ErrorDetail[],
): ChannelTransportName {
  const raw = env['CONVO_CHANNEL_TRANSPORT']?.trim();
  if (raw === undefined || raw === '') {
    return 'none';
  }
  if (!(CHANNEL_TRANSPORTS as readonly string[]).includes(raw)) {
    issues.push({
      field: 'CONVO_CHANNEL_TRANSPORT',
      code: 'unsupported_value',
      message: `The channel transport must be one of: ${CHANNEL_TRANSPORTS.join(', ')}.`,
    });
    return 'none';
  }
  return raw as ChannelTransportName;
}
