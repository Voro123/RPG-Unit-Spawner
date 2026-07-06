# MINIMAX 图像生成 API 参考

> 以下为已确认的官方参数（基于 MINIMAX Image Generation OpenAPI，`https://api.minimax.io`）。
> 实现时以 `references` 为准，SKILL.md 不重复罗列细节。

## 概述

- 服务商标识：`minimax`
- 用途：AI 图像生成（像素精灵图、行走图、参考图 i2i）
- 官方文档：`https://platform.minimax.io/docs/api-reference/image-generation-i2i`
- 鉴权：`Authorization: Bearer <API_KEY>`（API key 在用户中心获取，后端持有，不下发前端）

## 端点 (Endpoint)

- `POST https://api.minimax.io/v1/image_generation`
- 请求头：`Content-Type: application/json`、`Authorization: Bearer <API_KEY>`
- 协议：同步返回（url 或 base64），无异步轮询

## 请求结构 (ImageGenerationReq)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | `image-01` 或 `image-01-live`（image-01 支持自定义宽高） |
| `prompt` | string | 是 | 文本描述，最大 1500 字符 |
| `subject_reference` | array | 否 | i2i 参考图，见下 |
| `aspect_ratio` | string | 否 | 默认 `1:1`；可选 `16:9`/`4:3`/`3:2`/`2:3`/`3:4`/`9:16`/`21:9` |
| `width` | integer | 否 | 仅 `image-01` 有效；与 `height` 同设；[512,2048]，须被 8 整除 |
| `height` | integer | 否 | 仅 `image-01` 有效；规则同 `width` |
| `response_format` | string | 否 | `url`（24h 过期）或 `base64`；**决定用 `base64` 直接落盘** |
| `seed` | integer | 否 | 相同 seed+参数可复现 |
| `n` | integer | 否 | [1,9]，默认 1 |
| `prompt_optimizer` | boolean | 否 | 默认 false |

- 若同时提供 `width/height` 与 `aspect_ratio`，**`aspect_ratio` 优先**。
- `subject_reference` 元素结构：
  - `type`: 当前仅 `"character"`（主体参考，建议清晰正面图）
  - `image_file`: 公网 URL 或 Base64 Data URL（`data:image/png;base64,...`）；JPG/JPEG/PNG，<10MB

## 响应结构 (ImageGenerationResp)

```json
{
  "id": "<trace_id>",
  "data": { "image_base64": ["<base64...>"] },   // response_format=base64
  "metadata": { "success_count": 1, "failed_count": 0 },
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

- `data.image_urls`：当 `response_format=url`（24h 过期，勿直接持久化）
- `data.image_base64`：当 `response_format=base64`

## 可用模型 (Models)

| 模型 id | 说明 | 是否默认 |
|---------|------|----------|
| `image-01` | 支持自定义 width/height，适合像素小图下采样 | 默认 |
| `image-01-live` | 实时风格，不支持自定义宽高 | 否 |

## 尺寸与限制 (Limits)

- 最小输出 512×512（`image-01` width/height 范围 [512,2048]，须被 8 整除）。
- **像素小图策略**：MINIMAX 无法直接输出 16×16/32×32，故生成 ≥512px 后由前端
  nearest-neighbor 下采样到 `cellSize`，保证像素清晰、无模糊插值。
- `n` 最多 9；`prompt` 最多 1500 字符。

## 错误码 (Errors)

| status_code | 含义 | 处理建议 |
|------------|------|----------|
| 0 | 成功 | — |
| 1002 | 触发限流 | 重试（退避） |
| 1004 | 账号鉴权失败 | 检查 API key |
| 1008 | 余额不足 | 提示充值 |
| 1026 | 提示词敏感 | 提示用户修改 prompt |
| 2013 | 参数非法 | 校验请求参数 |
| 2049 | API key 无效 | 提示重新配置 |

## 自动 Tag（图像→文本）

- 图像生成接口本身不返回文本描述；自动 Tag 使用 MINIMAX **文本 chat 模型**：
  输入 = 用户生成提示词 + 精灵图上下文（cellSize / 网格 / 已有 tag）+ 「输出简短用法 Tag」指令。
- 确认存在视觉 chat 接口后，可附加格子图像以获得更准确 Tag（作为增强，非必需）。
- `TAG_MODEL` 常量集中配置（默认取当前文本模型，实现时填入具体 id）。
