#!/usr/bin/env node
// 读隔离 v2 一次性迁移:把每个隔离 claude bot「自己配置的 cwd」下的 project 目录
// (含 memory + transcript)从全局 ~/.claude/projects/<cwd-hash> 拷进它的 per-bot
// BOT_HOME:<BOTMUX_HOME>/bots/<appId>/claude/projects/<cwd-hash>。
//
//  - 只迁「按 appId 唯一对得上」的东西:bot 配置里的 workingDir / workingDirs 各自
//    的 cwd-hash。/cd 去过的别的 cwd 不迁(那些 project 目录可能与 admin/别的 bot
//    共享,迁过去会把别人的数据带进来)。
//  - codex 不迁(sessions 全局按日期、无法按 bot 拆;每 bot 从空 CODEX_HOME 起)。
//  - 幂等:目标已存在的文件跳过(--force 覆盖)。默认 DRY-RUN,加 --apply 才真拷。
//
// 用法:
//   node scripts/migrate-read-isolation-v2.mjs            # 预览(dry-run)
//   node scripts/migrate-read-isolation-v2.mjs --apply    # 真执行
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, cpSync, realpathSync, readdirSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const HOME = homedir();
const BOTMUX_HOME = join(HOME, '.botmux');
const BOTS_JSON = join(BOTMUX_HOME, 'bots.json');
const GLOBAL_PROJECTS = join(HOME, '.claude', 'projects');

// claude-code 的旧数据在 ~/.claude/projects(本脚本处理)。seed/relay 也是 claude 家族、
// v2 同样会被重定向+provision,但它们的旧数据在各自 dataDir(.claude-runtime 等),源路径
// 不同 → 本脚本不迁,改为显式告警,避免"静默丢数据"(review L1)。
const CLAUDE_FAMILY = new Set(['claude-code']);
const CLAUDE_FORKS = new Set(['seed', 'relay']);

function cwdHash(cwd) {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* cwd 可能已不存在,用字面量 */ }
  return real.replace(/[^A-Za-z0-9-]/g, '-');
}

function botCwds(bot) {
  const set = new Set();
  if (bot.workingDir) set.add(bot.workingDir);
  for (const d of bot.workingDirs ?? []) set.add(d);
  if (bot.defaultOncall?.enabled && bot.defaultOncall.workingDir) set.add(bot.defaultOncall.workingDir);
  return [...set];
}

if (!existsSync(BOTS_JSON)) { console.error(`未找到 ${BOTS_JSON}`); process.exit(1); }
const bots = JSON.parse(readFileSync(BOTS_JSON, 'utf-8'));
const isolated = bots.filter((b) => b.readIsolation === true && CLAUDE_FAMILY.has(b.cliId));
const forkWarn = bots.filter((b) => b.readIsolation === true && CLAUDE_FORKS.has(b.cliId));
for (const b of forkWarn) {
  console.warn(`⚠️  ${b.larkAppId} 是 claude 家族 fork(${b.cliId}):v2 会重定向+provision,但旧数据在其自身 dataDir(非 ~/.claude/projects),本脚本不迁——如需保留 memory/transcript 请手动拷贝。`);
}

console.log(`${APPLY ? '【APPLY】真执行' : '【DRY-RUN】仅预览(加 --apply 执行)'}`);
console.log(`隔离 claude bot 数:${isolated.length}\n`);

let planned = 0, copied = 0, skipped = 0;
for (const bot of isolated) {
  const botHome = join(BOTMUX_HOME, 'bots', bot.larkAppId, 'claude', 'projects');
  console.log(`● ${bot.larkAppId}  → ${botHome}`);
  for (const cwd of botCwds(bot)) {
    const hash = cwdHash(cwd);
    const src = join(GLOBAL_PROJECTS, hash);
    const dst = join(botHome, hash);
    if (!existsSync(src)) { console.log(`   - ${cwd}  (无全局 project 目录,跳过)`); continue; }
    const hasMem = existsSync(join(src, 'memory'));
    const files = (() => { try { return readdirSync(src).length; } catch { return 0; } })();
    console.log(`   - ${cwd}\n       src: ${src} (${files} 项${hasMem ? ',含 memory' : ''})\n       dst: ${dst}${existsSync(dst) && !FORCE ? '  (已存在,跳过;--force 覆盖)' : ''}`);
    planned++;
    if (APPLY) {
      if (existsSync(dst) && !FORCE) { skipped++; continue; }
      try { mkdirSync(join(botHome), { recursive: true }); cpSync(src, dst, { recursive: true, force: FORCE, errorOnExist: false }); copied++; }
      catch (e) { console.log(`       ⚠️ 拷贝失败:${e.message}`); }
    }
  }
  console.log('');
}
console.log(`计划 ${planned} 个 cwd 目录${APPLY ? `;已拷 ${copied},跳过 ${skipped}` : '(dry-run 未执行)'}`);
console.log('codex:不迁(每 bot 从空 CODEX_HOME 起)。');
