import { describe, expect, it } from 'vitest';

import {
  CLI_SELECT_OPTIONS,
  CLI_SELECT_TREE,
  resolveCliSelection,
  lookupCliSelection,
  selectionKeyForBot,
  stripSettingsArgs,
  stripWrapperUnsafeArgs,
  buildWrappedLaunch,
  parseWrapperCli,
  decorateResumeForWrapper,
  isTtadkWrapper,
  ttadkAcceptsModel,
  ttadkConfigModelChoices,
  TTADK_DEFAULT_MODEL,
  TTADK_MODEL_SUGGESTIONS,
} from '../src/setup/cli-selection.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';

describe('CLI_SELECT_OPTIONS / CLI_SELECT_TREE', () => {
  it('includes the two aiden gateway options right after native aiden', () => {
    const keys = CLI_SELECT_OPTIONS.map((o) => o.key);
    expect(keys).toContain('aiden');
    expect(keys).toContain('aiden-x-claude');
    expect(keys).toContain('aiden-x-codex');
    const i = keys.indexOf('aiden');
    expect(keys[i + 1]).toBe('aiden-x-claude');
    expect(keys[i + 2]).toBe('aiden-x-codex');
  });

  it('appends the two cjadk gateway options after the native CLIs', () => {
    const keys = CLI_SELECT_OPTIONS.map((o) => o.key);
    expect(keys).toContain('cjadk-x-claude');
    expect(keys).toContain('cjadk-x-codex');
    const i = keys.indexOf('cjadk-x-claude');
    expect(keys[i + 1]).toBe('cjadk-x-codex');
  });

  it('keeps every plain CliId selectable by its own key', () => {
    expect(lookupCliSelection('claude-code')?.cliId).toBe('claude-code');
    expect(lookupCliSelection('codex')?.cliId).toBe('codex');
    expect(lookupCliSelection('codex')?.wrapperCli).toBeUndefined();
  });

  it('cascades Aiden into a submenu of three variants', () => {
    const aiden = CLI_SELECT_TREE.find((g) => g.key === 'aiden');
    expect(aiden?.children?.map((c) => c.key)).toEqual(['aiden', 'aiden-x-claude', 'aiden-x-codex']);
    // an ungrouped top entry is a directly-selectable leaf
    const gemini = CLI_SELECT_TREE.find((g) => g.key === 'gemini');
    expect(gemini?.option?.cliId).toBe('gemini');
    expect(gemini?.children).toBeUndefined();
  });

  it('cascades Codex into one submenu of Codex + Codex App (no top-level codex-app)', () => {
    const codex = CLI_SELECT_TREE.find((g) => g.key === 'codex');
    expect(codex?.children?.map((c) => c.key)).toEqual(['codex', 'codex-app']);
    expect(codex?.option).toBeUndefined();
    expect(CLI_SELECT_TREE.find((g) => g.key === 'codex-app')).toBeUndefined();
    expect(resolveCliSelection('codex')).toEqual({ cliId: 'codex' });
    expect(resolveCliSelection('codex-app')).toEqual({ cliId: 'codex-app' });
  });

  it('cascades TRAE (CoCo) into one submenu of coco + traex (no top-level coco/traex)', () => {
    const trae = CLI_SELECT_TREE.find((g) => g.key === 'trae');
    expect(trae?.label).toBe('TRAE (CoCo)');
    expect(trae?.children?.map((c) => c.key)).toEqual(['coco', 'traex']);
    expect(trae?.option).toBeUndefined();
    expect(CLI_SELECT_TREE.find((g) => g.key === 'coco')).toBeUndefined();
    expect(CLI_SELECT_TREE.find((g) => g.key === 'traex')).toBeUndefined();
    expect(resolveCliSelection('coco')).toEqual({ cliId: 'coco' });
    expect(resolveCliSelection('traex')).toEqual({ cliId: 'traex' });
  });

  it('keeps Pi and Oh My Pi as adjacent top-level leaves', () => {
    const treeKeys = CLI_SELECT_TREE.map((g) => g.key);
    const i = treeKeys.indexOf('pi');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(treeKeys[i + 1]).toBe('oh-my-pi');
    // both remain directly-selectable leaves (not a submenu)
    expect(CLI_SELECT_TREE[i].option?.cliId).toBe('pi');
    expect(CLI_SELECT_TREE[i + 1].option?.cliId).toBe('oh-my-pi');
    const flatKeys = CLI_SELECT_OPTIONS.map((o) => o.key);
    const fi = flatKeys.indexOf('pi');
    expect(flatKeys[fi + 1]).toBe('oh-my-pi');
  });

  it('cascades Mira into one submenu of Mira App + Mir CLI (no top-level mir)', () => {
    const mira = CLI_SELECT_TREE.find((g) => g.key === 'mira');
    expect(mira?.children?.map((c) => c.key)).toEqual(['mira', 'mir']);
    expect(mira?.option).toBeUndefined();
    // mir is no longer a separate top-level entry — it lives under the Mira group.
    expect(CLI_SELECT_TREE.find((g) => g.key === 'mir')).toBeUndefined();
    // flat list: both resolvable, mir folded under mira (no duplicate top entry)
    const keys = CLI_SELECT_OPTIONS.map((o) => o.key);
    expect(keys).toContain('mira');
    expect(keys).toContain('mir');
  });

  it('resolves both Mira variants to their native cliIds (no wrapperCli)', () => {
    expect(resolveCliSelection('mira')).toEqual({ cliId: 'mira' });
    expect(resolveCliSelection('mir')).toEqual({ cliId: 'mir' });
  });

  it('cascades CJADK into a submenu of its two × variants', () => {
    const cjadk = CLI_SELECT_TREE.find((g) => g.key === 'cjadk');
    expect(cjadk?.children?.map((c) => c.key)).toEqual(['cjadk-x-claude', 'cjadk-x-codex']);
    expect(cjadk?.option).toBeUndefined();
  });

  it('appends the six ttadk gateway options after cjadk', () => {
    const keys = CLI_SELECT_OPTIONS.map((o) => o.key);
    expect(keys).toContain('ttadk-x-claude');
    const i = keys.indexOf('ttadk-x-claude');
    expect(keys.slice(i, i + 6)).toEqual([
      'ttadk-x-claude', 'ttadk-x-codex', 'ttadk-x-opencode', 'ttadk-x-coco', 'ttadk-x-cursor', 'ttadk-x-gemini',
    ]);
    // ttadk comes after the cjadk block
    expect(keys.indexOf('ttadk-x-claude')).toBeGreaterThan(keys.indexOf('cjadk-x-codex'));
  });

  it('cascades TTADK into a submenu of its six × variants', () => {
    const ttadk = CLI_SELECT_TREE.find((g) => g.key === 'ttadk');
    expect(ttadk?.children?.map((c) => c.key)).toEqual([
      'ttadk-x-claude', 'ttadk-x-codex', 'ttadk-x-opencode', 'ttadk-x-coco', 'ttadk-x-cursor', 'ttadk-x-gemini',
    ]);
    expect(ttadk?.option).toBeUndefined();
  });
});

describe('resolveCliSelection', () => {
  it('maps a plain cli key to just its cliId', () => {
    expect(resolveCliSelection('claude-code')).toEqual({ cliId: 'claude-code' });
    expect(resolveCliSelection('gemini')).toEqual({ cliId: 'gemini' });
  });

  it('maps aiden×claude to claude-code + wrapperCli "aiden x claude"', () => {
    expect(resolveCliSelection('aiden-x-claude')).toEqual({ cliId: 'claude-code', wrapperCli: 'aiden x claude' });
  });

  it('maps aiden×codex to codex + wrapperCli "aiden x codex"', () => {
    expect(resolveCliSelection('aiden-x-codex')).toEqual({ cliId: 'codex', wrapperCli: 'aiden x codex' });
  });

  it('maps native aiden to plain aiden (no wrapper)', () => {
    expect(resolveCliSelection('aiden')).toEqual({ cliId: 'aiden' });
  });

  it('maps cjadk×claude to claude-code + wrapperCli "cjadk claude"', () => {
    expect(resolveCliSelection('cjadk-x-claude')).toEqual({ cliId: 'claude-code', wrapperCli: 'cjadk claude' });
  });

  it('maps cjadk×codex to codex + wrapperCli "cjadk codex"', () => {
    expect(resolveCliSelection('cjadk-x-codex')).toEqual({ cliId: 'codex', wrapperCli: 'cjadk codex' });
  });

  it('maps ttadk variants to their underlying cliId + "ttadk <sub>" wrapperCli', () => {
    expect(resolveCliSelection('ttadk-x-claude')).toEqual({ cliId: 'claude-code', wrapperCli: 'ttadk claude' });
    expect(resolveCliSelection('ttadk-x-codex')).toEqual({ cliId: 'codex', wrapperCli: 'ttadk codex' });
    expect(resolveCliSelection('ttadk-x-opencode')).toEqual({ cliId: 'opencode', wrapperCli: 'ttadk opencode' });
    expect(resolveCliSelection('ttadk-x-coco')).toEqual({ cliId: 'coco', wrapperCli: 'ttadk coco' });
    // Cursor uses ttadk's `cursor-cli` subcommand but the botmux adapter is still `cursor`.
    expect(resolveCliSelection('ttadk-x-cursor')).toEqual({ cliId: 'cursor', wrapperCli: 'ttadk cursor-cli' });
    expect(resolveCliSelection('ttadk-x-gemini')).toEqual({ cliId: 'gemini', wrapperCli: 'ttadk gemini' });
  });

  it('throws on an unknown key', () => {
    expect(() => resolveCliSelection('nope')).toThrow(/未知 CLI 选择项/);
  });
});

describe('selectionKeyForBot', () => {
  it('round-trips aiden gateway bots back to their selection key', () => {
    expect(selectionKeyForBot('claude-code', 'aiden x claude')).toBe('aiden-x-claude');
    expect(selectionKeyForBot('codex', 'aiden x codex')).toBe('aiden-x-codex');
  });

  it('round-trips cjadk gateway bots back to their selection key', () => {
    expect(selectionKeyForBot('claude-code', 'cjadk claude')).toBe('cjadk-x-claude');
    expect(selectionKeyForBot('codex', 'cjadk codex')).toBe('cjadk-x-codex');
  });

  it('round-trips ttadk gateway bots back to their selection key', () => {
    expect(selectionKeyForBot('claude-code', 'ttadk claude')).toBe('ttadk-x-claude');
    expect(selectionKeyForBot('coco', 'ttadk coco')).toBe('ttadk-x-coco');
    expect(selectionKeyForBot('cursor', 'ttadk cursor-cli')).toBe('ttadk-x-cursor');
  });

  it('falls back to cliId for plain bots or unrecognised prefixes', () => {
    expect(selectionKeyForBot('codex')).toBe('codex');
    expect(selectionKeyForBot('claude-code', '')).toBe('claude-code');
    expect(selectionKeyForBot('claude-code', 'ccr')).toBe('claude-code');
  });
});

describe('stripSettingsArgs', () => {
  it('drops --settings <value> (two tokens)', () => {
    expect(stripSettingsArgs(['--session-id', 'x', '--settings', '{"a":1}', '--model', 'm']))
      .toEqual(['--session-id', 'x', '--model', 'm']);
  });

  it('drops --settings=<value> (single token)', () => {
    expect(stripSettingsArgs(['--settings={"a":1}', '--plugin-dir', '/p']))
      .toEqual(['--plugin-dir', '/p']);
  });

  it('leaves args untouched when there is no --settings', () => {
    expect(stripSettingsArgs(['--resume', 'id', '--model', 'm'])).toEqual(['--resume', 'id', '--model', 'm']);
  });
});

describe('stripWrapperUnsafeArgs', () => {
  it('strips --settings (both forms) like stripSettingsArgs', () => {
    expect(stripWrapperUnsafeArgs(['--settings', '{}', '--plugin-dir', '/p'])).toEqual(['--plugin-dir', '/p']);
    expect(stripWrapperUnsafeArgs(['--settings={}', '--model', 'm'])).toEqual(['--model', 'm']);
  });

  it('strips the botmux-injected codex -c override (flag + value)', () => {
    expect(stripWrapperUnsafeArgs([
      '--no-alt-screen',
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="s"',
      '-C',
      '/repo',
    ])).toEqual(['--no-alt-screen', '-C', '/repo']);
  });

  it('strips a botmux override for any BOTMUX_* key, not just SESSION_ID', () => {
    expect(stripWrapperUnsafeArgs(['-c', 'shell_environment_policy.set.BOTMUX_TURN_ID="t"', '--model', 'm']))
      .toEqual(['--model', 'm']);
  });

  it('leaves a user-supplied -c (non-botmux config override) untouched', () => {
    expect(stripWrapperUnsafeArgs(['-c', 'model_reasoning_effort="high"', '--model', 'm']))
      .toEqual(['-c', 'model_reasoning_effort="high"', '--model', 'm']);
  });

  it('handles both --settings and the codex -c override in one pass', () => {
    expect(stripWrapperUnsafeArgs([
      '--session-id', 'x',
      '--settings', '{}',
      '-c', 'shell_environment_policy.set.BOTMUX_SESSION_ID="s"',
      '--model', 'm',
    ])).toEqual(['--session-id', 'x', '--model', 'm']);
  });

  it('leaves args untouched when nothing is unsafe', () => {
    expect(stripWrapperUnsafeArgs(['resume', 'cid', '--model', 'm'])).toEqual(['resume', 'cid', '--model', 'm']);
  });
});

describe('parseWrapperCli', () => {
  it('splits on whitespace and drops blanks', () => {
    expect(parseWrapperCli('  aiden   x claude ')).toEqual(['aiden', 'x', 'claude']);
    expect(parseWrapperCli('')).toEqual([]);
  });
});

describe('buildWrappedLaunch', () => {
  it('prepends the prefix and strips --settings for aiden x claude', () => {
    const out = buildWrappedLaunch('aiden x claude', ['--session-id', 'sid', '--settings', '{}', '--plugin-dir', '/p']);
    expect(out.bin).toBe('aiden');
    expect(out.args).toEqual(['x', 'claude', '--session-id', 'sid', '--plugin-dir', '/p']);
  });

  it('keeps non-config args verbatim for aiden x codex', () => {
    const out = buildWrappedLaunch('aiden x codex', ['resume', 'cid', '--model', 'm']);
    expect(out.bin).toBe('aiden');
    expect(out.args).toEqual(['x', 'codex', 'resume', 'cid', '--model', 'm']);
  });

  // Regression: aiden 1.8.38+ rejects `aiden x codex … -c …`. The Codex adapter
  // injects `-c shell_environment_policy.set.BOTMUX_SESSION_ID=…` (commit 10d3e61),
  // which previously reached the launcher verbatim and broke spawn. It must now be
  // stripped for aiden wrappers; everything else (bypass/-C/--model) is preserved.
  it('strips the botmux-injected codex -c override for aiden x codex', () => {
    const out = buildWrappedLaunch('aiden x codex', [
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"',
      '-C',
      '/repo',
    ]);
    expect(out.bin).toBe('aiden');
    expect(out.args).toEqual([
      'x',
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '-C',
      '/repo',
    ]);
    expect(out.args).not.toContain('-c');
  });

  it('strips the startup-update override that aiden refuses to accept', () => {
    const out = buildWrappedLaunch('aiden x codex', [
      '-c',
      'check_for_update_on_startup=false',
      '--no-alt-screen',
    ]);
    expect(out.args).toEqual(['x', 'codex', '--no-alt-screen']);
  });

  it('does not strip a user-supplied -c that is not a botmux override (aiden x codex)', () => {
    const out = buildWrappedLaunch('aiden x codex', ['-c', 'model_reasoning_effort="high"', '--model', 'm']);
    expect(out.args).toEqual(['x', 'codex', '-c', 'model_reasoning_effort="high"', '--model', 'm']);
  });

  // Regression (only reproduces on cjadk codex): cjadk's `code` subcommand defines
  // `-c, --command <cmd>` (commander), so botmux's injected
  // `-c shell_environment_policy.set.BOTMUX_SESSION_ID=…` was captured as cjadk's
  // --command and NOT forwarded to codex → cjadk tried to run the value as a custom
  // command and errored `… is not installed. Please install it first.`. Rewrite to
  // codex's long form `--config` (which cjadk does NOT define → allowUnknownOption
  // passes it through to real codex), preserving the BOTMUX_SESSION_ID shell-env channel.
  it('rewrites the botmux codex -c override to --config for cjadk codex', () => {
    const out = buildWrappedLaunch('cjadk codex', [
      '--no-alt-screen',
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"',
    ]);
    expect(out.bin).toBe('cjadk');
    expect(out.args).toEqual(['codex', '--no-alt-screen', '--config', 'shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"']);
    // cjadk's `-c`/`--command` collision is gone — no bare -c reaches the launcher.
    expect(out.args).not.toContain('-c');
  });

  it('does not rewrite a user-supplied -c that is not a botmux override (cjadk codex)', () => {
    const out = buildWrappedLaunch('cjadk codex', ['-c', 'model_reasoning_effort="high"', '--no-alt-screen']);
    // User-owned -c is left untouched (its semantics are the user's to own, not ours).
    expect(out.args).toEqual(['codex', '-c', 'model_reasoning_effort="high"', '--no-alt-screen']);
  });

  it('rewrites the startup-update override for cjadk codex', () => {
    const out = buildWrappedLaunch('cjadk codex', [
      '-c',
      'check_for_update_on_startup=false',
    ]);
    expect(out.args).toEqual(['codex', '--config', 'check_for_update_on_startup=false']);
  });

  it('keeps the codex -c override for the bare-passthrough ttadk codex gateway', () => {
    const out = buildWrappedLaunch('ttadk codex', [
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"',
    ]);
    expect(out.args).toContain('-c');
    expect(out.args).toContain('shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"');
  });

  it('keeps the startup-update override for the bare-passthrough ttadk gateway', () => {
    const out = buildWrappedLaunch('ttadk codex', [
      '-c',
      'check_for_update_on_startup=false',
    ]);
    expect(out.args).toContain('check_for_update_on_startup=false');
  });

  it('keeps --settings for cjadk claude (forwarded verbatim to real claude)', () => {
    const out = buildWrappedLaunch('cjadk claude', ['--session-id', 'sid', '--settings', '{}', '--plugin-dir', '/p']);
    expect(out.bin).toBe('cjadk');
    expect(out.args).toEqual(['claude', '--session-id', 'sid', '--settings', '{}', '--plugin-dir', '/p']);
  });

  it('prepends the prefix for cjadk codex', () => {
    const out = buildWrappedLaunch('cjadk codex', ['resume', 'cid']);
    expect(out.bin).toBe('cjadk');
    expect(out.args).toEqual(['codex', 'resume', 'cid']);
  });

  it('works for a generic single-token prefix (ccr) without stripping --settings', () => {
    const out = buildWrappedLaunch('ccr', ['--settings', '{}', '--resume', 'x']);
    expect(out.bin).toBe('ccr');
    expect(out.args).toEqual(['--settings', '{}', '--resume', 'x']);
  });

  it('resolves the bin via the provided resolver', () => {
    const out = buildWrappedLaunch('aiden x claude', ['--resume', 'x'], (b) => `/abs/${b}`);
    expect(out.bin).toBe('/abs/aiden');
  });

  it('returns empty bin for a blank prefix so callers can skip', () => {
    expect(buildWrappedLaunch('   ', ['--resume', 'x'])).toEqual({ bin: '', args: ['--resume', 'x'] });
  });

  describe('ttadk gateway', () => {
    it('injects `-m <model> --skip-check` and forwards CLI args verbatim (keeps --settings)', () => {
      const out = buildWrappedLaunch('ttadk claude', ['--session-id', 'sid', '--settings', '{}'], (b) => b, { ttadkModel: 'glm-5.1' });
      expect(out.bin).toBe('ttadk');
      expect(out.args).toEqual(['claude', '-m', 'glm-5.1', '--skip-check', '--session-id', 'sid', '--settings', '{}']);
    });

    it('falls back to the default model when none is provided', () => {
      const out = buildWrappedLaunch('ttadk codex', ['--resume', 'cid']);
      expect(out.args).toEqual(['codex', '-m', TTADK_DEFAULT_MODEL, '--skip-check', '--resume', 'cid']);
    });

    it('treats blank/whitespace model as unset and uses the default', () => {
      const out = buildWrappedLaunch('ttadk claude', ['--x'], (b) => b, { ttadkModel: '   ' });
      expect(out.args).toEqual(['claude', '-m', TTADK_DEFAULT_MODEL, '--skip-check', '--x']);
    });

    it('does NOT inject -m for CoCo (requiresManagedModel=false), only --skip-check', () => {
      const out = buildWrappedLaunch('ttadk coco', ['--session-id', 'sid'], (b) => b, { ttadkModel: 'glm-5.1' });
      expect(out.args).toEqual(['coco', '--skip-check', '--session-id', 'sid']);
      expect(out.args).not.toContain('-m');
    });

    it('uses the cursor-cli subcommand for ttadk × cursor', () => {
      const out = buildWrappedLaunch('ttadk cursor-cli', ['--resume', 'x'], (b) => b, { ttadkModel: 'glm-5.1' });
      expect(out.args).toEqual(['cursor-cli', '-m', 'glm-5.1', '--skip-check', '--resume', 'x']);
    });

    it('resolves the ttadk bin via the provided resolver', () => {
      const out = buildWrappedLaunch('ttadk claude', [], (b) => `/abs/${b}`, { ttadkModel: 'glm-5' });
      expect(out.bin).toBe('/abs/ttadk');
    });
  });
});

// End-to-end regression: wire the REAL Codex adapter's buildArgs into the
// launcher exactly as the worker does. This is the actual failure the user hit
// (aiden 1.8.38 rejecting `aiden x codex … -c …`). Guards against the adapter
// and the wrapper layer drifting apart in the future.
describe('codex adapter × aiden wrapper (regression for commit 10d3e61)', () => {
  const codex = createCodexAdapter('/usr/bin/codex');

  const BOTMUX_OVERRIDE_RE = /^shell_environment_policy\.set\.BOTMUX_/;
  const forwardsBotmuxC = (args: ReadonlyArray<string>): boolean =>
    args.some((a, i) => a === '-c' && BOTMUX_OVERRIDE_RE.test(args[i + 1] ?? ''));

  it('native codex still injects the botmux session-env -c (feature preserved)', () => {
    const args = codex.buildArgs({ sessionId: 'sess-4', resume: false });
    expect(forwardsBotmuxC(args)).toBe(true);
  });

  it('aiden x codex never forwards the botmux -c (fresh launch)', () => {
    const args = codex.buildArgs({ sessionId: 'sess-4', resume: false, workingDir: '/repo' });
    const out = buildWrappedLaunch('aiden x codex', args);
    expect(forwardsBotmuxC(out.args)).toBe(false);
    expect(out.args).not.toContain('-c');
  });

  it('aiden x codex never forwards the botmux -c (resume launch)', () => {
    const args = codex.buildArgs({ sessionId: 'sess-4', resume: true, resumeSessionId: 'codex-uuid' });
    expect(args).toContain('resume');               // sanity: we exercised the resume branch
    const out = buildWrappedLaunch('aiden x codex', args);
    expect(forwardsBotmuxC(out.args)).toBe(false);
    // resume target + benign flags survive the strip.
    expect(out.args).toContain('codex-uuid');
    expect(out.args).toContain('--no-alt-screen');
  });

  // Cross-CLI guard: any aiden `aiden x <cli>` wrapper must drop a botmux-injected
  // `-c shell_environment_policy.set.BOTMUX_*` override, so a future adapter that
  // mirrors Codex's injection cannot re-break aiden launches. ttadk keeps it
  // (bare-passthrough); cjadk rewrites it to --config (see the cjadk regression below).
  it('no aiden built-in wrapper forwards a botmux -c override', () => {
    const codexArgs = [
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="s"',
    ];
    const aidenWrappers = CLI_SELECT_OPTIONS
      .map((o) => o.wrapperCli)
      .filter((w): w is string => !!w && parseWrapperCli(w)[0] === 'aiden');
    expect(aidenWrappers).toContain('aiden x codex');
    for (const w of aidenWrappers) {
      const out = buildWrappedLaunch(w, codexArgs);
      expect(forwardsBotmuxC(out.args), `${w} must not forward botmux -c`).toBe(false);
    }
  });
});

// End-to-end regression (only reproduces on cjadk codex): cjadk's `code` subcommand
// owns `-c/--command`, so botmux's injected `-c shell_environment_policy.set.BOTMUX_*`
// was eaten as cjadk's custom-command and never reached codex (cjadk errored
// `… is not installed`). The wrapper layer must rewrite it to codex's long-form
// `--config` (cjadk passes unknown options through), keeping the session-env channel.
describe('codex adapter × cjadk wrapper (cjadk -c/--command collision)', () => {
  const codex = createCodexAdapter('/usr/bin/codex');

  const BOTMUX_OVERRIDE_RE = /^shell_environment_policy\.set\.BOTMUX_/;
  const findConfigOverride = (args: ReadonlyArray<string>, flag: string): string | undefined => {
    const i = args.findIndex((a, j) => a === flag && BOTMUX_OVERRIDE_RE.test(args[j + 1] ?? ''));
    return i === -1 ? undefined : args[i + 1];
  };

  it('cjadk codex rewrites the botmux -c override to --config (fresh launch)', () => {
    const args = codex.buildArgs({ sessionId: 'sess-4', resume: false, workingDir: '/repo' });
    const out = buildWrappedLaunch('cjadk codex', args);
    expect(out.bin).toBe('cjadk');
    // No bare `-c` survives (would collide with cjadk's --command); the override now rides --config.
    expect(findConfigOverride(out.args, '-c')).toBeUndefined();
    expect(findConfigOverride(out.args, '--config')).toBe('shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"');
  });

  it('cjadk codex rewrites the botmux -c override to --config (resume launch)', () => {
    const args = codex.buildArgs({ sessionId: 'sess-4', resume: true, resumeSessionId: 'codex-uuid' });
    expect(args).toContain('resume');               // sanity: exercised the resume branch
    const out = buildWrappedLaunch('cjadk codex', args);
    expect(findConfigOverride(out.args, '-c')).toBeUndefined();
    expect(findConfigOverride(out.args, '--config')).toBe('shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"');
    expect(out.args).toContain('codex-uuid');        // resume target survives
  });
});

describe('isTtadkWrapper / ttadkAcceptsModel', () => {
  it('detects the ttadk prefix only', () => {
    expect(isTtadkWrapper('ttadk claude')).toBe(true);
    expect(isTtadkWrapper('ttadk coco')).toBe(true);
    expect(isTtadkWrapper('cjadk claude')).toBe(false);
    expect(isTtadkWrapper('aiden x claude')).toBe(false);
    expect(isTtadkWrapper('')).toBe(false);
    expect(isTtadkWrapper(undefined)).toBe(false);
  });

  it('reports which ttadk subcommands accept -m', () => {
    expect(ttadkAcceptsModel('ttadk claude')).toBe(true);
    expect(ttadkAcceptsModel('ttadk cursor-cli')).toBe(true);
    expect(ttadkAcceptsModel('ttadk gemini')).toBe(true);
    expect(ttadkAcceptsModel('ttadk coco')).toBe(false);
    expect(ttadkAcceptsModel('cjadk claude')).toBe(false);
    expect(ttadkAcceptsModel(undefined)).toBe(false);
  });
});

describe('ttadkConfigModelChoices', () => {
  it('returns the ttadk model suggestions for a managed-model ttadk bot', () => {
    expect(ttadkConfigModelChoices('ttadk claude')).toEqual([...TTADK_MODEL_SUGGESTIONS]);
    expect(ttadkConfigModelChoices('ttadk cursor-cli')).toEqual([...TTADK_MODEL_SUGGESTIONS]);
  });

  it('returns an empty list for ttadk CoCo (no model dropdown)', () => {
    expect(ttadkConfigModelChoices('ttadk coco')).toEqual([]);
  });

  it('returns null for non-ttadk bots so callers fall back to the adapter choices', () => {
    expect(ttadkConfigModelChoices('cjadk claude')).toBeNull();
    expect(ttadkConfigModelChoices('aiden x claude')).toBeNull();
    expect(ttadkConfigModelChoices(undefined)).toBeNull();
    expect(ttadkConfigModelChoices('')).toBeNull();
  });
});

describe('decorateResumeForWrapper', () => {
  it('rewrites the leading bin to the wrapper prefix', () => {
    expect(decorateResumeForWrapper('claude --resume ID', 'aiden x claude')).toBe('aiden x claude --resume ID');
    expect(decorateResumeForWrapper('codex resume ID', 'aiden x codex')).toBe('aiden x codex resume ID');
  });

  it('returns the command unchanged when no wrapper is set', () => {
    expect(decorateResumeForWrapper('claude --resume ID', undefined)).toBe('claude --resume ID');
    expect(decorateResumeForWrapper('claude --resume ID', '   ')).toBe('claude --resume ID');
  });

  it('keeps ttadk non-interactive flags (-m / --skip-check) in the resume command', () => {
    expect(decorateResumeForWrapper('claude --resume ID', 'ttadk claude', { ttadkModel: 'glm-5.1' }))
      .toBe('ttadk claude -m glm-5.1 --skip-check --resume ID');
  });

  it('uses the default ttadk model in the resume command when none is set', () => {
    expect(decorateResumeForWrapper('codex resume ID', 'ttadk codex'))
      .toBe(`ttadk codex -m ${TTADK_DEFAULT_MODEL} --skip-check resume ID`);
  });

  it('omits -m for ttadk CoCo resume (still adds --skip-check)', () => {
    expect(decorateResumeForWrapper('coco --resume ID', 'ttadk coco', { ttadkModel: 'glm-5.1' }))
      .toBe('ttadk coco --skip-check --resume ID');
  });
});
