import { spawnSync } from 'node:child_process';
import {
  ZmxBackend,
  type ZmxManagedSessionProbe,
} from '../adapters/backend/zmx-backend.js';
import { zmxEnv } from '../setup/ensure-zmx.js';

type ManagedProbe = (name: string, sessionId: string) => ZmxManagedSessionProbe;
type AttachProcess = (name: string) => {
  status: number | null;
  error?: Error;
};

export interface ManagedZmxAttachDeps {
  probe?: ManagedProbe;
  attach?: AttachProcess;
  env?: NodeJS.ProcessEnv;
}

export type FrozenManagedZmxAttach =
  | { ok: true; pid: number }
  | { ok: false; message: string };

export type ManagedZmxAttachResult =
  | { ok: true }
  | { ok: false; message: string };

function runProbe(
  name: string,
  sessionId: string,
  deps: ManagedZmxAttachDeps,
): ZmxManagedSessionProbe {
  if (deps.probe) return deps.probe(name, sessionId);
  return ZmxBackend.probeManagedSession(name, sessionId, deps.env ?? zmxEnv());
}

function rejectedProbeMessage(name: string, probe: ZmxManagedSessionProbe): string {
  if (probe.state === 'missing') {
    return `ZMX session ${name} is no longer available.`;
  }
  if (probe.state === 'unknown') {
    return `Refusing to attach: ${probe.reason}`;
  }
  if (probe.state === 'incompatible') {
    const identity = probe.reason === 'transport-label'
      ? 'botmux.transport'
      : 'botmux.session';
    return `Refusing to attach: ZMX session ${name} has a mismatched ${identity} label.`;
  }
  return `Refusing to attach: ZMX session ${name} could not be verified.`;
}

/**
 * Freeze the exact PTY-root PID after proving both Botmux ownership labels for
 * the complete UUID. probeManagedSession itself samples the PID on both sides
 * of its label reads, so this cannot bind labels from one same-name generation
 * to the PID of another.
 */
export function freezeManagedZmxAttachTarget(
  name: string,
  sessionId: string,
  deps: ManagedZmxAttachDeps = {},
): FrozenManagedZmxAttach {
  const probe = runProbe(name, sessionId, deps);
  if (probe.state !== 'compatible') {
    return { ok: false, message: rejectedProbeMessage(name, probe) };
  }
  return { ok: true, pid: probe.pid };
}

/**
 * Re-prove both ownership labels and the frozen PID immediately before handing
 * the terminal to `zmx attach`. Any missing, unknown, mismatched, or replaced
 * target seen by this proof fails closed. ZMX's attach API remains name-based,
 * so an upstream-irreducible replacement race still exists after this proof
 * and before the attach process resolves the name.
 */
export function attachFrozenManagedZmxSession(
  name: string,
  sessionId: string,
  frozenPid: number,
  deps: ManagedZmxAttachDeps = {},
): ManagedZmxAttachResult {
  const probe = runProbe(name, sessionId, deps);
  if (probe.state !== 'compatible') {
    return { ok: false, message: rejectedProbeMessage(name, probe) };
  }
  if (probe.pid !== frozenPid) {
    return {
      ok: false,
      message: `Refusing to attach: ZMX session ${name} changed from PID ${frozenPid} to ${probe.pid}.`,
    };
  }

  const attached = deps.attach
    ? deps.attach(name)
    : spawnSync('zmx', ['attach', name, '/bin/sh', '-c', 'exit 75'], {
        stdio: 'inherit',
        env: deps.env ?? zmxEnv(),
      });
  if (attached.error) {
    return { ok: false, message: `Failed to attach ZMX session ${name}: ${attached.error.message}` };
  }
  if (attached.status !== 0) {
    return {
      ok: false,
      message: `ZMX attach for ${name} exited with status ${attached.status ?? 'unknown'}.`,
    };
  }
  return { ok: true };
}
