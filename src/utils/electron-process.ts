/** Chromium/Electron helper processes inherit the main executable's comm and
 *  often its environment, but carry an explicit `--type=gpu-process`,
 *  `--type=renderer`, `--type=utility`, … role. They do not own the agent's
 *  chat store and must not outrank the main process during identity binding.
 *  Stop at `--` so a literal user/program argument after the separator is not
 *  interpreted as an Electron process role. */
export function isElectronHelperProcessArgv(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') return false;
    if (arg.startsWith('--type=')) return true;
  }
  return false;
}
