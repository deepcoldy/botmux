import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { frozenCommandSkillHintForMessage } from '../src/core/frozen-command-guidance.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('frozen-command generic ask guard', () => {
  it('does not inject the lifecycle hint for an ordinary filesystem operation', () => {
    expect(frozenCommandSkillHintForMessage('删除 /tmp 目录下的缓存文件')).toBeUndefined();
    expect(frozenCommandSkillHintForMessage('删除固化命令 /旧命令')).toContain('botmux-freeze');
  });

  it('rejects lifecycle confirmation before contacting the daemon', () => {
    const result = spawnSyncTsScript(
      join(repoRoot, 'src', 'cli.ts'),
      [
        'ask',
        'buttons',
        '--options',
        'confirm=确认安装,cancel=取消',
        '确认安装固化命令 /近30天注册且激活商户数 吗？',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: 'sess-freeze-guard',
          BOTMUX_CHAT_ID: 'oc_guard',
          BOTMUX_LARK_APP_ID: 'cli_guard',
          BOTMUX_ROOT_MESSAGE_ID: 'om_guard',
          BOTMUX_WORKFLOW: '',
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('必须使用宿主专用确认卡');
    expect(result.stderr).toContain('botmux freeze apply');
  });

  it('uses the session working directory to distinguish a frozen command from ordinary slash tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-freeze-ask-guard-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const workingDir = join(root, 'repo');
    mkdirSync(join(workingDir, '.botmux', 'commands'), { recursive: true });
    writeFileSync(join(workingDir, '.botmux', 'commands', '泰国上账.yaml'), `
schemaVersion: 2
name: 泰国上账
description: 查询泰国上账
executor: builtin.data-mcp.readonly
timezone: Asia/Bangkok
params: []
input:
  sql: SELECT 1
output:
  maxChars: 2000
onError: fail
`);
    seedPersistedSessionRows(dataDir, 'cli_guard', {
      'sess-freeze-guard-known': {
        sessionId: 'sess-freeze-guard-known',
        chatId: 'oc_guard',
        rootMessageId: 'om_guard',
        title: 'guard fixture',
        status: 'active',
        createdAt: '2026-09-22T00:00:00.000Z',
        workingDir,
        larkAppId: 'cli_guard',
      },
    });
    const env = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess-freeze-guard-known',
      BOTMUX_CHAT_ID: 'oc_guard',
      BOTMUX_LARK_APP_ID: 'cli_guard',
      BOTMUX_ROOT_MESSAGE_ID: 'om_guard',
      BOTMUX_DAEMON_IPC_PORT: '1',
      BOTMUX_WORKFLOW: '',
    };
    const args = (prompt: string) => [
      'ask', 'buttons', '--options', 'yes=确认,no=取消', prompt,
    ];

    const frozen = spawnSyncTsScript(
      join(repoRoot, 'src', 'cli.ts'),
      args('要把 /泰国上账 废弃吗？'),
      { cwd: repoRoot, encoding: 'utf8', env },
    );
    expect(frozen.status).toBe(2);
    expect(frozen.stderr).toContain('必须使用宿主专用确认卡');

    const schedule = spawnSyncTsScript(
      join(repoRoot, 'src', 'cli.ts'),
      args('要不要新增 /schedule 定时任务？'),
      { cwd: repoRoot, encoding: 'utf8', env },
    );
    expect(schedule.status).not.toBe(2);
    expect(schedule.stderr).not.toContain('必须使用宿主专用确认卡');
  });
});
