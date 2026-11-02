// Keeps the Midscene model configuration out of what the Midscene workflow
// publishes: the report site (deepcoldy.github.io), the run summary, and —
// because the failure comments are built from the site manifest — the
// comments on merged pull requests.
//
// GitHub masks secrets in job logs only. Midscene writes the model name into
// its error messages ("failed to call AI model service (<model name>): 429 …")
// and into the report dumps, so the name reached a public pull request comment
// (#2661) and the published reports. The base URL and the API key are masked
// the same way in case a message ever carries them.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const REDACTED = '***';

// A value this short could match unrelated text (a word, a version), and
// replacing it would corrupt the report rather than protect anything.
const MIN_SECRET_LENGTH = 4;

// Text the site carries; screenshots, previews and videos are left alone.
const TEXT_FILE = /\.(?:html?|json|m?js|css|txt|md|log|csv|xml|svg)$/i;

/** The configured values to mask, longest first. */
export function secretValues(env) {
  const values = new Set();
  const add = (value) => {
    const text = String(value ?? '').trim();
    if (text.length >= MIN_SECRET_LENGTH) values.add(text);
  };
  add(env.MIDSCENE_MODEL_NAME);
  add(env.MIDSCENE_MODEL_API_KEY);
  const baseUrl = String(env.MIDSCENE_MODEL_BASE_URL ?? '').trim();
  if (baseUrl) {
    add(baseUrl.replace(/\/+$/, ''));
    try {
      const url = new URL(baseUrl);
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
      await writeFile(file, redact(bytes.toString('utf8')));
      rewritten.push(path.relative(root, file));
    }
  }
  await visit(root);
  return rewritten;
}
