import { scanMultipleProjects, type ProjectScanOptions } from './project-scanner.js';

interface ScanRequest {
  baseDirs: string[];
  maxDepth: number;
  options: ProjectScanOptions;
}

type ScanResponse =
  | { ok: true; projects: ReturnType<typeof scanMultipleProjects> }
  | { ok: false; error: string };

function sendResponse(response: ScanResponse): void {
  if (!process.send || !process.connected) return;
  process.send(response, () => {
    if (process.connected) process.disconnect();
  });
}

process.once('message', (request: ScanRequest) => {
  try {
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
