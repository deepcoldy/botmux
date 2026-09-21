#!/usr/bin/env node

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const reportRoot = required(options, 'report-root');
  const output = required(options, 'output');
  const reports = await findReportIndexes(reportRoot);
  if (reports.length === 0) {
    throw new Error(`No Midscene Test index.html found below ${reportRoot}`);
  }

  await mkdir(output, { recursive: true });
  await cp(path.dirname(reports[0].file), output, { recursive: true });
  process.stdout.write(`Prepared ${reports[0].file} for GitHub Pages.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
