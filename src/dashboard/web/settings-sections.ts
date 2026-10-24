// 全局设置页的区块清单：设置页左侧导航和 ⌘K 设置索引都从这里生成。放在这个轻量
// 模块里：⌘K 索引（入口包）要按它生成条目，设置页本身很重。

export interface SettingsSection {
  /** settings 页 SettingsBlock 的 DOM id：导航点击滚到它，深链 `#/settings?section=<id>` 也落到它。 */
  id: string;
  module: string;
  /** 区块标题的 i18n key，也是导航项的文字。 */
  section: string;
  /** 区块内字段标题的 i18n key；深链带 `field=<key>` 时页面会闪烁定位到该行。 */
  fields: readonly string[];
  /** 区块的其它叫法（i18n key），例如页面标题和设置侧栏用词不同时两种都能搜到。 */
  aliasKeys?: readonly string[];
}

/**
 * 顺序就是设置页上区块的渲染顺序（导航按它排，单测按页面实际渲染校验）。
 * settings 页新增区块 / 字段时同步这里（单测校验 key 都有译文）。
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'settings-access', module: 'settings.moduleGeneral', section: 'settings.sectionAccess', fields: ['settings.publicReadOnly', 'settings.remoteAccess', 'settings.oauthRedirectBase'] },
  { id: 'settings-cards', module: 'settings.moduleGeneral', section: 'settings.sectionCards', fields: ['settings.cardBrandLabel', 'settings.openTerminalInFeishu', 'settings.enableLocalCliOpen', 'settings.localCliOpenMode'] },
  { id: 'settings-group-creation', module: 'settings.moduleGeneral', section: 'settings.sectionGroupCreation', fields: ['settings.groupNamePrefix'] },
  {
    id: 'settings-experimental',
    module: 'settings.moduleGeneral',
    section: 'settings.sectionExperimental',
    fields: [
      'settings.chatBotDiscovery',
      'settings.herdrTraexPlugin',
      'settings.codexRpcInput',
      'settings.autoUpgradeCodexSessions',
      'settings.bypassCodexHookTrust',
      'settings.hideCodexRateLimitModelNudge',
      'settings.codexNotifier',
      'settings.noVisibleOutputHint',
      'settings.crossPrincipalInterruption',
    ],
  },
  { id: 'settings-overload', module: 'settings.moduleGeneral', section: 'settings.sectionHostOverloadAlert', fields: ['settings.hostOverloadAlert'] },
  { id: 'settings-whiteboard', module: 'settings.moduleGeneral', section: 'settings.sectionWhiteboard', fields: ['settings.whiteboardEnable'] },
  { id: 'settings-workflow', module: 'settings.moduleGeneral', section: 'settings.sectionWorkflow', fields: ['settings.workflowEnable'] },
  { id: 'settings-multi-topic', module: 'settings.moduleGeneral', section: 'settings.sectionMultiTopic', fields: ['settings.multiTopicEnable'] },
  { id: 'settings-repo-picker', module: 'settings.moduleGeneral', section: 'settings.sectionRepoPicker', fields: ['settings.repoPickerMode'] },
  { id: 'settings-schedule', module: 'settings.moduleGeneral', section: 'settings.sectionSchedule', fields: ['settings.scheduleTimeZone', 'settings.sessionCleanupEnable', 'settings.sessionCleanupArchiveCodex'] },
  { id: 'settings-prompt-cache', module: 'settings.moduleGeneral', section: 'settings.sectionPromptCache', fields: ['promptCache.ttl', 'promptCache.keepalive'] },
  // 表格型区块在「通用设置」的瀑布流之后单独占满一行，所以排在通用设置最后。
  { id: 'settings-session-env', module: 'settings.moduleGeneral', section: 'sessionEnv.sectionTitle', fields: ['sessionEnv.tmuxTitle'] },
  { id: 'settings-vc', module: 'settings.moduleMeeting', section: 'settings.sectionVcMeetingAgent', fields: ['settings.vcMeetingAgent'] },
  { id: 'settings-autostart', module: 'settings.moduleSystem', section: 'settings.sectionAutostart', fields: ['settings.autostartToggle'] },
  { id: 'settings-maintenance', module: 'settings.moduleSystem', section: 'settings.sectionMaintenance', fields: ['settings.autoUpdate', 'settings.autoRestart', 'settings.httpProxy'] },
  { id: 'settings-update', module: 'settings.moduleSystem', section: 'settings.sectionUpdate', fields: [], aliasKeys: ['update.section'] },
];
