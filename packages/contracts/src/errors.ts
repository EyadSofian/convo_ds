/**
 * The single error envelope required by MASTER-PROMPT section 8.
 *
 * `code` is the machine-readable contract and is stable across releases;
 * `message` is safe to show a human and must never carry a secret, another
 * tenant's identifiers, or a raw driver error.
 */
export interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly request_id: string | null;
  readonly details: readonly ErrorDetail[];
}

export interface ErrorDetail {
  /** Dotted path into the rejected input, or a configuration key. */
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export function errorEnvelope(
  code: string,
  message: string,
  options: { readonly requestId?: string; readonly details?: readonly ErrorDetail[] } = {},
): ErrorEnvelope {
  return {
    code,
    message,
    request_id: options.requestId ?? null,
    details: options.details ?? [],
  };
}
