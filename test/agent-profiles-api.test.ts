import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleAgentProfilesApi, type AgentProfilesApiDeps } from '../src/dashboard/agent-profiles-api.js';

let dir: string;
let agentsPath: string;
let server: Server;
let base: string;
let deps: Partial<AgentProfilesApiDeps>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-agents-api-'));
  agentsPath = join(dir, 'agents.json');
  deps = {};
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleAgentProfilesApi(req, res, url, {
      canManageHost: true,
      knownBotIds: () => new Set(['cli_a', 'cli_b']),
      agentsPath: () => agentsPath,
      checkWorkingDir: dirPath => (dirPath === '/missing' ? 'not found' : null),
      now: () => 1_000,
      ...deps,
    }).then(handled => {
      if (!handled) { res.writeHead(599); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

const agent = { name: '主仓库 Claude', exec: { cliId: 'claude-code', model: '', reasoningEffort: '' } };

describe('/api/agents', () => {
  it('returns an empty snapshot before agents.json exists and ignores unrelated paths', async () => {
    expect(await call('GET', '/api/agents')).toEqual({ status: 200, body: { ok: true, agents: [], links: {} } });
    expect((await call('GET', '/api/agentsx')).status).toBe(599);
  });

  it('creates an agent, optionally linking bots, and persists it privately', async () => {
    const created = await call('POST', '/api/agents', { agent, linkBots: ['cli_a', 'cli_a'] });
    expect(created.status).toBe(200);
    const id = created.body.agent.id;
    expect(id).toMatch(/^ag_/);
    expect(created.body.agent).toMatchObject({ name: '主仓库 Claude', createdAt: 1_000, updatedAt: 1_000 });
    expect(created.body.links).toEqual({ cli_a: id });
    const onDisk = JSON.parse(readFileSync(agentsPath, 'utf-8'));
    expect(onDisk).toMatchObject({ version: 1, links: { cli_a: id } });
    expect(statSync(agentsPath).mode & 0o777).toBe(0o600);
  });

  it('validates the CLI selection key, effort/model pairing and working dir', async () => {
    expect((await call('POST', '/api/agents', { agent: { name: 'x', exec: { cliId: 'nope' } } })).body.error).toBe('exec:invalid_cli');
    expect((await call('POST', '/api/agents', {
      agent: { name: 'x', exec: { cliId: 'codex', model: 'unknown-model', reasoningEffort: 'ultra' } },
    })).body.error).toBe('exec:reasoning_effort_not_supported_by_model');
    const missingDir = await call('POST', '/api/agents', { agent: { name: 'x', workspace: { mode: 'default', workingDir: '/missing' } } });
    expect(missingDir).toMatchObject({ status: 400, body: { error: 'workspace:invalid_working_dir', message: 'not found' } });
    expect((await call('POST', '/api/agents', { agent, linkBots: ['cli_unknown'] })).status).toBe(404);
  });

  it('accepts a Claude config profile only for a CLI that supports it, and only if it exists', async () => {
    const ok = await call('POST', '/api/agents', { agent: { name: 'api', exec: { cliId: 'claude-code', configDir: '~/.claude-api' } } });
    expect(ok.body.agent.exec).toMatchObject({ cliId: 'claude-code', configDir: '~/.claude-api' });
    expect((await call('POST', '/api/agents', { agent: { name: 'x', exec: { cliId: 'codex', configDir: '~/.claude-api' } } })).body.error)
      .toBe('exec:config_dir_unsupported');
    expect((await call('POST', '/api/agents', { agent: { name: 'x', exec: { cliId: 'claude-code', configDir: '/missing' } } })).body)
      .toMatchObject({ error: 'exec:invalid_config_dir', message: 'not found' });
  });

  it('updates the definition while keeping id and createdAt', async () => {
    const id = (await call('POST', '/api/agents', { agent })).body.agent.id;
    deps.now = () => 2_000;
    const updated = await call('PUT', `/api/agents/${id}`, { agent: { ...agent, name: '改名', sandbox: { mode: 'oncall' } } });
    expect(updated.body.agent).toMatchObject({ id, name: '改名', sandbox: { mode: 'oncall' }, createdAt: 1_000, updatedAt: 2_000 });
    expect((await call('PUT', '/api/agents/ag_missing1', { agent })).status).toBe(404);
  });

  it('links, re-links and unlinks without touching other bots', async () => {
    const a = (await call('POST', '/api/agents', { agent })).body.agent.id;
    const b = (await call('POST', '/api/agents', { agent: { ...agent, name: 'B' } })).body.agent.id;
    expect((await call('PUT', `/api/agents/${a}/links/cli_a`)).body).toMatchObject({ previous: null, links: { cli_a: a } });
    expect((await call('PUT', `/api/agents/${a}/links/cli_b`)).body.links).toEqual({ cli_a: a, cli_b: a });
    expect((await call('PUT', `/api/agents/${b}/links/cli_a`)).body).toMatchObject({ previous: a, links: { cli_a: b, cli_b: a } });
    // 只解除确实指向该 Agent 的边：cli_a 已改关联到 b，用 a 解除不应误删。
    expect((await call('DELETE', `/api/agents/${a}/links/cli_a`)).body.links).toEqual({ cli_a: b, cli_b: a });
    expect((await call('DELETE', `/api/agents/${b}/links/cli_a`)).body.links).toEqual({ cli_b: a });
    expect((await call('PUT', `/api/agents/${a}/links/cli_unknown`)).status).toBe(404);
  });

  it('deletes an agent together with its links', async () => {
    const id = (await call('POST', '/api/agents', { agent, linkBots: ['cli_a', 'cli_b'] })).body.agent.id;
    const removed = await call('DELETE', `/api/agents/${id}`);
    expect(removed.body).toMatchObject({ ok: true, agents: [], links: {} });
    expect(removed.body.unlinked.sort()).toEqual(['cli_a', 'cli_b']);
  });

  it('hides links of bots that are no longer in bots.json', async () => {
    const id = (await call('POST', '/api/agents', { agent, linkBots: ['cli_a', 'cli_b'] })).body.agent.id;
    deps.knownBotIds = () => new Set(['cli_a']);
    expect((await call('GET', '/api/agents')).body.links).toEqual({ cli_a: id });
  });

  it('requires management rights for every write', async () => {
    deps.canManageHost = false;
    expect((await call('GET', '/api/agents')).status).toBe(200);
    expect((await call('POST', '/api/agents', { agent })).status).toBe(403);
    expect((await call('DELETE', '/api/agents/ag_whatever')).status).toBe(403);
  });

  it('refuses to overwrite a corrupt agents.json', async () => {
    writeFileSync(agentsPath, '{ not json');
    expect((await call('GET', '/api/agents')).body.error).toBe('agents_file_invalid');
    expect((await call('POST', '/api/agents', { agent })).status).toBe(500);
    expect(readFileSync(agentsPath, 'utf-8')).toBe('{ not json');
  });

  it('rejects malformed bodies', async () => {
    const response = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[' });
    expect(response.status).toBe(400);
    expect((await call('POST', '/api/agents', { agent: { name: '' } })).body.error).toBe('name_required');
  });
});

describe('/api/agents zero injection', () => {
  it('stores the mode and rejects it up front when the unified CLI cannot support it', async () => {
    const ok = await call('POST', '/api/agents', { agent: { ...agent, promptInjection: { mode: 'none' } } });
    expect(ok.body.agent.promptInjection).toEqual({ mode: 'none' });
    const gemini = await call('POST', '/api/agents', {
      agent: { name: 'g', exec: { cliId: 'gemini', model: '', reasoningEffort: '' }, promptInjection: { mode: 'none' } },
    });
    expect(gemini).toMatchObject({ status: 400, body: { error: 'promptInjection:unsupported' } });
    const withSandbox = await call('POST', '/api/agents', {
      agent: { ...agent, sandbox: { mode: 'off' }, promptInjection: { mode: 'none' } },
    });
    expect(withSandbox.status).toBe(200);
    // Without a unified CLI each bot's daemon validates against its own CLI on push.
    const noExec = await call('POST', '/api/agents', { agent: { name: 'n', promptInjection: { mode: 'none' } } });
    expect(noExec.status).toBe(200);
    expect((await call('POST', '/api/agents', { agent: { name: 'n', promptInjection: { mode: 'off' } } })).body.error)
      .toBe('promptInjection:invalid_prompt_injection');
  });
});
