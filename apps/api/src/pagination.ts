import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CursorBinding {
  readonly tenantId: string;
  readonly filterHash: string;
  readonly sort: string;
}

export interface CursorPosition {
  readonly value: string;
  readonly id: string;
}

export type CursorDecodeResult =
  | { readonly status: 'valid'; readonly after: CursorPosition }
  | {
      readonly status: 'rejected';
      readonly code: 'cursor_invalid' | 'cursor_expired';
      readonly message: string;
    };

export interface PageEnvelope<T> {
  readonly data: readonly T[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
  readonly request_id: string;
}

interface CursorPayload {
  readonly v: 1;
  readonly tenant_id: string;
  readonly filter_hash: string;
  readonly sort: string;
  readonly value: string;
  readonly id: string;
  readonly exp: number;
}

export class OpaqueCursorCodec {
  private readonly secret: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('Cursor signing secret must contain at least 32 bytes.');
    }
    this.secret = Buffer.from(secret, 'utf8');
  }

  encode(binding: CursorBinding, after: CursorPosition, ttlSeconds: number): string {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new Error('Cursor TTL must be a positive integer.');
    }
    const payload: CursorPayload = {
      v: 1,
      tenant_id: binding.tenantId,
      filter_hash: binding.filterHash,
      sort: binding.sort,
      value: after.value,
      id: after.id,
      exp: Math.floor(this.now() / 1000) + ttlSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return encoded + '.' + this.sign(encoded);
  }

  decode(cursor: string, binding: CursorBinding): CursorDecodeResult {
    if (cursor.length > 4096) {
      return invalidCursor();
    }
    const parts = cursor.split('.');
    const encoded = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || encoded === undefined || signature === undefined) {
      return invalidCursor();
    }
    const expected = Buffer.from(this.sign(encoded), 'base64url');
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return invalidCursor();
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    } catch {
      return invalidCursor();
    }
    if (!isCursorPayload(decoded)) {
      return invalidCursor();
    }
    if (
      decoded.tenant_id !== binding.tenantId ||
      decoded.filter_hash !== binding.filterHash ||
      decoded.sort !== binding.sort
    ) {
      return invalidCursor();
    }
    if (decoded.exp <= Math.floor(this.now() / 1000)) {
      return {
        status: 'rejected',
        code: 'cursor_expired',
        message: 'This page cursor expired. Refresh the list from the beginning.',
      };
    }
    return {
      status: 'valid',
      after: { value: decoded.value, id: decoded.id },
    };
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.secret).update(encoded).digest('base64url');
  }
}

export function pageEnvelope<T>(
  data: readonly T[],
  nextCursor: string | null,
  requestId: string,
): PageEnvelope<T> {
  return {
    data,
    page: { next_cursor: nextCursor, has_more: nextCursor !== null },
    request_id: requestId,
  };
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const payload = value as Partial<CursorPayload>;
  return (
    payload.v === 1 &&
    typeof payload.tenant_id === 'string' &&
    typeof payload.filter_hash === 'string' &&
    typeof payload.sort === 'string' &&
    typeof payload.value === 'string' &&
    typeof payload.id === 'string' &&
    Number.isInteger(payload.exp)
  );
}

function invalidCursor(): CursorDecodeResult {
  return {
    status: 'rejected',
    code: 'cursor_invalid',
    message: 'This page cursor is invalid. Refresh the list from the beginning.',
  };
}
