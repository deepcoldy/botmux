// src/core/session-row-enrichment.ts
//
// Git presentation metadata for dashboard session rows. Resolution happens in
// the central dashboard read-model (not in an HTTP request handler), so REST
// snapshots and SSE updates share one row shape.

export type GitRepoInfo = {
  /** basename of the repo top-level dir. */
  repoName: string;
  /** Current branch; null for detached HEAD. */
  branch: string | null;
};

export interface GitRepoResolveOptions {
  /** Bypass a possibly stale positive cache at a known turn boundary. */
  force?: boolean;
}
