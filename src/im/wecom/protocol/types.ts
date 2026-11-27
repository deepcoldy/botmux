/** Enterprise WeChat identifiers remain native, separate from callback reply tokens. */
export interface WecomAttachment { type: 'image' | 'file'; url: string; aesKey?: string }
export interface WecomInboundMessage {
  messageId: string;
  userId: string;
  conversationId: string;
  chatType: 'single' | 'group';
  text: string;
  replyContext: { requestId: string };
  attachments: WecomAttachment[];
  quote?: { type: string; text: string };
}
export type WecomMessage = WecomInboundMessage;

/** Diagnostic signals contain no sender, bot, request or message content. */
export type WecomInboundEvent = 'callback_received' | 'normalized' | 'invalid_message' | 'callback_before_auth';

/** Verified long-connection event identity; never construct this from message text. */
export interface WecomCardEvent {
  messageId: string; botId: string; userId: string; conversationId: string;
  chatType: 'single' | 'group'; requestId: string; taskId: string; eventKey: string;
  receivedAt: number;
}
export interface WecomTemplateCard {
  card_type: 'button_interaction' | 'text_notice' | 'news_notice' | 'vote_interaction' | 'multiple_interaction'; task_id: string;
  main_title: { title: string; desc?: string };
  source?: {desc?: string; desc_color?: 0 | 1 | 2 | 3};
  horizontal_content_list?: Array<{keyname:string;value?:string}>;
  vertical_content_list?: Array<{title:string;desc?:string}>;
  jump_list?: Array<{type:0|1|2|3;title:string;url?:string;question?:string}>;
  card_action?: {type:0|1|2;url?:string};
  checkbox?: {question_key:string;mode?:0|1;option_list:Array<{id:string;text:string;is_checked?:boolean}>};
  select_list?: Array<{question_key:string;title?:string;option_list:Array<{id:string;text:string}>}>;
  submit_button?: {text:string;key:string};
  sub_title_text?: string;
  button_list?: Array<{ text: string; key: string; style?: number }>;
}

/** The server may have accepted a write whose acknowledgement was lost. */
export class WecomDeliveryUncertainError extends Error {}
