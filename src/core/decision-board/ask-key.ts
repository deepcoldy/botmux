/**
 * 待拍板内容的指纹（问题 + 选项 + 推荐）。拍板卡片的按钮带着它，决定落库时也记下当时的指纹：
 * 对不上就说明选项后来改过（旧卡片、或同一个选项键换了意思）。只看拍板相关字段，
 * 管家改进展、改阶段不会让指纹变化。单独成文件：store 与卡片都要用，避免互相 import。
 */
import { createHash } from 'node:crypto';
import type { BoardItem } from './model.js';

export function decisionAskKey(item: Pick<BoardItem, 'question' | 'options' | 'recommend'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ q: item.question ?? '', o: item.options.map(o => [o.key, o.label, o.effect ?? '']), r: item.recommend ?? '' }))
    .digest('hex').slice(0, 12);
}

/**
 * 指纹里的文字先规整：全半角（NFKC）、连续空白、句末标点。改写标点宽度、多敲一个空格、问号换成全角都不算改了；
 * 换了说法就算换了一轮（宁可把草稿收进历史，也不把写给旧问题的选择发出去）。
 */
const norm = (text: string | undefined): string => (text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  .replace(/[\s?!.,;:。？！，；：…]+$/u, '');

/**
 * 草稿是写给哪一轮拍板的：待拍板 / 待验收、且有问题或选项时，是问题 + 选项（键、做法、结果）的指纹；否则是空串
 *（进行中、等待中的事项上随手写的说明，不针对哪个问题）。不含推荐：管家只改推荐时，owner 选的选项仍然成立。
 * 问题要算进去：选项常是通用的（是 / 否、A 做 / B 不做），这时问题本身才是要定的事。
 *
 * 草稿存下时记下它；之后这一项离开待拍板、结束，或这一轮换了，指纹对不上，这份草稿就不再算待提交，
 * 收进这一项的历史（见 decision-board-store.ts 的 reconcileDrafts）。
 */
export function draftAskKey(item: Pick<BoardItem, 'state' | 'question' | 'options'>): string {
  if (item.state !== 'decide' && item.state !== 'accept') return '';
  const q = norm(item.question);
  if (!q && item.options.length === 0) return '';
  return DRAFT_ASK_KEY_VERSION + createHash('sha256')
    .update(JSON.stringify({ q, o: item.options.map(o => [norm(o.key), norm(o.label), norm(o.effect)]) }))
    .digest('hex').slice(0, 11);
}

/**
 * 指纹算法的版本，放在指纹第一位。以后改了规整规则就升它：库里旧版本的指纹按「不知道写给哪一轮」处理（和旧构建存的
 * 一样），不会因为算法变了把所有待拍板的草稿一次收走；页面带来的旧版本指纹按现在这一轮算。
 */
export const DRAFT_ASK_KEY_VERSION = '1';

/** 指纹是不是这一版算法算的（空串 = 不针对问题的说明，任何版本都一样）。 */
export function isCurrentDraftAskKey(key: string): boolean {
  return key === '' || key.startsWith(DRAFT_ASK_KEY_VERSION);
}

/** 页面带回来的指纹：空串，或 12 位十六进制。 */
export const DRAFT_ASK_KEY_RE = /^(?:[0-9a-f]{12})?$/;
