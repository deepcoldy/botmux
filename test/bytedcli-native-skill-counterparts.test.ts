import { describe, expect, it } from 'vitest';
import { parseBytedcliOperation as parse } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy, resolveBytedcliOperationRule } from '../src/core/bytedcli-operation-policy-config.js';
import { describeSkillApi } from '../src/core/bytedcli-skill-api.js';

const cases: [string, 'read' | 'write', string[]][] = [
  ['bits.release.get', 'read', ['bits', 'release', 'get', '--ticket-id', '1261241961730']],
  ['duty.plan.get', 'read', ['duty', 'plan', 'get', '--name', 'demo-duty']],
  ['mindai.chart.auth.status', 'read', ['mindai', 'chart', 'auth', 'status']],
  ['mindai.chart.create', 'write', ['mindai', 'chart', 'create', '--prompt', '生成流程图', '--http-timeout-ms', '30000', '--image-style-name', '飞书经典']],
  ['mindai.chart.execute', 'write', ['mindai', 'chart', 'execute', '--prompt', '生成流程图', '--timeout-ms', '30000', '--include-svg']],
  ['mindai.chart.update', 'write', ['mindai', 'chart', 'update', '--task-id', 'task-123', '--prompt', '修改流程图']],
  ['mindai.chart.watch', 'read', ['mindai', 'chart', 'watch', '--task-id', 'task-123', '--timeout-ms', '30000']],
];
const policy = (rules: Record<string, string>) => parseBytedcliOperationPolicy({
  schema: 'botmux.bytedcli-operation-policy.v2', cliVersion: '0.199.0', catalogVersion: '2026-11-27.2', rules,
});
describe('native counterparts of managed Skill APIs', () => {
  it.each(cases)('%s preserves its actual effect, isolated execution and exact configured identity', (id, effect, argv) => {
    const op = parse(['--json', ...argv]);
    expect(op).toMatchObject({ id, effect, execution: 'isolated-native' });
    expect(parse(op.argv)).toEqual(op);
    const bot = policy({ [id]: 'machine' });
    expect(resolveBytedcliOperationRule(op.id, undefined, bot)).toMatchObject({ identity: 'machine', enabled: true });
    expect(resolveBytedcliOperationRule(op.id, policy({ [id]: 'actor' }), bot).identity).toBe('actor');
    expect(resolveBytedcliOperationRule(op.id, policy({ [id]: 'deny' }), bot).enabled).toBe(false);
    if (id.startsWith('mindai.')) expect(op.requiredRuntime).toBe('python3');
  });
  it('accepts a fixed CN release URL or ticket ID, never both or an alternate origin', () => {
    const origin = new URL(describeSkillApi('skill-api.bits.release.get', {ticketId:'123'}).url).origin;
    const url = origin + '/devops/123/release/releaseTicket/detail/456';
    expect(parse(['bits', 'release', 'get', '--url', url, '--raw']).id).toBe('bits.release.get');
    for (const argv of [
      ['bits', 'release', 'get'],
      ['bits', 'release', 'get', '--ticket-id', '0'],
      ['bits', 'release', 'get', '--ticket-id', '123', '--url', url],
      ['bits', 'release', 'get', '--url', url.replace('bits.', 'bits-boe.')],
      ['bits', 'release', 'get', '--url', url + '?stage=789'],
      ['bits', 'release', 'get', '--url', url + '#extra'],
    ]) expect(() => parse(argv)).toThrow();
  });
  it('closes selectors, deadlines, file paths and identity/configuration overrides', () => {
    for (const argv of [
      ['duty', 'plan', 'get', '--name', '../other'],
      ['duty', 'plan', 'get', '--name', 'demo-duty', '--host', 'https://example.test'],
      ['duty', 'plan', 'get', '--name', 'demo-duty', '--action-user', 'other-user'],
      ['mindai', 'chart', 'auth', 'status', '--config', '/etc/private.json'],
      ['mindai', 'chart', 'create', '--prompt', 'draw', '--base-url', 'https://example.test'],
      ['mindai', 'chart', 'create', '--prompt', 'draw', '--http-timeout-ms', '0'],
      ['mindai', 'chart', 'update', '--task-id', '../task', '--prompt', 'draw'],
      ['mindai', 'chart', 'watch', '--task-id', 'task-1', '--timeout-ms', '0'],
      ['mindai', 'chart', 'watch', '--task-id', 'task-1', '--timeout-ms', '60001'],
      ['mindai', 'chart', 'watch', '--task-id', 'task-1', '--until', 'never'],
    ]) expect(() => parse(argv)).toThrow();
  });
  it('uses a single image snapshot for update and rejects missing or surplus bytes', () => {
    const argv = ['mindai', 'chart', 'update', '--task-id', 'task-1', '--prompt', 'draw', '--attachment', 'input0-png'];
    const inputs = { files: [{ id: 'input0-png', dataBase64: 'AP8=' }] };
    const op = parse(argv, inputs);
    expect(op).toMatchObject({ id: 'mindai.chart.update', effect: 'write',
      stagedInputs: [{ id: 'input0-png', flag: '--attachment', encoding: 'binary', dataBase64: 'AP8=' }] });
    expect(parse(op.argv, inputs)).toEqual(op);
    for (const [args, bytes] of [
      [argv, undefined],
      [argv.map(v => v === 'input0-png' ? '/etc/private.png' : v), inputs],
      [argv, { files: [...inputs.files, { id: 'extra-png', dataBase64: 'AA==' }] }],
      [[...argv, '--attachment', 'input1-jpg'], inputs],
    ] as const) expect(() => parse(args, bytes)).toThrow();
  });
  it('keeps absent and unrelated native commands on actor fallback', () => {
    const bot = policy(Object.fromEntries(cases.map(([id]) => [id, 'machine'])));
    for (const argv of [
      ['bits', 'release', 'create', '--name', 'unrelated'],
      ['duty', 'plan', 'set-users', '--name', 'demo-duty', '--user', 'demo'],
      ['oncall', 'tenant', 'search', 'demo'],
    ]) {
      const op = parse(argv); expect(op.effect).toBe('unknown');
      expect(resolveBytedcliOperationRule(op.id, undefined, bot).identity).toBe('actor');
    }
    expect(() => parse(['self', 'skills', 'list'])).toThrow();
  });
});
