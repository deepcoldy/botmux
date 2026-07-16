import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  birthRun,
  mintV3RunId,
  readGrillState,
  readRunChatBinding,
  writeGrillState,
  transition,
  canTransition,
  GrillTransitionError,
  GRILL_STATUS_FILE,
  GRILL_STATE_SCHEMA_VERSION,
  type GrillState,
} from '../src/workflows/v3/grill-state.js';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'v3-grill-'));
}

describe('grill-state — birthRun', () => {
  it('建 runDir + 写初始 grilling 状态 + 回 runId/paths', () => {
    const base = freshBase();
    try {
      const { runId, runDir, state } = birthRun({ goal: '帮我调研竞品出报告', baseDir: base, runId: 'demo-001' });
      expect(runId).toBe('demo-001');
      expect(runDir).toBe(join(base, 'demo-001'));
      expect(state.status).toBe('grilling');
      expect(state.schemaVersion).toBe(GRILL_STATE_SCHEMA_VERSION);
      expect(state.specPath).toBe(join(runDir, 'spec.md'));
      expect(state.specJsonPath).toBe(join(runDir, 'spec.json'));
      // 落盘了
      expect(existsSync(join(runDir, GRILL_STATUS_FILE))).toBe(true);
      const onDisk = readGrillState(runDir);
      expect(onDisk?.goal).toBe('帮我调研竞品出报告');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('不给 runId 时生成 <slug>-<精确时间>-<随机后缀>；CJK goal slug 回退 run', () => {
    const base = freshBase();
    try {
      const now = new Date(2026, 5, 2, 9, 7, 8, 9); // 2026-06-02 09:07:08.009（本地）
      const cjk = birthRun({ goal: '帮我调研竞品', baseDir: base, now, randomSuffix: 'a1b2c3d4' });
      expect(cjk.runId).toBe('run-260602-090708-009-a1b2c3d4');
      const en = birthRun({ goal: 'Research Competitors Now!!', baseDir: base, now, randomSuffix: 'e5f6a7b8' });
      expect(en.runId).toBe('research-competitors-now-260602-090708-009-e5f6a7b8');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('同目标同一毫秒仍由短随机后缀区分，且保持可读前缀', () => {
    const now = new Date(2026, 5, 2, 9, 7, 8, 9);
    const first = mintV3RunId('帮我调研竞品', now, '11111111');
    const second = mintV3RunId('帮我调研竞品', now, '22222222');
    expect(first).toBe('run-260602-090708-009-11111111');
    expect(second).toBe('run-260602-090708-009-22222222');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(() => mintV3RunId('g', now, '../bad!!')).toThrow(/8 hexadecimal/);
  });
});

describe('grill-state — 合法转移链路', () => {
  it('grilling → spec_ready → spec_approved → architect_running → dag_ready → dag_approved 全通', () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'r' });
      expect(transition(runDir, 'spec_ready').status).toBe('spec_ready');
      expect(transition(runDir, 'spec_approved').status).toBe('spec_approved');
      expect(transition(runDir, 'architect_running').status).toBe('architect_running');
      const ready = transition(runDir, 'dag_ready', {
        dagPath: join(runDir, 'architect/attempts/001/work/dag.json'),
        notesPath: join(runDir, 'architect/attempts/001/work/architect-notes.md'),
        architectManifestPath: join(runDir, 'architect/attempts/001/manifest.json'),
      });
      // codex 断言3：路径记录在案，后续别重猜
      expect(ready.dagPath).toContain('dag.json');
      expect(ready.notesPath).toContain('architect-notes.md');
      expect(ready.architectManifestPath).toContain('manifest.json');
      expect(transition(runDir, 'dag_approved').status).toBe('dag_approved');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('grill-state — 非法转移（gate 不可跳）', () => {
  it('codex 断言1 backstop：非 spec_approved 到不了 architect_running', () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'r' });
      // grilling 直接 architect → 拒
      expect(() => transition(runDir, 'architect_running')).toThrow(GrillTransitionError);
      transition(runDir, 'spec_ready');
      // spec_ready 直接 architect（跳过 approve）→ 拒
      expect(() => transition(runDir, 'architect_running')).toThrow(GrillTransitionError);
      expect(canTransition('spec_ready', 'architect_running')).toBe(false);
      expect(canTransition('spec_approved', 'architect_running')).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('grilling 不能直接跳到 spec_approved（gate-1 不可跳）', () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'r' });
      expect(() => transition(runDir, 'spec_approved')).toThrow(GrillTransitionError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('grill-state — 回退（失败/改需求）', () => {
  it('codex 断言2：architect/validate 失败可退回并记 problems', () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'r' });
      transition(runDir, 'spec_ready');
      transition(runDir, 'spec_approved');
      transition(runDir, 'architect_running');
      // validateDag 失败 → 不进 dag_ready，退回 spec_approved + 记 problems
      const back = transition(runDir, 'spec_approved', { problems: ['node "x" depends on unknown node "y"'] });
      expect(back.status).toBe('spec_approved');
      expect(back.problems).toEqual(['node "x" depends on unknown node "y"']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('dag_ready review 不过可退回 grilling 重澄清', () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'r' });
      transition(runDir, 'spec_ready');
      transition(runDir, 'spec_approved');
      transition(runDir, 'architect_running');
      transition(runDir, 'dag_ready', { dagPath: 'x' });
      expect(transition(runDir, 'grilling').status).toBe('grilling');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('grill-state — 持久化', () => {
  it('write/read roundtrip', () => {
    const base = freshBase();
    try {
      const runDir = join(base, 'r');
      const state: GrillState = {
        schemaVersion: GRILL_STATE_SCHEMA_VERSION,
        runId: 'r', goal: 'g', status: 'grilling',
        createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-06-02T00:00:00.000Z',
        specPath: join(runDir, 'spec.md'), specJsonPath: join(runDir, 'spec.json'),
      };
      writeGrillState(runDir, state);
      expect(readGrillState(runDir)).toEqual(state);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('读不存在的 runDir → undefined', () => {
    const base = freshBase();
    try {
      expect(readGrillState(join(base, 'nope'))).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('grill-state — chatBinding（daemon humanGate 发卡用）', () => {
  it('birthRun 带 chatBinding → 落盘 + readRunChatBinding 读回', () => {
    const base = freshBase();
    try {
      const binding = {
        larkAppId: 'cli_abc', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess-1',
      };
      const { runDir, state } = birthRun({ goal: 'g', baseDir: base, runId: 'r', chatBinding: binding });
      expect(state.chatBinding).toEqual(binding);
      expect(readRunChatBinding(runDir)).toEqual(binding);
      // 落盘后重新读 grill.state.json 也带 binding
      expect(readGrillState(runDir)?.chatBinding).toEqual(binding);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('birthRun 无 chatBinding（CLI/dev 出生）→ readRunChatBinding undefined，state 无该键', () => {
    const base = freshBase();
    try {
      const { runDir, state } = birthRun({ goal: 'g', baseDir: base, runId: 'r' });
      expect('chatBinding' in state).toBe(false);
      expect(readRunChatBinding(runDir)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('readRunChatBinding 读不存在的 runDir → undefined', () => {
    const base = freshBase();
    try {
      expect(readRunChatBinding(join(base, 'nope'))).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
