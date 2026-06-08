/**
 * Import a markdown string as a Feishu Docx document via lark-cli.
 *
 * Uses `lark-cli drive +import` which handles the multipart upload +
 * import task + polling in a single CLI invocation. Much simpler than
 * the SDK/curl approach.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB limit for .md import

interface ImportResult {
  ok: boolean;
  docUrl?: string;
  docTitle?: string;
  error?: string;
}

/** Check whether `lark-cli` is available in PATH. Cached so we only probe once. */
let larkCliAvailable: boolean | null = null;
function checkLarkCli(): boolean {
  if (larkCliAvailable !== null) return larkCliAvailable;
  try {
    const { execSync } = require('node:child_process');
    execSync('lark-cli --version', { stdio: 'ignore', timeout: 5000 });
    larkCliAvailable = true;
  } catch {
    larkCliAvailable = false;
  }
  return larkCliAvailable;
}

/** Run lark-cli asynchronously so the event loop stays unblocked. */
function execLarkCli(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Import markdown content as a Feishu Docx document.
 * Returns the document URL on success.
 */
export async function importMarkdownAsDoc(
  _larkAppId: string,
  markdown: string,
  title: string,
): Promise<ImportResult> {
  if (!checkLarkCli()) {
    return { ok: false, error: 'lark-cli 未安装，无法导入飞书文档。请运行 npx @larksuite/cli@latest install' };
  }

  const buf = Buffer.from(markdown, 'utf-8');
  if (buf.length > MAX_FILE_BYTES) {
    return { ok: false, error: '内容超过 20 MB，无法导入为飞书文档' };
  }

  const tmpName = `botmux-import-${randomBytes(6).toString('hex')}.md`;
  const tmpPath = join(config.session.dataDir, 'tmp', tmpName);
  const tmpDir = join(config.session.dataDir, 'tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  try {
    writeFileSync(tmpPath, markdown, 'utf-8');

    const result = await execLarkCli(
      `cd '${tmpDir}' && lark-cli drive +import --file './${tmpName}' --type docx --name '${title.replace(/'/g, "'\\''")}' --json`,
    );

    const json: any = JSON.parse(result.trim());
    if (!json?.ok) {
      const msg = json?.error?.message ?? 'unknown error';
      logger.error(`[doc-import] lark-cli import failed: ${msg}`);
      return { ok: false, error: msg };
    }

    const docUrl: string | undefined = json?.data?.url;
    const docTitle: string | undefined = json?.data?.job_error_msg === 'success' ? title : undefined;
    if (!docUrl) {
      logger.error(`[doc-import] lark-cli import returned no url: ${JSON.stringify(json?.data)}`);
      return { ok: false, error: '导入成功但未返回文档链接' };
    }

    logger.info(`[doc-import] Imported markdown → ${docUrl} (title: ${docTitle ?? title})`);
    return { ok: true, docUrl, docTitle: docTitle ?? title };
  } catch (err: any) {
    logger.error(`[doc-import] Import failed: ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? '导入失败' };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
