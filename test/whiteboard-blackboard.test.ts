import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import * as s from '../src/services/whiteboard-store.js';

// The store reads config.session.dataDir (SESSION_DATA_DIR) and
// whiteboardEnabled() from ~/.botmux/config.json (HOME-based), both resolved
// dynamically at call time. Point them at a temp dir per test so nothing
// touches the real machine state.
let home: string;
let dataDir: string;
let prevHome: string | undefined;
let prevData: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevData = process.env.SESSION_DATA_DIR;
  home = mkdtempSync(join(tmpdir(), 'wb-blackboard-'));
  dataDir = join(home, '.botmux', 'data');
  mkdirSync(join(home, '.botmux'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = home;
  process.env.SESSION_DATA_DIR = dataDir;
  writeFileSync(join(home, '.botmux', 'config.json'), JSON.stringify({ whiteboard: { enabled: true } }), 'utf-8');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevData === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevData;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('whiteboard blackboard primitives', () => {
  it('default template is the blackboard structure with the three regions', () => {
    const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });
    const board = s.readWhiteboard(meta.id);
    expect(board).toContain('项目共享白板');
    expect(board).toContain('数据');            // trust banner
    expect(board).toContain('共享结论');
    expect(board).toContain('各 Session 工作区');
    expect(board).toContain('消息日志');
  });

  describe('postWhiteboardMessage / readWhiteboardLog', () => {
    it('appends monotonic messages that concurrent sessions can read', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });

      const m1 = s.postWhiteboardMessage(meta.id, { body: 'claiming auth/', kind: 'claim', actor: 'sess-a' });
      const m2 = s.postWhiteboardMessage(meta.id, { body: 'yielding auth/', kind: 'yield', actor: 'sess-b', to: 'sess-a' });
      expect(m1.seq).toBe(1);
      expect(m2.seq).toBe(2);

      const all = s.readWhiteboardLog(meta.id);
      expect(all.map(m => m.body)).toEqual(['claiming auth/', 'yielding auth/']);
      expect(all[1]).toMatchObject({ kind: 'yield', actor: 'sess-b', to: 'sess-a' });
    });

    it('sinceSeq returns only messages a peer has not seen yet', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });
      s.postWhiteboardMessage(meta.id, { body: 'one', actor: 'a' });
      s.postWhiteboardMessage(meta.id, { body: 'two', actor: 'a' });
      const seen = s.readWhiteboardLog(meta.id);
      const cursor = seen[seen.length - 1].seq;
      s.postWhiteboardMessage(meta.id, { body: 'three', actor: 'b' });

      const fresh = s.readWhiteboardLog(meta.id, { sinceSeq: cursor });
      expect(fresh.map(m => m.body)).toEqual(['three']);
    });

    it('defaults kind to note and rejects an empty body', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });
      expect(s.postWhiteboardMessage(meta.id, { body: 'hi' }).kind).toBe('note');
      expect(() => s.postWhiteboardMessage(meta.id, { body: '   ' })).toThrow('whiteboard_empty_content');
    });

    it('log read skips the legacy [overwrite] audit lines from writeWhiteboard', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });
      s.writeWhiteboard(meta.id, '# whole rewrite\n', { actor: 'sess-a' });
      s.postWhiteboardMessage(meta.id, { body: 'a real message', actor: 'sess-a' });
      const log = s.readWhiteboardLog(meta.id);
      expect(log.map(m => m.body)).toEqual(['a real message']);
    });
  });

  describe('upsertWhiteboardSection', () => {
    it('creates and updates one session block without touching others', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });

      s.upsertWhiteboardSection(meta.id, 'sess-a', '- a working on X', { actor: 'sess-a' });
      s.upsertWhiteboardSection(meta.id, 'sess-b', '- b working on Y', { actor: 'sess-b' });
      let board = s.readWhiteboard(meta.id);
      expect(board).toContain('## @session sess-a');
      expect(board).toContain('- a working on X');
      expect(board).toContain('## @session sess-b');
      expect(board).toContain('- b working on Y');

      // sess-a updates only its own block; sess-b's stays intact.
      s.upsertWhiteboardSection(meta.id, 'sess-a', '- a now on Z', { actor: 'sess-a' });
      board = s.readWhiteboard(meta.id);
      expect(board).toContain('- a now on Z');
      expect(board).not.toContain('- a working on X');
      expect(board).toContain('- b working on Y');   // untouched
      // Only one heading per session (update replaced, not appended).
      expect(board.match(/## @session sess-a/g)?.length).toBe(1);
    });

    it('empty body removes the session block', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });
      s.upsertWhiteboardSection(meta.id, 'sess-a', '- something', { actor: 'sess-a' });
      expect(s.readWhiteboard(meta.id)).toContain('## @session sess-a');
      s.upsertWhiteboardSection(meta.id, 'sess-a', '', { actor: 'sess-a' });
      expect(s.readWhiteboard(meta.id)).not.toContain('## @session sess-a');
    });

    it('preserves the shared 共享结论 region when a session writes its block', () => {
      const meta = s.createWhiteboard({ chatId: 'chat1', sessionId: 'sess-a' });
      s.upsertWhiteboardSection(meta.id, 'sess-a', '- working', { actor: 'sess-a' });
      const board = s.readWhiteboard(meta.id);
      expect(board).toContain('共享结论');
      expect(board).toContain('消息日志');
    });
  });
});
