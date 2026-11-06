import type { OutboundMessageOptions } from '../../im/lark/client.js';
import type {
  HostExecutorRegistry,
  ProviderReconciler,
  RegisteredHostExecutor,
} from '../v3/runtime-host-contract.js';
import {
  botmuxScheduleExecutor,
  botmuxScheduleReconciler,
  parseScheduleInput,
} from './botmux-schedule.js';
import {
  feishuSendExecutor,
  createFeishuSendExecutor,
  parseFeishuSendInput,
} from './feishu-send.js';
import {
  feishuReplyExecutor,
  createFeishuReplyExecutor,
  parseFeishuReplyInput,
} from './feishu-reply.js';
import { feishuImReconciler, createFeishuImReconciler } from './feishu-im.js';
export type {
  HostExecutorRegistry,
  RegisteredHostExecutor,
} from '../v3/runtime-host-contract.js';

export function createDefaultHostExecutorRegistry(options?: OutboundMessageOptions, replyOptions = options): HostExecutorRegistry {
  return new Map([
    [
      'botmux-schedule',
      {
        executor: botmuxScheduleExecutor,
        parseInput: parseScheduleInput,
      } satisfies RegisteredHostExecutor,
    ],
    [
      'feishu-send',
      {
        executor: options ? createFeishuSendExecutor(options) : feishuSendExecutor,
        parseInput: parseFeishuSendInput,
      } satisfies RegisteredHostExecutor,
    ],
    [
      'feishu-reply',
      {
        executor: replyOptions ? createFeishuReplyExecutor(replyOptions) : feishuReplyExecutor,
        parseInput: parseFeishuReplyInput,
      } satisfies RegisteredHostExecutor,
    ],
  ]);
}

export function createDefaultProviderReconcilers(options?: OutboundMessageOptions, replyOptions = options): Map<string, ProviderReconciler> {
  return new Map([
    [botmuxScheduleReconciler.provider, botmuxScheduleReconciler],
    [feishuImReconciler.provider, (options || replyOptions) ? createFeishuImReconciler(options, replyOptions) : feishuImReconciler],
  ]);
}
