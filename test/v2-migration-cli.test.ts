import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotConfig } from '../src/bot-registry.js';
import {
  parseWorkflowMigrationCliOptions,
  runWorkflowMigrationCli,
} from '../src/cli/workflow-migration.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { scanLegacyWorkflowCandidates } from '../src/workflows/migration/v2-scanner.js';

const BOT: BotConfig = {
  larkAppId: 'cli_goal',
  larkAppSecret: 'secret',
  cliId: 'codex',
  workingDir: '/repo',
};

function definition(id: string, prompt = 'work'): WorkflowDefinition {
  return {
    workflowId: id,
    version: 1,
    nodes: { work: { type: 'subagent', bot: BOT.larkAppId, prompt } },
  };
}

describe('v2 migration scanner and CLI', () => {
  let root: string;
  let firstDir: string;
  let secondDir: string;
  let sourcePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-v2-migration-cli-'));
    firstDir = join(root, 'cwd-workflows');
    secondDir = join(root, 'home-workflows');
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    sourcePath = join(firstDir, 'demo.workflow.json');
    writeFileSync(sourcePath, JSON.stringify(definition('demo')), 'utf-8');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports malformed and shadowed assets instead of silently hiding them', async () => {
    const shadowed = join(secondDir, 'demo.workflow.json');
    writeFileSync(shadowed, JSON.stringify(definition('demo', 'shadow')), 'utf-8');
    writeFileSync(join(secondDir, 'broken.workflow.json'), '{broken', 'utf-8');
    const all = await scanLegacyWorkflowCandidates({ dirs: [firstDir, secondDir] });
    expect(all.map((item) => item.kind)).toEqual(['valid', 'invalid', 'shadowed']);
    expect(all.find((item) => item.kind === 'shadowed')).toMatchObject({ shadowedBy: sourcePath });

    const explicit = await scanLegacyWorkflowCandidates({ refs: [shadowed] });
    expect(explicit).toMatchObject([{ kind: 'valid', path: shadowed }]);
  });

  it('strictly parses commit identity/scope and unknown/duplicate flags', () => {
    expect(parseWorkflowMigrationCliOptions([], join(root, 'data'))).toMatchObject({
      refs: [],
      commit: false,
      dataDir: join(root, 'data'),
    });
    expect(() => parseWorkflowMigrationCliOptions(['--commit'], join(root, 'data')))
      .toThrow(/never infers ownership\/scope/);
    expect(() => parseWorkflowMigrationCliOptions(['--wat'], join(root, 'data')))
      .toThrow(/unknown flag/);
    expect(() => parseWorkflowMigrationCliOptions(['--json', '--json'], join(root, 'data')))
      .toThrow(/duplicate flag/);
    expect(() => parseWorkflowMigrationCliOptions(['--supersede-pending'], join(root, 'data')))
      .toThrow(/commit-only/);
    expect(parseWorkflowMigrationCliOptions([
      '--owner-open-id', 'ou_owner',
      '--lark-app-id=cli_owner',
      '--scope', 'chat',
      '--chat-id', 'oc_chat',
      '--chat-type', 'p2p',
      '--commit',
    ], join(root, 'data'))).toMatchObject({
      owner: { openId: 'ou_owner', larkAppId: 'cli_owner' },
      scope: { kind: 'chat', chatId: 'oc_chat' },
      chatType: 'p2p',
      commit: true,
    });
  });

  it('uses the daemon breadcrumb as migration default without SESSION_DATA_DIR', () => {
    const previousHome = process.env.HOME;
    const previousDataDir = process.env.SESSION_DATA_DIR;
    const home = join(root, 'home');
    const active = join(root, 'custom-data');
    try {
      mkdirSync(join(home, '.botmux'), { recursive: true });
      mkdirSync(active, { recursive: true });
      writeFileSync(join(home, '.botmux', '.data-dir'), active, 'utf-8');
      process.env.HOME = home;
      delete process.env.SESSION_DATA_DIR;
      expect(parseWorkflowMigrationCliOptions([]).dataDir).toBe(active);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    }
  });

  it('dry-run writes zero bytes and commit creates the ledger/library explicitly', async () => {
    const dataDir = join(root, 'data');
    const scan = async () => scanLegacyWorkflowCandidates({ refs: [sourcePath] });
    const dry = await runWorkflowMigrationCli({
      refs: [sourcePath],
      all: false,
      commit: false,
      json: true,
      acknowledgeWarnings: false,
      supersedePending: false,
      dataDir,
    }, {
      loadBots: () => [BOT],
      scanCandidates: scan,
    });
    expect(dry.ok).toBe(true);
    expect(dry.reports).toMatchObject([{ status: 'convertible', workflowId: 'demo' }]);
    expect(existsSync(dataDir)).toBe(false);

    const committed = await runWorkflowMigrationCli({
      refs: [sourcePath],
      all: false,
      commit: true,
      json: true,
      acknowledgeWarnings: false,
      supersedePending: false,
      dataDir,
      owner: { openId: 'ou_owner', larkAppId: 'cli_owner' },
      scope: { kind: 'global' },
    }, {
      loadBots: () => [BOT],
      scanCandidates: scan,
    });
    expect(committed.ok).toBe(true);
    expect(committed.reports).toMatchObject([{
      status: 'committed',
      workflowId: 'demo',
    }]);
    expect(existsSync(join(dataDir, 'workflow-migrations', 'v2-to-v3.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'workflow-library'))).toBe(true);
  });

  it('commits convertible definitions independently while leaving unsupported peers untouched', async () => {
    const badPath = join(firstDir, 'bad.workflow.json');
    const bad = definition('bad');
    (bad.nodes.work as any).prompt = 'consume ${upstream.output.value}';
    writeFileSync(badPath, JSON.stringify(bad), 'utf-8');
    const dataDir = join(root, 'batch-data');
    const result = await runWorkflowMigrationCli({
      refs: [sourcePath, badPath],
      all: false,
      commit: true,
      json: true,
      acknowledgeWarnings: false,
      supersedePending: false,
      dataDir,
      owner: { openId: 'ou_owner', larkAppId: 'cli_owner' },
      scope: { kind: 'global' },
    }, {
      loadBots: () => [BOT],
      scanCandidates: () => scanLegacyWorkflowCandidates({ refs: [sourcePath, badPath] }),
    });
    expect(result.ok).toBe(false);
    expect(result.reports.map((report) => report.status)).toEqual(['committed', 'unsupported']);
    expect(result.reports[1]!.issues.map((item) => item.code)).toContain('OUTPUT_BINDING_UNSUPPORTED');
    expect(existsSync(join(dataDir, 'workflow-library', result.reports[0]!.targetWorkflowId!))).toBe(true);
    expect(existsSync(join(dataDir, 'workflow-library', result.reports[1]!.targetWorkflowId!))).toBe(false);
  });
});
