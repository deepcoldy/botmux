import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLeadOnlyGuard, LEAD_ONLY_GUARD_FILENAME } from '../src/skills/lead-only-guard.js';

let script: string;
let pluginRoot: string;
beforeAll(() => {
  pluginRoot = mkdtempSync(join(tmpdir(), 'lead-guard-'));
  ensureLeadOnlyGuard(pluginRoot);
  script = join(pluginRoot, 'hooks', LEAD_ONLY_GUARD_FILENAME);
});

function run(command: string, leadOnly = true, tool = 'Bash') {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (leadOnly) env.BOTMUX_LEAD_ONLY = '1';
  return spawnSync('node', [script], { input: JSON.stringify({ tool_name: tool, tool_input: { command } }), env, encoding: 'utf-8' });
}

describe('lead-only Bash guard hook', () => {
  it('writes hooks.json pointing at the guard', () => {
    const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('*');
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/lead-only-guard.mjs');
    expect(existsSync(script)).toBe(true);
  });

  it.each([
    'botmux dispatch --bot worker1 --prompt hi',
    'botmux',
    'botmux send "ok"',
    "botmux send --stdin <<'EOF'\n完成了; 下一步 && rm -rf x | cat `ls` $(id)\nEOF",
    'botmux dispatch --brief "目标：a; 验收：b | c & d"',
    "botmux send 'x; y && z'",
    'botmux send "a\\"; still quoted\\""',
    'botmux send <<EOF\nplain; text\nEOF',
    'botmux send <<"EOF"\n$(id)\nEOF\n',
  ])('allows %j', (cmd) => {
    expect(run(cmd).status).toBe(0);
  });

  it.each([
    'ls',
    'botmuxx foo',
    'cat x | botmux send',
    'botmux x; rm y',
    'botmux x && rm y',
    'botmux x | tee f',
    'botmux x & ',
    'botmux x `id`',
    'botmux x $(id)',
    'botmux x\nrm y',
    'rm -rf / # botmux',
    'botmux send "$(rm x)"',
    'botmux send "a `id`"',
    'botmux send "a" ; rm y',
    'botmux send "unterminated; rm y',
    "botmux send <<'EOF'\na\nEOF\nrm -rf y",
    'botmux send <<EOF\n$(rm y)\nEOF',
    'botmux send <<EOF',
  ])('blocks %j with exit 2 and a hint', (cmd) => {
    const r = run(cmd);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('负责人只转发模式');
    expect(r.stderr).toContain('Lead-only manager mode');
    expect(r.stderr).toContain('botmux dispatch');
  });

  it('allows everything when BOTMUX_LEAD_ONLY is not 1', () => {
    expect(run('rm -rf /tmp/x; ls', false).status).toBe(0);
    const env = { PATH: process.env.PATH ?? '', BOTMUX_LEAD_ONLY: '0' };
    expect(spawnSync('node', [script], { input: JSON.stringify({ tool_input: { command: 'ls' } }), env }).status).toBe(0);
  });

  it.each(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Write', 'mcp__pi-delegate__start_task'])('blocks non-Bash tool %s', (tool) => {
    const r = run('ls', true, tool);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('负责人只转发模式');
  });

  it.each(['TodoWrite', 'Skill', 'ToolSearch'])('allows bookkeeping tool %s', (tool) => {
    expect(run('', true, tool).status).toBe(0);
  });

  it('non-Bash tools pass when BOTMUX_LEAD_ONLY is not 1', () => {
    expect(run('ls', false, 'Read').status).toBe(0);
  });
});
