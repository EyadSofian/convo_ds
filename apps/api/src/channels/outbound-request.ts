import type { ErrorDetail } from '@convo/contracts';
import type { ParseResult } from './channel-request.js';

/**
 * Request parsing for the outbound send command.
 *
 * `clientMessageId` is required rather than generated here. The point of it is
 * that the *caller's* retry is recognisable as the same message; a value this
 * server invents would be different on every retry and would guarantee exactly
 * the duplicate it exists to prevent.
 */

export interface SendMessageRequest {
  readonly peerIdentity: string;
  readonly messageType: string;
  readonly text: string;
  readonly template: {
    readonly id?: string;
    readonly name?: string;
    readonly language?: string;
    readonly parameters?: Readonly<Record<string, string>>;
  } | null;
  readonly clientMessageId: string;
  readonly trafficClass: 'interactive' | 'bulk';
  /**
   * True for an internal note.
   *
   * Accepted and then refused rather than rejected as malformed: a note is a
   * real thing an operator writes, and the permit is the one place that decides
   * what may reach a provider. Silently dropping the field here would move that
   * decision somewhere nobody tests.
   */
  readonly isPrivateNote: boolean;
}

const IDENTITY = /^[A-Za-z0-9_.:+@-]{1,190}$/;
const CLIENT_ID = /^[A-Za-z0-9_.:-]{8,190}$/;
const MAX_TEXT = 16_000;
const NAME = /^[a-z0-9_]{1,190}$/;
const LANGUAGE = /^[A-Za-z]{2}(_[A-Za-z]{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseSendMessage(input: unknown): ParseResult<SendMessageRequest> {
  const record = asRecord(input);
  if (record === null) {
    return {
      ok: false,
      details: [{ field: 'body', code: 'malformed', message: 'The body must be an object.' }],
    };
  }
  const details: ErrorDetail[] = [];

  const peerIdentity = typeof record['peerIdentity'] === 'string' ? record['peerIdentity'].trim() : '';
  if (!IDENTITY.test(peerIdentity)) {
    details.push({
      field: 'peerIdentity',
      code: 'malformed',
      message: 'Provide the recipient identity as the provider expresses it.',
    });
  }

  const messageType = typeof record['messageType'] === 'string' ? record['messageType'].trim() : '';
  if (!NAME.test(messageType)) {
    details.push({ field: 'messageType', code: 'malformed', message: 'Provide a message type.' });
  }

  // Not length-checked against a channel limit here: the limit belongs to the
  // connection's own capability matrix, and that is a permit-time decision. This
  // is only the bound past which no channel could possibly accept it.
  const text = typeof record['text'] === 'string' ? record['text'] : '';
  if (text.length > MAX_TEXT) {
    details.push({ field: 'text', code: 'too_long', message: `At most ${String(MAX_TEXT)} characters.` });
  }

  const clientMessageId =
    typeof record['clientMessageId'] === 'string' ? record['clientMessageId'].trim() : '';
  if (!CLIENT_ID.test(clientMessageId)) {
    details.push({
      field: 'clientMessageId',
      code: 'malformed',
      message: 'Provide your own id for this message, 8 to 190 characters.',
    });
  }

  let template: SendMessageRequest['template'] = null;
  if ('template' in record && record['template'] !== null) {
    const raw = asRecord(record['template']);
    const id = typeof raw?.['id'] === 'string' ? raw['id'].trim() : '';
    if (id !== '') {
      const rawParameters = asRecord(raw?.['parameters']);
      const parameters: Record<string, string> = {};
      const invalid = !UUID.test(id) || rawParameters === null || Object.entries(rawParameters).some(([key, value]) => {
        if (!/^(header|body):[1-9][0-9]{0,2}$|^button:(?:0|[1-9][0-9]{0,2}):[1-9][0-9]{0,2}$/.test(key) || typeof value !== 'string' || value.length > 1024) return true;
        parameters[key] = value;
        return false;
      });
      if (invalid) details.push({ field: 'template', code: 'malformed', message: 'A template id and text parameter map are required.' });
      else template = { id, parameters };
    } else {
      const name = typeof raw?.['name'] === 'string' ? raw['name'].trim() : '';
      const language = typeof raw?.['language'] === 'string' ? raw['language'].trim() : '';
      if (!NAME.test(name) || !LANGUAGE.test(language)) {
        details.push({ field: 'template', code: 'malformed', message: 'A template is {name, language}.' });
      } else template = { name, language };
    }
  }

  const rawClass = record['trafficClass'];
  const trafficClass = rawClass === undefined ? 'interactive' : rawClass;
  if (trafficClass !== 'interactive' && trafficClass !== 'bulk') {
    details.push({
      field: 'trafficClass',
      code: 'malformed',
      message: 'Traffic class is interactive or bulk.',
    });
  }

  const isPrivateNote = record['isPrivateNote'];
  if (isPrivateNote !== undefined && typeof isPrivateNote !== 'boolean') {
    details.push({
      field: 'isPrivateNote',
      code: 'malformed',
      message: 'isPrivateNote is true or false.',
    });
  }

  if (details.length > 0) {
    return { ok: false, details };
  }
  return {
    ok: true,
    value: {
      peerIdentity,
      messageType,
      text,
      template,
      clientMessageId,
      trafficClass: trafficClass as 'interactive' | 'bulk',
      isPrivateNote: isPrivateNote === true,
    },
  };
}
