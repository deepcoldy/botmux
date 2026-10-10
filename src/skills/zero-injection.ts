import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Shared skills may belong to another bot. Never remove them on behalf of
 * one zero-injection session, or claim clean input while the CLI loads them. */
export function assertNoGlobalBotmuxSkills(skillsDir: string | undefined): void {
  if (!skillsDir) return;
  const dir = skillsDir.startsWith('~') ? join(homedir(), skillsDir.slice(1)) : skillsDir;
  if (existsSync(dir) && readdirSync(dir).some(name => name.startsWith('botmux-')
    && existsSync(join(dir, name, 'SKILL.md')))) {
    throw new Error(`零注入无法使用全局 botmux 技能目录（${dir}）；请改为按会话注入或使用独立 home`);
  }
}

/** Empty values also override a stale prompt inherited from a parent process
 * or persistent terminal server. Pi/OMP need their boundary extension for
 * final detection, but its prompt-injection lane must stay empty. */
export function clearBotmuxPromptEnv(env: Record<string, string | undefined>): void {
  env.BOTMUX_APPEND_SYSTEM_PROMPT = '';
  env.BOTMUX_APPEND_SYSTEM_PROMPT_FILE = '';
}
