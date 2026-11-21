# Pane 桌面指导

先绑定目标窗口，再打开聊天工具栏的 **桌面指导**。可在窗口预览内拖拽框选，也可截取屏幕感知标出的变化区。输入控件名称定位，选择候选项和高亮样式，再切换到目标窗口查看。开始教学时输入任务，按步骤亲自操作。点击 **检查结果** 读取当前 UIA 状态。证据不足时，可核对预期结果后手动确认。

图像授权默认关闭，每次提交定位或教学后重置。仅在 UIA 没有候选且用户授权图像时，请求视觉定位。生成教学步骤会向当前模型发送任务和最多 18 个可见的相关控件名称及角色，勾选图像授权时另附一张目标截图。局部区域已选定时，请求使用该区域的最新截图。

## 右上角任务栏

生成步骤后，Pane 会收起控制面板，在目标窗口所在显示器的右上角显示当前步骤。任务栏让鼠标点击穿透，并在目标窗口离开前台、指导暂停或结束时隐藏。点击浮动助手或托盘的 **打开桌面指导** 可继续检查结果和切换步骤。关闭面板或聊天窗口会保留进度，使用 **退出教学** 可清理会话。

## 模块与接口

| 模块 | 接口和用途 |
| --- | --- |
| `native/ui-automation.cpp` | `inspectAutomation(HWND, PID)` 在独立子进程用 Microsoft UI Automation 遍历绑定窗口的 Control View，返回 Runtime ID、父子关系、名称、Automation ID、角色、状态与物理像素边界。 |
| `native/window-capture.cpp` | 原辅助程序新增 `uia`、`geometry` 和 `roi`。命令延用助手 PID、目标 `HWND:PID:启动时间`、预期 EXE 和禁止名单参数。ROI 在预期 EXE 后添加四个百万分之一整数坐标 `x y width height`。UIA 和窗口几何返回 JSON，ROI 返回一行 JSON 加 JPEG。 |
| `src/main/element-detector.ts` | `inspect`、`get`、`matchElements` 校验进程归属、控件角色、可见性和边界。匹配状态为 `matched`、`candidates` 或 `missing`。 |
| `src/main/roi.ts` | `regionUnits` 校验窗口内 0–1 的区域；`imageToScreen` 与 `screenToImage` 转换图像和全局物理坐标。WGC 帧与 DWM 窗口尺寸无法对应时，返回无可验证映射。 |
| `src/main/location.ts` 和 `desktop-query.ts` | `LocationEngine.locate` 优先使用 UIA，视觉定位返回最多三个标为估计的候选项。视觉高亮须有用户确认、有效观察、相同窗口几何，并在首次显示前重新捕获并比对原始局部图像。结构化请求使用现有两种 Responses 连接方式。 |
| `src/main/overlay-manager.ts` 和 `overlay-geometry.ts` | `show`、`hide`、`clear` 控制独立透明窗口。高亮支持边框、半透明、箭头、编号、文字和顺序显示。根据 Electron 的物理像素与 DIP 转换、显示器边界和窗口 DPI 验证位置。 |
| `src/main/guidance-tracker.ts` | 在目标显示器上呈现只读任务栏。复用已授权目标的本地窗口几何验证。 |
| `src/main/guidance.ts` | `GuidanceEngine` 解析最多八步的教学，管理待开始、进行中、已完成、待确认和已跳过。指定的可见控件在步骤开始时明确缺失，随后以唯一匹配出现，才允许通过 UIA 确认。其余情况由用户确认。 |
| `src/renderer/GuidePanel.tsx` | 现有 Pane 聊天窗口内的指导面板，管理预览、框选、候选项、高亮和教学进度。 |

`src/shared.ts` 声明接口，`src/main/preload.ts` 暴露固定操作，`src/main/main.ts` 保留可信窗口与主 frame 的 IPC 校验。所有窗口读取由主进程解析当前绑定，渲染进程不能传入任意 HWND 或全局坐标发起扫描和高亮。

| IPC | 输入及返回 |
| --- | --- |
| `ui:inspect`、`ui:findElement`、`ui:getElement` | 读取绑定窗口；可按 `{name?, automationId?, role?}` 匹配，或用 Runtime ID 读取当前可见元素。 |
| `ui:roi`、`ui:changeRoi` | 接收归一化矩形或当前观察变化区的索引；返回一张原始像素尺寸 JPEG、窗口几何和裁剪范围。 |
| `ui:locate`、`ui:highlight`、`ui:clear` | 按控件查询及明确的视觉授权定位；用当前结果签发的候选 ID 和样式请求高亮；清理定位与控件高亮。 |
| `guidance:open`、`guidance:start`、`guidance:state` | 显式提交任务、图像授权和可选 ROI；返回教学状态。 |
| `guidance:check`、`guidance:confirm`、`guidance:next`、`guidance:pause`、`guidance:exit` | 检查当前预期状态、确认或跳过、推进、暂停或恢复、退出。渲染进程订阅 `guidance` 事件。 |

UIA、ROI 和高亮共用现有 HWND、PID、进程启动时间及 EXE 验证。对原生扫描前后的窗口标识及几何重新核验，窗口切换、禁止名单更新、锁屏或系统挂起取消请求。UIA 排除密码控件、编辑框和明显的敏感标签，不读取 Value 或 Text pattern。画面和可访问名称作为不可信数据传入模型，教学内容及图像留在内存。退出教学释放会话及临时数据。窗口变化只触发本地观察和位置校验。Chat、OAuth、API Key 和 SQLite 结构沿用 2.1.1。

## 性能和坐标边界

- UIA 单次最多遍历 180 个节点、10 层，等待上限 1.9 秒。主进程异步等待，可终止阻塞的原生辅助进程。
- ROI 用 WGC 采集目标窗口，并在 WIC 编码前裁剪，保留源像素尺寸。单次最多 1200 万像素，等待上限 3.4 秒。持续观察继续复用已有 WGC 会话。
- 高亮有效期 16 秒，每次校验返回后约 420 毫秒再次检查。校验超过 800 毫秒即隐藏上一次的标记。失去前台、候选消失、坐标或显示器映射不可验证时隐藏。横跨不同显示器的单个矩形或分布在不同显示器的多标记组合会保守隐藏。
- 存量屏幕感知数据只在本地比较和缓存。只有显式打开预览时返回一张 JPEG；控件树不随原生视频帧传输。
- 真实 Windows 夹具的一次开发验收测得 UIA 约 90 毫秒，局部 WGC 约 280 毫秒。这个数值包含进程启动和 IPC 往返，适用于当次夹具和主机。

## 验证范围

Windows 构建 26300 的桌面集成中，使用真实 Chromium 模拟交易窗口、原生 UIA、WGC 和 Win32 命中测试。模拟订单按钮点击计数为零。两个桌面测试均可单独运行。指导测试中的视觉及计划响应使用本地模型替身，安装版测试覆盖打包后的原生路径。真实账户、实际交易软件、Windows 10 和物理混合 DPI 多屏环境待验证。视觉候选无稳定观察或几何不一致时留在截图预览中。受保护窗口、复杂 UAC 或自绘应用能提供的 UIA 信息取决于操作系统与应用。

[Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32) · [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) · [Electron screen 坐标 API](https://www.electronjs.org/docs/latest/api/screen)
