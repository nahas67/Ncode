# Ncode Chrome 扩展

英文文档见 [README.md](README.md)。本目录是 Ncode 的 Chrome MV3 扩展工程：侧边栏聊天 UI、
`gemini.google.com` 网页会话 Provider、浏览器/PC 控制层、MCP 客户端，以及运行在 MV3
Service Worker 中的 Ncode Goal Loop 与 Compact & Resume 编排逻辑。

### 项目简介

仓库根目录就是可直接运行的 Chrome 扩展工程根目录（The repository root is the runnable
Chrome extension project root），无需再进入嵌套的 `gemini-nexus/` 目录。运行时代码按能力分组：

| 目录 | 职责 |
| --- | --- |
| `background/` | MV3 模块化 Service Worker：Provider、提示词/工具循环、各类 Manager、Ncode 集成 |
| `content/` | 注入页面的内容脚本（工具栏、选区、Gemini Web 桥接） |
| `sandbox/` | 沙箱 iframe 中的聊天渲染器与 UI 控制器 |
| `sidepanel/` | 侧边栏桥接外壳与窗口动作 |
| `settings/` | 设置页模块入口与桥接 |
| `services/` | 模型 Provider 与响应解析器 |
| `shared/` | 跨运行时工具，按能力分目录：`shared/ui/`、`shared/logging/`、`shared/mcp/`、`shared/media/`、`shared/models/`、`shared/settings/` 等 |
| `css/` | 各 UI 界面拥有的样式表 |
| `assets/`、`vendor/` | 图标、光标以及内置的第三方运行时依赖 |

模块与入口约定：

- 不再保留顶层 `shared/*.js` 兼容入口，跨运行时工具一律放入对应能力目录（例如 `shared/ui/`、`shared/logging/`）。
- 模块目录的聚合入口统一使用目录内 `index.js`。
- 运行域入口保留为各运行域根部的 `index.js`：`background/index.js`、`content/index.js`、
  `settings/index.js`、`sidepanel/index.js`、`sandbox/index.js`。
- 运行时代码文件使用 `snake_case` 命名；`scripts/` 下的构建与打包脚本使用 kebab-case。
- 样式布局回归测试放在对应样式表旁边，例如 `css/settings_layout.test.js`。

### 快速开始

环境要求：Node.js >= 20 以及 Chromium 浏览器。请在仓库根目录（本目录的上一级）执行统一脚本：

```bash
npm run install:all        # 安装 extension 与 pc-daemon 依赖
npm run build:extension    # vite build -> 打包 -> 生成可加载的 extension/dist
npm run test:extension     # 运行扩展项目的 vitest 测试
npm run check              # 语法、smoke、dist 校验与 e2e 验收
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，指向
`extension/dist`。扩展会连接本地 Ncode daemon（`http://127.0.0.1:3001/mcp`），使用 PC
能力前请先运行 `npm run start:daemon`。

### 文档

- [docs/gemini-web-reverse.md](docs/gemini-web-reverse.md)：Gemini Web 逆向请求契约（会话
  token、StreamGenerate/ProcessFile RPC、上传端点与请求头、思考等级标记、模型哈希）。
- 模型目录位于 `shared/models/web_model_catalog.js`，契约漂移检查命令为
  `npm run check:gemini-web`。
- 英文文档：[README.md](README.md)。
- 项目质量指南保留在 `docs/project-guidelines/`，本地工具草稿（例如 `.trellis/`）不会进入
  受版本控制的项目文档。
