import { TOOL_NAMES } from '../types.js';
import * as sendToThread from './send-to-thread.js';
import * as getThreadMessages from './get-thread-messages.js';
import * as reactToMessage from './react-to-message.js';
import * as listBots from './list-bots.js';

export const tools = {
  [TOOL_NAMES.SEND_TO_THREAD]: sendToThread,
  [TOOL_NAMES.GET_THREAD_MESSAGES]: getThreadMessages,
  [TOOL_NAMES.REACT_TO_MESSAGE]: reactToMessage,
  [TOOL_NAMES.LIST_BOTS]: listBots,
} as const;
