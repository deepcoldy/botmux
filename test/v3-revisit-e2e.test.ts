/**
 * v3-revisit-e2e.test.ts — 跨节点 revisit 的 DAEMON 级端到端：走真正的
 * `driveV3Run`(grill 出生 + dag.json + bots 解析 + 真 manifest 校验
 * readAndValidateManifest)+ 注入一个脚本化 worker(不 spawn 真 CLI —— 真 CLI
 * 是否回溯取决于模型,不可作确定性测试;真机 smoke 见 docs 的 runbook)。
 *
 * 覆盖 unit/集成测试够不到的 daemon 编排:revisit → supersede → 预算耗尽 →
 * postRevisitGrantCard 真被调 → requestRevisitGrant 原子 grant+retry → redrive →
 * 成功。证明卡片那一砖确实接到了 daemon 受阻分发上。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { driveV3Run, requestRevisitGrant, type V3DaemonRunDeps } from '../src/workflows/v3/daemon-run.js';
import { birthRun, writeGrillState, readGrillState } from '../src/workflows/v3/grill-state.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { GOAL_ENV, type Manifest, type RunNode, type ValidateManifest } from '../src/workflows/v3/contract.js';

const BINDING = { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' };

const realValidate: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (e) {
    return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
  }
};

function file(outputDir: string, name: string, content: string, kind: 'markdown' | 'json'): Manifest['files'][number] {
  writeFileSync(join(outputDir, name), content);
  return { name, path: name, kind, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), mime: kind === 'json' ? 'application/json' : 'text/markdown' };
}
function writeManifest(req: Parameters<RunNode>[0], m: Manifest): string {
  const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(p, JSON.stringify(m));
  return p;
}

/** A→C, C 声明可回溯 A,且 C 永远请求回溯(逼出预算耗尽)。 */
function seedRevisitRun(base: string, runId: string): string {
  const { runDir } = birthRun({ goal: 'g', baseDir: base, runId, chatBinding: BINDING });
  const dagPath = join(runDir, 'dag.json');
  writeFileSync(dagPath, JSON.stringify({
    runId,
    nodes: [
      { id: 'A', type: 'goal', goal: 'a', depends: [], inputs: [] },
      { id: 'C', type: 'goal', goal: 'c', depends: ['A'], inputs: [{ from: 'A' }], revisitTo: ['A'] },
    ],
  }));
  const state = readGrillState(runDir)!;
  writeGrillState(runDir, { ...state, status: 'dag_approved', dagPath });
  return runDir;
}

describe('v3 revisit — daemon 级 e2e (driveV3Run + 真 manifest 校验 + 脚本化 worker)', () => {
  it('revisit → 预算耗尽 → postRevisitGrantCard 被调 → grant+retry → 收敛成功', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-revisit-e2e-'));
    try {
      const runId = 'revisit-e2e';
      seedRevisitRun(base, runId);

      // C 在 #001/#002 请求回溯(逼出 per-pair=1 耗尽),#003 起成功收敛。
      const cRevisitInstances = new Set(['C#001', 'C#002']);
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'A') {
          return { status: 'ok', manifestPath: writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 'a', files: [file(req.outputDir, 'a.md', 'A', 'markdown')] }) };
        }
        const inst = req.attemptId.split('/')[0]!; // e.g. C#002
        if (cRevisitInstances.has(inst)) {
          return { status: 'ok', manifestPath: writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 'revisit', files: [file(req.outputDir, 'result.json', JSON.stringify({ status: 'revisit', revisitTo: 'A', reason: '还要改' }), 'json')] }) };
        }
        return { status: 'ok', manifestPath: writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 'c done', files: [file(req.outputDir, 'c.md', 'C-final', 'markdown')] }) };
      };

      const postRevisitGrantCard = vi.fn(async () => {});
      const deps: V3DaemonRunDeps = {
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => runNode,
        validateManifest: realValidate,
        postRevisitGrantCard,
        onTerminal: async () => {},
      };

      // drive 1:C#001 回溯 → A#002,C#002 → C#002 回溯 → per-pair 1/1 耗尽 → 受阻。
      const first = await driveV3Run(runId, deps);
      expect(first.reason).toBe('terminal');
      if (first.reason === 'terminal') expect(first.runStatus).toBe('blocked');
      // daemon 选了 revisit grant 卡(不是普通 retry 卡),且 scope=pair。
      expect(postRevisitGrantCard).toHaveBeenCalledTimes(1);
      const info = postRevisitGrantCard.mock.calls[0]![1];
      expect(info).toMatchObject({ sourceNodeId: 'C', toNodeId: 'A', tier: 'pair' });

      // 人工准许(pair)+ 原子 retry。
      const grant = requestRevisitGrant(base, runId, { sourceNodeId: 'C', toNodeId: 'A', by: 'ou_user', expectedAttemptId: info.attemptId });
      expect(grant.kind).toBe('granted');

      // drive 2:C#002 回溯放行(预算 2)→ A#003,C#003 → C#003 成功 → run 成功。
      const second = await driveV3Run(runId, deps);
      expect(second.reason).toBe('terminal');
      if (second.reason === 'terminal') expect(second.runStatus).toBe('succeeded');

      const events = readJournal(join(base, runId, 'journal.ndjson'));
      // 共放行 2 次回溯(C#001、C#002),C#003 成功收敛。
      expect(events.filter((e) => e.type === 'nodeRevisitRequested').length).toBe(2);
      expect(events.some((e) => e.type === 'nodeSucceeded' && (e as any).instanceId === 'C#003')).toBe(true);
      expect(events.filter((e) => e.type === 'revisitBudgetGranted').length).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
