
# Pane for macOS

目标平台为 macOS Sonoma 14 及以上。Apple Silicon 和 Intel 分别使用对应架构的安装包。开发预览与现有 Windows 版本共用聊天、模型连接、SQLite 格式、划词工具栏、浮动助手和指导面板。

| 功能 | macOS 实现 |
| --- | --- |
| 浮动助手、迷你聊天、菜单栏 | 沿用 Electron 窗口。⌃⇧Space 唤出 Pane，⌃⇧Q 读取选区 |
| 窗口截图、局部截图、屏幕感知 | ScreenCaptureKit 捕获绑定的窗口。身份由窗口编号、进程 PID、进程启动时间和应用标识共同校验 |
| 划词 | Accessibility 仅读取当前选区。应用支持选择通知时使用 AX 事件，否则鼠标拖选可触发一次查询，键盘选择可用快捷键 |
| 桌面指导 | Accessibility 提供控件位置，无法读取时可主动使用视觉识别。覆盖层使用逻辑坐标，截图使用实际像素 |
| 语音 | Core Audio 输入和输出设备选择、本地 Whisper 转写、系统语音朗读。转写内容进入聊天草稿 |
| 模型和历史 | 现有 ChatGPT 登录、Responses API、API Key 模式和本地 SQLite。凭据由 Electron 安全存储通过 macOS 钥匙串加密 |

在 Pane 的「设置 → macOS 系统权限」里，可分别授权屏幕录制、辅助功能和麦克风。按照系统提示重开 Pane 后再试。自动划词还需在「全局划词」开启。个别应用不提供可读选区，可以手动复制后用工具栏导入。受保护窗口和密码字段会被排除。禁用名单每行填写一个应用标识，例如 com.apple.TextEdit。

## 构建预览

在目标架构的 Mac 上安装 Xcode 命令行工具、CMake 和 Node.js 24.13+，在仓库根目录运行：

```sh
npm ci --legacy-peer-deps
npm run dist:mac -- -c.mac.identity=- -c.mac.hardenedRuntime=false
npm run test:mac -- --packaged
```

安装包和 ZIP 压缩包输出到 release 目录。预览使用临时签名。公开分发需要 Developer ID Application 签名和 Apple 公证；在有正式凭据的构建环境运行 npm run dist:mac，并通过 Electron Builder 的环境变量提供签名与公证凭据。

## 验收

构建检查验证 Mach-O 架构、签名、原生帮助程序的协议以及 Whisper 启动。`npm run test:mac -- --packaged --interactive` 额外检查真实 AppKit 测试窗口、禁止名单、截图、ROI、按钮树、选区和窗口关闭。运行交互测试的终端需要系统屏幕录制与辅助功能权限。

本机安装 Chrome 时，可用 `npm run test:mac -- --browser` 检查网页正文、网页输入框、空选区和密码字段。这组测试需要辅助功能权限。

发行前还需在已登录的 Mac 上走查：

1. Finder、Safari、Chrome 和 TextEdit 中从菜单栏或机器人截图、绑定、局部放大以及选区问答。
2. 同时连接 Retina 和非 Retina 显示器，移动目标窗口测试截图清晰度、划词位置及指导标记；切换 Space、锁屏、最小化和退出目标应用后确认敏感状态清理。
3. 使用内建及 USB 或蓝牙麦克风和扬声器试听、切换设备、转写中英短句、检查朗读输出与取消操作。
4. 通过真实 ChatGPT 登录和 API Key 各发送一次带图问题。重启后复查账户、模型和历史。
