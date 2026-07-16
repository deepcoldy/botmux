import type { ProviderReconciler } from '../shared/provider-reconciler.js';
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
import type { SideEffectingExecutor } from './types.js';

export type RegisteredHostExecutor<Input = unknown, Output = unknown> = {
  executor: SideEffectingExecutor<Input, Output>;
  parseInput(input: unknown): Input;
};

export type HostExecutorRegistry = Map<string, RegisteredHostExecutor>;

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
