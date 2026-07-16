import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function dashboardSource(file: string): string {
  return readFileSync(new URL(`../src/dashboard/web/${file}`, import.meta.url), 'utf8');
}

function labelsContainingCustomDropdown(source: string): string[] {
  return [...source.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)]
    .map(match => match[0])
    .filter(label => /<Dropdown(?:Menu|Field)\b/.test(label));
}

describe('dashboard master feature integration', () => {
  it('keeps the default-off Codex App clean-history switch wired into Bot defaults', () => {
    const page = dashboardSource('bot-defaults-page.tsx');
    const types = dashboardSource('bot-defaults.ts');
    const messages = dashboardSource('i18n.ts');

    expect(types).toContain('codexAppCleanInput?: boolean');
    expect(page).toContain('<CodexAppDisplaySection bot={bot} putCardPref={putCardPref} />');
    expect(page).toContain('dataAction="toggle-codex-app-clean-input"');
    expect(messages).toContain('默认关闭，保持原有兼容行为');
    expect(messages).toContain('still reach the model, but move to hidden context');
  });

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

  it('submits TraeX source/ref through one explicit path and reconciles lost PUT responses', () => {
    const page = dashboardSource('settings-page.tsx');
    const editor = page.slice(page.indexOf('function TraexPluginEditor'));

    expect(editor).toContain("void props.onSave({ source: normalizedSource, ref: normalizedRef })");
    expect(editor).not.toContain('onBlur=');
    expect(editor).toContain('setSource(props.value.recommendedSource)');
    expect(editor).toContain('setRef(props.value.recommendedRef)');
    expect(page).toContain("await fetch('/api/settings')");
    expect(page).toContain("tr('settings.saveReconciled')");
    expect(page).not.toContain('herdrTraexPlugin.spec');
  });

  it('does not recenter the v3 DAG for status-only poll updates', () => {
    const page = dashboardSource('v3-components.tsx');

    expect(page).toContain('const topologyKey = layout');
    expect(page).toContain('}, [topologyKey]);');
    expect(page).not.toContain('}, [layout]);');
  });

  it('keeps bot save statuses semantic and shared dropdowns visibly disabled', () => {
    const css = dashboardSource('style.css');

    // Nested status spans must keep their success/warning color instead of inheriting
    // the muted field-label rule used by direct label children.
    expect(css).toContain('.bd-body .bd-row :where(label, .bd-field) > span');
    expect(css).not.toContain('.bd-body .bd-row span {');

    // DropdownMenu is shared by Bots, Roles, Settings, and Sessions. Its disabled
    // appearance belongs to the shared selector rather than a page-specific override.
    expect(css).toContain('.sect-sort-menu.is-disabled > summary,');
    expect(css).toMatch(/\.sect-sort-menu\.is-disabled > summary:hover \{[\s\S]*?cursor: not-allowed;[\s\S]*?opacity: 0\.62;/);
    expect(css).not.toContain('.kanban-team-menu.is-disabled > summary');
  });

  it('does not nest custom dropdowns in labels that activate their first option', () => {
    // A wrapping label implicitly associates itself with the first labelable
    // descendant. DropdownMenu options are buttons, so clicking the field title
    // would otherwise activate option 1 and silently change the selection.
    const webDir = new URL('../src/dashboard/web/', import.meta.url);
    const offenders = readdirSync(webDir)
      .filter(file => file.endsWith('.tsx'))
      .flatMap(file => labelsContainingCustomDropdown(dashboardSource(file)).map(() => file));
    const botDefaults = dashboardSource('bot-defaults-page.tsx');

    expect(offenders).toEqual([]);
    expect(botDefaults).toContain('className="bd-field"');
  });
});
