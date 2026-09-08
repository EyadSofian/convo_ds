import { createHash, timingSafeEqual } from 'node:crypto';

export function bootstrapTokenMatches(
  provided: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof provided !== 'string') {
    return false;
  }
  const actualDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
