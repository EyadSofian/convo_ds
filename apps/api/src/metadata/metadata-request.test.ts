import { describe, expect, it } from 'vitest';
import { ApiHttpError } from '../http-error.js';
import {
  parseBoolean,
  parseFieldCreate,
  parseFieldUpdate,
  parseLabelCreate,
  parseLabelUpdate,
  parseMutation,
  parseTarget,
  parseVersion,
} from './metadata-request.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function refused(work: () => unknown): void {
  expect(work).toThrow(ApiHttpError);
}

describe('metadata request parsing', () => {
  it('parses and normalizes labels', () => {
    expect(parseLabelCreate({ name: '  مهتم  ', color: '#aabbcc' })).toEqual({ name: 'مهتم', color: '#AABBCC' });
    expect(parseLabelUpdate({ version: 2, name: ' جديد ' })).toEqual({ version: 2, name: 'جديد' });
    expect(parseLabelUpdate({ version: 2, color: '#abcdef' })).toEqual({ version: 2, color: '#ABCDEF' });
    expect(parseLabelUpdate({ version: 2, name: 'جديد', color: '#abcdef' })).toEqual({ version: 2, name: 'جديد', color: '#ABCDEF' });
  });

  it.each([
    null, [], {}, { name: '', color: '#112233' }, { name: 'x', color: 'blue' },
    { name: 'x'.repeat(61), color: '#112233' },
  ])('refuses malformed label creation %#', (body) => refused(() => parseLabelCreate(body)));

  it.each([
    {}, { version: 0, name: 'x' }, { version: 1 }, { version: 1, name: '' },
    { version: 1, color: 'red' }, { version: Number.MAX_SAFE_INTEGER + 1, name: 'x' },
  ])('refuses malformed label updates %#', (body) => refused(() => parseLabelUpdate(body)));

  it('parses versions, targets and booleans', () => {
    expect(parseVersion({ version: 1 })).toBe(1);
    expect(parseTarget(undefined)).toBeNull();
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('contact')).toBe('contact');
    expect(parseTarget('conversation')).toBe('conversation');
    expect(parseBoolean(undefined)).toBe(false);
    expect(parseBoolean('false')).toBe(false);
    expect(parseBoolean('true')).toBe(true);
    refused(() => parseVersion({ version: -1 }));
    refused(() => parseTarget('account'));
    refused(() => parseBoolean('yes'));
  });

  it.each(['text', 'number', 'boolean', 'date'])('parses a %s field without options', (type) => {
    expect(parseFieldCreate({ target: 'contact', key: 'course_level', name: ' Course ', type, options: [] })).toMatchObject({
      target: 'contact', key: 'course_level', name: 'Course', type, options: [],
    });
  });

  it.each(['single_select', 'multi_select'])('parses a %s field with distinct options', (type) => {
    expect(parseFieldCreate({ target: 'conversation', key: 'stage', name: 'Stage', type, options: ['New', 'Won'] })).toMatchObject({
      type, options: ['New', 'Won'],
    });
  });

  it.each([
    null, [], {},
    { target: 'account', key: 'x', name: 'X', type: 'text', options: [] },
    { target: 'contact', key: 'Bad-Key', name: 'X', type: 'text', options: [] },
    { target: 'contact', key: 'x', name: '', type: 'text', options: [] },
    { target: 'contact', key: 'x', name: 'X', type: 'unknown', options: [] },
    { target: 'contact', key: 'x', name: 'X', type: 'text', options: ['no'] },
    { target: 'contact', key: 'x', name: 'X', type: 'single_select', options: [] },
    { target: 'contact', key: 'x', name: 'X', type: 'single_select', options: ['A', 'A'] },
    { target: 'contact', key: 'x', name: 'X', type: 'single_select', options: [''] },
    { target: 'contact', key: 'x', name: 'X', type: 'single_select', options: 'A' },
    { target: 'contact', key: 'x', name: 'X', type: 'single_select', options: Array.from({ length: 101 }, (_, i) => String(i)) },
  ])('refuses malformed field definitions %#', (body) => refused(() => parseFieldCreate(body)));

  it('parses definition updates', () => {
    expect(parseFieldUpdate({ version: 3, name: ' Level ' })).toEqual({ version: 3, name: 'Level' });
    expect(parseFieldUpdate({ version: 3, options: ['A', 'B'] })).toEqual({ version: 3, options: ['A', 'B'] });
    expect(parseFieldUpdate({ version: 3, name: 'Level', options: [] })).toEqual({ version: 3, name: 'Level', options: [] });
  });

  it.each([
    {}, { version: 1 }, { version: 0, name: 'x' }, { version: 1, name: '' },
    { version: 1, options: 'x' }, { version: 1, options: ['A', 'A'] },
  ])('refuses malformed definition updates %#', (body) => refused(() => parseFieldUpdate(body)));

  it('parses an atomic metadata mutation', () => {
    expect(parseMutation({ version: 4, addLabels: [ID], removeLabels: [OTHER], fields: [{ fieldId: ID, value: false }] })).toEqual({
      version: 4, addLabels: [ID], removeLabels: [OTHER], fields: [{ fieldId: ID, value: false }],
    });
    expect(parseMutation({ version: 4, fields: [{ fieldId: ID, value: null }] }).fields[0]?.value).toBeNull();
  });

  it.each([
    null, {}, { version: 1 }, { version: 1, addLabels: 'x' }, { version: 1, removeLabels: 'x' },
    { version: 1, addLabels: ['bad'] }, { version: 1, removeLabels: ['bad'] },
    { version: 1, addLabels: [ID], removeLabels: [ID] },
    { version: 1, fields: 'x' }, { version: 1, fields: [{}] },
    { version: 1, fields: [{ fieldId: ID }] },
    { version: 1, fields: [{ fieldId: 'bad', value: 'x' }] },
    { version: 1, fields: [{ fieldId: ID, value: 1 }, { fieldId: ID, value: 2 }] },
  ])('refuses malformed mutations %#', (body) => refused(() => parseMutation(body)));
});
