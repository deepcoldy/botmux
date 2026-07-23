import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isManagedAgentDeviceCommandContext,
  runDeviceCommand,
  type DeviceEnrollmentApi,
} from '../src/platform/device-command.js';
import { DeviceIsolationDaemonActivationError } from '../src/platform/device-isolation-activation-client.js';

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-command-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('botmux device host command', () => {
  const isolationReady = {
    isolationSupported: () => true,
    activateIsolation: async () => ({ activated: true, daemonCount: 1 }),
  };

  it('detects detached managed sessions from BOTMUX_SESSION_ID', () => {
    const dataDir = tempHome();
    expect(isManagedAgentDeviceCommandContext({
      dataDir,
      env: { BOTMUX_SESSION_ID: 'session-secret' },
    })).toBe(true);
    expect(isManagedAgentDeviceCommandContext({ dataDir, env: {} })).toBe(false);
  });

  it('rejects a managed agent context before reading binding or credentials', async () => {
    const readBinding = vi.fn();
    const output: string[] = [];
    const code = await runDeviceCommand(['enroll'], {
      isAgentContext: () => true,
      readBinding,
      stdout: line => output.push(line),
      stderr: line => output.push(line),
    });
    expect(code).toBe(2);
    expect(readBinding).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('宿主终端');
  });

  it('enrolls, writes 0600, and never prints any machine/grant/device secret', async () => {
    const homeDir = tempHome();
    const output: string[] = [];
    const api: DeviceEnrollmentApi = {
      issuer: 'https://platform.example.test',
      beginEnrollment: vi.fn(async () => ({
        grantId: 'grant-secret', pollSecret: 'poll-secret', expiresAt: 1_900_000_000_000,
      })),
      waitForEnrollment: vi.fn(async () => ({
        accessToken: 'access-secret',
        accessExpiresAt: 1_800_000_000_000,
        refreshToken: 'refresh-secret',
        deviceExp: 1_900_000_000_000,
      })),
    };

    const code = await runDeviceCommand(['enroll', '--name', 'Work Mac'], {
      ...isolationReady,
      homeDir,
      isAgentContext: () => false,
      readBinding: () => ({
        platformUrl: 'https://platform.example.test',
        machineId: 'machine-1',
        machineToken: 'machine-secret',
      }),
      createClient: () => api,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
      stdout: line => output.push(line),
      stderr: line => output.push(line),
    });

    expect(code).toBe(0);
    expect(api.beginEnrollment).toHaveBeenCalledWith({
      machineToken: 'machine-secret',
      deviceName: 'Work Mac',
      deviceKind: 'desktop-ide',
    });
    const rendered = output.join('\n');
    for (const secret of ['machine-secret', 'grant-secret', 'poll-secret', 'access-secret', 'refresh-secret']) {
      expect(rendered).not.toContain(secret);
    }
    if (process.platform !== 'win32') {
      expect(lstatSync(join(homeDir, '.botmux', 'device-auth', 'device.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('prints a stable token-free JSON status for Electron and logout is idempotent', async () => {
    const homeDir = tempHome();
    const api: DeviceEnrollmentApi = {
      issuer: 'https://platform.example.test',
      beginEnrollment: async () => ({ grantId: 'g', pollSecret: 'p', expiresAt: 1_900_000_000_000 }),
      waitForEnrollment: async () => ({
        accessToken: 'access-secret', accessExpiresAt: 1_800_000_000_000,
        refreshToken: 'refresh-secret', deviceExp: 1_900_000_000_000,
      }),
    };
    await runDeviceCommand(['enroll'], {
      ...isolationReady,
      homeDir,
      isAgentContext: () => false,
      hostName: () => 'Host',
      readBinding: () => ({
        platformUrl: api.issuer, machineId: 'm', machineToken: 'machine-secret',
      }),
      createClient: () => api,
      stdout: () => {}, stderr: () => {},
    });

    const statusOut: string[] = [];
    expect(await runDeviceCommand(['status', '--json'], {
      homeDir,
      isAgentContext: () => false,
      stdout: line => statusOut.push(line),
      stderr: line => statusOut.push(line),
    })).toBe(0);
    expect(statusOut).toHaveLength(1);
    expect(JSON.parse(statusOut[0])).toMatchObject({
      schemaVersion: 1,
      enrolled: true,
      issuer: 'https://platform.example.test',
      deviceExp: 1_900_000_000_000,
    });
    expect(statusOut[0]).not.toContain('access-secret');
    expect(statusOut[0]).not.toContain('refresh-secret');

    expect(await runDeviceCommand(['logout'], {
      homeDir, isAgentContext: () => false, stdout: () => {}, stderr: () => {},
    })).toBe(0);
    expect(await runDeviceCommand(['logout'], {
      homeDir, isAgentContext: () => false, stdout: () => {}, stderr: () => {},
    })).toBe(0);
  });

  it('fails closed without a machine binding', async () => {
    const output: string[] = [];
    expect(await runDeviceCommand(['enroll'], {
      ...isolationReady,
      homeDir: tempHome(),
      isAgentContext: () => false,
      readBinding: () => null,
      stdout: line => output.push(line),
      stderr: line => output.push(line),
    })).toBe(1);
    expect(output.join('\n')).toContain('尚未绑定平台');
  });

  it('refuses before grant creation when daemon quiescence cannot be proven', async () => {
    const beginEnrollment = vi.fn();
    const output: string[] = [];
    expect(await runDeviceCommand(['enroll'], {
      homeDir: tempHome(),
      isAgentContext: () => false,
      isolationSupported: () => true,
      activateIsolation: async () => {
        throw new DeviceIsolationDaemonActivationError('旧会话尚未安全清退');
      },
      readBinding: () => ({
        platformUrl: 'https://platform.example.test',
        machineId: 'm',
        machineToken: 'machine-secret',
      }),
      createClient: () => ({
        issuer: 'https://platform.example.test',
        beginEnrollment,
        waitForEnrollment: vi.fn(),
      }),
      stdout: line => output.push(line),
      stderr: line => output.push(line),
    })).toBe(1);
    expect(beginEnrollment).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('旧会话尚未安全清退');
  });
});
