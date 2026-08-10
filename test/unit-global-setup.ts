import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    unitSessionDataRoot: string;
  }
}

export default function setupUnitDataRoot(project: TestProject) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-unit-'));
  project.provide('unitSessionDataRoot', root);

  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
