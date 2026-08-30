# Persona Forge v0.1.0

一个面向 SillyTavern 1.18.0+ 的 User Persona 生成扩展。

## 这一版已经实现

- 自动读取当前角色卡（Description / Personality / Scenario / Creator Notes 等）。
- 自动识别当前全局 World Info、角色主世界书、角色附加世界书、当前 Chat Lorebook、Persona Lorebook。
- 自动读取角色卡内嵌 Character Book。
- 可手动补选其他世界书。
- 随机生成 / 定向生成两种模式。
- 定向模式支持姓名、关键词、锁定条件、补充要求。
- 4 种生成倾向：均衡适配、世界观优先、高剧情潜力、小概率但合理。
- 默认直接调用 SillyTavern 当前连接的模型，使用 `generateRaw()`；不需要再填 API Key。
- 不读取当前聊天正文，降低聊天剧情对新 Persona 的污染。
- 生成结果一键复制，包含 Clipboard API + 旧浏览器 fallback。
- 移动端专门布局：手机全屏面板、单列字段、触控尺寸、safe-area、iOS 输入框防自动放大、移动端悬浮入口。
- 大型世界书会按通用规则优先并在字符预算内截取，结果区会提示实际读取条目数。
- 最近一次生成结果保存在扩展设置中，重新打开仍可复制。

## 安装

把 `persona-forge` 整个文件夹放到当前用户的 SillyTavern 扩展目录中，例如：

    SillyTavern/data/<你的用户>/extensions/persona-forge/

然后刷新 SillyTavern 页面。

如果你的安装方式仍使用旧式第三方扩展目录，也可以放在：

    SillyTavern/public/scripts/extensions/third-party/persona-forge/

页面刷新后，可以：

1. 在 Extensions 设置中找到 **Persona Forge** 并点击“打开 Persona Forge”。
2. 或点击右下方的 ✨ 悬浮按钮（可在设置里关闭）。

## 使用

1. 进入某个角色聊天。
2. 打开 Persona Forge。
3. 顶部会显示当前角色和自动识别到的世界书。
4. 选择“随机生成”或“定向生成”。
5. 定向模式可填写姓名、关键词与锁定条件。
6. 点击“生成人设”。
7. 生成完成后点击“⧉ 一键复制”。

## 兼容说明

本扩展的主要公开调用都来自 `SillyTavern.getContext()`，包括：

- `generateRaw()`
- `loadWorldInfo()`
- `getWorldInfoNames()`
- `extensionSettings`
- `eventSource` / `eventTypes`

为了准确识别“当前全局启用”和“角色附加世界书”，v0.1.0 额外以动态导入方式只读 `world-info.js` 中的 `selected_world_info` 与 `world_info.charLore`。如果未来 SillyTavern 内部路径变化，这部分失败时扩展会自动降级，其余功能仍会继续工作。

## 文件

- `manifest.json` — SillyTavern 扩展清单
- `index.js` — 识别、Prompt 组装、模型调用、复制与 UI 逻辑
- `style.css` — 桌面 / 平板 / 手机响应式样式

## v0.2 可以继续做

- 一键保存为 SillyTavern Persona。
- 单独选择 Connection Profile 作为“人设生成专用模型”。
- 生成 3 个候选 Persona 并横向比较。
- 对生成结果做第二阶段世界观冲突检查与自动修复。
- 局部锁定字段后只重抽其余部分。
- Persona 头像 Prompt / 头像生成联动。
