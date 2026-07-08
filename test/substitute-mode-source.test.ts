import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('substitute mode daemon source ordering', () => {
  it('checks own pinned working dir before creating a session for ungranted substitute turns', () => {
    const source = readFileSync(join(process.cwd(), 'src/daemon.ts'), 'utf8');
    const start = source.indexOf('async function handleNewTopic(');
    const end = source.indexOf('async function handleThreadReply(', start);
    const body = source.slice(start, end);

    const resolveIdx = body.indexOf('const { pinnedWorkingDir, oncallEntry, inheritedFrom } = await resolvePinnedWorkingDir');
    const guardIdx = body.indexOf("tr('cmd.substitute.need_working_dir'");
    const createIdx = body.indexOf('const session = sessionStore.createSession', guardIdx);
    const inheritRejectIdx = body.indexOf('(!pinnedWorkingDir || !!inheritedFrom)');

    expect(resolveIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(resolveIdx);
    expect(createIdx).toBeGreaterThan(guardIdx);
    expect(inheritRejectIdx).toBeGreaterThan(-1);
  });
});
