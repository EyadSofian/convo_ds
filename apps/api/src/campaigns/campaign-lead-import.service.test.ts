import { describe, expect, it } from 'vitest';
import { normalizeLeadMobile, parseLeadImport } from './campaign-lead-import.service';

describe('campaign lead import boundary', () => {
  it('normalizes Egyptian national and explicit international numbers', () => {
    expect(normalizeLeadMobile('010 1234 5678')).toBe('201012345678');
    expect(normalizeLeadMobile('+20 (10) 1234-5678')).toBe('201012345678');
    expect(normalizeLeadMobile('00201012345678')).toBe('201012345678');
    expect(normalizeLeadMobile('1012345678')).toBe('201012345678');
    expect(normalizeLeadMobile('1234')).toBeNull();
    expect(normalizeLeadMobile('0101234567x')).toBeNull();
  });

  it('refuses overlarge or malformed payloads', () => {
    expect(() => parseLeadImport({ connectionId: 'bad', campaignName: 'Test', rows: [] })).toThrow();
  });
});
