/**
 * coco-picker-keys.ts
 *
 * CoCo (Trae CLI) 的 AskUserQuestion 用一个原生 TUI 选择器作答，它的 PreToolUse
 * hook **不能**像 Claude 那样用 directive 把答案塞回去（实测：返回
 * updatedInput.answers 后 CoCo 照样弹原生 picker）。因此 botmux 改为：hook 把
 * 结构化问题注册成飞书选择卡，用户答完后由 worker 用按键序列驱动这个原生
 * picker 自动作答。本模块把「每题选中的 key」翻译成确定的按键序列。
 *
 * 实测的 picker 键位模型（CoCo 0.120.38）：
 *   每题（光标从第 0 行起，Down/Up 移动）：
 *     - 单选：Down×idx 到目标项 → Enter（选中并**自动跳下一题**）
 *     - 多选：每个选中项 Down 到位 + Space 勾选；再 Down 到末尾的 "Next" 行 + Enter 进下一题
 *       行布局：options 占 0..L-1，"Type something" 在 L，"Next" 在 L+1
 *   全部答完进 "Review your answers"：光标默认在 "Submit answers"（第 0 行），Enter 提交
 *
 * navKeys 只负责「答完所有题、停在 Review 屏」；最后那记提交 Enter 由 worker 在
 * 确认 Review 屏出现后单独补发（见 worker driveCocoPicker），避免屏幕切换还没渲染
 * 完就把提交键打飞。
 */

import type { AskQuestion } from './ask-types.js';

export interface CocoPickerPlan {
  /** 导航 + 选择所有问题、最终停在 Review 屏的按键序列（不含提交 Enter）。 */
  navKeys: string[];
}

/**
 * 把 broker 的 answers（answers[i] = 第 i 题选中的 key 数组）翻译成驱动 CoCo
 * 原生 picker 的按键序列。questions[i].options 的 key 与 answers[i] 里的 key 对应。
 */
export function computeCocoPickerKeys(
  questions: ReadonlyArray<AskQuestion>,
  answers: ReadonlyArray<ReadonlyArray<string>>,
): CocoPickerPlan {
  const navKeys: string[] = [];

  questions.forEach((q, qi) => {
    const opts = q.options;
    const optionCount = opts.length;
    const selected = answers[qi] ?? [];

    if (!q.multiSelect) {
      // 单选：broker 保证恰好 1 个选中；找不到时兜底选第 0 项（不应发生）。
      const key = selected[0];
      const found = opts.findIndex((o) => o.key === key);
      const idx = found >= 0 ? found : 0;
      for (let i = 0; i < idx; i++) navKeys.push('Down');
      navKeys.push('Enter'); // 选中 + 自动跳下一题
      return;
    }

    // 多选：按升序逐个 Down 到位 + Space 勾选，最后走到 "Next" 行 + Enter。
    const indices = selected
      .map((k) => opts.findIndex((o) => o.key === k))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    let cursor = 0;
    for (const idx of indices) {
      for (let i = cursor; i < idx; i++) navKeys.push('Down');
      navKeys.push('Space');
      cursor = idx;
    }
    const nextRow = optionCount + 1; // options 0..L-1, "Type something"=L, "Next"=L+1
    for (let i = cursor; i < nextRow; i++) navKeys.push('Down');
    navKeys.push('Enter'); // "Next" 进下一题（或进 Review）
  });

  return { navKeys };
}
