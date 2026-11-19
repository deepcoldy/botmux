# Codex 浏览器插件的宿主运行时

Codex 浏览器插件的 service 使用 Node WASI reactor 接口。Bun 1.4.4 的
`node:wasi` 缺少 `getImportObject()` 和 `initialize()`；因此编译版 Botmux
原先虽然能列出标签页，读取 AX 树时仍会失败。

启用浏览器能力的 Bun runner 现在将已安装插件的 **service** 放在一个
Node 子进程中运行。`node` 通过正常 PATH 解析，需要 Node.js 22 或更新版本。
Node 宿主继续使用原来的进程内实现。没有新增地区配置或浏览器控制入口。

- `botmux_browser` 的操作白名单和参数校验保持在拥有会话的 broker 中。
- 站点授权、其它浏览器安全提示、app-server 配置读取和 authenticated fetch
  仍交给同一个会话处理；子进程不改用普通 fetch，也不自行批准提示。
- 一个 broker 复用一个 service 子进程；请求、回调和消息大小都有界限。
  进程退出时拒绝等待者，不重放可能已经发生的浏览器操作。
- worker 程序作为固定源码嵌入二进制，避免外部 Node 进程读取 Bun 虚拟路径，
  也避免打包器将 worker 的内置模块导入改写为宿主私有函数。
- 普通标签页连接失效及 `Debugger unattached` 会使旧 binding 和 claim 失效。
  后续明确操作重新发现连接、重新 claim，失败操作不会自动重试。

插件初始化失败会关闭刚创建的 service，runner 退出时也会回收它。
诊断 stderr 不转发到模型或飞书，防止 SDK 输出凭据或私有响应。

验证包括 Node/Bun 运行时、真实 WASI reactor、字节数组及大整数传输、授权和
authenticated fetch 回传、turn-ended hook、进程退出和编译版 binary smoke。
这些测试不替代真实扩展连接和目标页面的验收。
