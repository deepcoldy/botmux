/** Stable IM resource references, never local paths, URLs or credentials. */
export interface CaptureAttachment {
  messageId: string;
  type: 'image' | 'file' | 'audio' | 'media' | 'merge_forward';
  key: string;
}

export function parseCaptureAttachments(value: unknown): CaptureAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid_input_capture_attachments');
  const seen = new Set<string>();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || Object.keys(ref).length !== 3 || !['messageId', 'type', 'key'].every(key => Object.hasOwn(ref, key))
      || typeof ref.messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,196}$/.test(ref.messageId)
      || !['image', 'file', 'audio', 'media', 'merge_forward'].includes(ref.type)
      || typeof ref.key !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(ref.key)
      || ref.type === 'merge_forward' && ref.key !== ref.messageId) throw new Error('invalid_input_capture_attachments');
    const key = JSON.stringify([ref.messageId, ref.type, ref.key]);
    if (seen.has(key)) throw new Error('invalid_input_capture_attachments');
    seen.add(key);
    return { messageId: ref.messageId, type: ref.type, key: ref.key };
  });
}
