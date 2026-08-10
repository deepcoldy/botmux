import { basename, resolve } from 'node:path';
import { statSync } from 'node:fs';

import {
  scanMultipleProjects,
  describeProjectDir,
  type ProjectScanOptions,
} from './project-scanner.js';
import { expandHome } from '../core/working-dir.js';

interface ScanRequest {
  kind?: 'scan';
  baseDirs: string[];
  maxDepth: number;
  options: ProjectScanOptions;
}

// Full `/repo <name|path>` resolution — candidate stat + git describe + the
// recursive basename scan — runs here in the child so none of its synchronous,
// potentially-blocking fs/git work touches the daemon event loop.
interface ResolveRequest {
  kind: 'resolve';
  repoArg: string;
  scanDirs: string[];
}

type ChildRequest = ScanRequest | ResolveRequest;

type ScanResponse =
  | { ok: true; projects: ReturnType<typeof scanMultipleProjects> }
  | { ok: false; error: string };

type ResolveResponse =
  | { ok: true; resolved: { path: string; displayName: string } | null }
  | { ok: false; error: string };

type ChildResponse = ScanResponse | ResolveResponse;

function sendResponse(response: ChildResponse): void {
  if (!process.send || !process.connected) return;
  process.send(response, () => {
    if (process.connected) process.disconnect();
  });
}

function resolveRepoSelection(
  repoArg: string,
  scanDirs: string[],
): { path: string; displayName: string } | null {
  const isExplicitPath =
    repoArg.startsWith('/') ||
    repoArg.startsWith('~') ||
    repoArg.startsWith('.') ||
    repoArg.includes('/');

  const candidates: string[] = [];
  if (repoArg.startsWith('/') || repoArg.startsWith('~')) {
    candidates.push(resolve(expandHome(repoArg)));
  } else {
    for (const d of scanDirs) candidates.push(resolve(d, repoArg));
    candidates.push(resolve(expandHome(repoArg))); // daemon-cwd fallback (matches /cd)
  }

  for (const cand of candidates) {
    try {
      if (!statSync(cand).isDirectory()) continue;
    } catch {
      continue; // missing / not a dir — try next candidate
    }
    const desc = describeProjectDir(cand);
    return desc
      ? { path: cand, displayName: `${desc.name} (${desc.branch})` }
      : { path: cand, displayName: basename(cand) };
  }

  if (isExplicitPath) return null;

  const projects = scanDirs.length > 0 ? scanMultipleProjects(scanDirs) : [];
  const byName = projects.find((p) => p.name === repoArg);
  if (byName) return { path: byName.path, displayName: `${byName.name} (${byName.branch})` };

  return null;
}

process.once('message', (request: ChildRequest) => {
  try {
    if (request.kind === 'resolve') {
      sendResponse({ ok: true, resolved: resolveRepoSelection(request.repoArg, request.scanDirs) });
      return;
    }
    sendResponse({
      ok: true,
      projects: scanMultipleProjects(request.baseDirs, request.maxDepth, request.options),
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
