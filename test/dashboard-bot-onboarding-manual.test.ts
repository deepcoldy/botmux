import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotOnboardingManager } from '../src/dashboard/bot-onboarding.js';
import { assertUniqueBotProcessNames, botProcessName } from '../src/setup/bot-config-editor.js';

let tmpDir: string;
let botsJsonPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botmux-onboard-manual-'));
  botsJsonPath = join(tmpDir, 'bots.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BotOnboardingManager manual App ID / App Secret onboarding', () => {
  it('validates credentials and owner, persists Feishu bot with 0o600, live-starts, and never leaks appSecret', async () => {
    const startBotLive = vi.fn(async () => ({ ok: true, message: 'botmux-0 已上线' }));
    const validateCredentials = vi.fn(async () => ({ ok: true as const }));
    const detectUnusableOwners = vi.fn(async () => []);
    const secret = 'super-secret-value-987654';

    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials,
      detectUnusableOwners,
      startBotLive,
    });

    const job = mgr.start({
      registrationMode: 'manual',
      brand: 'feishu',
      appId: 'cli_a1b2c3d4e5',
      appSecret: secret,
      allowedUsers: ['owner@example.com'],
      appName: 'my-first-bot',
      cliId: 'claude-code',
      workingDir: tmpDir,
      dirMode: 'fixed',
    });
    await job.done;

    const snap = mgr.get(job.id)!;
    expect(snap.status).toBe('completed');
    expect(snap.registrationMode).toBe('manual');
    expect(snap.appId).toBe('cli_a1b2c3d4e5');
    expect(snap.brand).toBe('feishu');
    expect(snap.liveStarted).toBe(true);
    expect(snap.remainingSteps?.length).toBeGreaterThan(0);
    expect(JSON.stringify(snap)).not.toContain(secret);

    expect(validateCredentials).toHaveBeenCalledWith('cli_a1b2c3d4e5', secret, 'feishu');
    expect(detectUnusableOwners).toHaveBeenCalledWith('cli_a1b2c3d4e5', secret, 'feishu', ['owner@example.com']);
    expect(startBotLive).toHaveBeenCalledWith('cli_a1b2c3d4e5');

    const persisted = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      larkAppId: 'cli_a1b2c3d4e5',
      larkAppSecret: secret,
      cliId: 'claude-code',
      defaultWorkingDir: tmpDir,
      allowedUsers: ['owner@example.com'],
    });
    expect(persisted[0].brand).toBeUndefined();
    expect(statSync(botsJsonPath).mode & 0o777).toBe(0o600);
  });

  it('persists brand="lark" and Lark console links for international Lark apps', async () => {
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials: async () => ({ ok: true }),
      detectUnusableOwners: async () => [],
      startBotLive: async () => ({ ok: true }),
    });

    const job = mgr.start({
      registrationMode: 'manual',
      brand: 'lark',
      appId: 'cli_lark999',
      appSecret: 'lark-secret',
      allowedUsers: ['on_abc123'],
      cliId: 'claude-code',
      workingDir: tmpDir,
    });
    await job.done;

    const snap = mgr.get(job.id)!;
    expect(snap.status).toBe('completed');
    expect(snap.brand).toBe('lark');
    expect(snap.remainingSteps?.every(step => new URL(step.url).hostname === 'open.larksuite.com')).toBe(true);

    const persisted = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(persisted[0].brand).toBe('lark');
  });

  it('fails closed on invalid credentials without writing bots.json and redacts secret from error message', async () => {
    const secret = 'leak-test-secret-xyz';
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials: async () => ({
        ok: false,
        error: 'invalid_credentials',
        message: `Feishu rejected secret ${secret}`,
      }),
      detectUnusableOwners: vi.fn(async () => []),
      startBotLive: vi.fn(async () => ({ ok: true })),
    });

    const job = mgr.start({
      registrationMode: 'manual',
      appId: 'cli_badcred',
      appSecret: secret,
      allowedUsers: ['owner@example.com'],
      cliId: 'claude-code',
      workingDir: tmpDir,
    });
    await job.done;

    const snap = mgr.get(job.id)!;
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('credential_validation_failed');
    expect(snap.message).not.toContain(secret);
    expect(snap.message).toContain('[REDACTED]');
    expect(existsSync(botsJsonPath)).toBe(false);
  });

  it('fails closed on cross-app ou_ owner rejected by target app via owner-identity check', async () => {
    const startBotLive = vi.fn(async () => ({ ok: true }));
    const detectUnusableOwners = vi.fn(async () => ['ou_foreign_app_user']);

    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials: async () => ({ ok: true }),
      detectUnusableOwners,
      startBotLive,
    });

    const job = mgr.start({
      registrationMode: 'manual',
      appId: 'cli_targetapp',
      appSecret: 'target-secret',
      allowedUsers: ['ou_foreign_app_user'],
      cliId: 'claude-code',
      workingDir: tmpDir,
    });
    await job.done;

    const snap = mgr.get(job.id)!;
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('unusable_owner');
    expect(detectUnusableOwners).toHaveBeenCalledWith('cli_targetapp', 'target-secret', 'feishu', ['ou_foreign_app_user']);
    expect(existsSync(botsJsonPath)).toBe(false);
    expect(startBotLive).not.toHaveBeenCalled();
  });

  it('rejects missing owner, invalid appId, and cloneSourceAppId before calling remote APIs', async () => {
    const validateCredentials = vi.fn(async () => ({ ok: true as const }));
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials,
      detectUnusableOwners: async () => [],
    });

    const noOwner = mgr.start({
      registrationMode: 'manual',
      appId: 'cli_valid1',
      appSecret: 'secret',
      allowedUsers: [],
      workingDir: tmpDir,
    });
    await noOwner.done;
    expect(mgr.get(noOwner.id)?.error).toBe('no_owner');

    const badAppId = mgr.start({
      registrationMode: 'manual',
      appId: 'local_spoof',
      appSecret: 'secret',
      allowedUsers: ['owner@example.com'],
      workingDir: tmpDir,
    });
    await badAppId.done;
    expect(mgr.get(badAppId.id)?.error).toBe('invalid_app_id');

    const cloneAttempt = mgr.start({
      registrationMode: 'manual',
      appId: 'cli_valid2',
      appSecret: 'secret',
      allowedUsers: ['owner@example.com'],
      cloneSourceAppId: 'cli_other',
      workingDir: tmpDir,
    });
    await cloneAttempt.done;
    expect(mgr.get(cloneAttempt.id)?.error).toBe('manual_clone_unsupported');

    expect(validateCredentials).not.toHaveBeenCalled();
    expect(existsSync(botsJsonPath)).toBe(false);
  });

  it('rejects concurrent duplicate appId inside the file lock without overwriting the existing bot', async () => {
    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>(resolve => {
      markValidationStarted = resolve;
    });
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials: () => new Promise(resolve => {
        releaseValidation = () => resolve({ ok: true });
        markValidationStarted();
      }),
      detectUnusableOwners: async () => [],
    });

    const job = mgr.start({
      registrationMode: 'manual',
      appId: 'cli_racedup1',
      appSecret: 'new-secret',
      allowedUsers: ['owner@example.com'],
      workingDir: tmpDir,
    });

    await validationStarted;
    // Another writer commits the same appId while validation is in flight.
    writeFileSync(botsJsonPath, JSON.stringify([
      { larkAppId: 'cli_racedup1', larkAppSecret: 'original-secret', allowedUsers: ['first@example.com'] },
    ], null, 2));
    releaseValidation();
    await job.done;

    const snap = mgr.get(job.id)!;
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('duplicate_app');
    const persisted = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].larkAppSecret).toBe('original-secret');
  });

  it('survives non-array or corrupt bots.json at boot and fails closed upfront without overwriting it', async () => {
    for (const raw of ['{ corrupted json', '{}', '"not-an-array"', '[{"larkAppId":""}]']) {
      writeFileSync(botsJsonPath, raw);
      const mgr = new BotOnboardingManager({
        botsJsonPath,
        validateCredentials: vi.fn(async () => ({ ok: true as const })),
        detectUnusableOwners: vi.fn(async () => []),
      });
      // Give startup reconciliation microtask a tick to ensure no unhandled rejection.
      await new Promise(resolve => setTimeout(resolve, 10));

      const manual = mgr.start({
        registrationMode: 'manual',
        appId: 'cli_ok1',
        appSecret: 'secret',
        allowedUsers: ['owner@example.com'],
        workingDir: tmpDir,
      });
      await manual.done;
      expect(mgr.get(manual.id)?.status).toBe('failed');
      expect(mgr.get(manual.id)?.error).toBe('invalid_bots_json');
      expect(readFileSync(botsJsonPath, 'utf-8')).toBe(raw);

      const local = mgr.start({
        registrationMode: 'local',
        appName: 'local-test',
        cliId: 'claude-code',
        workingDir: tmpDir,
      });
      await local.done;
      expect(mgr.get(local.id)?.status).toBe('failed');
      expect(mgr.get(local.id)?.error).toBe('invalid_bots_json');
      expect(readFileSync(botsJsonPath, 'utf-8')).toBe(raw);
    }
  });

  it('persists free-text appName in displayName only so reserved or duplicate names never break process naming', async () => {
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials: async () => ({ ok: true }),
      detectUnusableOwners: async () => [],
      startBotLive: async () => ({ ok: true }),
    });

    for (const [appId, appName] of [
      ['cli_reserved1', 'dashboard'],
      ['cli_reserved2', 'plugin-foo'],
      ['cli_dupname1', 'mybot'],
      ['cli_dupname2', 'mybot'],
    ] as const) {
      const job = mgr.start({
        registrationMode: 'manual',
        appId,
        appSecret: 'secret',
        allowedUsers: ['owner@example.com'],
        appName,
        cliId: 'claude-code',
        workingDir: tmpDir,
      });
      await job.done;
      expect(mgr.get(job.id)?.status).toBe('completed');
    }

    const persisted = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(persisted).toHaveLength(4);
    expect(() => assertUniqueBotProcessNames(persisted)).not.toThrow();
    expect(persisted.map((b: any, i: number) => botProcessName(b, i))).toEqual([
      'botmux-0',
      'botmux-1',
      'botmux-2',
      'botmux-3',
    ]);
    expect(persisted[0].name).toBeUndefined();
    expect(persisted[0].displayName).toBe('dashboard');
  });

  it('closes TOCTOU gap when bots.json becomes structurally invalid during async credential validation', async () => {
    for (const corruptPayload of ['[{"larkAppId":""}]', '{}']) {
      rmSync(botsJsonPath, { force: true });
      let releaseValidation!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });

      const mgr = new BotOnboardingManager({
        botsJsonPath,
        validateCredentials: () => new Promise(resolve => {
          releaseValidation = () => resolve({ ok: true });
          markStarted();
        }),
        detectUnusableOwners: async () => [],
      });

      const job = mgr.start({
        registrationMode: 'manual',
        appId: 'cli_toctou1',
        appSecret: 'sec',
        allowedUsers: ['owner@example.com'],
        workingDir: tmpDir,
      });
      await started;
      writeFileSync(botsJsonPath, corruptPayload);
      releaseValidation();
      await job.done;

      expect(mgr.get(job.id)?.status).toBe('failed');
      expect(mgr.get(job.id)?.error).toBe('invalid_bots_json');
      expect(readFileSync(botsJsonPath, 'utf-8')).toBe(corruptPayload);
    }
  });

  it('rejects loader-invalid bots.json entries (sandboxNetwork, mojo.localDaemon, cliLaunchMode) without overwriting', async () => {
    const loaderInvalidPayloads = [
      JSON.stringify([{ larkAppId: 'cli_a', larkAppSecret: 's', sandboxNetwork: 'false' }]),
      JSON.stringify([{ larkAppId: 'cli_a', larkAppSecret: 's', mojo: { localDaemon: 'false' } }]),
      JSON.stringify([{ larkAppId: 'cli_a', larkAppSecret: 's', cliLaunchMode: 'not-a-mode' }]),
    ];
    for (const raw of loaderInvalidPayloads) {
      writeFileSync(botsJsonPath, raw);
      const mgr = new BotOnboardingManager({
        botsJsonPath,
        validateCredentials: vi.fn(async () => ({ ok: true as const })),
        detectUnusableOwners: vi.fn(async () => []),
      });
      const job = mgr.start({
        registrationMode: 'manual',
        appId: 'cli_newvalid1',
        appSecret: 'sec',
        allowedUsers: ['owner@example.com'],
        workingDir: tmpDir,
      });
      await job.done;
      expect(mgr.get(job.id)?.status).toBe('failed');
      expect(mgr.get(job.id)?.error).toBe('invalid_bots_json');
      expect(readFileSync(botsJsonPath, 'utf-8')).toBe(raw);
    }
  });

  it('reconciles uncertain post-rename coordinator failures in manual onboarding without stranding on duplicate_app', async () => {
    const startBotLive = vi.fn(async () => ({ ok: true, message: 'botmux-0 已上线' }));
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials: async () => ({ ok: true }),
      detectUnusableOwners: async () => [],
      startBotLive,
      runBotsMutation: async mutation => {
        // File write + rename succeeds, then coordinator post-commit throws.
        await mutation();
        throw new Error('coordinator commit ack lost');
      },
    });

    const job = mgr.start({
      registrationMode: 'manual',
      appId: 'cli_reconcile1',
      appSecret: 'sec-reconcile',
      allowedUsers: ['owner@example.com'],
      cliId: 'claude-code',
      workingDir: tmpDir,
      dirMode: 'fixed',
    });
    await job.done;

    const snap = mgr.get(job.id)!;
    expect(snap.status).toBe('completed');
    expect(snap.addedBotIndex).toBe(0);
    expect(startBotLive).toHaveBeenCalledWith('cli_reconcile1');
    const persisted = JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].larkAppId).toBe('cli_reconcile1');
  });

  it('does not treat a concurrently drifted local record as an exact uncertain-commit match', async () => {
    const startBotLive = vi.fn(async () => ({ ok: true }));
    const mgr = new BotOnboardingManager({
      botsJsonPath,
      startBotLive,
      runBotsMutation: async mutation => {
        await mutation();
        const drifted = JSON.parse(readFileSync(botsJsonPath, 'utf8'));
        drifted[0].defaultWorkingDir = join(tmpDir, 'drifted-working-dir');
        drifted[0].model = 'drifted-model';
        writeFileSync(botsJsonPath, JSON.stringify(drifted, null, 2));
        throw new Error('coordinator commit ack lost');
      },
    });

    const job = mgr.start({
      registrationMode: 'local',
      appName: 'local-exact-record',
      cliId: 'riff',
      workingDir: tmpDir,
      dirMode: 'fixed',
      model: 'original-model',
    });
    await job.done;

    expect(mgr.get(job.id)?.status).toBe('failed');
    expect(startBotLive).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(botsJsonPath, 'utf8'));
    expect(persisted[0]).toMatchObject({
      defaultWorkingDir: join(tmpDir, 'drifted-working-dir'),
      model: 'drifted-model',
    });
  });

  it('cancels an in-flight QR onboarding job cooperatively so late QR resolution never writes bots.json or starts a bot', async () => {
    let releaseCreateApp!: () => void;
    let receivedSignal: AbortSignal | undefined;
    const validateCredentials = vi.fn(async () => ({ ok: true as const }));
    const startBotLive = vi.fn(async () => ({ ok: true }));
    let qrReady!: () => void;
    const waitForQr = new Promise<void>(resolve => { qrReady = resolve; });

    const mgr = new BotOnboardingManager({
      botsJsonPath,
      validateCredentials,
      startBotLive,
      createApp: async opts => {
        receivedSignal = opts.signal;
        await opts.onQrCode?.({ qrText: 'QR', qrPayload: 'https://feishu.cn/qr/test' });
        qrReady();
        await new Promise<void>(resolve => { releaseCreateApp = resolve; });
        return {
          ok: true,
          appId: 'cli_late_qr1',
          appSecret: 'sec-late',
          brand: 'feishu',
          sessionFile: join(tmpDir, 'feishu-session.json'),
          sessionSource: 'qr_login',
          sessionIdentity: {
            userId: 'u1',
            userName: 'Alice',
            email: 'alice@example.com',
            tenantId: 't1',
            tenantName: 'Corp',
          },
        };
      },
    });

    const job = mgr.start({
      registrationMode: 'web',
      cliId: 'claude-code',
      workingDir: tmpDir,
    });
    await waitForQr;
    expect(mgr.get(job.id)?.status).toBe('waiting_for_scan');

    const cancelled = mgr.cancel(job.id);
    expect(cancelled.ok).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(mgr.get(job.id)?.status).toBe('failed');
    expect(mgr.get(job.id)?.error).toBe('cancelled');
    expect(mgr.get(job.id)?.qrDataUrl).toBeUndefined();

    // Even if the remote QR poll later resolves with valid credentials, nothing is persisted or started.
    releaseCreateApp();
    await job.done;
    expect(validateCredentials).not.toHaveBeenCalled();
    expect(startBotLive).not.toHaveBeenCalled();
    expect(existsSync(botsJsonPath)).toBe(false);
    expect(mgr.get(job.id)?.error).toBe('cancelled');
  });
});
