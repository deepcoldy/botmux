import { describe, it, expect } from 'bun:test';
import {
  projectSessionEventForAudience,
  projectSessionsForAudience,
  redactGroupsForPublic,
  redactSchedulesForPublic,
  redactSessionEventForPublic,
  redactSessionsForPublic,
  redactSettingsForPublic,
  sessionBoardAudienceFor,
} from '../src/dashboard/public-redact.js';

// A representative slice of the /api/groups `chats` payload that dashboard.ts
// builds (memberBots[].oncallChat = { chatId, workingDir } for bound bots).
function sampleChats() {
  return [
    {
      chatId: 'oc_chat1',
      name: '客户群 A',
      chatMode: 'group',
      avatar: 'https://avatar.example/chat1.png',
      description: 'private description',
      ownerId: 'ou_owner',
      memberBots: [
        {
          larkAppId: 'cli_a',
          botName: 'Claude',
          inChat: true,
          hasRole: true,
          pinStreamingCardMasterEnabled: true,
          pinStreamingCardChatEnabled: false,
          pinStreamingCardEffectiveEnabled: false,
          oncallChat: { chatId: 'oc_chat1', workingDir: '/root/iserver/customer-secret' },
        },
        {
          larkAppId: 'cli_b',
          botName: 'Codex',
          inChat: false,
          hasRole: false,
          pinStreamingCardMasterEnabled: false,
          pinStreamingCardChatEnabled: true,
          pinStreamingCardEffectiveEnabled: false,
          oncallChat: null,
        },
      ],
    },
  ];
}

function sampleSchedules() {
  return [
    {
      id: 'sch1',
      name: '每日构建',
      enabled: true,
      nextRunAt: '2026-06-07T01:00:00Z',
      lastStatus: 'ok',
      prompt: '部署到 /root/iserver/customer-secret 并通知客户',
      workingDir: '/root/iserver/customer-secret',
      chatId: 'oc_chat1',
    },
  ];
}

describe('redactGroupsForPublic', () => {
  it('drops ALL non-board fields for anonymous visitors (oncall/description/ownerId/hasRole)', () => {
    const out = redactGroupsForPublic(sampleChats()) as any[];
    // chat-level config/PII gone
    expect(out[0]).not.toHaveProperty('description');
    expect(out[0]).not.toHaveProperty('ownerId');
    // per-bot oncall binding + role-existence matrix gone
    for (const mb of out[0].memberBots) {
      expect(mb).not.toHaveProperty('oncallChat');
      expect(mb).not.toHaveProperty('hasRole');
    }
    const json = JSON.stringify(out);
    for (const leaked of ['workingDir', 'customer-secret', 'private description', 'ou_owner']) {
      expect(json).not.toContain(leaked);
    }
  });

  it('keeps exactly the board name-map / roster fields (explicit allow-list)', () => {
    const out = redactGroupsForPublic(sampleChats()) as any[];
    expect(out).toEqual([
      {
        chatId: 'oc_chat1',
        name: '客户群 A',
        chatMode: 'group',
        avatar: 'https://avatar.example/chat1.png',
        memberBots: [
          {
            larkAppId: 'cli_a',
            botName: 'Claude',
            inChat: true,
          },
          {
            larkAppId: 'cli_b',
            botName: 'Codex',
            inChat: false,
          },
        ],
      },
    ]);
  });

  it('drops pin-streaming-card booleans for anonymous visitors while still stripping private config fields', () => {
    const [out] = redactGroupsForPublic(sampleChats()) as any[];
    expect(out.memberBots[0]).not.toHaveProperty('pinStreamingCardMasterEnabled');
    expect(out.memberBots[0]).not.toHaveProperty('pinStreamingCardChatEnabled');
    expect(out.memberBots[0]).not.toHaveProperty('pinStreamingCardEffectiveEnabled');
    expect(out.memberBots[1]).not.toHaveProperty('pinStreamingCardMasterEnabled');
    expect(out.memberBots[1]).not.toHaveProperty('pinStreamingCardChatEnabled');
    expect(out.memberBots[1]).not.toHaveProperty('pinStreamingCardEffectiveEnabled');
    expect(out.memberBots[0]).not.toHaveProperty('oncallChat');
    expect(out.memberBots[0]).not.toHaveProperty('hasRole');
  });

  it('never leaks per-bot permission config even if a roster row starts carrying it', () => {
    // p2pOpen (私聊对话全开) is admin-only Bot Defaults config. The roster today
    // is built from botSummaryPayload, which does not carry it — this pins the
    // allow-list so a future upstream change to the roster shape cannot make an
    // anonymous visitor able to read which bots accept DMs from anyone.
    const chats = sampleChats();
    (chats[0].memberBots[0] as Record<string, unknown>).p2pOpen = true;
    const out = redactGroupsForPublic(chats) as any[];
    expect(out[0].memberBots[0]).not.toHaveProperty('p2pOpen');
    expect(JSON.stringify(out)).not.toContain('p2pOpen');
  });

  it('does not mutate the input (authed callers keep the original oncallChat/description)', () => {
    const input = sampleChats();
    redactGroupsForPublic(input);
    expect(input[0].memberBots[0].oncallChat).toEqual({ chatId: 'oc_chat1', workingDir: '/root/iserver/customer-secret' });
    expect(input[0].description).toBe('private description');
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(redactGroupsForPublic([])).toEqual([]);
    // junk fields are dropped; only allow-listed keys survive
    expect(redactGroupsForPublic([{ chatId: 'x', secret: 'y' }] as unknown[])).toEqual([{ chatId: 'x' }]);
    expect(redactGroupsForPublic(null as unknown as unknown[])).toBeNull();
  });
});

describe('redactSchedulesForPublic', () => {
  it('strips prompt + workingDir for anonymous visitors', () => {
    const out = redactSchedulesForPublic(sampleSchedules()) as any[];
    expect(out[0]).not.toHaveProperty('prompt');
    expect(out[0]).not.toHaveProperty('workingDir');
    expect(JSON.stringify(out)).not.toContain('customer-secret');
  });

  it('preserves name / timing / status fields', () => {
    const out = redactSchedulesForPublic(sampleSchedules()) as any[];
    expect(out[0]).toEqual({
      id: 'sch1',
      name: '每日构建',
      enabled: true,
      nextRunAt: '2026-06-07T01:00:00Z',
      lastStatus: 'ok',
      chatId: 'oc_chat1',
    });
  });

  it('does not mutate the input (authed callers keep prompt + workingDir)', () => {
    const input = sampleSchedules();
    redactSchedulesForPublic(input);
    expect(input[0]).toHaveProperty('prompt');
    expect(input[0].workingDir).toBe('/root/iserver/customer-secret');
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(redactSchedulesForPublic([])).toEqual([]);
    expect(redactSchedulesForPublic([null] as unknown[])).toEqual([null]);
    expect(redactSchedulesForPublic(undefined as unknown as unknown[])).toBeUndefined();
  });
});

describe('session presentation redaction', () => {
  const session = {
    sessionId: 's1',
    workingDir: '/repo/customer-a',
    repoName: 'customer-a',
    gitBranch: 'issue/CUSTOMER-123',
    botAvatarUrl: 'https://img.example/bot.png',
    preview: { path: '/preview/s1/', registeredAt: '2026-08-11T12:00:00.000Z' },
    previewTarget: { host: '127.0.0.1', port: 4173, registeredAt: '2026-08-11T12:00:00.000Z' },
    previewUserText: 'private question',
    previewBotText: 'private answer',
    previewUserFullText: 'private question in full',
    previewBotFullText: 'private answer in full',
    previewUserAt: 100,
    previewBotAt: 200,
    previewBotState: 'replied',
  };

  it('strips branch names from anonymous REST rows without mutating authenticated data', () => {
    const out = redactSessionsForPublic([session]) as any[];
    expect(out[0]).toMatchObject({
      sessionId: 's1',
      workingDir: '/repo/customer-a',
      repoName: 'customer-a',
      botAvatarUrl: 'https://img.example/bot.png',
    });
    expect(out[0]).not.toHaveProperty('gitBranch');
    expect(out[0]).not.toHaveProperty('preview');
    expect(out[0]).not.toHaveProperty('previewTarget');
    expect(out[0]).not.toHaveProperty('previewUserText');
    expect(out[0]).not.toHaveProperty('previewBotText');
    expect(out[0]).not.toHaveProperty('previewUserFullText');
    expect(out[0]).not.toHaveProperty('previewBotFullText');
    expect(out[0]).not.toHaveProperty('previewUserAt');
    expect(out[0]).not.toHaveProperty('previewBotAt');
    expect(out[0]).not.toHaveProperty('previewBotState');
    expect(session.gitBranch).toBe('issue/CUSTOMER-123');
  });

  it('applies the same policy to spawned and update SSE bodies', () => {
    const spawned = redactSessionEventForPublic('session.spawned', { session }) as any;
    expect(spawned.session).not.toHaveProperty('gitBranch');

    const updateBody = {
      sessionId: 's1',
      patch: {
        gitBranch: 'issue/CUSTOMER-456',
        repoName: 'customer-a',
        preview: { path: '/preview/s1/' },
        previewTarget: { host: '127.0.0.1', port: 4173 },
        previewUserText: 'private question',
        previewBotText: 'private answer',
        previewBotState: 'replied',
      },
    };
    const updated = redactSessionEventForPublic('session.update', updateBody) as any;
    expect(updated.patch).toEqual({ repoName: 'customer-a' });
    expect(updateBody.patch.gitBranch).toBe('issue/CUSTOMER-456');
  });

  it('keeps concrete CLI runtime identity private in REST rows and SSE bodies', () => {
    const runtimeSession = {
      sessionId: 's-runtime',
      cliId: 'codex',
      runtimeId: 'internal-vendor-codex',
      runtimeDisplayName: 'Internal Vendor Codex',
      status: 'working',
    };

    const [rest] = redactSessionsForPublic([runtimeSession]) as any[];
    expect(rest).toEqual({ sessionId: 's-runtime', cliId: 'codex', status: 'working' });

    const spawned = redactSessionEventForPublic('session.spawned', { session: runtimeSession }) as any;
    expect(spawned.session).toEqual({ sessionId: 's-runtime', cliId: 'codex', status: 'working' });

    const updated = redactSessionEventForPublic('session.update', {
      sessionId: 's-runtime',
      patch: {
        runtimeId: 'internal-vendor-codex',
        runtimeDisplayName: 'Internal Vendor Codex',
        status: 'idle',
      },
    }) as any;
    expect(updated.patch).toEqual({ status: 'idle' });
  });

  it('strips the Riff sandbox write URL from anonymous REST rows without mutating authenticated data', () => {
    // riffAccessUrl is a bearer WRITE capability (the unique sandbox subdomain
    // IS the credential). An anonymous read-only visitor must never receive it,
    // or the public board would hand out write access to the sandbox. Read
    // access stays available via the local worker log terminal (webPort).
    const riffSession = { sessionId: 's-riff', webPort: 3007, riffAccessUrl: 'https://abc123.sandbox.example/term' };
    const out = redactSessionsForPublic([riffSession]) as any[];
    expect(out[0]).toMatchObject({ sessionId: 's-riff', webPort: 3007 });
    expect(out[0]).not.toHaveProperty('riffAccessUrl');
    expect(riffSession.riffAccessUrl).toBe('https://abc123.sandbox.example/term');
  });

  it('strips riffAccessUrl from spawned and update SSE bodies', () => {
    const riffSession = { sessionId: 's-riff', webPort: 3007, riffAccessUrl: 'https://abc123.sandbox.example/term' };
    const spawned = redactSessionEventForPublic('session.spawned', { session: riffSession }) as any;
    expect(spawned.session).not.toHaveProperty('riffAccessUrl');
    expect(spawned.session).toMatchObject({ sessionId: 's-riff', webPort: 3007 });

    const updateBody = { sessionId: 's-riff', patch: { riffAccessUrl: 'https://def456.sandbox.example/term', webPort: 3007 } };
    const updated = redactSessionEventForPublic('session.update', updateBody) as any;
    expect(updated.patch).toEqual({ webPort: 3007 });
    expect(updateBody.patch.riffAccessUrl).toBe('https://def456.sandbox.example/term');
  });

  it('strips openTodos (task-state plaintext from transcripts) from anonymous REST rows and SSE bodies', () => {
    // openTodos.items[].text is CLI transcript plaintext — equivalent to preview
    // content. Anonymous read-only visitors must not receive it (they get no TODO
    // badge); the field is entirely blacklisted, both in the full REST projection
    // and in incremental SSE patches (where worker-pool publishes openTodos on
    // every runtime status edge).
    const todoSession = {
      sessionId: 's-todo',
      status: 'idle',
      openTodos: { total: 3, done: 1, remaining: 2, hasInProgress: true, items: [{ status: 'in_progress', text: 'secret task text' }] },
    };
    const rest = redactSessionsForPublic([todoSession]) as any[];
    expect(rest[0]).toEqual({ sessionId: 's-todo', status: 'idle' });
    expect(todoSession.openTodos.remaining).toBe(2);

    const spawned = redactSessionEventForPublic('session.spawned', { session: todoSession }) as any;
    expect(spawned.session).not.toHaveProperty('openTodos');

    const updateBody = { sessionId: 's-todo', patch: { status: 'working', openTodos: { total: 1, done: 0, remaining: 1, hasInProgress: false, items: [{ status: 'pending', text: 'x' }] } } };
    const updated = redactSessionEventForPublic('session.update', updateBody) as any;
    expect(updated.patch).toEqual({ status: 'working' });
  });

  it('fails closed for future preview-prefixed fields on anonymous REST and SSE surfaces', () => {
    const future = {
      sessionId: 's-future',
      status: 'idle',
      previewUserMarkdown: 'future private user field',
      previewBotRichText: 'future private bot field',
    };
    const rest = redactSessionsForPublic([future]) as any[];
    expect(rest[0]).toEqual({ sessionId: 's-future', status: 'idle' });

    const update = redactSessionEventForPublic('session.update', {
      sessionId: 's-future',
      patch: {
        status: 'working',
        previewUserMarkdown: 'future private patch',
      },
    }) as any;
    expect(update.patch).toEqual({ status: 'working' });
  });
});

// Regression: `/api/sessions` and `/events` used to gate their projection on
// "holds the local management cookie", so an authenticated Feishu H5 / platform
// Workbench identity was served the ANONYMOUS projection. That deleted the very
// `preview` descriptor its own `preview.view` / `preview.operate` capabilities
// operate on, and the mobile Workbench + Dock rendered 「无网页预览」 forever.
describe('session board audience (H5/Workbench identity is not anonymous)', () => {
  // Everything a session row can carry that the anonymous projection strips.
  function boardSession() {
    return {
      sessionId: 's1',
      status: 'working',
      cliId: 'claude',
      webPort: 3007,
      gitBranch: 'issue/CUSTOMER-123',
      runtimeId: 'internal-vendor-codex',
      runtimeDisplayName: 'Internal Vendor Codex',
      preview: { path: '/preview/s1/', registeredAt: '2026-08-11T12:00:00.000Z' },
      previewUserText: 'private question',
      previewBotText: 'private answer',
      previewUserFullText: 'private question in full',
      previewBotFullText: 'private answer in full',
      previewUserAt: 100,
      previewBotAt: 200,
      previewBotState: 'replied',
      openTodos: { total: 3, done: 1, remaining: 2, hasInProgress: true, items: [{ status: 'in_progress', text: 'task text' }] },
      riffAccessUrl: 'https://abc123.sandbox.example/term',
    };
  }

  describe('sessionBoardAudienceFor', () => {
    it('maps the local management cookie to `management` (H5 flag is irrelevant)', () => {
      expect(sessionBoardAudienceFor({ legacyAuthed: true, workbenchIdentity: false })).toBe('management');
      expect(sessionBoardAudienceFor({ legacyAuthed: true, workbenchIdentity: true })).toBe('management');
    });

    it('maps an authenticated H5 / platform-dashboard identity to `workbench`, NOT anonymous', () => {
      expect(sessionBoardAudienceFor({ legacyAuthed: false, workbenchIdentity: true })).toBe('workbench');
    });

    it('maps a tokenless publicReadOnly visitor to `anonymous`', () => {
      expect(sessionBoardAudienceFor({ legacyAuthed: false, workbenchIdentity: false })).toBe('anonymous');
    });
  });

  it('hands the H5 identity the preview descriptor the anonymous board never gets', () => {
    const session = boardSession();
    const [workbench] = projectSessionsForAudience([session], 'workbench') as any[];
    // The point of the fix: preview.view / preview.operate have something to act on.
    expect(workbench.preview).toEqual({ path: '/preview/s1/', registeredAt: '2026-08-11T12:00:00.000Z' });

    const [anon] = projectSessionsForAudience([session], 'anonymous') as any[];
    expect(anon).not.toHaveProperty('preview');
  });

  it('restores every display field for the H5 identity while anonymous keeps losing them', () => {
    const session = boardSession();
    const [workbench] = projectSessionsForAudience([session], 'workbench') as any[];
    for (const [field, value] of [
      ['gitBranch', 'issue/CUSTOMER-123'],
      ['runtimeId', 'internal-vendor-codex'],
      ['runtimeDisplayName', 'Internal Vendor Codex'],
      ['previewUserText', 'private question'],
      ['previewBotText', 'private answer'],
      ['previewUserFullText', 'private question in full'],
      ['previewBotFullText', 'private answer in full'],
      ['previewUserAt', 100],
      ['previewBotAt', 200],
      ['previewBotState', 'replied'],
    ] as const) {
      expect(workbench[field], field).toEqual(value);
    }
    expect(workbench.openTodos).toEqual(session.openTodos);

    const [anon] = projectSessionsForAudience([session], 'anonymous') as any[];
    for (const field of [
      'gitBranch', 'runtimeId', 'runtimeDisplayName', 'previewUserText', 'previewBotText',
      'previewUserFullText', 'previewBotFullText', 'previewUserAt', 'previewBotAt',
      'previewBotState', 'openTodos',
    ]) {
      expect(anon, field).not.toHaveProperty(field);
    }
    // Anonymous keeps exactly the watch-board fields it always had.
    expect(anon).toEqual({ sessionId: 's1', status: 'working', cliId: 'claude', webPort: 3007 });
  });

  it('still withholds the Riff sandbox bearer WRITE url from the Workbench identity', () => {
    // riffAccessUrl is a credential, not a display field: the unique subdomain IS
    // the write capability. `GET /api/sessions/:id/write-link` is deliberately
    // absent from workbenchH5Capability, and terminal writes are arbitrated by a
    // server-side single-writer lease — the sandbox URL would bypass both.
    const session = boardSession();
    const [workbench] = projectSessionsForAudience([session], 'workbench') as any[];
    expect(workbench).not.toHaveProperty('riffAccessUrl');
    expect(JSON.stringify(workbench)).not.toContain('abc123.sandbox.example');
    // The read path the Workbench actually uses survives.
    expect(workbench.webPort).toBe(3007);

    // Only the local management cookie sees it.
    const [management] = projectSessionsForAudience([session], 'management') as any[];
    expect(management.riffAccessUrl).toBe('https://abc123.sandbox.example/term');
  });

  it('applies the identical audience rule to SSE spawned rows and update patches', () => {
    const session = boardSession();
    const spawned = projectSessionEventForAudience('session.spawned', { session }, 'workbench') as any;
    expect(spawned.session.preview).toEqual(session.preview);
    expect(spawned.session.gitBranch).toBe('issue/CUSTOMER-123');
    expect(spawned.session).not.toHaveProperty('riffAccessUrl');

    // A live patch must not take back what the initial REST fetch delivered,
    // otherwise the preview pane goes blank on the first status edge.
    const updateBody = {
      sessionId: 's1',
      patch: {
        status: 'idle',
        preview: { path: '/preview/s1/', registeredAt: '2026-08-11T12:05:00.000Z' },
        previewBotText: 'private answer',
        gitBranch: 'issue/CUSTOMER-456',
        riffAccessUrl: 'https://def456.sandbox.example/term',
      },
    };
    const updated = projectSessionEventForAudience('session.update', updateBody, 'workbench') as any;
    expect(updated.patch).toEqual({
      status: 'idle',
      preview: { path: '/preview/s1/', registeredAt: '2026-08-11T12:05:00.000Z' },
      previewBotText: 'private answer',
      gitBranch: 'issue/CUSTOMER-456',
    });

    const anonUpdate = projectSessionEventForAudience('session.update', updateBody, 'anonymous') as any;
    expect(anonUpdate.patch).toEqual({ status: 'idle' });
  });

  it('leaves management rows and non-session events completely untouched', () => {
    const session = boardSession();
    const sessions = [session];
    // Identity, not a copy: the management path must stay a pure pass-through.
    expect(projectSessionsForAudience(sessions, 'management')).toBe(sessions);

    const scheduleBody = { schedule: { id: 'sch1', prompt: 'business instructions' } };
    for (const audience of ['management', 'workbench', 'anonymous'] as const) {
      // Schedule prompts are gated separately (management-only) in dashboard.ts;
      // the session projector must not silently claim to handle them.
      expect(projectSessionEventForAudience('schedule.created', scheduleBody, audience)).toBe(scheduleBody);
    }
  });

  it('never mutates the caller rows when projecting for the Workbench', () => {
    const session = boardSession();
    projectSessionsForAudience([session], 'workbench');
    projectSessionEventForAudience('session.spawned', { session }, 'workbench');
    expect(session.riffAccessUrl).toBe('https://abc123.sandbox.example/term');
    expect(session.preview).toEqual({ path: '/preview/s1/', registeredAt: '2026-08-11T12:00:00.000Z' });
  });

  it('tolerates malformed shapes without throwing on any audience', () => {
    for (const audience of ['management', 'workbench', 'anonymous'] as const) {
      expect(() => projectSessionsForAudience([null, 'x', 42] as unknown[], audience)).not.toThrow();
      expect(projectSessionsForAudience('nope' as unknown as unknown[], audience)).toBe('nope');
      expect(projectSessionEventForAudience('session.spawned', null, audience)).toBeNull();
      expect(projectSessionEventForAudience('session.update', { sessionId: 's1' }, audience))
        .toEqual({ sessionId: 's1' });
    }
  });
});

describe('redactSettingsForPublic', () => {
  it('removes the complete notifier snapshot from tokenless settings', () => {
    const settings = {
      publicReadOnly: true,
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_codex',
        notifyWhen: 'always',
        platformSupported: true,
        hookInstalled: true,
        botOptions: [{
          larkAppId: 'cli_codex',
          botName: 'Codex',
          cliId: 'codex',
          recipientConfigured: true,
          recipientVerified: true,
          recipientHint: 'a***@example.com',
          futureSecret: 'private',
        }],
        targetDaemonOnline: true,
        pendingCount: 1,
        workerHeartbeatAt: '2026-07-24T01:02:03.000Z',
        workerOnline: true,
        lastError: {
          at: '2026-07-24T01:00:00.000Z',
          message: 'failed to read /Users/alice/private-repo',
          retryAt: '2026-07-24T01:01:00.000Z',
        },
        futureSecret: 'private',
      },
    };

    const out = redactSettingsForPublic(settings) as any;

    expect(out.publicReadOnly).toBe(true);
    expect(out.codexNotifier).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('a***@example.com');
    expect(JSON.stringify(out)).not.toContain('cli_codex');
    expect(JSON.stringify(out)).not.toContain('/Users/alice/private-repo');
    expect(settings.codexNotifier.botOptions[0].recipientHint).toBe('a***@example.com');
    expect(settings.codexNotifier.lastError).not.toBeNull();
  });

  it('tolerates missing or malformed settings shapes', () => {
    expect(redactSettingsForPublic(null)).toBeNull();
    expect(redactSettingsForPublic({ publicReadOnly: true })).toEqual({ publicReadOnly: true });
    expect(redactSettingsForPublic({ codexNotifier: 'private malformed value' })).toEqual({});
    expect(redactSettingsForPublic({
      codexNotifier: { botOptions: ['private malformed option'] },
    })).toEqual({});
  });

  it('removes the complete hostOverloadAlert snapshot (target bot + recipient hints) from tokenless settings', () => {
    const settings = {
      publicReadOnly: true,
      hostOverloadAlert: {
        enabled: true,
        targetBotAppId: 'cli_notify',
        enterLoadRatio: 1.5,
        enterMemUsedFrac: 0.92,
        targetDaemonOnline: true,
        botOptions: [{
          larkAppId: 'cli_notify',
          botName: 'Claude',
          cliId: 'claude',
          apiOnly: false,
          recipientConfigured: true,
          recipientVerified: true,
          recipientHint: 'b***@example.com',
        }],
      },
    };

    const out = redactSettingsForPublic(settings) as any;

    expect(out.publicReadOnly).toBe(true);
    expect(out.hostOverloadAlert).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('b***@example.com');
    expect(JSON.stringify(out)).not.toContain('cli_notify');
    // Non-mutating: authed callers still see the full snapshot.
    expect(settings.hostOverloadAlert.botOptions[0].recipientHint).toBe('b***@example.com');
  });

  it('strips BOTH notifier snapshots at once (codexNotifier + hostOverloadAlert)', () => {
    const out = redactSettingsForPublic({
      publicReadOnly: false,
      codexNotifier: { enabled: true, targetBotAppId: 'cli_codex' },
      hostOverloadAlert: { enabled: true, targetBotAppId: 'cli_notify' },
    }) as any;
    expect(out).toEqual({ publicReadOnly: false });
  });
});
