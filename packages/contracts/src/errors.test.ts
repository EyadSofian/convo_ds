import { describe, expect, it } from 'vitest';
import { errorEnvelope } from './errors.js';

describe('errorEnvelope', () => {
  it('defaults requestId to null and details to an empty list', () => {
    expect(errorEnvelope('not_found', 'No such conversation.')).toEqual({
      code: 'not_found',
      message: 'No such conversation.',
      request_id: null,
      details: [],
    });
  });

  it('carries a request id and validation details when given them', () => {
    const details = [{ field: 'slug', code: 'malformed', message: 'Bad slug.' }];
    expect(errorEnvelope('invalid_input', 'Invalid.', { requestId: 'req-1', details })).toEqual({
      code: 'invalid_input',
      message: 'Invalid.',
      request_id: 'req-1',
      details,
    });
  });
});
