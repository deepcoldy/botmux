import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { locateExecutable } from '../utils/executable.js';

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
export async function prepareZcodeSessionModel(opts: ZcodeModelPreparationOptions): Promise<Record<string, string>> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.sessionId)) throw new Error('Invalid ZCode botmux session identity');
  const bun = opts.env.BOTMUX_ZCODE_BUN?.trim() || locateExecutable('bun') || join(homedir(), '.bun', 'bin', 'bun');
  const helper = opts.helperPath ?? opts.env.BOTMUX_ZCODE_PROVIDER_HELPER?.trim() ?? join(homedir(), '.botmux', 'bin', 'zcode-provider-helper.mjs');
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
