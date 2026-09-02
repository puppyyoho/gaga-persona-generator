import assert from 'node:assert/strict';
import {
    buildLegacyChatStreamingPayload,
    buildLegacyTextStreamingPayload,
    detectHostCapabilities,
    extractGeneratedTextCompat,
    getActiveModelInfo,
    generateRawCompat,
    readOpeningGreetingCompat,
    readPersonaCompat,
    readSelectedConnectionProfile,
    subscribeHostEvents,
} from '../st-compat.js';

const modern = {
    generateRaw: async request => request.prompt,
    loadWorldInfo() {},
    getWorldInfoNames() {},
    Popup: { show() {} },
    powerUserSettings: { persona_description: '现代人设' },
    chat: [{ is_user: false, mes: '当前开场白' }],
    eventSource: { on() {} },
    eventTypes: { CHAT_CHANGED: 'chat_changed' },
    stopGeneration() {},
    ChatCompletionService: { sendRequest() {} },
};
const modernCapabilities = detectHostCapabilities(modern);
assert.equal(modernCapabilities.compatibilityMode, false);
assert.equal(modernCapabilities.generation, true);
assert.equal(modernCapabilities.streaming, true);
assert.deepEqual(modernCapabilities.missing, []);

const rawDataContext = {
    mainApi: 'openai',
    async generateRawData() {
        return { choices: [{ message: { content: '{"profile":{}}' } }] };
    },
    extractMessageFromData(data) {
        return data.choices?.[0]?.message?.content || '';
    },
};
assert.equal(
    await generateRawCompat(rawDataContext, { prompt: '原始响应' }),
    '{"profile":{}}',
);
assert.equal(
    extractGeneratedTextCompat({}, { choices: [{ text: '回退提取' }] }, 'textgenerationwebui'),
    '回退提取',
);
await assert.rejects(
    () => generateRawCompat({
        async generateRawData() {
            return { reasoning: '我正在思考' };
        },
    }, { prompt: '只有思考' }),
    /只返回了思考内容/,
);

const legacy114 = {
    generateRaw: async request => request.prompt,
    loadWorldInfo() {},
    powerUserSettings: { persona_description: '旧版人设' },
    chat: [{ is_user: false, mes: '旧版当前开场白' }],
    eventSource: { on() {} },
    event_types: { CHAT_CHANGED: 'legacy_chat_changed' },
    stopGeneration() {},
    TextCompletionService: { sendRequest() {} },
};
const legacyCapabilities = detectHostCapabilities(legacy114);
assert.equal(legacyCapabilities.compatibilityMode, true);
assert.equal(legacyCapabilities.generation, true);
assert.equal(legacyCapabilities.streaming, true);
assert.deepEqual(legacyCapabilities.missing, []);

assert.equal(await generateRawCompat(modern, { prompt: '生成内容' }), '生成内容');
let quietArguments;
const quietOnly = {
    async generateQuietPrompt(...args) {
        quietArguments = args;
        return '旧版结果';
    },
};
assert.equal(
    await generateRawCompat(quietOnly, { systemPrompt: '系统', prompt: '用户', responseLength: 900 }),
    '旧版结果',
);
assert.deepEqual(quietArguments, ['系统\n\n用户', false, false, 900]);

assert.deepEqual(
    readPersonaCompat({ name1: '小U', powerUserSettings: { persona_description: '描述' } }),
    { name: '小U', description: '描述' },
);
assert.deepEqual(
    readPersonaCompat({ powerUserSettings: { name1: '旧U', personaDescription: '旧字段描述' } }),
    { name: '旧U', description: '旧字段描述' },
);

const liveSettings = { chat_completion_source: 'openai', openai_model: '初始模型' };
const liveModelContext = {
    mainApi: 'openai',
    chatCompletionSettings: liveSettings,
    getChatCompletionModel: settings => settings.openai_model,
};
assert.equal(getActiveModelInfo(liveModelContext).model, '初始模型');
liveSettings.openai_model = '切换后的模型';
assert.equal(getActiveModelInfo(liveModelContext).model, '切换后的模型');
const profileContext = {
    ...liveModelContext,
    extensionSettings: {
        connectionManager: {
            selectedProfile: 'profile-1',
            profiles: [{ id: 'profile-1', name: '备用连接', model: '配置模型' }],
        },
    },
};
assert.equal(readSelectedConnectionProfile(profileContext).name, '备用连接');
assert.equal(getActiveModelInfo(profileContext).label, '备用连接 · 切换后的模型');

assert.deepEqual(
    readOpeningGreetingCompat({ chat: [{ is_user: false, mes: '正在显示的备用开场白' }] }, '默认开场白'),
    { text: '正在显示的备用开场白', source: '当前聊天正在显示的开场白' },
);
assert.deepEqual(
    readOpeningGreetingCompat({ chat: [] }, '默认开场白'),
    { text: '默认开场白', source: '角色卡默认开场白（第一个）' },
);

const subscriptions = [];
const subscribed = subscribeHostEvents({
    eventSource: { on: (event, listener) => subscriptions.push([event, listener]) },
    event_types: { CHAT_CHANGED: 'legacy_chat_changed' },
}, ['CHAT_CHANGED', 'MESSAGE_SWIPED'], () => {});
assert.deepEqual(subscribed, ['CHAT_CHANGED']);
assert.equal(subscriptions.length, 1);

const chatPayload = buildLegacyChatStreamingPayload({
    chat_completion_source: 'openrouter',
    temp_openai: 0.8,
    openai_max_tokens: 777,
    stream_openai: false,
}, [{ role: 'user', content: '测试' }], 'test-model');
assert.equal(chatPayload.stream, true);
assert.equal(chatPayload.model, 'test-model');
assert.equal(chatPayload.temperature, 0.8);
assert.equal(chatPayload.max_tokens, 777);

const textPayload = buildLegacyTextStreamingPayload(
    { type: 'koboldcpp', temp: 0.7 },
    { temperature: 0.7 },
    { prompt: '完整提示词', stream: true, max_tokens: 600 },
    null,
    'http://localhost:5001',
);
assert.equal(textPayload.api_type, 'koboldcpp');
assert.equal(textPayload.api_server, 'http://localhost:5001');
assert.equal(textPayload.prompt, '完整提示词');
assert.equal(textPayload.stream, true);

console.log('st compatibility ok');