/**
 * The field shape behind `current_execution_unverified` on tmux + Claude Code,
 * on a real Linux process tree: the pane's login shell runs an rc hook in the
 * background (autojump) and then execs into the program-status relay. The
 * relay never reaps that child, so it keeps an unreaped zombie next to its one
 * real payload. The launch-layer walk must still see exactly one payload, or
 * the worker never rewires its trusted root from the relay to the CLI and every
 * tool call under that CLI fails process attestation.
 *
 * Only processes this test spawns are touched (its own process group).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unwrapBotmuxLaunchLayers } from '../src/core/launch-layers.js';
import { getChildPids } from '../src/core/session-discovery.js';
import { isZombieProcess } from '../src/core/session-scope.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform !== 'linux')('launch layers on a real process tree', () => {
  it('unwraps a relay that inherited an unreaped background child from the pane shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-zombie-relay-'));
    // Relay-shaped argv: <interpreter> <dir>/program-status-relay.js <sha256> <dir>/botmux-psr-x/plan.json
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const script = join(dir, 'program-status-relay.js');
    writeFileSync(script, [
      "import { spawn } from 'node:child_process';",
      "spawn('sleep', ['30'], { stdio: 'ignore' });",
      'setTimeout(() => {}, 30_000);',
    ].join('\n'));
    mkdirSync(join(dir, 'botmux-psr-x'));
    const plan = join(dir, 'botmux-psr-x', 'plan.json');
    writeFileSync(plan, '{}');
    // The pane's login shell: `true &` stands in for the backgrounded rc hook,
    // and `exec` turns the shell into the relay, which inherits that child.
    const paneShell = join(dir, 'pane-shell.sh');
    writeFileSync(paneShell, 'true &\nexec "$@"\n');
    const pane = spawn('/bin/sh', [paneShell, process.execPath, script, 'a'.repeat(64), plan], {
      detached: true, stdio: 'ignore',
    });
    try {
      const relayPid = pane.pid!;
      let children: number[] = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        children = getChildPids(relayPid);
        if (children.length === 2 && children.some(child => isZombieProcess(child))) break;
        await delay(50);
      }
      const zombies = children.filter(child => isZombieProcess(child));
      expect(zombies, `children of the relay: ${children.join(',')}`).toHaveLength(1);
      const payload = children.find(child => !isZombieProcess(child))!;
      expect(unwrapBotmuxLaunchLayers(relayPid, { relay: true }))
        .toEqual({ pid: payload, layers: ['program-status-relay'], chain: [relayPid, payload] });
    } finally {
      try { process.kill(-pane.pid!, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
