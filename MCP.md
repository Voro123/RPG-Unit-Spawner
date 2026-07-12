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
