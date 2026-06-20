import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { prepareClaudeSkillPlugin } from '../src/core/skills/claude-plugin-delivery.js';
import { prepareSkillDelivery } from '../src/core/skills/delivery.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('Claude scoped skill delivery', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-skill-plugin-'));
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-data-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('materializes selected skills into a Claude plugin root', () => {
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'claude-code',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prepared = prepareClaudeSkillPlugin(manifest);

    expect(readFileSync(join(prepared.pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8')).toContain('"name": "botmux-session-skills"');
    expect(readFileSync(join(prepared.pluginDir, 'skills', 'deploy', 'SKILL.md'), 'utf-8')).toContain('# Deploy');
  });

  it('Claude adapter appends the session skill plugin dir without replacing botmux plugin dir', () => {
    const adapter = createCliAdapterSync('claude-code');
    const args = adapter.buildArgs({ sessionId: 's1', resume: false, skillPluginDir: '/tmp/session-plugin' });
    const pluginDirs = args.flatMap((arg, index) => arg === '--plugin-dir' ? [args[index + 1]] : []);

    expect(pluginDirs).toContain('/tmp/session-plugin');
    expect(pluginDirs.length).toBeGreaterThan(1);
  });

  it('fails native delivery explicitly when the CLI has no scoped native support', () => {
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prepared = prepareSkillDelivery(createCliAdapterSync('codex'), manifest, 'native');

    expect(prepared.fatal).toBe(true);
    expect(prepared.diagnostics).toContain('native_skill_delivery_not_supported');
  });
});
