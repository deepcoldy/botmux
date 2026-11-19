import { z } from 'zod';

import {
  GROUP_CHAT_ID, GROUP_SEND_REQUEST_ID, GROUP_SEND_CONTENT_MAX_BYTES,
  GROUP_SEND_BODY_MAX_BYTES, TOPIC_ROOT_ID, USER_OPEN_ID,
} from '../services/request-bound-group-send.js';

export const HOST_POST_PATH = '/api/host/post-message';
export const HOST_POST_MAX_TEXT_BYTES = GROUP_SEND_CONTENT_MAX_BYTES;
// JSON escaping can expand one text byte into six bytes.
export const HOST_POST_MAX_BODY_BYTES = GROUP_SEND_BODY_MAX_BYTES;

const postMessageFields = z.object({
  requestId: z.string().regex(GROUP_SEND_REQUEST_ID),
  larkAppId: z.string().regex(/^cli_[A-Za-z0-9_-]{1,128}$/),
  text: z.string().refine(text => text.trim() !== '' && Buffer.byteLength(text) <= HOST_POST_MAX_TEXT_BYTES),
});

export const hostPostRequest = z.union([
  postMessageFields.extend({
    chatId: z.string().regex(GROUP_CHAT_ID),
    rootMessageId: z.string().regex(TOPIC_ROOT_ID).optional(),
    userOpenId: z.never().optional(),
  }).strict(),
  postMessageFields.extend({
    userOpenId: z.string().regex(USER_OPEN_ID),
    chatId: z.never().optional(),
    rootMessageId: z.never().optional(),
  }).strict(),
]);
