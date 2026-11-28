import type { CliId } from '../../adapters/cli/types.js';
import { readGlobalConfig } from '../../global-config.js';
import { readSkillRegistry } from '../../services/skill-registry-store.js';
import { readSkillPackRegistry } from '../../services/skill-pack-store.js';
import type { BotSkillPolicy, SessionSkillManifest, SkillPackage } from './types.js';
import { discoverProjectSkills } from './discovery.js';
import { writeSessionSkillManifest } from './manifest-store.js';
import {
  removeSessionSkillRuntime,
  snapshotSessionSkills,
  type SkillSnapshotLimits,
  type SkillSnapshotTrust,
} from './snapshot.js';
import { renderSkillCatalogBlock } from './prompt.js';
import { resolveSessionSkillManifest } from './session-resolver.js';
import { filterAvailableSessionSkills, type UnavailableSkillEntry } from './source-health.js';

export interface PreparedSessionSkillPrompt {
  prompt: string;
  manifest: SessionSkillManifest | null;
  /** Snapshot refusals / limit hits / skipped entries, for the worker log. */
  snapshotDiagnostics?: string[];
  /** Skills skipped during preflight because their source directory/entrypoint was unavailable. */
  unavailableSkills?: UnavailableSkillEntry[];
  /** Human-readable lines for unavailable skills skipped during preflight. */
  sourceDiagnostics?: string[];
}

export function prepareSessionSkillPrompt(opts: {
  sessionId: string;
  cliId: CliId;
  workingDir: string;
  prompt: string;
  botPolicy: BotSkillPolicy | undefined;
  pluginSkills?: SkillPackage[];
  /** Test overrides; production uses the live botmux layout (snapshot.ts). */
  snapshotTrust?: SkillSnapshotTrust;
  snapshotLimits?: SkillSnapshotLimits;
}): PreparedSessionSkillPrompt {
  if (!opts.botPolicy && !opts.pluginSkills?.length) {
    removeSessionSkillRuntime(opts.sessionId);
    return { prompt: opts.prompt, manifest: null };
  }
  const globalSkills = readGlobalConfig().skills;
  const manifest = resolveSessionSkillManifest({
    sessionId: opts.sessionId,
    cliId: opts.cliId,
    workingDir: opts.workingDir,
    botPolicy: opts.botPolicy,
    pluginSkills: opts.pluginSkills,
    globalProjectSkills: globalSkills?.trustProjectSkills,
    globalDelivery: globalSkills?.delivery,
    registrySkills: Object.values(readSkillRegistry().skills),
    projectSkills: discoverProjectSkills(opts.workingDir),
    packs: readSkillPackRegistry().packs,
  });
  if (!manifest || manifest.prioritySkills.length === 0) {
    removeSessionSkillRuntime(opts.sessionId);
    return { prompt: opts.prompt, manifest };
  }
  const preflight = filterAvailableSessionSkills(manifest);
  if (preflight.availableSkills.length === 0) {
    removeSessionSkillRuntime(opts.sessionId);
    return {
      prompt: opts.prompt,
      manifest: preflight.manifest,
      unavailableSkills: preflight.unavailableSkills,
      sourceDiagnostics: preflight.diagnostics,
    };
  }
  // Freeze the enabled botmux-MANAGED skills (store / plugin bundles) into
  // this session's own runtime dir and point the manifest there (snapshot.ts):
  // that is what the file sandbox exposes. Linked / external skills keep their
  // own path — readable wherever the CLI can already read it, unavailable in
  // the file sandbox (`botmux skill show` explains). The catalog is unchanged.
  const snapshot = snapshotSessionSkills(preflight.manifest, {
    trust: opts.snapshotTrust,
    limits: opts.snapshotLimits,
  });
  const manifestOut = snapshot.manifest;
  writeSessionSkillManifest(manifestOut);
  const extra = {
    snapshotDiagnostics: snapshot.diagnostics,
    ...(preflight.unavailableSkills.length > 0 ? { unavailableSkills: preflight.unavailableSkills } : {}),
    ...(preflight.diagnostics.length > 0 ? { sourceDiagnostics: preflight.diagnostics } : {}),
  };
  if (opts.prompt.trim().length === 0 || opts.prompt.includes('<botmux_skills')) {
    return { prompt: opts.prompt, manifest: manifestOut, ...extra };
  }
  return {
    prompt: `${opts.prompt}\n\n${renderSkillCatalogBlock(manifestOut)}`,
    manifest: manifestOut,
    ...extra,
  };
}
