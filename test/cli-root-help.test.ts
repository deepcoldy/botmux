import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('botmux root help workflow surface', () => {
  it('advertises v3 Saved/ad-hoc commands and isolates v2 under the migration namespace', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-root-help-'));
    try {
      const env = { ...process.env, HOME: home };
      delete env.BOTMUX_WORKFLOW;
      const stdout = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          '--help',
        ],
        { cwd: process.cwd(), env, encoding: 'utf-8' },
      );

      expect(stdout).toContain('workflow save [last|runId] [名称]');
      expect(stdout).toContain('发布当前 Bot 全局版本 / 确认 unsafe lint 请由用户在飞书显式发送');
      expect(stdout).toContain('workflow run <名称|workflowId> [--param key=value ...]');
      expect(stdout).toContain('workflow new|spec-finalize|approve-spec|revise-spec|architect|revise-dag');
      expect(stdout).toContain('workflow approve-dag|start');
      expect(stdout).toContain('template migrate-v3 [id|path ...]');
      expect(stdout).toContain('v2 定义迁移：默认 dry-run');
      expect(stdout).toContain('template archive-runs [--commit|--verify <archive>|--retire <archive> --ack-daemon-stopped]');
      expect(stdout).toContain('v2 历史 run 私有静态归档');
      expect(stdout).toContain('原子迁入 quarantine');
      expect(stdout).not.toContain('template <run|resume|cancel|ls|tail|validate|show>');
      expect(stdout).not.toContain('v2 执行兼容面');
      expect(stdout).not.toContain('workflow <run|resume|cancel|ls|tail|validate|show>');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
