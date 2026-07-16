import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleV3RunSaveAction, isV3RunSaveAction } from '../src/im/lark/v3-run-save-card-handler.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import {
  V3_RUN_SAVE_ACTION,
  V3_RUN_SAVE_CONFIRM_ACTION,
  buildV3RunSaveActionValue,
  type V3RunSaveActionValue,
} from '../src/im/lark/v3-run-save-card.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';

let root: string;
let baseDir: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v3-run-save-card-'));
  baseDir = join(root, 'runs');
  dataDir = join(root, 'data');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function seedRun(runId = 'save-run-001', goal = 'write report') {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), {
    runId,
    nodes: [{ id: 'work', type: 'goal', goal, depends: [], inputs: [] }],
  });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId,
    title: '可复用日报',
    requirement: goal,
    nodes: [{
      sketchId: 'work', goal, input_needs: [], expected_outputs: ['report.md'],
      acceptance: 'report exists', risk_gate: false, unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    '': { larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/source' },
  });
  const envelope = makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-07-10T08:00:00.000Z',
    authorizedAt: '2026-07-10T08:01:00.000Z',
    authorizedByOpenId: 'ou_owner',
    chatBinding: {
      larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root', ownerOpenId: 'ou_owner',
    },
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  });
  publishRunEnvelopeOnce(runDir, envelope);
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
  return { envelope, runDir };
}

function deps() {
  return { baseDir, dataDir };
}

describe('v3 terminal run save card', () => {
  it('recognizes only its own action namespace', () => {
    expect(isV3RunSaveAction(V3_RUN_SAVE_ACTION)).toBe(true);
    expect(isV3RunSaveAction(V3_RUN_SAVE_CONFIRM_ACTION)).toBe(true);
    expect(isV3RunSaveAction('v3_gate_approve')).toBe(false);
  });

  it('saves a succeeded ad-hoc run and replays to the same definition', async () => {
    const { envelope } = seedRun();
    const value = buildV3RunSaveActionValue(envelope, 'chat');
    const first = await handleV3RunSaveAction(value, 'ou_owner', 'cli_test', deps()) as any;
    const replay = await handleV3RunSaveAction(value, 'ou_owner', 'cli_test', deps()) as any;
    expect(first.header.template).toBe('green');
    expect(first.header.title.content).toContain('已保存');
    const firstDefinition = first.elements[0].fields[2].text.content;
    expect(replay.elements[0].fields[2].text.content).toBe(firstDefinition);
  });

  it('is wired through the generic Lark card handler before its legacy permission gate', async () => {
    const { envelope } = seedRun('save-run-wired');
    const value = buildV3RunSaveActionValue(envelope, 'chat');
    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: value as unknown as Record<string, string> },
    }, {
      activeSessions: new Map(),
      lastRepoScan: new Map(),
      sessionReply: async () => 'om_reply',
      v3RunSaveDeps: deps(),
    }, 'cli_test') as any;
    expect(result.header.template).toBe('green');
    expect(result.header.title.content).toContain('已保存');
  });

  it('rejects a forged operator, receiving app, old global card action, and nonce', async () => {
    const { envelope } = seedRun();
    const chat = buildV3RunSaveActionValue(envelope, 'chat');
    expect((await handleV3RunSaveAction(chat, 'ou_other', 'cli_test', deps()) as any).toast.content)
      .toContain('只有发起');
    expect((await handleV3RunSaveAction(chat, 'ou_owner', 'cli_other', deps()) as any).toast.content)
      .toContain('只有发起');
    expect((await handleV3RunSaveAction({ ...chat, nonce: 'bad' }, 'ou_owner', 'cli_test', deps()) as any).toast.content)
      .toContain('nonce');

    const global = buildV3RunSaveActionValue(envelope, 'global');
    const saveRun = vi.fn();
    expect((await handleV3RunSaveAction(
      global,
      'ou_owner',
      'cli_test',
      { ...deps(), saveRun: saveRun as any },
    ) as any).toast.content)
      .toContain('当前 Bot 全局');
    expect((await handleV3RunSaveAction(
      global,
      'ou_owner',
      'cli_test',
      { ...deps(), saveRun: saveRun as any },
    ) as any).toast.content)
      .toContain('/workflow save save-run-001 [名称] --global');
    expect(saveRun).not.toHaveBeenCalled();
  });

  it('requires a fresh explicit confirmation for unsafe reusable literals', async () => {
    const { envelope } = seedRun('unsafe-run-001', 'read /root/private/report.txt');
    const firstValue = buildV3RunSaveActionValue(envelope, 'chat');
    const warning = await handleV3RunSaveAction(firstValue, 'ou_owner', 'cli_test', deps()) as any;
    expect(warning.header.template).toBe('orange');
    const confirm = warning.elements[2].actions[0].value as V3RunSaveActionValue;
    expect(confirm.action).toBe(V3_RUN_SAVE_CONFIRM_ACTION);
    expect(confirm.warningDigest).toMatch(/^[0-9a-f]{64}$/);

    const saved = await handleV3RunSaveAction(confirm, 'ou_owner', 'cli_test', deps()) as any;
    expect(saved.header.template).toBe('green');

    const forged = { ...confirm, warningDigest: '0'.repeat(64) };
    expect((await handleV3RunSaveAction(forged, 'ou_owner', 'cli_test', deps()) as any).toast.content)
      .toContain('nonce');
  });

  it('reports success when an old confirmation card no longer produces warnings', async () => {
    const { envelope } = seedRun('warning-removed-run');
    const oldConfirm = buildV3RunSaveActionValue(envelope, 'chat', 'a'.repeat(64));
    const result = await handleV3RunSaveAction(oldConfirm, 'ou_owner', 'cli_test', deps()) as any;
    expect(result.header.template).toBe('green');
    expect(result.header.title.content).toContain('已保存');
    expect(JSON.stringify(result)).not.toContain('已失效');
  });
});
