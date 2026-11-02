import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';
import type { CountryCode } from 'libphonenumber-js/min';

const COUNTRIES = getCountries();

export function quickWhatsAppNumber(raw: string, country = 'EG'): string | null {
  const input = raw.trim().replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776)).replace(/^00/, '+');
  if (!COUNTRIES.includes(country as CountryCode) || !/^\+?[0-9\s().-]+$/.test(input)) return null;
  const phone = parsePhoneNumberFromString(input, { defaultCountry: country as CountryCode, extract: false });
  return phone?.isValid() ? phone.number : null;
}

export function quickWhatsAppCountries(lang: 'ar' | 'en'): readonly { value: string; label: string }[] {
  const names = new Intl.DisplayNames([lang], { type: 'region' });
  return COUNTRIES.map((country) => ({ value: country, label: `${names.of(country)} +${getCountryCallingCode(country)}` }))
    .sort((a, b) => a.value === 'EG' ? -1 : b.value === 'EG' ? 1 : a.label.localeCompare(b.label, lang));
}
