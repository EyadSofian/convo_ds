import { describe, expect, it } from 'vitest';
import { prepaintLanguage } from './prepaint-language';

describe('prepaintLanguage', () => {
  it('uses an explicit English deep-link before any stored preference', () => {
    expect(prepaintLanguage('#/automations?view=mine&edit=draft-1&lang=en', null)).toBe('en');
    expect(prepaintLanguage('#/automations?lang=en', 'ar')).toBe('en');
  });

  it('uses an explicit Arabic deep-link before any stored preference', () => {
    expect(prepaintLanguage('#/automations?edit=draft-1&lang=ar', null)).toBe('ar');
    expect(prepaintLanguage('#/automations?lang=ar', 'en')).toBe('ar');
  });

  it('uses the persisted presentation preference only when the route omits language', () => {
    expect(prepaintLanguage('#/automations?view=mine', 'en')).toBe('en');
  });

  it('defaults to Arabic for missing or invalid presentation values', () => {
    expect(prepaintLanguage('#/automations?lang=fr', null)).toBe('ar');
    expect(prepaintLanguage('#/automations?lang=%E0%A4', 'fr')).toBe('ar');
    expect(prepaintLanguage('#/automations', null)).toBe('ar');
  });

  it('does not treat unrelated hash parameters as authority inputs', () => {
    expect(prepaintLanguage('#/inbox?tenant=other&role=owner&membership=x', 'en')).toBe('en');
  });
});
