import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BundledRuntimeCandidate } from './runtime-service.js';

export interface ResolveBundledRuntimeInput {
  resourcesPath: string;
  repoRoot: string;
  isPackaged: boolean;
  arch: NodeJS.Architecture;
  appVersion: string;
  env: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
}

export function resolveBundledRuntimeCandidate(input: ResolveBundledRuntimeInput): BundledRuntimeCandidate {
  const exists = input.existsSync ?? existsSync;
  const root = input.isPackaged ? join(input.resourcesPath, 'runtime') : input.repoRoot;
  const nodePath = input.isPackaged
    ? join(input.resourcesPath, 'node', `darwin-${input.arch}`, 'bin', 'node')
    : resolveDevelopmentNode(input.env, exists);
  const cliPath = join(root, 'dist', 'cli.js');

  if (input.isPackaged && (!exists(nodePath) || !exists(cliPath))) {
    throw new Error(`Bundled botmux runtime is incomplete: node=${nodePath}, cli=${cliPath}`);
  }

  return {
    kind: 'bundled',
    root,
    cliPath,
    nodePath,
    version: input.appVersion,
    runtimeSource: 'bundled',
  };
}

function resolveDevelopmentNode(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const nodePath = [env.BOTMUX_DESKTOP_NODE_PATH, env.npm_node_execpath]
    .find(candidate => candidate && exists(candidate));
  if (!nodePath) {
    throw new Error('Desktop development requires BOTMUX_DESKTOP_NODE_PATH or npm_node_execpath');
  }
  return nodePath;
}
