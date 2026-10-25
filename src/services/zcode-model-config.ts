import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { locateExecutable } from '../utils/executable.js';
import { ZCODE_PROVIDER_HELPER_SOURCE } from './zcode-provider-helper-data.js';

export interface ZcodeModelPreparationOptions {
  sessionId: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  reasoningEffort?: string;
  resume: boolean;
  helperPath?: string;
}

/** Prepare an isolated provider config using ZCode's own installed codec.
 * The existing TUI/session DB remains shared; successful resume retains its
 * saved selection. Configuration errors abort launch and never silently fall back. */
/** Default location the bridge is materialised into. */
export function defaultZcodeHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOTMUX_ZCODE_PROVIDER_HELPER?.trim()
    || join(homedir(), '.botmux', 'bin', 'zcode-provider-helper.mjs');
}

/**
 * Materialise the bridge from the embedded source.
 *
 * The bridge used to be shipped as a repo script and invoked from
 * `~/.botmux/bin/`, but nothing ever wrote it there: tsc does not copy `.mjs`
 * into dist, the npm `files` whitelist excludes it, and the compiled binary only
 * embeds imported modules. Every ordinary install therefore hit ENOENT inside a
 * fail-closed path and could not start a ZCode topic at all.
 *
 * Idempotent: only rewrites when the bytes differ, so a warm daemon spawn costs
 * one read. Mode 0600 — it is a local script, not a shared executable.
 */
export function ensureZcodeProviderHelper(helperPath = defaultZcodeHelperPath()): string {
  try {
    if (existsSync(helperPath) && readFileSync(helperPath, 'utf8') === ZCODE_PROVIDER_HELPER_SOURCE) return helperPath;
  } catch { /* fall through and rewrite */ }
  mkdirSync(join(helperPath, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(helperPath, ZCODE_PROVIDER_HELPER_SOURCE, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(helperPath, 0o600); } catch { /* best effort on odd filesystems */ }
  return helperPath;
}

export async function prepareZcodeSessionModel(opts: ZcodeModelPreparationOptions): Promise<Record<string, string>> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.sessionId)) throw new Error('Invalid ZCode botmux session identity');
  const bun = opts.env.BOTMUX_ZCODE_BUN?.trim() || locateExecutable('bun') || join(homedir(), '.bun', 'bin', 'bun');
  const helper = opts.helperPath ?? ensureZcodeProviderHelper(defaultZcodeHelperPath(opts.env));

  // The bridge validates against ZCode's OWN schema, so it needs that source
  // tree plus bun to import its TypeScript. Neither ships with botmux nor with
  // an ordinary ZCode install. DEGRADE, DO NOT FAIL: refusing here meant NO
  // ZCode topic could start on a clean machine. Returning no env override lets
  // ZCode launch with the provider/model the user already picked in its own UI;
  // the only loss is botmux's per-topic model override, which is not a startup
  // dependency. A misconfigured selection is still loud in the log.
  const source = opts.env.BOTMUX_ZCODE_SOURCE_DIR?.trim() || join(homedir(), 'zcode-src');
  const haveCodec = existsSync(join(source, 'packages/provider-node/src/index.ts'));
  if (!haveCodec || !existsSync(bun)) {
    const missing = !haveCodec
      ? `ZCode source tree (looked for ${join(source, 'packages/provider-node/src/index.ts')}; set BOTMUX_ZCODE_SOURCE_DIR)`
      : `bun (looked for ${bun}; set BOTMUX_ZCODE_BUN)`;
    console.log(
      `[zcode] 未找到 ${missing}，跳过每话题模型覆盖，改用 ZCode 自己保存的模型选择`
      + (opts.model ? `（本会话请求的 ${opts.model} 不会生效）` : ''),
    );
    return {};
  }
  const input = JSON.stringify({ sessionId: opts.sessionId, dataDir: resolve(opts.dataDir), env: opts.env,
    model: opts.model, reasoningEffort: opts.reasoningEffort, resume: opts.resume });
  const response = await new Promise<string>((resolveResult, reject) => {
    const child = execFile(bun, [helper], {
      env: opts.env, timeout: 20_000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const safe = stderr.trim().split('\n').find(line => /^(Invalid session identity|Select a default ZCode model|ZCode provider\/model|ZCode model has no supported|Invalid ZCode model selection:|ZCode provider configuration could not)/.test(line));
        reject(new Error(safe ?? 'ZCode model preparation failed; verify the installed provider bridge'));
      } else resolveResult(stdout);
    });
    child.stdin?.on('error', () => { /* execFile reports the authoritative exit */ });
    child.stdin?.end(input);
  });
  const parsed = JSON.parse(response) as { env?: Record<string, unknown>; adjustment?: { requested?: string; applied?: string } };
  if (parsed.adjustment?.applied) {
    // Never silent: the CLI log records the downgrade, and the card shows the
    // level that actually ran (read back from ZCode's own ledger).
    console.log(`[zcode] 思考强度 ${parsed.adjustment.requested} 该模型不支持，已自动降到 ${parsed.adjustment.applied}`);
  }
  const env = parsed.env;
  const expected = join(resolve(opts.dataDir), 'zcode-runtime', opts.sessionId, 'provider_config.json');
  if (!env || env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE !== expected
    || typeof env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE !== 'string'
    || !isAbsolute(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)) throw new Error('Invalid ZCode model preparation result');
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: expected,
    BOTMUX_ZCODE_RUNTIME_DIR: join(resolve(opts.dataDir), 'zcode-runtime'),
  };
}
