import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLeadOnlyPluginDir, isPlainBotmuxCommand, isLeadOnlyToolCallAllowed, leadOnlyHooksJson } from '../src/skills/lead-only-guard.js';

describe('isPlainBotmuxCommand (strict whitelist lexer)', () => {
  it.each([
    'botmux dispatch --bot worker1 --prompt hi',
    'botmux',
    'botmux send "ok"',
    'botmux dispatch --brief "目标：a; 验收：b | c & d"',
    "botmux send 'x; y && z'",
    "botmux send 'multi\nline; text | with `ticks` $(id) <<EOF'",
    'botmux dispatch --brief "处理 <<x>>"',
    "botmux send 'a'\"b\"c",
    'botmux x --a=b@c:d,e/f%g+h\t-i\n',
  ])('allows %j', (cmd) => { expect(isPlainBotmuxCommand(cmd)).toBe(true); });

  it.each([
    '',
    '   ',
    'ls',
    'botmuxx foo',
    '"botmux" x',
    "'botmux' x",
    'cat x | botmux send',
    'botmux x; rm y',
    'botmux x && rm y',
    'botmux x | tee f',
    'botmux x & ',
    'botmux x `id`',
    'botmux x $(id)',
    'botmux x $HOME',
    'botmux x\nrm y',
    'botmux x \\\nrm y',
    'botmux x ~',
    'botmux x *',
    'botmux x ?',
    'botmux x [a]',
    'botmux x {a,b}',
    'botmux x !',
    // review bypasses
    'botmux x <(touch pwned)',
    "botmux x <(sh -c 'touch pwned')",
    'botmux x > >(cat > pwned)',
    'botmux x > pwned',
    'botmux x >> pwned',
    'botmux x 2>pwned',
    'botmux send < ~/.ssh/config',
    'botmux send <~/.ssh/config',
    "botmux x # <<'EOF'\ntouch pwned\nEOF",
    'botmux x #c',
    'botmux x <<EOF\n$\\\n(touch pwned)\nEOF',
    "botmux send --stdin <<'EOF'\nhi\nEOF",
    'botmux send "$(rm x)"',
    'botmux send "a `id`"',
    'botmux send "a\\"; rm y"',
    'botmux send "hi!"',
    'botmux send "unterminated; rm y',
    "botmux send 'unterminated",
    'botmux x (id)',
  ])('denies %j', (cmd) => { expect(isPlainBotmuxCommand(cmd)).toBe(false); });
});

describe('isLeadOnlyToolCallAllowed', () => {
  it.each(['TodoWrite', 'Skill', 'ToolSearch'])('allows bookkeeping tool %s', (t) => {
    expect(isLeadOnlyToolCallAllowed({ tool_name: t })).toBe(true);
  });
  it.each(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Write', 'mcp__pi-delegate__start_task'])('denies %s', (t) => {
    expect(isLeadOnlyToolCallAllowed({ tool_name: t })).toBe(false);
  });
  it('Bash goes through the lexer; malformed input denied', () => {
    expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: 'botmux send hi' } })).toBe(true);
    expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBe(false);
    expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: {} })).toBe(false);
    expect(isLeadOnlyToolCallAllowed({ tool_input: { command: 'botmux x' } })).toBe(true);
  });
});

describe('lead-only plugin dir', () => {
  let root: string;
  beforeAll(() => { root = ensureLeadOnlyPluginDir(join(mkdtempSync(join(tmpdir(), 'lead-guard-')), 'claude-plugin'))!; });

  it('writes manifest + hooks.json whose command is the botmux binary hook (no bare node script)', () => {
    expect(root).toMatch(/-lead-only$/);
    expect(existsSync(join(root, '.claude-plugin', 'plugin.json'))).toBe(true);
    const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('*');
    const cmd: string = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toMatch(/hook lead-only-guard$/);
    expect(cmd).not.toContain('lead-only-guard.mjs');
    expect(cmd).toBe(JSON.parse(leadOnlyHooksJson()).hooks.PreToolUse[0].hooks[0].command);
  });

  it('is idempotent', () => {
    const before = readFileSync(join(root, 'hooks', 'hooks.json'), 'utf-8');
    ensureLeadOnlyPluginDir(root.replace(/-lead-only$/, ''));
    expect(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf-8')).toBe(before);
  });
});
