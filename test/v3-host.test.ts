import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hostNew,
  hostSpecFinalize,
  hostApproveSpec,
  hostArchitect,
  hostApproveDag,
  hostReviseSpec,
  hostReviseDag,
  cmdWorkflowHost,
  chatBindingFromEnv,
  HostGuardError,
  type ArchitectDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState, transition } from '../src/workflows/v3/grill-state.js';
import { SPEC_SCHEMA_VERSION, type BotSnapshot } from '../src/workflows/v3/contract.js';
import { DagValidationError } from '../src/workflows/v3/dag.js';

function base(): string {
  return mkdtempSync(join(tmpdir(), 'v3-host-'));
}

function writeSpecMd(specPath: string, runId: string, title: string): void {
  const spec = {
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId,
    title,
    requirement: '调研竞品出报告',
    nodes: [
      { sketchId: 'research', goal: '调研 X/Y/Z', input_needs: [], expected_outputs: ['facts.md'], acceptance: '含定价', risk_gate: false, unknowns: [] },
    ],
  };
  writeFileSync(specPath, `# Spec\n\n## 草图\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`, 'utf-8');
}

function writeValidSpecMd(specPath: string, runId: string): void {
  writeSpecMd(specPath, runId, 'demo');
}

const DUMMY_BOT: BotSnapshot = { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' };

/** ArchitectDeps that always synthesize a valid dag (loadDag never throws). */
function okArchitectDeps(): ArchitectDeps {
  return {
    runArchitect: async (input) => ({
      status: 'ok',
      dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
      notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
      manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
    }),
    loadDag: () => ({ runId: 'r', nodes: [] }),
    botSnapshot: DUMMY_BOT,
    resolveLarkAppSecret: () => undefined,
  };
}

/** Drive a run to spec_approved (so architect tests can start there). */
function toApprovedSpec(baseDir: string): { runDir: string; runId: string } {
  const { runDir, runId } = hostNew({ goal: 'g', baseDir, runId: 'r' });
  writeValidSpecMd(join(runDir, 'spec.md'), runId);
  hostSpecFinalize(runDir);
  hostApproveSpec(runDir);
  return { runDir, runId };
}

/** Drive a run all the way to dag_ready (so revise/approve-dag tests can start there). */
async function toDagReady(baseDir: string): Promise<{ runDir: string; runId: string }> {
  const r = toApprovedSpec(baseDir);
  await hostArchitect(r.runDir, okArchitectDeps());
  return r;
}

describe('host — new / spec-finalize / approve-spec', () => {
  it('new 建 run；spec-finalize 校验通过 → spec_ready + 写 spec.json', () => {
    const b = base();
    try {
      const { runDir, runId } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(readGrillState(runDir)!.status).toBe('grilling');
      writeValidSpecMd(join(runDir, 'spec.md'), runId);
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(true);
      expect(out.state!.status).toBe('spec_ready');
      expect(existsSync(join(runDir, 'spec.json'))).toBe(true);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('spec-finalize：spec.md 非法 → {ok:false, problems}，状态留 grilling（阻断 handoff）', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      writeFileSync(join(runDir, 'spec.md'), '# Spec\n没有 json 块', 'utf-8');
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(false);
      expect(out.problems!.length).toBeGreaterThan(0);
      expect(readGrillState(runDir)!.status).toBe('grilling');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('approve-spec 只能从 spec_ready', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(() => hostApproveSpec(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — architect（codex 3 断言）', () => {
  it('断言1：非 spec_approved 跑 architect → HostGuardError', async () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      const deps: ArchitectDeps = {
        runArchitect: async () => { throw new Error('不该被调用'); },
        loadDag: () => ({}),
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      await expect(hostArchitect(runDir, deps)).rejects.toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('成功：runArchitect ok + loadDag ok → dag_ready 且记录 dagPath/notesPath/manifestPath（断言3）', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        }),
        loadDag: () => ({ runId: 'r', nodes: [] }), // 校验通过（不抛）
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
      expect(out.state.dagPath).toContain('dag.json');
      expect(out.state.notesPath).toContain('architect-notes.md');
      expect(out.state.architectManifestPath).toContain('manifest.json');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('断言2a：runArchitect fail → 退回 spec_approved + 记 problems，不进 dag_ready', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async () => ({ status: 'fail', manifestPath: 'm', problems: ['architect 崩了'] }),
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toEqual(['architect 崩了']);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('runArchitect throw → 退回 spec_approved + 记 problems，不卡 architect_running', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async () => { throw new Error('worker spawn failed'); },
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toEqual(['worker spawn failed']);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('runArchitect ok 但缺 notesPath → 退回 spec_approved', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        }),
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toContain('architect 未产出 architect-notes.md');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('断言2b：dagPath 出来了但 host validateDag 失败 → 退回 spec_approved + 记 validation problems', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'dag.json'),
          notesPath: join(input.runDir, 'notes.md'),
          manifestPath: join(input.runDir, 'manifest.json'),
        }),
        loadDag: () => { throw new DagValidationError(['node "x" depends on unknown node "y"']); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toContain('node "x" depends on unknown node "y"');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — approve-dag（gate-2）', () => {
  it('dag_ready → dag_approved，回 dagPath', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'dag.json'),
          notesPath: join(input.runDir, 'notes.md'),
          manifestPath: join(input.runDir, 'manifest.json'),
        }),
        loadDag: () => ({}),
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      await hostArchitect(runDir, deps);
      const { state, dagPath } = hostApproveDag(runDir);
      expect(state.status).toBe('dag_approved');
      expect(dagPath).toContain('dag.json');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('非 dag_ready 时 approve-dag → HostGuardError', () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      expect(() => hostApproveDag(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — spec-finalize 状态守卫（先 guard 后写）', () => {
  it('spec_ready 可原地重定稿（Gate-1 改稿自环），spec.json 更新成新内容', () => {
    const b = base();
    try {
      const { runDir, runId } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      writeSpecMd(join(runDir, 'spec.md'), runId, '初稿');
      expect(hostSpecFinalize(runDir).state!.status).toBe('spec_ready');
      // 用户在 Gate-1 改需求 → 改 spec.md 重新 finalize
      writeSpecMd(join(runDir, 'spec.md'), runId, '改后');
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(true);
      expect(out.state!.status).toBe('spec_ready');
      expect(readFileSync(join(runDir, 'spec.json'), 'utf-8')).toContain('改后');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('spec_approved 状态下 finalize 被拒，且 spec.json 不被覆盖（先 guard 后写）', () => {
    const b = base();
    try {
      const { runDir, runId } = toApprovedSpec(b); // spec.json 此刻 title=demo
      const before = readFileSync(join(runDir, 'spec.json'), 'utf-8');
      // 若 finalize 误执行，会把 spec.json 覆盖成新 title
      writeSpecMd(join(runDir, 'spec.md'), runId, '不该被写入');
      expect(() => hostSpecFinalize(runDir)).toThrow(HostGuardError);
      expect(readFileSync(join(runDir, 'spec.json'), 'utf-8')).toBe(before);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — architect 崩溃恢复', () => {
  it('上次 architect 写了 architect_running 后崩溃 → 重跑 architect 能恢复到 dag_ready（不卡死）', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      // 模拟中断：状态停在 architect_running（进程在 await 中被 kill）
      transition(runDir, 'architect_running');
      expect(readGrillState(runDir)!.status).toBe('architect_running');
      const out = await hostArchitect(runDir, okArchitectDeps());
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — 改稿（revise-spec / revise-dag）', () => {
  it('revise-spec：dag_ready → grilling，并清掉 stale 的 dag 产物', async () => {
    const b = base();
    try {
      const { runDir } = await toDagReady(b);
      expect(readGrillState(runDir)!.dagPath).toBeDefined();
      const state = hostReviseSpec(runDir);
      expect(state.status).toBe('grilling');
      expect(state.dagPath).toBeUndefined();
      expect(state.notesPath).toBeUndefined();
      expect(state.architectManifestPath).toBeUndefined();
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('revise-spec 在 grilling（无可退）/ dag_approved（已交 runtime）被拒', async () => {
    const b = base();
    const b2 = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(() => hostReviseSpec(runDir)).toThrow(HostGuardError); // grilling
      const { runDir: rd2 } = await toDagReady(b2);
      hostApproveDag(rd2);
      expect(() => hostReviseSpec(rd2)).toThrow(HostGuardError); // dag_approved
    } finally {
      rmSync(b, { recursive: true, force: true });
      rmSync(b2, { recursive: true, force: true });
    }
  });

  it('revise-dag：dag_ready → spec_approved，清掉 dag 产物，可重跑 architect 重编', async () => {
    const b = base();
    try {
      const { runDir } = await toDagReady(b);
      const state = hostReviseDag(runDir);
      expect(state.status).toBe('spec_approved');
      expect(state.dagPath).toBeUndefined();
      // 需求不变，重跑 architect 应再次成功
      const out = await hostArchitect(runDir, okArchitectDeps());
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('revise-dag 在非 dag_ready 被拒', () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b); // spec_approved
      expect(() => hostReviseDag(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — CLI runId 越界守卫', () => {
  it('非法 runId（路径穿越）在 dispatch 入口被拒', async () => {
    const b = base();
    try {
      await expect(cmdWorkflowHost('approve-spec', ['../escape', '--base-dir', b])).rejects.toThrow(/非法 runId/);
      await expect(cmdWorkflowHost('revise-spec', ['a/b', '--base-dir', b])).rejects.toThrow(/非法 runId/);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — chatBindingFromEnv（grill 出生落话题绑定）', () => {
  it('env 全 → 完整 binding', () => {
    expect(chatBindingFromEnv({
      BOTMUX_LARK_APP_ID: 'cli_abc',
      BOTMUX_CHAT_ID: 'oc_chat',
      BOTMUX_ROOT_MESSAGE_ID: 'om_root',
      BOTMUX_SESSION_ID: 'sess-1',
    } as NodeJS.ProcessEnv)).toEqual({
      larkAppId: 'cli_abc', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'sess-1',
    });
  });

  it('只有 larkAppId+chatId（无 root/session）→ 最小 binding', () => {
    expect(chatBindingFromEnv({
      BOTMUX_LARK_APP_ID: 'cli_abc', BOTMUX_CHAT_ID: 'oc_chat',
    } as NodeJS.ProcessEnv)).toEqual({ larkAppId: 'cli_abc', chatId: 'oc_chat' });
  });

  it('缺 larkAppId 或 chatId（CLI/dev，非 worker）→ undefined', () => {
    expect(chatBindingFromEnv({ BOTMUX_CHAT_ID: 'oc_chat' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(chatBindingFromEnv({ BOTMUX_LARK_APP_ID: 'cli_abc' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(chatBindingFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
