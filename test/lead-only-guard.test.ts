import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
    // non-ASCII letters are never shell syntax
    'botmux dispatch --title t --bot-app cli_x:执行 --brief 目标',
    // quoted-delimiter heredoc at the end of the first line: the body is never expanded
    "botmux send --stdin <<'EOF'\nhi\nEOF",
    "botmux send --no-mention <<'EOF'\n多行 $(id) `id` ; | & > x\nEOF\n",
    'botmux send <<"EOF"\n$HOME\nEOF',
    "botmux send 'a b' <<'EOF'\n\nEOF\n\n",
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
    'botmux send "$(rm x)"',
    'botmux send "a `id`"',
    'botmux send "a\\"; rm y"',
    'botmux send "hi!"',
    'botmux send "unterminated; rm y',
    "botmux send 'unterminated",
    'botmux x (id)',
    'botmux x ；',
    // heredoc forms other than a quoted delimiter that ends the first line
    "botmux send <<'EOF'\nhi\nEOF\ntouch pwned",
    "botmux send <<'EOF'\nhi\n",
    "botmux send <<'EOF'\nhi\nEOF \n",
    "botmux send <<'EOF'\nhi\n EOF\ntouch pwned",
    "botmux send <<-'EOF'\n\thi\n\tEOF",
    "botmux send <<'EOF' --mention-back\nhi\nEOF",
    "botmux send <<'EOF' <<'G'\nhi\nEOF\nG",
    "botmux send <<'EOF'; touch pwned\nhi\nEOF",
    "botmux x; touch pwned <<'EOF'\nhi\nEOF",
    "ls <<'EOF'\nhi\nEOF",
    "botmux send 'x <<'EOF'\nhi\nEOF",
    "botmux send $(id) <<'EOF'\nhi\nEOF",
    "botmux send <<'E-F'\nhi\nE-F",
  ])('denies %j', (cmd) => { expect(isPlainBotmuxCommand(cmd)).toBe(false); });
});

const DENIED_SUBCOMMANDS = ['task register t1', 'task start t1', 'task update t1 status=done', 'mcp serve', 'setup add', 'upgrade', 'restart', 'delete all', 'plugin init', 'schedule update x', 'workflow run', 'hook lead-only-guard', 'ask', 'daemon', 'whiteboard enable', 'whiteboard disable', 'whiteboard write --yes', 'whiteboard create', 'whiteboard path', 'wb enable', 'task list', 'task', 'help', 'whiteboard list', 'wb ls', 'whiteboard read --id wb_other', 'whiteboard update --id=wb_other x', 'whiteboard read --chat-id oc_other', 'whiteboard read --session-id s2', 'whiteboard read --lark-app-id cli_x', 'whiteboard read --app-id cli_x','whiteboard current --id wb_other'];
const FILE_FLAG_CMDS = [
  'botmux whiteboard update --content-file /etc/passwd',
  'botmux whiteboard update --content-file=/x',
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
  "botmux send --diff p",
  "botmux send --diff=/tmp/x.patch",
  "botmux send --'content'-file x",
  "botmux send '--file=x'",
  "botmux send --content-file /etc/passwd <<'EOF'\nx\nEOF",
];
const ALLOWED_CMDS = [
  'botmux whiteboard read --json',
  "botmux whiteboard update --expected-updated-at 2026-11-09T00:00:00.000Z <<'EOF'\nrules: a\nEOF\n",
  "botmux wb update 'notes'",
  'botmux whiteboard status',
  'botmux whiteboard current --create',
  "botmux dispatch --brief 'goal: a; check: b'",
  "botmux send '多行\n文本'",
  'botmux status',
  'botmux manager status',
  'botmux manager lead-only off',
  'botmux history',
  'botmux bots list',
  'botmux bots ls',
  'botmux bots list --scope chat',
  'botmux bots',
  'botmux --help',
  'botmux observe',
  'botmux observe --session s1',
  "botmux send --no-mention <<'EOF'\n进度 $(touch pwned) `touch pwned2`\nEOF",
  'botmux send <<"EOF"\n$(touch pwned)\nEOF',
  "botmux dispatch --into om_x --bot-app 'cli_x:执行' --brief '先 grep 再改; 结果回报'",
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
  it('denies whiteboard flags that target another directory', () => {
    for (const cmd of ['botmux whiteboard read --working-dir /tmp', 'botmux wb update --repo=/x hi']) {
      expect(leadOnlyArgvViolation(parsePlainBotmuxArgv(cmd)!)).toMatch(/not allowed/);
      expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: cmd } })).toBe(false);
    }
  });
  it('narrows bots to roster reads: invite (membership change, no human gate) is denied', () => {
    for (const cmd of [
      'botmux bots invite --chat oc_x --team t --agent cli_x',
      'botmux bots create-group --chat oc_x',
    ]) {
      expect(isPlainBotmuxCommand(cmd)).toBe(true);
      expect(leadOnlyArgvViolation(parsePlainBotmuxArgv(cmd)!)).toMatch(/membership|群成员/);
      expect(isLeadOnlyToolCallAllowed({ tool_name: 'Bash', tool_input: { command: cmd } })).toBe(false);
    }
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
    'botmux bots invite --chat oc_x --team t --agent cli_x',
    "botmux send <<'EOF'\nhi\nEOF\ntouch pwned",
    "botmux send <<'EOF'\nhi\n EOF\ntouch pwned",
    'botmux send <<EOF\n$(touch pwned)\nEOF',
    "botmux send <<'EOF'; touch pwned\nhi\nEOF",
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

describe('lead has no file tools (memory exception removed)', () => {
  const transcript = '/home/u/.claude/projects/p/sid.jsonl';
  it.each(['Read', 'Write', 'Edit', 'MultiEdit'])('%s on a memory/*.md path is denied', (tool) => {
    expect(isLeadOnlyToolCallAllowed({ tool_name: tool, tool_input: { file_path: '/home/u/.claude/projects/p/memory/MEMORY.md' }, transcript_path: transcript })).toBe(false);
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
