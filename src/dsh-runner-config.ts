import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

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

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** DSH may rename the legacy file between any check and the read. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function findDefaultModels(entries: unknown, parentEnabled = true): Array<{ entry: Record<string, unknown>; enabled: boolean }> {
  if (!Array.isArray(entries) || entries.some(entry => !isRecord(entry))) {
    throw new Error('dsh --dump-config: expected a literal YAML entry list');
  }
  return entries.flatMap(entry => {
    const enabled = parentEnabled && (entry.disabled == null || entry.disabled === false);
    const matches = entry.id === 'agent-default-model' ? [{ entry, enabled }] : [];
    // Only group configs contain plugin entries; other plugins may own arbitrary arrays.
    if (entry.group === true || entry.name === 'cordis:group' || entry.name === '@deepseek-ai/cordis-plugin-group') {
      matches.push(...findDefaultModels(entry.config ?? [], enabled));
    }
    return matches;
  });
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
  const result = spawnSync(options.dshBin, [...options.launchArgs, '--dump-config'], {
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
    // The child's output stays hidden; the exact query lets the operator see it locally.
    const command = [
      ...(options.env.DSH_HOME?.trim() ? [`DSH_HOME=${shellQuote(options.dshHome)}`] : []),
      ...[options.dshBin, ...options.launchArgs, '--dump-config'].map(shellQuote),
    ].join(' ');
    throw new Error(`dsh --dump-config failed (${reason}); run this to see the error: ${command}`);
  }

  const entries = readConfigYaml(result.stdout, '--dump-config');
  const defaults = findDefaultModels(entries);
  if (defaults.length > 1) throw new Error('dsh --dump-config: duplicate agent-default-model entries');

  let selection: DshModelSelection = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    providerSource: 'default', modelSource: 'default',
  };
  if (defaults.length === 1) {
    const { entry, enabled } = defaults[0];
    if (!enabled) {
      throw new Error('dsh --dump-config: agent-default-model or its group is disabled or has a dynamic enabled state');
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
  }
  // Preserve the legacy file's explicit choices while it exists. Old DSH reads
  // them at runtime; new DSH imports them during boot, after --dump-config.
  // Once DSH renames the file to .imported, only the composed profile applies.
  const legacyText = readIfPresent(join(options.dshHome, 'settings.yaml'));
  if (legacyText !== undefined) {
    const settings = readConfigYaml(legacyText, 'settings.yaml') ?? {};
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
  if (options.model?.trim()) {
    selection.model = options.model.trim();
    selection.modelSource = '--model';
  }
  return selection;
}
