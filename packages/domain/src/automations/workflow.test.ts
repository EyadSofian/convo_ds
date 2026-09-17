import { describe, expect, it } from 'vitest';
import { AUTOMATION_STEP_TYPES, AUTOMATION_TRIGGERS, validateAutomationWorkflow, validateVariableMapping } from './workflow.js';
const base = { version: 1, trigger: { type: 'manual', config: {} }, target: { type: 'single_customer', config: {} }, steps: [{ id: 'send', type: 'send_whatsapp_template', config: {} }], safety: { approvalRequired: false, duplicateWindowSeconds: 3600 } };
describe('automation workflow contract', () => {
  it('accepts every trigger and step extension point', () => { for (const type of AUTOMATION_TRIGGERS) expect(validateAutomationWorkflow({ ...base, trigger: { type, config: {} }, ...(type === 'schedule' ? { schedule: { kind: 'daily', time: '09:00' } } : {}) }).ok).toBe(true); for (const type of AUTOMATION_STEP_TYPES) { const step = type === 'condition' ? { id: 'step', type, config: {}, conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'trigger', operator: 'eq', value: 'manual' }] } } } : { id: 'step', type, config: {} }; expect(validateAutomationWorkflow({ ...base, steps: [step] }).ok).toBe(true); } });
  it('rejects malformed, duplicate and unbounded workflows', () => { expect(validateAutomationWorkflow(null).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, version: 2 }).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, trigger: { type: 'magic', config: {} } }).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, target: { type: 'everyone', config: {} } }).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, steps: [] }).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, steps: [base.steps[0], base.steps[0]] }).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, safety: { approvalRequired: true, duplicateWindowSeconds: -1 } }).ok).toBe(false); expect(validateAutomationWorkflow({ ...base, schedule: [] }).ok).toBe(false);
    // A step id that is not a string, and one that is a string of the wrong
    // shape: three separate ways into the same refusal, and each needs its own
    // case or two of the three go unexercised.
    expect(validateAutomationWorkflow({ ...base, steps: [{ id: 7, type: 'delay', config: {} }] }).ok).toBe(false);
    expect(validateAutomationWorkflow({ ...base, steps: [{ id: 'Not Valid', type: 'delay', config: {} }] }).ok).toBe(false);
    // A schedule trigger with no schedule: the one combination the validator
    // has to reject on a relationship between two fields rather than on either.
    expect(validateAutomationWorkflow({ ...base, trigger: { type: 'schedule', config: {} } }).ok).toBe(false);
    // A step whose type is unknown, and one whose config is not an object:
    // both are "invalid_step", reached by different halves of the same guard.
    expect(validateAutomationWorkflow({ ...base, steps: [{ id: 'step', type: 'teleport', config: {} }] }).ok).toBe(false);
    expect(validateAutomationWorkflow({ ...base, steps: [{ id: 'step', type: 'delay', config: null }] }).ok).toBe(false);
    // A condition step carrying a condition document that does not validate.
    expect(validateAutomationWorkflow({ ...base, steps: [{ id: 'step', type: 'condition', config: {}, conditions: { version: 99 } }] }).ok).toBe(false); });
  it('requires a complete, closed variable map', () => { expect(validateVariableMapping({ '1': { type: 'customer_field', field: 'first_name' } }, ['1'])).toEqual([]); expect(validateVariableMapping({}, ['1'])).toEqual([{ path: '$.1', code: 'required' }]); expect(validateVariableMapping({ '2': { type: 'static', value: 'x' } }, ['1'])).toHaveLength(2); expect(validateVariableMapping(null, ['1'])).toEqual([{ path: '$', code: 'invalid_mapping' }]); });
});
