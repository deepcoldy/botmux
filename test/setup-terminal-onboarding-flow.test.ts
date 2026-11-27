import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WecomOnboardingManager, handleWecomOnboardingApi, type WecomOnboardingOptions } from '../src/dashboard/wecom/onboarding.js';
import { readWecomConfigPaths } from '../src/im/wecom/config/discovery.js';
import { createWecomSetupClient } from '../src/cli/wecom/onboarding-client.js';
import { runWecomQrSetup, type WecomSetupPicker } from '../src/cli/wecom/setup-wizard.js';
import { resolveCliSelection } from '../src/setup/cli-selection.js';
import { loadWecomSecret, parseWecomConfig } from '../src/im/wecom/config/config.js';
const roots: string[] = [];
const actor = { userId: 'fixture-owner', authSessionId: 'fixture-cookie-session' };
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => resolve = done); return { promise, resolve }; };
// Real timers: every wait in these flows is injected (wizard sleep, readiness, QR and pairing deferreds).
// The yield is a real macrotask so the manager's file I/O and locks progress between polls; a fake-clock
// advance would not do that under Bun, whose async advance never returns to the event loop.
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise(done => setImmediate(done)); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(extra: Partial<WecomOnboardingOptions> = {}) {
 const root = mkdtempSync(join(tmpdir(), 'setup-terminal-flow-')); roots.push(root);
 const credentials = defer<{ botId: string; secret: string }>(), proof = defer<{ userid: string; verifiedAt: string }>(), ready = defer<void>();
 const authorize = vi.fn(async () => ({ authUrl: 'https://work.weixin.qq.com/fixture-qr', expiresAt: Date.now() + 300000, cancel: () => {}, waitForCredentials: () => credentials.promise }));
 const pair = vi.fn(async (options: any) => { options.beforeConnect(); options.onChallenge('BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF'); return proof.promise; });
 const start = vi.fn(async (_id: string) => ({} as any)); const stop = vi.fn(async (_id: string) => ({} as any));
 // The wizard's connections manager: begin() checks beforeStart, then runs start / stop.
 const connections = { connection: async () => undefined, idle: async () => {}, begin: (action: string, id: string, opts: { beforeStart?: () => void } = {}) => { opts.beforeStart?.(); const settled = Promise.resolve().then(() => (action === 'stop' ? stop(id) : start(id))).then(() => ({ ok: true, message: '' })); return { view: {} as any, settled }; } } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
 const options: WecomOnboardingOptions = { root, preflight: async () => ({ appName: 'fixture', cliId: 'codex', workingDir: root, backend: 'pty', port: 19345, dirMode: 'fixed', mode: 'qr' }), authorize, pair, manager: connections, waitForReady: () => ready.promise, ...extra };
 const manager = new WecomOnboardingManager(options); let loseStart = false, revoked = false; const requests: string[] = [];
 const transport = async (url: string, init: any = {}) => {
  const path = new URL(url).pathname; requests.push(`${init.method ?? 'GET'} ${path}`);
  if (revoked) return new Response('PRIVATE_AUTH_FAILURE', { status: 401 });
  if (path === '/') return new Response('<meta name="botmux-csrf" content="fixture_csrf_ticket_0123456789">', { headers: { 'content-type': 'text/html' } });
  expect(init.headers.cookie).toBe('botmux_dashboard_token=fixture_cookie_token_0123456789');
  if (init.method === 'POST') expect(init.headers['x-botmux-csrf']).toBe('fixture_csrf_ticket_0123456789');
  if (path.endsWith('/start')) {
   // Same mapping as the Dashboard route (dashboard.ts): a throw from start() becomes 400 { error }.
   let job; try { job = await manager.start(JSON.parse(init.body), actor); } catch (error) { const code = error instanceof Error && /^wecom_[a-z_]+$/.test(error.message) ? error.message : 'wecom_invalid_onboarding'; return Response.json({ ok: false, error: code }, { status: 400 }); }
   if (loseStart) { loseStart = false; throw Error('lost HTTP response PRIVATE_SECRET'); } return Response.json({ job });
  }
  let status = 0, body = ''; const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse;
  expect(await handleWecomOnboardingApi({ method: init.method ?? 'GET' } as IncomingMessage, res, new URL(url), { manager, actor, hostAdmin: true, csrfValid: () => true })).toBe(true);
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
 };
 const client = await createWecomSetupClient({ ok: true, url: 'http://127.0.0.1/?t=fixture_cookie_token_0123456789' }, 41234, { fetch: transport });
 const output: string[] = [], qr: string[] = [], answers: string[] = [];
 const prompt = { ask: vi.fn(async () => answers.shift() ?? 'q'), write: (text: string) => output.push(text) };
 // Selector answers: an item label, or a number for an item index (task ids are not known up front).
 const picks: Array<string | number> = [], cliPicks: string[] = [];
 const picker: WecomSetupPicker = {
  choose: async question => { const pick = picks.shift(); if (pick === undefined) throw new Error(`no answer for selector ${question.title}`); return typeof pick === 'number' ? pick : question.items.findIndex(item => item.label === pick); },
  chooseCli: async () => cliPicks.shift() ?? null,
 };
 const advance = async () => { await flush(); const job = manager.list(actor)[0]; if (job?.status === 'waiting_for_scan' && output.some(line => line.includes('https://work.weixin.qq.com/fixture-qr'))) credentials.resolve({ botId: 'fixture-platform-bot', secret: 'PRIVATE_PLATFORM_SECRET' }); if (job?.status === 'needs_pairing' && output.includes('BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF')) proof.resolve({ userid: 'native-owner', verifiedAt: new Date().toISOString() }); if (job?.status === 'starting_bot') ready.resolve(); await flush(); };
 return { root, manager, options, credentials, proof, ready, authorize, pair, start, stop, client, output, qr, answers, prompt, picks, cliPicks, picker, requests, advance, lose: () => loseStart = true, revoke: () => revoked = true };
}
const CONTINUE = '继续';
/** Answers for a new scan-to-create task, in the order the wizard asks: name, CLI, directory, backend, then 「继续」. */
const newBot = (f: { answers: string[]; cliPicks: string[]; picks: Array<string | number> }) => { f.answers.push('fixture', '/tmp'); f.cliPicks.push('codex'); f.picks.push('pty', CONTINUE); };
describe('terminal flow through shared onboarding manager and HTTP API', () => {
 it('completes QR, native private-message pairing, durable save and managed startup through the same state machine', async () => {
  const f = await fixture(); newBot(f); const code = await runWecomQrSetup({ connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker, sleep: f.advance, renderQr: url => f.qr.push(url) });
  expect(code).toBe(0); expect(f.qr).toEqual(['https://work.weixin.qq.com/fixture-qr']); expect(f.output).toContain('BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF'); expect(f.start).toHaveBeenCalledOnce(); expect(f.authorize).toHaveBeenCalledOnce(); expect(f.pair).toHaveBeenCalledOnce();
  const files = readWecomConfigPaths(f.root).filter(file => file !== join(f.root, 'config.json')); expect(files).toHaveLength(1); expect(JSON.parse(readFileSync(files[0], 'utf8')).allowedUsers).toEqual(['native-owner']); expect(f.output.join('\n')).not.toContain('PRIVATE_PLATFORM_SECRET');
 });
 it('recovers a task when the start operation succeeded but its HTTP response was lost, without a second creation', async () => {
  const f = await fixture(); f.lose(); newBot(f); expect(await runWecomQrSetup({ connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker })).toBe(2);
  expect(f.manager.list(actor)).toHaveLength(1); f.picks.push(0); expect(await runWecomQrSetup({ connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker, sleep: f.advance, renderQr: () => {} })).toBe(0);
  expect(f.requests.filter(path => path.endsWith('/start'))).toHaveLength(1); expect(f.authorize).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce(); expect(f.output.join('\n')).not.toContain('PRIVATE_SECRET');
 });
 it('cancels a late start response and rejects a native owner proof that arrives after cancellation', async () => {
  const f = await fixture(); const signal = new AbortController(); newBot(f);
  const client = { ...f.client, start: async (input: any) => { const job = await f.client.start(input); await flush(); f.credentials.resolve({ botId: 'fixture-platform-bot', secret: 'PRIVATE_PLATFORM_SECRET' }); await flush(); signal.abort(); return job; } };
  expect(await runWecomQrSetup({ connect: async () => client, tty: true, prompt: f.prompt, picker: f.picker, signal: signal.signal })).toBe(0);
  const job = f.manager.list(actor)[0]; expect(job.status).toBe('cancelled'); f.proof.resolve({ userid: 'late-owner', verifiedAt: new Date().toISOString() }); await flush(); expect(f.manager.get(job.id, actor)).toMatchObject({ status: 'cancelled', saved: false }); expect(f.start).not.toHaveBeenCalled();
 });
 it('does not duplicate startup after a polling authorization failure and cannot complete an obsolete token generation', async () => {
  let live = true; const f = await fixture({ isActorLive: () => live }); newBot(f);
  const code = await runWecomQrSetup({ connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker, renderQr: () => {}, sleep: async () => { await flush(); live = false; f.revoke(); f.credentials.resolve({ botId: 'late-bot', secret: 'PRIVATE_PLATFORM_SECRET' }); await flush(); } });
  expect(code).toBe(2); expect(f.requests.filter(path => path.endsWith('/start'))).toHaveLength(1); expect(f.start).not.toHaveBeenCalled(); expect(f.output.join('\n')).not.toContain('PRIVATE_AUTH_FAILURE'); expect(f.manager.list(actor)[0]?.status).toBe('failed');
 });
 it('rejects changed saved configuration during a long readiness window instead of reporting old generation completed', async () => {
  const f = await fixture(); newBot(f); f.answers.push('q'); let changed = false;
  const code = await runWecomQrSetup({ connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker, renderQr: () => {}, sleep: async () => { await flush(); const job = f.manager.list(actor)[0]; if (job?.status === 'starting_bot' && !changed) { const file = readWecomConfigPaths(f.root).find(path => path !== join(f.root, 'config.json'))!; const config = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, JSON.stringify({ ...config, displayName: 'operator-changed' })); changed = true; f.ready.resolve(); await flush(); } else if (job?.status === 'waiting_for_scan') { f.credentials.resolve({ botId: 'fixture-platform-bot', secret: 'PRIVATE_PLATFORM_SECRET' }); await flush(); } else if (job?.status === 'needs_pairing') { f.proof.resolve({ userid: 'native-owner', verifiedAt: new Date().toISOString() }); await flush(); } } });
  expect(code).toBe(0); expect(changed).toBe(true); expect(f.manager.list(actor)[0]).toMatchObject({ status: 'failed', saved: true }); expect(f.start).toHaveBeenCalledOnce();
 });
 it('manual credentials from the terminal start the same manual job as the browser form: no QR, pairing with those credentials, saved and started', async () => {
  // The Dashboard side resolves the CLI selection key exactly as the real preflight does.
  const bodies: Record<string, unknown>[] = [];
  const f = await fixture({ preflight: async raw => {
   bodies.push(raw); const selection = resolveCliSelection(String(raw.cliId));
   return { appName: String(raw.appName ?? ''), cliId: selection.cliId, wrapperCli: selection.wrapperCli, cliLaunchMode: selection.cliLaunchMode, workingDir: f.root, backend: 'pty', port: 19346, dirMode: 'fixed', mode: raw.mode === 'manual' ? 'manual' : 'qr' };
  } });
  const SECRET = 'MANUAL-ACCEPTANCE-SECRET-41d7';
  f.answers.push('fixture-manual-bot', SECRET, 'manual-name', '/tmp'); f.cliPicks.push('aiden-x-claude'); f.picks.push('pty', CONTINUE);
  const code = await runWecomQrSetup({ mode: 'manual', connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker, sleep: f.advance, renderQr: url => f.qr.push(url) });
  expect(code).toBe(0); expect(f.authorize).not.toHaveBeenCalled(); expect(f.qr).toEqual([]); expect(f.requests.filter(path => path.endsWith('/start'))).toHaveLength(1);
  expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ platform: 'wecom', mode: 'manual', botId: 'fixture-manual-bot', secret: SECRET, cliId: 'aiden-x-claude' }); expect(bodies[0]).not.toHaveProperty('wrapperCli');
  expect(f.pair).toHaveBeenCalledOnce(); expect(f.pair.mock.calls[0][0]).toMatchObject({ botId: 'fixture-manual-bot', secret: SECRET });
  const files = readWecomConfigPaths(f.root).filter(file => file !== join(f.root, 'config.json')); expect(files).toHaveLength(1);
  const saved = parseWecomConfig(JSON.parse(readFileSync(files[0], 'utf8'))); expect(saved).toMatchObject({ botId: 'fixture-manual-bot', allowedUsers: ['native-owner'], managedCore: { cli: 'claude-code', botConfig: { wrapperCli: 'aiden x claude' } } }); expect(loadWecomSecret(saved)).toBe(SECRET);
  expect(f.manager.list(actor)).toEqual([]); expect(f.output.join('\n')).not.toContain(SECRET);
 });
 it('a refusal before anything is created asks again only that answer, keeps the manual credentials, and starts once more without a second receipt', async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = await fixture({ preflight: async raw => {
   bodies.push(raw);
   if (raw.workingDir !== f.root) throw new Error('wecom_working_directory_unavailable');
   return { appName: '', cliId: 'codex', workingDir: f.root, backend: 'pty', port: 19347, dirMode: 'fixed', mode: raw.mode === 'manual' ? 'manual' : 'qr' };
  } });
  const SECRET = 'MANUAL-REFUSAL-SECRET-8e02';
  f.answers.push('fixture-refusal-bot', SECRET, '', '/definitely/missing', f.root); f.cliPicks.push('codex'); f.picks.push('pty', CONTINUE, CONTINUE);
  const code = await runWecomQrSetup({ mode: 'manual', connect: async () => f.client, tty: true, prompt: f.prompt, picker: f.picker, sleep: f.advance, renderQr: () => {} });
  expect(code).toBe(0); expect(f.requests.filter(path => path.endsWith('/start'))).toHaveLength(2);
  expect(bodies.map(body => [body.workingDir, body.botId, body.secret === SECRET])).toEqual([['/definitely/missing', 'fixture-refusal-bot', true], [f.root, 'fixture-refusal-bot', true]]);
  expect(f.pair).toHaveBeenCalledOnce(); expect(readWecomConfigPaths(f.root).filter(file => file !== join(f.root, 'config.json'))).toHaveLength(1);
  expect(readdirSync(join(f.root, 'onboarding')).filter(name => name.endsWith('.json'))).toHaveLength(1);
  expect(f.output.join('\n')).not.toContain(SECRET);
 });
});
