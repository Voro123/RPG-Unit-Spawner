# MCP: Minimax RPG Image Tools

这个项目提供一个 stdio MCP server，让支持 MCP 的 AI 编程客户端在开发游戏时直接调用本项目的 Minimax 图片生成能力。

## 启动命令

```bash
npm run mcp
```

它不会启动 Express 网页服务，只会通过标准输入/输出处理 MCP JSON-RPC 消息。

## 客户端配置示例

把下面的配置加入你的 MCP 客户端配置中，并把路径改成你的本地项目路径：

```json
{
  "mcpServers": {
    "rpg-unit-spawner-minimax": {
      "command": "node",
      "args": ["D:/codes/game/h5/RPG-Unit-Spawner/mcp/server.js"],
      "cwd": "D:/codes/game/h5/RPG-Unit-Spawner"
    }
  }
}
```

也可以使用 npm：

```json
{
  "mcpServers": {
    "rpg-unit-spawner-minimax": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "D:/codes/game/h5/RPG-Unit-Spawner"
    }
  }
}
```

## API key 配置

MCP server 复用现有的服务端配置：`data/config.json`。

最简单的方式是先运行网页应用：

```bash
npm run dev
```

然后打开 `http://localhost:3000/config.html` 填入 Minimax API key。MCP 不会把 API key 返回给客户端，只会通过 `minimax_status` 返回脱敏状态。

## 工具

- `minimax_status`: 检查 Minimax 是否已配置，返回脱敏 key 状态。
- `build_rpg_asset_prompt`: 只构建最终英文 prompt，不生成图片。
- `generate_rpg_asset_image`: 按本项目规则生成 RPG sprite 或 tile 图片。
- `list_projects`: 列出 `data/projects` 下的项目。
- `locate_project`: 通过 `projectId` 或 `projectName` 定位项目，可选择不存在时创建。
- `create_project`: 新建项目。
- `list_sprite_sheets`: 列出项目内的精灵图/地块图 sheet。
- `create_sprite_sheet`: 在项目内新建 sheet。
- `get_sprite_sheet`: 读取 sheet 元数据和已填充 cell 的图片路径。
- `read_sprite_cell_image`: 读取指定 cell 的 PNG。
- `generate_sprite_cell_image`: 调用 Minimax 生成图片，并直接覆盖项目内指定 sheet cell 的原图。
- `update_sprite_cell_image`: 用传入 base64 图片直接覆盖项目内指定 sheet cell 的原图。
- `update_sprite_cell_region_image`: 把一张大 PNG 按指定格子区域缩放切片，批量覆盖多个 cell。
- `export_sprite_sheet_skill`: 导出/覆盖该 sheet 的 `SKILL.md`，说明每个已填充格子的坐标、用途、类型和图片路径。
- `generate_minimax_image_raw`: 使用原始 prompt 直接调用 Minimax。

## 生成文件

默认会把 PNG 保存到：

```text
data/mcp-images
```

这个目录在 `data/` 下，已经被 `.gitignore` 忽略。你也可以在工具参数里传 `outputDir`，但路径必须在当前项目目录内。

## 常用参数

`generate_rpg_asset_image` 支持：

```json
{
  "prompt": "一瓶红色生命药水",
  "assetKind": "sprite",
  "n": 1,
  "saveToFile": true,
  "outputDir": "data/mcp-images",
  "fileNamePrefix": "health-potion"
}
```

生成地块材质时使用：

```json
{
  "prompt": "清新动漫风绿色草地",
  "assetKind": "tile",
  "width": 1024,
  "height": 1024,
  "saveToFile": true,
  "fileNamePrefix": "grass-tile"
}
```

## 直接写入项目精灵图

先定位或创建项目：

```json
{
  "projectName": "Demo RPG",
  "createIfMissing": true
}
```

然后列出项目里的 sheet：

```json
{
  "projectName": "Demo RPG"
}
```

如果没有 sheet，创建一个：

```json
{
  "projectName": "Demo RPG",
  "name": "Items",
  "cellSize": 32,
  "cols": 8,
  "rows": 8,
  "createProjectIfMissing": true
}
```

生成并覆盖某个 cell：

```json
{
  "projectName": "Demo RPG",
  "sheetId": "这里填 create_sprite_sheet 或 list_sprite_sheets 返回的 id",
  "cellIndex": 0,
  "prompt": "一瓶红色生命药水",
  "assetKind": "sprite",
  "tag": "sprite: red health potion"
}
```

如果你已经有一张图片的 base64，也可以直接覆盖 cell：

```json
{
  "projectName": "Demo RPG",
  "sheetId": "这里填 sheet id",
  "cellIndex": 0,
  "imageBase64": "data:image/png;base64,...",
  "tag": "sprite: edited health potion",
  "assetKind": "sprite"
}
```

把一张大图放入多个格子区域：

```json
{
  "projectName": "Demo RPG",
  "sheetId": "这里填 sheet id",
  "startCellIndex": 0,
  "regionCols": 2,
  "regionRows": 2,
  "imageBase64": "data:image/png;base64,...",
  "assetKind": "sprite",
  "cellTags": [
    "large boss sprite top-left part",
    "large boss sprite top-right part",
    "large boss sprite bottom-left part",
    "large boss sprite bottom-right part"
  ]
}
```

`cellTags` 是按行优先顺序写的：先第一行从左到右，再第二行从左到右。长度必须等于 `regionCols * regionRows`。如果不传 `cellTags`，可以传 `tagPrefix`，MCP 会自动生成 `tagPrefix part (x,y)`，但 AI 识别效果不如逐格说明。

每次使用 `generate_sprite_cell_image`、`update_sprite_cell_image` 或 `update_sprite_cell_region_image` 写入项目 sheet 后，MCP 都会自动刷新该 sheet 的：

```text
data/projects/<projectId>/sprites/<sheetId>/SKILL.md
```

这个 `SKILL.md` 会记录：

- 项目和 sheet 信息
- cellSize 和网格尺寸
- 每个已填充 cell 的 index、坐标
- 每个 cell 的用途说明，也就是 tag / `cellTags`
- assetKind
- 原图绝对路径

也可以手动导出：

```json
{
  "projectName": "Demo RPG",
  "sheetId": "这里填 sheet id",
  "writeFile": true
}
```

## Codex 使用约定

在这个仓库里开发游戏素材时，Codex 应优先使用 `rpg-unit-spawner-minimax` MCP 生图和写入项目数据。只有 MCP 不可用、返回不可恢复错误，或你明确要求使用 Codex 自带生图时，才改用 Codex 自身的图片生成能力。
