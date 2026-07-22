# Botmux Mobile ≈ Codex App 机制：落地方案（暂存）

> 状态：设计备忘，**暂不推进实现**。  
> 背景：希望手机端像 Codex App 一样跨网控制本机/常开执行环境，而不是绑死局域网 Desktop。

## 1. 目标形态（对齐 Codex）

```
手机 Botmux Mobile (薄 UI)
        │  登录 + 安全中继
        ▼
Cloud Mobile Relay (director + cell)
        │  绑定某台 Desktop host
        ▼
Botmux Desktop / runtime（执行面：PTY、worktree、agent、凭证）
```

| Codex | Botmux |
|--------|--------|
| ChatGPT 内 Codex UI | Botmux Mobile |
| 本机/远程 Codex | Desktop runtime |
| Secure relay | Mobile Relay（`BOTMUX_RELAY_URL` + DesktopRelayService） |
| ChatGPT 账号 | Cloud auth（env 配置） |
| 机器睡眠则该环境不可用 | 相同约束 |

**原则**

1. Mobile **永不**成为完整执行面。  
2. Desktop/runtime 是 source of truth。  
3. Relay 只做可达性 + 会话管道（E2EE 已在路径上）。  
4. Direct（`ws://LAN:6768`）保留作同网/开发。  
5. **Platform（多人协作）≠ Mobile Relay**；可共用云身份，职责分开。

## 2. 与「不依赖 Desktop」的边界

- 复刻 Codex = **不依赖「局域网里的 Desktop」**，仍依赖 **某台在线的 Desktop/runtime**。  
- Mac 休眠 → 该机执行面停 → 手机仍控不了那台机（中继解决跨网，不解决睡眠）。  
- 7×24：执行面放常开机 / headless，手机经同一套 Relay 连接。

## 3. 仓库现状（已有骨架）

- 配对 offer：`endpoint` + 可选 `relay: { directorUrl, cellUrl, relayHostId, inviteToken, … }`（mobile-only scope）。  
- Desktop：`DesktopRelayService`、`RelaySessionBroker`、pairing provision。  
- Mobile：`mobile-relay-e2ee-link`、credential、LAN→relay 升级。  
- Env（开源不写死域名）：`BOTMUX_RELAY_URL`（+ cloud login 相关 env）。  
- 开发无 Desktop：`pnpm mock-server`（假数据，非真执行）。

## 4. 落地里程碑（未开工）

1. **运维**：可用的 director/cell + `BOTMUX_RELAY_URL` + cloud login。  
2. **Desktop**：登录后自动上线 broker；配对 QR **默认带 relay**。  
3. **Mobile**：配对优先 relay；同网可降级/升级 direct。  
4. **体验**：机器列表、离线原因（睡眠/断网/未登录）。  
5. **可选**：headless Desktop / 常开 agent。  
6. **远期**：云端执行面（对标 Codex 云沙箱，非当前必须）。

## 5. 明确不做（本阶段）

- 用 Platform 协作层替代 Mobile Relay 协议。  
- 手机内嵌完整 agent/PTY 宿主。  
- 宣称「Mac 休眠后仍可控本机会话」。

## 6. 相关路径

- Desktop relay：`desktop/src/main/runtime/relay/`  
- 配对 offer：`desktop/src/shared/mobile-relay-pairing-offer.ts`  
- Mobile transport：`mobile/src/transport/mobile-relay-*.ts`  
- 品牌/env：`docs/branding.md`  
- 协作 Platform（不同产品）：`docs/platform-design.md`
