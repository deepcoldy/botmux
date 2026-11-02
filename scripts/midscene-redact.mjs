// Keeps the Midscene model configuration and the Feishu tenant address out of
// what the Midscene workflow publishes or uploads: the raw test data artifacts,
// the report site (deepcoldy.github.io), the run summary, and — because the
// failure comments are built from the site manifest — the comments on merged
// pull requests.
//
// GitHub masks secrets in job logs only. Midscene writes the model name into
// its error messages ("failed to call AI model service (<model name>): 429 …")
// and into the report dumps; the Feishu cases put the page URL, on the tenant
// host of FEISHU_TEST_GROUP_URL, into theirs ("… (URL: https://<tenant>/next/
// messenger/ …)"). Both reached public pull request comments. The base URL and
// the API key are masked the same way in case a message ever carries them.
//
// As a command, masks the given directories in place (the raw data, before it
// is uploaded): node scripts/midscene-redact.mjs <dir>...

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REDACTED = '***';

// A value this short could match unrelated text (a word, a version), and
// replacing it would corrupt the report rather than protect anything.
const MIN_SECRET_LENGTH = 4;
// A misconfigured value that is a JSON literal or a number would rewrite the
// JSON structure itself ({"ok":true} → {"ok":***}).
const JSON_LITERAL = /^(?:null|true|false|undefined|nan|infinity|-?\d+(?:\.\d+)?)$/i;

// Data files the reports and results are made of. Code files (.js, .css) are
// never touched: a short value can also be an identifier there.
const TEXT_FILE = /\.(?:html?|json|txt|md|log|csv|xml|svg)$/i;
const HTML_FILE = /\.html?$/i;

// Inside a report page, the viewer's own code — a <script> without a data
// type, or a <style> — is left as it is. A short model name such as "gemini"
// or "mini" also occurs in the bundle's identifiers, strings and class names,
// and masking those breaks the page. The data the page shows (the
// midscene_*_dump blocks, comments, text) is masked like any other text.
// The model family (MIDSCENE_MODEL_FAMILY) is deliberately not masked: it is a
// generic adapter name ("… mode") that the bundle also uses as an identifier.
const CODE_BLOCK = /<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi;

function isCodeBlock(tag, attributes) {
  if (tag.toLowerCase() === 'style') return true;
  const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]?.trim().toLowerCase() ?? '';
  return type === '' || type === 'module' || /javascript|ecmascript/.test(type);
}

/** Mask a report page, keeping the viewer's code blocks intact. */
export function redactHtml(html, redact) {
  let result = '';
  let last = 0;
  for (const match of html.matchAll(CODE_BLOCK)) {
    if (!isCodeBlock(match[1], match[2])) continue;
    result += redact(html.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + redact(html.slice(last));
}

/** The configured values to mask, longest first. */
export function secretValues(env) {
  const values = new Set();
  const add = (value) => {
    const text = String(value ?? '').trim();
    if (text.length >= MIN_SECRET_LENGTH && !JSON_LITERAL.test(text)) values.add(text);
  };
  add(env.MIDSCENE_MODEL_NAME);
  add(env.MIDSCENE_MODEL_API_KEY);
  // The Feishu test group URL: its host is the tenant address every Feishu
  // page URL in the cases' messages is on.
  for (const configured of [env.MIDSCENE_MODEL_BASE_URL, env.FEISHU_TEST_GROUP_URL]) {
    const value = String(configured ?? '').trim();
    if (!value) continue;
    add(value.replace(/\/+$/, ''));
    try {
      const url = new URL(value);
      add(url.origin);
      add(url.host);
    } catch {
      // Not a URL: the whole value above is all there is to mask.
    }
  }
  // Longest first, so a URL is replaced whole before its host is.
  return [...values].sort((left, right) => right.length - left.length);
}

/** A function masking every value in text, including JSON-escaped slashes. */
export function createRedactor(values) {
  const needles = values.flatMap((value) => (value.includes('/') ? [value, value.replaceAll('/', '\\/')] : [value]));
  return (text) => needles.reduce((result, needle) => result.split(needle).join(REDACTED), String(text));
}

/**
 * Mask the values in every text file under root. Files are only rewritten
 * when they contain one, and are searched as bytes first so report files of
 * tens of megabytes are not decoded for nothing.
 * @returns {Promise<string[]>} the rewritten files, relative to root
 */
export async function redactTree(root, values) {
  if (values.length === 0) return [];
  const redact = createRedactor(values);
  const needles = values
    .flatMap((value) => (value.includes('/') ? [value, value.replaceAll('/', '\\/')] : [value]))
    .map((value) => Buffer.from(value));
  const rewritten = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
      const bytes = await readFile(file);
      if (!needles.some((needle) => bytes.includes(needle))) continue;
      const text = bytes.toString('utf8');
      const masked = HTML_FILE.test(entry.name) ? redactHtml(text, redact) : redact(text);
      if (masked === text) continue; // the value only occurs in the viewer's code
      await writeFile(file, masked);
      rewritten.push(path.relative(root, file));
    }
  }
  await visit(root);
  return rewritten;
}

async function main(directories) {
  const values = secretValues(process.env);
  if (values.length === 0) {
    process.stdout.write('No Midscene model or Feishu test configuration to mask.\n');
    return;
  }
  let total = 0;
  for (const directory of directories) {
    try {
      total += (await redactTree(path.resolve(directory), values)).length;
    } catch (error) {
      if (error?.code === 'ENOENT') continue; // a suite that produced no data
      throw error;
    }
  }
  process.stdout.write(`Masked the Midscene model and Feishu test configuration in ${total} file(s).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
