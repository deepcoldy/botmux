/**
 * Workflow node sessions on the executing bot (design 2026-11-03 §4.2, §5.5,
 * §7.1): the verified-handoff marker drops the workflow discovery hint and the
 * workflow skill family from every injection path (daemon-built opening input
 * and in-worker system prompt / `botmux skill show`), the node's upstream
 * products are staged as this turn's attachments, and the main bot's daemon
 * can prove acceptance from the receiver's session store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Session rows the opening-input builder looks up by id (everything else is
// the real store).
const sessionRows = new Map<string, object>();
vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, getSession: (id: string) => (sessionRows.get(id) as any) ?? actual.getSession(id) };
});
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBotmuxShellHints, buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';
import { builtinSkillContent, builtinSkillEntries } from '../src/skills/injection-mode.js';
import { WORKFLOW_FEATURE_SKILL_NAMES } from '../src/skills/definitions.js';
import { WORKFLOW_NODE_SESSION_ENV } from '../src/workflows/session-kind.js';
import {
  findWorkflowHandoffAcceptance,
  readWorkflowAttemptInputs,
  stageWorkflowNodeInputs,
  substituteWorkflowHandoffPlaceholder,
  WORKFLOW_INPUT_STAGE_MAX_FILE_BYTES,
} from '../src/core/workflow-node-session.js';
import { WORKFLOW_HANDOFF_ID_PLACEHOLDER } from '../src/im/lark/v3-node-card.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { scrubSessionTurnMarkerEnv } from '../src/utils/child-env.js';
import { buildBotmuxEnvAssignments } from '../src/adapters/backend/tmux-backend.js';

describe('node session marker suppresses workflow injection', () => {
  beforeEach(() => { process.env.BOTMUX_WORKFLOW_ENABLED = 'true'; });
  afterEach(() => {
    delete process.env.BOTMUX_WORKFLOW_ENABLED;
    delete process.env[WORKFLOW_NODE_SESSION_ENV];
  });

  it('daemon-built routing hints: a node session gets exactly the workflow-off hints', () => {
    const ordinary = buildBotmuxShellHints('zh');
    const node = buildBotmuxShellHints('zh', false, undefined, undefined, { sessionKind: 'botNode' });
    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    const workflowOff = buildBotmuxShellHints('zh');
    expect(ordinary).not.toEqual(workflowOff); // the switch is on: ordinary sessions keep the hint
    expect(node).toEqual(workflowOff);
  });

  it('in-worker system prompt: the exported marker drops the hint', () => {
    const ordinary = buildBotmuxSystemPromptText({ locale: 'zh' });
    process.env[WORKFLOW_NODE_SESSION_ENV] = '1';
    const node = buildBotmuxSystemPromptText({ locale: 'zh' });
    delete process.env[WORKFLOW_NODE_SESSION_ENV];
    process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
    const workflowOff = buildBotmuxSystemPromptText({ locale: 'zh' });
    expect(ordinary).not.toBe(workflowOff);
    expect(node).toBe(workflowOff);
  });

  it('opening input built by the daemon: a session row carrying the marker gets the workflow-off input', () => {
    sessionRows.set('s-node', { sessionId: 's-node', workflowNode: { handoffMessageId: 'om_h', publishRoot: 'om_card' } });
    sessionRows.set('s-plain', { sessionId: 's-plain' });
    try {
      const ordinary = buildNewTopicPrompt('hello', 's-plain', 'codex');
      const node = buildNewTopicPrompt('hello', 's-node', 'codex');
      process.env.BOTMUX_WORKFLOW_ENABLED = 'false';
      expect(ordinary).not.toBe(buildNewTopicPrompt('hello', 's-plain', 'codex'));
      expect(node).toBe(buildNewTopicPrompt('hello', 's-node', 'codex'));
    } finally {
      sessionRows.clear();
    }
  });

  it('skill catalog and `botmux skill show`: no workflow skill at all for a node session', () => {
    const ordinary = builtinSkillEntries({ asksViaHook: false }).map((entry) => entry.name);
    process.env[WORKFLOW_NODE_SESSION_ENV] = '1';
    const node = builtinSkillEntries({ asksViaHook: false }).map((entry) => entry.name);
    // Never resident in a catalog (read on demand); an ordinary session can
    // read the main-bot ones, a node session none — not even botmux-goal-ask.
    for (const name of WORKFLOW_FEATURE_SKILL_NAMES) {
      expect(ordinary).not.toContain(name);
      expect(node).not.toContain(name);
      expect(builtinSkillContent(name, { ...process.env })).toBeUndefined();
    }
    expect(builtinSkillContent('botmux-workflow', { ...process.env, [WORKFLOW_NODE_SESSION_ENV]: '' })).toBeDefined();
    // Besides the multi-bot dispatch skills (test/workflow-node-skills.test.ts)
    // the catalog is unchanged.
    expect(node).toEqual(ordinary.filter((name) => name !== 'botmux-orchestrate' && name !== 'botmux-handoff'));
  });
});

describe('P2-6: the node marker never crosses a process boundary by accident', () => {
  it('daemon / supervisor / dashboard boot scrubs an inherited marker', () => {
    const env: NodeJS.ProcessEnv = { [WORKFLOW_NODE_SESSION_ENV]: '1', PATH: '/usr/bin' };
    scrubSessionTurnMarkerEnv(env);
    expect(env[WORKFLOW_NODE_SESSION_ENV]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('a tmux / zellij pane receives it from a node session and never from an ordinary one', () => {
    expect(buildBotmuxEnvAssignments({ [WORKFLOW_NODE_SESSION_ENV]: '1' })).toContain(`${WORKFLOW_NODE_SESSION_ENV}=1`);
    expect(buildBotmuxEnvAssignments({}).some((arg) => arg.startsWith(`${WORKFLOW_NODE_SESSION_ENV}=`))).toBe(false);
  });
});

describe('input staging (§7.1)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wf-stage-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runFile(rel: string, content: string): string {
    const path = join(root, 'run', rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  it('copies the run\'s upstream products into the turn attachment dir', () => {
    const changes = runFile('inspect#001/attempts/001/work/changes.md', '# changes');
    const tests = runFile('verify#001/attempts/001/work/tests.md', '# tests');
    const staged = stageWorkflowNodeInputs({
      runDir: join(root, 'run'),
      inputs: {
        inputs: [
          { from: 'inspect', output: 'changes', name: 'changes.md', path: changes, kind: 'markdown' },
          { from: 'verify', name: 'tests.md', path: tests, kind: 'markdown' },
        ],
      },
      attachmentsDir: join(root, 'attachments'),
    });
    expect(staged.skipped).toEqual([]);
    expect(staged.attachments.map((attachment) => readFileSync(attachment.path, 'utf-8'))).toEqual(['# changes', '# tests']);
    expect(staged.attachments.every((attachment) => attachment.path.startsWith(join(root, 'attachments')))).toBe(true);
  });

  it('refuses paths outside the run directory, symlinks out of it and oversize files', () => {
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'host secret');
    mkdirSync(join(root, 'run', 'n'), { recursive: true });
    const link = join(root, 'run', 'n', 'link.txt');
    symlinkSync(outside, link);
    const big = runFile('n/big.bin', '');
    writeFileSync(big, Buffer.alloc(WORKFLOW_INPUT_STAGE_MAX_FILE_BYTES + 1));
    const staged = stageWorkflowNodeInputs({
      runDir: join(root, 'run'),
      inputs: {
        inputs: [
          { from: 'a', name: 'secret.txt', path: outside, kind: 'text' },
          { from: 'b', name: 'link.txt', path: link, kind: 'text' },
          { from: 'c', name: 'big.bin', path: big, kind: 'binary' },
        ],
      },
      attachmentsDir: join(root, 'attachments'),
    });
    expect(staged.attachments).toEqual([]);
    expect(staged.skipped.map((item) => item.from)).toEqual(['a', 'b', 'c']);
  });

  it('reads the attempt\'s inputs.json and refuses an attempt id escaping the run', () => {
    runFile('w#001/attempts/001/inputs.json', JSON.stringify({ inputs: [] }));
    expect(readWorkflowAttemptInputs(join(root, 'run'), 'w#001/attempts/001')).toEqual({ inputs: [] });
    expect(readWorkflowAttemptInputs(join(root, 'run'), '../outside')).toBeUndefined();
  });
});

describe('handoff id placeholder', () => {
  it('replaces every occurrence with the real handoff id', () => {
    const text = `botmux report --dispatch-root ${WORKFLOW_HANDOFF_ID_PLACEHOLDER} --status completed\n` +
      `botmux report --dispatch-root ${WORKFLOW_HANDOFF_ID_PLACEHOLDER} --status blocked "x"`;
    const out = substituteWorkflowHandoffPlaceholder(text, 'om_real', WORKFLOW_HANDOFF_ID_PLACEHOLDER);
    expect(out).not.toContain(WORKFLOW_HANDOFF_ID_PLACEHOLDER);
    expect(out.match(/om_real/g)).toHaveLength(2);
  });
});

describe('acceptance evidence (§5.5)', () => {
  const base = { sessionId: 's1', larkAppId: 'cli_doc', chatId: 'oc_chat', rootMessageId: 'om_card', status: 'active' };
  const query = { targetLarkAppId: 'cli_doc', chatId: 'oc_chat', publishRoot: 'om_card', handoffMessageId: 'om_handoff', isWorkerAlive: () => true };

  it('a session that registered this handoff accepted it, at registration time', () => {
    const registeredAt = '2026-11-03T08:00:00.000Z';
    expect(findWorkflowHandoffAcceptance({
      ...query,
      sessions: [{ ...base, workflowNode: { handoffMessageId: 'om_handoff', publishRoot: 'om_card', registeredAt } }],
    })).toEqual({ sessionId: 's1', acceptedAt: Date.parse(registeredAt) });
  });

  it('the live worker\'s durable input receipt for exactly this message also proves it', () => {
    expect(findWorkflowHandoffAcceptance({
      ...query,
      sessions: [{
        ...base, pid: 42, workerGeneration: 3,
        dispatchInputReceipts: { om_handoff: { rootMessageId: 'om_card', committedAt: '2026-11-03T08:00:00.000Z', workerGeneration: 3 } },
      }],
    })).toMatchObject({ sessionId: 's1' });
  });

  it.each([
    ['another bot', { larkAppId: 'cli_other' }],
    ['another chat', { chatId: 'oc_other' }],
    ['a closed session', { status: 'closed' }],
    ['another handoff', { workflowNode: { handoffMessageId: 'om_old', publishRoot: 'om_card', registeredAt: '2026-11-03T08:00:00.000Z' } }],
    ['a stale worker generation', { pid: 42, workerGeneration: 4, dispatchInputReceipts: { om_handoff: { rootMessageId: 'om_card', committedAt: '2026-11-03T08:00:00.000Z', workerGeneration: 3 } } }],
  ])('is not accepted by %s', (_label, overrides) => {
    expect(findWorkflowHandoffAcceptance({ ...query, sessions: [{ ...base, ...overrides }] })).toBeUndefined();
  });
});
