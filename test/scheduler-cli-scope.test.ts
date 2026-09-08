import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('schedule CLI session scope propagation', () => {
  it('resolves the requested/current execution position into scheduler.addTask', () => {
    expect(cliSource).toContain("scope?: 'thread' | 'chat';");
    expect(cliSource).toMatch(/function detectCurrentSession[\s\S]*?scope: s\.scope,/);
    expect(cliSource).toMatch(/const executionPosition: 'top-level' \| 'topic' \| 'new-topic' =[\s\S]*?cur\?\.scope/);
    // Group/topic_group sessions default to top-level (never pin results to the
    // topic the schedule was created in — e.g. an adopted one); only p2p keeps
    // the legacy scope-based inference.
    expect(cliSource).toMatch(/cur\?\.chatType === 'p2p'/);
    expect(cliSource).toMatch(/rootMessageId: executionPosition === 'topic' \? rootMessageId : undefined/);
    expect(cliSource).toMatch(/const scope: 'thread' \| 'chat' = executionPosition === 'topic'/);
    expect(cliSource).toMatch(/task = scheduler\.addTask\(\{[\s\S]*?\bscope,[\s\S]*?\bexecutionPosition,[\s\S]*?\btopicTitle,[\s\S]*?\}\);/);
    expect(cliSource).not.toContain('--new-topic 与 --silent 不能同时使用');
    expect(cliSource).toMatch(/const silent = rest\.includes\('--silent'\)[\s\S]*?executionPosition[\s\S]*?scheduler\.addTask/);
  });

  it('wires --follow-active as topic execution and forwards the flag into scheduler.addTask', () => {
    // The flag must be stripped from positionals, or it would leak into the prompt.
    expect(cliSource).toMatch(/positionals\(rest, \[[^\]]*'--follow-active'[^\]]*\]\)/);
    // --follow-active implies topic execution (same chain, same literal shape).
    expect(cliSource).toMatch(/const executionPosition: 'top-level' \| 'topic' \| 'new-topic' =[\s\S]*?wantsTopic \|\| wantsFollowActive\s*\?\s*'topic'/);
    // Mutually exclusive with the two positions that have no topic to follow.
    expect(cliSource).toMatch(/wantsFollowActive && \(wantsNewTopic \|\| wantsTopLevel\)/);
    // Forwarded after topicTitle so the addTask arg order asserted above still holds.
    expect(cliSource).toMatch(/task = scheduler\.addTask\(\{[\s\S]*?\btopicTitle,[\s\S]*?followActive: wantsFollowActive \? true : undefined,[\s\S]*?\}\);/);
  });

  it('forwards --model / --reasoning-effort and rejects a bad level before writing', () => {
    // Both take a value, so `positionals` skips it automatically — asserting the
    // flags are NOT in the boolean list is what keeps "gpt-5.6-sol" out of the prompt.
    expect(cliSource).not.toMatch(/positionals\(rest, \[[^\]]*'--model'[^\]]*\]\)/);
    expect(cliSource).not.toMatch(/positionals\(rest, \[[^\]]*'--reasoning-effort'[^\]]*\]\)/);
    // Shape is validated in-process; the CLI/model pairing is not, because a
    // sandboxed session cannot read bots.json (fire time degrades instead).
    expect(cliSource).toMatch(/isScheduleReasoningEffort\(reasoningEffortArg\)/);
    expect(cliSource).toMatch(/task = scheduler\.addTask\(\{[\s\S]*?followActive: wantsFollowActive \? true : undefined,[\s\S]*?\bmodel,[\s\S]*?\breasoningEffort,[\s\S]*?\}\);/);
    // The receipt must state the fresh-spawn-only limit rather than let it be
    // discovered weeks later at fire time.
    expect(cliSource).toMatch(/executionPosition === 'new-topic'[\s\S]*?模型每次生效[\s\S]*?仅在本任务新建会话的那次执行生效/);
  });
});
