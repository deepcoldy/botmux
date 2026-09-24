/**
 * 会话 / 目录模式的单选卡片 + 逼真飞书聊天截图。
 *
 * 每个选项一张大卡片：顶部是模式名 + 单选钮，中间是高保真迷你飞书聊天截图
 * （头像、蓝色气泡、「回复消息」引用条、「回复话题」入口、话题分区），
 * 底部是一句话说明与适用场景标签。
 *
 * 截图区（.bd-mock*）固定使用飞书自己的浅色配色（与嵌入真实截图同理），
 * 不跟随 dashboard 暗色主题；蓝/紫只用来标注上下文归属（A/B 会话）。
 */
import { useId } from 'react';
import type React from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useT } from './react-hooks.js';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── 单选卡片选择器 ───────────────────────────────────────────────────── */

export type ModeCardOption<T extends string> = {
  value: T;
  /** 小方块图标（24px 软底 glyph） */
  icon: ReactNode;
  name: string;
  description: string;
  /** 适用场景小标签（每卡最多 2 个） */
  tags: string[];
  /** 中部的迷你飞书截图 */
  mock: ReactNode;
};

export function ModeCardPicker<T extends string>(props: {
  value: T;
  options: ReadonlyArray<ModeCardOption<T>>;
  disabled?: boolean;
  onChange(value: T): void;
  dataInput?: string;
  ariaLabel?: string;
  /** 固定列数（如普通群 4 项固定两列）；窄屏自动降为一列。默认自适应。 */
  columns?: number;
}): React.JSX.Element {
  const prefix = props.dataInput ?? 'mode';

  function onCardKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number): void {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const target = (index + next + props.options.length) % props.options.length;
    props.onChange(props.options[target].value);
    document.getElementById(`${prefix}-card-${props.options[target].value}`)?.focus();
  }

  return (
    <div
      className={cx('bd-mode-cards-wrap')}
    >
      <div
        className={cx('bd-mode-cards', props.columns ? 'is-fixed-cols' : undefined)}
        style={props.columns ? { '--bd-mode-cols': String(props.columns) } as React.CSSProperties : undefined}
        role="radiogroup"
        aria-label={props.ariaLabel}
        data-input={props.dataInput}
      >
      {props.options.map((option, index) => {
        const selected = option.value === props.value;
        return (
          <div
            key={option.value}
            id={`${prefix}-card-${option.value}`}
            className={['bd-mode-card', selected && 'is-selected'].filter(Boolean).join(' ')}
            role="radio"
            aria-checked={selected}
            tabIndex={props.disabled ? -1 : selected ? 0 : -1}
            aria-disabled={props.disabled || undefined}
            onClick={() => { if (!props.disabled) props.onChange(option.value); }}
            onKeyDown={event => {
              if (props.disabled) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                props.onChange(option.value);
              } else if (event.key.startsWith('Arrow')) {
                event.preventDefault();
                onCardKeyDown(event, index);
              }
            }}
          >
            {/* 顶部固定：图标 + 名称 + 单选钮（同排标题对齐） */}
            <div className="bd-mode-head">
              <span className="bd-mode-icon">{option.icon}</span>
              <span className="bd-mode-name">{option.name}</span>
              <span className={['bd-mode-radio', selected && 'is-on'].filter(Boolean).join(' ')} aria-hidden="true" />
            </div>
            {/* 中部：飞书截图，顶对齐、同排等高 */}
            <div className="bd-mode-mock" aria-hidden="true">{option.mock}</div>
            {/* 底部：说明 + 场景标签 */}
            <div className="bd-mode-foot">
              <p className="bd-mode-desc">{option.description}</p>
              {option.tags.length ? (
                <div className="bd-mode-tags">
                  {option.tags.slice(0, 2).map(tag => <span key={tag} className="bd-mode-tag">{tag}</span>)}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

/* ── 飞书头像（SVG，渐变 ID 用 useId 保证唯一） ──────────────────────── */

function PersonAvatar(): React.JSX.Element {
  const id = useId();
  const fill = `bdMockPerson${id.replace(/:/g, '')}`;
  return (
    <svg className="bd-mock-av" viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd9a8" />
          <stop offset="1" stopColor="#f2a65a" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${fill})`} />
      <circle cx="20" cy="16" r="6.4" fill="#7a4e21" opacity="0.85" />
      <path d="M8.5 33.5c1.6-6.2 6.6-9 11.5-9s9.9 2.8 11.5 9c-3 3-7 4.5-11.5 4.5s-8.5-1.5-11.5-4.5z" fill="#7a4e21" opacity="0.85" />
    </svg>
  );
}

function OtherPersonAvatar(): React.JSX.Element {
  return (
    <svg className="bd-mock-av" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#3bb27b" />
      <circle cx="20" cy="16" r="6.4" fill="#fff" opacity="0.9" />
      <path d="M8.5 33.5c1.6-6.2 6.6-9 11.5-9s9.9 2.8 11.5 9c-3 3-7 4.5-11.5 4.5s-8.5-1.5-11.5-4.5z" fill="#fff" opacity="0.9" />
    </svg>
  );
}

function BotAvatar(): React.JSX.Element {
  const id = useId();
  const fill = `bdMockBot${id.replace(/:/g, '')}`;
  return (
    <svg className="bd-mock-av" viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6a73e8" />
          <stop offset="1" stopColor="#8b6cf0" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${fill})`} />
      <rect x="12.5" y="14" width="15" height="12.5" rx="3.6" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="17" cy="20.4" r="1.7" fill="#fff" />
      <circle cx="23" cy="20.4" r="1.7" fill="#fff" />
      <path d="M17.6 23.6h4.8" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M20 14v-2.6M20 11.4l2.4-1.5" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/* ── 聊天骨架 ─────────────────────────────────────────────────────────── */

/** 气泡里 @ 某人 的蓝色片段。 */
function Mention(props: { children: ReactNode }): React.JSX.Element {
  return <span className="bd-mock-at">{props.children}</span>;
}

/** 私聊里「自己」发的消息：飞书单聊不显示自己头像/名字，气泡整体靠右。 */
function DmUserLine(props: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="bd-mock-dm-user">
      <span className="bd-mock-bubble bd-mock-bubble-r">{props.children}</span>
    </div>
  );
}

/** 群里「人」发的消息：头像 + 名字 + 气泡全部贴左（飞书群真实布局）。 */
function PersonLine(props: { name: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="bd-mock-personline">
      <PersonAvatar />
      <div className="bd-mock-col">
        <span className="bd-mock-nameline">{props.name}</span>
        {props.children}
      </div>
    </div>
  );
}

function GroupBubble(props: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="bd-mock-row bd-mock-row-g">
      <span className="bd-mock-bubble bd-mock-bubble-g">{props.children}</span>
    </div>
  );
}

function BotLine(props: { name: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="bd-mock-botline">
      <BotAvatar />
      <div className="bd-mock-col">
        <span className="bd-mock-nameline">{props.name}</span>
        {props.children}
      </div>
    </div>
  );
}

function BotBubble(props: { children: ReactNode }): React.JSX.Element {
  return <span className="bd-mock-bubble bd-mock-bubble-l">{props.children}</span>;
}

/**
 * 飞书「回复消息」引用：竖线只覆盖被引用摘要（灰色那行），回复正文另起一层，
 * 不把整段画成引用块。
 */
function QuoteReply(props: { to: string; quoted: string; children: ReactNode }): React.JSX.Element {
  const tr = useT();
  return (
    <div className="bd-mock-quote">
      <div className="bd-mock-quote-head">{tr('botDefaults.mock.replyTo', { name: props.to, msg: props.quoted })}</div>
      <div className="bd-mock-quote-body">{props.children}</div>
    </div>
  );
}

/** 上下文归属说明（普通 11px 文字，非胶囊）：A/B 两种会话一目了然。 */
function ContextLabel(props: { tone?: 'a' | 'b'; children: ReactNode }): React.JSX.Element {
  return (
    <div className={cx('bd-mock-ctx', props.tone === 'b' && 'is-b')}>
      <span className="bd-mock-ctx-dot" aria-hidden="true" />
      {props.children}
    </div>
  );
}

/** 话题分区：浅蓝/浅紫圆角盒，左上角是普通文字的上下文标签。 */
function TopicBox(props: {
  children: ReactNode;
  tone?: 'a' | 'b';
  label: ReactNode;
}): React.JSX.Element {
  return (
    <div className={cx('bd-mock-topic', `bd-mock-topic-${props.tone ?? 'a'}`)}>
      <div className={cx('bd-mock-topic-label', props.tone === 'b' && 'is-b')}>{props.label}</div>
      <div className="bd-mock-topic-body">{props.children}</div>
    </div>
  );
}

/** 「回复话题」入口（固定 SVG，避免跨平台 emoji 差异）。 */
function ReplyTopicEntry(): React.JSX.Element {
  const tr = useT();
  return (
    <div className="bd-mock-reply-topic">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M13.2 8.6c0 2.5-2 4.4-4.6 4.4H5.4M5.4 13L3 10.6 5.4 8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.6 5.6h3.4c2 0 3.4 1.2 3.8 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {tr('botDefaults.mock.replyTopic')}
    </div>
  );
}

/** 未 @ 机器人、它不回的消息。 */
function IgnoredNote(props: { text: string }): React.JSX.Element {
  return <div className="bd-mock-ignored">⊘ {props.text}</div>;
}

/* ── 私聊会话模式（3） ────────────────────────────────────────────────── */

export function P2pMock(props: { mode: 'chat' | 'thread' | 'group' }): React.JSX.Element {
  const tr = useT();
  const bot = tr('botDefaults.mock.botName');

  if (props.mode === 'thread') {
    return (
      <div className="bd-mock">
        <TopicBox tone="a" label={tr('botDefaults.mock.ctxTopicA')}>
          <DmUserLine>{tr('botDefaults.mock.checkError')}</DmUserLine>
          <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.onIt')}</BotBubble></BotLine>
          <ReplyTopicEntry />
        </TopicBox>
        <TopicBox tone="b" label={tr('botDefaults.mock.ctxTopicB')}>
          <DmUserLine>{tr('botDefaults.mock.runNewTask')}</DmUserLine>
          <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.sure')}</BotBubble></BotLine>
          <ReplyTopicEntry />
        </TopicBox>
      </div>
    );
  }

  if (props.mode === 'group') {
    return (
      <div className="bd-mock bd-mock-dm-split">
        <div className="bd-mock-dm">
          <div className="bd-mock-dm-title">{tr('botDefaults.mock.dmTitle')}</div>
          <DmUserLine>{tr('botDefaults.mock.checkError')}</DmUserLine>
        </div>
        <span className="bd-mock-flow-h">→</span>
        <div className="bd-mock-sgroups">
          <div className="bd-mock-sgroup bd-mock-topic-a">
            <span className="bd-mock-sgroup-name">{tr('botDefaults.mock.sgError')}</span>
            <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.onIt')}</BotBubble></BotLine>
          </div>
          <div className="bd-mock-sgroup bd-mock-topic-b">
            <span className="bd-mock-sgroup-name">{tr('botDefaults.mock.sgTask')}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bd-mock">
      <DmUserLine>{tr('botDefaults.mock.checkError')}</DmUserLine>
      <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.onItLog')}</BotBubble></BotLine>
      <DmUserLine>{tr('botDefaults.mock.doneYet')}</DmUserLine>
      <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.fixed')}</BotBubble></BotLine>
    </div>
  );
}

/* ── 普通群会话模式（4） ──────────────────────────────────────────────── */

export function RegularMock(props: {
  mode: 'new-topic' | 'chat-topic' | 'chat' | 'shared';
}): React.JSX.Element {
  const tr = useT();
  const person = tr('botDefaults.mock.personName');
  const bot = tr('botDefaults.mock.botName');
  const atBot = <Mention>@agent-bot</Mention>;
  const atMing = <Mention>@{person}</Mention>;

  if (props.mode === 'chat') {
    // 消息模式：所有消息（含原生话题追问）平铺成一条流，共用一个会话。
    return (
      <div className="bd-mock">
        <ContextLabel>{tr('botDefaults.mock.ctxOneSession')}</ContextLabel>
        <PersonLine name={person}>
          <GroupBubble>{atBot} {tr('botDefaults.mock.hi')}</GroupBubble>
        </PersonLine>
        <BotLine name={bot}>
          <QuoteReply to={person} quoted={tr('botDefaults.mock.hi')}>
            {atMing} {tr('botDefaults.mock.greeting')}
          </QuoteReply>
        </BotLine>
        <PersonLine name={person}>
          <GroupBubble>{atBot} {tr('botDefaults.mock.intro')}</GroupBubble>
        </PersonLine>
        <BotLine name={bot}>
          <QuoteReply to={person} quoted={tr('botDefaults.mock.intro')}>{tr('botDefaults.mock.willExplain')}</QuoteReply>
        </BotLine>
      </div>
    );
  }

  if (props.mode === 'shared') {
    // 话题展示、共享会话：两话题各自有名字，外侧括线标明「共用上下文 A」，
    // 第二话题的对话直接引用第一话题的失败结论，证明跨话题共享记忆。
    return (
      <div className="bd-mock">
        <ContextLabel>{tr('botDefaults.mock.ctxSharedA')}</ContextLabel>
        <div className="bd-mock-shared-brace">
          <TopicBox tone="a" label={tr('botDefaults.mock.ctxTopic1')}>
            <PersonLine name={person}>
              <GroupBubble>{atBot} {tr('botDefaults.mock.atCi')}</GroupBubble>
            </PersonLine>
            <BotLine name={bot}>
              <QuoteReply to={person} quoted={tr('botDefaults.mock.atCi')}>{tr('botDefaults.mock.sharedAns1')}</QuoteReply>
            </BotLine>
            <ReplyTopicEntry />
          </TopicBox>
          <TopicBox tone="a" label={tr('botDefaults.mock.ctxTopic2')}>
            <PersonLine name={person}>
              <GroupBubble>{atBot} {tr('botDefaults.mock.sharedTurn2')}</GroupBubble>
            </PersonLine>
            <BotLine name={bot}>
              <QuoteReply to={person} quoted={tr('botDefaults.mock.sharedTurn2')}>{tr('botDefaults.mock.sharedAns2')}</QuoteReply>
            </BotLine>
            <ReplyTopicEntry />
          </TopicBox>
        </div>
      </div>
    );
  }

  if (props.mode === 'new-topic') {
    // 话题模式：一句话开一个话题——两条顶层 @ 各开一个独立话题，
    // A/B 两种上下文颜色 + 标签，互不共享。
    return (
      <div className="bd-mock">
        <TopicBox tone="a" label={tr('botDefaults.mock.ctxTopic1A')}>
          <PersonLine name={person}>
            <GroupBubble>{atBot} {tr('botDefaults.mock.hi')}</GroupBubble>
          </PersonLine>
          <BotLine name={bot}>
            <QuoteReply to={person} quoted={tr('botDefaults.mock.hi')}>
              {atMing} {tr('botDefaults.mock.greeting')}
            </QuoteReply>
          </BotLine>
          <ReplyTopicEntry />
        </TopicBox>
        <TopicBox tone="b" label={tr('botDefaults.mock.ctxTopic2B')}>
          <PersonLine name={person}>
            <GroupBubble>{atBot} {tr('botDefaults.mock.atCi')}</GroupBubble>
          </PersonLine>
          <BotLine name={bot}>
            <QuoteReply to={person} quoted={tr('botDefaults.mock.atCi')}>{tr('botDefaults.mock.ciResult')}</QuoteReply>
          </BotLine>
          <ReplyTopicEntry />
        </TopicBox>
      </div>
    );
  }

  // chat-topic（默认）：
  // 上半段平铺 = 顶层 @，上下文 A，两轮问答体现连续；
  // 下半段话题盒 = 原生话题，上下文 B，盒内两轮（都带 @，避免与 @策略混淆）体现话题内连续。
  return (
    <div className="bd-mock">
      <ContextLabel>{tr('botDefaults.mock.ctxFlatA')}</ContextLabel>
      <PersonLine name={person}>
        <GroupBubble>{atBot} {tr('botDefaults.mock.hi')}</GroupBubble>
      </PersonLine>
      <BotLine name={bot}>
        <QuoteReply to={person} quoted={tr('botDefaults.mock.hi')}>
          {atMing} {tr('botDefaults.mock.greeting')}
        </QuoteReply>
      </BotLine>
      <PersonLine name={person}>
        <GroupBubble>{atBot} {tr('botDefaults.mock.intro')}</GroupBubble>
      </PersonLine>
      <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.willExplain')}</BotBubble></BotLine>
      <TopicBox tone="b" label={tr('botDefaults.mock.ctxNativeTopicB')}>
        <PersonLine name={person}>
          <GroupBubble>{atBot} {tr('botDefaults.mock.topicTurn1')}</GroupBubble>
        </PersonLine>
        <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.topicAns1')}</BotBubble></BotLine>
        <PersonLine name={person}>
          <GroupBubble>{atBot} {tr('botDefaults.mock.topicTurn2')}</GroupBubble>
        </PersonLine>
        <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.topicAns2')}</BotBubble></BotLine>
        <ReplyTopicEntry />
      </TopicBox>
    </div>
  );
}

/* ── 群聊 @ 策略（4） ─────────────────────────────────────────────────── */

export function MentionMock(props: {
  mode: 'always' | 'topic' | 'never' | 'ambient';
}): React.JSX.Element {
  const tr = useT();
  const person = tr('botDefaults.mock.personName');
  const bot = tr('botDefaults.mock.botName');

  if (props.mode === 'topic') {
    return (
      <div className="bd-mock">
        <PersonLine name={person}><GroupBubble>{tr('botDefaults.mock.whoOnDuty')}</GroupBubble></PersonLine>
        <IgnoredNote text={tr('botDefaults.mock.ignoredTopLevel')} />
        <TopicBox tone="b" label={tr('botDefaults.mock.ctxTakenTopic')}>
          <PersonLine name={person}><GroupBubble>{tr('botDefaults.mock.keepGoing')}</GroupBubble></PersonLine>
          <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.tookTopic')}</BotBubble></BotLine>
        </TopicBox>
      </div>
    );
  }

  if (props.mode === 'never') {
    return (
      <div className="bd-mock">
        <div className="bd-mock-badge">{tr('botDefaults.mock.noMentionBadge')}</div>
        <PersonLine name={person}><GroupBubble>{tr('botDefaults.mock.whoOnDuty')}</GroupBubble></PersonLine>
        <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.onIt')}</BotBubble></BotLine>
        <PersonLine name={person}><GroupBubble>{tr('botDefaults.mock.statusNow')}</GroupBubble></PersonLine>
        <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.recovered')}</BotBubble></BotLine>
      </div>
    );
  }

  if (props.mode === 'ambient') {
    return (
      <div className="bd-mock">
        <PersonLine name={person}><GroupBubble>{tr('botDefaults.mock.statusNow')}</GroupBubble></PersonLine>
        <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.recovered')}</BotBubble></BotLine>
        <PersonLine name={person}>
          <GroupBubble><Mention>@{tr('botDefaults.mock.peerName')}</Mention> {tr('botDefaults.mock.atPeer')}</GroupBubble>
        </PersonLine>
        <IgnoredNote text={tr('botDefaults.mock.yieldNote')} />
      </div>
    );
  }

  // always（默认）
  return (
    <div className="bd-mock">
      <PersonLine name={person}><GroupBubble>{tr('botDefaults.mock.whoOnDuty')}</GroupBubble></PersonLine>
      <IgnoredNote text={tr('botDefaults.mock.ignoredNoMention')} />
      <PersonLine name={person}><GroupBubble><Mention>@agent-bot</Mention> {tr('botDefaults.mock.atLog')}</GroupBubble></PersonLine>
      <BotLine name={bot}><BotBubble>{tr('botDefaults.mock.errorLine')}</BotBubble></BotLine>
    </div>
  );
}

/* ── 默认工作目录模式（3） ────────────────────────────────────────────── */

function FlowStep(props: { kind: 'session' | 'folder'; title: string; badges?: string[] }): React.JSX.Element {
  return (
    <div className={cx('bd-mock-step', `bd-mock-step-${props.kind}`)}>
      <span className="bd-mock-step-icon" aria-hidden="true">
        {props.kind === 'session' ? '💬' : '📁'}
      </span>
      <span className="bd-mock-step-text">
        <span className="bd-mock-step-title">{props.title}</span>
        {props.badges?.length ? (
          <span className="bd-mock-step-badges">
            {props.badges.map(badge => <span key={badge} className="bd-mock-step-badge">{badge}</span>)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function WorkingDirMock(props: { mode: 'off' | 'default' | 'oncall' }): React.JSX.Element {
  const tr = useT();

  if (props.mode === 'off') {
    return (
      <div className="bd-mock bd-mock-repo">
        <div className="bd-mock-repo-card">
          <div className="bd-mock-repo-head">🤖 {tr('botDefaults.mock.repoCardTitle')}</div>
          <div className="bd-mock-repo-row is-on">
            <span className="bd-mock-repo-radio" aria-hidden="true" />
            📁 botmux
            <span className="bd-mock-repo-check">✓</span>
          </div>
          <div className="bd-mock-repo-row">
            <span className="bd-mock-repo-radio" aria-hidden="true" />
            📁 another-repo
          </div>
          <div className="bd-mock-repo-actions">
            <span className="bd-mock-repo-btn is-primary">{tr('botDefaults.mock.repoPrimary')}</span>
            <span className="bd-mock-repo-btn">{tr('botDefaults.mock.repoWorktree')}</span>
          </div>
        </div>
      </div>
    );
  }

  if (props.mode === 'oncall') {
    return (
      <div className="bd-mock bd-mock-flow">
        <FlowStep kind="session" title={tr('botDefaults.mock.newSession')} />
        <div className="bd-mock-flow-v" aria-hidden="true">↓</div>
        <FlowStep
          kind="folder"
          title="/oncall/incident"
          badges={[tr('botDefaults.mock.badgeAutoBind'), tr('botDefaults.mock.badgeOpenChat')]}
        />
        <div className="bd-mock-crowd">
          <PersonAvatar />
          <BotAvatar />
          <OtherPersonAvatar />
          <span className="bd-mock-crowd-text">{tr('botDefaults.mock.openToAll')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bd-mock bd-mock-flow">
      <FlowStep kind="session" title={tr('botDefaults.mock.newSession')} />
      <div className="bd-mock-flow-v" aria-hidden="true">↓</div>
      <FlowStep
        kind="folder"
        title="/repo/botmux"
        badges={[tr('botDefaults.mock.badgeDirect'), tr('botDefaults.mock.badgePermsKept')]}
      />
    </div>
  );
}

/* ── 模式小图标（卡片标题前的 24px 软底 glyph） ───────────────────────── */

function Glyph(props: { d: string; d2?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={props.d} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {props.d2 ? <path d={props.d2} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

export const MODE_GLYPHS = {
  topic: <Glyph d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z M14 3.5V8h4" d2="M9.5 12.5h6M9.5 16h4.5" />,
  hybrid: <Glyph d="M5 7.5h10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H9l-3.5 3v-3H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z" d2="M10 3.5h9a2 2 0 0 1 2 2v3" />,
  message: <Glyph d="M4 6.5h16a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 15.5H9l-4 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 14V8A1.5 1.5 0 0 1 4 6.5z" d2="M8 10h8M8 13h5" />,
  shared: <Glyph d="M8 7v6a4 4 0 0 0 4 4h4M16 17l3 3 3-3" d2="M8 7L5 4M8 7l3-3M22 7l-3-3M22 7l-3 3" />,
  continuous: <Glyph d="M7 12h10M13 6l6 6-6 6" d2="M11 6l-6 6 6 6" />,
  separate: <Glyph d="M4 5h11v10H4zM9 9h11v10H9z" />,
  group: <Glyph d="M9 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19a5.5 5.5 0 0 1 11 0" d2="M16 8.8a3 3 0 0 0 0-5.6M17.5 19a5.5 5.5 0 0 0-3-4.9" />,
  at: <Glyph d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z" d2="M15.8 12v1.6a2.4 2.4 0 0 0 4.2 1.6V12a8 8 0 1 0-3.1 6.3M15.8 12v2.4" />,
  inTopic: <Glyph d="M5 4.5h14v11H8l-3 3v-3z" d2="M9 9h6M9 12h3.5" />,
  loud: <Glyph d="M4 10v4h3l5 3.5v-11L7 10H4z" d2="M16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10" />,
  yield: <Glyph d="M5 12h14M13 6l6 6-6 6" />,
  pickCard: <Glyph d="M3.5 7a1 1 0 0 1 1-1h7l2 2.5h6a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V7z" />,
  pinFolder: <Glyph d="M3.5 7a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V7z" d2="M3.5 9.5h17M14.5 4.5v3M9.5 4.5v3" />,
  oncall: <Glyph d="M12 3.5l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-5l7-3z" d2="M12 8.5v5M9.5 11h5" />,
};
