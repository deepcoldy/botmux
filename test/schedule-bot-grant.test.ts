import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { matchingScheduleBotGrant, botScheduleAuthority, assertScheduleBotGrantActive } from '../src/core/schedule-bot-grant.js';
import { signDispatchUser, verifyDispatchUser, scheduleCreateCapabilities } from '../src/core/dispatch-user-delegation.js';
import { authorizeDelegatedScheduleRun, authorizeScheduleSelfManage } from '../src/core/schedule-delegated-runtime.js';
import type { ScheduleAuthorityRecord } from '../src/services/schedule-authority-store.js';

const grant = { id: 'team', sourceAppId: 'cli_controller', targetAppIds: ['cli_child'],
  chatIds: ['oc_team'], controllerUnionId: 'on_admin' };
const policy = { createEnabled: true, botGrants: [grant] };
const record = (): ScheduleAuthorityRecord => ({
  kind: 'delegated', state: 'active', selfManage: true, runScopes: [],
  controlOpenId: 'ou_admin_child', controlUnionId: 'on_admin',
  grantId: 'bot-policy:cli_controller:team:delivery:cli_child',
  task: { id: 'task', larkAppId: 'cli_child', chatId: 'oc_team', rootMessageId: 'om_topic' } as any,
});
const deps = () => ({
  runEnabled: true, hostRunScopes: [], triggerUserAuthTools: ['lark-cli', 'bytedcli'] as const,
  adminOpenIds: ['ou_admin_child'], resolveTargetOpenId: async () => 'ou_admin_child',
  listChatMemberOpenIds: async () => ['ou_admin_child'],
  validateBotGrant: (r: ScheduleAuthorityRecord) => assertScheduleBotGrantActive(r, policy),
});

describe('host bot scheduling grants', () => {
  it('requires an unambiguous exact source, destination and chat allowlist', () => {
    expect(matchingScheduleBotGrant(policy, 'cli_controller', ['cli_child'], 'oc_team')).toEqual(grant);
    for (const [source, targets, chat] of [
      ['cli_other', ['cli_child'], 'oc_team'], ['cli_controller', ['cli_other'], 'oc_team'],
      ['cli_controller', ['cli_child', 'cli_other'], 'oc_team'], ['cli_controller', [], 'oc_team'],
      ['cli_controller', ['cli_child'], 'oc_other'],
    ] as const) expect(matchingScheduleBotGrant(policy, source, targets, chat)).toBeUndefined();
    expect(matchingScheduleBotGrant({ ...policy, createEnabled: false }, 'cli_controller', ['cli_child'], 'oc_team')).toBeUndefined();
    expect(matchingScheduleBotGrant({ ...policy, botGrants: [grant, { ...grant, id: 'other' }] }, 'cli_controller', ['cli_child'], 'oc_team')).toBeUndefined();
  });
  it('carries scheduling provenance through the signed message without personal tool authority', () => {
    const authority = botScheduleAuthority({ grant, sourceOpenId: 'ou_admin_source', targetAppIds: ['cli_child'], chatId: 'oc_team', selfManage: true });
    const signed = signDispatchUser('secret', { domain: 'botmux.dispatch-user.v2', deliveryId: '00000000-0000-4000-8000-000000000001',
      sourceAppId: 'cli_controller', sourceSessionId: 'controller-session', sourceTurnId: 'report:1',
      rootId: 'om_topic', chatId: 'oc_team', targetAppIds: ['cli_child'], issuedAt: Date.now(), authority });
    const verified = verifyDispatchUser('secret', signed)!;
    expect(verified.authority.tools).toEqual([]);
    expect(scheduleCreateCapabilities(verified.authority)).toEqual([expect.objectContaining({ botGrantId: 'team', allowedRunScopes: [] })]);
    signed.payload.chatId = 'oc_other';
    expect(verifyDispatchUser('secret', signed)).toBeUndefined();
  });
  it('revalidates a bot policy on every scheduled admission and cleanup, including revocation', async () => {
    const r = record();
    await expect(authorizeDelegatedScheduleRun(r.task, r, deps())).resolves.toMatchObject({ targetOpenId: 'ou_admin_child' });
    const revoked = { ...deps(), validateBotGrant: (r: ScheduleAuthorityRecord) => assertScheduleBotGrantActive(r, { createEnabled: true }) };
    await expect(authorizeDelegatedScheduleRun(r.task, r, revoked)).rejects.toThrow('revoked');
    await expect(authorizeScheduleSelfManage(r, { ...revoked, selfManageEnabled: true, targetChatId: 'oc_team' })).rejects.toThrow('revoked');
    await expect(authorizeDelegatedScheduleRun(r.task, r, { ...deps(), validateBotGrant: undefined })).rejects.toThrow('validator unavailable');
  });
  it('does not allow changing sponsor, target, chat or adding credential scopes to an existing task', () => {
    for (const mutate of [
      (r: ScheduleAuthorityRecord) => { r.controlUnionId = 'on_other'; },
      (r: ScheduleAuthorityRecord) => { r.task.chatId = 'oc_other'; },
      (r: ScheduleAuthorityRecord) => { r.task.larkAppId = 'cli_other'; },
      (r: ScheduleAuthorityRecord) => { r.runScopes = ['bytedcli']; },
      // Renaming a grant revokes it: the record names the id it was issued under.
      (r: ScheduleAuthorityRecord) => { r.grantId = 'bot-policy:cli_controller:renamed:delivery:cli_child'; },
    ]) { const r = record(); mutate(r); expect(() => assertScheduleBotGrantActive(r, policy)).toThrow(); }
  });
  it('refuses an admission or cleanup whose grant is revoked while the controller is being checked', async () => {
    let current: typeof policy | { createEnabled: boolean } = policy;
    const revokingDeps = () => ({ ...deps(),
      validateBotGrant: (r: ScheduleAuthorityRecord) => assertScheduleBotGrantActive(r, current),
      resolveTargetOpenId: async () => { current = { createEnabled: true }; return 'ou_admin_child'; } });
    const r = record();
    await expect(authorizeDelegatedScheduleRun(r.task, r, revokingDeps())).rejects.toThrow('revoked');
    current = policy;
    await expect(authorizeScheduleSelfManage(r, { ...revokingDeps(), selfManageEnabled: true, targetChatId: 'oc_team' }))
      .rejects.toThrow('revoked');
  });
  it('allows paused bot tasks to be cleaned up only at the explicit topic lifecycle boundary', async () => {
    const r = { ...record(), state: 'paused' as const };
    const input = { ...deps(), selfManageEnabled: true, targetChatId: 'oc_team' };
    await expect(authorizeScheduleSelfManage(r, input)).rejects.toThrow('paused');
    await expect(authorizeScheduleSelfManage(r, { ...input, allowPaused: true })).resolves.toBeUndefined();
    await expect(authorizeScheduleSelfManage({ ...r, state: 'revoked' }, { ...input, allowPaused: true })).rejects.toThrow('revoked');
  });
});

// Runs the daemon's real `delegatedScheduleRuntimeDeps` (extracted from
// src/daemon.ts, seams replaced) to prove the validator it hands to scheduled
// admission consults the current host grant rather than being a no-op.
const daemonSource = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const runtimeDepsFn = daemonSource.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'delegatedScheduleRuntimeDeps')!;
const runtimeDepsCode = ts.transpileModule(runtimeDepsFn.getText(daemonSource), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
describe('daemon scheduled-admission wiring', () => {
  it('revokes a bot-policy admission once the grant leaves the host config', async () => {
    let global: { scheduleDelegation?: unknown } = { scheduleDelegation: policy };
    const scope = {
      getBot: () => ({ config: { triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'] } } }),
      readGlobalConfig: () => global, assertScheduleBotGrantActive,
      getDashboardAdminOpenIds: () => ['ou_admin_child'],
      resolveTargetAppOpenId: async () => ({ status: 'resolved', openId: 'ou_admin_child' }),
      listChatMemberOpenIds: async () => ['ou_admin_child'],
    };
    const build = new Function('scope', `with (scope) { ${runtimeDepsCode}; return delegatedScheduleRuntimeDeps; }`)(scope);
    const r = record();
    await expect(authorizeDelegatedScheduleRun(r.task, r, build('cli_child'))).resolves.toMatchObject({ targetOpenId: 'ou_admin_child' });
    global = { scheduleDelegation: { createEnabled: true } };
    await expect(authorizeDelegatedScheduleRun(r.task, r, build('cli_child'))).rejects.toThrow('revoked');
  });
});
