/**
 * 飞书卡片 JSON 的最小样板 helper（header / config / 回调按钮 / lark_md 文本块）。
 *
 * 只收敛「一字不差重复了几十遍」的字面量，不做任何新的抽象层。硬约束：产物的
 * `JSON.stringify` 必须与手写字面量**逐字节相同**——JSON 对象的键序就是序列化
 * 顺序，而历史调用点的键序并不统一（header 有 title→template 与 template→title
 * 两种写法，按钮是 tag→text→type→value），所以这里按调用点原有的键序各给一个
 * 函数，而不是图省事统一成一种。test/card-builder-wire-golden.test.ts 钉着线上
 * 序列化结果。
 */

/** 卡片 header 色板（飞书 header.template）。保持 string 以兼容既有调用点的宽类型。 */
export type CardHeaderTemplate = string;

export interface PlainText { tag: 'plain_text'; content: string }

export function plainText(content: string): PlainText {
  return { tag: 'plain_text', content };
}

export interface CardHeader { title: PlainText; template: CardHeaderTemplate }
export interface CardHeaderTemplateFirst { template: CardHeaderTemplate; title: PlainText }

/** `header: { title, template }`（title 在前）——流式卡、会话卡、TUI 卡等一类。 */
export function cardHeader(title: string, template: CardHeaderTemplate): CardHeader {
  return { title: plainText(title), template };
}

/** `header: { template, title }`（template 在前）——配置卡、选仓卡、adopt/codex 选择卡等一类。 */
export function cardHeaderTemplateFirst(template: CardHeaderTemplate, title: string): CardHeaderTemplateFirst {
  return { template, title: plainText(title) };
}

export interface WideCardParts {
  /** 缺省则整张卡不带 `header` 键（无头小卡）。 */
  header?: CardHeader | CardHeaderTemplateFirst;
  elements: unknown[];
  /** 并入 `config` 的额外键（如 `update_multi`），排在 `wide_screen_mode` 之后。 */
  extraConfig?: Record<string, unknown>;
}

/**
 * v1 宽屏卡片外壳：`{ config: { wide_screen_mode: true, ...extraConfig }, [header], elements }`。
 * 键序固定为 config → header → elements，与既有手写字面量一致。
 */
export function wideCard({ header, elements, extraConfig }: WideCardParts): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, ...extraConfig },
    ...(header ? { header } : {}),
    elements,
  };
}

/** `{ tag: 'div', text: { tag: 'lark_md', content } }`。 */
export function larkMdDiv(content: string): { tag: 'div'; text: { tag: 'lark_md'; content: string } } {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/** 回调按钮：`{ tag, text, type, value }`（点击回传 value 给 card.action.trigger）。 */
export function callbackButton(
  text: string,
  type: string,
  value: Record<string, unknown>,
): { tag: 'button'; text: PlainText; type: string; value: Record<string, unknown> } {
  return { tag: 'button', text: plainText(text), type, value };
}

/** 链接按钮：`{ tag, text, type, multi_url }`（点击直接打开 URL，不回调）。 */
export function urlButton(
  text: string,
  type: string,
  multiUrl: Record<string, string>,
): { tag: 'button'; text: PlainText; type: string; multi_url: Record<string, string> } {
  return { tag: 'button', text: plainText(text), type, multi_url: multiUrl };
}

export interface SimpleCardOpts {
  title: string;
  template: CardHeaderTemplate;
  /** `{ tag: 'markdown', content }` 正文块（排在最前）。 */
  markdown?: string;
  /** `lark_md` div 正文块（排在 markdown 之后）。 */
  div?: string;
  /** 非空时追加 `{ tag: 'action', actions }`。 */
  buttons?: unknown[];
}

/**
 * 「header + 一段文字 + 一排按钮」的小卡（title→template 键序）：
 * 会话关闭卡、adopt 受阻卡、TUI 状态卡都是这个形状。
 */
export function simpleCard(o: SimpleCardOpts): Record<string, unknown> {
  const elements: unknown[] = [];
  if (o.markdown !== undefined) elements.push({ tag: 'markdown', content: o.markdown });
  if (o.div !== undefined) elements.push(larkMdDiv(o.div));
  if (o.buttons && o.buttons.length > 0) elements.push({ tag: 'action', actions: o.buttons });
  return wideCard({ header: cardHeader(o.title, o.template), elements });
}
