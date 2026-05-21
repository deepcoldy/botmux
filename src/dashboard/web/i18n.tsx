// Tiny i18n: a flat dict per locale + a Provider/hook. Locale is persisted in
// localStorage and defaults to the browser language. No external deps.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'botmux:lang';

function detectInitialLang(): Lang {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
    if (navigator.language?.toLowerCase().startsWith('zh')) return 'zh';
  }
  return 'en';
}

interface Ctx {
  lang: Lang;
  setLang: (v: Lang) => void;
  t: typeof EN;
}

const LangCtx = createContext<Ctx | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  const setLang = (v: Lang) => {
    setLangState(v);
    try { localStorage.setItem(STORAGE_KEY, v); } catch { /* private mode */ }
  };

  const value = useMemo<Ctx>(
    () => ({ lang, setLang, t: lang === 'zh' ? ZH : EN }),
    [lang],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export function useLang(): Ctx {
  const v = useContext(LangCtx);
  if (!v) throw new Error('useLang outside LangProvider');
  return v;
}

export const useT = (): typeof EN => useLang().t;

// ──────────────────────────────── Dictionary ────────────────────────────────

const EN = {
  nav: {
    sessions: 'Sessions',
    schedules: 'Schedules',
    groups: 'Groups & Bots',
    botDefaults: 'Bot Defaults',
  },
  status: { live: 'live', offline: 'offline' },
  common: {
    refresh: 'Refresh',
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    saving: 'Saving…',
    loading: 'Loading…',
    copy: 'copy',
    copied: 'copied',
    confirm: 'Confirm',
  },
  sessions: {
    searchPlaceholder: 'search workingDir / title / ids…',
    allStatus: 'all status',
    adoptAll: 'adopt: all',
    adoptYes: 'adopt: yes',
    adoptNo: 'adopt: no',
    activeOnly: 'active only',
    count: (n: number) => `${n} session${n !== 1 ? 's' : ''}`,
    selected: (n: number) => `${n} selected`,
    closeSelected: 'Close selected',
    closeProgress: (d: number, t: number) => `Closing ${d}/${t}`,
    empty: 'No sessions match the filters.',
    cols: {
      bot: 'bot',
      cli: 'cli',
      status: 'status',
      title: 'title',
      workingDir: 'workingDir',
      created: 'created',
      last: 'last',
      adopt: 'adopt',
    },
    drawer: {
      sessionId: 'sessionId',
      chatId: 'chatId',
      rootMessageId: 'rootMessageId',
      threadId: 'threadId',
      workingDir: 'workingDir',
      bot: 'bot',
      cli: 'cli',
      status: 'status',
      locate: 'Locate in Feishu thread',
      locating: 'Sending…',
      locateCooldown: (s: number) => `Cooldown ${s}s`,
      openXterm: 'Open xterm',
      closeSession: 'Close session',
      closing: 'Closing…',
    },
    confirmClose: 'Close this session?',
    confirmCloseBulk: (n: number) => `Close the selected ${n} session(s)?`,
    closeDone: (ok: number, failed: number) =>
      `Done: ${ok} succeeded / ${failed} failed`,
    locateFailed: (e: string) => `Locate failed: ${e}`,
  },
  schedules: {
    searchPlaceholder: 'search name / prompt / workingDir…',
    allKind: 'all kind',
    enabledOnly: 'enabled only',
    count: (n: number) => `${n} schedule${n !== 1 ? 's' : ''}`,
    cols: {
      name: 'name',
      bot: 'bot',
      schedule: 'schedule',
      next: 'next',
      last: 'last',
      repeat: 'repeat',
      enabled: 'enabled',
      actions: 'actions',
    },
    empty: 'No schedules.',
    runNow: 'Run now',
    pause: 'Pause',
    resume: 'Resume',
    failed: (e: string) => `Failed: ${e}`,
    networkError: (e: string) => `Network error: ${e}`,
  },
  groups: {
    searchPlaceholder: 'search chat name / id / owner…',
    missingBotOnly: 'missing-bot only',
    createGroup: '+ Create new group',
    chat: 'chat',
    actions: 'actions',
    empty: 'No chats match the filter.',
    addBots: 'Add bots',
    manage: 'Manage',
    create: {
      title: 'Create new group',
      desc:
        'Pick bots to invite. The dashboard auto-selects an online daemon as the chat creator/owner; the rest are added as members in the same call.',
      name: 'Group name',
      nameHint: '(optional)',
      bindDir: 'Bind directory',
      bindDirDesc:
        'Create the group and bind every invited bot to this directory, so new topics skip the repo picker.',
      bots: 'Bots',
      noBots: 'No bots online.',
      submit: 'Create',
      submitting: 'Creating…',
      pickOne: 'Pick at least one bot.',
    },
    success: {
      title: 'Group created',
      chatIdLabel: 'chatId',
      creatorLabel: 'creator',
      invitedOk: (oid: string) => (
        <>Auto-invited you (<code>{oid}</code>) as a member.</>
      ),
      ownerTransferred: 'Ownership transferred from bot to you.',
      transferFailed: (e: string) => `⚠ Owner transfer failed (${e}); you are a member but the bot is still owner.`,
      notified: (id: string) => (
        <>Bot @-mentioned you in the chat (message id <code>{id}</code>); follow the notification to enter.</>
      ),
      notifyFailed: (e: string) => `⚠ Auto @-mention failed (${e}); the new chat may not surface in your sidebar — use the link below.`,
      inviteRejected:
        'Feishu rejected the auto-invite (your open_id is out of the creator bot scope). You are NOT a member yet — ask any bot in the chat to add you manually.',
      noOwnerOpenId:
        'No ownerOpenId in dashboard cache, so you were NOT auto-invited. Before opening the link, ask any bot in the chat to add you manually.',
      bindOk: (path: string, ok: number, total: number) => (
        <>Bound directory: <code>{path}</code> ({ok}/{total} bots).</>
      ),
      bindFailed: (ok: number, total: number) =>
        `Bind partially failed: ${ok}/${total} succeeded.`,
      invalidBots: 'Invalid bot ids:',
      invalidUsers: 'Invalid user open_ids:',
      open: '↗ Open new group',
    },
    addBotsModal: {
      title: (name: string) => `Add bots to ${name}`,
      desc: "Select bots to add. The dashboard will pick a bot that's already in the chat as the proxy.",
      allInChat: 'All configured bots are already in this chat.',
      submit: 'Confirm add',
      submitting: 'Adding…',
      noProxy:
        'No bot is currently in this chat — add one manually in Feishu first, then retry.',
    },
    manageModal: {
      title: (name: string) => `Manage ${name}`,
      chatId: 'chatId',
      owner: 'owner',
      ownerUnknown: '(unknown)',
      oncallTitle: 'Oncall mode',
      oncallDesc:
        'When on: any group member can @-mention the bot to ask; new topics start the CLI in the bound directory directly. Only allowedUsers can still run /cd /restart etc.',
      oncallNoBots: 'No bot is in the group.',
      leaveTitle: 'Pick bots to leave the chat',
      ownerTag: '· owner',
      leaveButton: 'Selected bots leave chat',
      disbandButton: 'Disband group',
      disbandHint:
        'Disband only succeeds when one of the in-chat bots is the group owner. Otherwise Feishu will reject it — prefer "leave chat".',
      pickAtLeastOne: 'Pick at least one bot.',
      confirmLeave: (n: number) =>
        `Let ${n} bot(s) leave this chat? Their sessions here will be closed too.`,
      confirmDisband: (name: string) =>
        `Disband chat "${name}"? Irreversible. All bot sessions in this chat will be closed.`,
      disbandedBy: (botName: string, closedNote: string) =>
        `Disbanded (by ${botName})${closedNote}`,
      closedNoteOk: (n: number) => `\nClosed ${n} session(s).`,
      closedNoteMixed: (ok: number, failed: number) =>
        `\nClosed ${ok} session(s), ${failed} failed.`,
      disbandAllFailed: (lines: string) =>
        `No in-chat bot could disband:\n${lines}\n\nUse "leave chat" instead.`,
      bindOk: (path: string) => `✓ Bound → ${path}`,
      unbound: '✓ Unbound',
      wdRequired: 'Working directory required.',
      saveFailed: (e: string) => `✗ ${e}`,
    },
  },
  botDefaults: {
    searchPlaceholder: 'search bot name / app id…',
    hint: (
      <>
        When toggled ON, <strong>every chat without an oncall binding</strong>{' '}
        (including existing ones) will auto-bind to the directory below the next
        time someone opens a topic. Chats already manually bound in{' '}
        Groups &amp; Bots are left untouched; chats unbound via{' '}
        <code>/oncall unbind</code> are never auto-overwritten.
      </>
    ),
    errorLoading: (err: string) => `Failed to load bots: ${err}`,
    errorRetry: (
      <>
        Common cause: dashboard / daemon still running old code — run{' '}
        <code className="bg-red-100 px-1 rounded">botmux restart</code>, then refresh.
      </>
    ),
    noBots: (
      <>
        No bot online. Run <code className="px-1 bg-slate-100 rounded">botmux restart</code> to bring the daemon up.
      </>
    ),
    queryFailed: (e: string) => `Query failed: ${e}`,
    toggle: 'Default oncall mode',
    toggleDesc: '(all unbound chats will auto-bind on the next new topic)',
    workingDir: 'Default working directory',
    lastEnabled: (s: string) => `Last enabled at: ${s}`,
    autoboundCount: (n: number) => `Auto-bound ${n} chat(s)`,
    save: 'Save',
    saving: 'Saving…',
    savedOk: (path: string) =>
      `✓ Enabled${path ? ` → ${path}` : ''} (unbound chats will auto-oncall on next topic)`,
    savedOkDisabled: '✓ Disabled (already-bound chats are left alone)',
    savedError: (e: string) => `✗ ${e}`,
    wdRequired: 'Working directory required when enabled.',
  },
};

const ZH: typeof EN = {
  nav: {
    sessions: '会话',
    schedules: '定时任务',
    groups: '群组 & 机器人',
    botDefaults: '机器人默认',
  },
  status: { live: '已连接', offline: '已断开' },
  common: {
    refresh: '刷新',
    cancel: '取消',
    close: '关闭',
    save: '保存',
    saving: '保存中…',
    loading: '加载中…',
    copy: '复制',
    copied: '已复制',
    confirm: '确定',
  },
  sessions: {
    searchPlaceholder: '搜索工作目录 / 标题 / ID …',
    allStatus: '全部状态',
    adoptAll: '认领: 全部',
    adoptYes: '认领: 是',
    adoptNo: '认领: 否',
    activeOnly: '只看活跃',
    count: (n: number) => `${n} 个会话`,
    selected: (n: number) => `已选 ${n} 个`,
    closeSelected: '关闭选中',
    closeProgress: (d: number, t: number) => `关闭中 ${d}/${t}`,
    empty: '没有匹配的会话。',
    cols: {
      bot: '机器人',
      cli: 'CLI',
      status: '状态',
      title: '标题',
      workingDir: '工作目录',
      created: '创建',
      last: '最近',
      adopt: '认领',
    },
    drawer: {
      sessionId: '会话 ID',
      chatId: '群 ID',
      rootMessageId: '根消息 ID',
      threadId: '话题 ID',
      workingDir: '工作目录',
      bot: '机器人',
      cli: 'CLI',
      status: '状态',
      locate: '📍 定位到飞书话题',
      locating: '📍 发送中…',
      locateCooldown: (s: number) => `📍 冷却 ${s}s`,
      openXterm: '🖥️ 打开 xterm',
      closeSession: '关闭会话',
      closing: '关闭中…',
    },
    confirmClose: '关闭这个会话？',
    confirmCloseBulk: (n: number) => `关闭选中的 ${n} 个会话？`,
    closeDone: (ok: number, failed: number) =>
      `关闭完成：成功 ${ok} / 失败 ${failed}`,
    locateFailed: (e: string) => `定位失败：${e}`,
  },
  schedules: {
    searchPlaceholder: '搜索 name / prompt / 工作目录 …',
    allKind: '全部类型',
    enabledOnly: '只看启用',
    count: (n: number) => `${n} 个任务`,
    cols: {
      name: '名称',
      bot: '机器人',
      schedule: '计划',
      next: '下次',
      last: '上次',
      repeat: '重复',
      enabled: '启用',
      actions: '操作',
    },
    empty: '没有定时任务。',
    runNow: '立即执行',
    pause: '暂停',
    resume: '恢复',
    failed: (e: string) => `失败：${e}`,
    networkError: (e: string) => `网络错误：${e}`,
  },
  groups: {
    searchPlaceholder: '搜索群名 / 群 ID / 群主 …',
    missingBotOnly: '仅显示缺机器人',
    createGroup: '+ 创建新群',
    chat: '群聊',
    actions: '操作',
    empty: '没有匹配的群聊。',
    addBots: '添加机器人',
    manage: '管理',
    create: {
      title: '创建新群',
      desc:
        '选择要邀请的机器人。dashboard 会自动挑一个在线 daemon 作为群主创建者，其余作为成员一并加入。',
      name: '群名',
      nameHint: '（可选）',
      bindDir: '绑定目录',
      bindDirDesc:
        '创建后给每个被邀请的机器人都绑定到该目录，新话题不再弹仓库选择器。',
      bots: '机器人',
      noBots: '没有在线机器人。',
      submit: '创建',
      submitting: '创建中…',
      pickOne: '至少选择一个机器人。',
    },
    success: {
      title: '群创建成功',
      chatIdLabel: '群 ID',
      creatorLabel: '创建者',
      invitedOk: (oid: string) => (
        <>已自动邀请你（<code>{oid}</code>）作为成员。</>
      ),
      ownerTransferred: '群主已从机器人转让给你。',
      transferFailed: (e: string) => `⚠ 自动转让群主失败（${e}），你是成员但群主仍是机器人。`,
      notified: (id: string) => (
        <>机器人已在群里 @ 了你（消息 id <code>{id}</code>），看飞书通知就能进群。</>
      ),
      notifyFailed: (e: string) => `⚠ 自动 @ 通知失败（${e}），新群可能不会主动出现在你侧边栏，建议从下面按钮跳进去。`,
      inviteRejected:
        '飞书拒绝了自动邀请（你的 open_id 在创建者 bot 的 scope 下不可用）。你目前不是新群成员，需要让群里的某个机器人手动把你加进来。',
      noOwnerOpenId:
        '没在 dashboard 缓存里找到 ownerOpenId，没有自动邀请你。点开下面链接前，先让群里任一机器人手动把你加进去。',
      bindOk: (path: string, ok: number, total: number) => (
        <>已绑定目录：<code>{path}</code>（{ok}/{total} bots）</>
      ),
      bindFailed: (ok: number, total: number) =>
        `目录绑定部分失败：成功 ${ok}/${total}。`,
      invalidBots: '无效 bot id：',
      invalidUsers: '无效用户 open_id：',
      open: '↗ 打开新群',
    },
    addBotsModal: {
      title: (name: string) => `添加机器人到 ${name}`,
      desc: '选择要添加的机器人。dashboard 会挑一个已在群里的机器人作为代理。',
      allInChat: '所有机器人都已经在这个群里了。',
      submit: '确认添加',
      submitting: '添加中…',
      noProxy: '目前没有机器人在这个群里 — 先在飞书里手动加一个，再来试。',
    },
    manageModal: {
      title: (name: string) => `管理 ${name}`,
      chatId: '群 ID',
      owner: '群主',
      ownerUnknown: '（未知）',
      oncallTitle: 'Oncall 模式',
      oncallDesc:
        '开启后：群内任何成员都能 @ 机器人提问，新话题直接用绑定目录启动 CLI；仅 allowedUsers 仍可执行 /cd /restart 等命令。',
      oncallNoBots: '没有机器人在群里。',
      leaveTitle: '选择机器人退出群聊',
      ownerTag: '· 群主',
      leaveButton: '选中机器人退出群聊',
      disbandButton: '解散群聊',
      disbandHint:
        '解散群聊仅当某个在群机器人是群主时才会成功。否则飞书会返回错误，建议改用「退出群聊」。',
      pickAtLeastOne: '至少选一个机器人。',
      confirmLeave: (n: number) =>
        `确定让 ${n} 个机器人退出群聊？该 bot 在此群的会话会一并关闭。`,
      confirmDisband: (name: string) =>
        `确定解散群聊「${name}」？此操作不可恢复，本群所有机器人会话也会一并关闭。`,
      disbandedBy: (botName: string, closedNote: string) =>
        `已解散（由 ${botName} 执行）${closedNote}`,
      closedNoteOk: (n: number) => `\n关闭了 ${n} 个会话。`,
      closedNoteMixed: (ok: number, failed: number) =>
        `\n关闭了 ${ok} 个会话，${failed} 个失败。`,
      disbandAllFailed: (lines: string) =>
        `所有在群机器人均无法解散：\n${lines}\n\n建议改用「退出群聊」。`,
      bindOk: (path: string) => `✓ 已绑定 → ${path}`,
      unbound: '✓ 已解绑',
      wdRequired: '请填工作目录。',
      saveFailed: (e: string) => `✗ ${e}`,
    },
  },
  botDefaults: {
    searchPlaceholder: '搜索机器人名 / app id …',
    hint: (
      <>
        开关 ON 后，<strong>所有没有 oncall binding 的群</strong>（包括老群）下一次开新话题会自动绑到下面填的目录；
        Groups &amp; Bots 里已经手动绑过的群不动；通过 <code>/oncall unbind</code>{' '}
        解过绑的群永远不再被自动覆盖。
      </>
    ),
    errorLoading: (err: string) => `无法加载 bot 列表：${err}`,
    errorRetry: (
      <>
        常见原因：dashboard / daemon 进程还在跑旧代码，执行{' '}
        <code className="bg-red-100 px-1 rounded">botmux restart</code> 后刷新。
      </>
    ),
    noBots: (
      <>
        没有在线的 bot。先 <code className="px-1 bg-slate-100 rounded">botmux restart</code> 让 daemon 上线。
      </>
    ),
    queryFailed: (e: string) => `查询失败：${e}`,
    toggle: '默认进 oncall 模式',
    toggleDesc: '（所有未绑定的群下次开话题自动绑）',
    workingDir: '默认工作目录',
    lastEnabled: (s: string) => `上次启用时间：${s}`,
    autoboundCount: (n: number) => `已自动绑定 ${n} 个群`,
    save: '保存',
    saving: '保存中…',
    savedOk: (path: string) =>
      `✓ 已开启${path ? ` → ${path}` : ''}（未绑定的群下次开话题自动 oncall）`,
    savedOkDisabled: '✓ 已关闭（已绑定的群不动）',
    savedError: (e: string) => `✗ ${e}`,
    wdRequired: '开启时必须填工作目录。',
  },
};
