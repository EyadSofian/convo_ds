import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import { fieldText, prepareTemplate, templateValuesFor } from './template-send.js';

const FIELD = '11111111-1111-4111-8111-111111111111';

/** Answers every query with the rows given, and records what was asked. */
function sql(rows: readonly unknown[]): SqlExecutor & { readonly asked: unknown[][] } {
  const asked: unknown[][] = [];
  return {
    asked,
    query: (_text: string, values?: readonly unknown[]) => {
      asked.push([...(values ?? [])]);
      return Promise.resolve({ rows, rowCount: rows.length }) as never;
    },
  } as SqlExecutor & { readonly asked: unknown[][] };
}

const TEMPLATE = {
  connection_id: 'cn-1', provider_template_id: 'meta-1', template_name: 'class_open', language: 'en',
  components: [{ type: 'BODY', text: 'Hi {{1}}, class on {{2}}.' }],
};

describe('filling a catalogue template for one recipient', () => {
  it('builds Meta’s components and a preview from values that fit exactly', async () => {
    expect(await prepareTemplate(sql([TEMPLATE]), 'tpl-1', { 'body:1': 'Mona', 'body:2': 'Sunday' })).toEqual({
      connectionId: 'cn-1', name: 'class_open', language: 'en', providerId: 'meta-1',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Mona' }, { type: 'text', text: 'Sunday' }] }],
      preview: 'Hi Mona, class on Sunday.',
    });
  });

  it('sends nothing for a template that is gone or values that no longer fit it', async () => {
    expect(await prepareTemplate(sql([]), 'tpl-1', {})).toBeNull();
    expect(await prepareTemplate(sql([TEMPLATE]), 'tpl-1', { 'body:1': 'Mona' })).toBeNull();
  });
});

describe('a contact’s values for a template', () => {
  it('reads the name, the number, a field and fixed text', async () => {
    const reader = sql([{ display_name: 'Mona', fields: { [FIELD]: 'B1, IELTS' } }]);
    expect(await templateValuesFor(reader, {
      'body:1': { source: 'display_name' },
      'body:2': { source: 'phone' },
      'body:3': { source: 'field', fieldId: FIELD },
      'body:4': { source: 'static', value: 'Sunday' },
    }, 'contact-1', '201000000001')).toEqual({ 'body:1': 'Mona', 'body:2': '201000000001', 'body:3': 'B1, IELTS', 'body:4': 'Sunday' });
    expect(reader.asked[0]).toEqual(['contact-1', [FIELD]]);
  });

  it('falls back where the contact has nothing, and is nothing for a contact that is gone', async () => {
    expect(await templateValuesFor(sql([{ display_name: 'Mona', fields: {} }]), { 'body:1': { source: 'field', fieldId: FIELD, fallback: 'English' } }, 'c', 'p'))
      .toEqual({ 'body:1': 'English' });
    expect(await templateValuesFor(sql([]), { 'body:1': { source: 'display_name' } }, 'c', 'p')).toBeNull();
  });

  it('shows a list field as joined text', () => {
    expect(fieldText('v')).toContain("string_agg(item, ', ')");
  });
});
