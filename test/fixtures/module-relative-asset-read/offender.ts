// FIXTURE — not real code. Reproduces, verbatim in shape, the defect that shipped as
// `找不到 botmux 默认应用图标`: a module-relative base dir bound on one line, then used
// to build an asset path on another. Exists so
// `scripts/audit-embedded-assets.mjs`'s reader gate can be shown to BITE without
// mutating a real source file. Its first version required both halves on ONE line and
// therefore stayed green on exactly this shape.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveIconTheBrokenWay(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'dashboard-web', 'favicon.png'),
    join(here, '..', 'dashboard', 'web', 'favicon.png'),
  ];
  return candidates.find(existsSync);
}
