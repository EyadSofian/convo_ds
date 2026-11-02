import { describe, expect, it } from 'vitest';
import { quickWhatsAppCountries, quickWhatsAppNumber } from './quick-whatsapp-phone.js';

describe('quick WhatsApp phone entry', () => {
  it('accepts Egyptian local, international, pasted and Arabic-digit numbers without repeating the calling code', () => {
    for (const raw of ['01012345678', '1012345678', '+201012345678', '201012345678', '00201012345678', '٠١٠١٢٣٤٥٦٧٨', '۰۱۰۱۲۳۴۵۶۷۸', '+20 (10) 1234-5678']) {
      expect(quickWhatsAppNumber(raw)).toBe('+201012345678');
    }
    expect(quickWhatsAppNumber('0501234567', 'SA')).toBe('+966501234567');
    expect(quickWhatsAppNumber('+447911123456', 'EG')).toBe('+447911123456');
  });
  it('rejects short, malformed, extended and unsupported-country input', () => {
    for (const raw of ['', '123', '0101234567890123456', 'call +201012345678', '+201012345678 x12', '+']) expect(quickWhatsAppNumber(raw)).toBeNull();
    expect(quickWhatsAppNumber('01012345678', 'XX')).toBeNull();
  });
  it('offers localized countries with Egypt first', () => {
    expect(quickWhatsAppCountries('ar')[0]).toEqual({ value: 'EG', label: 'مصر +20' });
    expect(quickWhatsAppCountries('en')).toContainEqual({ value: 'SA', label: 'Saudi Arabia +966' });
  });
});
