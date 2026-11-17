import { chatFileSizeLimit, chatFileTypes } from '@convo/domain';
import type { LiveContext } from './actions.js';
import { loadTimeline } from './inbox-actions.js';
import { currentTenantId } from './store.js';
import { voiceDraft } from './voice-message.js';

export interface AttachmentDraft {
  readonly conversationId: string;
  readonly file: File;
  readonly key: string;
  sending: boolean;
  error: string | null;
}

export function selectAttachment(context: LiveContext, file: File): void {
  const { live, state } = context;
  if (live.openConversation.status !== 'ready' || voiceDraft(live) !== null || live.attachmentDraft?.sending) return;
  const conversation = live.openConversation.value;
  const allowedTypes = chatFileTypes(conversation.channel);
  let error: string | null = null;
  const limit = chatFileSizeLimit(conversation.channel, file.type);
  const maxMb = limit / (1024 * 1024);
  if (!allowedTypes.includes(file.type)) {
    error = state.lang === 'ar' ? 'نوع الملف ده غير مدعوم على القناة دي.' : 'This file type is unsupported on this channel.';
  } else if (file.size === 0) {
    error = state.lang === 'ar' ? 'اختار ملف مش فاضي.' : 'Choose a file that is not empty.';
  } else if (file.size > limit) {
    error = state.lang === 'ar' ? `الحد الأقصى للملف ده ${maxMb} ميجابايت.` : `This file must be ${maxMb} MB or smaller.`;
  }
  live.attachmentDraft = { conversationId: conversation.id, file, key: context.newKey(), sending: false, error };
  context.refresh();
}

export async function sendAttachment(context: LiveContext): Promise<boolean> {
  const { live } = context;
  const draft = live.attachmentDraft;
  const tenantId = currentTenantId(live);
  if (draft === null || draft.sending || tenantId === null || live.openConversationId !== draft.conversationId ||
    live.openConversation.status !== 'ready' || draft.file.size === 0 ||
    draft.file.size > chatFileSizeLimit(live.openConversation.value.channel, draft.file.type) ||
    !chatFileTypes(live.openConversation.value.channel).includes(draft.file.type)) return false;
  draft.sending = true;
  draft.error = null;
  context.refresh();
  const result = await live.conversationsApi.replyFile(tenantId, draft.conversationId, draft.file, draft.key);
  if (live.attachmentDraft !== draft) return result.ok;
  if (!result.ok) {
    draft.sending = false;
    draft.error = result.error.message;
    context.refresh();
    return false;
  }
  live.attachmentDraft = null;
  await loadTimeline(context, draft.conversationId);
  return true;
}
