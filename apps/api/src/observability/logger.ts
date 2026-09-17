/**
 * Structured logging.
 *
 * Before this, the product's entire production observability was three
 * `console.log` calls in `main.ts`. That is not a small gap: an operator asked
 * "why did that invitation fail" had nothing to search, nothing to correlate a
 * request across the API and a worker with, and no way to tell one company's
 * traffic from another's.
 *
 * One line of JSON per event, on stdout, because that is what every log
 * collector this will ever run under already understands — Railway included. No
 * transport, no rotation, no file handles: the platform owns all three, and a
 * logging library that owns them too is a second place for them to be wrong.
 *
 * ## What must never be logged
 *
 * The redaction below is a deny-list *and* a structural rule, because a
 * deny-list alone always loses eventually. The structural rule is that this
 * module only ever writes the fields a caller names — it never serializes a
 * request, a response, a row, an error object or a headers bag, so there is no
 * path by which a cookie or an `Authorization` header reaches a line by
 * accident. The deny-list then catches the case where a caller names a field
 * badly.
 *
 * Message content is not logged at any level. Not truncated, not hashed: a
 * customer's message to a school is the most sensitive thing this system holds,
 * and the operational questions ("did it send", "how long did it take", "what
 * did the provider say") are all answerable from ids and codes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Field names whose values are replaced with `[redacted]` wherever they appear.
 *
 * Matched case-insensitively and by substring, so `csrfToken`, `x-csrf-token`
 * and `csrf` are all caught by one entry.
 */
const REDACTED = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'credential',
  'csrf',
  'hash',
  'signature',
  'body',
  'payload',
  'content',
  'text',
] as const;

export interface LogFields {
  readonly request_id?: string | undefined;
  readonly tenant_id?: string | undefined;
  readonly user_id?: string | undefined;
  readonly conversation_id?: string | undefined;
  readonly job_id?: string | undefined;
  readonly worker_role?: string | undefined;
  readonly route?: string | undefined;
  readonly method?: string | undefined;
  readonly status?: number | undefined;
  readonly duration_ms?: number | undefined;
  readonly error_code?: string | undefined;
  readonly [field: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that carries fields on every line. Used per request and per job. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly service: string;
  readonly processRole: string;
  readonly level?: LogLevel;
  /** Injected so a test can read lines instead of a process's stdout. */
  readonly write?: (line: string) => void;
  /** Injected so a test can assert on a timestamp. */
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_ORDER[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  function emit(level: LogLevel, base: LogFields, event: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < minimum) {
      return;
    }
    const line: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level,
      service: options.service,
      process_role: options.processRole,
      event,
    };
    for (const [name, value] of Object.entries({ ...base, ...fields })) {
      if (value === undefined) {
        continue;
      }
      line[name] = redactedName(name) ? '[redacted]' : safe(value);
    }
    write(JSON.stringify(line));
  }

  function build(base: LogFields): Logger {
    return {
      debug: (event, fields) => {
        emit('debug', base, event, fields ?? {});
      },
      info: (event, fields) => {
        emit('info', base, event, fields ?? {});
      },
      warn: (event, fields) => {
        emit('warn', base, event, fields ?? {});
      },
      error: (event, fields) => {
        emit('error', base, event, fields ?? {});
      },
      child: (fields) => build({ ...base, ...fields }),
    };
  }

  return build({});
}

export function redactedName(name: string): boolean {
  const lowered = name.toLowerCase();
  return REDACTED.some((needle) => lowered.includes(needle));
}

/**
 * What a field value is allowed to be.
 *
 * Primitives pass through. An Error becomes its message — never its stack,
 * which carries filesystem paths and, from a database driver, sometimes a
 * connection string. Anything else becomes its type name rather than being
 * serialized, which is the structural half of the rule at the top of this file:
 * there is no way to accidentally log an object's contents, because objects are
 * never expanded.
 */
function safe(value: unknown): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return value.message;
  return `[${kind}]`;
}

/**
 * The level this process logs at.
 *
 * `info` by default. `debug` exists for an operator chasing something specific
 * and is never the default, because a debug-level default is how a log bill and
 * a disk fill up at the same time.
 */
export function readLogLevel(env: Readonly<Record<string, string | undefined>>): LogLevel {
  const raw = env['CONVO_LOG_LEVEL']?.trim().toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}
