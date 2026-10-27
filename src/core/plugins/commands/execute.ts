import type { PluginCommandGateway } from './gateway.js';

export interface PluginSlashCommandInput {
  cmd: string;
  /** Whole routed invocation (`/work-bind status`); the plugin gets only the args. */
  content: string;
  /** null = two enabled plugins declare `cmd`; fail closed. */
  pluginId: string | null;
  larkAppId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | undefined;
  anchor: string;
  messageId: string;
  senderOpenId: string | undefined;
  senderUnionId: string | undefined;
  locale: string;
}

/** Host-side authority checks and IO, injected so the admission order is testable. */
export interface PluginSlashCommandDeps {
  /** grant-restriction text for a restricted member, undefined when unrestricted. */
  restrictedText(): string | undefined;
  canTalk(): boolean;
  canOperate(): boolean;
  onAdmitted(): void;
  execute: PluginCommandGateway['execute'];
  reply(content: string, msgType: 'text' | 'interactive'): Promise<unknown>;
  text(key: 'daemon.cmd_allowed_users_only' | 'daemon.plugin_command_conflict' | 'daemon.plugin_command_unavailable'): string;
}

/**
 * Run a Lark slash command declared by a plugin (`kind: 'plugin'` route). It
 * never creates a session, never reaches the CLI and never spends quota: the
 * plugin service answers with an optional text/card that the host posts back.
 * Admission is grant restriction → canTalk → conflict; management authority
 * travels to the plugin as host-computed `privileges`, never inferred from args.
 */
export async function runPluginSlashCommand(input: PluginSlashCommandInput, deps: PluginSlashCommandDeps): Promise<void> {
  const restrictedText = deps.restrictedText();
  if (restrictedText) {
    await deps.reply(restrictedText, 'text');
    return;
  }
  const canTalk = deps.canTalk();
  if (!canTalk) {
    await deps.reply(deps.text('daemon.cmd_allowed_users_only'), 'text');
    return;
  }
  if (input.pluginId === null) {
    await deps.reply(deps.text('daemon.plugin_command_conflict'), 'text');
    return;
  }
  deps.onAdmitted();
  const outcome = await deps.execute(input.pluginId, {
    eventId: input.messageId,
    larkAppId: input.larkAppId,
    command: input.cmd,
    args: input.content.replace(/^\S+/, '').trim(),
    chat: { chatId: input.chatId, chatType: input.chatType ?? null, anchor: input.anchor },
    sender: { openId: input.senderOpenId ?? null, unionId: input.senderUnionId ?? null },
    privileges: { canOperate: deps.canOperate(), canTalk },
    locale: input.locale,
  });
  if (!outcome.ok) {
    await deps.reply(deps.text('daemon.plugin_command_unavailable'), 'text');
    return;
  }
  if (!outcome.reply) return;
  if (outcome.reply.kind === 'text') {
    await deps.reply(outcome.reply.text, 'text');
    return;
  }
  await deps.reply(JSON.stringify(outcome.reply.card), 'interactive');
}
