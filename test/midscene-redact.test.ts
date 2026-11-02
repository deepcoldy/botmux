/**
 * Midscene 模型配置不进入公开产物：发布的报告站点、run summary，以及由站点
 * manifest 生成的 PR 失败评论。GitHub 只给 job 日志打码，Midscene 却把模型名
 * 写进报错（"failed to call AI model service (<模型名>): 429 …"）和报告 dump 的
 * 每条 AI 调用记录里。
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRedactor, redactTree, secretValues } from '../scripts/midscene-redact.mjs';
import { prepareMidscenePages } from '../scripts/prepare-midscene-pages.mjs';
import { testRunDump } from '../scripts/midscene-report-evidence.mjs';
import { interpolate, format } from './helpers/github-expression.js';

const MODEL = 'vision-model-9.9-pro';
const BASE_URL = 'https://llm-gateway.internal.example/v1/';
const API_KEY = 'sk-test-0123456789abcdef';
const ENV = { MIDSCENE_MODEL_NAME: MODEL, MIDSCENE_MODEL_BASE_URL: BASE_URL, MIDSCENE_MODEL_API_KEY: API_KEY };
const QUOTA_ERROR = `Node "feishu.runScenario" failed: AI model request failed after 3 retries (4/4 attempts). Last error: failed to call AI model service (${MODEL}): 429 Your quota has been exhausted.`;

describe('secretValues / createRedactor', () => {
  it('masks the model name, the key and the base URL in every form it can take', () => {
    const redact = createRedactor(secretValues(ENV));
    expect(redact(`service (${MODEL}): 429`)).toBe('service (***): 429');
    expect(redact(`calling ${BASE_URL}chat/completions`)).toBe('calling ***/chat/completions');
    expect(redact('{"url":"https:\\/\\/llm-gateway.internal.example\\/v1"}')).toBe('{"url":"***"}');
    expect(redact('host llm-gateway.internal.example refused')).toBe('host *** refused');
    expect(redact(`Bearer ${API_KEY}`)).toBe('Bearer ***');
  });

  it('masks nothing when unconfigured, and never a value too short to be specific', () => {
    expect(secretValues({})).toEqual([]);
    expect(secretValues({ MIDSCENE_MODEL_NAME: 'gpt' })).toEqual([]);
    expect(createRedactor([])('unchanged')).toBe('unchanged');
  });
});

describe('published Midscene site', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function buildSite(env: Record<string, string>) {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-redact-'));
    const dashboardRoot = join(root, 'dashboard');
    const feishuRoot = join(root, 'feishu', 'run-1');
    const casesRoot = join(root, 'cases');
    const output = join(root, 'site');
    await Promise.all([
      mkdir(dashboardRoot, { recursive: true }),
      mkdir(feishuRoot, { recursive: true }),
      mkdir(casesRoot, { recursive: true }),
    ]);
    const runDump = {
      projects: [{
        name: 'feishu-core-x',
        documents: [{ cases: [{
          caseId: 'kimi', name: 'Kimi basic bot flow', status: 'failed',
          attempts: [{ status: 'failed', durationMs: 100, steps: [{ id: 's1', status: 'failed', error: { message: QUOTA_ERROR } }] }],
        }] }],
      }],
    };
    // Every AI call in a Midscene dump records the model, passing or not.
    const webDump = { tasks: [{ usage: { model_name: MODEL, response_model_name: MODEL }, log: `Models: insight: ${MODEL}` }] };
    await writeFile(join(feishuRoot, 'index.html'), `
      <script type="midscene_test_run_dump">${JSON.stringify(runDump)}</script>
      <script type="midscene_web_dump" data-report-id="r1">${JSON.stringify(webDump)}</script>`);
    await writeFile(join(feishuRoot, 'screenshot.png'), Buffer.from(`not-text ${MODEL}`));
    await writeFile(join(casesRoot, 'core-x.yaml'), 'cases:\n  - name: Kimi basic bot flow\n');
    const manifest = await prepareMidscenePages({
      'dashboard-report-root': dashboardRoot,
      'feishu-report-root': join(root, 'feishu'),
      'feishu-outcome': 'failure',
      'feishu-cases': 'all',
      'skipped-cases-dir': casesRoot,
      output,
    }, { env });
    return { manifest, output };
  }

  async function textFiles(dir: string): Promise<Array<{ file: string; text: string }>> {
    const out: Array<{ file: string; text: string }> = [];
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(html|json)$/.test(entry.name)) continue;
      const file = join(entry.parentPath ?? (entry as any).path, entry.name);
      out.push({ file, text: await readFile(file, 'utf8') });
    }
    return out;
  }

  it('leaves no model name in the manifest (the comments\' source), the landing page or the copied report', async () => {
    const { manifest, output } = await buildSite(ENV);
    const failure = manifest.cases.find((c: { name: string }) => c.name === 'Kimi basic bot flow').failure;
    expect(failure).toContain('failed to call AI model service (***): 429');
    const files = await textFiles(output);
    expect(files.map((f) => f.file.slice(output.length + 1)).sort()).toEqual(['feishu/index.html', 'index.html', 'manifest.json']);
    for (const { file, text } of files) expect(text, file).not.toContain(MODEL);
    expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')).cases[0].failure).toContain('(***)');
    // The masked report still loads: its run dump parses and keeps the case.
    const report = files.find((f) => f.file.endsWith('feishu/index.html'))!.text;
    expect(testRunDump(report)?.projects?.[0]?.documents?.[0]?.cases?.[0]?.name).toBe('Kimi basic bot flow');
    // Images are copied untouched.
    expect(readFileSync(join(output, 'feishu', 'screenshot.png'), 'utf8')).toContain(MODEL);
  });

  it('publishes the site unchanged when no model configuration is given', async () => {
    const { manifest } = await buildSite({});
    expect(manifest.cases[0].failure).toContain(`(${MODEL})`);
  });

  it('rewrites only files that contain a value', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-redact-tree-'));
    await writeFile(join(root, 'a.json'), `{"m":"${MODEL}"}`);
    await writeFile(join(root, 'b.json'), '{"m":"other"}');
    expect(await redactTree(root, secretValues(ENV))).toEqual(['a.json']);
    expect(await readFile(join(root, 'a.json'), 'utf8')).toBe('{"m":"***"}');
  });
});

describe('Midscene run summary', () => {
  it('masks the model name in the failure column', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botmux-midscene-summary-redact-'));
    try {
      await writeFile(join(root, 'summary.json'), JSON.stringify({
        status: 'failed',
        summary: { total: 1, passed: 0, failed: 1, notRun: 0 },
        projects: [{ name: 'dashboard-smoke', cases: [{ name: 'Dashboard', status: 'failed' }] }],
      }));
      const siteManifest = join(root, 'manifest.json');
      await writeFile(siteManifest, JSON.stringify({ cases: [{ name: 'Dashboard', project: 'dashboard-smoke', status: 'failed', failure: QUOTA_ERROR }] }));
      const output = join(root, 'output.md');
      execFileSync(process.execPath, [
        'scripts/render-midscene-summary.mjs',
        '--results', root,
        '--feishu-results', join(root, 'missing-feishu'),
        '--site-manifest', siteManifest,
        '--artifact-name', 'report',
        '--test-outcome', 'failure',
        '--feishu-outcome', 'skipped',
        '--output', output,
      ], { env: { ...process.env, ...ENV } });
      const markdown = await readFile(output, 'utf8');
      expect(markdown).toContain('(***)');
      expect(markdown).not.toContain(MODEL);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Midscene workflow hands the model configuration to the publishing steps only', () => {
  const workflow = parseYaml(readFileSync(resolve(import.meta.dirname, '../.github/workflows/midscene-e2e.yml'), 'utf8')) as {
    jobs: Record<string, { env?: Record<string, string>; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
  };
  const report = workflow.jobs['midscene-report'];
  const secrets = { MIDSCENE_MODEL_NAME: MODEL, MIDSCENE_MODEL_BASE_URL: BASE_URL, MIDSCENE_MODEL_API_KEY: API_KEY };
  const stepEnv = (script: string) => {
    const step = report.steps.find((candidate) => candidate.run?.includes(script))!;
    return Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) =>
      [key, interpolate(String(value), { secrets, steps: {} }, { format })]));
  };

  it('gives the site and summary steps the values to mask', () => {
    for (const script of ['prepare-midscene-pages.mjs', 'render-midscene-summary.mjs']) {
      expect(stepEnv(script), script).toMatchObject(ENV);
    }
    // Not the whole job: installing dependencies never sees them.
    expect(report.env ?? {}).not.toHaveProperty('MIDSCENE_MODEL_NAME');
  });
});
