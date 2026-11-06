// Types for the dependency-free PATH helper shared by install.sh's JS twin
// (postinstall-bin.mjs) and Botmux Desktop's native host.
export declare const PATH_ENTRY_MARKER: string;
export declare function detectShell(env?: NodeJS.ProcessEnv): 'zsh' | 'fish' | 'bash' | 'other' | 'unknown';
export interface EnsurePathEntryResult {
  shell: string;
  written: string[];
  skipped: string[];
  failed: Array<{ file: string; error: string }>;
}
export declare function ensurePathEntry(opts: {
  installDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  shell?: string;
}): EnsurePathEntryResult;
