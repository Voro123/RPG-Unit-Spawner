# RPG Unit Spawner

用 **MINIMAX AI 图像生成** 制作像素风游戏素材的网站 + 后台。

## 功能

- **服务商配置**：当前仅 MINIMAX，配置 API Key 与模型（Key 仅存服务端）。
- **基本素材精灵图生成**：选择/新建后端精灵图（按格子），逐个生成像素素材；
  支持生成/删除/替换/改 Tag；参考图自动选取（当前图首格 → 其他图首格 → 上传）；
  生成后自动写入该精灵图绑定的 Skill 文件（AI 无图即懂每格素材与用法）。
- **行走图生成**：通过提示词生成角色行走动画表（基础版，待细化为方向×帧切片）。

## 运行

```bash
npm install
npm start
# 打开 http://localhost:3000
```

1. 打开「配置」页，填入 MINIMAX API Key 并选择模型（默认 `image-01`）。
2. 打开「精灵图生成」页，新建或选择精灵图，填写提示词生成素材。

## 目录

```
server/      Express 后端（配置 / MINIMAX provider / 精灵图管理）
public/      原生前端（config / sprite / walk）
data/        运行时数据（config.json + sprites/，已 gitignore，含敏感信息）
```

## 说明

- MINIMAX 最小输出 512×512，前端以 nearest-neighbor 下采样到 `cellSize` 保证像素清晰。
- 图像以 `base64` 落盘，避免 url 24h 过期。
- 自动 Tag 使用 MINIMAX 文本模型；调用失败回退为提示词截断。
- 详细设计与 API 参数见 `.codebuddy/skills/rpg-unit-spawner/`。
