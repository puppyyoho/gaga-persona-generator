# 嘎嘎人设生成器 v0.2.7

一个面向 SillyTavern 1.18.0+ 的世界观适配 User Persona 生成扩展。

嘎嘎人设生成器会读取当前角色卡和用户选择的世界书，调用 SillyTavern 当前连接的模型，生成可直接复制到 Persona Description 的新身份。它不会读取当前聊天正文，也不需要额外填写 API Key。

## 当前版本功能

- 修复当前已启用 User Persona 姓名污染新 Persona 的问题。
- 当前 Persona 绑定的世界书仍会被识别，但默认不勾选。
- 性别可选择随机、男、女或双性。
- 种族可选择随机、人类或人外；人外支持指定具体种族。
- 一次生成 3、5 或 7 个兼容同一人设的候选姓名。
- 点击候选姓名后，整份人设中的姓名与别名会同步切换。
- 支持“换一批名字”，不重新生成人设正文。
- 支持 YAML 与带小标题的自然语言两种输出格式，切换格式不重新调用模型。
- 支持精简、标准、详细、超详细和自定义字数（约 300–6000 字）。
- 选择的长度预设会立即同步目标字数；自定义字数留空时保留上一次有效值。
- 可选流式输出：当前 API 或连接管理器支持时边生成边显示，不支持时自动回退为普通生成。
- 增加精简、标准、剧情丰富和自定义内容范围。
- “生成内容（可勾选）”现在会直接展开显示，不需要额外寻找折叠面板。
- 关系网络可选父母、兄弟姐妹、朋友、重要 NPC、前任、伴侣、竞争者和宠物。
- 身体设定与性爱设定可以逐项勾选，未选择的栏目不会进入 Prompt 或结果。
- 世界书预算会参考当前模型上下文大小动态收缩。
- 生成过程中提供停止按钮。
- 最近一次结构化人设、候选姓名、输出格式和选项会保存在扩展设置中。
- 桌面端悬浮入口支持拖动并记住位置；手机端隐藏悬浮入口，避免遮挡页面。
- 扩展设置里的打开按钮固定为横向胶囊样式，避免窄栏中逐字换行。

## 生成内容

默认“标准”预设包括：

- 基本身份
- 外貌与体型
- 性格与行为逻辑
- 成长经历
- 职业、经济与资源
- 能力与限制
- 生活习惯
- 与当前角色的关系

自定义模式还可以选择：

- 父母或监护人、兄弟姐妹、朋友、重要 NPC、前任、当前伴侣、敌人或竞争者、宠物
- 身高与体型、身体比例、胸部、生殖器、第二性征、疤痕与纹身、声音与动作习惯
- 性欲水平、性取向、性癖与偏好、主动或被动倾向、做爱时的反应、身体敏感点、节奏与氛围、禁区、事后互动

## 世界书识别

扩展会自动识别：

- 当前全局 World Info
- 角色主世界书
- 角色附加世界书
- 当前 Chat Lorebook
- 当前 Persona Lorebook
- 角色卡内嵌 Character Book

为避免沿用当前 User 身份，Persona Lorebook 不会默认勾选，但仍可以在“世界书范围”中手动选择。

大型世界书会优先保留常驻和高顺序规则，并根据当前上下文预算截取。结果区会显示实际读取条目数。

## 安装

推荐在 SillyTavern 的 Extensions 面板中选择“安装扩展”，粘贴仓库地址：

    https://github.com/puppyyoho/gaga-persona-generator.git

也可以把整个文件夹放到当前用户扩展目录：

    SillyTavern/data/<你的用户>/extensions/persona-forge/

旧式全局扩展目录：

    SillyTavern/public/scripts/extensions/third-party/persona-forge/

安装后刷新 SillyTavern 页面。

## 使用

1. 进入某个角色聊天。
2. 在 Extensions 设置中打开嘎嘎人设生成器，或点击桌面端的可拖动悬浮按钮。
3. 选择随机生成或定向生成。
4. 选择性别、种族、候选姓名数量和生成倾向。
5. 选择人设长度，或在“自定义字数”中填写目标字数。
6. 在“生成内容（可勾选）”中使用预设或逐项勾选想生成的内容。
7. 确认世界书范围后点击“生成人设”。
8. 从候选姓名中选择一个名字。
9. 选择 YAML 或自然语言格式。
10. 点击“一键复制”。

## 输出格式

YAML 模式适合结构化编辑、字段锁定和后续保存为 Persona。

自然语言模式使用“【基本身份】”“【外貌与体型】”等小标题，更适合直接阅读和粘贴。

两种格式使用同一份内部人设数据，因此切换格式不会重新生成，也不会产生额外模型请求。

## 兼容说明

主要公开调用来自 SillyTavern.getContext()：

- generateRaw()
- ChatCompletionService / TextCompletionService（用于当前 API 的流式生成）
- ConnectionManagerRequestService（可选，用于连接管理器配置的流式生成）
- loadWorldInfo()
- getWorldInfoNames()
- extensionSettings
- eventSource / eventTypes
- stopGeneration()

为了识别全局启用和角色附加世界书，扩展还会只读动态导入 world-info.js 中的 selected_world_info 与 world_info.charLore。导入失败时会自动降级。

## 文件

- manifest.json：扩展清单
- index.js：SillyTavern 上下文、界面、模型调用与状态管理
- persona-data.js：栏目定义、结构化 Prompt、候选姓名、YAML 与自然语言渲染
- style.css：桌面、平板与手机响应式样式
- LICENSE：MIT License
