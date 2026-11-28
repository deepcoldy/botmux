import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { snapshotBytedcliTrustedFiles } from './bytedcli-runtime-integrity.js';

export interface BytedcliTrustedPythonRuntime {
  readonly executable: string;
  readonly protectedPaths: readonly string[];
  readonly stillCurrent: () => boolean;
}
/** Fixed distro Python and standard library for the audited bundled MindAI
 * client. Never discover Agent PATH, user packages or host configuration. */
export function discoverBytedcliPythonRuntime(): BytedcliTrustedPythonRuntime | undefined {
  try {
    if (process.platform !== 'linux') return undefined;
    const alias = '/usr/bin/python3', executable = realpathSync(alias);
    const version = /^\/usr\/bin\/python(3\.(?:1[1-9]|[2-9]\d))$/.exec(executable)?.[1];
    if (!version) return undefined;
    const library = `/usr/lib/python${version}`;
    for (const path of [executable, library]) {
      const stat = statSync(path);
      if (stat.uid !== 0 || stat.mode & 0o022) return undefined;
    }
    accessSync(executable, constants.X_OK);
    const snapshot = snapshotBytedcliTrustedFiles([alias, executable, library]);
    return Object.freeze({ executable, protectedPaths: snapshot.protectedPaths, stillCurrent: () => {
      try { return realpathSync(alias) === executable && snapshot.stillCurrent(); } catch { return false; }
    } });
  } catch { return undefined; }
}
