import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('schedule CLI session scope propagation', () => {
  it('resolves the requested/current execution position into the daemon request', () => {
    expect(cliSource).toContain("scope?: 'thread' | 'chat';");
    expect(cliSource).toMatch(/function detectCurrentSession[\s\S]*?scope: s\.scope,/);
    expect(cliSource).toContain('current turn caller does not match the session owner');
    expect(cliSource).toMatch(/const executionPosition: 'top-level' \| 'topic' \| 'new-topic' =[\s\S]*?cur\?\.scope/);
    // Group/topic_group sessions default to top-level (never pin results to the
    // topic the schedule was created in — e.g. an adopted one); only p2p keeps
    // the legacy scope-based inference.
    expect(cliSource).toMatch(/cur\?\.chatType === 'p2p'/);
    expect(cliSource).toMatch(/rootMessageId: executionPosition === 'topic' \? rootMessageId : undefined/);
    expect(cliSource).toMatch(/const scope: 'thread' \| 'chat' = executionPosition === 'topic'/);
    expect(cliSource).toMatch(/path: SCHEDULE_DELEGATED_ADD_ROUTE,[\s\S]*?body: \{ task: \{[\s\S]*?rootMessageId: executionPosition === 'topic' \? rootMessageId : undefined,[\s\S]*?executionPosition,[\s\S]*?larkAppId/);
    expect(cliSource).not.toMatch(/task = scheduler\.addTask\(/);
    expect(cliSource).not.toMatch(/ownerOpenId: process\.env\.BOTMUX_OWNER_OPEN_ID/);
    expect(cliSource).not.toMatch(/ownerUnionId: cur\?\.ownerUnionId/);
    expect(cliSource).not.toContain('--new-topic 与 --silent 不能同时使用');
    expect(cliSource).toMatch(/const silent = rest\.includes\('--silent'\)[\s\S]*?executionPosition[\s\S]*?SCHEDULE_DELEGATED_ADD_ROUTE/);
  });

  it('wires --follow-active as topic execution and forwards the flag into the daemon request', () => {
    // The flag must be stripped from positionals, or it would leak into the prompt.
    expect(cliSource).toMatch(/positionals\(rest, \[[^\]]*'--follow-active'[^\]]*\]\)/);
    // --follow-active implies topic execution (same chain, same literal shape).
    expect(cliSource).toMatch(/const executionPosition: 'top-level' \| 'topic' \| 'new-topic' =[\s\S]*?wantsTopic \|\| wantsFollowActive\s*\?\s*'topic'/);
    // Mutually exclusive with the two positions that have no topic to follow.
    expect(cliSource).toMatch(/wantsFollowActive && \(wantsNewTopic \|\| wantsTopLevel\)/);
    // Forwarded after topicTitle so the addTask arg order asserted above still holds.
    expect(cliSource).toMatch(/body: \{ task: \{[\s\S]*?\.\.\.\(wantsFollowActive \? \{ followActive: true \} : \{\}\)[\s\S]*?\}\s*\}/);
  });

  it('forwards --model / --reasoning-effort and rejects a bad level before writing', () => {
    // Both take a value, so `positionals` skips it automatically — asserting the
    // flags are NOT in the boolean list is what keeps "gpt-5.6-sol" out of the prompt.
    expect(cliSource).not.toMatch(/positionals\(rest, \[[^\]]*'--model'[^\]]*\]\)/);
    expect(cliSource).not.toMatch(/positionals\(rest, \[[^\]]*'--reasoning-effort'[^\]]*\]\)/);
    // Shape is validated in-process; the CLI/model pairing is not, because a
    // sandboxed session cannot read bots.json (fire time degrades instead).
    expect(cliSource).toMatch(/isScheduleReasoningEffort\(reasoningEffortArg\)/);
    expect(cliSource).toMatch(/body: \{ task: \{[\s\S]*?\bmodel,[\s\S]*?\breasoningEffort,[\s\S]*?\}\s*\}/);
    // The receipt must state the fresh-spawn-only limit rather than let it be
    // discovered weeks later at fire time.
    expect(cliSource).toMatch(/executionPosition === 'new-topic'[\s\S]*?模型每次生效[\s\S]*?仅在本任务新建会话的那次执行生效/);
  });

  it('accepts only an explicit 8-hex --id and forwards it to the daemon request', () => {
    expect(cliSource).toMatch(/const explicitTaskId = argValue\(rest, '--id'\)/);
    expect(cliSource).toMatch(/explicitTaskId !== undefined && !\/\^\[0-9a-f\]\{8\}\$\/\.test\(explicitTaskId\)/);
    expect(cliSource).toMatch(/const delegatedTaskId = explicitTaskId \?\? randomBytes\(4\)\.toString\('hex'\)[\s\S]*?id: delegatedTaskId,[\s\S]*?\bname,/);
  });
});
