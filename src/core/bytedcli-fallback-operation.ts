import { createHash } from 'node:crypto';

/** Unknown IDs are deliberately not policy keys. Hash the complete canonical
 * argv so neither guessed effects nor an arbitrary human label grants access. */
export function bytedcliFallbackOperationId(argv: readonly string[]): string {
  return `unknown.${createHash('sha256').update(JSON.stringify(argv)).digest('hex')}`;
}
const controlWords = new Set(['auth', 'profile', 'profiles', 'self', 'plugin', 'plugins', 'upgrade', 'update-cli',
  'install', 'uninstall', 'completion', 'completions', 'mcp', 'skill', 'skills', 'credential', 'credentials', 'login', 'logout']);
const forbiddenFlags = /^(?:--(?:as|profile|auth-site|bytecloud-user-jwt-file|jwt-file|token|ak|sk|vdc|network-profile|ai-auth-.+|socks5-proxy|http-proxy|http-header|http-debug|http-print|http-trace-file|http-body-limit|http-timeout-ms|http-retry-.+|jq|nomask|no-redact|debug|tls1\.2|color|no-color|version|all-help|help)|-d|-V|-h)$/;
const credentialFlag = /^--(?:.*-)?(?:access-token|refresh-token|id-token|user-token|token-file|jwt|jwt-file|authorization|cookie|password|secret|client-secret|credential|credentials|identity|profile)(?:-.*)?$/;
export function assertBytedcliNoIdentityOverrides(argv: readonly string[], reviewedFlags: readonly string[] = []): void {
  for (const arg of argv) {
    const flag = arg.split('=', 1)[0]!;
    // -d is command-local TCC dir, handled by its closed parser; never fallback.
    if (credentialFlag.test(flag) || forbiddenFlags.test(flag) && flag !== '-d' && flag !== '--help' && !reviewedFlags.includes(flag)) throw new Error('unsupported_operation');
  }
}
export function parseBytedcliFallbackArgv(argv: readonly string[]): string[] {
  assertBytedcliNoIdentityOverrides(argv);
  const result: string[] = []; let json = false; let site = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!; const equal = arg.indexOf('='); const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (forbiddenFlags.test(flag) || /^-[A-Za-z]{2,}/.test(flag)) throw new Error('unsupported_operation');
    if (flag === '--json' || flag === '-j') { if (json || equal >= 0) throw new Error('unsupported_operation'); json = true; continue; }
    if (flag === '--no-auto-upgrade') { if (equal >= 0) throw new Error('unsupported_operation'); continue; }
    if (flag === '--site') {
      const value = equal < 0 ? argv[++index] : arg.slice(equal + 1);
      if (site || value !== 'cn') throw new Error('unsupported_operation'); site = true; continue;
    }
    if (equal >= 0 && (flag === '--file' || flag === '--body-file')) result.push(flag, arg.slice(equal + 1));
    else result.push(arg);
  }
  if (!result.length || !/^[a-z][a-z0-9-]*$/.test(result[0]!) || result[0] === 'config') throw new Error('unsupported_operation');
  // Be conservative even when options intervene between nested commands.
  for (const word of result) {
    if (controlWords.has(word) || word.startsWith('+')) throw new Error('unsupported_operation');
  }
  return [...(json ? ['--json'] : []), '--site', 'cn', ...result];
}
