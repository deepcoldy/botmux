import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT_PROFILE_SHARED_PARTS } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer | undefined, server: Server | undefined, root: string | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals();
  if (server) await new Promise<void>(done => server!.close(() => done())); server = undefined;
  if (root) rmSync(root, { recursive: true, force: true }); root = undefined;
});
it('sends real HTTP saves only to the selected WeCom adapter and never to Lark bot routes', async () => {
  root = mkdtempSync(join(tmpdir(), 'wecom-profile-network-'));
  const file = join(root, 'config.json'), id = wecomConfigId(file);
  const executable = join(root, 'fixture-cli.cjs');
  writeFileSync(executable, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('codex-cli 0.134.0');else if(process.argv.includes('--help'))console.log('--profile');else console.log('{"models":[]}');\n`, { mode: 0o700 });
  writeFileSync(file, JSON.stringify({ botId: 'native', secretEnv: 'FAKE_SECRET', allowedUsers: ['alice'], coreUrl: 'http://127.0.0.1:19821',
    managedCore: { botId: 'local_http_acceptance', cli: 'codex', backend: 'pty', port: 19821, workingDirectory: root, stateDir: join(root, 'core'), botConfig: { cliRuntime: { id: 'network-fixture', executable }, cliPathOverride: executable } } }), { mode: 0o600 });
  const configuration = new WecomDashboardConfig(root), calls: { method: string; url: string }[] = [];
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); calls.push({ method: req.method!, url: req.url! });
    if (url.pathname.startsWith('/api/wecom/')) {
      await handleWecomConnectionsApi(req, res, url, { hostAdmin: true, csrfValid: true, configuration,
        readBody: async () => { let text = ''; for await (const chunk of req) text += String(chunk); return text ? JSON.parse(text) : {}; } }); return;
    }
    if (url.pathname.startsWith('/api/cli-options')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'unknown', models: [] })); return; }
    if (url.pathname === '/api/config' || url.pathname === '/api/prompt-cache') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(418, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unexpected_http_route' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => originalFetch(new URL(String(input), origin), init));
  await act(async () => { renderer = TestRenderer.create(React.createElement(WecomBotDefaultsCard, {
    shared: BOT_PROFILE_SHARED_PARTS,
    connection: { id, label: 'native', configuration: 'ready', ownership: 'dashboard', gateway: 'stopped' } as any,
    cliState: { options: [{ id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }] } as any,
    activeTab: 'common', onTabChange: vi.fn(), onRefresh: vi.fn(), onAction: vi.fn(),
  })); });
  for (let attempt = 0; attempt < 30 && !renderer!.root.findAllByProps({ 'data-action': 'save-agent' }).length; attempt++) await act(async () => { await new Promise(done => setTimeout(done, 10)); });
  expect(renderer!.root.findAllByProps({ 'data-action': 'save-agent' })).toHaveLength(1);
  for (const [index, action] of ['save-agent', 'save-access', 'save-role'].entries()) {
    await act(async () => renderer!.root.findByProps({ 'data-action': action }).props.onClick());
    await act(async () => { await vi.waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(index + 1)); await new Promise(done => setTimeout(done, 20)); });
  }
  await act(async () => renderer!.root.findByProps({ 'data-action': 'edit-bot-name' }).props.onClick());
  await act(async () => renderer!.root.findByProps({ 'data-input': 'botRename' }).props.onChange({ currentTarget: { value: 'renamed-native' } }));
  await act(async () => { renderer!.root.findByProps({ 'data-action': 'save-bot-name' }).props.onClick(); await vi.waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(4)); await new Promise(done => setTimeout(done, 20)); });
  expect(configuration.get(id).displayName).toBe('renamed-native');
  expect(renderer!.root.findByProps({ 'data-bot-name': true }).children).toContain('renamed-native');
  await act(async () => renderer!.root.findByProps({ dataInput: 'agentCliId' }).props.onChange('claude-code'));
  await act(async () => renderer!.root.findByProps({ dataInput: 'agentCliId' }).props.onChange('codex'));
  await act(async () => { await new Promise(done => setTimeout(done, 30)); });
  expect(calls.filter(call => call.method === 'PATCH').every(call => call.url === `/api/wecom/connections/${id}/config`)).toBe(true);
  expect(calls.filter(call => /^\/api\/(bots|team\/local-bots)\//.test(call.url))).toEqual([]);
  expect(calls.filter(call => call.url.startsWith('/api/cli-options')).every(call => !new URL(call.url, origin).searchParams.has('bot'))).toBe(true);
  expect(configuration.get(id).cli).toBe('codex');
});
