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

let pendingLabel: VideoLabel | null = null;

/** Remember which Midscene case owns the next browser context recording. */
export function setE2EVideoLabel(caseName: string, fileStem: string): void {
  pendingLabel = { caseName, fileStem };
}

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
  const manifestPath = path.join(E2E_VIDEO_DIR, MANIFEST);
  let manifest: Record<string, string> = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, string>;
  } catch {
    manifest = {};
  }
  manifest[caseName] = `${fileStem}.webm`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function publishLabeledPageVideo(page: Page | undefined): Promise<void> {
  const label = pendingLabel;
  pendingLabel = null;
  if (!label || !page) return;
  await publishPageVideo(page, label.caseName, label.fileStem);
}
