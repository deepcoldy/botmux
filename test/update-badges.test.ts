import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  CI_WORKFLOW,
  MIDSCENE_WORKFLOW,
  SUITE_JOB_NAMES,
  ciBadge,
  formatCount,
  latestFinishedRun,
  midsceneBadge,
  npmDownloadsBadge,
  npmPackages,
  updateBadges,
} from '../scripts/update-badges.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const run = (id: number, conclusion: string | null, status = 'completed') => ({ id, status, conclusion });
const job = (name: string, conclusion: string | null) => ({ name, conclusion });
const [DASHBOARD, FEISHU] = SUITE_JOB_NAMES;

describe('README badge data', () => {
  it('formats counts the way shields.io does', () => {
    expect([999, 1234, 2001, 17069, 55432, 999_499, 999_999, 1_250_000].map(formatCount))
      .toEqual(['999', '1.2k', '2k', '17k', '55k', '999k', '1M', '1.3M']);
  });

  it('sums botmux, its platform packages and the extra packages, not unrelated optional dependencies', () => {
    const packages = npmPackages({
      optionalDependencies: { '@napi-rs/canvas': '^0.1.65', 'botmux-linux-x64': '3.58.0', 'botmux-darwin-arm64': '3.58.0' },
    });
    expect(packages).toEqual(['botmux', 'botmux-linux-x64', 'botmux-darwin-arm64', 'botmux-workflow-core']);
    const points = {
      botmux: { downloads: 17_069 },
      'botmux-linux-x64': { downloads: 12_586 },
      'botmux-darwin-arm64': { downloads: 5_641 },
      'botmux-workflow-core': { downloads: 4_472 },
    };
    expect(npmDownloadsBadge(points, packages)).toMatchObject({ label: 'downloads', message: '40k/month' });
  });

  it('refuses a partial npm answer instead of publishing a smaller total', () => {
    const packages = ['botmux', 'botmux-linux-x64'];
    expect(() => npmDownloadsBadge({ botmux: { downloads: 10 }, 'botmux-linux-x64': null }, packages)).toThrow('botmux-linux-x64');
    expect(() => npmDownloadsBadge({ botmux: { downloads: 0 }, 'botmux-linux-x64': { downloads: 5 } }, packages)).toThrow('botmux');
  });

  it('reports CI from the newest run that finished, past superseded ones', () => {
    const runs = [run(5, 'cancelled'), run(4, 'skipped'), run(3, 'success'), run(2, 'failure')];
    expect(latestFinishedRun(runs)?.id).toBe(3);
    expect(ciBadge(latestFinishedRun(runs))).toMatchObject({ label: 'CI', message: 'passing' });
    expect(ciBadge(latestFinishedRun([run(9, 'cancelled'), run(8, 'timed_out')]))).toMatchObject({ message: 'failing' });
    expect(latestFinishedRun([run(7, null, 'in_progress'), run(6, 'cancelled')])).toBeUndefined();
  });

  it('says skipped when every Midscene suite was skipped, even though the run itself succeeded', () => {
    const skipped = [job('Check the Midscene model', 'success'), job(DASHBOARD, 'skipped'), job(FEISHU, 'skipped')];
    expect(midsceneBadge(run(1, 'success'), skipped)).toMatchObject({ label: 'Midscene E2E', message: 'skipped' });
    expect(midsceneBadge(run(1, 'failure'), skipped)).toMatchObject({ message: 'failing' });
  });

  it('says failing when any Midscene suite failed and passing when they ran clean', () => {
    expect(midsceneBadge(run(1, 'failure'), [job(DASHBOARD, 'success'), job(FEISHU, 'failure')])).toMatchObject({ message: 'failing' });
    expect(midsceneBadge(run(1, 'failure'), [job(DASHBOARD, 'success'), job(FEISHU, 'success')])).toMatchObject({ message: 'passing' });
    // The Feishu live slot wait timed out, so the Feishu suite never ran.
    expect(midsceneBadge(run(1, 'failure'), [job(DASHBOARD, 'success'), job(FEISHU, 'skipped')])).toMatchObject({ message: 'failing' });
    expect(() => midsceneBadge(run(1, 'success'), [job('Renamed suite', 'success')])).toThrow('renamed');
  });
});

describe('updateBadges', () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'botmux-badges-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(outDir, { recursive: true, force: true });
  });

  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' };
  const routes = (overrides: Record<string, unknown> = {}) => ({
    'https://registry.npmjs.org/botmux/latest': { optionalDependencies: { 'botmux-linux-x64': '1.0.0' } },
    'https://api.npmjs.org/downloads/point/last-month/botmux,botmux-linux-x64,botmux-workflow-core': {
      botmux: { downloads: 1_000 },
      'botmux-linux-x64': { downloads: 900 },
      'botmux-workflow-core': { downloads: 100 },
    },
    [`https://api.github.com/repos/o/r/actions/workflows/${CI_WORKFLOW}/runs?branch=master&event=push&status=completed&per_page=50`]: {
      workflow_runs: [run(12, 'cancelled'), run(11, 'failure')],
    },
    [`https://api.github.com/repos/o/r/actions/workflows/${MIDSCENE_WORKFLOW}/runs?branch=master&event=push&status=completed&per_page=50`]: {
      workflow_runs: [run(22, 'success')],
    },
    'https://api.github.com/repos/o/r/actions/runs/22/jobs?per_page=100': {
      jobs: [job(DASHBOARD, 'success'), job(FEISHU, 'success')],
    },
    ...overrides,
  });
  const fetchFrom = (table: Record<string, unknown>) => (async (url: string) =>
    url in table && table[url] !== undefined
      ? new Response(JSON.stringify(table[url]), { status: 200 })
      : new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
  const read = (file: string) => JSON.parse(readFileSync(join(outDir, file), 'utf8'));

  it('writes one shields.io endpoint file per badge', async () => {
    await updateBadges({ outDir, env, fetchImpl: fetchFrom(routes()) });
    expect(read('npm-downloads.json')).toEqual({ schemaVersion: 1, label: 'downloads', message: '2k/month', color: 'brightgreen' });
    expect(read('ci.json')).toMatchObject({ schemaVersion: 1, message: 'failing' });
    expect(read('midscene.json')).toMatchObject({ schemaVersion: 1, message: 'passing' });
  });

  it('keeps the previous file of a badge whose source is unavailable', async () => {
    writeFileSync(join(outDir, 'npm-downloads.json'), '{"previous":true}\n');
    await updateBadges({ outDir, env, fetchImpl: fetchFrom(routes({ 'https://registry.npmjs.org/botmux/latest': undefined })) });
    expect(read('npm-downloads.json')).toEqual({ previous: true });
    expect(read('ci.json')).toMatchObject({ message: 'failing' });
  });

  it('fails when no badge could be updated', async () => {
    await expect(updateBadges({ outDir, env, fetchImpl: fetchFrom({}) })).rejects.toThrow('no badge could be updated');
    expect(readdirSync(outDir)).toEqual([]);
  });

  // 机器可校验的一致性(K4)：读 GitHub 实际执行的 workflow YAML 与 README 里的 badge 地址，不读 src 文本。
  // 这几处只靠名字相连，改名后不会报错：workflow_run 按 workflow 的 name 触发、job 按 name 匹配、
  // shields.io 按文件名读，失败形状都是 badge 停在旧值或显示 invalid。
  it('stays wired to the workflows it reads and the README files that show it', async () => {
    const workflow = (file: string) => parseYaml(readFileSync(join(repoRoot, '.github/workflows', file), 'utf8'));
    const badges = workflow('badges.yml');
    expect([...badges.on.workflow_run.workflows].sort()).toEqual([workflow(CI_WORKFLOW).name, workflow(MIDSCENE_WORKFLOW).name].sort());
    const midsceneJobs = Object.values(workflow(MIDSCENE_WORKFLOW).jobs as Record<string, { name?: string }>).map((j) => j.name);
    expect(midsceneJobs).toEqual(expect.arrayContaining(SUITE_JOB_NAMES));

    await updateBadges({ outDir, env, fetchImpl: fetchFrom(routes()) });
    const written = readdirSync(outDir).sort();
    for (const readme of ['README.md', 'README.en.md']) {
      const text = readFileSync(join(repoRoot, readme), 'utf8');
      const referenced = [...text.matchAll(/raw\.githubusercontent\.com%2Fdeepcoldy%2Fbotmux%2Fbadges%2F([\w.-]+\.json)/g)].map((m) => m[1]).sort();
      expect(referenced, readme).toEqual(written);
    }
  });
});

// 机器可校验的一致性(K4)：读 GitHub 实际执行的 workflow YAML。Actions 排队时 badge job 要等很久才拿到 runner，
// 若后续触发会取消正在等的那次，每次上游跑完都重新排队，badge 一直发不出去，也不会报错。
describe('README badges workflow', () => {
  it('lets the queued update finish and only replaces the waiting one', () => {
    const { jobs } = parseYaml(readFileSync(join(repoRoot, '.github/workflows/badges.yml'), 'utf8'));
    expect(jobs.update.concurrency['cancel-in-progress']).toBe(false);
  });
});
