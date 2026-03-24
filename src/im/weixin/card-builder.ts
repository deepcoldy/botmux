import type { ImCardBuilder } from '../types.js';

export const weixinCardBuilder: ImCardBuilder = {
  buildSessionCard({ title }) {
    return { payload: `[session] ${title}\n发送消息开始编程。\n输入 /help 查看命令。` };
  },
  buildStreamingCard({ title, content, status }) {
    const statusText = status === 'idle' ? 'done' : status;
    const preview = content ? `\n${content.slice(0, 500)}` : '';
    return { payload: `[${statusText}] ${title}${preview}` };
  },
  buildRepoSelectCard({ projects, currentCwd }) {
    const list = projects.map((p, i) => `${i + 1}. ${p.name} (${p.path})`).join('\n');
    return { payload: `可选项目：\n${list}\n\n回复数字选择，或 /skip 使用 ${currentCwd}` };
  },
};
