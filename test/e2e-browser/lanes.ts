/**
 * Feishu lane selection. Every cases/*.yaml file is one lane, run as the
 * Midscene project `feishu-<file stem>`. FEISHU_E2E_CASES picks lanes:
 * unset/`core` = core-*.yaml (the CI gate), `all` = every lane, or a comma list
 * of lane stems (`core-codex,full-group`).
 *
 * Opt-in lanes live outside cases/ because they need extra Feishu setup; they
 * run only when named (`FEISHU_E2E_CASES=traex-ambient`), never via core/all.
 *
 * scripts/midscene-report-evidence.mjs mirrors this for the report scripts
 * (they are plain .mjs and cannot import TypeScript);
 * test/midscene-lanes.test.ts keeps the two in step.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

export const CASES_DIR = path.join(import.meta.dirname, 'cases');

export function laneStem(file: string): string {
  return path.basename(file).replace(/\.ya?ml$/i, '');
}

export function laneProject(file: string): string {
  return `feishu-${laneStem(file)}`;
}

/** Lane stem → case file (relative to this directory) for opt-in lanes. */
export const OPT_IN_LANES: Readonly<Record<string, string>> = {
  // Needs a TraeX bot in an ambient-mode group (see feishu-traex-ambient.e2e.ts).
  'traex-ambient': 'cases-traex/traex-ambient.yaml',
};

/** Case file paths (relative to this directory) for a FEISHU_E2E_CASES value. */
export function selectedCaseFiles(selection?: string): string[] {
  const optIn = (selection ?? '')
    .split(',')
    .map((stem) => stem.trim())
    .filter((stem) => stem in OPT_IN_LANES);
  const rest = (selection ?? '')
    .split(',')
    .map((stem) => stem.trim())
    .filter((stem) => stem && !(stem in OPT_IN_LANES))
    .join(',');
  const lanes = optIn.length > 0 && !rest ? [] : selectLaneFiles(listLaneFiles(), rest || undefined);
  return [...lanes.map((file) => `cases/${file}`), ...optIn.map((stem) => OPT_IN_LANES[stem])];
}

export function listLaneFiles(dir = CASES_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
}

export function selectLaneFiles(files: readonly string[], selection?: string): string[] {
  const value = selection?.trim() || 'core';
  if (value === 'all') return [...files];
  if (value === 'core') return files.filter((file) => laneStem(file).startsWith('core-'));
  const wanted = value.split(',').map((stem) => stem.trim()).filter(Boolean);
  const unknown = wanted.filter((stem) => !files.some((file) => laneStem(file) === stem));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown FEISHU_E2E_CASES lane(s): ${unknown.join(', ')}. ` +
        `Known: core, all, ${files.map(laneStem).join(', ')}`,
    );
  }
  return files.filter((file) => wanted.includes(laneStem(file)));
}
