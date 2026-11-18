// The pool preparation function, real native-root lookup, normalizer and image
// reader run together; only the filesystem and Lark upload transport are fake.
import './helpers/require-fenced-data-dir.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { doubaoWorkspaceForSession } from '../src/services/doubao-transcript.js';
import { normalizeDoubaoReplyImages } from '../src/services/doubao-rich-media.js';
import { resolveReplyImages, type ReplyImageState } from '../src/im/lark/reply-images.js';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('node:fs', () => {
  const { fs }: typeof import('memfs') = require('memfs');
  return { ...fs, default: fs };
});
const poolSource = await readFile('src/core/worker-pool.ts', 'utf8');
const sid = '38459999999999999';
const workspace = '/native/doubao/agent_mode/100/workspace';
const sessionsRoot = `${workspace}/.sessions`;
const project = '/project';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

describe('worker-pool Doubao artifact upload', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(join(process.cwd(), 'src/core'), { recursive: true });
    vol.writeFileSync(join(process.cwd(), 'src/core/worker-pool.ts'), poolSource);
    vol.mkdirSync(homedir(), { recursive: true });
    vol.mkdirSync(project);
    vol.mkdirSync(`${sessionsRoot}/${sid}`, { recursive: true });
    vol.writeFileSync(`${workspace}/diagram.png`, png);
    vol.chownSync(`${workspace}/diagram.png`, process.getuid?.() ?? 0, 0);
  });

  it.each([sid, undefined, '38458888888888888'])('uploads only with the matching bound native session (%s)', async nativeId => {
    const uploadImage = vi.fn(async (_app: string, _bytes: Buffer) => 'img_v3_doubao_artifact');
    const prepare = loadWorkerPoolFunction<(ds: DaemonSession, md: string, state: ReplyImageState, owns: () => boolean) => Promise<string>>(
      'prepareLocalReplyImages', {
        getBot: () => ({ config: {} }),
        sessionCliId: () => 'doubao',
        normalizeDoubaoReplyImages,
        daemonCardLocalHomeLinkMode: () => 'filesystem',
        sandboxBoolValue: () => false,
        doubaoWorkspaceForSession: (id: string | undefined) => doubaoWorkspaceForSession(id, [sessionsRoot]),
        resolveReplyImages, uploadImage,
      });
    const ds = { larkAppId: 'app_doubao', workingDir: project,
      session: { cliSessionId: nativeId, status: 'running' } } as DaemonSession;
    // This file is outside both the project and temporary roots: deleting the
    // pool's additionalImageRoots connection must break the positive case.
    const markdown = `![Diagram](${workspace}/diagram.png)`;
    const output = await prepare(ds, markdown, { omitImages: false }, () => true);
    if (nativeId === sid) {
      expect(output).toBe('![Diagram](img_v3_doubao_artifact)');
      expect(uploadImage).toHaveBeenCalledExactlyOnceWith('app_doubao', png);
    } else {
      expect(output).toBe(markdown);
      expect(uploadImage).not.toHaveBeenCalled();
    }
  });
});
