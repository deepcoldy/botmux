import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveBunExecutable, resolveNodeExecutable, spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexBrowserAuthenticatedFetch, resolveBrowserFetchRuntime } from '../src/services/codex-browser-authenticated-fetch.js';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleRpc } from '../src/services/codex-browser-fetch-service.js';

const mock = vi.hoisted(() => ({
  callTool: vi.fn(), connect: vi.fn(), close: vi.fn(), transport: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    callTool = mock.callTool;
    connect = mock.connect;
    close = mock.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
  StdioClientTransport: class {
    constructor(options: unknown) { mock.transport(options); }
    close = mock.close;
  },
}));

function result(body = 'ok', status = 200) {
  return { content: [{ type: 'text', text: JSON.stringify({
    status, statusText: '', headers: [['content-type', 'text/plain']],
    body: Buffer.from(body).toString('base64'),
  }) }] };
}
function config() {
  return { config: { mcp_servers: { node_repl: {
    command: process.execPath, args: [], env: { NODE_REPL_TRUSTED_CODE_PATHS: '/trusted' },
  } } } };
}

describe('CodexBrowserAuthenticatedFetch', () => {
  let fetcher: CodexBrowserAuthenticatedFetch;
  beforeEach(() => {
    vi.clearAllMocks();
    mock.connect.mockResolvedValue(undefined);
    mock.close.mockResolvedValue(undefined);
    mock.callTool.mockResolvedValue(result());
    fetcher = new CodexBrowserAuthenticatedFetch({
      readConfig: async () => config(), requestMeta: () => ({ 'x-codex-turn-metadata': 'turn-meta' }),
    });
  });
  afterEach(async () => { await fetcher.close(); vi.unstubAllEnvs(); });

  it('uses the installed authenticated runtime and preserves HTTP request/response data', async () => {
    const response = await fetcher.fetch('https://chatgpt.com/backend-api/aura/identity', {
      method: 'POST', headers: { 'x-test': 'value' }, body: 'hello',
    });
    expect(await response.text()).toBe('ok');
    const call = mock.callTool.mock.calls[0]![0];
    expect(call._meta).toEqual({ 'x-codex-turn-metadata': 'turn-meta' });
    expect(call.arguments.code).toContain('"body":"aGVsbG8="');
    expect(call.arguments.code).toContain('"x-test","value"');
    const env = mock.transport.mock.calls[0]![0].env;
    expect(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).botmux_browser_fetch).toMatch(/codex-browser-fetch-service\.mjs$/);
    expect(env.NODE_REPL_TRUSTED_CODE_PATHS).toMatch(/codex-browser-fetch-service\.mjs$/);
    expect(env.LARK_APP_SECRET).toBeUndefined();
    const service = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).botmux_browser_fetch;
    expect(readFileSync(service, 'utf8')).toContain('export const handleRpc');
    if (process.platform !== 'win32') expect(statSync(service).mode & 0o777).toBe(0o600);
    await fetcher.close();
    expect(existsSync(service)).toBe(false);
  });

  it('serializes concurrent requests and reuses one authenticated process', async () => {
    let release!: (value: unknown) => void;
    mock.callTool.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = fetcher.fetch('https://chatgpt.com/first');
    const second = fetcher.fetch('https://chatgpt.com/second');
    await vi.waitFor(() => expect(mock.callTool).toHaveBeenCalledTimes(1));
    release(result());
    await Promise.all([first, second]);
    expect(mock.callTool).toHaveBeenCalledTimes(2);
    expect(mock.connect).toHaveBeenCalledTimes(1);
  });

  it('fails closed without leaking runtime errors or falling back to plain fetch', async () => {
    mock.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'secret-token' }] });
    await expect(fetcher.fetch('https://chatgpt.com/')).rejects.toThrow('authenticated request failed');
    await expect(fetcher.fetch('https://chatgpt.com/')).resolves.toBeInstanceOf(Response);
  });

  it('retries a failed runtime startup', async () => {
    mock.connect.mockRejectedValueOnce(new Error('offline'));
    await expect(fetcher.fetch('https://chatgpt.com/')).rejects.toThrow('offline');
    const service = JSON.parse(mock.transport.mock.calls[0]![0].env.NODE_REPL_TRUSTED_SERVICES).botmux_browser_fetch;
    expect(existsSync(service)).toBe(false);
    await expect(fetcher.fetch('https://chatgpt.com/')).resolves.toBeInstanceOf(Response);
    expect(mock.connect).toHaveBeenCalledTimes(2);
  });

  it('does not start a runtime for an already aborted request', async () => {
    await expect(fetcher.fetch('https://chatgpt.com/', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it('rejects requests after shutdown', async () => {
    await fetcher.close();
    await expect(fetcher.fetch('https://chatgpt.com/')).rejects.toThrow('closed');
  });

  it('preserves bodyless HTTP responses', async () => {
    mock.callTool.mockResolvedValueOnce(result('', 204));
    const response = await fetcher.fetch('https://chatgpt.com/');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('reports missing runtime configuration instead of sending an anonymous request', async () => {
    vi.stubEnv('BOTMUX_CODEX_NODE_REPL_PATH', '/definitely-missing-botmux-runtime/node_repl');
    const missing = new CodexBrowserAuthenticatedFetch({ readConfig: async () => ({}), requestMeta: () => ({}) });
    await expect(missing.fetch('https://chatgpt.com/')).rejects.toThrow('authenticated runtime was not found');
    expect(mock.callTool).not.toHaveBeenCalled();
    await missing.close();
  });

  it('works after the desktop removes the node_repl MCP registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-browser-runtime-'));
    try {
      const command = join(root, 'node_repl');
      writeFileSync(command, 'fixture');
      writeFileSync(join(root, process.platform === 'win32' ? 'node.exe' : 'node'), 'fixture');
      vi.stubEnv('BOTMUX_CODEX_NODE_REPL_PATH', command);
      const fallback = new CodexBrowserAuthenticatedFetch({
        readConfig: async () => ({ config: { mcp_servers: { botmux: {} } } }),
        requestMeta: () => ({}), codexBin: '/installed/codex',
      });
      await expect(fallback.fetch('https://chatgpt.com/')).resolves.toBeInstanceOf(Response);
      expect(mock.transport.mock.calls.at(-1)![0]).toMatchObject({
        command, env: { CODEX_CLI_PATH: '/installed/codex', NODE_REPL_NODE_PATH: join(root, process.platform === 'win32' ? 'node.exe' : 'node') },
      });
      await fallback.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('prefers a valid registered runtime and fails when no installed runtime exists', () => {
    expect(resolveBrowserFetchRuntime(config().config, [])).toEqual(config().config.mcp_servers.node_repl);
    expect(() => resolveBrowserFetchRuntime({}, [])).toThrow('runtime was not found');
  });
});

describe('trusted fetch service', () => {
  it('delegates authentication to the official runtime and preserves non-200 status', async () => {
    const globals = globalThis as unknown as { nodeRepl?: unknown };
    const previous = globals.nodeRepl;
    const fetch = vi.fn(async () => new Response('denied', { status: 403 }));
    globals.nodeRepl = { fetch };
    try {
      const response = await handleRpc({ method: 'fetch', params: {
        url: 'https://chatgpt.com/backend-api/aura/identity', method: 'POST',
        headers: [], body: Buffer.from('body').toString('base64'),
      } });
      expect(response).toMatchObject({ status: 403, body: Buffer.from('denied').toString('base64') });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]).toEqual([
        'https://chatgpt.com/backend-api/aura/identity',
        expect.objectContaining({ body: Buffer.from('body'), redirect: 'error' }),
      ]);
    } finally { globals.nodeRepl = previous; }
  });
});

// This must cross a real process boundary: Bun's virtual filesystem is only
// visible inside the compiled executable. Minification matches release builds.
it.skipIf(!resolveBunExecutable())('materializes an executable trusted service from a minified Bun binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-browser-compiled-'));
  try {
    const entry = join(root, 'entry.ts');
    const binary = join(root, process.platform === 'win32' ? 'probe.exe' : 'probe');
    writeFileSync(entry, `
      import { materializeBrowserFetchService } from ${JSON.stringify(resolve('src/services/codex-browser-fetch-service.ts'))};
      import { spawnSync } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const service = materializeBrowserFetchService();
      try {
        const code = 'globalThis.nodeRepl = { fetch: async () => new Response("compiled-ok", {status: 201}) };' +
          'const {handleRpc} = await import(' + JSON.stringify(pathToFileURL(service.path).href) + ');' +
          'const result = await handleRpc({method:"fetch",params:{url:"https://example.test",method:"GET",headers:[]}});' +
          'if(result.status !== 201 || Buffer.from(result.body,"base64").toString() !== "compiled-ok") throw Error("bad response");';
        const child = spawnSync(process.argv[2], ['--input-type=module', '-e', code], {encoding:'utf8'});
        if(child.status !== 0) throw Error(child.stderr || String(child.error));
      } finally { service.dispose(); }
      if(existsSync(service.path)) throw Error('service was not cleaned up');
      console.log('compiled service passed');
    `);
    const build = spawnSyncBunTsEvalWithRepoImports(`
      const result = await Bun.build({entrypoints:[${JSON.stringify(entry)}], compile:{outfile:${JSON.stringify(binary)}}, minify:true});
      if(!result.success) throw Error(String(result.logs));
    `, { encoding: 'utf8', timeout: 60_000 });
    expect(build.status, String(build.stderr)).toBe(0);
    const run = spawnSync(binary, [resolveNodeExecutable()!], { encoding: 'utf8', timeout: 20_000 });
    expect(run.status, String(run.stderr)).toBe(0);
    expect(run.stdout).toContain('compiled service passed');
  } finally { rmSync(root, {recursive:true, force:true}); }
}, 90_000);
