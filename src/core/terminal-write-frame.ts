/**
 * 「这条 WebSocket 到底拿到了什么权限」的**带外**控制帧。
 *
 * 为什么不能混在 PTY 字节流里：终端页以前对每一个 data frame 扫一遍 OSC 1989
 * `write`，于是只读终端里跑一句 `printf` 打出同样的字节，就能把页面的 wsHasWrite
 * 翻成 true（反过来则是把自己打成只读的 DoS）。PTY 里跑的是用户/模型的进程，它的
 * 输出永远只能当数据，绝不能当控制。
 *
 * 通道契约（三条一起才成立，缺一条洞就回来）：
 *   ① worker 在握手完成的**同一个同步 tick** 里把它作为这条 socket 的第一条消息发出；
 *   ② 终端页只在「本连接的第一帧」上尝试解码，且要求**整帧精确匹配**其中一个字面量；
 *   ③ 解出结论后锁存，之后这条连接上的任何字节都只是 PTY 输出；重连先退回未知。
 *
 * 解码只有这一份实现：终端页把 {@link decodeTerminalWriteFrame} 的源码原样嵌进去
 * （那段页面代码住在 worker.ts 的模板字符串里，没法 import），单测跑的也是它，所以
 * 两边不可能各写各的。函数因此必须**自给自足**——不引用任何外部标识符、不出现反引号。
 */

const WRITABLE_FRAME = '{"botmux":"terminal.write","write":true}';
const READONLY_FRAME = '{"botmux":"terminal.write","write":false}';

/** worker 侧：这条 socket 实际拿到的权限，编码成一条带外控制帧。 */
export function terminalWriteFrame(write: boolean): string {
  return write ? WRITABLE_FRAME : READONLY_FRAME;
}

/**
 * 终端页侧：把一帧解成写权限结论，解不出来就是 `null`（当普通数据处理）。
 *
 * `firstFrame` 为假时**一律**返回 null——这正是「PTY 里的进程伪造不了控制帧」那条
 * 保证。函数体里的字面量是故意重复写死的：它会被序列化后嵌进终端页，引用模块级常量
 * 在那边就是 ReferenceError。
 */
export function decodeTerminalWriteFrame(frame: unknown, firstFrame: boolean): boolean | null {
  if (!firstFrame) return null;
  if (typeof frame !== 'string') return null;
  if (frame === '{"botmux":"terminal.write","write":true}') return true;
  if (frame === '{"botmux":"terminal.write","write":false}') return false;
  return null;
}

/** 终端页里那份内嵌解码器的源码（见文件头注释：一份实现，两处运行）。 */
export const decodeTerminalWriteFrameSource = decodeTerminalWriteFrame.toString();
