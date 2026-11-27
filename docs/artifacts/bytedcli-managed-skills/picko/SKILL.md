---
name: picko-es-tag-distribution
description: 查询招商圈选某个商品标签在 ES 中的数据分布。用户问“某个标签在 ES 的分布/值分布/数量/占比”、要求“先查 TCC 拿字段名再查 ES”，或给出标签中文名时，使用本技能。默认 TCC key 固定为 rule_list_config_PRODUCT_new；默认查询 udc_picko_record 中 entity_status=6 且 entity_end_time 大于当前时间戳的有效记录。
---

# Picko ES Tag Distribution

用于按标签中文名从 TCC 标签配置中定位 ES 字段名，并查询 `udc_picko_record` 的字段值分布。

## 默认实例

- TCC：`namespace=ecom.market.udc_dump`，`dir=/dump_v2`，`env=prod`，`region=CN`
- ES：`psm=byte.es.market_pick`，`idc=lf`，`index=udc_picko_record`，`method=GET`
- 默认 TCC key：固定使用 `rule_list_config_PRODUCT_new`，不要追问用户。

## 执行步骤

### 1. 查 TCC 标签集合

```bash
bytedcli tcc config get ecom.market.udc_dump rule_list_config_PRODUCT_new --env prod -r CN -d /dump_v2 -j
```

从返回的 `data.latest_version.base`（JSON 字符串）中按标签中文名匹配：

- 优先匹配 `desc` 去掉前缀后的精确中文名，例如 `【实时】是否送礼商品` 匹配 `是否送礼商品`。
- 其次用包含匹配处理用户输入的简称。
- 字段名取该标签对象的 `name`。
- 若有同名/近似多项，先列出候选并让用户确认，不要猜。

可用 `python3` 解析保存的输出；不要依赖肉眼在超长 TCC 输出里查找。

### 2. 取最新时间戳

```bash
date +%s
```

作为 ES 查询里的 `entity_end_time.gt`。如果用户明确指定时间戳，以用户指定为准。

### 3. 查 ES 字段值分布

查询 DSL 模板：

```json
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        {"term": {"entity_status": 6}},
        {"range": {"entity_end_time": {"gt": <timestamp>}}}
      ]
    }
  },
  "aggs": {
    "字段值分布": {
      "terms": {
        "field": "<field_name>",
        "size": 20
      }
    }
  }
}
```

命令：

```bash
bytedcli es search --psm byte.es.market_pick --idc lf --index udc_picko_record --method GET --query '<query-json>' --size 0 -j
```

### 4. 受管与普通运行

使用 `bytedcli --botmux-skill-api-contract` 探测运行合同；返回 `botmux.skill-api.v1` 时是受管模式。该标记仅用于分流，不授予任何权限。
受管 ES 查询按宿主精确命令策略选择身份。机器查询需要宿主管理员预先配置受保护且有效的 GDPR 平台登录凭据；缺失或过期时停止并报告宿主认证前提，不在会话中执行登录、安装 doas 或导出令牌。actor 缺少个人 GDPR 身份证明时拒绝，不借机器凭据。

以下 doas 操作仅适用于普通独立运行。

### 5. doas/网络问题处理

如果 ES 查询报 `Failed to install doas`、DNS、TOS 下载失败等沙箱/网络问题，按 Codex 权限规则用 `require_escalated` 重试。

如果提示 `doas installed but not found in PATH`，通常当前目录会生成 `./doas`，可执行：

```bash
chmod +x ./doas
PATH="$PWD:$PATH" DOAS_ZONE=cn bytedcli es search --psm byte.es.market_pick --idc lf --index udc_picko_record --method GET --query '<query-json>' --size 0 -j
```

若 doas 自动检测到 `boe` 或等待扫码，指定 `DOAS_ZONE=cn` 后重试。

## 结果判读与回复

- 从 `aggregations.字段值分布.buckets` 取 `key` 和 `doc_count`。
- 如果 TCC 标签有 `value_options`，把 `key` 映射为中文含义（注意 ES 返回数字时和 TCC 字符串值做字符串化比较）。
- 计算总量和占比；默认保留两位小数。
- 保持短答，包含：标签名、字段名、时间戳、过滤条件、分布表、合计。

回复模板：

```markdown
查到了。

- TCC 标签：`<标签中文名>`
- ES 字段名：`<field_name>`
- 取数时间戳：`<timestamp>`
- 过滤条件：`entity_status = 6` 且 `entity_end_time > <timestamp>`

| 值 | 含义 | doc_count | 占比 |
|---|---|---:|---:|
| `<key>` | `<含义>` | <count> | <pct>% |

合计：<total> 条。
```
