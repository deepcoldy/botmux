/**
 * 飞书卡片 JSON 2.0 `table` 组件共享的行高 / 表头样式。
 *
 * 组件默认 `row_height: 'low'` 把每一行钉死成单行高度，单元格文字一旦换行就被
 * 省略号截断（Agent 输出的 Markdown 管道表格内容稍长即中招）。这里统一改用
 * `auto`：行高随内容自适应增长，再用 `row_max_height` 封顶，避免单个超长
 * 单元格把整张卡片撑得过高。
 *
 * 兼容性：`auto` 与 `row_max_height` 需飞书客户端 V7.33+，低版本会忽略这两个
 * 字段、回退到平台默认行高；`header_style.lines` 无版本门槛，表头允许换两行在
 * 所有客户端版本均生效。
 *
 * 参考：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/table
 */

/** 自适应行高下的单格最大高度；飞书允许 32px–999px，约可容纳十余行正文。 */
export const TABLE_ROW_MAX_HEIGHT = '300px';

/** 统一灰底表头；`lines: 2` 让长表头换行展示而不是单行省略。 */
export const TABLE_HEADER_STYLE = Object.freeze({
  text_align: 'left' as const,
  text_size: 'normal' as const,
  background_style: 'grey' as const,
  text_color: 'default' as const,
  bold: true,
  lines: 2,
});

/**
 * 表格根组件样式，展开到 table 元素上：
 * `{ tag: 'table', page_size, ...TABLE_AUTO_ROW_STYLE, columns, rows }`
 */
export const TABLE_AUTO_ROW_STYLE = Object.freeze({
  row_height: 'auto' as const,
  row_max_height: TABLE_ROW_MAX_HEIGHT,
  header_style: TABLE_HEADER_STYLE,
});
