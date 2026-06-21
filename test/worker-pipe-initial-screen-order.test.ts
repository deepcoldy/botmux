import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('worker pipe initial screen ordering', () => {
  it('captures pipe initial screen after idle detector is registered', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // The inline `const initial = backend.captureCurrentScreen()` was refactored
    // into the shared seedBackendScreen() helper; the pipe-reattach seed is the
    // call with the `${effectiveBackendType} reattach` label (distinct from the
    // adopt-branch seeds, which run in earlier early-return paths). It must still
    // come after idle detector registration.
    const captureIdx = source.indexOf('seedBackendScreen(`${effectiveBackendType} reattach`, backend);');
    const idleIdx = source.indexOf('// Set up idle detection');
    expect(captureIdx).toBeGreaterThan(idleIdx);
  });

  it('runs a busy-pattern idle probe after each submitted input', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const writeIdx = source.indexOf('result = await cliAdapter.writeInput(backend, msg);');
    const probeIdx = source.indexOf('scheduleBusyPatternIdleProbe(`${cliName()} post-submit`);');
    const helperIdx = source.indexOf('function scheduleBusyPatternIdleProbe(source: string): void');

    expect(helperIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(writeIdx);
  });

  it('rechecks busy-pattern adapters when a Lark message is queued while busy', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const queueLogIdx = source.indexOf('Queued message (${pendingMessages.length} pending)');
    const queuedProbeIdx = source.indexOf('scheduleBusyPatternIdleProbe(`${cliName()} queued-message`);');
    const helperIdx = source.indexOf('function scheduleBusyPatternIdleProbe(source: string): void');

    expect(helperIdx).toBeGreaterThan(-1);
    expect(queueLogIdx).toBeGreaterThan(-1);
    expect(queuedProbeIdx).toBeGreaterThan(queueLogIdx);
  });

  it('rechecks busy-pattern adapters after first prompt timeout', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const timeoutIdx = source.indexOf("log('First prompt timeout — enabling screen updates and flushing queued messages');");
    const probeIdx = source.indexOf('probeBusyPatternIdle(`${cliName()} first-prompt-timeout`, backend)', timeoutIdx);

    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(timeoutIdx);
  });

  it('limits busy-pattern idle probes to the active status region', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const helperStart = source.indexOf('function busyProbeRegion(content: string): string');
    const probeStart = source.indexOf('function probeBusyPatternIdle');
    const probeEnd = source.indexOf('function scheduleReattachIdleProbe');
    const helper = source.slice(helperStart, probeEnd);
    const probe = source.slice(probeStart, probeEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('const tailLineCount = Math.max(12, Math.ceil(lines.length / 3));');
    expect(probe).toContain('cliAdapter.busyPattern.test(busyProbeRegion(content))');
    expect(probe).not.toContain('cliAdapter.busyPattern.test(content)');
  });

  it('limits the reattach idle probe to adapters with a busy marker', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const helperStart = source.indexOf('function scheduleReattachIdleProbe');
    const helperEnd = source.indexOf('function stopReattachIdleProbe');
    const helper = source.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('if (!cliAdapter?.busyPattern || (!be.captureCurrentScreen && !be.captureViewport)) return;');
    expect(helper).toContain('if (backend !== be || !awaitingFirstPrompt || isPromptReady) return;');
    expect(helper).not.toContain('pendingMessages.length > 0');
  });

  it('checks for an existing tmux session before falling back to pty', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const guardStart = source.indexOf('let effectiveBackend = cfg.backendType;');
    const guardEnd = source.indexOf("if (effectiveBackend === 'herdr'", guardStart);
    const guard = source.slice(guardStart, guardEnd);

    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(guard).toContain('const hasExistingSession = TmuxBackend.hasSession(existingSessionName);');
    expect(guard).toContain('!hasExistingSession && !TmuxBackend.isAvailable()');
    expect(guard.indexOf('TmuxBackend.hasSession')).toBeLessThan(guard.indexOf('TmuxBackend.isAvailable'));
  });
});
