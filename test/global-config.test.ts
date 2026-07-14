import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  globalVcMeetingAgentListenerBotAppId,
  globalConfigPath,
  isGlobalVcMeetingAgentEnabled,
  mergeDashboardConfig,
  mergeGlobalConfig,
  readGlobalConfig,
} from '../src/global-config.js';

describe('global dashboard config', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-global-config-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('reads only boolean dashboard settings', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      dashboard: {
        publicReadOnly: 'yes',
        openTerminalInFeishu: true,
        enableLocalCliOpen: true,
        localCliOpenMode: 'resume',
      },
    }));

    expect(readGlobalConfig().dashboard).toEqual({
      openTerminalInFeishu: true,
      enableLocalCliOpen: true,
      localCliOpenMode: 'resume',
    });
  });

  it('drops invalid dashboard.localCliOpenMode values', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      dashboard: {
        enableLocalCliOpen: true,
        localCliOpenMode: 'tmux',
      },
    }));

    expect(readGlobalConfig().dashboard).toEqual({ enableLocalCliOpen: true });
  });

  it('reads dashboard.chatBotDiscovery as a boolean (off)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      dashboard: { chatBotDiscovery: false },
    }));

    expect(readGlobalConfig().dashboard).toEqual({ chatBotDiscovery: false });
  });

  it('reads pinned plugin dashboards as a sanitized machine-wide preference', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      dashboard: { pinnedPlugins: ['demo-addon', 'bad/id', 'demo-addon', 'agent-chrome'] },
    }));

    expect(readGlobalConfig().dashboard?.pinnedPlugins).toEqual(['demo-addon', 'agent-chrome']);
    mergeDashboardConfig({ pinnedPlugins: ['agent-chrome'] });
    expect(readGlobalConfig().dashboard?.pinnedPlugins).toEqual(['agent-chrome']);
  });

  it('reads dashboard.herdrTraexPlugin opt-in with trimmed source/ref', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      dashboard: { herdrTraexPlugin: { enabled: true, source: ' owner/repo/subdir ', ref: ' reviewed-sha ' } },
    }));

    expect(readGlobalConfig().dashboard?.herdrTraexPlugin).toEqual({
      enabled: true,
      source: 'owner/repo/subdir',
      ref: 'reviewed-sha',
    });
  });

  it('reads the review-only legacy spec as source/ref for compatibility', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      dashboard: { herdrTraexPlugin: { enabled: true, spec: ' owner/repo#tag ' } },
    }));

    expect(readGlobalConfig().dashboard?.herdrTraexPlugin).toEqual({
      enabled: true,
      source: 'owner/repo',
      ref: 'tag',
    });
  });

  it('reads repoPickerMode as a top-level global enum', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      repoPickerMode: 'repos',
      dashboard: {
        openTerminalInFeishu: true,
      },
    }));

    expect(readGlobalConfig().repoPickerMode).toBe('repos');
  });

  it('drops invalid repoPickerMode values', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ repoPickerMode: 'grouped' }));
    expect(readGlobalConfig().repoPickerMode).toBeUndefined();
  });

  it('reads global skill project trust policy and delivery default', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      skills: {
        trustProjectSkills: 'trusted',
        delivery: 'prompt',
      },
    }));

    expect(readGlobalConfig().skills).toEqual({
      trustProjectSkills: 'trusted',
      delivery: 'prompt',
    });
  });

  it('reads vcMeetingAgent.enabled as a top-level global kill-switch', () => {
    expect(isGlobalVcMeetingAgentEnabled()).toBe(true);
    mergeGlobalConfig({ vcMeetingAgent: { enabled: false } });
    expect(readGlobalConfig().vcMeetingAgent).toEqual({ enabled: false });
    expect(isGlobalVcMeetingAgentEnabled()).toBe(false);
    mergeGlobalConfig({ vcMeetingAgent: { enabled: true } });
    expect(isGlobalVcMeetingAgentEnabled()).toBe(true);
  });

  it('reads vcMeetingAgent.listenerBotAppId as the global VC listener app', () => {
    mergeGlobalConfig({ vcMeetingAgent: { enabled: true, listenerBotAppId: ' cli_listener ' } });
    expect(readGlobalConfig().vcMeetingAgent).toEqual({ enabled: true, listenerBotAppId: 'cli_listener' });
    expect(globalVcMeetingAgentListenerBotAppId()).toBe('cli_listener');
  });

  it('reads global plugin defaults as a sanitized id list', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      plugins: ['agent-chrome', 'bad/id', 'agent-chrome', 'gitlab'],
    }));

    expect(readGlobalConfig().plugins).toEqual(['agent-chrome', 'gitlab']);
  });

  it('readGlobalConfig sees fresh values immediately after a merge (cache invalidation)', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { publicReadOnly: true } }));
    expect(readGlobalConfig().dashboard?.publicReadOnly).toBe(true); // primes the TTL cache
    mergeDashboardConfig({ publicReadOnly: false });
    // Same-process read-after-write must not serve the cached pre-merge value.
    expect(readGlobalConfig().dashboard?.publicReadOnly).toBe(false);
  });

  it('httpProxy survives a merge→read roundtrip (HD2D office download proxy)', () => {
    // Regression: readGlobalConfig() used to drop httpProxy, so the office-tab
    // proxy persisted by mergeGlobalConfig was never read back by the downloader.
    expect(readGlobalConfig().httpProxy).toBeUndefined();
    mergeGlobalConfig({ httpProxy: 'http://127.0.0.1:7890' });
    expect(readGlobalConfig().httpProxy).toBe('http://127.0.0.1:7890');
    // Clearing (null) removes it again.
    mergeGlobalConfig({ httpProxy: null });
    expect(readGlobalConfig().httpProxy).toBeUndefined();
  });

  it('ignores a non-string / blank httpProxy', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ httpProxy: 123 }));
    expect(readGlobalConfig().httpProxy).toBeUndefined();
    writeFileSync(globalConfigPath(), JSON.stringify({ httpProxy: '   ' }));
    expect(readGlobalConfig().httpProxy).toBeUndefined();
  });

  it('merge writes atomically and leaves no tmp file behind', () => {
    mergeDashboardConfig({ openTerminalInFeishu: true });
    const dir = dirname(globalConfigPath());
    const leftovers = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(readFileSync(globalConfigPath(), 'utf8')).dashboard.openTerminalInFeishu).toBe(true);
  });

  it('atomic write keeps the file at 0600 (no perm widening via tmp+rename)', () => {
    // The file can carry voice credentials. A pre-existing 0600 config must not
    // come out of the rename with the tmp file's umask-default (0644) mode.
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { publicReadOnly: true } }), { mode: 0o600 });
    chmodSync(globalConfigPath(), 0o600);
    mergeDashboardConfig({ openTerminalInFeishu: true });
    expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o600);
    // Fresh file (no pre-existing config) is also created at 0600.
    rmSync(globalConfigPath());
    mergeDashboardConfig({ publicReadOnly: false });
    expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('merges dashboard settings while preserving unknown nested keys', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      lang: 'zh',
      dashboard: {
        publicReadOnly: true,
        futureSetting: 'keep-me',
      },
    }));

    const typed = mergeDashboardConfig({ publicReadOnly: false, openTerminalInFeishu: true, localCliOpenMode: 'attach' });
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf8'));

    expect(typed).toEqual({ publicReadOnly: false, openTerminalInFeishu: true, localCliOpenMode: 'attach' });
    expect(raw.lang).toBe('zh');
    expect(raw.dashboard.futureSetting).toBe('keep-me');
    expect(raw.dashboard.publicReadOnly).toBe(false);
    expect(raw.dashboard.openTerminalInFeishu).toBe(true);
    expect(raw.dashboard.localCliOpenMode).toBe('attach');
  });
});
