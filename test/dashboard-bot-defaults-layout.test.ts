import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/dashboard/web/i18n.ts', import.meta.url), 'utf8');

describe('bot defaults focused layout', () => {
  it('keeps every task panel mounted while hiding inactive categories', () => {
    for (const tab of ['common', 'sessions', 'security', 'cards', 'advanced']) {
      expect(page).toContain(`id="bd-panel-${tab}"`);
      expect(page).toContain(`hidden={props.activeTab !== '${tab}'}`);
    }

    expect(page).toContain('<BotAgentSection');
    expect(page).toContain('<SessionModeSection');
    expect(page).toContain('<SandboxSection');
    expect(page).toContain('<CardBehaviorSection');
    expect(page).toContain('<section className="bd-tile bd-tile-wide"><CardBehaviorSection');
    expect(page).toContain('<RuntimeEnvironmentSection');
  });

  it('lays task tiles out as a two-column waterfall so short tiles do not strand a gap', () => {
    // A row-major grid locks each row to its tallest tile, leaving dead space
    // under a short tile next to a tall one. BdTabGrid measures every tile and
    // greedily drops it into the shortest column over a fine 1px row track;
    // the wide tile spans all columns. Two columns only above the container
    // threshold, else a single auto-row column (no overlap).
    expect(page).toContain('function BdTabGrid');
    expect(page).toContain('colBottom'); // shortest-column bookkeeping
    // every panel uses the masonry wrapper, none keep a raw grid div
    expect(page).not.toContain('<div className="bd-tab-grid">');
    expect((page.match(/<BdTabGrid>/g) ?? []).length).toBe(5);
    // CSS: single column + auto rows by default, 2 cols + 1px row track in the container query
    expect(css).toMatch(/\.bot-defaults-page \.bd-tab-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?grid-auto-rows:\s*auto;/);
    expect(css).toMatch(/@container \(min-width: 1024px\)\s*\{[\s\S]*?\.bot-defaults-page \.bd-tab-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?grid-auto-rows:\s*1px;/);
    expect(css).toMatch(/\.bot-defaults-page \.bd-tab-grid > \.bd-tile-wide\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  });

  it('fills the desktop main so the roster cannot be shoved under the search box', () => {
    // A sticky roster sized with 100dvh is usually a few pixels taller than
    // main's client box. Once pinned, the containing-block floor keeps
    // sliding it up and clips #bd-filters. Desktop therefore uses the same
    // fill-height shell as roles-page: main does not scroll, both columns
    // stretch, the list and the detail pane are the scrollports.
    const desktop = css.slice(css.indexOf('main:has(.bot-defaults-page)'), css.indexOf('main:has(.bot-defaults-page) .bd-detail') + 280);
    expect(desktop).toMatch(/main:has\(\.bot-defaults-page\)\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(desktop).toMatch(/\.bot-defaults-page\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\);/);
    expect(desktop).toMatch(/\.bd-layout\s*\{[\s\S]*?align-items:\s*stretch;/);
    expect(desktop).toMatch(/\.bd-roster\s*\{[\s\S]*?position:\s*static;[\s\S]*?height:\s*100%;/);
    expect(desktop).toMatch(/\.bd-detail\s*\{[\s\S]*?overflow-y:\s*auto;/);

    const rosterStart = css.indexOf('.bot-defaults-page .bd-roster {');
    const roster = css.slice(rosterStart, css.indexOf('.bot-defaults-page #bd-filters', rosterStart));
    expect(roster).toMatch(/grid-template-rows:\s*auto auto minmax\(0,\s*1fr\);/);
    expect(roster).toMatch(/overflow:\s*hidden;/);
    expect(roster).not.toMatch(/max-height:\s*calc\(100dvh/);

    const listStart = css.indexOf('.bot-defaults-page .bd-roster-list {');
    const list = css.slice(listStart, css.indexOf('@media (max-width: 980px)', listStart));
    expect(list).toMatch(/min-height:\s*0;/);
    expect(list).toMatch(/overflow-y:\s*auto;/);
    expect(list).toMatch(/overscroll-behavior:\s*contain;/);
  });

  it('keeps roster rows at their natural height when the filter leaves only a few', () => {
    // The desktop shell hands the list row the whole remaining column height.
    // A grid defaults to align-content:normal (=stretch), which splits that
    // slack across the auto rows: filtering 56 bots down to 2 measured 348px
    // per row instead of 54.4px, so the selected row rendered as a tall block
    // and the last row sank to the panel floor. align-content:start makes the
    // rows keep their content height and leaves the slack as empty space.
    const listStart = css.indexOf('.bot-defaults-page .bd-roster-list {');
    const list = css.slice(listStart, css.indexOf('@media (max-width: 980px)', listStart));
    expect(list).toMatch(/align-content:\s*start;/);
  });

  it('keeps the mobile roster bounded with a real scrollport instead of clipping', () => {
    // Grid auto rows keep max-content height, so the list row must be
    // forced into the remaining space (minmax(0,1fr) + min-height:0) or
    // overflow-y:auto never produces a scrollport and long rosters clip.
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.bot-defaults-page \.bd-roster\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0,\s*1fr\);/);
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.bot-defaults-page \.bd-roster-list\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  });

  it('lets long roster names scroll on hover instead of hard-clipping', () => {
    expect(page).toMatch(/<b><OverflowText text=\{name\}[^>]*\/><\/b>/);
  });

  it('files each section under its category per 申晗 IA', () => {
    const panelStart = (id: string) => page.indexOf(`id="bd-panel-${id}"`);
    const common = page.slice(panelStart('common'), panelStart('sessions'));
    const sessions = page.slice(panelStart('sessions'), panelStart('security'));
    const cards = page.slice(panelStart('cards'), panelStart('advanced'));
    const advanced = page.slice(panelStart('advanced'));

    // 会话常驻上限(含机器过载告警) + 启动命令 + /summary 总结范围 live under 会话.
    expect(sessions).toContain('<SessionCapSection');
    expect(sessions).toContain('<StartupCommandsSection');
    expect(sessions).toContain('<SummaryTriggerSection');
    // 默认角色 moved to 常用.
    expect(common).toContain('<RoleSection');
    expect(advanced).not.toContain('<RoleSection');
    // Codex App 历史显示 moved to 高级 and is gated on the codex-app agent.
    expect(advanced).toMatch(/bot\.cliId === 'codex-app'[\s\S]*?<CodexAppDisplaySection/);
    expect(cards).not.toContain('<CodexAppDisplaySection');
    // 会话后端 stays under 高级; 启动环境(Shell+env) stays under 高级 too.
    expect(advanced).toContain('<BackendTypeSection');
    expect(advanced).toContain('<RuntimeEnvironmentSection');
    expect(advanced).toContain('<SessionOwnerReminderSection');
    // and the moved sections no longer sit in their old homes
    expect(advanced).not.toContain('<SessionCapSection');
    expect(common).not.toContain('<BackendTypeSection');
    // 启动命令 was pulled out of the 启动环境 composite (Shell + env stay there).
    const runtimeEnv = page.slice(page.indexOf('function RuntimeEnvironmentSection'), page.indexOf('function RuntimeEnvironmentSection') + 400);
    expect(runtimeEnv).not.toContain('<StartupCommandsSection');
    expect(runtimeEnv).toContain('<LaunchShellSection');
  });

  it('hides the backend picker for EVERY remote CLI, not just riff', () => {
    // reconcileRiffBackendType rewrites backendType to the CLI's own name for
    // any isRemoteBackendId(cliId), so offering pty/tmux to a remote bot renders
    // a choice the spawn layer silently overwrites. Gate on the shared set so a
    // third remote CLI cannot reintroduce the phantom control.
    expect(page).toContain("import { isRemoteCliId } from '../../core/remote-cli-ids.js';");
    expect(page).toMatch(/\{!isRemoteCliId\(bot\.cliId\) \? \(\s*<section className="bd-tile"><BackendTypeSection/);
    // No open-coded riff-only gate may guard the backend picker again.
    expect(page).not.toMatch(/bot\.cliId !== 'riff' \? \(\s*<section className="bd-tile"><BackendTypeSection/);
  });

  it('keeps the file sandbox visible for mojo while hiding it for riff', () => {
    // Not symmetric with the backend picker on purpose: riff executes only in a
    // remote sandbox, but a mojo turn can spawn LOCALLY (cloud optional), so its
    // file-sandbox settings still bite. Treating "remote" as "no local exec"
    // here would silently drop isolation.
    expect(page).toMatch(/bot\.cliId !== 'riff' \? \(\s*<section className="bd-tile"><SandboxSection/);
    expect(page).not.toMatch(/isRemoteCliId\(bot\.cliId\)[^\n]*<SandboxSection/);
  });

  it('ships localized labels for every task category', () => {
    for (const key of ['tabCommon', 'tabSessions', 'tabSecurity', 'tabCards', 'tabAdvanced']) {
      expect(i18n.match(new RegExp(`'botDefaults\\.${key}'`, 'g'))).toHaveLength(2);
    }
  });

  it('places the Feishu description editor inside the profile header main column', () => {
    const profileStart = page.indexOf('<BotProfileIdentity');
    const tabsStart = page.indexOf('<BotDefaultsTabs', profileStart);
    const profileHead = page.slice(profileStart, tabsStart);

    expect(profileHead).toContain('<BotDescriptionControl bot={bot} />');
    expect(css).toMatch(/\.bot-defaults-page \.bd-description-preview\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
    expect(css).toMatch(/\.bot-defaults-page \.bd-description-modal\s*\{[\s\S]*?max-height:\s*min\(720px,\s*calc\(100vh - 32px\)\);/);
  });

  it('offers the Codex auth policy with explicit sandbox-independent scope copy', () => {
    expect(page).toContain('data-input="codexAuthSync"');
    expect(page).toContain("<CodexAuthSection bot={bot} patchBot={patchBot} />");
    expect(page).toContain("botDefaults.sectionCodexAuth");
    expect(page).toContain('/codex-auth-sync');
    expect(i18n.match(/'botDefaults\.codexAuthSyncHelp'/g)).toHaveLength(2);
    expect(i18n).toContain('无论是否启用沙箱都使用本 bot 的 CODEX_HOME');
    expect(i18n).toContain("with or without the sandbox");
  });

  it('auto-saves duration and quota without action buttons', () => {
    expect(page).toContain('dataInput="grantDefaultDurationMs"');
    expect(page).toContain('data-input="quotaLimit"');
    expect(page).not.toContain('data-action="save-grant-defaults"');
    expect(page).not.toContain('data-action="reset-grant-defaults"');
    expect(page).toContain('onBlur={saveQuota}');
    expect(page).toContain('onChange={saveDuration}');
    expect(page).toContain('className="bd-row bd-grant-duration"');
    expect(page).toContain('className="bd-row bd-quota"');
    expect(page).not.toContain('data-action="toggle-grant-quota-oncall"');
    expect(i18n).toContain("'botDefaults.quotaPlaceholder': '留空＝内置默认：授权卡每人 {count} 条'");
    expect(i18n).toContain("'botDefaults.quotaDefault': '消息额度覆盖'");
    expect(i18n).toContain("'botDefaults.grantDefaultsCurrentBuiltIn': '当前内置默认：{duration} · 授权卡每人 {count} 条；Oncall 不限'");
    expect(i18n).toContain("'botDefaults.grantDefaultsCurrentCustom': '当前自定义：{duration} · 每人 {count} 条（授权卡与 Oncall）'");
    expect(i18n).not.toContain("'botDefaults.grantDefaultsReset'");
    expect(i18n).not.toContain('点击“恢复默认限制”');
    expect(i18n).not.toContain('产品默认 3 条');
    expect(i18n).not.toContain('product default of 3');
    expect(css).not.toContain('.bot-defaults-page .bd-grant-default-grid');
    expect(css).toMatch(/\.bot-defaults-page \.bd-grant-defaults > \.actions\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  });

  it('offers granular Session owner reminder controls in advanced settings', () => {
    expect(page).toContain('function SessionOwnerReminderSection');
    for (const state of ['idle', 'dormant', 'pending_repo', 'tui_prompt', 'agent_attention', 'limited']) {
      expect(page).toContain(`value: '${state}'`);
    }
    for (const key of ['ownerReminderTitle', 'ownerReminderInterval', 'ownerReminderText', 'ownerReminderStates']) {
      expect(i18n.match(new RegExp(`'botDefaults\\.${key}'`, 'g'))).toHaveLength(2);
    }
  });
});
