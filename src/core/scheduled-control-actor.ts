import { configuredCliExecutionMode, type CliExecutionConfig } from './cli-execution-mode.js';
import { authorizeDelegatedScheduleRun, type DelegatedScheduleRuntimeDependencies } from './schedule-delegated-runtime.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';
import type { ScheduledRunIdentity } from './schedule-identity-claim.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';
import { effectiveScheduleChatIds } from '../services/schedule-store.js';
import { isAutoCompletedSchedule } from '../services/schedule-until-done.js';
import { isManualScheduledTurn } from './scheduled-turn-provenance.js';

/** 原生控制人证明不发布个人凭据，也不将 ownerless 任务改成有 owner。 */
export async function resolveNativeScheduledControlActor(input: {
  turnId: string;
  appId: string;
  chatId: string;
  authority: ScheduleAuthorityRecord;
  cliConfig: () => CliExecutionConfig;
  deps: DelegatedScheduleRuntimeDependencies;
  resolveDirectActor: () => ScheduledRunIdentity;
  assertCurrent: () => void;
}): Promise<{ openId: string; unionId: string } | undefined> {
  const a = input.authority;
  if (configuredCliExecutionMode(input.cliConfig()) !== 'native'
    || parseScheduledTurnId(input.turnId) !== a.task.id
    || a.task.larkAppId !== input.appId || !effectiveScheduleChatIds(a.task).includes(input.chatId)) return undefined;
  if (a.state !== 'active'
    && !(a.state === 'completed' && isAutoCompletedSchedule(a.task))
    && !(a.state === 'paused' && isManualScheduledTurn(a.task, input.turnId))) {
    throw new Error(`schedule authority state is ${a.state}; refusing control actor`);
  }
  input.assertCurrent();
  let actor: { openId: string; unionId: string } | undefined;
  if (a.kind === 'delegated') {
    const run = await authorizeDelegatedScheduleRun(a.task, a, {
      ...input.deps, manualTurnId: input.turnId, allowCompletedOnce: true,
      assertAuthorityCurrent: input.assertCurrent,
    });
    if (a.controlUnionId) actor = { openId: run.targetOpenId, unionId: a.controlUnionId };
  } else {
    const identity = input.resolveDirectActor();
    if (identity.ok) actor = { openId: identity.openId, unionId: identity.unionId };
  }
  input.assertCurrent();
  return configuredCliExecutionMode(input.cliConfig()) === 'native' ? actor : undefined;
}
