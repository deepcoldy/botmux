import type { CliAdapter } from '../adapters/cli/types.js';
import { cliHasNoRawPassthroughSurface } from './passthrough-commands.js';

export type GoalAction = keyof NonNullable<CliAdapter['nativeGoal']>;
export interface GoalControlView {
  actions: GoalAction[];
  blockedReason?: string;
}

export function nativeGoalControlView(
  adapter: Pick<CliAdapter, 'id' | 'nativeGoal'>,
  runtime: { adopted?: boolean; remote?: boolean; rpc?: boolean; live?: boolean },
): GoalControlView {
  let blockedReason: string | undefined;
  if (!adapter.nativeGoal || cliHasNoRawPassthroughSurface(adapter.id)) blockedReason = 'goal_unsupported';
  else if (runtime.adopted) blockedReason = 'adopt_goal_unsupported';
  else if (runtime.remote || runtime.rpc) blockedReason = 'goal_input_unsupported';
  else if (!runtime.live) blockedReason = 'no_live_worker';
  return {
    actions: adapter.nativeGoal ? Object.keys(adapter.nativeGoal) as GoalAction[] : [],
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export function prepareNativeGoalCommand(
  commands: CliAdapter['nativeGoal'],
  body: unknown,
): { ok: true; command: string } | { ok: false; error: string } {
  if (!commands) return { ok: false, error: 'goal_unsupported' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_goal_request' };
  const input = body as Record<string, unknown>;
  if (typeof input.action !== 'string' || !Object.hasOwn(commands, input.action)) {
    return { ok: false, error: 'goal_action_unsupported' };
  }
  const command = commands[input.action as GoalAction]!;
  if (input.action !== 'start') return { ok: true, command };
  if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 16_000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.objective)) {
    return { ok: false, error: 'invalid_goal_objective' };
  }
  const objective = input.objective.trim().replace(/[\r\n\t]+/g, ' ');
  // Native /goal parsers reserve these words for controls, not objectives.
  if (/^(pause|resume|clear|edit)(?:\s|$)/i.test(objective)) {
    return { ok: false, error: 'reserved_goal_objective' };
  }
  return { ok: true, command: `${command} ${objective}` };
}
