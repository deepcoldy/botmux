/**
 * 话题指令头被拒绝时回给用户的那一句话。
 *
 * 指令头是 fail closed 的（决策 D5）：任一项不合法就整条不生效，所以这条回复是用户
 * 唯一的反馈，必须说清**哪一项**错了，而不是笼统一句「用法错误」。一条消息里可能同时
 * 写错仓库名和模型名，`resolveTopicSpec` 会一次收齐，这里也一次列全。
 *
 * 两条入口（普通群新话题 / thread）共用同一份文案，所以独立成模块而不是长在 daemon 里。
 */
import { t, type Locale } from '../i18n/index.js';
import { CODEX_REASONING_EFFORTS } from '../services/codex-reasoning-effort.js';
import type { TopicHeaderError } from './topic-header.js';
import type { TopicSpec, TopicSpecError } from './topic-spec.js';

/** 把若干条原因包成一条完整回复：原因清单 + 一行用法提示。 */
function wrap(reasons: string[], locale: Locale): string {
  return t('daemon.topic_header_rejected', {
    reasons: reasons.map(r => `· ${r}`).join('\n'),
    usage: t('daemon.topic_header_usage', undefined, locale),
  }, locale);
}

/** 语法层的拒绝（解析器直接判定写错了）。 */
export function topicHeaderErrorText(error: TopicHeaderError, locale: Locale): string {
  const reason = error.kind === 'missing_arg'
    ? t('daemon.topic_header_missing_arg', { directive: `/${error.directive}` }, locale)
    : error.kind === 'duplicate_directive'
      ? t('daemon.topic_header_duplicate', { directive: `/${error.directive}` }, locale)
      : t('daemon.topic_header_unknown_directive', { token: error.token }, locale);
  return wrap([reason], locale);
}

/** 语义层的拒绝（仓库/模型/推理强度校验不过）。 */
export function topicSpecErrorText(errors: readonly TopicSpecError[], locale: Locale): string {
  return wrap(errors.map(error => {
    switch (error.kind) {
      case 'repo_numeric':
        return t('daemon.topic_header_repo_numeric', { arg: error.arg }, locale);
      case 'repo_not_found':
        return t('daemon.topic_header_repo_not_found', { arg: error.arg }, locale);
      case 'repo_worktree_unsupported':
        return t('daemon.topic_header_repo_worktree', undefined, locale);
      case 'model_invalid':
        return t('daemon.topic_header_model_invalid', { arg: error.arg }, locale);
      case 'model_unsupported_cli':
        return t('daemon.topic_header_model_unsupported', {
          cli: error.backendType === 'riff' ? 'riff' : (error.cliId ?? '?'),
        }, locale);
      case 'effort_invalid':
        return t('daemon.topic_header_effort_invalid', {
          arg: error.arg,
          allowed: CODEX_REASONING_EFFORTS.join(' / '),
        }, locale);
      case 'effort_unsupported_cli':
        return t('daemon.topic_header_effort_unsupported_cli', { cli: error.cliId ?? '?' }, locale);
      case 'effort_unsupported_model':
        return t('daemon.topic_header_effort_unsupported_model', {
          effort: error.effort,
          model: error.model ?? '(CLI 默认)',
        }, locale);
    }
  }), locale);
}

/**
 * 指令头只交代了会话规格、没写首轮任务时的确认回复。
 *
 * 这条路径不产生 AI 回合，也就没有流式卡片，这句话是用户唯一能看到的「头部生效了」的
 * 凭据，所以把真正钉下去的东西回显出来，而不是一句笼统的「已就绪」。
 */
export function topicHeaderReadyText(
  spec: TopicSpec,
  locale: Locale,
  /** CLI 实际起在哪个目录 —— 裸 `/repo` 没有解析出的仓库名，回显这个兜底目录。 */
  effectiveWorkingDir?: string,
): string {
  const parts: string[] = [];
  const repo = spec.repoDisplayName ?? spec.workingDir ?? effectiveWorkingDir;
  if (repo) {
    parts.push(t('daemon.topic_header_ready_repo', { repo }, locale));
  }
  if (spec.model) parts.push(t('daemon.topic_header_ready_model', { model: spec.model }, locale));
  if (spec.reasoningEffort) {
    parts.push(t('daemon.topic_header_ready_effort', { effort: spec.reasoningEffort }, locale));
  }
  // 只写了标题时没有可回显的启动项 —— 退回通用的「话题已创建」文案。
  if (parts.length === 0) return t('daemon.force_topic_ready', undefined, locale);
  return t('daemon.topic_header_ready', { summary: parts.join(' · ') }, locale);
}
