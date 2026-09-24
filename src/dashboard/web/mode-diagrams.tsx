/**
 * 会话 / 目录模式：紧凑单选选项 + 独立示例侧栏。
 *
 * 主页每个选项只保留「单选钮 + 名称 + 一句机制说明」，多模式在同一行/同一块
 * 直接比较，不内嵌大图；完整的高保真飞书聊天截图收进「查看示例」侧栏：
 * - 桌面：右侧 460px 浮层；窄屏：底部抽屉（≤90dvh）
 * - 侧栏一次只渲染正在预览的一张图，顶部按钮只切 previewValue，绝不调用保存回调，
 *   当前真实配置用「·当前」标出，避免为了比较示例而误改配置
 *
 * 截图区（.bd-mock*）固定使用飞书自己的浅色配色（与嵌入真实截图同理），
 * 蓝/紫只用来标注上下文归属（A/B 会话）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type React from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from './react-hooks.js';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── 模式选项组（紧凑单选 + 示例入口） ───────────────────────────────── */

export type ModeOption<T extends string> = {
  value: T;
  /** 选项短名（15px/650） */
  name: string;
  /** 一句机制说明（12px/常规，低对比） */
  short: string;
  /** 该项是否为出厂默认（与"当前选中"是两回事，只显示「默认」字样） */
  isDefault?: boolean;
  /** 适用场景标签（只出现在示例侧栏） */
  tags?: string[];
  /** 示例侧栏里的高保真飞书截图 */
  mock: ReactNode;
};

export function ModeOptionGroup<T extends string>(props: {
  /** data-input 标记，保留隐藏值锚点语义 */
  dataInput: string;
  groupName: string;
  groupSub: string;
  /** 侧栏标题后缀，如「私聊 · 对话示例」 */
  exampleTitle: string;
  value: T;
  options: ReadonlyArray<ModeOption<T>>;
  disabled?: boolean;
  onChange(value: T): void;
  /** 宽容器列数 / 窄容器列数（容器 ≤620px 时） */
  wideCols: number;
  narrowCols: number;
  /** 该组下额外的非选项内容（如私聊群模式下的会话群标签设置） */
  children?: ReactNode;
}): React.JSX.Element {
  const tr = useT();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const wrapId = useId().replace(/:/g, '');

  return (
    <div className="bd-mode-group">
      <div className="bd-mode-group-head">
        <div className="bd-mode-group-heading">
          <h4 className="bd-mode-group-title">{props.groupName}</h4>
          <span className="bd-mode-group-sub">{props.groupSub}</span>
        </div>
        <button
          ref={triggerRef}
          type="button"
          className="bd-mode-example-trigger"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          {tr('botDefaults.viewExample')}
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="bd-mode-opts-wrap">
        <div
          ref={gridRef}
          className="bd-mode-opt-grid"
          role="radiogroup"
          aria-label={props.groupName}
          data-input={props.dataInput}
          style={{
            '--bd-wide-cols': String(props.wideCols),
            '--bd-narrow-cols': String(props.narrowCols),
          } as React.CSSProperties}
        >
          {props.options.map((option, index) => {
            const selected = option.value === props.value;
            function move(delta: number): void {
              const target = (index + delta + props.options.length) % props.options.length;
              gridRef.current?.querySelectorAll<HTMLButtonElement>('.bd-mode-opt')[target]?.focus();
              props.onChange(props.options[target].value);
            }
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                disabled={props.disabled}
                className={cx('bd-mode-opt', selected && 'is-selected')}
                data-value={option.value}
                onClick={() => { if (!props.disabled) props.onChange(option.value); }}
                onKeyDown={event => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    move(1);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    move(-1);
                  }
                }}
              >
                <span className={cx('bd-mode-opt-radio', selected && 'is-on')} aria-hidden="true" />
                <span className="bd-mode-opt-text">
                  <span className="bd-mode-opt-name">
                    {option.name}
                    {option.isDefault ? <em className="bd-mode-default-tag">{tr('botDefaults.defaultWord')}</em> : null}
                  </span>
                  <span className="bd-mode-opt-short">{option.short}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {props.children}
      {drawerOpen ? (
        <ModeExampleDrawer
          portalKey={wrapId}
          title={props.exampleTitle}
          value={props.value}
          options={props.options}
          triggerRef={triggerRef}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* ── 示例侧栏 / 底部抽屉 ──────────────────────────────────────────────── */

function ModeExampleDrawer<T extends string>(props: {
  portalKey: string;
  title: string;
  value: T;
  options: ReadonlyArray<ModeOption<T>>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
}): React.JSX.Element {
  const tr = useT();
  const uid = useId().replace(/:/g, '');
  const tabPanelId = `bd-example-panel-${uid}`;
  const tabIdFor = (v: string): string => `bd-example-tab-${uid}-${v}`;
  const [preview, setPreview] = useState<T>(props.value);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // onClose 用 ref，让焦点管理 effect 可以只在挂载时跑一次（父组件 rerender 不抢焦点）
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const current = props.options.find(o => o.value === props.value) ?? props.options[0];
  const viewing = props.options.find(o => o.value === preview) ?? current;

  useEffect(() => {
    const panel = panelRef.current;
    closeRef.current?.focus();

    // 打开期间锁住背景：body 不滚动；portal 挂载在 body 下，main 之外还有
    // 顶栏/侧栏等框架，所以把「抽屉之外的整页框架」统一标 inert（排除抽屉自身），
    // 从 DOM 层杜绝 Tab 穿到背景（aria-modal 本身不做隔离）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // portal 挂在 body 下；它本身（.bd-example-layer）是 body 的直接子元素。
    // 把 body 的其它直接子元素（顶栏/侧栏/main 等整页框架，都在这些容器内）
    // 统一标 inert，抽屉自身所在容器排除——覆盖 main 外的框架。
    const background = [...document.body.children].filter(
      el => !el.classList?.contains('bd-example-layer'),
    );
    const savedAttrs = background.map(el => ({
      el,
      inert: el.hasAttribute('inert') ? el.getAttribute('inert') : null,
      hidden: el.hasAttribute('aria-hidden') ? el.getAttribute('aria-hidden') : null,
    }));
    background.forEach(el => {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    });

    function tabbables(): HTMLElement[] {
      if (!panel) return [];
      // 必须按运行时 tabIndex>=0 过滤：roving 组里非查看项是 tabindex=-1，
      // CSS :not([tabindex="-1"]) 选不掉通过属性/反射设置的 -1 按钮
      return [...panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
        .filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.offsetParent !== null);
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (!panel || event.key !== 'Tab') return;
      const seq = tabbables();
      if (seq.length === 0) {
        event.preventDefault();
        return;
      }
      const first = seq[0];
      const last = seq[seq.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // 方向键可能把焦点移到 tabIndex=-1 的 tab 上：此时焦点在面板内但不在
      // 可 Tab 序列里，浏览器会继续向后找 → 穿出抽屉。统一兜底回 first/last。
      if (!active || !seq.includes(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey) {
        if (active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      savedAttrs.forEach(({ el, inert, hidden }) => {
        if (inert === null) el.removeAttribute('inert'); else el.setAttribute('inert', inert);
        if (hidden === null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', hidden);
      });
      props.triggerRef.current?.focus();
    };
    // 只在挂载/卸载时跑：依赖 triggerRef（稳定 ref 对象），父组件 rerender 不重放焦点
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onTabKeyDown(event: React.KeyboardEvent, index: number): void {
    // roving tabindex：左右（窄屏下也支持上下）在 tabs 间移动焦点
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    const dir = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const target = (index + dir + props.options.length) % props.options.length;
    panelRef.current?.querySelectorAll<HTMLButtonElement>('.bd-example-tab')[target]?.focus();
    if (vertical) {
      // 上下键只移焦点；左右键同时切预览（符合 tablist 惯例）
      return;
    }
    setPreview(props.options[target].value);
  }

  return createPortal(
    <div
      className="bd-example-layer bot-defaults-page"
      onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <aside
        ref={panelRef}
        className="bd-example-panel"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header className="bd-example-head">
          <div>
            <h3 className="bd-example-title">{props.title}</h3>
            <p className="bd-example-note">{tr('botDefaults.exampleNote')}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="bd-example-close"
            aria-label={tr('botDefaults.exampleClose')}
            onClick={props.onClose}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="bd-example-tabs" role="tablist" aria-label={props.title}>
          {props.options.map((option, index) => {
            const isCurrent = option.value === props.value;
            const isViewing = option.value === viewing.value;
            return (
              <button
                key={option.value}
                id={tabIdFor(option.value)}
                type="button"
                role="tab"
                tabIndex={isViewing ? 0 : -1}
                aria-selected={isViewing}
                aria-controls={tabPanelId}
                className={cx('bd-example-tab', isViewing && 'is-viewing')}
                onClick={() => setPreview(option.value)}
                onKeyDown={event => onTabKeyDown(event, index)}
              >
                {option.name}
                {isCurrent ? <em className="bd-example-current">{tr('botDefaults.exampleCurrent')}</em> : null}
              </button>
            );
          })}
        </div>
        <div
          id={tabPanelId}
          className="bd-example-body"
          role="tabpanel"
          aria-labelledby={tabIdFor(viewing.value)}
          tabIndex={-1}
        >
          <div className="bd-example-meta">
            <span className="bd-example-name">{viewing.name}</span>
            <span className="bd-example-short">{viewing.short}</span>
            {viewing.tags?.length ? (
              <div className="bd-example-tags">
                {viewing.tags.map(tag => <span key={tag} className="bd-example-tag">{tag}</span>)}
              </div>
            ) : null}
          </div>
          <div className="bd-example-mock" aria-hidden="true">{viewing.mock}</div>
        </div>
      </aside>
    </div>,
    document.body,
    `bd-example-${props.portalKey}`,
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
      <div className="bd-mock">
        <div className="bd-mock-dm-split">
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
