import { AsyncLocalStorage } from 'node:async_hooks';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

/** Playwright WebM files for one Midscene run. Gitignored via `midscene_run/`. */
export const E2E_VIDEO_DIR = path.join(PROJECT_ROOT, 'test/e2e-browser/midscene_run/videos');

const MANIFEST = 'manifest.json';

export function e2eVideoRecordingEnabled(): boolean {
  return process.env.BOTMUX_E2E_RECORD_VIDEO === '1';
}

interface VideoLabel {
  caseName: string;
  fileStem: string;
}

// Lanes run concurrently in one process, so the label travels with the async
// call chain of its own case instead of living in a shared variable.
const caseLabel = new AsyncLocalStorage<VideoLabel>();

/** Run one case body so the browser context it records publishes under this case. */
export function runWithE2EVideoLabel<T>(
  caseName: string,
  fileStem: string,
  run: () => Promise<T>,
): Promise<T> {
  return caseLabel.run({ caseName, fileStem }, run);
}

// Concurrent cases share manifest.json; serialize its read-modify-write.
let manifestQueue: Promise<void> = Promise.resolve();

/**
 * After `context.close()`, move Playwright's random WebM to a stable name and
 * record the case name in `manifest.json` so the Pages index can embed it.
 */
export async function publishPageVideo(
  page: Page,
  caseName: string,
  fileStem: string,
): Promise<void> {
  const video = page.video();
  if (!video) return;
  const recorded = await video.path();
  await mkdir(E2E_VIDEO_DIR, { recursive: true });
  const target = path.join(E2E_VIDEO_DIR, `${fileStem}.webm`);
  if (path.resolve(recorded) !== path.resolve(target)) {
    await copyFile(recorded, target);
    await rm(recorded, { force: true });
  }
  const update = manifestQueue.then(async () => {
    const manifestPath = path.join(E2E_VIDEO_DIR, MANIFEST);
    let manifest: Record<string, string> = {};
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, string>;
    } catch {
      manifest = {};
    }
    manifest[caseName] = `${fileStem}.webm`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  manifestQueue = update.catch(() => {});
  await update;
}

export async function publishLabeledPageVideo(page: Page | undefined): Promise<void> {
  const label = caseLabel.getStore();
  if (!label || !page) return;
  await publishPageVideo(page, label.caseName, label.fileStem);
}
