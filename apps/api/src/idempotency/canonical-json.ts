import { createHmac } from 'node:crypto';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function requestHash(value: JsonValue, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key] as JsonValue))
      .join(',') +
    '}'
  );
}
