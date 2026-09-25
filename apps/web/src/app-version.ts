/**
 * Vite gives each release an immutable entry filename. The document is served
 * with no-cache, so comparing that filename with the running one detects a new
 * deployment without a mutable service-worker cache or a privileged API.
 */
export function entryAsset(document: Document): string | null {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null;
}

/** Read script attributes from fetched HTML without executing it. */
export function entryAssetFromMarkup(html: string): string | null {
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src !== undefined) return src;
  }
  return null;
}

export async function newerBundleAvailable(document: Document, fetchPage: typeof fetch): Promise<boolean> {
  const current = entryAsset(document);
  if (current === null || !current.startsWith('/assets/')) return false;
  const response = await fetchPage(document.location.pathname || '/', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) return false;
  const candidate = entryAssetFromMarkup(await response.text());
  return candidate !== null && candidate.startsWith('/assets/') && candidate !== current;
}
