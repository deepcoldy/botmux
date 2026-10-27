import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { compareVersions, parseVersion } from './utils/semver.js';

type ModelSource = 'profile' | 'settings.yaml' | 'default' | '--model';

interface DshModelSelection {
  provider: string;
  model: string;
  providerSource: ModelSource;
  modelSource: ModelSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** DSH's dump is YAML with inert !!js scalars, not executable configuration. */
function readConfigYaml(input: string, source: string): unknown {
  const doc = parseDocument(input, {
    prettyErrors: false,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    // Parser messages and child output may contain credentials from the dump.
    throw new Error(`dsh ${source}: invalid YAML (${problem.code})`);
  }
  try {
    return doc.toJS();
  } catch {
    throw new Error(`dsh ${source}: cannot resolve YAML aliases`);
  }
}

function modelField(config: Record<string, unknown>, key: 'provider' | 'model', source: string): string {
  const value = config[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`dsh ${source}: agent-default-model.${key} must be a non-empty literal string; dynamic values are unsupported`);
  }
  return value.trim();
}

/** Resolve the SDK model through DSH's own composition, using the launch context verbatim. */
export function resolveDshModel(options: {
  dshBin: string;
  launchArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  dshHome: string;
  model?: string;
}): DshModelSelection {
  const query = (argv: string[], operation: string): string => {
    const result = spawnSync(options.dshBin, argv, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      const reason = (result.error as NodeJS.ErrnoException | undefined)?.code ?? result.signal ?? `exit ${result.status}`;
      throw new Error(`dsh ${operation} failed (${reason}); check the selected profile with dsh --dump-config`);
    }
    return result.stdout;
  };

  const entries = readConfigYaml(query([...options.launchArgs, '--dump-config'], '--dump-config'), '--dump-config');
  if (!Array.isArray(entries) || entries.some(entry => !isRecord(entry))) {
    throw new Error('dsh --dump-config: expected a YAML entry list');
  }
  const defaults = entries.filter(entry => entry.id === 'agent-default-model');
  if (defaults.length > 1) throw new Error('dsh --dump-config: duplicate agent-default-model entries');

  const settingsPath = join(options.dshHome, 'settings.yaml');
  const hasLegacySettings = existsSync(settingsPath);
  let useLegacySettings = defaults.length === 0;
  if (defaults.length === 1 && hasLegacySettings) {
    // Before 0.1.7-alpha.1 the same plugin row existed, but settings.yaml
    // overrode it at runtime. Only this ambiguous overlap needs a version query.
    const version = query(['--version'], '--version').trim();
    if (!parseVersion(version)) throw new Error('dsh --version: unrecognized version; cannot select the settings format');
    useLegacySettings = compareVersions(version, '0.1.7-alpha.1') < 0;
  }

  let selection: DshModelSelection;
  if (!useLegacySettings) {
    const entry = defaults[0];
    if (entry.disabled != null && entry.disabled !== false) {
      throw new Error('dsh --dump-config: agent-default-model is disabled or has a dynamic enabled state');
    }
    if (!isRecord(entry.config) || typeof entry.config.__jsExpr === 'string') {
      throw new Error('dsh --dump-config: agent-default-model.config must be a literal mapping');
    }
    selection = {
      provider: modelField(entry.config, 'provider', '--dump-config'),
      model: modelField(entry.config, 'model', '--dump-config'),
      providerSource: 'profile',
      modelSource: 'profile',
    };
  } else {
    // Older DSH versions keep model preferences outside the composed tree.
    selection = {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
      providerSource: 'default', modelSource: 'default',
    };
    if (hasLegacySettings) {
      const settings = readConfigYaml(readFileSync(settingsPath, 'utf8'), 'settings.yaml');
      if (!isRecord(settings)) throw new Error('dsh settings.yaml: expected a mapping');
      const legacy = settings['agent-default-model'];
      if (legacy !== undefined) {
        if (!isRecord(legacy)) throw new Error('dsh settings.yaml: agent-default-model must be a literal mapping');
        for (const key of ['provider', 'model'] as const) {
          if (legacy[key] === undefined) continue;
          selection[key] = modelField(legacy, key, 'settings.yaml');
          selection[key === 'provider' ? 'providerSource' : 'modelSource'] = 'settings.yaml';
        }
      }
    }
  }
  if (options.model?.trim()) {
    selection.model = options.model.trim();
    selection.modelSource = '--model';
  }
  return selection;
}
