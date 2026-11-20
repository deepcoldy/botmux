import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', failMeta: false }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } }, dashboard: {} } }));
vi.mock('../src/utils/atomic-write.js', async original => {
  const actual = await original<typeof import('../src/utils/atomic-write.js')>();
  return { ...actual, atomicWriteFileSync: (path: string, ...args: any[]) => {
    if (state.failMeta && path.endsWith('.meta.json')) throw Error('injected metadata disk failure');
    return (actual.atomicWriteFileSync as any)(path, ...args);
  } };
});
import { handleFederationSpokeApi } from '../src/dashboard/federation-spoke-api.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { readTeamRoleInjectMode, writeTeamRoleInjectMode } from '../src/core/role-resolver.js';
import { buildTeamRoster } from '../src/services/team-roster.js';
import { setBotCapability, clearBotCapability } from '../src/services/bot-profile-store.js';
import { jsonRes } from '../src/dashboard/http.js';

// 非文本断言：仅在内存摘除守卫，执行真实请求流与文件写入实现。
function mutatedRoute(): typeof handleFederationSpokeApi {
  const source = ts.createSourceFile('federation-spoke-api.ts', readFileSync(new URL('../src/dashboard/federation-spoke-api.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let code = source.statements.filter(n => ts.isFunctionDeclaration(n)
    && ['teamRolePath', 'writeTeamRole', 'readBody', 'handleFederationSpokeApi'].includes(n.name?.text ?? '')
    || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === 'MAX_ROLE_BYTES'))
    .map(n => n.getText(source)).join('\n');
  const guards: Record<string, [string, string]> = {
    cas: ['body.expectedRole !== current || body.expectedInjectMode !== readTeamRoleInjectMode(larkAppId)', 'false'],
    role: ['body.expectedRole !== current', 'false'],
    mode: ['body.expectedInjectMode !== readTeamRoleInjectMode(larkAppId)', 'false'],
    budget: ["field === 'role' ? 2 * MAX_ROLE_BYTES * 6 + 1024 : undefined", 'undefined'],
    stream: ['total > maxBytes', 'false'],
    persisted: ['buf.length > MAX_ROLE_BYTES', 'false'],
  };
  const name = process.env.ROLE_CAS_REVIEW_MUTATION!;
  const guard = guards[name];
  if (!guard || !code.includes(guard[0])) throw Error(`Missing guard ${name}`);
  code = code.replace(guard[0], guard[1]);
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const scope = { readFileSync, existsSync, unlinkSync, mkdirSync, atomicWriteFileSync, join, dirname,
    readTeamRoleInjectMode, writeTeamRoleInjectMode, buildTeamRoster, setBotCapability, clearBotCapability, jsonRes, exports: {} };
  return new Function('scope', `with(scope) { ${compiled}; return handleFederationSpokeApi; }`)(scope);
}
const route = process.env.ROLE_CAS_REVIEW_MUTATION ? mutatedRoute() : handleFederationSpokeApi;

function request(body: unknown, pause?: () => Promise<void>): any {
  return { method: body === undefined ? 'GET' : 'PUT', headers: {}, async *[Symbol.asyncIterator]() {
    if (body === undefined) return;
    const bytes = Buffer.from(JSON.stringify(body)), middle = Math.floor(bytes.length / 2);
    yield bytes.subarray(0, middle);
    if (pause) await pause();
    yield bytes.subarray(middle);
  } };
}
async function call(body?: unknown, pause?: () => Promise<void>, field = 'role') {
  const res: any = { status: 0, body: '', setHeader() {}, writeHead(status: number) { this.status = status; }, end(body: string) { this.body = body; } };
  await route(request(body, pause), res, new URL(`http://localhost/api/team/local-bots/cli_test/${field}`), { dataDir: state.dataDir });
  return { status: res.status, ...JSON.parse(res.body) };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-20T00:00:00Z')); state.failMeta = false;
  state.dataDir = mkdtempSync(join(tmpdir(), 'role-cas-review-'));
  writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([{ larkAppId: 'cli_test', botName: 'Test', cliId: 'claude' }]));
});
afterEach(() => { vi.useRealTimers(); rmSync(state.dataDir, { recursive: true, force: true }); });

describe('role condition request-stream review', () => {
  it.each(['role', 'injectMode', 'delete'])('preserves a concurrent %s intervention during body delivery', async kind => {
    await call({ role: 'original', injectMode: 'once' }); const snapshot = await call();
    const result = await call({ role: 'replacement', injectMode: 'every', expectedRole: snapshot.role, expectedInjectMode: snapshot.injectMode }, async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await call({ role: kind === 'delete' ? '' : kind === 'role' ? 'operator edit' : 'original', injectMode: kind === 'injectMode' ? 'every' : 'once' });
    });
    expect(result.status).toBe(409);
    const actual = await call();
    expect(actual.role).toBe(kind === 'delete' ? '' : kind === 'role' ? 'operator edit' : 'original');
    expect(actual.injectMode).toBe(kind === 'injectMode' ? 'every' : 'once');
  });

  it('allows only one of two requests with the same observed state', async () => {
    await call({ role: 'original', injectMode: 'once' });
    const bodies = ['first', 'second'].map(role => ({ role, injectMode: 'every', expectedRole: 'original', expectedInjectMode: 'once' }));
    const results = await Promise.all(bodies.map(body => call(body)));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(['first', 'second']).toContain((await call()).role);
  });

  it('keeps partial writes visible and requires a fresh state before retry', async () => {
    await call({ role: 'original', injectMode: 'every' });
    const body = { role: 'replacement', injectMode: 'once', expectedRole: 'original', expectedInjectMode: 'every' };
    state.failMeta = true; await expect(call(body)).rejects.toThrow('metadata disk failure');
    state.failMeta = false;
    expect(await call()).toMatchObject({ role: 'replacement', injectMode: 'every' });
    expect((await call(body)).status).toBe(409);
    expect((await call({ ...body, expectedRole: 'replacement' })).status).toBe(200);
    expect(await call()).toMatchObject({ role: 'replacement', injectMode: 'once' });
  });

  it.each(['ascii', 'escaped'])('accepts conditional replacement of maximum-sized %s role values', async encoding => {
    const original = (encoding === 'ascii' ? 'a' : '\u0001').repeat(32 * 1024);
    const replacement = (encoding === 'ascii' ? 'b' : '\u0002').repeat(32 * 1024);
    expect((await call({ role: original, injectMode: 'once' })).status).toBe(200);
    const snapshot = await call(); expect(snapshot.role).toBe(original);
    const result = await call({ role: replacement, injectMode: 'every', expectedRole: snapshot.role, expectedInjectMode: snapshot.injectMode });
    expect(result.status).toBe(200);
    expect((await call()).role).toBe(replacement);
  });

  it('rejects an over-budget request before changing either persisted value', async () => {
    await call({ role: 'original', injectMode: 'once' });
    const result = await call({ role: 'replacement', injectMode: 'every', expectedRole: 'original',
      expectedInjectMode: 'once', padding: 'x'.repeat(400000) });
    expect(result.status).toBe(400);
    expect(await call()).toMatchObject({ role: 'original', injectMode: 'once' });
  });

  it('retains the smaller request budget for capability edits', async () => {
    const result = await call({ capability: 'test', padding: 'x'.repeat(65536) }, undefined, 'capability');
    expect(result.status).toBe(400);
  });

  it('does not enlarge the persisted role limit when increasing the JSON budget', async () => {
    expect((await call({ role: 'x'.repeat(33000), injectMode: 'once' })).status).toBe(200);
    expect((await call()).role).toBe('x'.repeat(32768));
  });
});
