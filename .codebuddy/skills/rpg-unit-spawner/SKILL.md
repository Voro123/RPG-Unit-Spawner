---
name: rpg-unit-spawner
description: >-
  This skill should be used when building, extending, or maintaining the
  rpg-unit-spawner web application — a site that uses MINIMAX AI image
  generation to produce pixel-art game assets. It covers the provider/API-key
  configuration system and the two generation modules: basic sprite (精灵图)
  generation and walking-animation (行走图) generation. Trigger when the user
  mentions rpg-unit-spawner, pixel sprite generation, walking sheets, MINIMAX
  image API, or configuring the image-generation provider/model.
---

# RPG Unit Spawner

## Overview

`rpg-unit-spawner` is a web application that turns natural-language descriptions
into **pixel-art game assets** via a MINIMAX AI image-generation backend. Users
first configure a service provider (currently **MINIMAX only**), supply their API
key, and pick a model; then they use one of two generation modules:

1. **基本素材精灵图生成 (Basic Sprite Generation)** — pick/create a backend sprite
   sheet, then fill its cells (default: next empty) with AI-generated pixel assets;
   each cell gets an auto-generated Tag written into the sheet's bound skill file.
2. **行走图生成 (Walking Animation Generation)** — generate directional walking
   animation sheets (default 4-direction × 3-frame) for RPG actor sprites.

This skill documents the **decided** architecture and the MINIMAX integration
contract. Technical choices below are pre-decided (最优方案); only runtime
secrets and product-direction changes need user input.

## Project Architecture（已决定）

- **Stack**: Node.js (>=18) + Express 后端；前端为**原生 HTML/CSS/JS**（无构建步骤），
  置于 `public/`。单一语言，便于直接 `npm install && npm start` 运行。
- **后端职责**:
  - 配置读写（`provider` / `api_key` / `model`），`api_key` 仅存服务端，不下发前端
  - 代理 MINIMAX 图像生成（前端只传 `prompt + params`）
  - 精灵图管理：列表 / 新建 / 格子 生成·删除·替换·改Tag / bound skill 文件读写
  - 自动 Tag：生成后用 MINIMAX 文本 chat 模型产出简短 Tag
- **存储**（运行时数据，目录 `data/`，整体 gitignore）:
  - `data/config.json` — 服务商配置（`{ provider, api_key, model }`）
  - `data/sprites/<id>/meta.json` — `{ name, cellSize, cols, rows, cells:[{index,col,row,imageRef,tag}] }`
  - `data/sprites/<id>/cells/<index>.png` — 单格图片
  - `data/sprites/<id>/SKILL.md` — 绑定的描述文件（供 AI 无图理解素材）
  - 精灵表预览/整表导出由**前端 canvas 合成**（无需服务端图像处理库，依赖最小）
- **目录**:
  ```
  rpg-unit-spawner/
  ├── .codebuddy/skills/rpg-unit-spawner/   # 本 skill
  ├── public/            # 前端：config.html / sprite.html / walk.html / app.js / style.css
  ├── server/            # 后端
  │   ├── index.js       # Express 入口 + 路由
  │   ├── config.js      # 配置读写
  │   ├── minimax.js     # MINIMAX provider 实现（见 references/minimax_api.md）
  │   └── sprites.js     # 精灵图管理（增删改 + bound skill 文件同步）
  ├── data/              # 运行时数据（gitignored）
  ├── package.json
  └── README.md
  ```
- **运行**: `npm install && npm start` → http://localhost:3000

## Configuration: Service Providers（已决定）

- **Pluggable provider abstraction**；当前仅实现 `minimax`。
- `name`: `minimax`
- `listModels()`: 返回 `["image-01", "image-01-live"]`，默认 `image-01`
- `generateImage(prompt, params)`: 调 `POST /v1/image_generation`（详见 `references/minimax_api.md`）
- **Persisted config**（`data/config.json`，由 配置页 保存）:
  - `provider`: 当前仅 `minimax`
  - `api_key`: 敏感，仅服务端持有
  - `model`: 必须在 `listModels()` 内
- **前端不持有 key**：仅从后端取 `{ provider, model, configured }` 用于渲染表单。
- 校验：`api_key` 非空；`model ∈ listModels()`。

## MINIMAX Integration（已决定）

详见 `references/minimax_api.md`（已填充真实参数）。关键工程决策：

- **`response_format: base64`** 直接落盘，避免 url 24h 过期。
- **像素小图策略**：MINIMAX 最小输出 512×512，无法直接出 16/32px。故生成 ≥512px 后，
  由前端 **nearest-neighbor 下采样**到 `cellSize`，保证像素清晰、无模糊插值。
- **参考图**：经 `subject_reference`（type=`character`，`image_file` 用 base64 Data URL）。
  注意 type 当前仅 `character`，参考图应为主体清晰的图；用于精灵图风格/主体参考。
- **自动 Tag**：用 MINIMAX 文本 chat 模型（`TAG_MODEL` 常量，默认当前文本模型），
  输入 = 用户提示词 + 精灵图上下文（cellSize/网格/已有 tag）+ 「输出简短用法 Tag」指令；
  确认有视觉接口后可附图像增强（非必需）。
- 错误处理：按 `base_resp.status_code` 映射（限流退避重试、鉴权/余额/敏感提示用户等）。

## Module 1: 基本素材精灵图生成（已决定）

**Purpose**: 在后端保存的精灵图上按格子逐个生成/管理像素素材；每格一张子图 + Tag，
并写入该精灵图绑定的 skill 文件，使 AI 无需看图即知每格对应什么素材及用法。

### 数据模型
- 见「Project Architecture」存储约定：`meta.json` + `cells/<index>.png` + `SKILL.md`。
- `cellSize`：用户新建时指定（默认 32）；网格 `cols×rows` 新建时指定（**默认 8×8**），
  **不自动扩展**（保持简单）。

### Workflow
1. **选择/新建精灵图**：无则新建空图，指定 `cellSize`、`cols×rows`。
2. **选目标格**：默认「下一空位」；可手动选格做 删除 / 替换 / 改 Tag。
3. **提示词 + 参考图**：参考图按「参考图规则」选定或上传。
4. **生成**：后端组装 prompt（像素风关键词 + `cellSize` 提示 + 参考图），调 MINIMAX；
   base64 落盘 `cells/<index>.png`，更新 `meta.json`。
5. **自动 Tag**：调 chat 模型生成简短 Tag，写入 `SKILL.md`（追加/更新该格行）。
6. **预览/导出**：前端 canvas 预览单格与整表，支持下载（整表导出含 `meta.json`）。

### 格子操作
- **生成（默认）**：填下一空位（首个无 `imageRef` 的格）。
- **删除**：清空 `imageRef`+`tag`，并同步移除 `SKILL.md` 对应行。
- **替换**：重新生成覆盖该格。
- **修改 Tag**：手动编辑或重新调 AI 生成。

### 参考图规则（优先级 高→低）
1. 用户主动上传的参考图（最高优先）。
2. 用户从「当前精灵图子图片」手动指定的某张。
3. **默认**：当前精灵图的**第一张子图片**。
4. 当前无子图 → 取「**其他精灵图**的第一张子图片」（按**最近修改**排序）。
5. 仍无 → **无参考图**。

### 自动 Tag 与 Bound Skill 文件
- 每生成一格即调 AI 生成**简短 Tag**（该素材是什么、在精灵图的哪个格、如何使用）。
- `SKILL.md` 模板（实现时按此生成/更新）：
  ```markdown
  # 精灵图：<name>
  用途：<一句话>　cellSize：<w>x<h>　网格：<cols>x<rows>

  ## 格子清单
  - 格子<index>(<col>,<row>)：<Tag/用法说明>
  ```
- 增/删/改格时同步维护该文件，保证 AI 后续无图可读懂整张精灵图。

### Prompt 策略
- 像素艺术风格关键词 + `cellSize` 分辨率提示（配合前端下采样保证清晰）。
- 有参考图时注入 `subject_reference`（`in the style / keep subject of reference`）。
- [TODO: 实作时打磨可复用中文/英文 prompt 模板与示例。]

### 输出规格
- 单格 PNG（`cellSize`）；整表由前端 canvas 合成预览/导出（含 `meta.json`）。
- 透明背景：MINIMAX 输出可能非透明，[TODO: 实作时评估是否需服务端去背或要求模型透明]。

## Module 2: 行走图生成（已决定默认，待实现细化）

**Purpose**: 生成角色行走动画表，供 RPG 引擎按帧播放。

**已决定默认**:
- **4 方向**（down/left/right/up）× **3 帧**，单帧 `cellSize` 默认 32。
- 输出网格 4×3（按方向分行、帧分列），前端切片预览/导出。
- **角色一致性**：同一基础提示词 + 固定 `seed`；首帧作 `subject_reference` 保持后续帧一致。
- [TODO: 实现时细化为接口与前端交互；若用户后续要 8 方向再扩展。]

## Resources

### references/
- `minimax_api.md` — MINIMAX 图像生成 API（**已填充真实参数**：端点、鉴权、请求/响应、
  模型、尺寸限制、错误码、自动 Tag 方案）。

### scripts/
[预留：精灵表合成/切片目前在前端 canvas 完成；如需服务端脚本再添加。]

### assets/
[预留：如默认调色板、示例图等。]

---

## 仍需用户确认的事项（仅这些）

- **运行时密钥**：MINIMAX `api_key`（用户自行在配置页填入，不入库/不提交）。
- **产品方向**：若对默认参数（8×8 网格、4 向 3 帧行走图、原生前端）有异议请提出；
  否则按上述「已决定」实现。
- **去背需求**：像素素材是否需要透明背景、是否需服务端去背（见 Module 1 输出规格 TODO）。
