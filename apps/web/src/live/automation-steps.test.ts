import { describe, expect, it } from 'vitest';
import type { AutomationStep } from '../api/automations.js';
import type { CustomField } from '../api/metadata.js';
import { delayParts, RUNNABLE_STEPS, runnable, stepConfigFrom } from './automation-steps.js';

const SEATS: CustomField = { id: 'f-seats', target: 'contact', key: 'seats', name: 'Seats', type: 'number', options: [], state: 'active', version: 1 };
const step = (type: AutomationStep['type'], config: Record<string, unknown> = {}): AutomationStep => ({ id: 's1', type, config });

describe('runnable steps', () => {
  it('offers exactly what the executor runs', () => {
    expect(RUNNABLE_STEPS).toEqual(['delay', 'send_whatsapp_template', 'add_label', 'remove_label', 'update_customer_field']);
    expect(runnable('delay')).toBe(true);
    expect(runnable('webhook')).toBe(false);
  });
});

describe('delayParts', () => {
  it('reads a stored delay in its largest whole unit, and defaults to an hour', () => {
    expect(delayParts({ seconds: 172_800 })).toEqual({ amount: 2, unit: 'days' });
    expect(delayParts({ seconds: 7200 })).toEqual({ amount: 2, unit: 'hours' });
    expect(delayParts({ seconds: 900 })).toEqual({ amount: 15, unit: 'minutes' });
    for (const config of [{}, { seconds: '60' }, { seconds: 1.5 }, { seconds: 30 }]) expect(delayParts(config)).toEqual({ amount: 1, unit: 'hours' });
  });
});

describe('stepConfigFrom', () => {
  it('builds a delay from the amount and unit typed, or keeps what was stored', () => {
    expect(stepConfigFrom({ automationDelay_s1: '3', automationDelayUnit_s1: 'days' }, step('delay'), 'delay', [])).toEqual({ seconds: 259_200 });
    expect(stepConfigFrom({}, step('delay', { seconds: 900 }), 'delay', [])).toEqual({ seconds: 900 });
    expect(stepConfigFrom({ automationDelayUnit_s1: 'fortnights' }, step('delay'), 'delay', [])).toEqual({ seconds: 3600 });
  });

  it('names a label, or nothing until one is chosen', () => {
    expect(stepConfigFrom({ automationLabel_s1: 'l-1' }, step('add_label'), 'add_label', [])).toEqual({ labelId: 'l-1' });
    expect(stepConfigFrom({}, step('remove_label', { labelId: 'l-2' }), 'remove_label', [])).toEqual({ labelId: 'l-2' });
    expect(stepConfigFrom({}, step('add_label'), 'add_label', [])).toEqual({});
  });

  it('writes a field value in the field’s own type', () => {
    expect(stepConfigFrom({ automationField_s1: 'f-seats', automationFieldValue_s1: '4' }, step('update_customer_field'), 'update_customer_field', [SEATS]))
      .toEqual({ fieldId: 'f-seats', value: 4 });
    expect(stepConfigFrom({ automationField_s1: 'f-gone', automationFieldValue_s1: 'x' }, step('update_customer_field'), 'update_customer_field', [SEATS]))
      .toEqual({ fieldId: 'f-gone', value: 'x' });
    expect(stepConfigFrom({}, step('update_customer_field', { fieldId: 'f-seats', value: 2 }), 'update_customer_field', [SEATS]))
      .toEqual({ fieldId: 'f-seats', value: 2 });
    expect(stepConfigFrom({ automationFieldValue_s1: '' }, step('update_customer_field', { fieldId: 'f-seats', value: 2 }), 'update_customer_field', [SEATS]))
      .toEqual({ fieldId: 'f-seats' });
    expect(stepConfigFrom({}, step('update_customer_field'), 'update_customer_field', [])).toEqual({});
  });

  it('starts a changed kind from nothing, and keeps any other kind as it was', () => {
    expect(stepConfigFrom({}, step('add_label', { labelId: 'l-1' }), 'update_customer_field', [])).toEqual({});
    expect(stepConfigFrom({}, step('webhook', { url: 'https://x' }), 'webhook', [])).toEqual({ url: 'https://x' });
  });
});
