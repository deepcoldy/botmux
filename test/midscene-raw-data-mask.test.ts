/**
 * 上传前给 Midscene 原始数据打码，并把飞书租户地址纳入打码范围。
 * 原始数据产物（botmux-midscene-*-data）在公开仓库里任何登录 GitHub 的人都能下载；
 * 发布站点和 PR 失败评论又都是由这些数据生成的。飞书用例的报错带着页面 URL
 * （FEISHU_TEST_GROUP_URL 的 host，即租户地址），Midscene 的报错和 dump 带着模型名。
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRedactor, redactHtml, redactTree, secretValues } from '../scripts/midscene-redact.mjs';
import { prepareMidscenePages } from '../scripts/prepare-midscene-pages.mjs';
import { evaluateExpression, format, interpolate, isTruthy } from './helpers/github-expression.js';

const MODEL = 'vision-model-9.9-pro';
const TENANT_HOST = 'acme-tenant.feishu.example';
const GROUP_URL = `https://${TENANT_HOST}/next/messenger/?chatId=oc_test_group_0001`;
const ENV = {
  MIDSCENE_MODEL_NAME: MODEL,
  MIDSCENE_MODEL_BASE_URL: 'https://llm-gateway.internal.example/v1',
  MIDSCENE_MODEL_API_KEY: 'sk-test-0123456789abcdef',
  FEISHU_TEST_GROUP_URL: GROUP_URL,
};
// 10-30 那批评论里的报错形态（地址换成了测试值）。
const MESSENGER_FAILURE = `Node "feishu.runScenario" failed: Feishu Messenger chat list did not load after 4 attempts (URL: https://${TENANT_HOST}/next/messenger/, title: Feishu).`;
const SCRIPT = resolve(import.meta.dirname, '../scripts/midscene-redact.mjs');

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('Feishu tenant address in the masked values', () => {
  it('masks the test group URL, its origin and its host wherever a page URL carries them', () => {
    const redact = createRedactor(secretValues(ENV));
    expect(redact(MESSENGER_FAILURE)).toBe(
      'Node "feishu.runScenario" failed: Feishu Messenger chat list did not load after 4 attempts (URL: ***/next/messenger/, title: Feishu).',
    );
    expect(redact(`goto ${GROUP_URL}`)).toBe('goto ***');
    expect(redact(`{"url":"https:\\/\\/${TENANT_HOST}\\/next\\/messenger\\/"}`)).toBe('{"url":"***\\/next\\/messenger\\/"}');
    expect(redact(`cookie domain .${TENANT_HOST}`)).toBe('cookie domain .***');
  });
});

describe('report pages keep working when a value also occurs in the viewer code (#2678 review P2-1)', () => {
  // "gemini" is both a plausible model name and an identifier / string / class name in the bundle.
  const page = [
    '<style>.gemini-badge{color:red}</style>',
    '<script>const geminiReasoningContent=1;function f(){return "gemini"}</script>',
    '<script type="module">import("./gemini.js")</script>',
    '<script type="midscene_web_dump" data-report-id="r1">{"usage":{"model_name":"gemini"}}</script>',
    '<!-- For Agent Analysis:\nModels: planning: gemini (x mode) -->',
    '<p>planned with gemini</p>',
  ].join('\n');
  const redact = createRedactor(secretValues({ MIDSCENE_MODEL_NAME: 'gemini' }));

  it('masks the data, the comment and the text but not the code blocks', () => {
    const masked = redactHtml(page, redact);
    expect(masked).toContain('<style>.gemini-badge{color:red}</style>');
    expect(masked).toContain('const geminiReasoningContent=1;function f(){return "gemini"}');
    expect(masked).toContain('import("./gemini.js")');
    expect(masked).toContain('{"usage":{"model_name":"***"}}');
    expect(masked).toContain('Models: planning: *** (x mode)');
    expect(masked).toContain('<p>planned with ***</p>');
  });

  it('applies to report files, leaves code files alone, and skips a page whose only match is code', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-code-'));
    await writeFile(join(root, 'report.html'), page);
    await writeFile(join(root, 'viewer-only.html'), '<script>return "gemini"</script>');
    await writeFile(join(root, 'bundle.js'), 'export const gemini = 1;');
    expect(await redactTree(root, secretValues({ MIDSCENE_MODEL_NAME: 'gemini' }))).toEqual(['report.html']);
    expect(await readFile(join(root, 'bundle.js'), 'utf8')).toBe('export const gemini = 1;');
    expect(await readFile(join(root, 'report.html'), 'utf8')).toContain('return "gemini"');
  });
});

describe('embedded screenshots stay intact (#2706 review P2-1)', () => {
  // "kimi" both names the model and occurs, by chance, inside the base64 of a screenshot.
  const redact = createRedactor(secretValues({ MIDSCENE_MODEL_NAME: 'kimi' }));
  const image = 'data:image/png;base64,AAAkimib20AAAkimi+/==';

  it('leaves midscene-image blocks and data URIs in dumps untouched, masking the text around them', () => {
    const page = `<script type="midscene-image" data-id="s1">${image}</script>`
      + `<script type="midscene_web_dump">{"model_name":"kimi","shot":"${image}"}</script><p>kimi</p>`;
    const masked = redactHtml(page, redact);
    expect(masked.split(image)).toHaveLength(3);
    expect(masked).toContain('{"model_name":"***","shot":');
    expect(masked).toContain('<p>***</p>');
    expect(redact(`{"m":"kimi","img":"${image}"}`)).toBe(`{"m":"***","img":"${image}"}`);
    // A screenshot block is left alone whatever its encoding, data URI or not.
    const bare = '<script type="midscene-image" data-id="s2">AAAkimiAAA</script>';
    expect(redactHtml(bare, redact)).toBe(bare);
  });

  it('writes every byte outside a masked value back unchanged, even in a file that is not valid UTF-8 (P3)', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-bytes-'));
    // 0xFF 0xFE is not valid UTF-8; "é" is valid two-byte UTF-8.
    const before = Buffer.concat([Buffer.from('log '), Buffer.from([0xff, 0xfe]), Buffer.from(' model kimi \u00e9\n')]);
    await writeFile(join(root, 'run.log'), before);
    expect(await redactTree(root, secretValues({ MIDSCENE_MODEL_NAME: 'kimi' }))).toEqual(['run.log']);
    const after = await readFile(join(root, 'run.log'));
    expect(after).toEqual(Buffer.from(before.toString('latin1').replace('kimi', '***'), 'latin1'));
  });
});

describe('misconfigured values (#2678 review P3-2)', () => {
  it('never masks a JSON literal or a number, which would break the JSON itself', () => {
    for (const value of ['null', 'true', 'false', '12345', '3.14']) {
      expect(secretValues({ MIDSCENE_MODEL_NAME: value }), value).toEqual([]);
    }
    expect(createRedactor(secretValues({ MIDSCENE_MODEL_NAME: 'null' }))('{"a":null}')).toBe('{"a":null}');
  });
});

describe('scripts/midscene-redact.mjs as a command (raw data, before upload)', () => {
  async function rawData() {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-raw-'));
    const runs = join(root, 'midscene_run', 'runs', 'r1', 'p1', 'documents', 'd1', 'cases', 'c1');
    const report = join(root, 'test', 'e2e-browser', 'midscene_run', 'report');
    await mkdir(runs, { recursive: true });
    await mkdir(report, { recursive: true });
    await writeFile(join(runs, 'a0.json'), JSON.stringify({ steps: [{ status: 'failed', error: { message: MESSENGER_FAILURE } }] }));
    await writeFile(join(report, 'playwright-1.html'), `<script type="midscene_web_dump">${JSON.stringify({ usage: { model_name: MODEL } })}</script>`);
    await writeFile(join(report, 'run.log'), `failed to call AI model service (${MODEL}): 429`);
    await writeFile(join(report, 'shot.jpeg'), Buffer.from(`binary ${TENANT_HOST}`));
    return root;
  }

  const run = (args: string[], env: Record<string, string>) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });

  async function textOf(dir: string) {
    const files = await readdir(dir, { withFileTypes: true, recursive: true });
    const texts: string[] = [];
    for (const entry of files) {
      if (entry.isFile() && /\.(json|html|log)$/.test(entry.name)) {
        texts.push(await readFile(join(entry.parentPath ?? (entry as any).path, entry.name), 'utf8'));
      }
    }
    return texts.join('\n');
  }

  it('masks the model name and the tenant address in every text file, leaves images alone, skips missing directories', async () => {
    const dir = await rawData();
    const out = run(['midscene_run/runs', 'test/e2e-browser/midscene_run', 'not/produced'], ENV);
    expect(out).toContain('in 3 file(s)');
    const text = await textOf(dir);
    expect(text).not.toContain(MODEL);
    expect(text).not.toContain(TENANT_HOST);
    expect(text).toContain('(URL: ***/next/messenger/');
    expect(readFileSync(join(dir, 'test', 'e2e-browser', 'midscene_run', 'report', 'shot.jpeg'), 'utf8')).toContain(TENANT_HOST);
  });

  it('changes nothing when the job has no configuration to mask', async () => {
    const dir = await rawData();
    expect(run(['midscene_run/runs'], {})).toContain('No Midscene model or Feishu test configuration');
    expect(await textOf(dir)).toContain(TENANT_HOST);
  });

  it('keeps the tenant address out of the site built from raw data that was never masked', async () => {
    root = await mkdtemp(join(tmpdir(), 'botmux-midscene-raw-site-'));
    const feishuRoot = join(root, 'feishu', 'run-1');
    const casesRoot = join(root, 'cases');
    await mkdir(feishuRoot, { recursive: true });
    await mkdir(join(root, 'dashboard'), { recursive: true });
    await mkdir(casesRoot, { recursive: true });
    await writeFile(join(feishuRoot, 'index.html'), `<script type="midscene_test_run_dump">${JSON.stringify({
      projects: [{ name: 'feishu-core-x', documents: [{ cases: [{
        caseId: 'c1', name: 'Group mode', status: 'failed',
        attempts: [{ status: 'failed', durationMs: 1, steps: [{ id: 's1', status: 'failed', error: { message: MESSENGER_FAILURE } }] }],
      }] }] }],
    })}</script>`);
    await writeFile(join(casesRoot, 'core-x.yaml'), 'cases:\n  - name: Group mode\n');
    const output = join(root, 'site');
    const manifest = await prepareMidscenePages({
      'dashboard-report-root': join(root, 'dashboard'),
      'feishu-report-root': join(root, 'feishu'),
      'feishu-outcome': 'failure',
      'feishu-cases': 'all',
      'skipped-cases-dir': casesRoot,
      output,
    }, { env: ENV });
    // The manifest is what the failure comments are made of.
    expect(manifest.cases[0].failure).toContain('(URL: ***/next/messenger/');
    expect(await textOf(output)).not.toContain(TENANT_HOST);
  });
});

describe('Midscene workflow masks the raw data before uploading it', () => {
  interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }
  interface Job { env?: Record<string, string>; steps: Step[] }
  const workflow = parseYaml(readFileSync(resolve(import.meta.dirname, '../.github/workflows/midscene-e2e.yml'), 'utf8')) as { jobs: Record<string, Job> };
  const secrets = { ...ENV };
  const envOf = (job: Job, step: Step) => Object.fromEntries(
    Object.entries({ ...job.env, ...step.env }).map(([key, value]) => [key, interpolate(String(value), { secrets, steps: {}, inputs: {} }, { format })]),
  );

  const uploads = Object.entries(workflow.jobs).flatMap(([jobId, job]) => job.steps
    .map((step, index) => ({ jobId, job, step, index }))
    .filter(({ step }) => step.uses?.startsWith('actions/upload-artifact') && /^botmux-midscene-.*-data$/.test(step.with?.name ?? '')));

  it('finds both raw data uploads', () => {
    expect(uploads.map(({ step }) => step.with!.name).sort()).toEqual(['botmux-midscene-dashboard-data', 'botmux-midscene-feishu-data']);
  });

  it('runs the mask over exactly the uploaded paths, right before each upload', () => {
    for (const { job, step, index } of uploads) {
      const mask = job.steps[index - 1];
      expect(mask.run, step.with!.name).toMatch(/^node scripts\/midscene-redact\.mjs /);
      const masked = mask.run!.replace(/^node scripts\/midscene-redact\.mjs /, '').split(/\s+/).filter(Boolean);
      const uploaded = step.with!.path.split('\n').map((line) => line.trim().replace(/\/$/, '')).filter(Boolean);
      expect(masked.sort(), step.with!.name).toEqual(uploaded.sort());
    }
  });

  // Evaluates the real step conditions: the mask runs whenever the data would
  // be uploaded (a failed suite included), and nothing is uploaded unless the
  // mask succeeded — a mask that crashed must not let unmasked data out.
  it('masks whenever the data could be uploaded, and uploads only masked data', () => {
    const evaluate = (condition: string, maskOutcome: string | null, jobFailed: boolean) => {
      const value = isTruthy(evaluateExpression(condition, {
        steps: {
          feishu_config: { outputs: { ready: 'true' } },
          ...(maskOutcome ? Object.fromEntries(uploads.map(({ job, index }) => [job.steps[index - 1].id ?? 'missing-id', { outcome: maskOutcome }])) : {}),
        },
      }, { always: () => true, cancelled: () => false, success: () => !jobFailed, failure: () => jobFailed, format }));
      // Without a status function GitHub adds success(): the step is skipped once an earlier one failed.
      return /\b(?:always|success|failure|cancelled)\s*\(/i.test(condition) ? value : value && !jobFailed;
    };
    for (const { job, step, index } of uploads) {
      const mask = job.steps[index - 1];
      const name = step.with!.name;
      expect(mask.id, name).toBeTruthy();
      for (const jobFailed of [false, true]) {
        expect(evaluate(mask.if!, null, jobFailed), `${name}: mask runs (job failed: ${jobFailed})`).toBe(true);
        expect(evaluate(step.if!, 'success', jobFailed), `${name}: masked data is uploaded`).toBe(true);
        for (const outcome of ['failure', 'skipped', 'cancelled']) {
          expect(evaluate(step.if!, outcome, jobFailed), `${name}: mask ${outcome}`).toBe(false);
        }
      }
    }
  });

  it('gives each mask step the values its data can carry', () => {
    const byName = Object.fromEntries(uploads.map(({ job, step, index }) => [step.with!.name, envOf(job, job.steps[index - 1])]));
    expect(byName['botmux-midscene-dashboard-data']).toMatchObject({ MIDSCENE_MODEL_NAME: MODEL });
    expect(byName['botmux-midscene-feishu-data']).toMatchObject({ MIDSCENE_MODEL_NAME: MODEL, FEISHU_TEST_GROUP_URL: GROUP_URL });
  });

  it('gives the site and summary steps the tenant address too (they also run on data masked by older runs\' rules)', () => {
    const report = workflow.jobs['midscene-report'];
    for (const script of ['prepare-midscene-pages.mjs', 'render-midscene-summary.mjs']) {
      const step = report.steps.find((candidate) => candidate.run?.includes(script))!;
      expect(envOf(report, step), script).toMatchObject({ FEISHU_TEST_GROUP_URL: GROUP_URL, MIDSCENE_MODEL_NAME: MODEL });
    }
  });
});
