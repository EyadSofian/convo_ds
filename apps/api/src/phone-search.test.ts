import { describe, expect, it } from 'vitest';
import { phoneSearchPatterns } from './phone-search.js';

describe('phone search aliases', () => {
  it.each(['01012345678', '+20 10 1234-5678', '00201012345678', '٠١٠١٢٣٤٥٦٧٨', '۰۱۰۱۲۳۴۵۶۷۸'])('matches both Egyptian formats: %s', (input) => {
    expect([...phoneSearchPatterns(input)].sort()).toEqual(['%01012345678%', '%201012345678%']);
  });
  it('preserves other countries and partial numbers without treating names as phones', () => {
    expect(phoneSearchPatterns('+44 (7700) 900123')).toEqual(['%447700900123%']);
    expect(phoneSearchPatterns('45678')).toEqual(['%45678%']);
    for (const input of ['', '12', 'Ahmed', 'Agent 123', '%123', '---']) expect(phoneSearchPatterns(input)).toEqual([]);
  });
});
