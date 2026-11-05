import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLeadOnlyPluginDir, isPlainBotmuxCommand, leadOnlyArgvViolation, parsePlainBotmuxArgv, isLeadOnlyToolCallAllowed, leadOnlyHooksJson } from '../src/skills/lead-only-guard.js';

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

const DENIED_SUBCOMMANDS = ['mcp serve', 'setup add', 'upgrade', 'restart', 'delete all', 'plugin init', 'schedule update x', 'workflow run', 'hook lead-only-guard', 'ask', 'daemon'];
const FILE_FLAG_CMDS = [
  "botmux send --content-file secret.txt",
  "botmux send --content-file=secret.txt",
  "botmux send --file /etc/passwd",
  "botmux send --files a,b hi",
  "botmux send --images a.png hi",
  "botmux send --card-file c.json",
  "botmux send --card-json '{}'",
  "botmux dispatch --brief-file /etc/shadow",
  "botmux dispatch --brief-file=/etc/shadow",
  "botmux send --prompt-file p",
  "botmux send --'content'-file x",
  "botmux send '--file=x'",
];
const ALLOWED_CMDS = [
  "botmux dispatch --brief 'goal: a; check: b'",
  "botmux send '多行\n文本'",
  'botmux status',
  'botmux manager status',
  'botmux manager lead-only off',
  'botmux history',
  'botmux --help',
];

describe('subcommand + flag allowlist', () => {
  it.each(ALLOWED_CMDS)('allows %j', (cmd) => {
    const argv = parsePlainBotmuxArgv(cmd);
    expect(argv).not.toBeNull();
    expect(leadOnlyArgvViolation(argv!)).toBeUndefined();
    expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: cmd } })).toBe(true);
  });
  it.each(DENIED_SUBCOMMANDS)('denies subcommand %j', (rest) => {
    const cmd = `botmux ${rest}`;
    expect(isPlainBotmuxCommand(cmd)).toBe(true); // lexically plain, so only the allowlist stops it
    expect(leadOnlyArgvViolation(parsePlainBotmuxArgv(cmd)!)).toMatch(/not allowed/);
    expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: cmd } })).toBe(false);
  });
  it.each(FILE_FLAG_CMDS)('denies file flag %j', (cmd) => {
    expect(leadOnlyArgvViolation(parsePlainBotmuxArgv(cmd)!)).toMatch(/inline/);
    expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: cmd } })).toBe(false);
  });
});

describe('guard + real bash with a dummy botmux (no side effects for bypasses)', () => {
  const BYPASS = [
    'botmux x <(touch pwned)',
    'botmux x > pwned',
    'botmux send <secret',
    "botmux x # <<'EOF'\ntouch pwned\nEOF",
    'botmux x <<EOF\n$\\\n(touch pwned)\nEOF',
    'botmux x; touch pwned',
    ...FILE_FLAG_CMDS.map(c => `${c}; touch pwned`),
    ...DENIED_SUBCOMMANDS.map(c => `botmux ${c} > pwned`),
    'botmux mcp serve',
    'botmux setup add',
    'botmux upgrade',
    'botmux delete all',
  ];
  it.each([...BYPASS, ...ALLOWED_CMDS])('%j', (cmd) => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-bash-'));
    const bin = mkdtempSync(join(tmpdir(), 'lead-bin-'));
    writeFileSync(join(bin, 'botmux'), `#!/bin/sh\necho "$@" >> "${dir}/.calls"\n`);
    chmodSync(join(bin, 'botmux'), 0o755);
    writeFileSync(join(dir, 'secret'), 'S3CRET');
    const allowed = isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: cmd } });
    if (allowed) spawnSync('bash', ['-c', cmd], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, input: '' });
    const files = readdirSync(dir).filter(f => f !== '.calls' && f !== 'secret');
    expect(files).toEqual([]);
    expect(existsSync(join(dir, '.calls'))).toBe(allowed);
    expect(allowed).toBe(ALLOWED_CMDS.includes(cmd));
  });
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
    expect(isLeadOnlyToolCallAllowed({ tool_input: { command: 'botmux status' } })).toBe(true);
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
    expect(hooks.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
    expect(cmd).not.toContain('lead-only-guard.mjs');
    expect(cmd).toBe(JSON.parse(leadOnlyHooksJson()).hooks.PreToolUse[0].hooks[0].command);
  });

  it('is idempotent', () => {
    const before = readFileSync(join(root, 'hooks', 'hooks.json'), 'utf-8');
    ensureLeadOnlyPluginDir(root.replace(/-lead-only$/, ''));
    expect(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf-8')).toBe(before);
  });
});
