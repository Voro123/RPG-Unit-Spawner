# AGENT.md

本文件用于指导 AI Agent / Codex 在本仓库中进行开发、维护和排障。除非用户另有明确要求，所有改动都应遵守这里的项目约定。

## 项目概览

`RPG-Unit-Spawner` 是一个用 **MINIMAX AI 图像生成**制作像素风 RPG 游戏素材的网站和本地后端。

当前主要能力：

- 服务商配置：当前仅支持 `minimax`，API Key 只保存在服务端运行时文件中，绝不能提交到仓库。
- 基本素材精灵图生成：创建/选择后端精灵图，按格子生成、替换、删除、修改 Tag，并同步运行时 `SKILL.md`。
- 区域生成：在精灵图页拖拽框选区域后，生成一张大图并由前端 canvas 切片写入多个格子。
- 行走图生成：基础版，通过通用生成接口生成行走动画表预览。

## 技术栈

- Node.js >= 18，依赖内置 `fetch`。
- Express 4 后端。
- CommonJS 模块系统，不要改成 ESM，除非用户明确要求全项目迁移。
- 前端是原生 HTML/CSS/JavaScript，无构建工具、无打包步骤。
- 当前唯一 npm 依赖是 `express`，新增依赖前要有明确收益。

## 运行命令

```bash
npm install
npm run dev
# 打开 http://localhost:3000
```

注意：当前 `package.json` 只有 `dev` 脚本，没有 `start` 脚本。如果修改 README 或文档，要与实际脚本保持一致；如果需要 `npm start`，应同时在 `package.json` 中补充脚本。

## 目录结构

```text
.
├── README.md
├── package.json
├── server/
│   ├── index.js      # Express 入口、路由、prompt 组装
│   ├── config.js     # data/config.json 配置读写与 key 脱敏
│   ├── minimax.js    # MINIMAX provider：模型列表、图像生成、key 测试
│   └── sprites.js    # 精灵图运行时数据管理、格子 PNG、运行时 SKILL.md
├── public/
│   ├── index.html
│   ├── config.html
│   ├── sprite.html
│   ├── walk.html
│   └── style.css
├── .codebuddy/skills/rpg-unit-spawner/
│   ├── SKILL.md
│   └── references/minimax_api.md
└── data/             # 运行时目录，已 gitignore，不要提交
```

## 运行时数据与安全规则

`data/` 是运行时目录，已在 `.gitignore` 中排除。不要提交、打印或泄露其中的敏感内容。

运行时数据约定：

- `data/config.json`：`{ provider, api_key, model, base_url }`
- `data/sprites/<id>/meta.json`：精灵图元数据。
- `data/sprites/<id>/cells/<index>.png`：单格图片。
- `data/sprites/<id>/SKILL.md`：该精灵图的运行时绑定说明文件。

安全要求：

- API Key 只允许服务端保存和使用，前端只接收 `hasKey`、`apiKeyMask` 等脱敏信息。
- 不要把 API Key 写进日志、README、测试文件、示例文件或提交信息。
- 不要提交 `node_modules/`、`data/`、`*.log`。

## 后端约定

后端入口是 `server/index.js`。

当前主要 API：

- `GET /api/config`：返回 provider/model/baseUrl/hasKey/apiKeyMask/models。
- `POST /api/config`：保存 MINIMAX 配置；`api_key` 留空时保留已有 key。
- `POST /api/config/test`：用一次最小图像生成测试 key 和 base URL。
- `GET /api/sprites`：列出精灵图。
- `POST /api/sprites`：创建精灵图。
- `GET /api/sprites/:id`：读取精灵图 meta。
- `GET /api/sprites/:id/cells/:index`：读取格子 PNG。
- `GET /api/sprites/:id/skill`：读取运行时绑定 `SKILL.md`。
- `POST /api/sprites/:id/cells/:index/generate`：生成格子。
- `POST /api/sprites/:id/cells/:index/replace`：替换格子。
- `DELETE /api/sprites/:id/cells/:index`：删除格子。
- `PUT /api/sprites/:id/cells/:index/tag`：修改 Tag。
- `PUT /api/sprites/:id/cells/:index/image`：把前端切好的 base64 PNG 写入指定格。
- `POST /api/sprites/:id/generate-raw`：生成一张不落盘的大图，供前端切片。
- `POST /api/generate`：通用图像生成，当前用于行走图页。

### Prompt 约定

像素风 prompt 统一从 `server/index.js` 的 `buildPixelPrompt(promptText, ref)` 组装。

当前策略：

- 强制英文像素风约束。
- 对非地形主体使用纯色洋红背景 `#FF00FF`，便于后续 chroma key 抠图。
- 地形/地面类素材要求铺满整张纹理。
- 如果存在参考图，要求主体形状、比例、调色板和风格贴近参考图。

修改 prompt 时要尽量保持：

- 单一主体，不要让模型自发添加边框、背景、装饰或额外物体。
- 像素清晰，不要抗锯齿、模糊、渐变、写实。
- 非地形主体使用纯色背景；地形纹理填满画面。

## MINIMAX 集成约定

MINIMAX 实现在 `server/minimax.js`。

- 可用模型：`image-01`、`image-01-live`。
- 默认 base URL：`https://api.minimax.io`；配置页还支持 `https://api.minimaxi.com`。
- 图像接口：`POST /v1/image_generation`。
- 鉴权：`Authorization: Bearer <API_KEY>`。
- 响应格式固定使用 `response_format: 'base64'`，避免 URL 24 小时过期。
- `image-01` 支持 `width`/`height`，当前会 clamp 到 `[512, 2048]` 且对齐到 8 的倍数。
- `n` 会被限制在 `[1, 9]`。
- 参考图使用 `subject_reference: [{ type: 'character', image_file: <data-url-or-base64> }]`。

错误处理当前会抛出 `MINIMAX_ERR_<code>: <message>`。如果增强错误提示，优先在服务端映射常见错误码，并让前端显示用户可理解的中文提示。

## 前端约定

前端位于 `public/`，每个页面内联自己的脚本：

- `index.html`：入口导航和模块介绍。
- `config.html`：MINIMAX base URL、API Key、模型配置和连接测试。
- `sprite.html`：精灵图创建、格子选择、区域选择、生成/替换/删除、Tag 修改、导出 ZIP。
- `walk.html`：行走图基础生成页。
- `style.css`：全局暗色 UI 与精灵图网格样式。

前端实现要求：

- 不引入构建流程，除非用户明确要求。
- 图片缩放、下采样、切片、整表导出优先使用浏览器 canvas。
- canvas 上下采样时保持 `imageSmoothingEnabled = false`。
- 图片预览保持 `image-rendering: pixelated`。
- UI 文案保持中文为主。

## 精灵图数据规则

`server/sprites.js` 负责精灵图运行时数据。

创建精灵图默认值：

- `cellSize = 32`
- `cols = 8`
- `rows = 8`
- `name = 未命名精灵图`

每个 cell 的形状：

```json
{ "index": 0, "col": 0, "row": 0, "imageRef": null, "tag": null }
```

保存格子时：

- 图片写入 `data/sprites/<id>/cells/<index>.png`。
- `imageRef` 设为 `cells/<index>.png`。
- 如果传入 `tag`，更新该格 Tag。
- 每次增删改后重新写运行时 `SKILL.md`。

删除格子时：

- 清空 `imageRef` 和 `tag`。
- 尝试删除对应 PNG，文件不存在也不报错。
- 重新写 meta 和运行时 `SKILL.md`。

参考图优先级：

1. 前端上传图。
2. 前端选择的当前图子图。
3. 自动：当前精灵图第一张已有子图。
4. 自动：其他精灵图中最近修改的第一张已有子图。
5. 无参考图。

## 与设计文档的已知差异

`.codebuddy/skills/rpg-unit-spawner/SKILL.md` 描述了更完整的目标方案，但当前代码有一些未完全实现的点：

- `README.md` 和 `.codebuddy` 文档写的是 `npm start`，当前 `package.json` 实际只有 `npm run dev`。
- 设计文档说“自动 Tag 使用 MINIMAX 文本 chat 模型”，当前 `generateCell()` 实际直接把用户 prompt 作为 Tag。
- 行走图模块仍是基础版：生成整图预览，没有完整的方向 × 帧切片、首帧参考或固定 seed 工作流。
- 透明背景未真正实现；当前 prompt 使用纯色洋红背景，适合后续 chroma key。
- `.codebuddy` 文档提到 `public/app.js`，当前仓库没有该文件，页面脚本是内联的。

Agent 修改相关功能时，应优先以“当前代码真实状态”为准，同时参考 `.codebuddy/skills/rpg-unit-spawner/` 中的目标设计。

## 开发原则

- 保持项目简单：原生前端 + Express 后端 + 最少依赖。
- 不要把运行时数据或用户素材提交进仓库。
- 不要在前端保存、显示或传递完整 API Key。
- 不要随意改变 API 路径；如需改变，必须同步更新前端调用和文档。
- 对用户输入做基础校验，错误返回 JSON：`{ error: "CODE_OR_MESSAGE" }`。
- 生成相关接口的请求体可能包含 base64 图片，保留足够的 JSON body limit。
- 新增文件时优先按现有目录职责放置；不要为了小改动引入复杂架构。
- 修改 UI 时保持暗色风格、中文文案、像素素材预览清晰。

## 手动验收清单

目前仓库没有自动测试。完成改动后至少手动检查：

1. `npm install` 能成功。
2. `npm run dev` 能启动，页面可访问 `http://localhost:3000`。
3. 配置页能读取、保存 `base_url`、`model`，API Key 留空时不会清空已有 key。
4. 未配置 key 时，精灵图页和行走图页显示配置提示。
5. 精灵图页能新建精灵图并渲染网格。
6. 有可用 MINIMAX key 时，单格生成、替换、删除、Tag 修改可用。
7. 区域框选生成能生成大图、切片、写入多个格子。
8. 导出 ZIP 中应包含整表 PNG、`meta.json`、运行时 `SKILL.md`。
9. 行走图页能调用 `/api/generate` 并显示结果图。
10. 任何改动都不应新增 `data/`、`node_modules/`、`*.log` 到 git。

## 文档维护

修改功能后要同步检查：

- `README.md`
- `.codebuddy/skills/rpg-unit-spawner/SKILL.md`
- `.codebuddy/skills/rpg-unit-spawner/references/minimax_api.md`
- 本文件 `AGENT.md`

如果实现了设计文档中的 TODO，例如真正的 AI 自动 Tag、行走图切片、透明背景/去背，要把“已知差异”改成当前事实。
