import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('frozen-command generic ask guard', () => {
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
});
