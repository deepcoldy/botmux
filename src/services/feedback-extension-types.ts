export interface FeedbackScope {
  botAppId: string;
  chatId: string;
  sourceMessageId: string;
  round: number;
}

export interface FeedbackPresentationLayer {
  enabled?: boolean;
  rounds?: number[];
  mode?: 'separate' | 'inline' | 'both';
  templateId?: string;
  actionIds?: string[];
}

export interface FeedbackPresentationRule extends FeedbackPresentationLayer {
  id: string;
  match: { chatId: string; sourceMessageId?: string };
}

export interface FeedbackPresentationConfig {
  default: FeedbackPresentationLayer;
  rules: FeedbackPresentationRule[];
}

export interface EffectivePresentation {
  enabled: boolean;
  rounds: number[];
  mode: 'separate' | 'inline' | 'both';
  templateId: string;
  actionIds: string[];
  matched: boolean;
  ruleIds: string[];
}

export interface FeedbackHookRegistration {
  id: string;
  version: number;
  protocolVersion: 1;
  hostId: string;
  command: string[];
  cwd: string;
  allowedBotAppIds: string[];
  allowedChatIds: string[];
  allowedActionIds: string[];
  timeoutMs: number;
  concurrency: number;
  envRefs: Record<string, string>;
  enabled: boolean;
}
