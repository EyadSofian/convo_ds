import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, API_POOL } from '../tokens.js';
import { tokenFingerprint } from './auth-tokens.js';

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 5;

export type RateLimitDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'blocked'; readonly retryAfterSeconds: number };

@Injectable()
export class AuthRateLimiter {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_POOL) private readonly pool: Pool,
  ) {}

  async consume(bucket: string, subject: string): Promise<RateLimitDecision> {
    const bucketHash = this.bucketHash(bucket, subject);
    const result = await this.pool.query<{ attempt_count: number; retry_after_seconds: number }>(
      `INSERT INTO auth_rate_limits
         (bucket_hash, window_started_at, attempt_count, expires_at)
       VALUES ($1, now(), 1, now() + $2 * interval '1 second')
       ON CONFLICT (bucket_hash) DO UPDATE SET
         attempt_count = CASE
           WHEN auth_rate_limits.window_started_at <= now() - $2 * interval '1 second' THEN 1
           ELSE auth_rate_limits.attempt_count + 1
         END,
         window_started_at = CASE
           WHEN auth_rate_limits.window_started_at <= now() - $2 * interval '1 second' THEN now()
           ELSE auth_rate_limits.window_started_at
         END,
         expires_at = now() + $2 * interval '1 second'
       RETURNING attempt_count,
         greatest(1, ceil(extract(epoch FROM
           (window_started_at + $2 * interval '1 second' - now()))))::integer
           AS retry_after_seconds`,
      [bucketHash, WINDOW_SECONDS],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Rate limit counter did not return a result');
    }
    return row.attempt_count <= MAX_ATTEMPTS
      ? { status: 'allowed' }
      : { status: 'blocked', retryAfterSeconds: row.retry_after_seconds };
  }

  async reset(bucket: string, subject: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_rate_limits WHERE bucket_hash = $1', [
      this.bucketHash(bucket, subject),
    ]);
  }

  private bucketHash(bucket: string, subject: string): string {
    return tokenFingerprint(this.config.secrets.authHash, 'rate:' + bucket, subject);
  }
}
