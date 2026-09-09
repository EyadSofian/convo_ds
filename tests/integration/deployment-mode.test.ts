import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseInstallationConfig } from '../../packages/domain/src/installation/config.js';
import { describeInstance } from '../../packages/contracts/src/instance.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_ROOTS = [path.join(ROOT, 'packages'), path.join(ROOT, 'apps')];

async function firstPartySources(): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules') {
          await walk(full);
        }
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  }
  for (const sourceRoot of SOURCE_ROOTS) {
    await walk(sourceRoot);
  }
  return files;
}

/**
 * MODE-01's security property is not "the value is validated" -- it is that
 * there is nowhere else to read it from. A grep is a blunt instrument, but it
 * is the one that keeps being true as the codebase grows: the day someone adds
 * `process.env.CONVO_DEPLOYMENT_MODE` to a request handler, this fails.
 */
describe('deployment mode is trusted installation config (MODE-01)', () => {
  it('is read from the environment in exactly one module', async () => {
    const sources = await firstPartySources();
    expect(sources.length).toBeGreaterThan(5);

    const mentioning: string[] = [];
    for (const file of sources) {
      const contents = await readFile(file, 'utf8');
      if (contents.includes('CONVO_DEPLOYMENT_MODE')) {
        mentioning.push(path.relative(ROOT, file));
      }
    }
    expect(mentioning).toEqual(['packages/domain/src/installation/config.ts']);
  });

  it('never touches process.env outside the configuration and CLI entry modules', async () => {
    const sources = await firstPartySources();
    const offenders: string[] = [];
    for (const file of sources) {
      const contents = await readFile(file, 'utf8');
      if (/process\.env/.test(contents)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    // Listed one by one rather than by pattern, so adding a file to this set is
    // a deliberate edit here. The two process entry points read their own
    // environment; the Vite config is a build-tool file that runs on the
    // developer's machine and is not part of any shipped artifact.
    expect(offenders.sort()).toEqual([
      'apps/api/src/main.ts',
      'apps/web/vite.config.ts',
      'packages/database/src/bin.ts',
    ]);
  });

  it('produces a public descriptor whose mode comes from the parsed config', () => {
    const config = parseInstallationConfig({
      CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
      CONVO_INSTALLATION_NAME: 'Acme On-Prem',
      CONVO_PUBLIC_BASE_URL: 'https://convo.acme.internal',
    });

    const descriptor = describeInstance({
      deploymentMode: config.deploymentMode,
      installationName: config.installationName,
      defaultLocale: config.defaultLocale,
      supportedLocales: config.supportedLocales,
      bootstrapRequired: true,
      ssoConfigured: config.ssoConfigured,
      mfaAvailable: config.mfaAvailable,
    });

    expect(descriptor).toEqual({
      apiVersion: 'v1',
      deploymentMode: 'self_hosted_single',
      installationName: 'Acme On-Prem',
      defaultLocale: 'ar',
      supportedLocales: ['ar', 'en'],
      bootstrapRequired: true,
      capabilities: {
        multiTenant: false,
        selfServiceSignup: false,
        ssoConfigured: false,
        mfaAvailable: true,
      },
    });
    expect(JSON.stringify(descriptor)).not.toContain('convo.acme.internal');
  });
});
