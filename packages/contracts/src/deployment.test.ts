import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_MODES, UI_LOCALES, isDeploymentMode, isUiLocale } from './deployment.js';

describe('deployment mode vocabulary', () => {
  it('accepts exactly the two supported modes', () => {
    expect([...DEPLOYMENT_MODES]).toEqual(['saas', 'self_hosted_single']);
    expect(isDeploymentMode('saas')).toBe(true);
    expect(isDeploymentMode('self_hosted_single')).toBe(true);
  });

  it.each([
    ['a near miss', 'self-hosted-single'],
    ['a plausible synonym nobody agreed on', 'onprem'],
    ['an empty string', ''],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an object claiming to be one', { toString: () => 'saas' }],
  ])('rejects %s', (_label, value) => {
    expect(isDeploymentMode(value)).toBe(false);
  });

  it('accepts exactly the two shipped UI locales', () => {
    expect([...UI_LOCALES]).toEqual(['ar', 'en']);
    expect(isUiLocale('ar')).toBe(true);
    expect(isUiLocale('en')).toBe(true);
    expect(isUiLocale('ar-EG')).toBe(false);
    expect(isUiLocale(42)).toBe(false);
  });
});
