import type { ImCardBuilder } from '../types.js';

export const weixinCardBuilder: ImCardBuilder = {
  buildSessionCard({ title, terminalUrl }) {
    const lines = [
      `✦ ${title}`,
      '',
      `🔗 终端: ${terminalUrl}`,
      '',
      '发送消息开始编程，输入 /help 查看命令。',
    ];
    return { payload: lines.join('\n') };
  },
  buildStreamingCard({ title, terminalUrl, content, status }) {
    const statusIcon = status === 'idle' ? '✅' : status === 'starting' ? '🚀' : '⏳';
    const lines = [
      `${statusIcon} ${title}`,
      `🔗 终端: ${terminalUrl}`,
    ];
    if (status === 'idle' && content) {
      // Send final output summary when done
      const trimmed = content.trim();
      const preview = trimmed.length > 800 ? trimmed.slice(-800) : trimmed;
      lines.push('', preview);
    }
    return { payload: lines.join('\n') };
  },
  buildRepoSelectCard({ projects, currentCwd }) {
    const list = projects.map((p, i) => `${i + 1}. ${p.name} (${p.path})`).join('\n');
    return { payload: `可选项目：\n${list}\n\n回复数字选择，或 /skip 使用 ${currentCwd}` };
  },
};
