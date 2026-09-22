#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { reportCases, testRunDump } from './midscene-report-evidence.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? '<end>'}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}`);
  return path.resolve(value);
}

async function findReportIndexes(root) {
  const matches = [];
  async function visit(directory) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === 'index.html') {
        matches.push({ file: candidate, modifiedAt: (await stat(candidate)).mtimeMs });
      }
    }
  }
  await visit(root);
  return matches.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function findFiles(root, predicate) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && predicate(entry.name)) matches.push(candidate);
    }
  }
  await visit(root);
  return matches;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return '—';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

async function readYamlCases(root) {
  const files = await findFiles(root, (name) => /\.ya?ml$/i.test(name));
  const cases = [];
  for (const file of files.sort()) {
    const document = parseYaml(await readFile(file, 'utf8'));
    for (const testCase of document?.cases ?? []) {
      if (typeof testCase?.name === 'string') cases.push(testCase.name);
    }
  }
  return cases;
}

async function loadProjectReport({ reportRoot, projectName, output, slug }) {
  for (const report of await findReportIndexes(reportRoot)) {
    const html = await readFile(report.file, 'utf8');
    const run = testRunDump(html);
    if (!run?.projects?.some((project) => project.name === projectName)) continue;
    const cases = await reportCases(run, projectName, { html, reportFile: report.file });
    await cp(path.dirname(report.file), path.join(output, slug), { recursive: true });
    await mkdir(path.join(output, 'previews'), { recursive: true });
    for (const testCase of cases) {
      if (!testCase.previewFile || !testCase.screenshot) continue;
      await writeFile(
        path.join(output, 'previews', testCase.previewFile),
        testCase.screenshot.bytes,
      );
    }
    return cases.map(({ screenshot, previewFile, ...testCase }) => ({
      ...testCase,
      reportPath: `${slug}/index.html`,
      previewPath: previewFile ? `previews/${previewFile}` : null,
    }));
  }
  throw new Error(`No Midscene Test report found for project ${projectName}`);
}

function caseTarget(testCase) {
  if (!testCase.reportPath) return null;
  return testCase.stepId
    ? `${testCase.reportPath}#${new URLSearchParams({ 'runner-step': testCase.stepId })}`
    : testCase.reportPath;
}

function landingPage(cases) {
  const passed = cases.filter((testCase) => testCase.status === 'success').length;
  const failed = cases.filter((testCase) => testCase.status === 'failed').length;
  const skipped = cases.filter((testCase) => testCase.status === 'skipped').length;
  const rows = cases.map((testCase) => {
    const icon = testCase.status === 'success' ? '✅' : testCase.status === 'skipped' ? '⏭️' : '❌';
    const target = caseTarget(testCase);
    const name = target
      ? `<a href="${escapeHtml(target)}">${escapeHtml(testCase.name)}</a>`
      : escapeHtml(testCase.name);
    const preview = testCase.previewPath && target
      ? `<a href="${escapeHtml(target)}"><img src="${escapeHtml(testCase.previewPath)}" alt="${escapeHtml(testCase.name)} screenshot" loading="lazy"></a>`
      : '<span class="unavailable">Not available</span>';
    return `<tr><td>${icon}</td><td>${name}</td><td>${escapeHtml(testCase.project)}</td><td>${escapeHtml(testCase.status)}</td><td>${formatDuration(testCase.durationMs)}</td><td>${preview}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Botmux Midscene report</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b0d13; color: #e8eaf2; }
    main { width: min(1280px, calc(100% - 40px)); margin: 48px auto; }
    .summary, .unavailable { color: #aeb4c6; }
    a { color: #a99bff; }
    table { width: 100%; border-collapse: collapse; background: #131722; border: 1px solid #2b3142; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #2b3142; text-align: left; vertical-align: top; }
    th { color: #aeb4c6; font-size: 13px; text-transform: uppercase; }
    img { width: 260px; max-height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid #343b50; }
  </style>
</head>
<body><main>
  <h1>Botmux × Midscene</h1>
  <p class="summary"><strong>${passed}/${cases.length} cases passed</strong> · ${failed} failed · ${skipped} skipped</p>
  <table>
    <thead><tr><th></th><th>Case</th><th>Project</th><th>Status</th><th>Duration</th><th>Node screenshot</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</main></body>
</html>`;
}

export async function prepareMidscenePages(options) {
  const dashboardKey = 'dashboard-report-root' in options ? 'dashboard-report-root' : 'report-root';
  const dashboardReportRoot = required(options, dashboardKey);
  const skippedCasesDir = required(options, 'skipped-cases-dir');
  const output = required(options, 'output');
  await mkdir(output, { recursive: true });

  const cases = await loadProjectReport({
    reportRoot: dashboardReportRoot,
    projectName: 'dashboard-smoke',
    output,
    slug: 'dashboard',
  });

  if (options['feishu-outcome'] === 'skipped' || !options['feishu-report-root']) {
    cases.push(...(await readYamlCases(skippedCasesDir)).map((name) => ({
      name,
      project: 'feishu-browser',
      status: 'skipped',
      attempts: 0,
      reportPath: null,
      previewPath: null,
      stepId: null,
    })));
  } else {
    cases.push(...await loadProjectReport({
      reportRoot: path.resolve(options['feishu-report-root']),
      projectName: 'feishu-browser',
      output,
      slug: 'feishu',
    }));
  }

  const manifest = { schemaVersion: 1, cases };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(output, 'index.html'), landingPage(cases));
  process.stdout.write(`Prepared ${cases.length} Midscene cases for publication.\n`);
  return manifest;
}

async function main() {
  await prepareMidscenePages(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
