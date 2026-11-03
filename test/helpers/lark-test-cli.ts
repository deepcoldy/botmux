import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { findRealToolBinary } from '../../src/core/cli-identity.js';

/** Test-only selection. Never teach the production identity resolver to bypass a host policy wrapper. */
export function resolveLarkTestCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.BOTMUX_TEST_LARK_CLI;
  if (explicit !== undefined && (!isAbsolute(explicit) || /[\x00-\x1f]/.test(explicit))) {
    throw new Error('BOTMUX_TEST_LARK_CLI must name an absolute native executable');
  }
  const candidate = explicit ?? findRealToolBinary('lark-cli', env.PATH);
  if (!candidate) {
    if (env.BOTMUX_TEST_REQUIRE_LARK_CLI === '1') throw new Error('real lark-cli contract is required');
    return null;
  }
  const path = realpathSync(candidate);
  accessSync(path, constants.X_OK);
  if (!statSync(path).isFile()) throw new Error('lark-cli contract needs a native executable file');
  const fd = openSync(path, 'r'); const header = Buffer.alloc(4);
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  // ELF, PE, Mach-O (both endiannesses) and universal Mach-O. A shell/Node/Python entry is not the native CLI contract.
  if (!['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))
      && header.subarray(0, 2).toString() !== 'MZ') {
    throw new Error('lark-cli contract needs a native executable; PATH selected a wrapper. Set BOTMUX_TEST_LARK_CLI explicitly.');
  }
  if (env.BOTMUX_TEST_LARK_CLI_SHA256
      && createHash('sha256').update(readFileSync(path)).digest('hex') !== env.BOTMUX_TEST_LARK_CLI_SHA256) {
    throw new Error('lark-cli executable changed after preflight');
  }
  return path;
}
