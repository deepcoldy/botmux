/**
 * 会话 / 目录模式的「聊天示意图」。
 *
 * 这几个设置（私聊会话模式、普通群会话模式、群聊 @ 策略、默认工作目录模式）
 * 光看选项名很难懂——纯文本描述要解释「会话」「原生话题」「接管」这些概念，
 * 不如直接画一个迷你飞书聊天窗，用气泡、话题框、会话底色把每种模式的消息
 * 走向画出来。用真实 DOM + CSS 而不是切图：深浅色主题自动跟随、文字可随
 * i18n 切换、任意 DPI 都清晰，也不会在仓库里留下二进制素材。
 *
 * 约定：
 * - 右气泡 = 群成员/你发的消息；左气泡 = 机器人的回复；
 * - Lane（带色底板 + 「会话 n」标签）= 一个独立 CLI 会话的边界；
 * - Topic（话题框）= 飞书里的话题（顶层新开的或原生话题）；
 * - SilentTag = 机器人看到了消息但保持沉默。
 */
import type React from 'react';
import type { ReactNode } from 'react';
import { useT } from './react-hooks.js';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── 骨架 ─────────────────────────────────────────────────────────────── */

function Diagram(props: { token: string; caption: string; children: ReactNode }): React.JSX.Element {
  return (
    <figure
      className="bd-md-diagram"
      role="img"
      aria-label={props.caption}
    >
      <div className="bd-md-stage" aria-hidden="true">{props.children}</div>
      <figcaption className="bd-md-caption-row">
        <span className="bd-md-caption">{props.caption}</span>
        <code className="bd-md-token">{props.token}</code>
      </figcaption>
    </figure>
  );
}

/** 迷你聊天窗：顶部标题条 + 消息区。 */
function Frame(props: { title: string; avatars?: 2 | 3; badge?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="bd-md-frame">
      <div className="bd-md-framebar">
        <span className={cx('bd-md-avatars', `bd-md-avatars-${props.avatars ?? 2}`)}>
          <span className="bd-md-av bd-md-av-user" />
          <span className="bd-md-av bd-md-av-bot" />
          {props.avatars === 3 ? <span className="bd-md-av bd-md-av-other" /> : null}
        </span>
        <span className="bd-md-frame-title">{props.title}</span>
        {props.badge ? <span className="bd-md-frame-badge">{props.badge}</span> : null}
      </div>
      <div className="bd-md-framebody">{props.children}</div>
    </div>
  );
}

/** 一条迷你气泡消息。side: r = 人发的（右），l = 机器人回复（左）。 */
function Bubble(props: { side: 'l' | 'r'; children: ReactNode }): React.JSX.Element {
  return (
    <div className={cx('bd-md-bubble-row', `bd-md-bubble-${props.side}`)}>
      {props.side === 'l' ? <span className="bd-md-av bd-md-bubble-av bd-md-av-bot" /> : null}
      <span className="bd-md-bubble">{props.children}</span>
    </div>
  );
}

/** 会话底色：同一块底板 = 同一个 CLI 会话（共享上下文/工作目录）。 */
function Lane(props: {
  tone?: 'a' | 'b' | 'c';
  tag: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cx('bd-md-lane', `bd-md-tone-${props.tone ?? 'a'}`, props.className)}>
      <span className="bd-md-lane-tag">{props.tag}</span>
      <div className="bd-md-lane-body">{props.children}</div>
    </div>
  );
}

/** 飞书话题框。fused = 话题被折进外层会话（视觉上与底板同色 + 虚线）。 */
function Topic(props: {
  tag: string;
  tone?: 'a' | 'b' | 'c';
  fused?: boolean;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'bd-md-topic',
        `bd-md-tone-${props.tone ?? 'a'}`,
        props.fused && 'bd-md-topic-fused',
        props.className,
      )}
    >
      <span className="bd-md-topic-tag">{props.tag}</span>
      <div className="bd-md-topic-body">{props.children}</div>
    </div>
  );
}

/** 机器人对这条消息保持沉默。 */
function SilentTag(props: { text: string }): React.JSX.Element {
  return (
    <div className="bd-md-silent-row">
      <span className="bd-md-silent">
        <span className="bd-md-silent-icon" aria-hidden="true">⊘</span>
        {props.text}
      </span>
    </div>
  );
}

/* ── 工作目录模式用的流程图骨架 ───────────────────────────────────────── */

function FlowArrow(): React.JSX.Element {
  return <span className="bd-md-flow-arrow" aria-hidden="true">↓</span>;
}

function FlowNode(props: {
  icon: 'session' | 'card' | 'folder';
  title: string;
  sub?: string;
  badges?: string[];
  avatars?: boolean;
}): React.JSX.Element {
  return (
    <div className={cx('bd-md-node', `bd-md-node-${props.icon}`)}>
      <span className={cx('bd-md-node-icon', `bd-md-node-icon-${props.icon}`)} aria-hidden="true">
        {props.icon === 'session' ? '💬' : props.icon === 'card' ? '🪪' : '📁'}
      </span>
      <span className="bd-md-node-text">
        <span className="bd-md-node-title">{props.title}</span>
        {props.sub ? <span className="bd-md-node-sub">{props.sub}</span> : null}
        {props.badges?.length ? (
          <span className="bd-md-node-badges">
            {props.badges.map(badge => <span key={badge} className="bd-md-node-badge">{badge}</span>)}
          </span>
        ) : null}
        {props.avatars ? (
          <span className="bd-md-avatars bd-md-avatars-3 bd-md-node-avatars">
            <span className="bd-md-av bd-md-av-user" />
            <span className="bd-md-av bd-md-av-bot" />
            <span className="bd-md-av bd-md-av-other" />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/* ── 私聊会话模式 ─────────────────────────────────────────────────────── */

export function P2pModeDiagram(props: { mode: 'chat' | 'thread' | 'group' }): React.JSX.Element {
  const tr = useT();
  const dmTitle = tr('botDefaults.diagram.dmTitle');

  if (props.mode === 'thread') {
    return (
      <Diagram token="thread" caption={tr('botDefaults.diagram.p2pThreadCap')}>
        <Frame title={dmTitle}>
          <Lane tone="a" tag={tr('botDefaults.diagram.laneSessionN', { n: '1' })}>
            <Bubble side="r">{tr('botDefaults.diagram.msgError')}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
          </Lane>
          <Lane tone="b" tag={tr('botDefaults.diagram.laneSessionN', { n: '2' })}>
            <Bubble side="r">{tr('botDefaults.diagram.msgDone')}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgFixed')}</Bubble>
          </Lane>
          <Lane tone="c" tag={tr('botDefaults.diagram.laneSessionN', { n: '3' })}>
            <Bubble side="r">{tr('botDefaults.diagram.msgNewTask')}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
          </Lane>
        </Frame>
      </Diagram>
    );
  }

  if (props.mode === 'group') {
    return (
      <Diagram token="group" caption={tr('botDefaults.diagram.p2pGroupCap')}>
        <div className="bd-md-split">
          <Frame title={dmTitle}>
            <Bubble side="r">{tr('botDefaults.diagram.msgError')}</Bubble>
            <Bubble side="r">{tr('botDefaults.diagram.msgNewTask')}</Bubble>
          </Frame>
          <span className="bd-md-split-arrow" aria-hidden="true">→</span>
          <div className="bd-md-session-groups">
            <div className="bd-md-session-group bd-md-tone-a">
              <div className="bd-md-session-group-head">
                <span className="bd-md-avatars bd-md-avatars-2">
                  <span className="bd-md-av bd-md-av-user" />
                  <span className="bd-md-av bd-md-av-bot" />
                </span>
                <span>{tr('botDefaults.diagram.sessionGroupN', { n: '①' })}</span>
              </div>
              <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
            </div>
            <div className="bd-md-session-group bd-md-tone-b">
              <div className="bd-md-session-group-head">
                <span className="bd-md-avatars bd-md-avatars-2">
                  <span className="bd-md-av bd-md-av-user" />
                  <span className="bd-md-av bd-md-av-bot" />
                </span>
                <span>{tr('botDefaults.diagram.sessionGroupN', { n: '②' })}</span>
              </div>
            </div>
          </div>
        </div>
      </Diagram>
    );
  }

  return (
    <Diagram token="chat" caption={tr('botDefaults.diagram.p2pChatCap')}>
      <Frame title={dmTitle}>
        <Lane tone="a" tag={tr('botDefaults.diagram.laneContinuous')}>
          <Bubble side="r">{tr('botDefaults.diagram.msgError')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
          <Bubble side="r">{tr('botDefaults.diagram.msgDone')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgFixed')}</Bubble>
        </Lane>
      </Frame>
    </Diagram>
  );
}

/* ── 普通群会话模式 ───────────────────────────────────────────────────── */

export function RegularGroupModeDiagram(props: {
  mode: 'chat' | 'chat-topic' | 'new-topic' | 'shared';
}): React.JSX.Element {
  const tr = useT();
  const groupTitle = tr('botDefaults.diagram.groupTitle');

  if (props.mode === 'chat') {
    return (
      <Diagram token="chat" caption={tr('botDefaults.diagram.regularChatCap')}>
        <Frame title={groupTitle} avatars={3}>
          <Lane tone="a" tag={tr('botDefaults.diagram.laneContinuous')}>
            <Bubble side="r">{tr('botDefaults.diagram.msgAtCi')}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
            <Topic tone="a" fused tag={tr('botDefaults.diagram.nativeTopicFolded')}>
              <Bubble side="r">{tr('botDefaults.diagram.msgInTopic')}</Bubble>
              <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
            </Topic>
          </Lane>
        </Frame>
      </Diagram>
    );
  }

  if (props.mode === 'new-topic') {
    return (
      <Diagram token="new-topic" caption={tr('botDefaults.diagram.regularNewTopicCap')}>
        <Frame title={groupTitle} avatars={3}>
          <Lane tone="a" tag={tr('botDefaults.diagram.newTopicSessionN', { n: '1' })}>
            <Bubble side="r">{tr('botDefaults.diagram.msgTaskN', { n: 'A' })}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
          </Lane>
          <Lane tone="b" tag={tr('botDefaults.diagram.newTopicSessionN', { n: '2' })}>
            <Bubble side="r">{tr('botDefaults.diagram.msgTaskN', { n: 'B' })}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
          </Lane>
          <Lane tone="c" tag={tr('botDefaults.diagram.newTopicSessionN', { n: '3' })}>
            <Bubble side="r">{tr('botDefaults.diagram.msgTaskN', { n: 'C' })}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
          </Lane>
        </Frame>
      </Diagram>
    );
  }

  if (props.mode === 'shared') {
    return (
      <Diagram token="shared" caption={tr('botDefaults.diagram.regularSharedCap')}>
        <Frame title={groupTitle} avatars={3}>
          <Lane tone="a" tag={tr('botDefaults.diagram.sharedSessionName')}>
            <Bubble side="r">{tr('botDefaults.diagram.msgAtCi')}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
            <div className="bd-md-topic-row">
              <Topic tone="a" tag={tr('botDefaults.diagram.sharedReuse')} className="bd-md-topic-compact">
                <Bubble side="r">{tr('botDefaults.diagram.msgInTopic')}</Bubble>
              </Topic>
              <Topic tone="a" tag={tr('botDefaults.diagram.sharedReuse')} className="bd-md-topic-compact">
                <Bubble side="r">{tr('botDefaults.diagram.msgNewTask')}</Bubble>
              </Topic>
            </div>
          </Lane>
        </Frame>
      </Diagram>
    );
  }

  // chat-topic（默认）
  return (
    <Diagram token="chat-topic" caption={tr('botDefaults.diagram.regularChatTopicCap')}>
      <Frame title={groupTitle} avatars={3}>
        <Lane tone="a" tag={tr('botDefaults.diagram.laneSessionN', { n: '1' })}>
          <Bubble side="r">{tr('botDefaults.diagram.msgAtCi')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
        </Lane>
        <Topic tone="b" tag={tr('botDefaults.diagram.nativeTopicName')}>
          <Bubble side="r">{tr('botDefaults.diagram.msgInTopic')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
        </Topic>
      </Frame>
    </Diagram>
  );
}

/* ── 群聊 @ 策略 ──────────────────────────────────────────────────────── */

export function MentionModeDiagram(props: {
  mode: 'always' | 'topic' | 'never' | 'ambient';
}): React.JSX.Element {
  const tr = useT();
  const groupTitle = tr('botDefaults.diagram.groupTitle');

  if (props.mode === 'topic') {
    return (
      <Diagram token="topic" caption={tr('botDefaults.diagram.mentionTopicCap')}>
        <Frame title={groupTitle} avatars={3}>
          <Bubble side="r">{tr('botDefaults.diagram.msgDuty')}</Bubble>
          <SilentTag text={tr('botDefaults.diagram.tagSilent')} />
          <Topic tone="a" tag={tr('botDefaults.diagram.takenTopic')}>
            <Bubble side="r">{tr('botDefaults.diagram.msgContinue')}</Bubble>
            <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
          </Topic>
        </Frame>
      </Diagram>
    );
  }

  if (props.mode === 'never') {
    return (
      <Diagram token="never" caption={tr('botDefaults.diagram.mentionNeverCap')}>
        <Frame title={groupTitle} avatars={3} badge={tr('botDefaults.diagram.badgeNoMention')}>
          <Bubble side="r">{tr('botDefaults.diagram.msgDuty')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
          <Bubble side="r">{tr('botDefaults.diagram.msgStatus')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgReplyShort')}</Bubble>
        </Frame>
      </Diagram>
    );
  }

  if (props.mode === 'ambient') {
    return (
      <Diagram token="ambient" caption={tr('botDefaults.diagram.mentionAmbientCap')}>
        <Frame title={groupTitle} avatars={3}>
          <Bubble side="r">{tr('botDefaults.diagram.msgStatus')}</Bubble>
          <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
          <Bubble side="r">{tr('botDefaults.diagram.msgAtPeer')}</Bubble>
          <SilentTag text={tr('botDefaults.diagram.tagYield')} />
        </Frame>
      </Diagram>
    );
  }

  // always（默认）
  return (
    <Diagram token="always" caption={tr('botDefaults.diagram.mentionAlwaysCap')}>
      <Frame title={groupTitle} avatars={3}>
        <Bubble side="r">{tr('botDefaults.diagram.msgDuty')}</Bubble>
        <SilentTag text={tr('botDefaults.diagram.tagSilent')} />
        <Bubble side="r">{tr('botDefaults.diagram.msgAtBotLog')}</Bubble>
        <Bubble side="l">{tr('botDefaults.diagram.msgReply')}</Bubble>
      </Frame>
    </Diagram>
  );
}

/* ── 默认工作目录模式 ─────────────────────────────────────────────────── */

export function WorkingDirModeDiagram(props: { mode: 'off' | 'default' | 'oncall' }): React.JSX.Element {
  const tr = useT();

  if (props.mode === 'default') {
    return (
      <Diagram token="default" caption={tr('botDefaults.diagram.wdDefaultCap')}>
        <div className="bd-md-flow">
          <FlowNode icon="session" title={tr('botDefaults.diagram.flowNewSession')} />
          <FlowArrow />
          <FlowNode
            icon="folder"
            title={tr('botDefaults.diagram.flowDefaultFolder')}
            badges={[tr('botDefaults.diagram.badgePermsUnchanged')]}
          />
        </div>
      </Diagram>
    );
  }

  if (props.mode === 'oncall') {
    return (
      <Diagram token="oncall" caption={tr('botDefaults.diagram.wdOncallCap')}>
        <div className="bd-md-flow">
          <FlowNode icon="session" title={tr('botDefaults.diagram.flowNewSession')} />
          <FlowArrow />
          <FlowNode
            icon="folder"
            title={tr('botDefaults.diagram.flowDefaultFolder')}
            badges={[
              tr('botDefaults.diagram.badgeAutoBind'),
              tr('botDefaults.diagram.badgeOpenChat'),
            ]}
            avatars
          />
        </div>
      </Diagram>
    );
  }

  // off（默认）
  return (
    <Diagram token="off" caption={tr('botDefaults.diagram.wdOffCap')}>
      <div className="bd-md-flow">
        <FlowNode icon="session" title={tr('botDefaults.diagram.flowNewSession')} />
        <FlowArrow />
        <FlowNode
          icon="card"
          title={tr('botDefaults.diagram.flowPickCard')}
          sub={tr('botDefaults.diagram.flowPickCardSub')}
        />
        <FlowArrow />
        <FlowNode icon="folder" title={tr('botDefaults.diagram.flowPickedFolder')} />
      </div>
    </Diagram>
  );
}
