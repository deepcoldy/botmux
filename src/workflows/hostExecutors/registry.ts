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
  parseFeishuSendInput,
} from './feishu-send.js';
import {
  feishuReplyExecutor,
  parseFeishuReplyInput,
} from './feishu-reply.js';
import { feishuImReconciler } from './feishu-im.js';
export type {
  HostExecutorRegistry,
  RegisteredHostExecutor,
} from '../v3/runtime-host-contract.js';

export function createDefaultHostExecutorRegistry(): HostExecutorRegistry {
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
        executor: feishuSendExecutor,
        parseInput: parseFeishuSendInput,
      } satisfies RegisteredHostExecutor,
    ],
    [
      'feishu-reply',
      {
        executor: feishuReplyExecutor,
        parseInput: parseFeishuReplyInput,
      } satisfies RegisteredHostExecutor,
    ],
  ]);
}

export function createDefaultProviderReconcilers(): Map<string, ProviderReconciler> {
  return new Map([
    [botmuxScheduleReconciler.provider, botmuxScheduleReconciler],
    [feishuImReconciler.provider, feishuImReconciler],
  ]);
}
