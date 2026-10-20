import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  CASES_DIR,
  laneProject,
  listLaneFiles,
  selectedCaseFiles,
  selectLaneFiles,
} from './e2e-browser/lanes.js';
import { FEISHU_SCENARIOS } from './e2e-browser/midscene-suite.js';
import { CHAT_MODE_SCENARIOS, parseChatModeScenario } from './e2e-browser/chat-mode-scenarios.js';
import { FEISHU_PHASE_SCENARIOS } from './e2e-browser/feishu-report-phases.js';
import {
  feishuLaneProject,
  isFeishuLaneProject,
  selectFeishuLaneFiles,
} from '../scripts/midscene-report-evidence.mjs';

interface LaneCase {
  name: string;
  steps: Array<Record<string, { scenario?: string }>>;
}

function laneCases(file: string): LaneCase[] {
  return (parseYaml(readFileSync(path.join(CASES_DIR, file), 'utf8')) as { cases: LaneCase[] }).cases;
}

describe('Feishu Midscene lanes', () => {
  const files = listLaneFiles();

  it('keeps the core CI gate on the conversation features', () => {
    const core = selectLaneFiles(files).map(laneProject);
    expect(core).toEqual([
      'feishu-core-claude',
      'feishu-core-codex',
      'feishu-core-conversation',
      'feishu-core-dm-modes-claude',
      'feishu-core-dm-modes-codex',
      'feishu-core-group-modes',
      'feishu-core-queue',
    ]);
    expect(selectLaneFiles(files, 'all')).toEqual(files);
    expect(selectLaneFiles(files, 'core-codex, full-group').map(laneProject)).toEqual([
      'feishu-core-codex',
      'feishu-full-group',
    ]);
    expect(() => selectLaneFiles(files, 'core-nope')).toThrow(/Unknown FEISHU_E2E_CASES lane/);
  });

  it('runs opt-in lanes only when named', () => {
    expect(selectedCaseFiles('traex-ambient')).toEqual(['cases-traex/traex-ambient.yaml']);
    expect(selectedCaseFiles('core-codex,traex-ambient')).toEqual([
      'cases/core-codex.yaml',
      'cases-traex/traex-ambient.yaml',
    ]);
    expect(selectedCaseFiles('all')).not.toContain('cases-traex/traex-ambient.yaml');
    expect(selectedCaseFiles(undefined)).toEqual(selectLaneFiles(files).map((file) => `cases/${file}`));
    expect(laneProject('cases-traex/traex-ambient.yaml')).toBe('feishu-traex-ambient');
  });

  it('report scripts select and name lanes exactly like the Midscene config', () => {
    for (const selection of [undefined, '', 'core', 'all', 'core-claude,full-schedule']) {
      expect(selectFeishuLaneFiles(files, selection)).toEqual(selectLaneFiles(files, selection));
    }
    for (const file of files) {
      expect(feishuLaneProject(path.join(CASES_DIR, file))).toBe(laneProject(file));
      expect(isFeishuLaneProject(laneProject(file))).toBe(true);
    }
    expect(isFeishuLaneProject('dashboard-smoke')).toBe(false);
  });

  it('runs every chat-mode scenario in exactly one lane', () => {
    const used = files.flatMap((file) =>
      laneCases(file).flatMap((testCase) =>
        testCase.steps.flatMap((step) => Object.values(step).map((input) => input.scenario)),
      ),
    );
    for (const scenario of CHAT_MODE_SCENARIOS) {
      expect(used.filter((name) => name === scenario), scenario).toHaveLength(1);
    }
  });

  it('gives every case one lane and every step a registered scenario', () => {
    const names = files.flatMap((file) => laneCases(file).map((testCase) => testCase.name));
    // The Pages index and video manifest key evidence by case name.
    expect(new Set(names).size).toBe(names.length);
    const known = new Set<string>([...FEISHU_SCENARIOS, ...FEISHU_PHASE_SCENARIOS]);
    for (const file of files) {
      for (const testCase of laneCases(file)) {
        for (const step of testCase.steps) {
          for (const input of Object.values(step)) {
            expect(known.has(input.scenario ?? ''), `${file}: ${testCase.name}`).toBe(true);
          }
        }
      }
    }
  });

  it('parses every chat-mode scenario into a bot and mode', () => {
    const parsed = CHAT_MODE_SCENARIOS.map(parseChatModeScenario);
    expect(new Set(parsed.map((item) => `${item.kind}:${item.mode}:${item.bot}`)).size).toBe(22);
    expect(parsed.filter((item) => item.bot === 'Claude')).toHaveLength(11);
  });
});
