/**
 * Detection of MCP servers that carry their own credentials.
 *
 * These servers are the honest limit of trigger-user auth: they talk to Feishu
 * through their own app id and secret, never exec `lark-cli`, and so no wrapper
 * sees them. The point of detecting them is to SAY SO. Claiming a boundary we do
 * not have would be more dangerous than not having it.
 *
 * The tests therefore pin two things: that a self-credentialed server is found
 * (including in the real config shape on this machine), and that an ordinary
 * server is not — a detector that cries wolf trains people to ignore it.
 *
 * Run:  npx vitest run --project unit test/credential-bearing-mcp.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findCredentialBearingMcpInJson,
  findCredentialBearingMcpInToml,
  scanCredentialBearingMcpServers,
  credentialBearingMcpAdvisory,
} from '../src/services/credential-bearing-mcp.js';

describe('findCredentialBearingMcpInToml', () => {
  // The exact shape found in a real ~/.codex/config.toml: a Feishu MCP server
  // with its own app credentials, plus `.tools.*` sub-tables after the env block.
  const realShape = `
[mcp_servers.feishu-lark]
command = "/Users/u/.local/bin/feishu-lark"
args = ["serve"]

[mcp_servers.feishu-lark.env]
FEISHU_APP_ID = "cli_abc"
FEISHU_APP_SECRET = "s3cret"

[mcp_servers.feishu-lark.tools.feishu_fetch_doc]
approval_mode = "approve"

[mcp_servers.bytedcli]
command = "/Users/u/.local/bin/bytedcli"
args = ["mcp"]

[mcp_servers.bytedcli.env]
NPM_CONFIG_REGISTRY = "http://bnpm.example.org"

[mcp_servers.botmux]
command = "/Users/u/.botmux/bin/botmux"
`;

  it('finds the server that authenticates on its own', () => {
    const found = findCredentialBearingMcpInToml(realShape, 'config.toml');
    expect(found).toEqual([
      { name: 'feishu-lark', source: 'config.toml', credentialEnvKeys: ['FEISHU_APP_SECRET'] },
    ]);
  });

  // bytedcli's MCP server runs the bytedcli binary — the wrapper DOES cover it,
  // and its env holds only a registry URL. Flagging it would be a false alarm.
  it('leaves a server with no credentials alone', () => {
    const found = findCredentialBearingMcpInToml(realShape, 'x');
    expect(found.map(s => s.name)).not.toContain('bytedcli');
    expect(found.map(s => s.name)).not.toContain('botmux');
  });

  // An app id is not a credential. Flagging it produces noise that trains people
  // to ignore the warning.
  it('does not treat an app id as a credential', () => {
    const found = findCredentialBearingMcpInToml(
      '[mcp_servers.x.env]\nFEISHU_APP_ID = "cli_abc"\n',
      'x',
    );
    expect(found).toEqual([]);
  });

  // Keys after a non-env sub-table belong to that table, not to env — otherwise
  // an innocuous `approval_mode` line could be misattributed.
  it('stops collecting once the env table ends', () => {
    const found = findCredentialBearingMcpInToml(
      '[mcp_servers.x.env]\nSAFE = "1"\n\n[mcp_servers.x.tools.t]\nAPI_KEY = "leaked-shape"\n',
      'x',
    );
    expect(found).toEqual([]);
  });

  it('ignores commented-out credentials', () => {
    const found = findCredentialBearingMcpInToml(
      '[mcp_servers.x.env]\n# FEISHU_APP_SECRET = "old"\n',
      'x',
    );
    expect(found).toEqual([]);
  });
});

describe('findCredentialBearingMcpInJson', () => {
  it('finds a self-credentialed server in the Claude config shape', () => {
    const raw = JSON.stringify({
      mcpServers: {
        'feishu-thing': { command: 'x', env: { FEISHU_APP_SECRET: 's', FEISHU_APP_ID: 'a' } },
        plain: { command: 'y' },
        botmux: { command: 'botmux', env: { BOTMUX_SESSION_ID: 's' } },
      },
    });
    const found = findCredentialBearingMcpInJson(raw, '.claude.json');
    expect(found).toEqual([
      { name: 'feishu-thing', source: '.claude.json', credentialEnvKeys: ['FEISHU_APP_SECRET'] },
    ]);
  });

  // Best-effort by design: this runs to produce an advisory, and an advisory that
  // can break a session start is worse than a missing advisory.
  it('returns nothing for malformed config instead of throwing', () => {
    expect(findCredentialBearingMcpInJson('{not json', 'x')).toEqual([]);
    expect(findCredentialBearingMcpInJson('{}', 'x')).toEqual([]);
    expect(findCredentialBearingMcpInJson('[]', 'x')).toEqual([]);
  });
});

describe('scanCredentialBearingMcpServers', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'botmux-mcp-scan-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('reads both config flavors and reports where each came from', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { a: { env: { SOME_ACCESS_TOKEN: 't' } } },
    }));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'),
      '[mcp_servers.b.env]\nOTHER_APP_SECRET = "s"\n');

    const found = scanCredentialBearingMcpServers(home, [
      { path: join(home, '.claude.json'), kind: 'json' },
      { path: join(home, '.codex', 'config.toml'), kind: 'toml' },
    ]);
    expect(found.map(s => s.name).sort()).toEqual(['a', 'b']);
    expect(found.find(s => s.name === 'a')?.source).toContain('.claude.json');
    expect(found.find(s => s.name === 'b')?.source).toContain('config.toml');
  });

  it('is quiet when nothing is configured', () => {
    expect(scanCredentialBearingMcpServers(home, [
      { path: join(home, 'missing.json'), kind: 'json' },
    ])).toEqual([]);
  });
});

describe('credentialBearingMcpAdvisory', () => {
  it('says nothing when there is nothing to say', () => {
    expect(credentialBearingMcpAdvisory([])).toBeNull();
  });

  // The message has to be actionable — which server, declared where — and must
  // never contain a credential VALUE, only which keys were seen.
  it('names the server and its config without leaking the secret', () => {
    const text = credentialBearingMcpAdvisory([
      { name: 'feishu-lark', source: '/Users/u/.codex/config.toml', credentialEnvKeys: ['FEISHU_APP_SECRET'] },
    ])!;
    expect(text).toContain('feishu-lark');
    expect(text).toContain('config.toml');
    expect(text).toContain('不受');
    expect(text).not.toContain('s3cret');
  });
});
