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
