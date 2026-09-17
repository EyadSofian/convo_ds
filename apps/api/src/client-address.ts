import type { ErrorDetail } from '@convo/contracts';
import type { EnvironmentSource } from '@convo/domain';

/**
 * How many reverse proxies sit in front of this process.
 *
 * This value exists because of a defect that made every IP-based control in the
 * product useless, and one of them dangerous:
 *
 * The browser never reaches the API directly. It talks to the public web
 * service, which reverse-proxies `/api/*` over Railway's private network. With
 * no proxy configuration, Fastify's `request.ip` was therefore the *web
 * service's* address — the same value for every user on the installation. The
 * consequences were not subtle:
 *
 * - `login-ip` became one shared bucket. Five failed logins from anybody locked
 *   **every** user out of the installation for fifteen minutes: a trivial,
 *   completely anonymous denial of service.
 * - `recovery:ip` and `recovery:complete` had the same defect.
 * - `ip_hash` on `user_sessions` recorded one value for every session, so the
 *   column answering "where was this session created" answered nothing.
 *
 * The naive fix — trust `X-Forwarded-For` — is worse than the bug. The header is
 * client-supplied, so trusting it unconditionally lets an attacker send a fresh
 * random address on every request and never be rate limited at all. That turns
 * a denial of service into an open credential-guessing oracle.
 *
 * So the hop count is **configuration** and it defaults to zero. Fastify's
 * `trustProxy` takes it and counts from the right — the end of the header that
 * a proxy we control appended, rather than the start, which is whatever the
 * client claimed. On Railway the correct value is 2: the Railway edge, then our
 * own web service. A spoofed prefix is then never read.
 *
 * The parsing lives in its own module rather than in `config.ts` so that this
 * explanation sits next to the value it explains, and so the bound is testable
 * without building a whole configuration.
 */

/** More than this many proxies in one path is a misconfiguration, not a topology. */
const MAX_HOPS = 8;

export function readTrustedProxyHops(env: EnvironmentSource, issues: ErrorDetail[]): number {
  const raw = env['CONVO_TRUSTED_PROXY_HOPS']?.trim();
  if (raw === undefined || raw === '') {
    // Zero, not one. A default that trusts a hop is wrong on any installation
    // reached directly, and wrong in the unsafe direction.
    return 0;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_HOPS) {
    issues.push({
      field: 'CONVO_TRUSTED_PROXY_HOPS',
      code: 'out_of_range',
      message: `The number of trusted proxies is an integer from 0 to ${String(MAX_HOPS)}.`,
    });
    return 0;
  }
  return value;
}

/**
 * The value Fastify's `trustProxy` option takes.
 *
 * `false` rather than `0`: Fastify treats a falsy number as "no proxy" anyway,
 * and saying so explicitly keeps the intent readable at the call site.
 */
/**
 * Fastify's `trustProxy`, expressed as the predicate form.
 *
 * Fastify accepts a bare hop count, but its exported option type in this
 * version does not include `number`, and the predicate form says the same thing
 * without a cast. `hop` is the distance inward from the socket, so
 * `hop < hops` trusts exactly the proxies we run and nothing beyond them.
 *
 * With `hops` of zero the predicate is always false, which is the safe default:
 * `X-Forwarded-For` is ignored entirely and the socket address is the client.
 */
export function trustProxyHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}
