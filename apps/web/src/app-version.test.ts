/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { entryAsset, entryAssetFromMarkup, newerBundleAvailable } from './app-version.js';

function page(asset: string | null, pathname = '/'): Document {
  return {
    location: { pathname },
    querySelector: () => asset === null ? null : ({ getAttribute: () => asset }),
  } as unknown as Document;
}

describe('installed app release detection', () => {
  it('recognizes a different immutable entry without loading it or changing the current draft', async () => {
    const current = page('/assets/index-old.js');
    const fetchPage = async () => new Response('<script type="module" src="/assets/index-new.js"></script>');
    expect(entryAsset(current)).toBe('/assets/index-old.js');
    expect(entryAssetFromMarkup('<script src="/assets/index-new.js" crossorigin type="module"></script>')).toBe('/assets/index-new.js');
    expect(await newerBundleAvailable(current, fetchPage as typeof fetch)).toBe(true);
    expect(entryAsset(current)).toBe('/assets/index-old.js');
  });

  it('ignores the same release, failed checks and non-production entry scripts', async () => {
    const current = page('/assets/index-old.js');
    expect(await newerBundleAvailable(current, (async () => new Response('<script type="module" src="/assets/index-old.js"></script>')) as typeof fetch)).toBe(false);
    expect(await newerBundleAvailable(current, (async () => new Response('', { status: 503 })) as typeof fetch)).toBe(false);
    expect(await newerBundleAvailable(page('/src/main.ts'), (async () => new Response('')) as typeof fetch)).toBe(false);
    expect(await newerBundleAvailable(page(null), (async () => new Response('')) as typeof fetch)).toBe(false);
    expect(await newerBundleAvailable(current, (async () => new Response('<script type="module" src="/src/main.ts"></script>')) as typeof fetch)).toBe(false);
    expect(await newerBundleAvailable(current, (async () => new Response('<script type="module"></script>')) as typeof fetch)).toBe(false);
    expect(entryAssetFromMarkup('<script src="/assets/ignored.js"></script>')).toBeNull();
    expect(entryAssetFromMarkup('<script type="module"></script>')).toBeNull();
    let path = '';
    await newerBundleAvailable(page('/assets/index-old.js', ''), (async (input) => {
      path = String(input);
      return new Response('<script type="module" src="/assets/index-old.js"></script>');
    }) as typeof fetch);
    expect(path).toBe('/');
  });
});
