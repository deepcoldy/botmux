import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAcpMcpServers } from '../src/services/minimax-acp-mcp.js';
import { logger } from '../src/utils/logger.js';

let root: string;
let cwd: string;
let dataDir: string;
const stdio = { command: 'node', args: ['server.mjs'], env: { KEY: 'account-literal' } };
const http = { type: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer synthetic' } };
const write = (path: string, servers: Record<string, unknown>) => writeFileSync(path, JSON.stringify({ mcpServers: servers }));
const read = (overrides: Partial<Parameters<typeof loadAcpMcpServers>[0]> = {}) =>
  loadAcpMcpServers({ cwd, dataDir, env: { MCP_TOKEN: 'project-secret' }, capabilities: { http: true, sse: true }, ...overrides });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-mcp-config-'));
  cwd = join(root, 'work'); dataDir = join(root, 'account');
  mkdirSync(cwd); mkdirSync(dataDir);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('MiniMax ACP MCP configuration', () => {
  it('keeps unconfigured accounts working without warnings', () => {
    expect(read()).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('maps all advertised transports, retaining account credentials as literal values', () => {
    write(join(dataDir, 'mcp.json'), { local: stdio, web: http,
      events: { type: 'sse', url: 'https://example.test/events' },
      literal: { ...stdio, env: { KEY: '${MCP_TOKEN}' } } });
    expect(read()).toEqual([
      { name: 'local', command: 'node', args: ['server.mjs'], env: [{ name: 'KEY', value: 'account-literal' }] },
      { name: 'web', type: 'http', url: http.url, headers: [{ name: 'Authorization', value: 'Bearer synthetic' }] },
      { name: 'events', type: 'sse', url: 'https://example.test/events', headers: [] },
      { name: 'literal', command: 'node', args: ['server.mjs'], env: [{ name: 'KEY', value: '${MCP_TOKEN}' }] },
    ]);
  });

  it('replaces a same-name account definition completely and expands project variables from this bot', () => {
    write(join(dataDir, 'mcp.json'), { shared: http, other: stdio });
    write(join(cwd, '.mcp.json'), { shared: { command: '${MISSING:-node}', args: ['${MCP_TOKEN}'],
      env: { TOKEN: '${MCP_TOKEN}', EMPTY: '${EMPTY:-fallback}' } } });
    expect(read({ env: { MCP_TOKEN: 'this-bot', EMPTY: '' } })).toEqual([
      { name: 'shared', command: 'node', args: ['this-bot'], env: [{ name: 'TOKEN', value: 'this-bot' }, { name: 'EMPTY', value: '' }] },
      { name: 'other', command: 'node', args: ['server.mjs'], env: [{ name: 'KEY', value: 'account-literal' }] },
    ]);
  });

  it.each([{ enabled: false }, { configured: false }, { builtin: true }])('does not enable excluded account servers: %j', excluded => {
    write(join(dataDir, 'mcp.json'), { excluded: { ...http, ...excluded }, good: stdio });
    expect(read().map(server => server.name)).toEqual(['good']);
  });

  it('uses native project flag semantics rather than account bookkeeping flags', () => {
    write(join(cwd, '.mcp.json'), { project: { ...stdio, configured: false, builtin: true } });
    expect(read().map(server => server.name)).toEqual(['project']);
  });

  it.each([
    ['auth', { type: 'oauth2', accessToken: 'NEVER_LOG_THIS_SECRET' }],
    ['timeout', 5000],
    ['metadata', { policy: 'NEVER_LOG_THIS_SECRET' }],
    ['tools', [{ name: 'proof', inputSchema: { type: 'object' } }]],
    ['description', 'NEVER_LOG_THIS_SECRET'],
  ])('leaves native %s options intact rather than shadowing them with an incomplete ACP entry', (key, value) => {
    write(join(dataDir, 'mcp.json'), { native: { ...http, [key as string]: value }, plain: stdio });
    expect(read().map(server => server.name)).toEqual(['plain']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('native_only_options'));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('NEVER_LOG_THIS_SECRET');
  });

  it('leaves project header redirect protection to mcode without reviving a same-name account entry', () => {
    write(join(dataDir, 'mcp.json'), { shared: stdio });
    write(join(cwd, '.mcp.json'), { shared: http, public: { type: 'http', url: http.url } });
    expect(read()).toEqual([{ name: 'public', type: 'http', url: http.url, headers: [] }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('native_only_project_headers'));
  });

  it.each([{ enabled: false }, null, { type: 'unsupported', url: 'https://example.test' }])('never resurrects the account entry under a project override: %j', override => {
    write(join(dataDir, 'mcp.json'), { shared: http, other: stdio });
    write(join(cwd, '.mcp.json'), { shared: override });
    expect(read().map(server => server.name)).toEqual(['other']);
  });

  it('filters unadvertised remote transports without losing stdio servers', () => {
    write(join(dataDir, 'mcp.json'), { web: http, events: { type: 'sse', url: http.url }, local: stdio });
    expect(read({ capabilities: undefined }).map(server => server.name)).toEqual(['local']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('reports malformed JSON without echoing its contents and retains the other source', () => {
    writeFileSync(join(dataDir, 'mcp.json'), '{"Authorization":"NEVER_LOG_THIS_SECRET"');
    write(join(cwd, '.mcp.json'), { good: stdio });
    expect(read().map(server => server.name)).toEqual(['good']);
    const warnings = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warnings).toContain('account'); expect(warnings).toContain('invalid_json');
    expect(warnings).not.toContain('NEVER_LOG_THIS_SECRET');
  });

  it('isolates invalid entries and does not leak URL, argument or environment values', () => {
    write(join(cwd, '.mcp.json'), {
      args: { command: 'node', args: [9, 'NEVER_LOG_THIS_SECRET'] },
      map: { ...http, headers: { Authorization: { token: 'NEVER_LOG_THIS_SECRET' } } },
      url: { type: 'http', url: 'https://user:NEVER_LOG_THIS_SECRET@example.test' },
      missing: { command: '${UNSET_PRIVATE_ENV}' },
      reserved: null,
      good: stdio,
    });
    expect(read().map(server => server.name)).toEqual(['good']);
    expect(logger.warn).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(/NEVER_LOG_THIS_SECRET|UNSET_PRIVATE_ENV|https:\/\//);
  });

  it('rejects malformed roots and oversized files, without discarding valid project configuration', () => {
    write(join(cwd, '.mcp.json'), { good: stdio });
    for (const content of ['[]', '{"mcpServers":[]}', ' '.repeat(1024 * 1024 + 1)]) {
      writeFileSync(join(dataDir, 'mcp.json'), content);
      expect(read().map(server => server.name)).toEqual(['good']);
    }
  });

  it.skipIf(process.platform === 'win32')('does not follow a project config outside its workspace', () => {
    const outside = join(root, 'outside.json'); write(outside, { escaped: stdio });
    symlinkSync(outside, join(cwd, '.mcp.json'));
    write(join(dataDir, 'mcp.json'), { account: stdio });
    expect(read().map(server => server.name)).toEqual(['account']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('path_outside_workspace'));
  });

  it.skipIf(process.platform === 'win32')('accepts workspace-local config symlinks', () => {
    write(join(cwd, 'servers.json'), { project: stdio });
    symlinkSync(join(cwd, 'servers.json'), join(cwd, '.mcp.json'));
    expect(read().map(server => server.name)).toEqual(['project']);
  });

  it('reads changed configuration on the next attachment without caching or crossing accounts', () => {
    write(join(dataDir, 'mcp.json'), { before: stdio });
    expect(read().map(server => server.name)).toEqual(['before']);
    write(join(dataDir, 'mcp.json'), { after: stdio });
    expect(read().map(server => server.name)).toEqual(['after']);
    const other = join(root, 'other-account'); mkdirSync(other);
    write(join(other, 'mcp.json'), { other: stdio });
    expect(read({ dataDir: other }).map(server => server.name)).toEqual(['other']);
    write(join(cwd, '.mcp.json'), { project: stdio });
    const otherCwd = join(root, 'other-project'); mkdirSync(otherCwd);
    write(join(otherCwd, '.mcp.json'), { otherProject: stdio });
    expect(read({ cwd: otherCwd }).map(server => server.name)).toEqual(['after', 'otherProject']);
  });
});
