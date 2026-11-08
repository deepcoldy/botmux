import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLinkRefRuntime,
  closeLinkRefRuntime,
  getLinkRefRuntime,
  initializeLinkRefRuntime,
  type LinkRefRuntime,
} from '../src/services/link-ref-runtime.js';
import {
  initialLinkRefSources,
  prepareLinkRefTurnPayload,
  readLinkRefAttachmentText,
} from '../src/core/link-ref-turn.js';
import type { CliTurnPayload } from '../src/types.js';
import type { LinkRefTurnKey } from '../src/services/link-ref-types.js';

const key: LinkRefTurnKey = { appId: 'app', sessionId: 'session', turnId: 'turn', dispatchAttempt: 1 };
const fullUrl = 'https://example.test/problem' + '?id=1&state=ready#timeline';

describe('LinkRef turn admission', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function runtime(): { runtime: LinkRefRuntime; dataDir: string } {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-admission-'));
    dirs.push(dataDir);
    return { runtime: createLinkRefRuntime(dataDir), dataDir };
  }

  function payload(): CliTurnPayload {
    return {
      content: `legacy user ${fullUrl}`,
      codexAppInput: { text: `clean user ${fullUrl}` },
      linkRefs: {
        mode: 'disabled',
        sources: [
          { sourceType: 'user_message', kind: 'text', text: `user ${fullUrl}` },
          { sourceType: 'group_context', kind: 'text', text: 'group https://group.example.test/page' },
          { sourceType: 'public_system_doc', kind: 'text', text: 'docs https://docs.example.test/page' },
        ],
      },
    };
  }

  it('disabled is byte-compatible and never scans or opens the ledger', () => {
    const { runtime: linkRefs, dataDir } = runtime();
    const before = payload();
    const content = before.content;
    const codexAppInput = structuredClone(before.codexAppInput);
    const register = vi.spyOn(linkRefs, 'registerSources');

    const result = linkRefs.prepareTurn({ key, mode: 'disabled', payload: before });

    expect(result.content).toBe(content);
    expect(result.codexAppInput).toEqual(codexAppInput);
    expect(result.linkRefs).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'link-refs'))).toBe(false);
  });

  it('observe scans only explicit sources without creating a ledger or changing model input', () => {
    const diagnostics: unknown[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-observe-'));
    dirs.push(dataDir);
    const linkRefs = createLinkRefRuntime(dataDir, { onDiagnostic: (event) => diagnostics.push(event) });
    const before = payload();
    const content = before.content;
    const codexAppInput = structuredClone(before.codexAppInput);

    const result = linkRefs.prepareTurn({ key, mode: 'observe', payload: before });

    expect(result.content).toBe(content);
    expect(result.codexAppInput).toEqual(codexAppInput);
    expect(result.linkRefs).toEqual({ mode: 'observe' });
    expect(diagnostics).toContainEqual(expect.objectContaining({ mode: 'observe', found: 3 }));
    expect(existsSync(join(dataDir, 'link-refs'))).toBe(false);
  });

  it('enabled registers once and appends a companion without rewriting Codex App text', () => {
    const { runtime: linkRefs } = runtime();
    const before = payload();
    const cleanText = before.codexAppInput!.text;
    const register = vi.spyOn(linkRefs, 'registerSources');

    const result = linkRefs.prepareTurn({ key, mode: 'enabled', payload: before });

    expect(register).toHaveBeenCalledOnce();
    expect(result.content).toContain('<botmux_link_refs>');
    expect(result.content).toContain(fullUrl);
    expect(result.codexAppInput?.text).toBe(cleanText);
    expect(Object.values(result.codexAppInput?.additionalContext ?? {}))
      .toContainEqual(expect.objectContaining({ kind: 'untrusted', value: expect.stringContaining('<botmux_link_refs>') }));
    expect(result.linkRefs).toEqual({ mode: 'enabled' });
    expect(linkRefs.restoreMode(key)).toBe('enabled');
  });

  it('opens an enabled turn even when its initial sources contain no URL', () => {
    const { runtime: linkRefs } = runtime();
    const before: CliTurnPayload = {
      content: 'no links yet',
      linkRefs: {
        mode: 'disabled',
        sources: [{ sourceType: 'user_message', kind: 'text', text: 'no links yet' }],
      },
    };

    const result = linkRefs.prepareTurn({ key, mode: 'enabled', payload: before });

    expect(result).toEqual({ content: 'no links yet', linkRefs: { mode: 'enabled' } });
    expect(linkRefs.restoreMode(key)).toBe('enabled');
  });

  it('opens an enabled turn even when it has no initial sources', () => {
    const { runtime: linkRefs } = runtime();

    linkRefs.prepareTurn({ key, mode: 'enabled', payload: { content: 'no sources' } });

    expect(linkRefs.restoreMode(key)).toBe('enabled');
  });

  it('does not register hidden instructions unless explicitly listed as public docs', () => {
    const sources = initialLinkRefSources({
      userText: 'user https://user.example.test/page',
      groupContext: 'group https://group.example.test/page',
      hiddenSystemInstruction: 'hidden https://hidden.example.test/page',
      skillInternalText: 'skill https://skill.example.test/page',
      publicSystemDocUrls: ['https://docs.example.test/page'],
    });

    expect(sources).toEqual([
      { sourceType: 'user_message', kind: 'text', text: 'user https://user.example.test/page' },
      { sourceType: 'group_context', kind: 'text', text: 'group https://group.example.test/page' },
      { sourceType: 'public_system_doc', kind: 'text', text: 'https://docs.example.test/page' },
    ]);
  });

  it('prepareLinkRefTurnPayload delegates to the installed runtime', () => {
    const fake = {
      prepareTurn: vi.fn(({ payload }: { payload: CliTurnPayload }) => ({ ...payload, content: 'prepared' })),
    } as unknown as LinkRefRuntime;
    const result = prepareLinkRefTurnPayload({ runtime: fake, key, mode: 'enabled', payload: payload() });
    expect(result.content).toBe('prepared');
    expect(fake.prepareTurn).toHaveBeenCalledOnce();
  });

  it('reads only bounded regular text attachment files without following symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-attachment-'));
    dirs.push(dir);
    const textPath = join(dir, 'source.md');
    const binaryPath = join(dir, 'binary.md');
    const largePath = join(dir, 'large.md');
    const symlinkPath = join(dir, 'link.md');
    writeFileSync(textPath, `authorization ${fullUrl}`);
    writeFileSync(binaryPath, Buffer.from([0x61, 0, 0x62]));
    writeFileSync(largePath, Buffer.alloc(256 * 1024 + 1, 0x61));
    symlinkSync(textPath, symlinkPath);

    expect(readLinkRefAttachmentText(textPath)).toBe(`authorization ${fullUrl}`);
    expect(readLinkRefAttachmentText(binaryPath)).toBeUndefined();
    expect(readLinkRefAttachmentText(largePath)).toBeUndefined();
    expect(readLinkRefAttachmentText(symlinkPath)).toBeUndefined();
    expect(readLinkRefAttachmentText(dir)).toBeUndefined();
  });

  it('restores enabled mode only for the exact open unexpired turn key', () => {
    const { runtime: first, dataDir } = runtime();
    first.prepareTurn({ key, mode: 'enabled', payload: payload() });
    first.close();

    const reopened = createLinkRefRuntime(dataDir);
    expect(reopened.restoreMode(key)).toBe('enabled');
    expect(reopened.restoreMode({ ...key, dispatchAttempt: 2 })).toBeUndefined();
    expect(reopened.restoreMode({ ...key, turnId: 'other-turn' })).toBeUndefined();
    reopened.close();
  });

  it('does not create a ledger while probing a disabled recovered turn', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-disabled-recovery-'));
    dirs.push(dataDir);
    const runtime = createLinkRefRuntime(dataDir);

    expect(runtime.restoreMode({
      appId: 'app-disabled-recovery',
      sessionId: 'session-disabled-recovery',
      turnId: 'turn-disabled-recovery',
    })).toBeUndefined();
    expect(existsSync(join(dataDir, 'link-refs', 'link-refs.sqlite'))).toBe(false);

    runtime.close();
  });

  it('installs an inert daemon runtime and clears it on shutdown', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-runtime-'));
    dirs.push(dataDir);

    initializeLinkRefRuntime(dataDir);

    expect(getLinkRefRuntime()).toBeDefined();
    expect(existsSync(join(dataDir, 'link-refs'))).toBe(false);
    closeLinkRefRuntime();
    expect(getLinkRefRuntime()).toBeUndefined();
  });
});
