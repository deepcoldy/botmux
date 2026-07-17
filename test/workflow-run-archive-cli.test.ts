import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import { parseWorkflowRunArchiveCliOptions } from '../src/cli/workflow-run-archive.js';

describe('botmux template archive-runs CLI', () => {
  it('defaults to a zero-write plan in the canonical data directory', () => {
    const dataDir = resolve('/tmp/botmux-archive-cli-data');
    const options = parseWorkflowRunArchiveCliOptions([], dataDir, {});
    expect(options).toEqual({
      mode: 'plan',
      json: false,
      runsDir: join(dataDir, 'workflow-runs'),
      archiveBaseDir: join(dataDir, 'workflow-archives', 'v2-runs'),
      daemonStoppedAcknowledged: false,
    });
  });

  it('parses explicit commit and verify modes without conflating source and archive roots', () => {
    expect(parseWorkflowRunArchiveCliOptions([
      '--commit', '--json', '--runs-dir', './runs', '--archive-dir=./archives',
    ], '/ignored')).toMatchObject({
      mode: 'commit',
      json: true,
      runsDir: resolve('./runs'),
      archiveBaseDir: resolve('./archives'),
    });
    expect(parseWorkflowRunArchiveCliOptions([
      '--verify', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ], '/tmp/data')).toMatchObject({
      mode: 'verify',
      archiveRef: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(parseWorkflowRunArchiveCliOptions([
      '--retire', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '--ack-daemon-stopped',
    ], '/tmp/data')).toMatchObject({
      mode: 'retire',
      archiveRef: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      daemonStoppedAcknowledged: true,
    });
  });

  it('rejects ambiguous or loose flags', () => {
    expect(() => parseWorkflowRunArchiveCliOptions(['extra'], '/tmp/data')).toThrow(/positional/);
    expect(() => parseWorkflowRunArchiveCliOptions(['--commit', '--verify', '/tmp/a'], '/tmp/data')).toThrow(/mutually exclusive/);
    expect(() => parseWorkflowRunArchiveCliOptions(['--retire', '/tmp/a', '--verify', '/tmp/a'], '/tmp/data')).toThrow(/mutually exclusive/);
    expect(() => parseWorkflowRunArchiveCliOptions(['--ack-daemon-stopped'], '/tmp/data')).toThrow(/only valid with --retire/);
    expect(() => parseWorkflowRunArchiveCliOptions(['--json=true'], '/tmp/data')).toThrow(/does not accept/);
    expect(() => parseWorkflowRunArchiveCliOptions(['--unknown'], '/tmp/data')).toThrow(/unknown flag/);
  });
});
