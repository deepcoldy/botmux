import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProjectGroupSlashCommand,
  runProjectGroupSlashCommand,
  type ProjectGroupSlashDeps,
} from '../src/core/project-group-command.js';
import {
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
  writeProjectOnboardingCard,
} from '../src/services/group-collaboration-mode-store.js';
import { readProjectGroup } from '../src/services/project-group-store.js';
import type { ChatBotMember } from '../src/im/lark/client.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function member(larkAppId: string, displayName: string): ChatBotMember {
  return {
    larkAppId,
    openId: larkAppId ? `ou_${larkAppId}` : 'ou_external',
    name: displayName,
    displayName,
    source: larkAppId ? 'configured' : 'introduce',
    hasTeamRole: false,
    mentionable: true,
    mentionSource: larkAppId ? 'cross-ref' : 'observed',
  };
}

function fixture(overrides: Partial<ProjectGroupSlashDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-slash-'));
  roots.push(dataDir);
  const ensureOnboardingCard = vi.fn(async () => undefined);
  const clearOnboardingCard = vi.fn(async ({ chatId }: { chatId: string }) => {
    await writeProjectOnboardingCard(dataDir, chatId, undefined);
  });
  const deps: ProjectGroupSlashDeps = {
    dataDir,
    getChatMode: vi.fn(async () => 'group'),
    listChatBotMembers: vi.fn(async () => [
      member('cli_coordinator', 'nodex'),
      member('cli_worker_a', 'Worker A'),
      member('cli_worker_b', 'Worker B'),
      member('', 'External Bot'),
    ]),
    readConfig: readGroupCollaborationMode,
    writeConfig: writeGroupCollaborationMode,
    readProject: readProjectGroup,
    ensureOnboardingCard,
    clearOnboardingCard,
    ...overrides,
  };
  return { dataDir, deps, ensureOnboardingCard, clearOnboardingCard };
}

const input = { content: '/project enable', larkAppId: 'cli_coordinator', chatId: 'oc_project' };

describe('/project slash command', () => {
  it('parses the supported command surface and rejects extra arguments', () => {
    expect(parseProjectGroupSlashCommand('/project')).toEqual({ ok: true, subcommand: 'help' });
    expect(parseProjectGroupSlashCommand('/project on')).toEqual({ ok: true, subcommand: 'enable' });
    expect(parseProjectGroupSlashCommand('/project get')).toEqual({ ok: true, subcommand: 'status' });
    expect(parseProjectGroupSlashCommand('/project role')).toEqual({ ok: true, subcommand: 'roles' });
    expect(parseProjectGroupSlashCommand('/project off')).toEqual({ ok: true, subcommand: 'disable' });
    expect(parseProjectGroupSlashCommand('/project enable now')).toEqual({
      ok: false, error: 'unexpected_arguments', value: 'now',
    });
    expect(parseProjectGroupSlashCommand('/project start')).toEqual({
      ok: false, error: 'unknown_subcommand', value: 'start',
    });
  });

  it('opens role configuration only for an enabled project owned by this coordinator', async () => {
    const standard = fixture();
    expect(await runProjectGroupSlashCommand({ ...input, content: '/project roles' }, standard.deps)).toEqual({
      kind: 'error', error: 'project_mode_required',
    });

    const project = fixture();
    await writeGroupCollaborationMode(project.dataDir, {
      chatId: input.chatId,
      mode: 'project',
      coordinatorAppId: input.larkAppId,
      workerAppIds: ['cli_worker_a'],
    });
    expect(await runProjectGroupSlashCommand({ ...input, content: '/project roles' }, project.deps)).toMatchObject({
      kind: 'roles',
      config: { coordinatorAppId: input.larkAppId, workerAppIds: ['cli_worker_a'] },
    });
  });

  it('enables project mode with the addressed bot as coordinator and all local peers as workers', async () => {
    const f = fixture();
    const result = await runProjectGroupSlashCommand(input, f.deps);

    expect(result).toMatchObject({ kind: 'enabled', alreadyEnabled: false, cardRefresh: 'updated' });
    expect(readGroupCollaborationMode(f.dataDir, input.chatId)).toMatchObject({
      mode: 'project',
      coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker_a', 'cli_worker_b'],
      autoEnrollWorkers: true,
    });
    expect(f.ensureOnboardingCard).toHaveBeenCalledWith(
      { dataDir: f.dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator' },
      { coordinatorName: 'nodex', workerNames: ['Worker A', 'Worker B'] },
    );
  });

  it('is idempotent and preserves a worker subset already curated in Dashboard', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: input.chatId,
      mode: 'project',
      coordinatorAppId: input.larkAppId,
      workerAppIds: ['cli_worker_a'],
      autoEnrollWorkers: false,
    });

    const result = await runProjectGroupSlashCommand(input, f.deps);

    expect(result).toMatchObject({ kind: 'enabled', alreadyEnabled: true });
    expect(readGroupCollaborationMode(f.dataDir, input.chatId)?.workerAppIds).toEqual(['cli_worker_a']);
    expect(readGroupCollaborationMode(f.dataDir, input.chatId)?.autoEnrollWorkers).toBe(false);
    expect(f.ensureOnboardingCard).toHaveBeenCalledWith(expect.anything(), {
      coordinatorName: 'nodex', workerNames: ['Worker A'],
    });
  });

  it('fails closed outside ordinary groups or when the live bot roster is incomplete', async () => {
    const topic = fixture({ getChatMode: vi.fn(async () => 'topic') });
    expect(await runProjectGroupSlashCommand(input, topic.deps)).toEqual({
      kind: 'error', error: 'ordinary_group_required',
    });

    const unknown = fixture({ getChatMode: vi.fn(async () => 'unknown') });
    expect(await runProjectGroupSlashCommand(input, unknown.deps)).toEqual({
      kind: 'error', error: 'chat_lookup_failed',
    });

    const noSelf = fixture({ listChatBotMembers: vi.fn(async () => [member('cli_worker_a', 'Worker A')]) });
    expect(await runProjectGroupSlashCommand(input, noSelf.deps)).toEqual({
      kind: 'error', error: 'coordinator_not_in_chat',
    });
    expect(readGroupCollaborationMode(noSelf.dataDir, input.chatId)).toBeUndefined();
  });

  it('does not steal a group or existing project owned by another coordinator', async () => {
    const configured = fixture();
    await writeGroupCollaborationMode(configured.dataDir, {
      chatId: input.chatId, mode: 'project', coordinatorAppId: 'cli_other', workerAppIds: [],
    });
    expect(await runProjectGroupSlashCommand(input, configured.deps)).toEqual({
      kind: 'error', error: 'coordinator_conflict', detail: 'cli_other',
    });

    const project = fixture({
      readProject: () => ({ larkAppId: 'cli_other' } as ReturnType<typeof readProjectGroup>),
    });
    expect(await runProjectGroupSlashCommand(input, project.deps)).toEqual({
      kind: 'error', error: 'coordinator_conflict', detail: 'cli_other',
    });
  });

  it('reports status and disables project mode after clearing the waiting guide', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: input.chatId, mode: 'project', coordinatorAppId: input.larkAppId,
      workerAppIds: ['cli_worker_a'],
    });
    await writeProjectOnboardingCard(f.dataDir, input.chatId, {
      messageId: 'om_guide', larkAppId: input.larkAppId, pinned: true,
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    });

    const status = await runProjectGroupSlashCommand({ ...input, content: '/project status' }, f.deps);
    expect(status).toMatchObject({ kind: 'status', config: { mode: 'project' }, project: undefined });

    const disabled = await runProjectGroupSlashCommand({ ...input, content: '/project disable' }, f.deps);
    expect(disabled).toEqual({ kind: 'disabled', alreadyDisabled: false, projectRetained: false });
    expect(f.clearOnboardingCard).toHaveBeenCalledTimes(1);
    expect(readGroupCollaborationMode(f.dataDir, input.chatId)).toMatchObject({ mode: 'standard' });
  });
});
