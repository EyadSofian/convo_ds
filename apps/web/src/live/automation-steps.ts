import type { AutomationStep } from '../api/automations.js';
import type { CustomField } from '../api/metadata.js';
import { typedValue } from './contact-profile.js';

/**
 * Configuring an automation step in the builder.
 *
 * The executor runs five kinds of step today. The builder offers those, keeps
 * any other kind a draft already holds visible — marked, so activation's
 * refusal is no surprise — and turns what the operator typed into the config
 * the executor reads.
 */

export type StepType = AutomationStep['type'];

/** Step kinds the executor can run, in the order the builder offers them. */
export const RUNNABLE_STEPS: readonly StepType[] = ['delay', 'send_whatsapp_template', 'add_label', 'remove_label', 'update_customer_field'];

/** The form-key prefix of one template step's variables, so two steps never share one. */
export function automationPrefix(stepId: string): string {
  return `automationParam_${stepId}_`;
}

export function runnable(type: string): boolean {
  return (RUNNABLE_STEPS as readonly string[]).includes(type);
}

export type DelayUnit = 'minutes' | 'hours' | 'days';

export const DELAY_UNITS: Readonly<Record<DelayUnit, number>> = { minutes: 60, hours: 3600, days: 86_400 };

/** A stored delay in the largest whole unit, so "86400" reads as "1 day". */
export function delayParts(config: Readonly<Record<string, unknown>>): { readonly amount: number; readonly unit: DelayUnit } {
  const seconds = config['seconds'];
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 60) return { amount: 1, unit: 'hours' };
  if (seconds % DELAY_UNITS.days === 0) return { amount: seconds / DELAY_UNITS.days, unit: 'days' };
  if (seconds % DELAY_UNITS.hours === 0) return { amount: seconds / DELAY_UNITS.hours, unit: 'hours' };
  return { amount: Math.round(seconds / DELAY_UNITS.minutes), unit: 'minutes' };
}

function stored(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The config a step saves with: what was typed for the kind now chosen,
 * falling back to what the step held when that kind was already its own. A
 * kind that changed starts from nothing, so a label id never leaks into a
 * field step.
 */
export function stepConfigFrom(
  form: Readonly<Record<string, string>>,
  step: AutomationStep,
  type: StepType,
  fields: readonly CustomField[],
): Readonly<Record<string, unknown>> {
  const own = type === step.type ? step.config : {};
  if (type === 'delay') {
    const parts = delayParts(own);
    const unit = form[`automationDelayUnit_${step.id}`] ?? parts.unit;
    const amount = Number(form[`automationDelay_${step.id}`] ?? String(parts.amount));
    return { seconds: Math.round(amount * (DELAY_UNITS[unit as DelayUnit] ?? DELAY_UNITS.hours)) };
  }
  if (type === 'add_label' || type === 'remove_label') {
    const labelId = form[`automationLabel_${step.id}`] ?? stored(own, 'labelId');
    return labelId === '' ? {} : { labelId };
  }
  if (type === 'update_customer_field') {
    const fieldId = form[`automationField_${step.id}`] ?? stored(own, 'fieldId');
    const typed = form[`automationFieldValue_${step.id}`];
    const definition = fields.find((field) => field.id === fieldId);
    // The value is written in the field's own type, as the profile would write it.
    const value = typed === undefined ? own['value'] : definition === undefined ? typed : typedValue(definition.type, typed);
    return fieldId === '' ? {} : value === undefined || value === null ? { fieldId } : { fieldId, value };
  }
  return own;
}
