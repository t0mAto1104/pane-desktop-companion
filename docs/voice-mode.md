# Pane 本地语音提问

首次使用请在 **设置 → 语音** 下载多语言 Whisper 模型（约 190 MB）。模型下载后保存在 Pane 用户目录，转写可断网运行，无需 API Key。可以选自动识别、中文或英语听写。中英交替提问可选自动识别。Pane 会在长停顿处分段判断语言，同一句中快速切换语言时仍可能漏掉部分术语。

从完整聊天或浮动助手打开的迷你聊天中点击麦克风，等「可以说话」出现再说。录音时可查看实时输入音量，单次最多 24 秒。结束录音后，转写填入输入框，可编辑后再发送。这一步才使用当前 Chat 连接提交确认后的文字。回答可通过现有 Windows 语音在选定输出设备上朗读。

在 **设置 → 语音** 可以选择麦克风和朗读设备，或点击 **试录并回放**。试录约 4 秒，通过选定输出设备播放。Pane 会区分录音太短、没有输入信号、输入音量偏低，以及录到声音但转写为空。试录不需要识别模型，录音和回放都只保留在内存。隐藏窗口、锁屏或休眠会取消正在进行的语音操作。

## 实现

- WASAPI 原生进程流式返回 16 kHz 单声道 PCM，只有主进程接收音频。渲染进程只收到状态和音量。
- 主进程以标准输入管道把 WAV 送给本地 whisper.cpp，并配合 Silero 语音活动检测，减少静音和背景声造成的误转写。音频不写盘，不上传。朗读继续使用 Windows System.Speech。
- `voice:testMic` 试录并回放，`voice:start` 生成聊天草稿，`voice:finish` 结束录音，`voice:cancel` 取消语音操作。`voice:modelStatus`、`voice:modelDownload`、`voice:modelCancel` 管理模型，下载仅由用户点击触发。
- 构建通过 `npm run build:whisper` 准备固定版本的 [whisper.cpp b5454](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454) 和 [Silero VAD](https://huggingface.co/ggml-org/whisper-vad)。安装包自带 Windows x64 运行组件，量化 [多语言模型](https://huggingface.co/ggerganov/whisper.cpp) 单独下载并校验 SHA-256。

本地转写速度取决于 CPU、录音长度和环境音。同一模型对不同口音、噪声和专业术语的准确率会有差异。

Windows 上可以用 `node tests/whisper-desktop.mjs <模型路径>` 验证原生转写。测试使用 Windows 合成的普通话、英语和分段混合样本，需要已安装相应的合成语音。
