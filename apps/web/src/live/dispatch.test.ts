import { describe, expect, it } from 'vitest';
import { roleNameField, splitArg, teamMemberField } from './dispatch.js';

/**
 * The naming rules the DOM and the dispatcher have to agree on.
 *
 * A form value reaches the dispatcher as `"<key>:<value>"`, so a key that
 * contains a colon stores the wrong thing under the wrong name — silently, and
 * only for the controls that happen to use one. These are the two places that
 * build such a key, and the one function that takes it apart again.
 */

describe('splitArg', () => {
  it('splits an id from its value', () => {
    expect(splitArg('m-1:supervisor')).toEqual({ id: 'm-1', value: 'supervisor' });
  });

  it('keeps everything after the first colon, because a value may contain one', () => {
    expect(splitArg('t-1:a:b')).toEqual({ id: 't-1', value: 'a:b' });
  });

  it('reads an argument with no separator as all id and no value', () => {
    // What a control rendered without a form key produces. Answering rather
    // than throwing keeps one malformed control from taking the screen down;
    // the empty value is then rejected by the parser on the server.
    expect(splitArg('t-1')).toEqual({ id: 't-1', value: '' });
    expect(splitArg('')).toEqual({ id: '', value: '' });
  });
});

describe('form keys', () => {
  it('never contain the separator the DOM uses', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(teamMemberField(id)).toBe(`teamMember_${id}`);
    expect(roleNameField(id)).toBe(`roleName_${id}`);
    expect(teamMemberField(id)).not.toContain(':');
    expect(roleNameField(id)).not.toContain(':');
  });
});
