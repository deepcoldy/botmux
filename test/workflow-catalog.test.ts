import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isValidWorkflowId,
  listWorkflowDefinitions,
  loadCatalogDefinition,
} from '../src/workflows/catalog.js';

const validDef = (workflowId: string, extras: Record<string, unknown> = {}) => ({
  workflowId,
  version: 1,
  params: {
    name: { type: 'string', required: true },
    count: { type: 'number' },
  },
  nodes: {
    draft: { type: 'subagent', bot: 'cli_test', prompt: 'do' },
  },
  ...extras,
});

let homeDir: string;
let projectDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'wf-catalog-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'wf-catalog-project-'));
  mkdirSync(join(homeDir, 'workflows'), { recursive: true });
  mkdirSync(join(projectDir, 'workflows'), { recursive: true });
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('catalog helpers', () => {
  it('isValidWorkflowId rejects path-traversal style ids', () => {
    expect(isValidWorkflowId('weather-trip')).toBe(true);
    expect(isValidWorkflowId('weather_trip.v2')).toBe(true);
    expect(isValidWorkflowId('weather/trip')).toBe(false);
    expect(isValidWorkflowId('../escape')).toBe(false);
    expect(isValidWorkflowId('with spaces')).toBe(false);
  });

  it('lists workflows from both dirs and dedupes by workflowId (first wins)', async () => {
    writeFileSync(
      join(projectDir, 'workflows', 'cwd-only.workflow.json'),
      JSON.stringify(validDef('cwd-only')),
    );
    // Same id present in both dirs — project dir should win because it
    // appears earlier in the search-path order.
    writeFileSync(
      join(projectDir, 'workflows', 'shared.workflow.json'),
      JSON.stringify(validDef('shared', { version: 7 })),
    );
    writeFileSync(
      join(homeDir, 'workflows', 'shared.workflow.json'),
      JSON.stringify(validDef('shared', { version: 1 })),
    );
    writeFileSync(
      join(homeDir, 'workflows', 'home-only.workflow.json'),
      JSON.stringify(validDef('home-only')),
    );

    const entries = await listWorkflowDefinitions({
      dirs: [join(projectDir, 'workflows'), join(homeDir, 'workflows')],
    });
    expect(entries.map((e) => e.workflowId)).toEqual(['cwd-only', 'home-only', 'shared']);
    const shared = entries.find((e) => e.workflowId === 'shared');
    // First-wins: project dir version 7 takes precedence over home dir version 1.
    expect(shared?.version).toBe(7);
    expect(shared?.path).toContain(projectDir);
  });

  it('summary includes paramCount, requiredParamCount, nodeCount, revisionId', async () => {
    writeFileSync(
      join(homeDir, 'workflows', 'summary-check.workflow.json'),
      JSON.stringify({
        workflowId: 'summary-check',
        version: 2,
        params: {
          name: { type: 'string', required: true },
          tag: { type: 'string' },
        },
        nodes: {
          draft: { type: 'subagent', bot: 'cli_a', prompt: 'p' },
          send: {
            type: 'hostExecutor',
            executor: 'feishu-send',
            depends: ['draft'],
            input: { content: 'x' },
            // Catalog test only cares about summary metadata, not gate
            // semantics — opt in so the fixture parses under the side-effect
            // gate rule.
            unsafeAllowUngated: true,
          },
        },
      }),
    );

    const [entry] = await listWorkflowDefinitions({
      dirs: [join(homeDir, 'workflows')],
    });
    expect(entry).toMatchObject({
      workflowId: 'summary-check',
      version: 2,
      paramCount: 2,
      requiredParamCount: 1,
      nodeCount: 2,
    });
    expect(entry?.revisionId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('silently skips unparseable files instead of throwing', async () => {
    writeFileSync(
      join(homeDir, 'workflows', 'broken.workflow.json'),
      '{ not valid json',
    );
    writeFileSync(
      join(homeDir, 'workflows', 'no-nodes.workflow.json'),
      JSON.stringify({ workflowId: 'no-nodes', version: 1, nodes: {} }),
    );
    writeFileSync(
      join(homeDir, 'workflows', 'good.workflow.json'),
      JSON.stringify(validDef('good')),
    );

    const entries = await listWorkflowDefinitions({
      dirs: [join(homeDir, 'workflows')],
    });
    expect(entries.map((e) => e.workflowId)).toEqual(['good']);
  });

  it('returns empty list when no workflow dirs exist', async () => {
    rmSync(homeDir, { recursive: true, force: true });
    const entries = await listWorkflowDefinitions({
      dirs: [join(homeDir, 'workflows')],
    });
    expect(entries).toEqual([]);
  });

  it('loadCatalogDefinition returns def, revisionId, and source path', async () => {
    writeFileSync(
      join(homeDir, 'workflows', 'demo.workflow.json'),
      JSON.stringify(validDef('demo')),
    );
    const found = await loadCatalogDefinition('demo', {
      searchPaths: [
        join(projectDir, 'workflows', 'demo.workflow.json'),
        join(homeDir, 'workflows', 'demo.workflow.json'),
      ],
    });
    expect(found).toBeDefined();
    expect(found?.definition.workflowId).toBe('demo');
    expect(found?.path).toContain(homeDir);
    expect(found?.revisionId).toMatch(/^sha256:/);
  });

  it('loadCatalogDefinition returns undefined when no path resolves', async () => {
    const found = await loadCatalogDefinition('missing', {
      searchPaths: [
        join(projectDir, 'workflows', 'missing.workflow.json'),
        join(homeDir, 'workflows', 'missing.workflow.json'),
      ],
    });
    expect(found).toBeUndefined();
  });
});
