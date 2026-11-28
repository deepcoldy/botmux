import { cpSync } from 'node:fs';

export type SkillMaterializationCopy = (sourceDir: string, targetDir: string) => void;

let testCopy: SkillMaterializationCopy | undefined;

/** Native Claude/Pi delivery shares this seam so failure-injection tests can
 *  exercise the post-preflight TOCTOU path on both Node and Bun. */
export function copySkillDirectoryForDelivery(sourceDir: string, targetDir: string): void {
  if (testCopy) {
    testCopy(sourceDir, targetDir);
    return;
  }
  cpSync(sourceDir, targetDir, { recursive: true });
}

export function __testOnly_setSkillMaterializationCopy(copy: SkillMaterializationCopy | undefined): void {
  testCopy = copy;
}
