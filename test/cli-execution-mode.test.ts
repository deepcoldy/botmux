import { describe, expect, it } from 'vitest';
import { configuredCliExecutionMode, delegatedCliExecutionAllowed, isCliExecutionInfo,
  isWorkerCliExecution, resolveCliExecutionInfo, sessionCliExecutionInfo, workerCliExecution,
  workerCliExecutionReport, type CliExecutionConfig } from '../src/core/cli-execution-mode.js';

const native: CliExecutionConfig = { larkToolBinding: false, triggerUserAuth: { enabled: false, tools: [] } };
const managed: CliExecutionConfig = { triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'] } };
const user = { username: 'operator', uid: 1000 };
const report = { workerPid: 90, workerGeneration: 7, cliExecution: workerCliExecution(native, false, user) };

describe('CLI execution mode', () => {
  it.each([
    [{}, 'managed', false],
    [native, 'native', true],
    [managed, 'managed', true],
    [{ larkToolBinding: false }, 'native', true],
    [{ larkToolBinding: false, triggerUserAuth: { enabled: true, tools: [], capabilities: [] } }, 'native', true],
    [{ larkToolBinding: true, triggerUserAuth: { enabled: false, tools: [] } }, 'managed', false],
    [{ larkToolBinding: false, triggerUserAuth: { enabled: true, tools: ['bytedcli'] } }, 'managed', false],
  ] as const)('uses the explicit complete policy for %o', (config, mode, allowed) => {
    expect(configuredCliExecutionMode(config as CliExecutionConfig)).toBe(mode);
    expect(delegatedCliExecutionAllowed(config as CliExecutionConfig)).toBe(allowed);
  });

  it('reports the real spawn binding and OS executor without inventing a platform user', () => {
    expect(workerCliExecution({}, false, user)).toEqual({ mode: 'native', executor: { kind: 'os-user', ...user } });
    expect(workerCliExecution(native, true, { username: 'windows-user', uid: -1 }))
      .toEqual({ mode: 'managed', executor: { kind: 'os-user', username: 'windows-user' } });
  });

  it('withholds executor metadata instead of failing spawn or trusting an environment fallback', () => {
    const expected = workerCliExecution(native, false, user);
    expect(workerCliExecutionReport(native, false, { userInfo: () => user, bun: false })).toEqual(expected);
    expect(workerCliExecutionReport(native, false, {
      userInfo: () => { throw new Error('passwd entry missing'); }, bun: false,
    })).toBeUndefined();
    expect(workerCliExecutionReport(native, false, {
      userInfo: () => user, bun: true, getuid: () => user.uid + 1,
    })).toBeUndefined();
    expect(workerCliExecutionReport(native, false, {
      userInfo: () => user, bun: true, getuid: () => user.uid, readUsername: () => 'root',
    })).toBeUndefined();
    expect(workerCliExecutionReport(native, false, {
      userInfo: () => user, bun: true, getuid: () => user.uid,
      readUsername: () => { throw new Error('account unresolved'); },
    })).toBeUndefined();
    expect(workerCliExecutionReport(native, false, {
      userInfo: () => user, bun: true, getuid: () => user.uid, readUsername: () => user.username,
    })).toEqual(expected);
  });

  it('withholds native authorization for missing, stale or mismatched worker facts', () => {
    const input = { config: native, workerPid: 90, workerGeneration: 7, nativeAuthorized: true };
    expect(resolveCliExecutionInfo({ ...input, report })).toMatchObject({ mode: 'native', nativeAuthorized: true });
    for (const patch of [{ report: undefined }, { report: { ...report, cliExecution: undefined } },
      { workerPid: 91 }, { workerGeneration: 8 }, { config: managed },
      { report: { ...report, conflict: 'invalid' } }]) {
      expect(resolveCliExecutionInfo({ ...input, report, ...patch })).toEqual({ mode: 'unknown', nativeAuthorized: false });
    }
  });

  it('does not turn execution proof or a talk-only caller into native operating permission', () => {
    const session = { worker: { pid: 90 }, workerGeneration: 7, reportedIdentityModel: report,
      managedTurnOrigin: { turnId: 'turn-a', callerOpenId: 'ou_talker' } };
    expect(sessionCliExecutionInfo(session, native, ['ou_operator'])).toMatchObject({ nativeAuthorized: false });
    session.managedTurnOrigin.callerOpenId = 'ou_operator';
    expect(sessionCliExecutionInfo(session, native, ['ou_operator'])).toMatchObject({ nativeAuthorized: true });
  });

  it('uses only the exact native scheduled controller, with current operator checks', () => {
    const session = { worker: { pid: 90 }, workerGeneration: 7, reportedIdentityModel: report,
      managedTurnOrigin: { turnId: 'schedule:abcd1234:run-a' },
      scheduledControlActors: new Map([['schedule:abcd1234:run-a', { openId: 'ou_operator' }]]) };
    expect(sessionCliExecutionInfo(session, native, ['ou_operator'])).toMatchObject({ nativeAuthorized: true });
    expect(sessionCliExecutionInfo(session, native, [])).toMatchObject({ nativeAuthorized: false });
    session.managedTurnOrigin.turnId = 'schedule:abcd1234:run-b';
    expect(sessionCliExecutionInfo(session, native, ['ou_operator'])).toMatchObject({ nativeAuthorized: false });
  });

  it('rejects credential-bearing or malformed reports and impossible authorization flags', () => {
    const cli = report.cliExecution;
    expect(isWorkerCliExecution(cli)).toBe(true);
    for (const value of [{ ...cli, token: 'forbidden' }, { ...cli, executor: { ...cli.executor, uid: -1 } },
      { ...cli, executor: { ...cli.executor, username: 'user\nother' } }, { mode: 'native' }]) {
      expect(isWorkerCliExecution(value)).toBe(false);
    }
    expect(isCliExecutionInfo({ mode: 'unknown', nativeAuthorized: false })).toBe(true);
    expect(isCliExecutionInfo({ ...cli, mode: 'managed', nativeAuthorized: true })).toBe(false);
    expect(isCliExecutionInfo({ mode: 'unknown', nativeAuthorized: true })).toBe(false);
  });
});
