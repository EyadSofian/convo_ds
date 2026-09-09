import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Keeping the exact request bytes, for the routes whose authentication is a
 * signature over them.
 *
 * Fastify's JSON parser hands the route an object. Re-serializing that object
 * to check a signature verifies a document the sender never signed: key order,
 * whitespace, number formatting and unicode escaping are all free to differ,
 * and every one of them changes the HMAC. So the parser for the webhook paths
 * keeps the buffer and parses nothing — the ingress service parses, later, and
 * only after the signature has held (EVT-01, CH-WA-02).
 *
 * It is scoped to the webhook prefix rather than applied globally so that the
 * rest of the API keeps its ordinary JSON body parsing and its body limit.
 */

const RAW_BODIES = new WeakMap<object, Uint8Array>();

const WEBHOOK_PREFIX = '/api/v1/webhooks/';

/** Body cap for a signed delivery. Meta batches are small; this is generous. */
export const WEBHOOK_BODY_LIMIT = 512 * 1024;

export function attachRawBodyParser(server: FastifyInstance): void {
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
    (request, body, done) => {
      const buffer = body as Buffer;
      if (!request.url.startsWith(WEBHOOK_PREFIX)) {
        // Everything else behaves exactly as the default parser did.
        try {
          done(null, buffer.length === 0 ? undefined : JSON.parse(buffer.toString('utf8')));
        } catch (error) {
          const failure = error as Error & { statusCode?: number };
          failure.statusCode = 400;
          done(failure, undefined);
        }
        return;
      }
      RAW_BODIES.set(request, new Uint8Array(buffer));
      // The route gets no parsed body at all. Nothing downstream can
      // accidentally trust a field before the signature has been checked.
      done(null, undefined);
    },
  );
}

/**
 * The bytes as received.
 *
 * An empty array when the parser did not run — a request with no body, or a
 * content type we do not parse. The signature check then fails on a mismatch,
 * which is the correct answer for a request that carried nothing to sign.
 */
export function rawBodyOf(request: FastifyRequest): Uint8Array {
  return RAW_BODIES.get(request) ?? new Uint8Array(0);
}
