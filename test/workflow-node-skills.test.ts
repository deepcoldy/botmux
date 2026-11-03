/**
 * Workflow node sessions and multi-bot dispatch skills (design 2026-11-03
 * §4.2, N3). A node session executes one node of an approved run and submits
 * it with `botmux report`, so it is offered neither the workflow family nor
 * the skills that hand work to other bots (botmux-orchestrate, botmux-handoff)
 * — not in the prompt catalog, not via `botmux skill list/show`, and not in the
 * native plugin dirs its CLI loads. Ordinary sessions keep everything.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The plugin-dir adapters resolve their shared dirs under the home directory at
// import time; point it at a throwaway dir so nothing here touches a real one.
const HOME = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/wf-node-skills-home-${process.pid}-${Math.random().toString(36).slice(2)}`);
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => HOME, default: { ...actual, homedir: () => HOME } };
});
// Session rows the daemon-side opening-input builder looks up by id.
const sessionRows = new Map<string, object>();
vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, getSession: (id: string) => (sessionRows.get(id) as any) ?? actual.getSession(id) };
});
// The builtin-injection mode is per bot config; switchable here.
const injection = vi.hoisted(() => ({ mode: 'prompt' as 'prompt' | 'off' }));
vi.mock('../src/skills/injection-mode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/skills/injection-mode.js')>();
  return { ...actual, resolveSkillInjectionModeForApp: () => injection.mode };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { builtinSkillContent, builtinSkillEntries, builtinSkillHelpPointer } from '../src/skills/injection-mode.js';
import { WORKFLOW_FEATURE_SKILL_NAMES } from '../src/skills/definitions.js';
import { ensurePluginSkills } from '../src/skills/installer.js';
import { builtinPluginDirForSession, syncWorkflowNodePluginDir, workflowNodePluginDir } from '../src/skills/workflow-node-plugin-dir.js';
import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { WORKFLOW_NODE_SESSION_ENV } from '../src/workflows/node-session-env.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createCursorAdapter } from '../src/adapters/cli/cursor.js';
import { createOhMyPiAdapter } from '../src/adapters/cli/oh-my-pi.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';

const DISPATCH = ['botmux-orchestrate', 'botmux-handoff'];
const KEPT = ['botmux-send', 'botmux-bots', 'botmux-schedule'];
const NODE = { [WORKFLOW_NODE_SESSION_ENV]: '1' };

beforeAll(() => mkdirSync(HOME, { recursive: true }));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

beforeEach(() => {
  vi.stubEnv('BOTMUX_WORKFLOW_ENABLED', 'true');
  vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'true');
  vi.stubEnv(WORKFLOW_NODE_SESSION_ENV, '');
  injection.mode = 'prompt';
});
afterEach(() => {
  vi.unstubAllEnvs();
  sessionRows.clear();
});

const names = () => builtinSkillEntries({ asksViaHook: false }).map((entry) => entry.name);

describe('prompt catalog and `botmux skill list/show`', () => {
  it('in-worker catalog: a node session loses the dispatch skills, nothing else', () => {
    const ordinary = names();
    vi.stubEnv(WORKFLOW_NODE_SESSION_ENV, '1');
    const node = names();
    expect(ordinary).toEqual(expect.arrayContaining([...DISPATCH, ...KEPT]));
    expect(node).toEqual(ordinary.filter((name) => !DISPATCH.includes(name)));
  });

  it('daemon-built opening input (prompt-catalog CLI): only a session row carrying the marker loses them', () => {
    sessionRows.set('s-node', { sessionId: 's-node', workflowNode: { handoffMessageId: 'om_h', publishRoot: 'om_card' } });
    sessionRows.set('s-plain', { sessionId: 's-plain' });
    const ordinary = buildNewTopicPrompt('hello', 's-plain', 'codex');
    const node = buildNewTopicPrompt('hello', 's-node', 'codex');
    for (const name of DISPATCH) {
      expect(ordinary).toContain(`- ${name}:`);
      expect(node).not.toContain(name);
    }
    for (const name of KEPT.filter((n) => n === 'botmux-schedule')) expect(node).toContain(`- ${name}:`);
  });

  it('daemon-built opening input with injection off: a node session is not pointed at `botmux workflow`', () => {
    injection.mode = 'off';
    sessionRows.set('s-node', { sessionId: 's-node', workflowNode: { handoffMessageId: 'om_h', publishRoot: 'om_card' } });
    sessionRows.set('s-plain', { sessionId: 's-plain' });
    const ordinary = buildNewTopicPrompt('hello', 's-plain', 'codex', undefined, undefined, undefined, undefined, undefined, undefined, 'en');
    const node = buildNewTopicPrompt('hello', 's-node', 'codex', undefined, undefined, undefined, undefined, undefined, undefined, 'en');
    expect(ordinary).toContain(builtinSkillHelpPointer('en', { workflowEnabled: true }));
    expect(node).toContain(builtinSkillHelpPointer('en', { workflowEnabled: false }));
    expect(node).not.toContain(builtinSkillHelpPointer('en', { workflowEnabled: true }));
  });

  it('in-worker help pointer (injection off): the node marker drops `workflow`', () => {
    const ordinary = builtinSkillHelpPointer('en');
    vi.stubEnv(WORKFLOW_NODE_SESSION_ENV, '1');
    expect(ordinary).toBe(builtinSkillHelpPointer('en', { workflowEnabled: true }));
    expect(builtinSkillHelpPointer('en')).toBe(builtinSkillHelpPointer('en', { workflowEnabled: false }));
  });

  it('`botmux skill list` / `show` / `resources`: ordinary sessions read them, node sessions are refused with a reason', () => {
    vi.stubEnv('SESSION_DATA_DIR', mkdtempSync(join(tmpdir(), 'wf-node-skills-data-')));
    const ordinary = { BOTMUX_SESSION_ID: 's-skill', BOTMUX_WORKFLOW_ENABLED: 'true', BOTMUX_MULTI_TOPIC_ENABLED: 'true' };
    const node = { ...ordinary, ...NODE };
    const listed = (env: Record<string, string>) => runSkillSessionCommand(['list'], env).stdout.split('\n').map((line) => line.split('\t')[0]);
    expect(listed(ordinary)).toEqual(expect.arrayContaining([...DISPATCH, ...KEPT]));
    expect(listed(node)).toEqual(expect.arrayContaining(KEPT));
    for (const name of DISPATCH) {
      expect(listed(node)).not.toContain(name);
      expect(runSkillSessionCommand(['show', name], ordinary)).toMatchObject({ code: 0, stdout: expect.stringContaining(`name: ${name}`) });
      for (const sub of ['show', 'resources']) {
        const refused = runSkillSessionCommand([sub, name], node);
        expect(refused).toMatchObject({ code: 1, stdout: '' });
        expect(refused.stderr).toContain(name);
      }
      // The resolver itself withholds them too (other callers of it).
      expect(builtinSkillContent(name, ordinary)).toBeDefined();
      expect(builtinSkillContent(name, node)).toBeUndefined();
    }
    expect(runSkillSessionCommand(['show', 'botmux-send'], node)).toMatchObject({ code: 0 });
  });
});

describe('native plugin dirs', () => {
  const skillsIn = (dir: string) => readdirSync(join(dir, 'skills')).sort();
  const prepare = (cliId: string, dir: string) => {
    ensurePluginSkills(cliId, dir);
    // A workflow skill an older build left in the shared dir.
    mkdirSync(join(dir, 'skills', 'botmux-workflow'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'botmux-workflow', 'SKILL.md'), '---\nname: botmux-workflow\n---\n');
  };

  it.each([
    ['claude-code', 'claude-plugin', () => createClaudeCodeAdapter('/usr/bin/claude'), '--plugin-dir', ''],
    ['cursor', 'cursor-plugin', () => createCursorAdapter('/usr/bin/cursor-agent'), '--plugin-dir', ''],
    ['oh-my-pi', 'omp-plugin', () => createOhMyPiAdapter('/bin/omp', () => '/tmp/boundary.js'), '--plugin-dir', ''],
    ['pi', 'pi-skills', () => createPiAdapter('/bin/pi', () => '/tmp/boundary.js'), '--skill', 'skills'],
  ] as const)('%s: a node session\'s CLI loads the copy without the withheld skills; an ordinary one the shared dir', (cliId, dirName, make, flag, sub) => {
    const shared = join(HOME, '.botmux', dirName);
    prepare(cliId, shared);
    const loaded = () => {
      const args = make().buildArgs({ sessionId: `s-${cliId}`, resume: false, env: {} } as any);
      return args[args.indexOf(flag) + 1];
    };
    expect(loaded()).toBe(join(shared, sub));
    vi.stubEnv(WORKFLOW_NODE_SESSION_ENV, '1');
    const copy = workflowNodePluginDir(shared);
    expect(loaded()).toBe(join(copy, sub));
    expect(skillsIn(copy)).toEqual(skillsIn(shared).filter((name) => !DISPATCH.includes(name) && !WORKFLOW_FEATURE_SKILL_NAMES.includes(name)));
    expect(skillsIn(copy)).toEqual(expect.arrayContaining(KEPT));
    expect(existsSync(join(copy, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('the copy follows the shared dir: removed skills disappear, a withheld one never stays', () => {
    const shared = join(mkdtempSync(join(tmpdir(), 'wf-node-plugin-')), 'plugin');
    prepare('claude-code', shared);
    const copy = syncWorkflowNodePluginDir(shared);
    rmSync(join(shared, 'skills', 'botmux-schedule'), { recursive: true });
    writeFileSync(join(shared, 'skills', 'botmux-send', 'SKILL.md'), '---\nname: botmux-send\ndescription: edited\n---\n');
    mkdirSync(join(copy, 'skills', 'botmux-orchestrate'), { recursive: true }); // e.g. left by an older build
    syncWorkflowNodePluginDir(shared);
    expect(skillsIn(copy)).not.toContain('botmux-schedule');
    expect(skillsIn(copy)).not.toContain('botmux-orchestrate');
    expect(readdirSync(join(copy, 'skills', 'botmux-send'))).toEqual(['SKILL.md']);
    expect(builtinSkillSource(copy, 'botmux-send')).toContain('description: edited');
  });

  it('an ordinary session never creates the copy; if it cannot be prepared the shared dir is used', () => {
    const shared = join(mkdtempSync(join(tmpdir(), 'wf-node-plugin-')), 'plugin');
    prepare('claude-code', shared);
    expect(builtinPluginDirForSession(shared, {})).toBe(shared);
    expect(existsSync(workflowNodePluginDir(shared))).toBe(false);
    const missing = join(tmpdir(), `wf-node-plugin-missing-${process.pid}`);
    expect(builtinPluginDirForSession(missing, NODE)).toBe(missing);
  });
});

function builtinSkillSource(dir: string, name: string): string {
  return readFileSync(join(dir, 'skills', name, 'SKILL.md'), 'utf8');
}
