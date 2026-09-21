#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === 'index.html') {
        matches.push({
          file: candidate,
          modifiedAt: (await stat(candidate)).mtimeMs,
        });
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

async function readSkippedCases(root) {
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

function landingPage({ passedCases, skippedCases }) {
  const rows = [
    ...passedCases.map(
      (name) => `<tr><td>✅</td><td>${escapeHtml(name)}</td><td>dashboard-smoke</td><td><strong>passed</strong></td></tr>`,
    ),
    ...skippedCases.map(
      (name) => `<tr><td>⏭️</td><td>${escapeHtml(name)}</td><td>feishu-browser</td><td>skipped</td></tr>`,
    ),
  ].join('\n');
  const total = passedCases.length + skippedCases.length;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Botmux Midscene report</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b0d13; color: #e8eaf2; }
    main { width: min(1100px, calc(100% - 40px)); margin: 48px auto; }
    h1 { margin-bottom: 8px; }
    .summary { color: #aeb4c6; margin-bottom: 28px; }
    a { color: #9d8cff; }
    table { width: 100%; border-collapse: collapse; background: #131722; border: 1px solid #2b3142; border-radius: 12px; overflow: hidden; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #2b3142; text-align: left; }
    th { color: #aeb4c6; font-size: 13px; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    .report-link { display: inline-block; margin: 0 0 24px; padding: 10px 14px; border: 1px solid #7466d9; border-radius: 8px; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>Botmux × Midscene · passed with skips</h1>
    <p class="summary"><strong>${passedCases.length}/${total} cases passed</strong> · 0 failed · ${skippedCases.length} skipped</p>
    <a class="report-link" href="dashboard/">Open the native Dashboard Midscene report</a>
    <table>
      <thead><tr><th></th><th>Case</th><th>Project</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>
`;
}

export async function prepareMidscenePages(options) {
  const reportRoot = required(options, 'report-root');
  const resultsRoot = required(options, 'results-root');
  const skippedCasesDir = required(options, 'skipped-cases-dir');
  const output = required(options, 'output');
  const reports = await findReportIndexes(reportRoot);
  if (reports.length === 0) {
    throw new Error(`No Midscene Test index.html found below ${reportRoot}`);
  }

  const summaries = await findFiles(resultsRoot, (name) => name === 'summary.json');
  if (summaries.length !== 1) {
    throw new Error(`Expected one Dashboard summary.json, found ${summaries.length}`);
  }
  const summary = JSON.parse(await readFile(summaries[0], 'utf8'));
  const passedCases = (summary.projects ?? []).flatMap((project) =>
    (project.cases ?? [])
      .filter((testCase) => testCase.status === 'success')
      .map((testCase) => testCase.name),
  );
  const skippedCases = await readSkippedCases(skippedCasesDir);
  if (passedCases.length === 0 || skippedCases.length === 0) {
    throw new Error('Pages report requires passed Dashboard and skipped Feishu cases');
  }

  await mkdir(path.join(output, 'dashboard'), { recursive: true });
  await cp(path.dirname(reports[0].file), path.join(output, 'dashboard'), {
    recursive: true,
  });
  await writeFile(
    path.join(output, 'index.html'),
    landingPage({ passedCases, skippedCases }),
  );
  process.stdout.write(`Prepared ${reports[0].file} for GitHub Pages.\n`);
}

async function main() {
  await prepareMidscenePages(parseArguments(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
