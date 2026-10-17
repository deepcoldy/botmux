#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  attemptResultCases,
  feishuLaneProject,
  isFeishuLaneProject,
  reportCases,
  selectFeishuLaneFiles,
  testRunDump,
} from './midscene-report-evidence.mjs';

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

async function findReportFiles(root) {
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
      else if (entry.isFile() && (
        entry.name === 'index.html' ||
        /^midscene-e2e-.*\.html$/.test(entry.name)
      )) {
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

async function readYamlCases(root, selection) {
  const files = await findFiles(root, (name) => /\.ya?ml$/i.test(name));
  const cases = [];
  for (const file of selectFeishuLaneFiles(files.sort(), selection)) {
    const document = parseYaml(await readFile(file, 'utf8'));
    for (const testCase of document?.cases ?? []) {
      if (typeof testCase?.name === 'string') {
        cases.push({ name: testCase.name, project: feishuLaneProject(file) });
      }
    }
  }
  return cases;
}

async function copyReportCandidate(candidate, { output, slug, nested = false }) {
  const destination = nested
    ? path.join(output, slug, candidate.key)
    : path.join(output, slug);
  await cp(path.dirname(candidate.file), destination, { recursive: true });
  await mkdir(path.join(output, 'previews'), { recursive: true });
  for (const testCase of candidate.cases) {
    if (!testCase.previewFile || !testCase.screenshot) continue;
    await writeFile(
      path.join(output, 'previews', testCase.previewFile),
      testCase.screenshot.bytes,
    );
  }
  return candidate.cases.map(({ screenshot, previewFile, ...testCase }) => ({
    ...testCase,
    reportPath: nested
      ? `${slug}/${candidate.key}/${path.basename(candidate.file)}`
      : `${slug}/${path.basename(candidate.file)}`,
    previewPath: previewFile ? `previews/${previewFile}` : null,
  }));
}

async function loadProjectReport({ reportRoot, projectMatches, output, slug }) {
  const candidates = [];
  for (const report of await findReportFiles(reportRoot)) {
    try {
      const html = await readFile(report.file, 'utf8');
      const run = testRunDump(html);
      const projectNames = (run?.projects ?? [])
        .map((project) => project.name)
        .filter(projectMatches);
      if (projectNames.length === 0) continue;
      const cases = await reportCases(run, projectNames, { html, reportFile: report.file });
      if (cases.length > 0) {
        candidates.push({
          ...report,
          cases,
          key: `run-${String(candidates.length + 1).padStart(3, '0')}`,
        });
      }
    } catch (error) {
      process.stderr.write(`Ignoring unreadable Midscene report ${report.file}: ${error.message}\n`);
    }
  }
  if (candidates.length === 0) return [];

  candidates.sort((left, right) =>
    right.cases.length - left.cases.length || right.modifiedAt - left.modifiedAt,
  );
  const aggregate = candidates[0];
  if (aggregate.cases.length > 1 || candidates.length === 1) {
    return copyReportCandidate(aggregate, { output, slug });
  }

  const cases = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const copied = await copyReportCandidate(candidate, { output, slug, nested: true });
    for (const testCase of copied) {
      const key = `${testCase.project}\0${testCase.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push(testCase);
    }
  }
  return cases;
}

function caseTarget(testCase) {
  if (!testCase.reportPath) return null;
  return testCase.stepId
    ? `${testCase.reportPath}#${new URLSearchParams({ 'runner-step': testCase.stepId })}`
    : testCase.reportPath;
}

function replayCell(testCase, videosByCase) {
  const src = videosByCase[testCase.name];
  if (!src && testCase.status === 'success' && videosByCase[KEPT_IN_ARTIFACT]?.has(testCase.name)) {
    return '<span class="unavailable">Passed — recording kept in the run artifact</span>';
  }
  if (!src) return '<span class="unavailable">Not available</span>';
  return `<video controls preload="metadata" src="${escapeHtml(src)}"></video>`;
}

// Recordings of passed cases stay in the run artifact. A full Feishu run
// records ~1 GB, which made the Pages site too large to publish and grew the
// gh-pages repository with every run; a replay matters for a failure.
const KEPT_IN_ARTIFACT = Symbol('kept-in-artifact');

async function videoSources(videosDir, output, publishable) {
  if (!videosDir) return {};
  const root = path.resolve(videosDir);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return {};
  const sources = {};
  await mkdir(path.join(output, 'videos'), { recursive: true });
  const kept = new Set();
  sources[KEPT_IN_ARTIFACT] = kept;
  for (const [caseName, fileName] of Object.entries(manifest)) {
    if (typeof fileName !== 'string') continue;
    if (!publishable(caseName)) {
      kept.add(caseName);
      continue;
    }
    const base = path.basename(fileName);
    if (base !== fileName || !base.endsWith('.webm')) continue;
    const source = path.join(root, base);
    try {
      const info = await stat(source);
      if (!info.isFile()) continue;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await cp(source, path.join(output, 'videos', base));
    sources[caseName] = `videos/${base}`;
  }
  return sources;
}

function landingPage(cases, videosByCase) {
  const passed = cases.filter((testCase) => testCase.status === 'success').length;
  const failed = cases.filter((testCase) => testCase.status === 'failed').length;
  const skipped = cases.filter((testCase) => testCase.status === 'skipped').length;
  const notRun = cases.filter((testCase) => testCase.status === 'not-run').length;
  const rows = cases.map((testCase) => {
    const icon = testCase.status === 'success'
      ? '✅'
      : testCase.status === 'skipped'
        ? '⏭️'
        : testCase.status === 'not-run'
          ? '⏸️'
          : '❌';
    const target = caseTarget(testCase);
    const name = target
      ? `<a href="${escapeHtml(target)}">${escapeHtml(testCase.name)}</a>`
      : escapeHtml(testCase.name);
    const preview = testCase.previewPath && target
      ? `<a href="${escapeHtml(target)}"><img src="${escapeHtml(testCase.previewPath)}" alt="${escapeHtml(testCase.name)} screenshot" loading="lazy"></a>`
      : '<span class="unavailable">Not available</span>';
    const replay = replayCell(testCase, videosByCase);
    const failure = testCase.failure
      ? `<div class="failure">${escapeHtml(testCase.failure)}</div>`
      : '';
    return `<tr><td>${icon}</td><td>${name}${failure}</td><td>${escapeHtml(testCase.project)}</td><td>${escapeHtml(testCase.status)}</td><td>${formatDuration(testCase.durationMs)}</td><td>${preview}</td><td>${replay}</td></tr>`;
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
    .failure { margin-top: 6px; max-width: 420px; color: #ff9b9b; font-size: 13px; }
    a { color: #a99bff; }
    table { width: 100%; border-collapse: collapse; background: #131722; border: 1px solid #2b3142; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #2b3142; text-align: left; vertical-align: top; }
    th { color: #aeb4c6; font-size: 13px; text-transform: uppercase; }
    img, video { width: 260px; max-height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid #343b50; background: #000; }
  </style>
</head>
<body><main>
  <h1>Botmux × Midscene</h1>
  <p class="summary"><strong>${passed}/${cases.length} cases passed</strong> · ${failed} failed · ${skipped} skipped · ${notRun} not run</p>
  <table>
    <thead><tr><th></th><th>Case</th><th>Project</th><th>Status</th><th>Duration</th><th>Node screenshot</th><th>Replay</th></tr></thead>
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
    projectMatches: (name) => name === 'dashboard-smoke',
    output,
    slug: 'dashboard',
  });

  // Only the lanes this run selected; unselected lanes are not "not run".
  const configuredFeishuCases = await readYamlCases(skippedCasesDir, options['feishu-cases'] ?? 'all');
  if (options['feishu-outcome'] === 'skipped' || !options['feishu-report-root']) {
    cases.push(...configuredFeishuCases.map(({ name, project }) => ({
      name,
      project,
      status: 'skipped',
      attempts: 0,
      reportPath: null,
      previewPath: null,
      stepId: null,
    })));
  } else {
    const reportedCases = await loadProjectReport({
      reportRoot: path.resolve(options['feishu-report-root']),
      projectMatches: isFeishuLaneProject,
      output,
      slug: 'feishu',
    });
    cases.push(...reportedCases);
    const reportedNames = new Set(reportedCases.map((testCase) => testCase.name));
    // A run killed at its time limit never writes the HTML report; recover the
    // cases that finished from their per-attempt result files.
    if (options['feishu-results-root']) {
      const configuredNames = new Set(configuredFeishuCases.map(({ name }) => name));
      for (const testCase of await attemptResultCases(
        path.resolve(options['feishu-results-root']),
        isFeishuLaneProject,
      )) {
        if (reportedNames.has(testCase.name) || !configuredNames.has(testCase.name)) continue;
        reportedNames.add(testCase.name);
        cases.push(testCase);
      }
      const order = new Map(configuredFeishuCases.map(({ name }, index) => [name, index]));
      cases.sort((left, right) => (order.get(left.name) ?? -1) - (order.get(right.name) ?? -1));
    }
    cases.push(...configuredFeishuCases
      .filter(({ name }) => !reportedNames.has(name))
      .map(({ name, project }) => ({
        name,
        project,
        status: 'not-run',
        attempts: 0,
        reportPath: null,
        previewPath: null,
        stepId: null,
      })));
  }

  const passed = new Set(cases.filter((testCase) => testCase.status === 'success').map((testCase) => testCase.name));
  const videosByCase = await videoSources(options['videos-dir'], output, (name) => !passed.has(name));
  const manifest = { schemaVersion: 1, cases };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(output, 'index.html'), landingPage(cases, videosByCase));
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
