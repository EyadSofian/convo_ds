import type { Lang } from './format';

/**
 * Chooses the document language before the application module is evaluated.
 *
 * The hash is intentionally treated as a presentation-only input here. This
 * function knows only the closed `lang=en|ar` vocabulary; it cannot read or
 * establish a tenant, role, membership, identity, or authority.
 */
export function prepaintLanguage(hash: string, persisted: string | null): Lang {
  const route = languageInHash(hash);
  if (route !== null) return route;
  return persisted === 'en' || persisted === 'ar' ? persisted : 'ar';
}

function languageInHash(hash: string): Lang | null {
  const queryAt = hash.indexOf('?');
  if (queryAt === -1) return null;
  for (const part of hash.slice(queryAt + 1).split('&')) {
    const [rawKey, rawValue = ''] = part.split('=', 2);
    // String#split always produces an element at index 0, including for an
    // empty query segment; no undefined fallback is needed here.
    if (decode(rawKey!) !== 'lang') continue;
    const value = decode(rawValue);
    return value === 'en' || value === 'ar' ? value : null;
  }
  return null;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return '';
  }
}
