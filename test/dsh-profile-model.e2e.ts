/**
 * Opt-in real DSH acceptance. Install @deepseek-ai/dsh outside the worktree,
 * then set BOTMUX_TEST_DSH_NODE_MODULES to that installation's node_modules.
 * Uses a temporary DSH_HOME and a loopback model endpoint; no real API keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnTsScript } from './helpers/ts-runner.js';
import { resolveDshModel } from '../src/dsh-runner-config.js';
import { isMap, parseDocument, type YAMLSeq } from 'yaml';

const modules = process.env.BOTMUX_TEST_DSH_NODE_MODULES;

describe.skipIf(!modules)('real DSH profile model selection', () => {
  let root: string;
  let dshHome: string;
  let dshBin: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let overlay: string;
  const calls: Array<{ model: string; path: string; credentialMatched: boolean }> = [];

  beforeEach(() => { calls.length = 0; });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-dsh-profile-'));
    dshHome = join(root, 'dsh');
    const runtimeModules = resolve(modules!);
    dshBin = join(runtimeModules, '.bin', 'dsh');
    server = createServer((req, res) => {
      let input = '';
      req.on('data', chunk => { input += chunk; });
      req.on('end', () => {
        const body = JSON.parse(input);
        calls.push({ model: body.model, path: req.url!, credentialMatched: req.headers.authorization === 'Bearer fixture-key' });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown, finishReason: string | null) => ({
          id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } : {}),
        });
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'PROFILE_OK' }, null))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    for (const [name, provider, model] of [
      ['botmux', 'flatkey', 'profile-model'],
      ['second-profile', 'second-provider', 'second-model'],
    ]) {
      const dir = join(dshHome, 'profiles', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: `dsh-profile-${name}`, private: true, dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
      }));
      writeFileSync(join(dir, 'cordis.yml'), '[]\n');
      symlinkSync(runtimeModules, join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, 'cordis.patch.yml'), `
- id: agent-default-model
  config:
    provider: ${provider}
    model: ${model}
- id: llm-pi-ai
  config:
    providers:
      ${provider}:
        api: openai-completions
        apiKeyEnv: BOTMUX_DSH_FIXTURE_KEY
        baseURL: http://127.0.0.1:${port}/v1
        models:
          - id: ${model}
            contextWindow: 262144
            maxTokens: 65536
          - id: overlay-model
            contextWindow: 262144
            maxTokens: 65536
- id: session-telemetry-otel
  disabled: true
`);
    }
    writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  BOTMUX_DSH_FIXTURE_KEY: fixture-key\n', { mode: 0o600 });
    writeFileSync(join(dshHome, 'settings.yaml.imported'), 'agent-default-model:\n  provider: obsolete\n  model: obsolete\n');
    overlay = join(root, 'overlay with spaces.yml');
    writeFileSync(overlay, '- id: agent-default-model\n  config:\n    provider: flatkey\n    model: overlay-model\n');
    env = { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: undefined, BOTMUX_DSH_FIXTURE_KEY: undefined, DSH_TELEMETRY_DISABLED: '1' };
  });

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('follows real profile and patch composition while preserving an explicit model override', () => {
    const select = (profile: string, patch?: string, model?: string) => resolveDshModel({
      dshBin, launchArgs: ['--profile', profile, ...(patch ? [`--patch=${patch}`] : [])],
      cwd: root, env, dshHome, model,
    });
    expect(select('botmux')).toMatchObject({ provider: 'flatkey', model: 'profile-model' });
    expect(select('second-profile')).toMatchObject({ provider: 'second-provider', model: 'second-model' });
    expect(select('botmux', overlay)).toMatchObject({ provider: 'flatkey', model: 'overlay-model' });
    expect(select('botmux', overlay, 'profile-model')).toMatchObject({ provider: 'flatkey', model: 'profile-model' });
  });

  function cloneHome(name: string): string {
    const home = join(root, name);
    mkdirSync(home);
    cpSync(join(dshHome, 'profiles'), join(home, 'profiles'), { recursive: true });
    writeFileSync(join(home, '.credentials.yaml'), readFileSync(join(dshHome, '.credentials.yaml')), { mode: 0o600 });
    return home;
  }

  async function completeTurn(home: string, sessionId: string): Promise<void> {
    const child = spawnTsScript(resolve('src/dsh-runner.ts'), [
      '--session-id', sessionId, '--dsh-bin', dshBin, '--cwd', root,
    ], { cwd: resolve('.'), env: { ...env, DSH_HOME: home }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let submitted = false;
    let timer: ReturnType<typeof setTimeout>;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      const final = await new Promise<{ content: string }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`real DSH turn timed out\n${stderr}`)), 45_000);
        child.stderr!.on('data', chunk => { stderr += chunk; });
        child.stdout!.on('data', chunk => {
          stdout += chunk;
          if (!submitted && stdout.includes('›')) {
            submitted = true;
            const frame = Buffer.from(JSON.stringify({ type: 'message', content: 'Reply PROFILE_OK. Do not use tools.' })).toString('base64');
            child.stdin!.write(`::botmux-dsh:${frame}\n`);
          }
          const marker = /\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/.exec(stdout);
          if (marker) resolve(JSON.parse(Buffer.from(marker[1], 'base64').toString()));
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`real DSH exited ${code}\n${stderr}`)));
      });
      expect(final.content).toBe('PROFILE_OK');
    } finally {
      clearTimeout(timer!);
      child.stdin!.end();
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 4000);
      await exited;
      clearTimeout(killTimer);
    }
  }

  it('completes a real SDK turn using the custom route and its managed credential without an official key', async () => {
    await completeTurn(dshHome, 'real-profile-test');
    expect(calls).toEqual([{ model: 'profile-model', path: '/v1/chat/completions', credentialMatched: true }]);
  });

  it('uses pending legacy settings on first boot and follows the profile after migration', async () => {
    const home = cloneHome('migration');
    const patchPath = join(home, 'profiles', 'botmux', 'cordis.patch.yml');
    const patch = parseDocument(readFileSync(patchPath, 'utf8'));
    patch.delete(0); // Leave the bundle's official default in place until DSH imports the legacy selection.
    writeFileSync(patchPath, String(patch));
    writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: flatkey\n  model: profile-model\n');

    await completeTurn(home, 'before-migration');
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false);
    expect(existsSync(join(home, 'settings.yaml.imported'))).toBe(true);
    expect(calls).toEqual([{ model: 'profile-model', path: '/v1/chat/completions', credentialMatched: true }]);

    const migrated = parseDocument(readFileSync(patchPath, 'utf8'));
    migrated.add({ id: 'agent-default-model', config: { provider: 'flatkey', model: 'overlay-model' } });
    writeFileSync(patchPath, String(migrated));
    await completeTurn(home, 'after-migration');
    expect(calls.at(-1)).toEqual({ model: 'overlay-model', path: '/v1/chat/completions', credentialMatched: true });
  });

  it('uses a default model nested in a real bundle group for configuration and an SDK turn', async () => {
    const home = cloneHome('grouped');
    const profile = join(home, 'profiles', 'botmux');
    const runtimeModules = resolve(modules!);
    unlinkSync(join(profile, 'node_modules')); // Replace only the fixture's symlink; never modify shared dependencies.
    const bundle = join(profile, 'node_modules', 'grouped-base');
    mkdirSync(bundle, { recursive: true });
    symlinkSync(join(runtimeModules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'dir');
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: 'grouped-base', version: '0.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
    const base = parseDocument(readFileSync(join(runtimeModules, '@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    });
    const rows = base.getIn([0, 'insert'], true) as YAMLSeq;
    const index = rows.items.findIndex(row => isMap(row) && row.get('id') === 'agent-default-model');
    expect(index).toBeGreaterThanOrEqual(0);
    base.setIn([0, 'insert', index], {
      id: 'model-group', name: 'cordis:group', group: true, config: [rows.items[index]],
    });
    writeFileSync(join(bundle, 'cordis.patch.yml'), String(base));
    const pkgPath = join(profile, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dsh.profile.bundles = ['grouped-base', '@deepseek-ai/dsh-sdk-app'];
    writeFileSync(pkgPath, JSON.stringify(pkg));

    expect(resolveDshModel({ dshBin, launchArgs: ['--profile', 'botmux'], cwd: root, env: { ...env, DSH_HOME: home }, dshHome: home }))
      .toMatchObject({ provider: 'flatkey', model: 'profile-model' });
    await completeTurn(home, 'grouped-profile-test');
    expect(calls).toEqual([{ model: 'profile-model', path: '/v1/chat/completions', credentialMatched: true }]);
  });
});
