import type { ChannelKind } from './kinds.js';

export const MAX_CHAT_FILE_BYTES = 5 * 1024 * 1024;
export const CHAT_FILE_CONTENT_TYPE = 'application/vnd.convo.chat-file';

const IMAGES = ['image/jpeg', 'image/png'] as const;
const DOCUMENTS = [
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
const AUDIO = ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4'] as const;
const VIDEO = ['video/mp4', 'video/3gpp'] as const;

const IMAGE_TYPES = new Set<string>(IMAGES);
const AUDIO_TYPES = new Set<string>(AUDIO);
const VIDEO_TYPES = new Set<string>(VIDEO);

export function chatFileTypes(kind: string): readonly string[] {
  if (kind === 'whatsapp') return [...IMAGES, ...DOCUMENTS, ...AUDIO, ...VIDEO];
  if (kind === 'messenger') return [...IMAGES, ...DOCUMENTS, 'image/gif', ...AUDIO, ...VIDEO];
  if (kind === 'instagram') return IMAGES;
  return [];
}

export type ChatFileMessageType = 'image' | 'document' | 'file' | 'audio' | 'video';

export function chatFileMessageType(kind: ChannelKind, mimeType: string): ChatFileMessageType | null {
  if (!chatFileTypes(kind).includes(mimeType)) return null;
  if (IMAGE_TYPES.has(mimeType) || mimeType === 'image/gif') return 'image';
  if (AUDIO_TYPES.has(mimeType)) return 'audio';
  if (VIDEO_TYPES.has(mimeType)) return 'video';
  return kind === 'whatsapp' ? 'document' : 'file';
}
