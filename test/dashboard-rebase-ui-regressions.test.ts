import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function dashboardSource(file: string): string {
  return readFileSync(new URL(`../src/dashboard/web/${file}`, import.meta.url), 'utf8');
}

describe('dashboard master feature integration', () => {
  it('keeps substitute mode configurable from the React bot defaults page', () => {
    const page = dashboardSource('bot-defaults-page.tsx');
    const types = dashboardSource('bot-defaults.ts');

    expect(types).toContain('substituteMode?: BotSubstituteMode | null');
    expect(page).toContain('<SubstituteModeSection bot={bot} patchBot={patchBot} />');
    expect(page).toContain('/substitute-mode`');
    expect(page).toContain('dataAction="toggle-substitute-mode"');
    expect(page).toContain('data-input="substituteTargets"');
    expect(page).toContain('data-action="add-substitute-target"');
    expect(page).toContain('data-action="remove-substitute-target"');
    expect(page).toContain('substituteTargetIdPlaceholder');
    expect(page).not.toContain('substituteTargetsPlaceholder');
    expect(page).toContain('data-action="save-substitute-mode"');
    expect(page).toContain('data-action="off-substitute-mode"');
  });

  it('keeps lark-cli status and Feishu login QR handling in global settings', () => {
    const page = dashboardSource('settings-page.tsx');
    const css = dashboardSource('style.css');

    expect(page).toContain('larkCliVersion?: string | null');
    expect(page).toContain('larkCliMeetsRequirement?: boolean');
    expect(page).toContain('body?.feishuLoginQr');
    expect(page).toContain('<LarkCliStatus settings={settings.vcMeetingAgent} />');
    expect(page).toContain('className="settings-feishu-login"');
    expect(css).toContain('.settings-lark-cli-status');
    expect(css).toContain('.settings-feishu-login');
  });

  it('does not recenter the v3 DAG for status-only poll updates', () => {
    const page = dashboardSource('v3-components.tsx');

    expect(page).toContain('const topologyKey = layout');
    expect(page).toContain('}, [topologyKey]);');
    expect(page).not.toContain('}, [layout]);');
  });
});
