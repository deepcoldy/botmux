import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTrustedDataMcpProxyDiagnostics } from '../src/mcp/trusted-stdio-proxy.js';
import {
  clearTrustedTurnFile,
  inspectTrustedTurnFromEnv,
  readTrustedTurnFile,
  resolveBotmuxDataDirForTrustedTurn,
  trustedTurnFilePath,
  trustedTurnFilePathFromEnv,
  writeTrustedTurnFile,
} from '../src/utils/trusted-turn-store.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-trusted-turn-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('trusted-turn-store', () => {
  it('persists and reads only the matching unexpired session identity', () => {
    const file = trustedTurnFilePath(tempDir(), 'sess-1');

    writeTrustedTurnFile(file, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      trustedCaller: {
        requestUserOpenId: 'ou_user',
        requestUserUnionId: 'on_user',
        requestLarkAppId: 'cli_app',
      },
    }, 1000, 5000);

    expect(readTrustedTurnFile(file, 'sess-1', 2000)).toEqual({
      requestUserOpenId: 'ou_user',
      requestUserUnionId: 'on_user',
      requestLarkAppId: 'cli_app',
    });
    expect(readTrustedTurnFile(file, 'other-session', 2000)).toBeUndefined();
    expect(readTrustedTurnFile(file, 'sess-1', 7000)).toBeUndefined();
  });

  it('clears the turn file so later MCP calls fail closed', () => {
    const file = trustedTurnFilePath(tempDir(), 'sess-1');
    writeTrustedTurnFile(file, {
      sessionId: 'sess-1',
      trustedCaller: { requestUserUnionId: 'on_user' },
    });

    clearTrustedTurnFile(file);

    expect(readTrustedTurnFile(file, 'sess-1')).toBeUndefined();
  });

  it('derives the trusted turn file from session id when the explicit env path is absent', () => {
    const dataDir = tempDir();

    expect(trustedTurnFilePathFromEnv({
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess-1',
    })).toBe(join(dataDir, 'trusted-turns', 'sess-1.json'));
  });

  it('prefers the explicit trusted turn file env path', () => {
    expect(trustedTurnFilePathFromEnv({
      BOTMUX_TRUSTED_TURN_FILE: '/tmp/turn.json',
      SESSION_DATA_DIR: '/tmp/ignored',
      BOTMUX_SESSION_ID: 'sess-1',
    })).toBe('/tmp/turn.json');
  });

  it('resolves SESSION_DATA_DIR before other BotMux data dir fallbacks', () => {
    const dataDir = tempDir();

    expect(resolveBotmuxDataDirForTrustedTurn({ SESSION_DATA_DIR: dataDir })).toBe(dataDir);
  });

  it('inspects trusted turn state without exposing identity values', () => {
    const dataDir = tempDir();
    const file = trustedTurnFilePath(dataDir, 'sess-1');
    writeTrustedTurnFile(file, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      trustedCaller: {
        requestUserOpenId: 'ou_user',
        requestUserUnionId: 'on_user',
        requestLarkAppId: 'cli_app',
      },
    }, 1000, 5000);

    expect(inspectTrustedTurnFromEnv({
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess-1',
    }, 2000)).toEqual({
      filePath: file,
      source: 'session_data_dir',
      exists: true,
      valid: true,
      expectedSessionId: 'sess-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      updatedAtMs: 1000,
      expiresAtMs: 6000,
      hasOpenId: true,
      hasUnionId: true,
      hasLarkAppId: true,
    });
  });

  it('reports missing trusted turn file as blocked diagnostics', () => {
    const dataDir = tempDir();

    expect(inspectTrustedTurnFromEnv({
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess-1',
    }, 2000)).toMatchObject({
      filePath: join(dataDir, 'trusted-turns', 'sess-1.json'),
      source: 'session_data_dir',
      exists: false,
      valid: false,
      reason: 'file_missing',
      hasUnionId: false,
    });
  });

  it('exposes redacted Data MCP proxy diagnostics', () => {
    const dataDir = tempDir();
    const file = trustedTurnFilePath(dataDir, 'sess-1');
    writeTrustedTurnFile(file, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      trustedCaller: {
        requestUserOpenId: 'ou_user',
        requestUserUnionId: 'on_user',
        requestLarkAppId: 'cli_app',
      },
    }, Date.now(), 5000);

    const diagnostics = getTrustedDataMcpProxyDiagnostics({
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess-1',
    });

    expect(diagnostics).toMatchObject({
      status: 'ok',
      target: 'data-agent',
      injectTools: ['validate_sql_for_user', 'run_query_for_user'],
      agentVisibleArguments: ['sql', 'datasource'],
      trustedTurn: {
        filePath: file,
        valid: true,
        hasUnionId: true,
      },
      stdio: {
        clientReadProtocols: ['jsonl', 'content-length'],
        upstreamReadProtocols: ['jsonl', 'content-length'],
        upstreamWriteProtocol: 'jsonl',
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('on_user');
    expect(JSON.stringify(diagnostics)).not.toContain('ou_user');
  });
});
