#!/usr/bin/env node

import { appendFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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
  return value;
}

async function findSummaries(root) {
  const matches = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(candidate);
        else if (entry.isFile() && entry.name === 'summary.json') {
          matches.push(candidate);
        }
      }),
    );
  }
  await visit(root);
  return matches.sort();
}

function cell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

function duration(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function renderSummary({ summary, artifactName, testOutcome, runUrl }) {
  const counts = summary?.summary;
  const cases = (summary?.projects ?? []).flatMap((project) =>
    (project.cases ?? []).map((testCase) => ({
      ...testCase,
      project: project.name,
    })),
  );
  const reportAvailable = Boolean(summary);
  const status =
    testOutcome === 'success' && summary?.status === 'success'
      ? 'passed'
      : testOutcome === 'skipped'
        ? 'live cases skipped'
        : testOutcome === 'not-run'
          ? 'not run'
          : 'failed';
  const artifactUrl = runUrl ? `${runUrl}#artifacts` : null;
  const lines = [
    `## Botmux × Midscene · ${status}`,
    '',
    reportAvailable
      ? `**${counts.passed}/${counts.total} cases passed · ${counts.failed} failed · ${counts.notRun} not run**`
      : testOutcome === 'skipped'
        ? '**Static Midscene validation passed.** Live Feishu browser cases were skipped because their repository secrets are unavailable.'
        : '**No Midscene result was produced.** The job stopped before the test runner started.',
    '',
  ];

  if (reportAvailable && artifactUrl) {
    lines.push(
      `[Download the native Midscene HTML report and runner data (${artifactName})](${artifactUrl})`,
      '',
    );
  } else if (reportAvailable) {
    lines.push(`Artifact: ${artifactName}`, '');
  }

  if (cases.length > 0) {
    lines.push(
      '| Case | Project | Status | Attempts |',
      '|:--|:--|:--|--:|',
      ...cases.map((testCase) => {
        const icon = testCase.status === 'success' ? '✅' : '❌';
        const attempts = testCase.attempts?.length ?? 0;
        return `| ${icon} ${cell(testCase.name)} | ${cell(testCase.project)} | ${cell(testCase.status)} | ${attempts} |`;
      }),
      '',
      `Run duration: ${duration(summary.durationMs)}.`,
      '',
    );
  }

  return lines.join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = required(options, 'results');
  const files = await findSummaries(results);
  const latest = files.at(-1);
  const summary = latest
    ? JSON.parse(await readFile(latest, 'utf8'))
    : null;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl =
    repository && runId
      ? `https://github.com/${repository}/actions/runs/${runId}`
      : null;
  const markdown = renderSummary({
    summary,
    artifactName: required(options, 'artifact-name'),
    testOutcome: required(options, 'test-outcome'),
    runUrl,
  });
  await appendFile(required(options, 'output'), markdown);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
