import { z } from 'zod';

export const HOST_POST_PATH = '/api/host/post-message';
export const HOST_POST_MAX_TEXT_BYTES = 8192;
// JSON escaping can expand one text byte into six bytes.
export const HOST_POST_MAX_BODY_BYTES = 64 * 1024;

const postMessageFields = z.object({
  larkAppId: z.string().regex(/^cli_[A-Za-z0-9_-]{1,128}$/),
  text: z.string().refine(text => text.trim() !== '' && Buffer.byteLength(text) <= HOST_POST_MAX_TEXT_BYTES),
});

export const hostPostRequest = z.union([
  postMessageFields.extend({
    chatId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,128}$/),
    rootMessageId: z.string().regex(/^om_[A-Za-z0-9_-]{1,128}$/).optional(),
    userOpenId: z.never().optional(),
  }).strict(),
  postMessageFields.extend({
    userOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]{1,128}$/),
    chatId: z.never().optional(),
    rootMessageId: z.never().optional(),
  }).strict(),
]);
