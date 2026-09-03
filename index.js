import {
    LENGTH_PRESETS,
    PERSONA_NAME_TOKEN,
    SECTION_GROUPS,
    SECTION_PRESETS,
    buildNameRerollPrompt,
    buildPersonaGenerationPrompt,
    buildPersonaRefinementPrompt,
    buildPersonaRefinementSystemPrompt,
    buildPersonaSystemPrompt,
    createDefaultSectionSelection,
    getSelectedSections,
    neutralizePersonaReferences,
    normalizeNameCandidates,
    normalizeCustomSectionPresets,
    normalizeLengthPreset,
    normalizeStructuredResult,
    parseStructuredResponse,
    resolveTargetLength,
    renderStructuredResult,
} from './persona-data.js';
import {
    buildLegacyChatStreamingPayload,
    buildLegacyTextStreamingPayload,
    detectHostCapabilities,
    ensureChatCompletionPayloadModel,
    extractGeneratedTextCompat,
    extractReasoningCompat,
    getActiveModelInfo,
    generateRawCompat,
    getHostContext,
    initializeHostCompatibility,
    readSelectedConnectionProfile,
    readOpeningGreetingCompat,
    readPersonaCompat,
    resolveChatCompletionModel,
    subscribeHostEvents,
} from './st-compat.js';
import {
    buildIndependentApiPayload,
    hasIndependentApiSettings,
    normalizeIndependentApiSettings,
} from './independent-api.js';

const EXTENSION_NAME = 'persona-forge';
const DISPLAY_NAME = '嘎嘎人设生成器';
const SETTINGS_KEY = 'personaForge';
const VERSION = '0.8.0';
const FAB_ICON_URL = new URL('./icon.png', import.meta.url).href;
const DEFAULT_FAB_SIZE = 65;

const state = {
    overlay: null,
    panel: null,
    settingsPanel: null,
    worldInfoRuntime: null,
    floatingResizeBound: false,
    allWorldNames: [],
    activeWorldNames: [],
    personaWorldNames: [],
    selectedWorldNames: new Set(),
    embeddedBook: null,
    lastContextSignature: '',
    generating: false,
    generationEpoch: 0,
    streamAbortController: null,
    structuredResult: null,
    selectedCandidateIndex: 0,
    resultView: 'persona',
    capabilities: null,
    secretRuntime: null,
};

function getContext() {
    return getHostContext();
}

function notify(type, message) {
    const toast = globalThis.toastr;
    if (toast?.[type]) {
        toast[type](message, DISPLAY_NAME);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(String);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
}

function unique(values) {
    return [...new Set(values.filter(Boolean).map(v => String(v).trim()).filter(Boolean))];
}

function getCurrentCharacter(ctx = getContext()) {
    const id = Number(ctx.characterId);
    if (!Number.isInteger(id) || id < 0 || !ctx.characters?.[id]) return null;
    return ctx.characters[id];
}

function characterData(character) {
    return character?.data ?? character ?? {};
}

function getField(character, ...names) {
    const data = characterData(character);
    for (const name of names) {
        const value = data?.[name] ?? character?.[name];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function getCharacterName(character) {
    return getField(character, 'name') || '未选择角色';
}

function getCurrentPersonaContext(ctx = getContext()) {
    return readPersonaCompat(ctx);
}

function getCharacterPrimaryWorld(character) {
    const data = characterData(character);
    return data?.extensions?.world || character?.extensions?.world || '';
}

function getEmbeddedCharacterBook(character) {
    const data = characterData(character);
    const book = data?.character_book || character?.character_book;
    if (!book || typeof book !== 'object') return null;
    return book;
}

async function getWorldInfoRuntime() {
    if (state.worldInfoRuntime) return state.worldInfoRuntime;
    try {
        // This tiny compatibility import is used only to identify SillyTavern's currently selected
        // global books and additional character lorebooks. Lorebook loading itself uses getContext().loadWorldInfo().
        state.worldInfoRuntime = await import('../../../world-info.js');
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not import world-info runtime. Falling back to context-only detection.`, error);
        state.worldInfoRuntime = {};
    }
    return state.worldInfoRuntime;
}

function resolveCharacterLoreMatches(character, charLore) {
    if (!Array.isArray(charLore) || !character) return [];
    const data = characterData(character);
    const aliases = unique([
        character.avatar,
        data.avatar,
        character.name,
        data.name,
        character.filename,
        data.filename,
    ]);

    const matched = [];
    for (const binding of charLore) {
        if (!binding || typeof binding !== 'object') continue;
        const bindingName = String(binding.name ?? '').trim();
        if (!bindingName) continue;
        const isMatch = aliases.some(alias => alias === bindingName || alias.replace(/\.png$/i, '') === bindingName.replace(/\.png$/i, ''));
        if (isMatch) matched.push(...normalizeArray(binding.extraBooks));
    }
    return matched;
}

async function detectWorldBooks() {
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);
    const runtime = await getWorldInfoRuntime();

    const allWorldNames = typeof ctx.getWorldInfoNames === 'function'
        ? normalizeArray(ctx.getWorldInfoNames())
        : normalizeArray(runtime.world_names);

    const active = [];

    // 1) Global World Info selected in SillyTavern.
    active.push(...normalizeArray(runtime.selected_world_info));
    active.push(...normalizeArray(runtime.world_info?.globalSelect));

    // 2) Character primary lorebook.
    active.push(getCharacterPrimaryWorld(character));

    // 3) Character additional lorebooks.
    active.push(...resolveCharacterLoreMatches(character, runtime.world_info?.charLore));

    // 4) Current chat lorebook.
    active.push(...normalizeArray(ctx.chatMetadata?.world_info));

    // Current Persona lorebooks are detected but intentionally not selected by default.
    // This prevents the active User identity from contaminating a newly generated Persona.
    const personaWorlds = normalizeArray(ctx.powerUserSettings?.persona_description_lorebook);

    state.allWorldNames = unique(allWorldNames);
    state.activeWorldNames = unique(active).filter(name => state.allWorldNames.length === 0 || state.allWorldNames.includes(name));
    state.personaWorldNames = unique(personaWorlds).filter(name => state.allWorldNames.length === 0 || state.allWorldNames.includes(name));
    state.embeddedBook = getEmbeddedCharacterBook(character);

    // On first context load, default to active books. Preserve manual user selection afterward.
    const signature = JSON.stringify({
        character: getCharacterName(character),
        active: state.activeWorldNames,
        persona: state.personaWorldNames,
        all: state.allWorldNames,
        embedded: Boolean(state.embeddedBook),
    });

    if (signature !== state.lastContextSignature) {
        const defaultNames = currentMode() === 'refine'
            ? unique([...state.activeWorldNames, ...state.personaWorldNames])
            : state.activeWorldNames;
        state.selectedWorldNames = new Set(defaultNames);
        state.lastContextSignature = signature;
    }

    return {
        all: state.allWorldNames,
        active: state.activeWorldNames,
        persona: state.personaWorldNames,
        embedded: state.embeddedBook,
    };
}

function ensureSettings() {
    const ctx = getContext();
    const root = ctx.extensionSettings;
    const defaults = {
        showFloatingButton: true,
        floatingPosition: null,
        floatingSize: DEFAULT_FAB_SIZE,
        floatingIcon: '',
        lastResult: '',
        lastStructuredResult: null,
        lastMode: 'random',
        lastStyle: 'balanced',
        lastOutputFormat: 'natural',
        streamOutput: true,
        referenceGreeting: false,
        lastSelectedCandidateIndex: 0,
        gender: 'random',
        species: 'random',
        speciesDetail: '',
        nameCount: 5,
        lengthPreset: 'standard',
        targetLength: LENGTH_PRESETS.standard.targetLength,
        customTargetLength: LENGTH_PRESETS.standard.targetLength,
        sectionSelection: createDefaultSectionSelection(),
        customSectionPresets: [],
        apiMode: 'tavern',
        independentApi: normalizeIndependentApiSettings(),
    };
    const current = root[SETTINGS_KEY] && typeof root[SETTINGS_KEY] === 'object'
        ? root[SETTINGS_KEY]
        : {};
    const previousValue = JSON.stringify(current);
    const mergedSections = {
        ...defaults.sectionSelection,
        ...(current.sectionSelection && typeof current.sectionSelection === 'object' ? current.sectionSelection : {}),
        identity: true,
    };
    const migrated = {
        ...defaults,
        ...current,
        floatingSize: clampFloatingSize(current.floatingSize ?? defaults.floatingSize),
        floatingIcon: typeof current.floatingIcon === 'string'
            && current.floatingIcon.startsWith('data:image/')
            ? current.floatingIcon
            : '',
        lengthPreset: normalizeLengthPreset(current.lengthPreset),
        customTargetLength: resolveTargetLength(
            'custom',
            current.customTargetLength ?? (current.lengthPreset === 'custom' ? current.targetLength : defaults.customTargetLength),
        ),
        sectionSelection: mergedSections,
        customSectionPresets: normalizeCustomSectionPresets(current.customSectionPresets),
        apiMode: current.apiMode === 'independent' ? 'independent' : 'tavern',
        independentApi: normalizeIndependentApiSettings(current.independentApi),
    };
    // Remove retired settings from older installations.
    delete migrated.includeSummary;
    delete migrated.maxLoreChars;
    const changed = previousValue !== JSON.stringify(migrated);
    // Keep the same object reference. Several UI operations read settings
    // again while handling one event; replacing the object here would make
    // the caller mutate a stale copy and silently lose its changes.
    Object.assign(current, migrated);
    delete current.includeSummary;
    delete current.maxLoreChars;
    root[SETTINGS_KEY] = current;
    if (changed) {
        ctx.saveSettingsDebounced?.();
    }
    return current;
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

async function getSecretRuntime() {
    if (state.secretRuntime) return state.secretRuntime;
    const candidates = ['/scripts/secrets.js'];
    for (const path of candidates) {
        try {
            const runtime = await import(path);
            if (typeof runtime.writeSecret === 'function') {
                state.secretRuntime = runtime;
                return runtime;
            }
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] Could not load the SillyTavern secret store.`, error);
        }
    }
    return null;
}

function independentApiConfigFromUi({ persist = true } = {}) {
    const settings = ensureSettings();
    const root = state.overlay;
    const current = normalizeIndependentApiSettings(settings.independentApi);
    if (root) {
        current.endpoint = root.querySelector('#pf-independent-api-endpoint')?.value ?? current.endpoint;
        current.model = root.querySelector('#pf-independent-api-model')?.value ?? current.model;
        current.maxTokens = root.querySelector('#pf-independent-api-max-tokens')?.value ?? current.maxTokens;
        current.temperature = root.querySelector('#pf-independent-api-temperature')?.value ?? current.temperature;
    }
    settings.independentApi = normalizeIndependentApiSettings(current);
    if (persist) saveSettings();
    return settings.independentApi;
}

function setIndependentApiStatus(message, type = 'info') {
    const element = state.overlay?.querySelector('#pf-independent-api-status');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function syncApiConnectionUi() {
    const root = state.overlay;
    if (!root) return;
    const settings = ensureSettings();
    const independent = settings.apiMode === 'independent';
    root.querySelectorAll('[data-api-mode]').forEach(button => {
        const active = button.dataset.apiMode === (independent ? 'independent' : 'tavern');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
    const fields = root.querySelector('#pf-independent-api-fields');
    if (fields) fields.hidden = !independent;
    const note = root.querySelector('#pf-tavern-api-note');
    if (note) note.hidden = independent;
    const api = normalizeIndependentApiSettings(settings.independentApi);
    const values = {
        '#pf-independent-api-endpoint': api.endpoint,
        '#pf-independent-api-model': api.model,
        '#pf-independent-api-max-tokens': api.maxTokens || '',
        '#pf-independent-api-temperature': String(api.temperature),
    };
    for (const [selector, value] of Object.entries(values)) {
        const input = root.querySelector(selector);
        if (input && document.activeElement !== input) input.value = value;
    }
    if (note) {
        const context = getContext();
        note.textContent = `使用酒馆当前选择的 API、模型和连接设置（${getActiveModelInfo(context).label}），不会改变酒馆全局配置。`;
    }
    const status = root.querySelector('#pf-independent-api-status');
    if (status && !status.dataset.state) {
        status.textContent = api.secretId
            ? `已保存 API Key（酒馆密钥库） · ${api.model || '未填写模型'}`
            : '尚未保存 API Key。填写后点击“保存独立 API”。';
    }
}

function setApiMode(mode) {
    const settings = ensureSettings();
    settings.apiMode = mode === 'independent' ? 'independent' : 'tavern';
    saveSettings();
    syncApiConnectionUi();
    updateGenerationModelLabel();
}

async function saveIndependentApi() {
    const settings = ensureSettings();
    const config = independentApiConfigFromUi({ persist: false });
    if (!config.endpoint || !config.model) {
        throw new Error('请先填写 API 地址和模型名称。');
    }
    const keyInput = state.overlay?.querySelector('#pf-independent-api-key');
    const key = String(keyInput?.value || '').trim();
    if (key) {
        const runtime = await getSecretRuntime();
        if (!runtime?.writeSecret) {
            throw new Error('当前酒馆版本没有可用的密钥库接口，无法安全保存 API Key。');
        }
        const secretKey = runtime.SECRET_KEYS?.CUSTOM || 'api_key_custom';
        const secretId = await runtime.writeSecret(
            secretKey,
            key,
            `${DISPLAY_NAME} · 独立 API`,
            { allowEmpty: false },
        );
        const resolvedId = String(secretId?.id ?? secretId?.secret_id ?? (secretId || '')).trim();
        if (!resolvedId) throw new Error('酒馆密钥库没有返回有效的 Key 标识。');
        config.secretId = resolvedId;
        keyInput.value = '';
    }
    if (!config.secretId) throw new Error('请填写 API Key 并保存，或先保存已有 Key。');
    settings.independentApi = normalizeIndependentApiSettings(config);
    saveSettings();
    syncApiConnectionUi();
    setIndependentApiStatus(`已保存独立 API：${config.model} · API Key 保存在酒馆密钥库`, 'success');
    notify('success', '独立 API 设置已保存。');
}

async function clearIndependentApiKey() {
    const settings = ensureSettings();
    const config = normalizeIndependentApiSettings(settings.independentApi);
    if (!config.secretId) {
        setIndependentApiStatus('当前没有已保存的 API Key。');
        return;
    }
    const runtime = await getSecretRuntime();
    if (typeof runtime?.deleteSecret !== 'function') {
        throw new Error('当前酒馆版本没有可用的密钥库删除接口。');
    }
    const secretKey = runtime.SECRET_KEYS?.CUSTOM || 'api_key_custom';
    await runtime.deleteSecret(secretKey, config.secretId);
    settings.independentApi = normalizeIndependentApiSettings({ ...config, secretId: '' });
    saveSettings();
    syncApiConnectionUi();
    setIndependentApiStatus('已清除独立 API 的 Key。');
    notify('success', '已清除独立 API Key。');
}

async function testIndependentApi() {
    const settings = ensureSettings();
    const config = independentApiConfigFromUi({ persist: false });
    if (!config.endpoint || !config.model || !config.secretId) {
        throw new Error('请先填写地址、模型，并保存 API Key。');
    }
    const service = getContext()?.ChatCompletionService;
    if (typeof service?.sendRequest !== 'function') {
        throw new Error('当前酒馆版本没有 Chat Completion 请求接口，无法使用独立 API。');
    }
    setIndependentApiStatus('正在测试连接…');
    const payload = buildIndependentApiPayload(config, [
        { role: 'user', content: '请只回复 OK' },
    ], { stream: false });
    payload.max_tokens = 8;
    const response = await service.sendRequest(payload, true);
    const text = extractGeneratedTextCompat(getContext(), response)
        || (typeof response === 'string' ? response : response?.content ?? response?.text ?? '');
    if (!String(text).trim()) throw new Error('API 已响应，但没有返回可读内容。');
    setIndependentApiStatus(`连接成功：${config.model} · 已收到测试响应`, 'success');
    notify('success', `独立 API 连接成功：${config.model}`);
}

function updateGenerationModelLabel(ctx = getContext()) {
    const modelLabel = state.overlay?.querySelector('#pf-generation-model');
    if (!modelLabel) return;
    const settings = ensureSettings();
    if (settings.apiMode === 'independent') {
        const api = normalizeIndependentApiSettings(settings.independentApi);
        modelLabel.textContent = `独立 API · ${api.model || '未配置模型'}`;
        return;
    }
    modelLabel.textContent = getActiveModelInfo(ctx).label;
}

function escapeAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function createStaticUi() {
    if (document.getElementById('pf-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'pf-overlay';
    overlay.className = 'pf-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <section class="pf-modal" role="dialog" aria-modal="true" aria-labelledby="pf-title">
            <header class="pf-header">
                <div class="pf-heading-wrap">
                    <div class="pf-kicker">${DISPLAY_NAME} <span class="pf-version">v${VERSION}</span></div>
                    <h2 id="pf-title">世界观适配 User 人设生成器</h2>
                    <div class="pf-context-line" id="pf-context-line">正在读取当前角色与世界书…</div>
                </div>
                <button class="pf-icon-button" id="pf-close" type="button" aria-label="关闭"><span class="pf-close-glyph" aria-hidden="true"></span></button>
            </header>

            <div class="pf-scroll">
                <section class="pf-card pf-status-card">
                    <div class="pf-compat-note" id="pf-compat-note" hidden></div>
                    <div class="pf-status-grid">
                        <div>
                            <span class="pf-label-mini">当前角色</span>
                            <strong id="pf-character-name">—</strong>
                        </div>
                        <div>
                            <span class="pf-label-mini">当前 U</span>
                            <strong id="pf-current-persona-name">—</strong>
                        </div>
                        <div>
                            <span class="pf-label-mini">生成模型</span>
                            <strong id="pf-generation-model">跟随 SillyTavern 当前连接</strong>
                        </div>
                    </div>
                    <div class="pf-book-summary">
                        <span class="pf-label-mini">自动识别到的世界书</span>
                        <div class="pf-chip-wrap" id="pf-active-book-chips"></div>
                    </div>
                </section>

                <section class="pf-card pf-api-card">
                    <div class="pf-section-head">
                        <div>
                            <h3>API 连接</h3>
                            <p id="pf-api-description">默认跟随酒馆当前连接；也可以单独填写 OpenAI 兼容 API。</p>
                        </div>
                    </div>
                    <div class="pf-segmented" role="radiogroup" aria-label="API 连接方式">
                        <button type="button" class="pf-segment is-active" data-api-mode="tavern" role="radio" aria-checked="true">🔗 跟随酒馆</button>
                        <button type="button" class="pf-segment" data-api-mode="independent" role="radio" aria-checked="false">🔑 独立 API</button>
                    </div>
                    <div class="pf-inline-note" id="pf-tavern-api-note">使用酒馆当前选择的 API、模型和连接设置，不会改变酒馆全局配置。</div>
                    <div id="pf-independent-api-fields" hidden>
                        <div class="pf-grid pf-grid-2 pf-top-gap">
                            <label class="pf-field">
                                <span>API 地址 <small>OpenAI 兼容接口</small></span>
                                <input id="pf-independent-api-endpoint" type="url" autocomplete="url" placeholder="https://example.com/v1">
                            </label>
                            <label class="pf-field">
                                <span>模型名称</span>
                                <input id="pf-independent-api-model" type="text" autocomplete="off" placeholder="例如：claude-3-5-sonnet 或 gpt-4o">
                            </label>
                            <label class="pf-field">
                                <span>最大输出 Token <small>留空则交给 API 默认值</small></span>
                                <input id="pf-independent-api-max-tokens" type="number" min="1" max="200000" step="1" inputmode="numeric" placeholder="可选">
                            </label>
                            <label class="pf-field">
                                <span>温度 <small>0–2</small></span>
                                <input id="pf-independent-api-temperature" type="number" min="0" max="2" step="0.1" inputmode="decimal">
                            </label>
                        </div>
                        <label class="pf-field pf-top-gap">
                            <span>API Key <small>只保存到酒馆密钥库，不写入扩展设置</small></span>
                            <input id="pf-independent-api-key" type="password" autocomplete="new-password" placeholder="首次使用时填写；已保存后可留空">
                        </label>
                        <div class="pf-api-actions">
                            <button type="button" class="pf-mini-button" id="pf-save-independent-api">保存独立 API</button>
                            <button type="button" class="pf-mini-button" id="pf-test-independent-api">测试连接</button>
                            <button type="button" class="pf-mini-button" id="pf-clear-independent-api-key">清除已保存 Key</button>
                        </div>
                        <div class="pf-inline-note" id="pf-independent-api-status">尚未配置独立 API。</div>
                    </div>
                </section>

                <section class="pf-card">
                    <div class="pf-section-head">
                        <div>
                            <h3>工作方式</h3>
                            <p id="pf-mode-description">随机生成会主动补全身份；定向生成会优先服从你给出的条件。</p>
                        </div>
                    </div>
                    <div class="pf-segmented" role="radiogroup" aria-label="工作方式">
                        <button type="button" class="pf-segment is-active" data-mode="random" role="radio" aria-checked="true">🎲 随机生成</button>
                        <button type="button" class="pf-segment" data-mode="directed" role="radio" aria-checked="false">🎯 定向生成</button>
                        <button type="button" class="pf-segment" data-mode="refine" role="radio" aria-checked="false">🪄 优化当前 U</button>
                    </div>

                    <div class="pf-inline-note pf-refine-note" id="pf-refine-note" hidden>
                        <strong id="pf-refine-source-title">将读取当前 U 的人设原文</strong>
                        <span id="pf-refine-source-status">优化结果只会显示在结果区，不会自动覆盖原人设。</span>
                    </div>

                    <div class="pf-grid pf-grid-3 pf-top-gap">
                        <label class="pf-field" data-create-only>
                            <span>生成倾向</span>
                            <select id="pf-style">
                                <option value="balanced">均衡适配</option>
                                <option value="world-first">世界观优先</option>
                                <option value="dramatic">高剧情潜力</option>
                                <option value="rare">小概率但合理</option>
                            </select>
                        </label>
                        <label class="pf-field" data-create-only>
                            <span>性别</span>
                            <select id="pf-gender">
                                <option value="random">随机</option>
                                <option value="男">男</option>
                                <option value="女">女</option>
                                <option value="双性">双性</option>
                            </select>
                        </label>
                        <label class="pf-field" data-create-only>
                            <span>种族</span>
                            <select id="pf-species">
                                <option value="random">随机</option>
                                <option value="human">人类</option>
                                <option value="nonhuman">人外</option>
                            </select>
                        </label>
                    </div>

                    <div class="pf-grid pf-grid-3">
                        <label class="pf-field" id="pf-species-detail-field" data-create-only hidden>
                            <span>具体种族 <small>留空则跟随世界观</small></span>
                            <input id="pf-species-detail" type="text" autocomplete="off" placeholder="例如：狐族兽人、吸血鬼、机器人">
                        </label>
                        <label class="pf-field" data-create-only>
                            <span>候选姓名数量</span>
                            <select id="pf-name-count">
                                <option value="3">3 个</option>
                                <option value="5">5 个</option>
                                <option value="7">7 个</option>
                            </select>
                        </label>
                        <label class="pf-field">
                            <span>人设长度</span>
                            <select id="pf-length-preset">
                                <option value="concise">精简（约 600 字）</option>
                                <option value="standard">标准（约 1000 字）</option>
                                <option value="detailed">详细（约 1800 字）</option>
                                <option value="extensive">超详细（约 2800 字）</option>
                                <option value="custom">自定义字数</option>
                            </select>
                        </label>
                        <label class="pf-field" id="pf-target-length-field" hidden>
                            <span>目标字数 <small>允许上下浮动约 20%</small></span>
                            <input id="pf-target-length" type="number" min="300" max="6000" step="100" inputmode="numeric" value="1000">
                        </label>
                        <label class="pf-field pf-field-wide">
                            <span id="pf-extra-short-label">附加要求 <small>随机模式也可填写</small></span>
                            <input id="pf-extra-short" type="text" autocomplete="off" placeholder="例如：不要贵族、偏日常、年龄30岁左右">
                        </label>
                    </div>
                    <label class="pf-option-toggle" for="pf-stream-output">
                        <input id="pf-stream-output" type="checkbox">
                        <span>
                            <strong>实时显示生成过程</strong>
                            <small>模型生成期间会持续显示实际收到的内容与分片数；接口不支持时会说明原因并回退普通生成。</small>
                        </span>
                    </label>
                    <label class="pf-option-toggle" for="pf-reference-greeting">
                        <input id="pf-reference-greeting" type="checkbox">
                        <span>
                            <strong>参考当前开场白</strong>
                            <small id="pf-reference-greeting-status">优先读取当前聊天正在显示的第一条角色开场白；没有时读取角色卡默认开场白，不读取后续聊天。</small>
                        </span>
                    </label>
                    <button type="button" class="pf-content-jump" id="pf-jump-content">↓ 选择生成内容（可勾选）</button>

                    <div id="pf-directed-fields" class="pf-directed-fields" hidden>
                        <div class="pf-grid pf-grid-2">
                            <label class="pf-field">
                                <span>指定姓名 <small>填写后不生成候选名</small></span>
                                <input id="pf-name" type="text" autocomplete="off" placeholder="留空则生成多个候选姓名">
                            </label>
                            <label class="pf-field">
                                <span>关键词</span>
                                <input id="pf-keywords" type="text" autocomplete="off" placeholder="如：植物学教授，漂亮，聪明，有点娇气">
                            </label>
                        </div>
                        <label class="pf-field">
                            <span>锁定条件 <small>模型不得自行修改</small></span>
                            <textarea id="pf-hard" rows="3" placeholder="例如：31岁；与{{char}}是前妻；职业必须是大学教师"></textarea>
                        </label>
                        <label class="pf-field">
                            <span>补充说明</span>
                            <textarea id="pf-extra" rows="3" placeholder="想要怎样的家庭背景、关系张力、生活习惯等，都可以写在这里"></textarea>
                        </label>
                    </div>
                </section>

                <section class="pf-card pf-content-card" id="pf-content-details">
                    <div class="pf-section-head pf-content-head">
                        <div>
                            <h3 id="pf-content-title">生成内容（可勾选）</h3>
                            <p id="pf-content-description">下面的栏目会直接决定人设里生成哪些内容；不需要的项目可以取消勾选。</p>
                        </div>
                        <small id="pf-section-count">0 项已选</small>
                    </div>
                    <div class="pf-detail-body">
                        <div class="pf-preset-toolbar" aria-label="内容预设">
                            <button class="pf-mini-button" type="button" data-preset="compact">精简</button>
                            <button class="pf-mini-button is-active" type="button" data-preset="standard">标准</button>
                            <button class="pf-mini-button" type="button" data-preset="story">剧情丰富</button>
                            <button class="pf-mini-button" type="button" data-preset="custom">自定义</button>
                        </div>
                        <div class="pf-custom-preset-manager">
                            <div class="pf-custom-preset-row">
                                <input id="pf-custom-preset-name" class="pf-compact-control" type="text" maxlength="60" autocomplete="off" placeholder="给当前勾选组合起个名字">
                                <button class="pf-mini-button" type="button" id="pf-save-custom-preset">＋ 保存当前勾选</button>
                            </div>
                            <div class="pf-custom-preset-row">
                                <select id="pf-custom-preset-select" class="pf-compact-control" aria-label="已保存的自定义模板">
                                    <option value="">选择已保存模板</option>
                                </select>
                                <button class="pf-mini-button pf-delete-preset" type="button" id="pf-delete-custom-preset" disabled>删除模板</button>
                            </div>
                            <p class="pf-custom-preset-help">模板只保存栏目勾选组合，不会修改性别、种族、篇幅或其他生成条件。</p>
                        </div>
                        <div id="pf-section-groups" class="pf-section-groups"></div>
                    </div>
                </section>

                <details class="pf-card pf-details" id="pf-book-details">
                    <summary>
                        <span>世界书范围</span>
                        <small id="pf-book-count">0 个已选</small>
                    </summary>
                    <div class="pf-detail-body">
                        <p class="pf-muted">默认勾选当前真正启用或绑定的世界书。生成时会完整读取所选世界书中已启用且有正文的条目，不自行截断；也不会读取当前聊天正文。</p>
                        <div class="pf-book-toolbar">
                            <button class="pf-mini-button" type="button" id="pf-select-active">只选当前启用</button>
                            <button class="pf-mini-button" type="button" id="pf-select-all">全选</button>
                            <button class="pf-mini-button" type="button" id="pf-select-none">清空</button>
                            <button class="pf-mini-button" type="button" id="pf-refresh">刷新识别</button>
                        </div>
                        <div id="pf-book-list" class="pf-book-list"></div>
                        <div class="pf-inline-note" id="pf-embedded-note" hidden>✓ 当前角色卡还包含内嵌 Character Book，将自动读取。</div>
                        <div class="pf-inline-note" id="pf-persona-book-note" hidden>检测到当前 Persona 绑定的世界书，默认不勾选，避免沿用当前 User 身份。</div>
                    </div>
                </details>

                <section class="pf-card pf-result-card" id="pf-result-card">
                    <div class="pf-section-head pf-result-head">
                        <div>
                            <h3>生成结果</h3>
                            <p id="pf-result-meta" aria-live="polite">生成完成后可直接一键复制。</p>
                        </div>
                        <button type="button" class="pf-copy-button" id="pf-copy" disabled>⧉ 一键复制</button>
                    </div>
                    <div class="pf-candidate-panel" id="pf-candidate-panel" hidden>
                        <div class="pf-candidate-head">
                            <span class="pf-label-mini">候选姓名</span>
                            <button class="pf-mini-button" type="button" id="pf-reroll-names">换一批名字</button>
                        </div>
                        <div class="pf-name-candidates" id="pf-name-candidates"></div>
                    </div>
                    <div class="pf-output-toolbar" id="pf-output-toolbar">
                        <span class="pf-label-mini">输出格式</span>
                        <div class="pf-format-toggle" role="radiogroup" aria-label="输出格式">
                            <button type="button" class="pf-format-button" data-format="yaml" role="radio" aria-checked="false">YAML</button>
                            <button type="button" class="pf-format-button is-active" data-format="natural" role="radio" aria-checked="true">自然语言</button>
                        </div>
                    </div>
                    <div class="pf-refinement-view-toolbar" id="pf-refinement-view-toolbar" hidden>
                        <span class="pf-label-mini">查看方式</span>
                        <div class="pf-view-toggle" role="tablist" aria-label="优化结果查看方式">
                            <button type="button" class="pf-view-button is-active" data-result-view="persona" role="tab" aria-selected="true">优化后人设</button>
                            <button type="button" class="pf-view-button" data-result-view="comparison" role="tab" aria-selected="false">修改对比</button>
                        </div>
                    </div>
                    <div class="pf-empty" id="pf-empty">还没有生成内容。</div>
                    <pre class="pf-result" id="pf-result" tabindex="0" aria-live="off" hidden></pre>
                    <div class="pf-comparison" id="pf-comparison" tabindex="0" hidden></div>
                </section>
            </div>

            <footer class="pf-footer">
                <button class="pf-secondary-button" type="button" id="pf-regenerate" disabled>↻ 再生成一次</button>
                <button class="pf-secondary-button pf-cancel-button" type="button" id="pf-cancel" hidden>停止生成</button>
                <button class="pf-primary-button" type="button" id="pf-generate">✨ 生成人设</button>
            </footer>
        </section>
    `;

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.panel = overlay.querySelector('.pf-modal');

    renderSectionOptions();
    bindUiEvents();
}

function createSettingsUi() {
    if (document.getElementById('pf-settings')) return;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return;

    const settings = ensureSettings();
    const block = document.createElement('div');
    block.id = 'pf-settings';
    block.className = 'extension_container pf-settings';
    block.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${DISPLAY_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>读取当前角色与世界书，调用当前 SillyTavern 模型生成适配世界观的 User Persona。</p>
                <button type="button" class="menu_button pf-open-button" id="pf-open-settings"><span aria-hidden="true">✨</span><span>打开${DISPLAY_NAME}</span></button>
                <label class="checkbox_label pf-settings-check">
                    <input id="pf-show-fab" type="checkbox" ${settings.showFloatingButton ? 'checked' : ''}>
                    <span>显示悬浮入口（可拖动，手机端也显示）</span>
                </label>
                <div class="pf-fab-settings" aria-label="悬浮入口设置">
                    <div class="pf-fab-setting-head">
                        <span>悬浮窗图标大小</span>
                        <output id="pf-fab-size-value" for="pf-fab-size">${clampFloatingSize(settings.floatingSize)} px</output>
                    </div>
                    <div class="pf-fab-size-row">
                        <input id="pf-fab-size" type="range" min="40" max="120" step="1" value="${clampFloatingSize(settings.floatingSize)}">
                        <button type="button" class="pf-mini-button" id="pf-reset-fab-size">恢复默认大小</button>
                    </div>
                    <div class="pf-fab-icon-actions">
                        <button type="button" class="pf-mini-button" id="pf-upload-icon">上传自定义图标</button>
                        <button type="button" class="pf-mini-button" id="pf-reset-icon">恢复默认图标</button>
                        <input id="pf-icon-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
                    </div>
                    <small class="pf-fab-setting-help">支持 PNG、JPG、GIF、WebP，单张不超过 2 MB。图片只保存在当前酒馆设置中。</small>
                </div>
            </div>
        </div>
    `;
    container.appendChild(block);
    state.settingsPanel = block;

    block.querySelector('#pf-open-settings')?.addEventListener('click', openPanel);
    block.querySelector('#pf-show-fab')?.addEventListener('change', event => {
        settings.showFloatingButton = Boolean(event.target.checked);
        saveSettings();
        updateFloatingButton();
    });

    const sizeInput = block.querySelector('#pf-fab-size');
    const sizeValue = block.querySelector('#pf-fab-size-value');
    const syncFabSizeUi = value => {
        const size = clampFloatingSize(value);
        if (sizeInput) sizeInput.value = String(size);
        if (sizeValue) sizeValue.textContent = `${size} px`;
    };
    sizeInput?.addEventListener('input', event => {
        const size = clampFloatingSize(event.target.value);
        settings.floatingSize = size;
        syncFabSizeUi(size);
        updateFloatingButton();
        saveSettings();
    });
    block.querySelector('#pf-reset-fab-size')?.addEventListener('click', () => {
        settings.floatingSize = DEFAULT_FAB_SIZE;
        syncFabSizeUi(DEFAULT_FAB_SIZE);
        updateFloatingButton();
        saveSettings();
    });

    const iconFile = block.querySelector('#pf-icon-file');
    block.querySelector('#pf-upload-icon')?.addEventListener('click', () => iconFile?.click());
    iconFile?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const accepted = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (!accepted.includes(file.type)) {
            notify('error', '请选择 PNG、JPG、GIF 或 WebP 图片。');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            notify('error', '图片不能超过 2 MB。');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/')) {
                notify('error', '无法读取这张图片。');
                return;
            }
            settings.floatingIcon = reader.result;
            saveSettings();
            updateFloatingButton();
            notify('success', '已应用自定义悬浮窗图标。');
        };
        reader.onerror = () => notify('error', '读取图片失败，请重试。');
        reader.readAsDataURL(file);
    });
    block.querySelector('#pf-reset-icon')?.addEventListener('click', () => {
        settings.floatingIcon = '';
        saveSettings();
        updateFloatingButton();
        notify('success', '已恢复默认悬浮窗图标。');
    });
}

function clampFloatingSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size)) return DEFAULT_FAB_SIZE;
    return Math.min(120, Math.max(40, Math.round(size)));
}

function isPhoneViewport() {
    return window.matchMedia?.('(max-width: 600px)').matches ?? window.innerWidth <= 600;
}

function clampFloatingPosition(button, left, top) {
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
        left: Math.min(Math.max(margin, Number(left) || margin), maxLeft),
        top: Math.min(Math.max(margin, Number(top) || margin), maxTop),
    };
}

function setFloatingPosition(button, left, top, persist = false) {
    const position = clampFloatingPosition(button, left, top);
    button.style.left = `${position.left}px`;
    button.style.top = `${position.top}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    if (persist) {
        ensureSettings().floatingPosition = {
            left: Math.round(position.left),
            top: Math.round(position.top),
        };
        saveSettings();
    }
    return position;
}

function restoreFloatingPosition(button) {
    const saved = ensureSettings().floatingPosition;
    if (!saved || typeof saved !== 'object') return;
    const left = Number(saved.left);
    const top = Number(saved.top);
    if (Number.isFinite(left) && Number.isFinite(top)) setFloatingPosition(button, left, top);
}

function constrainFloatingButton() {
    const button = document.getElementById('pf-fab');
    const saved = ensureSettings().floatingPosition;
    if (!button || !saved) return;
    const left = Number.parseFloat(button.style.left);
    const top = Number.parseFloat(button.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) setFloatingPosition(button, left, top, true);
}

function bindFloatingDrag(button) {
    if (button.dataset.dragBound === 'true') return;
    button.dataset.dragBound = 'true';
    let drag = null;

    button.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const rect = button.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            moved: false,
        };
        setFloatingPosition(button, rect.left, rect.top);
        button.classList.add('is-dragging');
        button.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    button.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
        setFloatingPosition(button, drag.left + deltaX, drag.top + deltaY);
        event.preventDefault();
    });

    const finishDrag = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
        button.classList.remove('is-dragging');
        if (drag.moved) {
            button.dataset.dragged = 'true';
            setFloatingPosition(button, Number.parseFloat(button.style.left), Number.parseFloat(button.style.top), true);
        }
        drag = null;
    };
    button.addEventListener('pointerup', finishDrag);
    button.addEventListener('pointercancel', finishDrag);
    button.addEventListener('click', event => {
        if (button.dataset.dragged === 'true') {
            button.dataset.dragged = '';
            event.preventDefault();
            return;
        }
        openPanel();
    });
}

function setFloatingSize(button, value) {
    const size = clampFloatingSize(value);
    button.style.setProperty('--pf-fab-size', `${size}px`);
    return size;
}

function getFloatingIconSrc(settings = ensureSettings()) {
    const custom = String(settings.floatingIcon || '').trim();
    return custom.startsWith('data:image/') ? custom : FAB_ICON_URL;
}

function updateFloatingButton() {
    const settings = ensureSettings();
    let button = document.getElementById('pf-fab');
    const mobileViewport = isPhoneViewport();
    // Respect the user's visibility switch on every viewport.
    if (!settings.showFloatingButton) {
        button?.remove();
        return;
    }

    if (!button) {
        button = document.createElement('button');
        button.id = 'pf-fab';
        button.className = 'pf-fab';
        button.type = 'button';
        button.title = `拖动调整位置，点击打开${DISPLAY_NAME}`;
        button.setAttribute('aria-label', `打开${DISPLAY_NAME}（可拖动）`);
        button.innerHTML = `<img class="pf-fab-icon" src="${FAB_ICON_URL}" alt="" aria-hidden="true" draggable="false">`;
        document.body.appendChild(button);
        bindFloatingDrag(button);
    }
    setFloatingSize(button, settings.floatingSize);
    const icon = button.querySelector('.pf-fab-icon');
    if (icon && icon.src !== getFloatingIconSrc(settings)) icon.src = getFloatingIconSrc(settings);
    restoreFloatingPosition(button);
    // Keep the entry visible on every viewport. Mobile gets a compact variant via CSS.
    button.hidden = Boolean(state.overlay?.classList.contains('is-open'));
    button.classList.toggle('is-mobile', mobileViewport);
    if (mobileViewport && !ensureSettings().floatingPosition) {
        const rect = button.getBoundingClientRect();
        setFloatingPosition(
            button,
            Math.max(8, window.innerWidth - rect.width - 14),
            Math.max(8, window.innerHeight - rect.height - 92),
        );
    }
    // A position saved on a wider desktop viewport may be outside a phone viewport.
    // Clamp it after the mobile CSS has applied so the button always remains reachable.
    constrainFloatingButton();
    if (!state.floatingResizeBound) {
        window.addEventListener('resize', () => {
            updateFloatingButton();
            constrainFloatingButton();
        }, { passive: true });
        state.floatingResizeBound = true;
    }
}

function renderSectionOptions() {
    const root = state.overlay;
    const container = root?.querySelector('#pf-section-groups');
    if (!container) return;
    const settings = ensureSettings();
    container.replaceChildren();

    for (const group of SECTION_GROUPS) {
        const section = document.createElement('section');
        section.className = 'pf-option-group';

        const title = document.createElement('h4');
        title.textContent = group.label;
        section.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'pf-option-grid';

        for (const option of group.sections) {
            const label = document.createElement('label');
            label.className = 'pf-option-item';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.sectionId = option.id;
            input.checked = option.required || Boolean(settings.sectionSelection[option.id]);
            input.disabled = Boolean(option.required);

            const text = document.createElement('span');
            text.textContent = option.label;
            label.append(input, text);
            grid.appendChild(label);

            input.addEventListener('change', () => {
                settings.sectionSelection[option.id] = input.checked;
                markPreset('custom');
                const savedSelect = state.overlay?.querySelector('#pf-custom-preset-select');
                if (savedSelect) savedSelect.value = '';
                const deleteButton = state.overlay?.querySelector('#pf-delete-custom-preset');
                if (deleteButton) deleteButton.disabled = true;
                updateSectionCount();
                saveSettings();
            });
        }

        section.appendChild(grid);
        container.appendChild(section);
    }

    updateSectionCount();
    detectAndMarkPreset();
    renderCustomSectionPresets();
}

function getCurrentSectionSelection() {
    const settings = ensureSettings();
    const selection = { ...settings.sectionSelection, identity: true };
    state.overlay?.querySelectorAll('[data-section-id]').forEach(input => {
        selection[input.dataset.sectionId] = input.checked;
    });
    return selection;
}

function updateSectionCount() {
    const count = getSelectedSections(getCurrentSectionSelection()).length;
    const target = state.overlay?.querySelector('#pf-section-count');
    if (target) target.textContent = count + ' 项已选';
}

function markPreset(preset) {
    state.overlay?.querySelectorAll('[data-preset]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.preset === preset);
    });
}

function detectAndMarkPreset() {
    const selection = getCurrentSectionSelection();
    const activeIds = Object.entries(selection).filter(([, active]) => active).map(([id]) => id).sort();
    for (const [preset, ids] of Object.entries(SECTION_PRESETS)) {
        const sorted = [...ids].sort();
        if (JSON.stringify(activeIds) === JSON.stringify(sorted)) {
            markPreset(preset);
            return;
        }
    }
    markPreset('custom');
}

function applySectionPreset(preset) {
    if (preset === 'custom') {
        markPreset('custom');
        return;
    }
    const ids = new Set(SECTION_PRESETS[preset] || SECTION_PRESETS.standard);
    const settings = ensureSettings();
    state.overlay?.querySelectorAll('[data-section-id]').forEach(input => {
        const checked = input.disabled || ids.has(input.dataset.sectionId);
        input.checked = checked;
        settings.sectionSelection[input.dataset.sectionId] = checked;
    });
    settings.sectionSelection.identity = true;
    markPreset(preset);
    const savedSelect = state.overlay?.querySelector('#pf-custom-preset-select');
    if (savedSelect) savedSelect.value = '';
    const nameInput = state.overlay?.querySelector('#pf-custom-preset-name');
    if (nameInput) nameInput.value = '';
    const deleteButton = state.overlay?.querySelector('#pf-delete-custom-preset');
    if (deleteButton) deleteButton.disabled = true;
    updateSectionCount();
    saveSettings();
}

function renderCustomSectionPresets(selectedId = '') {
    const select = state.overlay?.querySelector('#pf-custom-preset-select');
    const deleteButton = state.overlay?.querySelector('#pf-delete-custom-preset');
    if (!select) return;
    const presets = ensureSettings().customSectionPresets;
    const preferred = selectedId || select.value;
    select.replaceChildren();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = presets.length ? '选择已保存模板' : '还没有保存模板';
    select.appendChild(placeholder);
    for (const preset of presets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = `${preset.name}（${preset.sectionIds.length} 项）`;
        select.appendChild(option);
    }

    select.value = presets.some(preset => preset.id === preferred) ? preferred : '';
    if (deleteButton) deleteButton.disabled = !select.value;
}

function applyCustomSectionPreset(presetId) {
    const settings = ensureSettings();
    const preset = settings.customSectionPresets.find(item => item.id === presetId);
    if (!preset) {
        renderCustomSectionPresets();
        return;
    }
    const ids = new Set(preset.sectionIds);
    state.overlay?.querySelectorAll('[data-section-id]').forEach(input => {
        const checked = input.disabled || ids.has(input.dataset.sectionId);
        input.checked = checked;
        settings.sectionSelection[input.dataset.sectionId] = checked;
    });
    settings.sectionSelection.identity = true;
    detectAndMarkPreset();
    updateSectionCount();
    const nameInput = state.overlay?.querySelector('#pf-custom-preset-name');
    if (nameInput) nameInput.value = preset.name;
    renderCustomSectionPresets(preset.id);
    saveSettings();
    notify('success', `已应用自定义模板“${preset.name}”。`);
}

function saveCustomSectionPreset() {
    const nameInput = state.overlay?.querySelector('#pf-custom-preset-name');
    const name = String(nameInput?.value ?? '').trim().slice(0, 60);
    if (!name) {
        notify('warning', '请先填写模板名称。');
        nameInput?.focus();
        return;
    }

    const sectionIds = getSelectedSections(getCurrentSectionSelection()).map(section => section.id);
    const settings = ensureSettings();
    const existing = settings.customSectionPresets.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    let selectedId;
    if (existing) {
        existing.name = name;
        existing.sectionIds = sectionIds;
        selectedId = existing.id;
        notify('success', `已更新自定义模板“${name}”。`);
    } else {
        selectedId = globalThis.crypto?.randomUUID?.() || `custom-${Date.now()}`;
        settings.customSectionPresets.push({ id: selectedId, name, sectionIds });
        notify('success', `已保存自定义模板“${name}”。`);
    }
    settings.customSectionPresets = normalizeCustomSectionPresets(settings.customSectionPresets);
    renderCustomSectionPresets(selectedId);
    saveSettings();
}

async function deleteCustomSectionPreset() {
    const select = state.overlay?.querySelector('#pf-custom-preset-select');
    const settings = ensureSettings();
    const preset = settings.customSectionPresets.find(item => item.id === select?.value);
    if (!preset) return;

    let confirmed = true;
    const popupShow = getContext().Popup?.show;
    if (typeof popupShow?.confirm === 'function') {
        confirmed = Boolean(await popupShow.confirm('删除自定义模板', `确定删除“${preset.name}”吗？`));
    } else if (typeof globalThis.confirm === 'function') {
        confirmed = globalThis.confirm(`确定删除自定义模板“${preset.name}”吗？`);
    }
    if (!confirmed) return;

    settings.customSectionPresets = settings.customSectionPresets.filter(item => item.id !== preset.id);
    const nameInput = state.overlay?.querySelector('#pf-custom-preset-name');
    if (nameInput?.value === preset.name) nameInput.value = '';
    renderCustomSectionPresets();
    saveSettings();
    notify('success', `已删除自定义模板“${preset.name}”。`);
}

function updateSpeciesDetailVisibility() {
    const root = state.overlay;
    const species = root?.querySelector('#pf-species')?.value;
    const field = root?.querySelector('#pf-species-detail-field');
    if (field) field.hidden = currentMode() === 'refine' || species !== 'nonhuman';
}

function updateLengthVisibility() {
    const root = state.overlay;
    const preset = root?.querySelector('#pf-length-preset')?.value || 'standard';
    const field = root?.querySelector('#pf-target-length-field');
    if (field) field.hidden = preset !== 'custom';
}

/**
 * Keep the visible target-length field and the selected preset in sync.
 * Presets are not merely labels: they define the target sent to the prompt.
 * A blank custom field falls back to the last valid value instead of the
 * browser's minimum (300), which used to make the UI and generated prompt
 * disagree after a blur.
 */
function syncTargetLengthControl() {
    const root = state.overlay;
    const settings = ensureSettings();
    const presetInput = root?.querySelector('#pf-length-preset');
    const targetInput = root?.querySelector('#pf-target-length');
    const requestedPreset = presetInput?.value || settings.lengthPreset || 'standard';
    const presetKey = normalizeLengthPreset(requestedPreset);
    if (presetInput && presetInput.value !== presetKey) presetInput.value = presetKey;

    let targetLength;
    if (presetKey === 'custom') {
        const raw = String(targetInput?.value ?? '').trim();
        const previous = Number(settings.customTargetLength);
        const fallback = Number.isFinite(previous)
            ? previous
            : LENGTH_PRESETS.standard.targetLength;
        const candidate = raw === '' ? fallback : Number(raw);
        targetLength = resolveTargetLength('custom', Number.isFinite(candidate) ? candidate : fallback);
        settings.customTargetLength = targetLength;
    } else {
        targetLength = LENGTH_PRESETS[presetKey].targetLength;
    }

    if (targetInput) targetInput.value = String(targetLength);
    settings.lengthPreset = presetKey;
    settings.targetLength = targetLength;
    return targetLength;
}

function setOutputFormat(format, persist = true) {
    const valid = format === 'yaml' ? 'yaml' : 'natural';
    state.overlay?.querySelectorAll('[data-format]').forEach(button => {
        const active = button.dataset.format === valid;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
    if (persist) {
        ensureSettings().lastOutputFormat = valid;
        saveSettings();
    }
    renderCurrentResult();
}

function syncControlsFromSettings() {
    const root = state.overlay;
    const settings = ensureSettings();
    const values = {
        '#pf-style': settings.lastStyle || 'balanced',
        '#pf-gender': settings.gender || 'random',
        '#pf-species': settings.species || 'random',
        '#pf-species-detail': settings.speciesDetail || '',
        '#pf-name-count': String(settings.nameCount || 5),
        '#pf-length-preset': normalizeLengthPreset(settings.lengthPreset),
        '#pf-target-length': String(
            normalizeLengthPreset(settings.lengthPreset) === 'custom'
                ? settings.customTargetLength || settings.targetLength || LENGTH_PRESETS.standard.targetLength
                : settings.targetLength || LENGTH_PRESETS.standard.targetLength,
        ),
    };
    for (const [selector, value] of Object.entries(values)) {
        const input = root?.querySelector(selector);
        if (input) input.value = value;
    }
    const streamToggle = root?.querySelector('#pf-stream-output');
    if (streamToggle) streamToggle.checked = settings.streamOutput !== false;
    const greetingToggle = root?.querySelector('#pf-reference-greeting');
    if (greetingToggle) greetingToggle.checked = Boolean(settings.referenceGreeting);
    updateGreetingReferenceUi();
    syncTargetLengthControl();
    updateSpeciesDetailVisibility();
    updateLengthVisibility();
    setOutputFormat(settings.lastOutputFormat || 'natural', false);
    syncApiConnectionUi();
}

function bindUiEvents() {
    const root = state.overlay;
    root.querySelector('#pf-close')?.addEventListener('click', closePanel);
    root.addEventListener('pointerdown', event => {
        if (event.target === root) closePanel();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.overlay?.classList.contains('is-open')) closePanel();
    });

    root.querySelectorAll('.pf-segment[data-mode]').forEach(button => {
        button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    root.querySelectorAll('[data-api-mode]').forEach(button => {
        button.addEventListener('click', () => setApiMode(button.dataset.apiMode));
    });
    root.querySelector('#pf-save-independent-api')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await saveIndependentApi();
        } catch (error) {
            setIndependentApiStatus(readableError(error), 'error');
            notify('error', '保存独立 API 失败：' + readableError(error));
        } finally {
            button.disabled = false;
        }
    });
    root.querySelector('#pf-test-independent-api')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await testIndependentApi();
        } catch (error) {
            setIndependentApiStatus(readableError(error), 'error');
            notify('error', '独立 API 测试失败：' + readableError(error));
        } finally {
            button.disabled = false;
        }
    });
    root.querySelector('#pf-clear-independent-api-key')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await clearIndependentApiKey();
        } catch (error) {
            setIndependentApiStatus(readableError(error), 'error');
            notify('error', '清除独立 API Key 失败：' + readableError(error));
        } finally {
            button.disabled = false;
        }
    });
    root.querySelectorAll('#pf-independent-api-endpoint, #pf-independent-api-model, #pf-independent-api-max-tokens, #pf-independent-api-temperature').forEach(input => {
        input.addEventListener('change', () => {
            independentApiConfigFromUi();
            syncApiConnectionUi();
            updateGenerationModelLabel();
        });
    });

    root.querySelector('#pf-style')?.addEventListener('change', () => {
        ensureSettings().lastStyle = root.querySelector('#pf-style').value;
        saveSettings();
    });
    root.querySelector('#pf-gender')?.addEventListener('change', event => {
        ensureSettings().gender = event.target.value;
        saveSettings();
    });
    root.querySelector('#pf-species')?.addEventListener('change', event => {
        ensureSettings().species = event.target.value;
        updateSpeciesDetailVisibility();
        saveSettings();
    });
    root.querySelector('#pf-species-detail')?.addEventListener('change', event => {
        ensureSettings().speciesDetail = event.target.value.trim();
        saveSettings();
    });
    root.querySelector('#pf-name-count')?.addEventListener('change', event => {
        ensureSettings().nameCount = Number(event.target.value) || 5;
        saveSettings();
    });
    root.querySelector('#pf-length-preset')?.addEventListener('change', event => {
        const settings = ensureSettings();
        settings.lengthPreset = normalizeLengthPreset(event.target.value);
        if (settings.lengthPreset === 'custom') {
            const targetInput = root.querySelector('#pf-target-length');
            if (targetInput) targetInput.value = String(settings.customTargetLength || LENGTH_PRESETS.standard.targetLength);
        }
        syncTargetLengthControl();
        updateLengthVisibility();
        saveSettings();
    });
    const syncCustomTargetLength = () => {
        syncTargetLengthControl();
        saveSettings();
    };
    root.querySelector('#pf-target-length')?.addEventListener('change', syncCustomTargetLength);
    root.querySelector('#pf-target-length')?.addEventListener('blur', syncCustomTargetLength);
    root.querySelector('#pf-stream-output')?.addEventListener('change', event => {
        ensureSettings().streamOutput = Boolean(event.target.checked);
        saveSettings();
    });
    root.querySelector('#pf-reference-greeting')?.addEventListener('change', event => {
        ensureSettings().referenceGreeting = Boolean(event.target.checked);
        saveSettings();
    });
    root.querySelectorAll('[data-preset]').forEach(button => {
        button.addEventListener('click', () => applySectionPreset(button.dataset.preset));
    });
    root.querySelector('#pf-save-custom-preset')?.addEventListener('click', saveCustomSectionPreset);
    root.querySelector('#pf-custom-preset-name')?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        saveCustomSectionPreset();
    });
    root.querySelector('#pf-custom-preset-select')?.addEventListener('change', event => {
        const presetId = event.target.value;
        if (presetId) {
            applyCustomSectionPreset(presetId);
        } else {
            root.querySelector('#pf-delete-custom-preset').disabled = true;
        }
    });
    root.querySelector('#pf-delete-custom-preset')?.addEventListener('click', () => {
        deleteCustomSectionPreset().catch(error => {
            console.error(`[${DISPLAY_NAME}] Could not delete custom section preset.`, error);
            notify('error', '删除自定义模板失败。');
        });
    });
    root.querySelectorAll('[data-format]').forEach(button => {
        button.addEventListener('click', () => setOutputFormat(button.dataset.format));
    });
    root.querySelectorAll('[data-result-view]').forEach(button => {
        button.addEventListener('click', () => setResultView(button.dataset.resultView));
    });

    root.querySelector('#pf-copy')?.addEventListener('click', copyCurrentResult);
    root.querySelector('#pf-generate')?.addEventListener('click', generatePersona);
    root.querySelector('#pf-regenerate')?.addEventListener('click', generatePersona);
    root.querySelector('#pf-reroll-names')?.addEventListener('click', rerollNames);
    root.querySelector('#pf-cancel')?.addEventListener('click', cancelGeneration);
    root.querySelector('#pf-jump-content')?.addEventListener('click', () => {
        const content = root.querySelector('#pf-content-details');
        content?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        root.querySelector('[data-section-id]')?.focus({ preventScroll: true });
    });
    root.querySelector('#pf-select-active')?.addEventListener('click', () => {
        const names = currentMode() === 'refine'
            ? unique([...state.activeWorldNames, ...state.personaWorldNames])
            : state.activeWorldNames;
        state.selectedWorldNames = new Set(names);
        renderWorldBookList();
    });
    root.querySelector('#pf-select-all')?.addEventListener('click', () => {
        state.selectedWorldNames = new Set(state.allWorldNames);
        renderWorldBookList();
    });
    root.querySelector('#pf-select-none')?.addEventListener('click', () => {
        state.selectedWorldNames.clear();
        renderWorldBookList();
    });
    root.querySelector('#pf-refresh')?.addEventListener('click', async () => {
        state.lastContextSignature = '';
        await refreshContextUi(true);
        notify('success', '已重新识别角色与世界书。');
    });
}

function setMode(mode) {
    const valid = ['random', 'directed', 'refine'].includes(mode) ? mode : 'random';
    const root = state.overlay;
    const previous = currentMode();
    root.querySelectorAll('.pf-segment[data-mode]').forEach(button => {
        const active = button.dataset.mode === valid;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
    root.querySelector('#pf-directed-fields').hidden = valid !== 'directed';

    if (valid === 'refine') {
        for (const name of state.personaWorldNames) state.selectedWorldNames.add(name);
    } else if (previous === 'refine') {
        for (const name of state.personaWorldNames) {
            if (!state.activeWorldNames.includes(name)) state.selectedWorldNames.delete(name);
        }
    }

    updateModeUi(valid);
    renderWorldBookList();
    ensureSettings().lastMode = valid;
    saveSettings();
}

function updateModeUi(mode = currentMode()) {
    const root = state.overlay;
    if (!root) return;
    const refining = mode === 'refine';
    const persona = getCurrentPersonaContext();

    root.querySelectorAll('[data-create-only]').forEach(field => {
        field.hidden = refining;
    });
    updateSpeciesDetailVisibility();

    const descriptions = {
        random: '随机生成会根据世界观主动补全一个全新的 User 身份。',
        directed: '定向生成会优先服从你填写的姓名、关键词与锁定条件。',
        refine: '读取当前 U 的人设原文，并结合角色卡与世界书进行保真优化。',
    };
    root.querySelector('#pf-mode-description').textContent = descriptions[mode] || descriptions.random;
    root.querySelector('#pf-refine-note').hidden = !refining;
    root.querySelector('#pf-refine-source-title').textContent = persona.name
        ? `当前 U：${persona.name}`
        : '当前 U 尚未命名';
    root.querySelector('#pf-refine-source-status').textContent = persona.description
        ? `已读取 ${persona.description.length} 字原文。结果只显示在下方，不会自动覆盖当前人设。`
        : '当前 U 的 Persona Description 为空，请先在 SillyTavern 中填写人设后再优化。';

    const extraLabel = root.querySelector('#pf-extra-short-label');
    const extraInput = root.querySelector('#pf-extra-short');
    if (refining) {
        extraLabel.innerHTML = '优化要求 <small>可选</small>';
        extraInput.placeholder = '例如：保留全部设定，减少机械感，加强与当前角色的关系逻辑';
        root.querySelector('#pf-content-title').textContent = '优化后栏目（可勾选）';
        root.querySelector('#pf-content-description').textContent = '原文内容会被整理到这些栏目中；新增栏目会在不改变核心设定的前提下适度补全。';
        root.querySelector('#pf-jump-content').textContent = '↓ 选择优化后的栏目（可勾选）';
    } else {
        extraLabel.innerHTML = '附加要求 <small>随机模式也可填写</small>';
        extraInput.placeholder = '例如：不要贵族、偏日常、年龄30岁左右';
        root.querySelector('#pf-content-title').textContent = '生成内容（可勾选）';
        root.querySelector('#pf-content-description').textContent = '下面的栏目会直接决定人设里生成哪些内容；不需要的项目可以取消勾选。';
        root.querySelector('#pf-jump-content').textContent = '↓ 选择生成内容（可勾选）';
    }

    const personaBookNote = root.querySelector('#pf-persona-book-note');
    if (personaBookNote) {
        personaBookNote.textContent = refining
            ? '检测到当前 Persona 绑定的世界书，优化模式已自动勾选。'
            : '检测到当前 Persona 绑定的世界书，默认不勾选，避免沿用当前 User 身份。';
    }
    const selectActive = root.querySelector('#pf-select-active');
    if (selectActive) selectActive.textContent = refining ? '选择当前相关' : '只选当前启用';

    if (!state.generating) {
        const generate = root.querySelector('#pf-generate');
        generate.textContent = refining ? '🪄 优化当前 U' : '✨ 生成人设';
        generate.disabled = refining && !persona.description;
        const regenerate = root.querySelector('#pf-regenerate');
        regenerate.textContent = refining ? '↻ 再优化一次' : '↻ 再生成一次';
    }
}

function currentMode() {
    return state.overlay?.querySelector('.pf-segment[data-mode].is-active')?.dataset.mode || 'random';
}

async function openPanel() {
    createStaticUi();
    await refreshContextUi(false);

    const settings = ensureSettings();
    setMode(settings.lastMode || 'random');
    syncControlsFromSettings();
    renderSectionOptions();
    state.resultView = 'persona';

    if (settings.lastStructuredResult && typeof settings.lastStructuredResult === 'object') {
        state.structuredResult = settings.lastStructuredResult;
        state.selectedCandidateIndex = Math.min(
            Number(settings.lastSelectedCandidateIndex) || 0,
            Math.max(0, (state.structuredResult.candidates?.length || 1) - 1),
        );
        renderCurrentResult('上次生成结果');
    } else {
        const saved = String(settings.lastResult || '');
        if (saved) setResult(saved, '上次生成结果');
    }

    state.overlay.classList.add('is-open');
    state.overlay.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('pf-modal-open');
    const floatingButton = document.getElementById('pf-fab');
    if (floatingButton) floatingButton.hidden = true;
}

function closePanel() {
    if (!state.overlay) return;
    state.overlay.classList.remove('is-open');
    state.overlay.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('pf-modal-open');
    updateFloatingButton();
}

async function refreshContextUi(force = false) {
    if (!state.overlay) return;
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);
    const persona = getCurrentPersonaContext(ctx);

    if (force) state.worldInfoRuntime = null;
    await detectWorldBooks();

    state.overlay.querySelector('#pf-character-name').textContent = getCharacterName(character);
    state.overlay.querySelector('#pf-current-persona-name').textContent = persona.name
        ? `${persona.name}${persona.description ? ` · ${persona.description.length} 字` : ' · 暂无人设描述'}`
        : '未命名 Persona';
    state.overlay.querySelector('#pf-context-line').textContent = character
        ? `已读取当前角色 · ${state.activeWorldNames.length} 个绑定/启用世界书${state.embeddedBook ? ' · 含卡内世界书' : ''}`
        : '当前未选择单角色；仍可使用全局与聊天世界书生成。';
    updateGenerationModelLabel(ctx);
    syncApiConnectionUi();

    updateGreetingReferenceUi(character);

    renderActiveChips();
    renderWorldBookList();
    const embeddedNote = state.overlay.querySelector('#pf-embedded-note');
    embeddedNote.hidden = !state.embeddedBook;
    const personaNote = state.overlay.querySelector('#pf-persona-book-note');
    personaNote.hidden = state.personaWorldNames.length === 0;
    updateModeUi();
}

function renderActiveChips() {
    const wrap = state.overlay.querySelector('#pf-active-book-chips');
    wrap.replaceChildren();

    const chips = [...state.activeWorldNames];
    if (state.embeddedBook) chips.push('角色卡内嵌 Character Book');

    if (!chips.length) {
        const empty = document.createElement('span');
        empty.className = 'pf-chip pf-chip-muted';
        empty.textContent = '未识别到绑定世界书';
        wrap.appendChild(empty);
        return;
    }

    for (const name of chips) {
        const chip = document.createElement('span');
        chip.className = 'pf-chip';
        chip.textContent = name;
        wrap.appendChild(chip);
    }
}

function renderWorldBookList() {
    const list = state.overlay.querySelector('#pf-book-list');
    const count = state.overlay.querySelector('#pf-book-count');
    list.replaceChildren();

    if (!state.allWorldNames.length) {
        const empty = document.createElement('div');
        empty.className = 'pf-inline-note';
        empty.textContent = '当前没有可枚举的 World Info 文件。';
        list.appendChild(empty);
    } else {
        for (const name of state.allWorldNames) {
            const label = document.createElement('label');
            label.className = 'pf-book-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selectedWorldNames.has(name);
            checkbox.addEventListener('change', () => {
                checkbox.checked ? state.selectedWorldNames.add(name) : state.selectedWorldNames.delete(name);
                updateBookCount();
            });

            const text = document.createElement('span');
            text.className = 'pf-book-item-text';
            text.textContent = name;

            if (state.activeWorldNames.includes(name)) {
                const badge = document.createElement('small');
                badge.className = 'pf-active-badge';
                badge.textContent = '当前启用';
                text.append(' ', badge);
            } else if (state.personaWorldNames.includes(name)) {
                const badge = document.createElement('small');
                badge.className = 'pf-active-badge pf-persona-badge';
                badge.textContent = '当前 Persona';
                text.append(' ', badge);
            }

            label.append(checkbox, text);
            list.appendChild(label);
        }
    }

    updateBookCount();
}

function updateBookCount() {
    const count = state.overlay?.querySelector('#pf-book-count');
    if (count) count.textContent = `${state.selectedWorldNames.size} 个已选`;
}

function extractEntries(book, sourceName) {
    if (!book || typeof book !== 'object') return [];
    const raw = book.entries ?? book.data?.entries ?? [];
    const entries = Array.isArray(raw) ? raw : Object.values(raw || {});

    return entries
        .filter(entry => entry && typeof entry === 'object')
        .filter(entry => entry.enabled !== false && entry.disable !== true)
        .map((entry, index) => ({
            source: sourceName,
            index,
            comment: String(entry.comment ?? entry.name ?? '').trim(),
            keys: unique([
                ...(Array.isArray(entry.key) ? entry.key : []),
                ...(Array.isArray(entry.keys) ? entry.keys : []),
                ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
                ...(Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []),
            ]),
            content: String(entry.content ?? '').trim(),
            constant: Boolean(entry.constant),
            order: Number(entry.order ?? entry.insertion_order ?? 0),
        }))
        .filter(entry => entry.content);
}

function entryToText(entry) {
    const title = entry.comment ? `｜${entry.comment}` : '';
    const keys = entry.keys.length ? `\n关键词：${entry.keys.join(' / ')}` : '';
    return `【世界书：${entry.source}${title}】${keys}\n${entry.content}`;
}

async function collectWorldLore() {
    const ctx = getContext();
    const runtime = await getWorldInfoRuntime();
    const loadWorldInfo = typeof ctx.loadWorldInfo === 'function'
        ? ctx.loadWorldInfo.bind(ctx)
        : (typeof runtime.loadWorldInfo === 'function' ? runtime.loadWorldInfo : null);
    const entries = [];
    const failures = [];

    for (const name of state.selectedWorldNames) {
        try {
            const book = loadWorldInfo ? await loadWorldInfo(name) : null;
            if (book) entries.push(...extractEntries(book, name));
            else failures.push(name);
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] Failed to load World Info: ${name}`, error);
            failures.push(name);
        }
    }

    if (state.embeddedBook) {
        entries.push(...extractEntries(state.embeddedBook, '角色卡内嵌 Character Book'));
    }

    const blocks = entries.map(entry => (
        neutralizePersonaReferences(
            entryToText(entry),
            ctx.name1,
            getCharacterName(getCurrentCharacter(ctx)),
        )
    ));
    const text = blocks.join('\n\n');

    return {
        text,
        totalEntries: entries.length,
        includedEntries: entries.length,
        failures,
        chars: text.length,
    };
}

function collectCharacterContext() {
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);
    if (!character) return '当前未选择单角色。';

    const name = getCharacterName(character);
    const fields = [
        ['姓名', name],
        ['Description', getField(character, 'description')],
        ['Personality', getField(character, 'personality')],
        ['Scenario', getField(character, 'scenario')],
        ['Creator Notes', getField(character, 'creator_notes', 'creatorcomment')],
        ['System Prompt', getField(character, 'system_prompt')],
        ['Post-History Instructions', getField(character, 'post_history_instructions')],
    ].filter(([, value]) => value);

    const blocks = fields.map(([label, value]) => {
        const cleaned = neutralizePersonaReferences(value, ctx.name1, name);
        return '【' + label + '】\n' + cleaned;
    });
    return blocks.join('\n\n');
}

function getCharacterDefaultGreeting(character = getCurrentCharacter(getContext())) {
    return String(getField(character, 'first_mes', 'first_message', 'greeting') || '').trim();
}

function getOpeningGreetingReference(
    character = getCurrentCharacter(getContext()),
    ctx = getContext(),
) {
    return readOpeningGreetingCompat(ctx, getCharacterDefaultGreeting(character));
}

function updateGreetingReferenceUi(character = getCurrentCharacter(getContext())) {
    const toggle = state.overlay?.querySelector('#pf-reference-greeting');
    const status = state.overlay?.querySelector('#pf-reference-greeting-status');
    if (!toggle || !status) return;

    const { text: greeting, source } = getOpeningGreetingReference(character);
    toggle.disabled = !greeting;
    toggle.checked = Boolean(greeting && ensureSettings().referenceGreeting);
    status.textContent = greeting
        ? `已识别${source}（${greeting.length} 字）。开启后只提取与 U 有关的信息，不读取后续聊天。`
        : '当前聊天和角色卡都没有可读取的开场白。切换到包含开场白的角色后即可启用。';
}

function collectOpeningGreeting() {
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);
    const { text: greeting } = getOpeningGreetingReference(character, ctx);
    if (!greeting) return '';

    return neutralizePersonaReferences(
        greeting,
        ctx.name1,
        getCharacterName(character),
    );
}

function collectCurrentPersonaText() {
    const ctx = getContext();
    const persona = getCurrentPersonaContext(ctx);
    if (!persona.description) return '';
    return neutralizePersonaReferences(
        persona.description,
        persona.name,
        getCharacterName(getCurrentCharacter(ctx)),
    );
}

function collectGenerationOptions() {
    const root = state.overlay;
    const mode = currentMode();
    const style = root.querySelector('#pf-style')?.value || 'balanced';
    const shortExtra = root.querySelector('#pf-extra-short')?.value?.trim() || '';
    const gender = root.querySelector('#pf-gender')?.value || 'random';
    const species = root.querySelector('#pf-species')?.value || 'random';
    const speciesDetail = species === 'nonhuman'
        ? root.querySelector('#pf-species-detail')?.value?.trim() || ''
        : '';
    const nameCount = Number(root.querySelector('#pf-name-count')?.value) || 5;
    const lengthPreset = root.querySelector('#pf-length-preset')?.value || 'standard';
    const targetLength = syncTargetLengthControl();
    const streamOutput = Boolean(root.querySelector('#pf-stream-output')?.checked);
    const greetingToggle = root.querySelector('#pf-reference-greeting');
    const referenceGreeting = Boolean(greetingToggle?.checked && !greetingToggle.disabled);
    const sections = getSelectedSections(getCurrentSectionSelection());
    const randomId = globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + String(Math.random());

    if (mode === 'refine') {
        const persona = getCurrentPersonaContext();
        return {
            mode,
            style: 'balanced',
            gender: 'random',
            species: 'random',
            speciesDetail: '',
            nameCount: 1,
            lengthPreset,
            targetLength,
            streamOutput,
            referenceGreeting,
            fixedName: persona.name || 'User',
            sections,
            directionText: [
                '工作模式：优化当前 User Persona',
                '优化要求：' + (shortExtra || '保留全部明确设定，改善自然度、因果联系与世界观适配度'),
            ].join('\n'),
        };
    }

    if (mode === 'random') {
        return {
            mode,
            style,
            gender,
            species,
            speciesDetail,
            nameCount,
            lengthPreset,
            targetLength,
            streamOutput,
            referenceGreeting,
            fixedName: '',
            sections,
            directionText: [
                '生成模式：随机生成',
                '附加要求：' + (shortExtra || '无'),
                '随机扰动标识：' + randomId,
            ].join('\n'),
        };
    }

    const name = root.querySelector('#pf-name')?.value?.trim() || '';
    const keywords = root.querySelector('#pf-keywords')?.value?.trim() || '';
    const hard = root.querySelector('#pf-hard')?.value?.trim() || '';
    const extra = root.querySelector('#pf-extra')?.value?.trim() || '';

    return {
        mode,
        style,
        gender,
        species,
        speciesDetail,
        nameCount: name ? 1 : nameCount,
        lengthPreset,
        targetLength,
        streamOutput,
        referenceGreeting,
        fixedName: name,
        sections,
        directionText: [
            '生成模式：定向生成',
            '姓名：' + (name || '未指定，生成多个候选姓名'),
            '关键词：' + (keywords || '未指定'),
            '锁定条件：' + (hard || '无'),
            '附加要求：' + ([shortExtra, extra].filter(Boolean).join('；') || '无'),
        ].join('\n'),
    };
}

function getConnectionManagerStreaming(ctx) {
    const service = ctx?.ConnectionManagerRequestService;
    const profile = readSelectedConnectionProfile(ctx);
    if (!profile || typeof service?.sendRequest !== 'function') return null;
    const modelInfo = getActiveModelInfo(ctx);
    // A manually changed model in the live selector is newer than the profile
    // snapshot. In that case let SillyTavern's main API path handle the request
    // instead of silently reverting to the profile's old model.
    if (modelInfo.liveModel && modelInfo.liveModel !== modelInfo.profileModel) {
        return null;
    }
    try {
        if (typeof service.isProfileSupported === 'function' && !service.isProfileSupported(profile)) return null;
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not validate the selected connection profile.`, error);
        return null;
    }
    return {
        service,
        profileId: profile.id,
        profile,
        model: modelInfo.liveModel || modelInfo.profileModel,
        label: [profile.name || '连接管理器', profile.model].filter(Boolean).join(' · '),
    };
}

function getCurrentApiStreaming(ctx) {
    const liveContext = getContext();
    const sourceContext = liveContext || ctx;
    const mainApi = String(sourceContext?.mainApi || '').toLowerCase();
    const chatService = sourceContext?.ChatCompletionService;
    if (mainApi === 'openai'
        && typeof chatService?.presetToGeneratePayload === 'function'
        && typeof chatService?.sendRequest === 'function'
        && sourceContext?.chatCompletionSettings) {
        const settings = sourceContext.chatCompletionSettings;
        const model = resolveChatCompletionModel(sourceContext, settings);
        return {
            api: 'chat',
            service: chatService,
            settings,
            label: [
                settings.chat_completion_source || 'Chat Completion',
                model,
            ].filter(Boolean).join(' · '),
        };
    }

    const textService = sourceContext?.TextCompletionService;
    if (mainApi === 'textgenerationwebui'
        && typeof textService?.presetToGeneratePayload === 'function'
        && typeof textService?.sendRequest === 'function'
        && sourceContext?.textCompletionSettings) {
        const settings = sourceContext.textCompletionSettings;
        return {
            api: 'text',
            service: textService,
            settings,
            label: [settings.api_type || settings.type || 'Text Completion', settings.model].filter(Boolean).join(' · '),
        };
    }

    return null;
}

function getIndependentApiStreaming(ctx) {
    const service = ctx?.ChatCompletionService;
    if (typeof service?.sendRequest !== 'function') return null;
    const settings = normalizeIndependentApiSettings(ensureSettings().independentApi);
    return {
        api: 'independent-chat',
        service,
        settings,
        label: ['独立 API', settings.model || '未配置模型'].join(' · '),
    };
}

function cloneSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    try {
        if (typeof structuredClone === 'function') return structuredClone(settings);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not clone generation settings; using a shallow copy.`, error);
    }
    return { ...settings };
}

function getActiveTextCompletionPreset(ctx, settings) {
    const presetName = settings?.preset;
    if (!presetName || typeof ctx?.getPresetManager !== 'function') return null;
    try {
        const manager = ctx.getPresetManager('textgenerationwebui');
        return manager?.getCompletionPresetByName?.(presetName) || null;
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not read the active Text Completion preset.`, error);
        return null;
    }
}

async function buildCoreChatStreamingPayload(ctx, currentApi, messages) {
    // ChatCompletionService.presetToGeneratePayload() intentionally builds a
    // "quiet" request. SillyTavern disables streaming while building quiet
    // requests, so changing only payload.stream afterwards is not equivalent
    // to the native streaming path. Build with the same "normal" path used by
    // the main chat, then remove chat-only tools and multi-swipe fields.
    const runtime = await import('/scripts/openai.js');
    const settings = cloneSettings(currentApi.settings);
    settings.stream_openai = true;
    let model = resolveChatCompletionModel(ctx, settings);
    if (!model && typeof runtime.getChatCompletionModel === 'function') {
        try {
            // SillyTavern's resolver expects the complete settings object. Passing
            // only chat_completion_source returns no model on current versions.
            model = String(runtime.getChatCompletionModel(settings) || '').trim();
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] Could not resolve the streaming model from the host runtime.`, error);
        }
    }
    if (!model) {
        throw new Error('无法读取当前 Chat Completion 模型，已取消这次流式请求');
    }

    let payload;
    if (typeof runtime.createGenerationParameters === 'function') {
        const built = await runtime.createGenerationParameters(settings, model, 'normal', messages);
        payload = built?.generate_data;
    } else {
        // SillyTavern 1.14-1.17 exposes the streaming request service but not
        // createGenerationParameters(). Recreate the public request shape from
        // active settings without mutating the user's preset.
        payload = buildLegacyChatStreamingPayload(settings, messages, model, currentApi.service);
    }
    ensureChatCompletionPayloadModel(payload, model);

    payload.stream = true;
    delete payload.n;
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.assistant_prefill;

    // Some host versions or provider adapters omit the field even though the
    // model was supplied to the parameter builder. OpenAI-compatible endpoints
    // reject such a body with 422, so preserve the live model explicitly.
    ensureChatCompletionPayloadModel(payload, model);

    const readyEvent = ctx.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
    if (readyEvent && typeof ctx.eventSource?.emit === 'function') {
        await ctx.eventSource.emit(readyEvent, payload);
    }
    return ensureChatCompletionPayloadModel(
        payload,
        resolveChatCompletionModel(ctx, currentApi.settings) || model,
    );
}

function mergeStreamText(previous, next) {
    const value = String(next ?? '');
    if (!value) return previous;
    // SillyTavern's stream adapter normally yields the complete text so far,
    // while a few providers yield deltas. Support both without duplicating text.
    if (!previous) return value;
    if (value.startsWith(previous)) return value;
    if (previous.startsWith(value)) return previous;
    if (previous.endsWith(value)) return previous;
    return previous + value;
}

function waitForBrowserPaint() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 0);
        }
    });
}

function readableError(error) {
    const messages = [];
    const seen = new Set();
    const visit = value => {
        if (value == null || seen.has(value)) return;
        if (typeof value === 'string') {
            if (value.trim()) messages.push(value.trim());
            return;
        }
        if (typeof value !== 'object') return;
        seen.add(value);
        if (typeof value.message === 'string') messages.push(value.message.trim());
        visit(value.cause);
        visit(value.error);
        visit(value.detail);
        visit(value.response);
        visit(value.data);
    };
    visit(error);
    const generic = message => /^(api request failed|request failed|网络请求失败)$/i.test(message.trim());
    const meaningful = messages.find(message => message && !generic(message));
    if (meaningful) return meaningful;
    if (messages[0]) return messages[0];
    return String(error || '未知错误');
}

function getResponseTokenBudget(ctx, targetLength) {
    // targetLength is a Chinese-character writing target, while the API limit is
    // measured in tokens. Reserve room for JSON keys, structural punctuation and
    // reasoning so the model is not forced to spend the entire response on setup.
    const chars = Math.max(300, Number(targetLength) || 1000);
    const estimated = Math.ceil(chars * 1.6 + 800);
    const configured = Number(
        ctx?.chatCompletionSettings?.openai_max_tokens
        ?? ctx?.textCompletionSettings?.max_tokens
        ?? ctx?.textCompletionSettings?.max_new_tokens
        ?? 0,
    );
    const upperBound = Math.max(estimated, Number.isFinite(configured) ? configured : 0);
    return Math.min(8192, Math.max(1024, upperBound));
}

async function generateWithCurrentConnection(ctx, { systemPrompt, prompt, maxTokens }) {
    const liveContext = getContext();
    if (ensureSettings().apiMode === 'independent') {
        const config = independentApiConfigFromUi({ persist: true });
        if (!hasIndependentApiSettings(config)) {
            throw new Error('独立 API 尚未配置完整，请填写地址、模型并保存 API Key。');
        }
        const service = liveContext?.ChatCompletionService;
        if (typeof service?.sendRequest !== 'function') {
            throw new Error('当前酒馆版本没有 Chat Completion 请求接口，无法使用独立 API。');
        }
        const messages = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: prompt },
        ];
        const payload = buildIndependentApiPayload(config, messages, { stream: false });
        const response = await service.sendRequest(payload, true);
        let text = extractGeneratedTextCompat(liveContext, response);
        if (!text) text = typeof response === 'string' ? response : (response?.content ?? response?.text ?? '');
        if (!String(text).trim()) {
            const reasoning = extractReasoningCompat(response);
            throw new Error(reasoning.trim()
                ? `${config.model} · 模型只返回了思考内容，没有最终人设正文。请降低思考强度或填写最大输出 Token 后重试。`
                : `${config.model} · 模型返回了空内容，请检查独立 API 设置与内容过滤。`);
        }
        return { text: String(text), source: `独立 API · ${config.model}` };
    }
    const responseLength = getResponseTokenBudget(liveContext, maxTokens);
    const hasNativeGeneration = typeof liveContext?.generateRawData === 'function'
        || typeof liveContext?.generateRaw === 'function'
        || typeof liveContext?.generateQuietPrompt === 'function';

    // Normal generation should follow SillyTavern's currently active API. A
    // selected Connection Manager profile may only be a saved profile and can
    // contain a stale/empty model even after the user switches the live model.
    if (hasNativeGeneration) {
        const text = await generateRawCompat(liveContext, {
            systemPrompt,
            prompt,
            responseLength,
            trimNames: false,
        });
        return {
            text: String(text),
            source: getActiveModelInfo(liveContext).label,
        };
    }

    const connection = getConnectionManagerStreaming(liveContext);

    if (connection) {
        const messages = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: prompt },
        ];
        const response = await connection.service.sendRequest(
            connection.profileId,
            messages,
            responseLength,
            {
                stream: false,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            },
            connection.model ? { model: connection.model } : {},
        );
        let text = extractGeneratedTextCompat(liveContext, response);
        if (!text && typeof response === 'function') {
            const generator = response();
            for await (const chunk of generator) {
                text = typeof chunk === 'string' ? chunk : (chunk?.text ?? chunk?.content ?? text);
            }
        }
        if (!String(text).trim()) {
            const reasoning = extractReasoningCompat(response);
            throw new Error(reasoning.trim()
                ? `${connection.label} · 模型只返回了思考内容，没有最终人设正文。请降低思考强度或提高回复上限后重试。`
                : `${connection.label} · 模型返回了空内容。请检查回复上限与内容过滤设置后重试。`);
        }
        return { text: String(text), source: connection.label };
    }

    throw new Error('当前版本未提供可用的人设生成接口');
}

async function generateRawWithStreaming(ctx, { systemPrompt, prompt, maxTokens, onStatus, onChunk }) {
    // Re-read the host context immediately before generation and prefer the API
    // SillyTavern is actually using. Connection Manager is only a compatibility
    // fallback when the host does not expose its current Chat/Text stream service.
    const liveContext = getContext();
    const independent = ensureSettings().apiMode === 'independent';
    const currentApi = independent
        ? getIndependentApiStreaming(liveContext)
        : getCurrentApiStreaming(liveContext);
    const connection = independent || currentApi ? null : getConnectionManagerStreaming(liveContext);
    if (!connection && !currentApi) return { supported: false, streamed: false, text: '' };

    const controller = new AbortController();
    state.streamAbortController = controller;
    const source = connection?.label || currentApi?.label || '当前连接';
    const startedAt = performance.now();
    onStatus?.({ phase: 'connecting', source, eventCount: 0, textLength: 0 });
    try {
        // Target Chinese character count is a writing instruction, not an API token limit.
        // Current Chat/Text requests keep SillyTavern's validated response length; only the
        // Connection Manager path still requires an explicit value from its public API.
        const connectionMaxTokens = getResponseTokenBudget(liveContext, maxTokens);
        let response;

        if (currentApi?.api === 'independent-chat') {
            const config = independentApiConfigFromUi({ persist: true });
            if (!hasIndependentApiSettings(config)) {
                throw new Error('独立 API 尚未配置完整，请填写地址、模型并保存 API Key。');
            }
            const messages = [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                { role: 'user', content: prompt },
            ];
            const payload = buildIndependentApiPayload(config, messages, { stream: true });
            response = await currentApi.service.sendRequest(payload, true, controller.signal);
        } else if (connection) {
            const messages = [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                { role: 'user', content: prompt },
            ];
            response = await connection.service.sendRequest(
                connection.profileId,
                messages,
                connectionMaxTokens,
                {
                    stream: true,
                    signal: controller.signal,
                    extractData: true,
                    includePreset: true,
                    includeInstruct: true,
                },
                connection.model ? { model: connection.model } : {},
            );
        } else if (currentApi.api === 'chat') {
            const messages = [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                { role: 'user', content: prompt },
            ];
            const payload = await buildCoreChatStreamingPayload(liveContext, currentApi, messages);
            response = await currentApi.service.sendRequest(payload, true, controller.signal);
        } else {
            const activePreset = getActiveTextCompletionPreset(liveContext, currentApi.settings);
            const settings = cloneSettings(activePreset || currentApi.settings);
            const finalPrompt = [systemPrompt, prompt].filter(Boolean).join('\n\n');
            const overridePayload = {
                prompt: finalPrompt,
                stream: true,
            };
            if (!activePreset) {
                // Older SillyTavern builds may not expose the preset manager. Preserve
                // their current setting where possible instead of inflating it from word count.
                const configuredLimit = Number(
                    settings.genamt
                    ?? settings.max_new_tokens
                    ?? settings.max_tokens
                    ?? document.querySelector('#amount_gen')?.value,
                );
                if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
                    overridePayload.max_tokens = Math.floor(configuredLimit);
                    overridePayload.max_new_tokens = Math.floor(configuredLimit);
                }
            }
            const presetPayload = currentApi.service.presetToGeneratePayload(
                settings,
                {},
                overridePayload,
            );
            // SillyTavern 1.14-1.17 ignores the third override argument. Merge
            // it again so prompt and stream survive on both old and new services.
            const hasAppliedOverrides = presetPayload?.prompt === finalPrompt
                && presetPayload?.stream === true;
            const payload = hasAppliedOverrides
                ? presetPayload
                : buildLegacyTextStreamingPayload(
                    settings,
                    presetPayload,
                    overridePayload,
                    currentApi.service,
                    liveContext.getTextGenServer?.(settings.api_type ?? settings.type),
                );
            const readyEvent = liveContext.eventTypes?.TEXT_COMPLETION_SETTINGS_READY;
            if (readyEvent && typeof liveContext.eventSource?.emit === 'function') {
                await liveContext.eventSource.emit(readyEvent, payload);
            }
            response = await currentApi.service.sendRequest(payload, true, controller.signal);
        }

        const generator = typeof response === 'function'
            ? response()
            : (response && typeof response[Symbol.asyncIterator] === 'function' ? response : null);

        let text = '';
        let eventCount = 0;
        let updateCount = 0;
        let firstChunkMs = null;
        if (generator) {
            onStatus?.({ phase: 'connected', source, eventCount: 0, textLength: 0 });
            for await (const chunk of generator) {
                eventCount += 1;
                const chunkText = typeof chunk === 'string'
                    ? chunk
                    : (chunk?.text ?? chunk?.content ?? '');
                const nextText = mergeStreamText(text, chunkText);
                if (nextText !== text) {
                    text = nextText;
                    updateCount += 1;
                    firstChunkMs ??= Math.round(performance.now() - startedAt);
                    onChunk?.(text, {
                        phase: 'receiving',
                        source,
                        eventCount,
                        updateCount,
                        textLength: text.length,
                        firstChunkMs,
                    });
                }

                // Some reverse proxies buffer several SSE events and release them in one burst.
                // Yield a frame regularly so the browser can still paint received events progressively.
                if (eventCount === 1 || eventCount % 8 === 0) await waitForBrowserPaint();
            }
        } else {
            text = typeof response === 'string'
                ? response
                : (response?.content ?? response?.text ?? '');
        }
        if (!String(text).trim()) throw new Error('流式接口返回了空内容');
        const elapsedMs = Math.round(performance.now() - startedAt);
        const streamed = Boolean(generator && updateCount > 1);
        return {
            supported: true,
            streamed,
            text: String(text),
            source,
            eventCount,
            updateCount,
            firstChunkMs,
            elapsedMs,
            buffered: Boolean((generator && updateCount <= 1) || (!generator && text)),
        };
    } catch (error) {
        const detail = readableError(error);
        throw new Error(`${source} · ${detail}`);
    } finally {
        if (state.streamAbortController === controller) state.streamAbortController = null;
    }
}

async function generatePersona() {
    if (state.generating) return;
    const ctx = getContext();
    const independentReady = ensureSettings().apiMode === 'independent'
        && typeof ctx?.ChatCompletionService?.sendRequest === 'function';
    if (!state.capabilities?.generation && !independentReady) {
        notify('error', '当前版本未提供可用的人设生成接口。');
        return;
    }

    state.generating = true;
    const generationId = ++state.generationEpoch;
    setLoading(true);

    try {
        await refreshContextUi(false);
        const options = collectGenerationOptions();
        const characterContext = collectCharacterContext();
        const openingGreeting = options.referenceGreeting ? collectOpeningGreeting() : '';
        const currentPersonaText = options.mode === 'refine' ? collectCurrentPersonaText() : '';
        if (options.mode === 'refine' && !currentPersonaText) {
            throw new Error('当前 U 的 Persona Description 为空，请先填写人设后再使用优化模式。');
        }
        const lore = await collectWorldLore();
        const prompt = options.mode === 'refine'
            ? buildPersonaRefinementPrompt({
                options,
                personaName: getCurrentPersonaContext(ctx).name,
                currentPersonaText,
                characterContext,
                openingGreeting,
                loreText: lore.text,
            })
            : buildPersonaGenerationPrompt({
                options,
                characterContext,
                openingGreeting,
                loreText: lore.text,
            });

        const systemPrompt = options.mode === 'refine'
            ? buildPersonaRefinementSystemPrompt()
            : buildPersonaSystemPrompt();
        let resultText = '';
        let streamState = { supported: false, streamed: false, text: '' };
        if (options.streamOutput) {
            setStreamingPreview('', { phase: 'preparing' });
            scrollStreamingResultIntoView();
            await waitForBrowserPaint();
            try {
                streamState = await generateRawWithStreaming(ctx, {
                    systemPrompt,
                    prompt,
                    maxTokens: options.targetLength,
                    onStatus: info => {
                        if (generationId === state.generationEpoch) setStreamingPreview('', info);
                    },
                    onChunk: (text, info) => {
                        if (generationId === state.generationEpoch) setStreamingPreview(text, info);
                    },
                });
                if (!streamState.supported) {
                    setStreamingFallbackPreview('当前 API 类型没有可供扩展调用的独立流式接口');
                    await waitForBrowserPaint();
                }
            } catch (error) {
                if (generationId !== state.generationEpoch) return;
                console.warn(`[${DISPLAY_NAME}] Streaming generation failed; falling back to normal generation.`, error);
                const fallbackReason = readableError(error);
                streamState = { supported: true, streamed: false, text: '', fallback: true, fallbackReason };
                setStreamingFallbackPreview(fallbackReason);
                await waitForBrowserPaint();
            }
        }
        if (streamState.text) {
            resultText = streamState.text;
        } else {
            const fallback = await generateWithCurrentConnection(ctx, {
                systemPrompt,
                prompt,
                maxTokens: options.targetLength,
            });
            resultText = fallback.text;
            if (fallback.source) streamState.source = fallback.source;
        }

        if (generationId !== state.generationEpoch) return;
        const payload = parseStructuredResponse(resultText);
        state.structuredResult = normalizeStructuredResult(payload, options, ctx.name1, currentPersonaText);
        state.selectedCandidateIndex = 0;
        state.resultView = 'persona';

        const notes = [];
        notes.push('已完整读取 ' + lore.includedEntries + ' 条世界书内容（' + lore.chars + ' 字）');
        if (openingGreeting) notes.push('已参考角色开场白');
        if (lore.failures.length) notes.push(lore.failures.length + ' 个世界书读取失败');

        const settings = ensureSettings();
        settings.lastStructuredResult = state.structuredResult;
        settings.lastSelectedCandidateIndex = 0;
        settings.lastResult = '';
        settings.lastMode = options.mode;
        if (options.mode !== 'refine') {
            settings.lastStyle = options.style;
            settings.gender = options.gender;
            settings.species = options.species;
            settings.speciesDetail = options.speciesDetail;
            settings.nameCount = options.nameCount;
        }
        settings.lengthPreset = options.lengthPreset;
        settings.targetLength = options.targetLength;
        settings.streamOutput = options.streamOutput;
        settings.sectionSelection = getCurrentSectionSelection();
        saveSettings();
        if (options.streamOutput && streamState.streamed) {
            notes.push(`实时接收 ${streamState.updateCount} 个有效分片`);
        } else if (options.streamOutput && streamState.buffered) {
            notes.push('上游只返回了一个完整分片，未形成实时流');
        } else if (options.streamOutput) {
            notes.push(streamState.supported
                ? `流式请求失败，已回退普通生成${streamState.fallbackReason ? `（${streamState.fallbackReason}）` : ''}`
                : '当前 API 类型未提供独立流式接口，已使用普通生成');
        }
        renderCurrentResult((options.mode === 'refine' ? '当前 U 优化完成 · ' : '') + notes.join(' · '));
    } catch (error) {
        if (generationId !== state.generationEpoch) return;
        console.error(`[${DISPLAY_NAME}] Generation failed`, error);
        notify('error', (currentMode() === 'refine' ? '优化失败：' : '生成失败：') + (error?.message || error));
        setResultError(error?.message || String(error));
    } finally {
        if (generationId === state.generationEpoch) {
            state.generating = false;
            setLoading(false);
        }
    }
}

async function rerollNames() {
    if (state.generating || !state.structuredResult) return;
    if (state.structuredResult.options?.fixedName) {
        notify('info', '当前使用的是指定姓名。');
        return;
    }

    const ctx = getContext();
    const independentReady = ensureSettings().apiMode === 'independent'
        && typeof ctx?.ChatCompletionService?.sendRequest === 'function';
    if (!state.capabilities?.generation && !independentReady) return;
    const count = Number(state.structuredResult.options?.nameCount) || Number(ensureSettings().nameCount) || 5;
    const generationId = ++state.generationEpoch;
    state.generating = true;
    setLoading(true);

    try {
        const result = await generateWithCurrentConnection(ctx, {
            systemPrompt: buildPersonaSystemPrompt(),
            prompt: buildNameRerollPrompt(state.structuredResult, count),
            maxTokens: 900,
        });
        if (generationId !== state.generationEpoch) return;
        const payload = parseStructuredResponse(result.text);
        const candidates = normalizeNameCandidates(payload, ctx.name1);
        if (!candidates.length) throw new Error('模型没有返回新的候选姓名。');

        state.structuredResult = {
            ...state.structuredResult,
            candidates,
        };
        state.selectedCandidateIndex = 0;
        const settings = ensureSettings();
        settings.lastStructuredResult = state.structuredResult;
        settings.lastSelectedCandidateIndex = 0;
        saveSettings();
        renderCurrentResult('已更换候选姓名');
    } catch (error) {
        if (generationId !== state.generationEpoch) return;
        console.error(`[${DISPLAY_NAME}] Name reroll failed`, error);
        notify('error', '更换姓名失败：' + (error?.message || error));
    } finally {
        if (generationId === state.generationEpoch) {
            state.generating = false;
            setLoading(false);
        }
    }
}

function cancelGeneration() {
    if (!state.generating) return;
    state.generationEpoch += 1;
    state.generating = false;
    state.streamAbortController?.abort();
    state.streamAbortController = null;
    try {
        getContext().stopGeneration?.();
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not stop the underlying request.`, error);
    }
    setLoading(false);
    notify('info', '已停止生成。');
}

function selectCandidate(index) {
    if (!state.structuredResult?.candidates?.[index]) return;
    state.selectedCandidateIndex = index;
    const settings = ensureSettings();
    settings.lastSelectedCandidateIndex = index;
    saveSettings();
    renderCurrentResult();
}

function getResultCandidateName() {
    const candidates = state.structuredResult?.candidates || [];
    const safeIndex = Math.min(
        Math.max(Number(state.selectedCandidateIndex) || 0, 0),
        Math.max(0, candidates.length - 1),
    );
    return candidates[safeIndex]?.name || '未命名 Persona';
}

function materializeComparisonText(value) {
    return String(value || '').split(PERSONA_NAME_TOKEN).join(getResultCandidateName());
}

function splitComparisonSegments(value) {
    const text = String(value || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    const segments = text.match(/[^。！？；\n]+[。！？；]?|\n+/g) || [text];
    return segments.map(segment => segment.trim()).filter(Boolean).slice(0, 320);
}

function buildLocalTextDiff(beforeText, afterText) {
    const before = splitComparisonSegments(beforeText);
    const after = splitComparisonSegments(afterText);
    const table = Array.from(
        { length: before.length + 1 },
        () => new Uint16Array(after.length + 1),
    );

    for (let i = 1; i <= before.length; i += 1) {
        for (let j = 1; j <= after.length; j += 1) {
            table[i][j] = before[i - 1] === after[j - 1]
                ? table[i - 1][j - 1] + 1
                : Math.max(table[i - 1][j], table[i][j - 1]);
        }
    }

    const reversed = [];
    let i = before.length;
    let j = after.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
            reversed.push({ type: 'unchanged', text: before[i - 1] });
            i -= 1;
            j -= 1;
        } else if (i > 0 && (j === 0 || table[i - 1][j] >= table[i][j - 1])) {
            reversed.push({ type: 'removed', text: before[i - 1] });
            i -= 1;
        } else {
            reversed.push({ type: 'added', text: after[j - 1] });
            j -= 1;
        }
    }

    return reversed.reverse().reduce((groups, item) => {
        const previous = groups.at(-1);
        if (previous?.type === item.type) {
            previous.text += item.text;
        } else {
            groups.push({ ...item });
        }
        return groups;
    }, []);
}

function appendComparisonColumn(container, labelText, value, tone, emptyText) {
    const column = document.createElement('div');
    column.className = `pf-comparison-column ${tone}`;
    const label = document.createElement('span');
    label.className = 'pf-comparison-column-label';
    label.textContent = labelText;
    const text = document.createElement('div');
    text.className = 'pf-comparison-text';
    text.textContent = value || emptyText;
    column.append(label, text);
    container.appendChild(column);
}

function renderRefinementComparison() {
    const container = state.overlay?.querySelector('#pf-comparison');
    if (!container) return;
    container.replaceChildren();

    const comparison = state.structuredResult?.comparison || {};
    const changes = Array.isArray(comparison.changeLog) ? comparison.changeLog : [];
    const legend = document.createElement('div');
    legend.className = 'pf-diff-legend';
    for (const [className, labelText] of [
        ['is-added', '新增'],
        ['is-modified', '修改'],
        ['is-removed', '删除'],
        ['is-unchanged', '保留'],
    ]) {
        const item = document.createElement('span');
        item.className = className;
        item.textContent = labelText;
        legend.appendChild(item);
    }
    container.appendChild(legend);

    if (changes.length) {
        const typeMeta = {
            added: { label: '新增', className: 'is-added' },
            modified: { label: '修改', className: 'is-modified' },
            removed: { label: '删除', className: 'is-removed' },
            unchanged: { label: '保留', className: 'is-unchanged' },
        };
        for (const change of changes) {
            const meta = typeMeta[change.type] || typeMeta.modified;
            const card = document.createElement('article');
            card.className = `pf-change-card ${meta.className}`;
            const header = document.createElement('header');
            const title = document.createElement('strong');
            title.textContent = change.section || '未分类';
            const badge = document.createElement('span');
            badge.className = `pf-change-badge ${meta.className}`;
            badge.textContent = meta.label;
            header.append(title, badge);
            if (change.reason) {
                const reason = document.createElement('p');
                reason.className = 'pf-change-reason';
                reason.textContent = change.reason;
                header.appendChild(reason);
            }
            card.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'pf-comparison-grid';
            const columnTones = {
                added: ['is-neutral', 'is-added'],
                modified: ['is-neutral', 'is-modified'],
                removed: ['is-removed', 'is-neutral'],
                unchanged: ['is-unchanged', 'is-unchanged'],
            }[change.type] || ['is-neutral', 'is-modified'];
            appendComparisonColumn(grid, '修改前', materializeComparisonText(change.before), columnTones[0], '无对应原文');
            appendComparisonColumn(grid, '修改后', materializeComparisonText(change.after), columnTones[1], '已删除');
            card.appendChild(grid);
            container.appendChild(card);
        }
        return;
    }

    const sourceText = materializeComparisonText(comparison.sourceText);
    const finalText = renderStructuredResult(state.structuredResult, state.selectedCandidateIndex, 'natural');
    if (!sourceText) {
        const empty = document.createElement('div');
        empty.className = 'pf-comparison-empty';
        empty.textContent = '这份旧结果没有保存修改记录，请重新优化一次后查看对比。';
        container.appendChild(empty);
        return;
    }

    const note = document.createElement('p');
    note.className = 'pf-comparison-note';
    note.textContent = '模型没有返回结构化修改记录，以下是本地文本差异。栏目重排可能被识别为修改。';
    container.appendChild(note);
    const fallback = document.createElement('div');
    fallback.className = 'pf-local-diff';
    for (const part of buildLocalTextDiff(sourceText, finalText)) {
        const span = document.createElement('span');
        span.className = `pf-diff-part is-${part.type}`;
        span.textContent = part.text;
        fallback.appendChild(span);
    }
    container.appendChild(fallback);
}

function hasRefinementComparison() {
    const result = state.structuredResult;
    if (result?.options?.mode !== 'refine' || !result.comparison) return false;
    return Boolean(result.comparison.sourceText || result.comparison.changeLog?.length);
}

function updateResultView() {
    const root = state.overlay;
    if (!root) return;
    const toolbar = root.querySelector('#pf-refinement-view-toolbar');
    const comparison = root.querySelector('#pf-comparison');
    const result = root.querySelector('#pf-result');
    const outputToolbar = root.querySelector('#pf-output-toolbar');
    const empty = root.querySelector('#pf-empty');
    const canCompare = hasRefinementComparison();
    if (!canCompare) state.resultView = 'persona';
    const comparing = canCompare && state.resultView === 'comparison';

    if (toolbar) toolbar.hidden = !canCompare;
    root.querySelectorAll('[data-result-view]').forEach(button => {
        const active = button.dataset.resultView === (comparing ? 'comparison' : 'persona');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    if (outputToolbar) outputToolbar.hidden = comparing;
    if (comparison) comparison.hidden = !comparing;
    if (result) result.hidden = comparing || !result.textContent;
    if (empty) empty.hidden = comparing || Boolean(result?.textContent);
    if (comparing) renderRefinementComparison();

    const copy = root.querySelector('#pf-copy');
    if (copy) copy.title = comparing ? '复制优化后人设，不包含修改对比' : '';
}

function setResultView(view) {
    state.resultView = view === 'comparison' && hasRefinementComparison()
        ? 'comparison'
        : 'persona';
    updateResultView();
}

function renderCandidateButtons() {
    const root = state.overlay;
    const panel = root?.querySelector('#pf-candidate-panel');
    const wrap = root?.querySelector('#pf-name-candidates');
    if (!panel || !wrap) return;
    const candidates = state.structuredResult?.candidates || [];
    panel.hidden = candidates.length === 0 || state.structuredResult?.options?.mode === 'refine';
    wrap.replaceChildren();

    candidates.forEach((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pf-name-button';
        button.classList.toggle('is-active', index === state.selectedCandidateIndex);
        button.textContent = candidate.name;
        if (candidate.style) button.title = candidate.style;
        button.addEventListener('click', () => selectCandidate(index));
        wrap.appendChild(button);
    });

    const reroll = root.querySelector('#pf-reroll-names');
    if (reroll) reroll.hidden = Boolean(state.structuredResult?.options?.fixedName);
}

function renderCurrentResult(meta = '生成完成，可切换姓名和输出格式') {
    if (!state.structuredResult) return;
    const format = ensureSettings().lastOutputFormat || 'natural';
    const text = renderStructuredResult(state.structuredResult, state.selectedCandidateIndex, format);
    renderCandidateButtons();
    setResult(text, meta);
    updateResultView();
}

function setLoading(loading) {
    const root = state.overlay;
    if (!root) return;
    const generate = root.querySelector('#pf-generate');
    const regenerate = root.querySelector('#pf-regenerate');
    const copy = root.querySelector('#pf-copy');
    const cancel = root.querySelector('#pf-cancel');
    const rerollNamesButton = root.querySelector('#pf-reroll-names');

    generate.disabled = loading;
    regenerate.disabled = loading || !root.querySelector('#pf-result')?.textContent?.trim();
    copy.disabled = loading || !root.querySelector('#pf-result')?.textContent?.trim();
    if (cancel) cancel.hidden = !loading;
    if (rerollNamesButton) rerollNamesButton.disabled = loading;
    root.querySelectorAll('.pf-name-button, .pf-format-button, .pf-view-button, .pf-segment[data-mode]').forEach(button => {
        button.disabled = loading;
    });
    generate.classList.toggle('is-loading', loading);
    generate.textContent = loading
        ? (currentMode() === 'refine' ? '正在优化…' : '正在生成…')
        : (currentMode() === 'refine' ? '🪄 优化当前 U' : '✨ 生成人设');
    root.querySelector('.pf-modal')?.setAttribute('aria-busy', String(loading));
    if (!loading) updateModeUi();
}

function formatStreamStatus(info = {}, value = '') {
    const source = info.source ? ` · ${info.source}` : '';
    if (info.phase === 'preparing') {
        return currentMode() === 'refine'
            ? '正在整理当前 U、角色设定与世界书…'
            : '正在整理世界书与生成要求…';
    }
    if (info.phase === 'connecting') return `正在建立流式连接${source}…`;
    if (info.phase === 'connected') return `流式连接已建立${source}，等待首个分片…`;
    if (info.phase === 'receiving') {
        const count = Number(info.updateCount || info.eventCount) || 0;
        return `实时接收中 · ${String(value).length} 字 · ${count} 个有效分片${source}`;
    }
    return '正在等待模型输出…';
}

function scrollStreamingResultIntoView() {
    const root = state.overlay;
    const scroller = root?.querySelector('.pf-scroll');
    const card = root?.querySelector('#pf-result-card');
    if (!scroller || !card) return;
    const targetTop = Math.max(0, card.offsetTop - scroller.offsetTop - 12);
    try {
        scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
    } catch {
        scroller.scrollTop = targetTop;
    }
}

function setStreamingPreview(text = '', info = {}) {
    const root = state.overlay;
    if (!root) return;
    const result = root.querySelector('#pf-result');
    const empty = root.querySelector('#pf-empty');
    const value = String(text ?? '');
    const status = formatStreamStatus(info, value);
    state.resultView = 'persona';
    root.querySelector('#pf-refinement-view-toolbar').hidden = true;
    root.querySelector('#pf-comparison').hidden = true;
    root.querySelector('#pf-output-toolbar').hidden = false;
    result.textContent = value;
    result.hidden = !value;
    empty.hidden = Boolean(value);
    if (!value) empty.textContent = status;
    if (value) result.scrollTop = result.scrollHeight;
    root.querySelector('#pf-result-meta').textContent = status;
    root.querySelector('#pf-copy').disabled = true;
    root.querySelector('#pf-regenerate').disabled = true;
    root.querySelector('#pf-candidate-panel').hidden = true;
    const generate = root.querySelector('#pf-generate');
    if (generate && state.generating) {
        generate.textContent = value
            ? `已接收 ${value.length} 字 · ${Number(info.updateCount || info.eventCount) || 0} 片`
            : '正在连接流式输出…';
    }
}

function setStreamingFallbackPreview(reason = '') {
    const root = state.overlay;
    if (!root) return;
    const message = `流式连接未成功，正在切换普通生成${reason ? `：${reason}` : '…'}`;
    const empty = root.querySelector('#pf-empty');
    const result = root.querySelector('#pf-result');
    state.resultView = 'persona';
    root.querySelector('#pf-refinement-view-toolbar').hidden = true;
    root.querySelector('#pf-comparison').hidden = true;
    root.querySelector('#pf-output-toolbar').hidden = false;
    result.hidden = true;
    result.textContent = '';
    empty.hidden = false;
    empty.textContent = message;
    root.querySelector('#pf-result-meta').textContent = message;
    const generate = root.querySelector('#pf-generate');
    if (generate && state.generating) generate.textContent = '已回退普通生成…';
}

function setResult(text, meta = '生成完成') {
    const root = state.overlay;
    if (!root) return;
    const result = root.querySelector('#pf-result');
    const empty = root.querySelector('#pf-empty');
    result.textContent = text;
    result.hidden = false;
    empty.hidden = true;
    root.querySelector('#pf-result-meta').textContent = meta;
    root.querySelector('#pf-copy').disabled = false;
    root.querySelector('#pf-regenerate').disabled = false;
    updateResultView();
}

function setResultError(message) {
    const root = state.overlay;
    if (!root) return;
    const result = root.querySelector('#pf-result');
    const empty = root.querySelector('#pf-empty');
    result.hidden = true;
    result.textContent = '';
    const candidatePanel = root.querySelector('#pf-candidate-panel');
    if (candidatePanel) candidatePanel.hidden = true;
    root.querySelector('#pf-refinement-view-toolbar').hidden = true;
    root.querySelector('#pf-comparison').hidden = true;
    root.querySelector('#pf-output-toolbar').hidden = false;
    empty.hidden = false;
    empty.textContent = `生成失败：${message}`;
    root.querySelector('#pf-result-meta').textContent = generationErrorHint(message);
    root.querySelector('#pf-copy').disabled = true;
    root.querySelector('#pf-regenerate').disabled = false;
}

function generationErrorHint(message) {
    const text = String(message || '');
    if (/思考内容|reasoning|thinking/i.test(text)) {
        return '模型只返回了思考，没有返回最终正文。可降低思考强度、关闭思考显示或提高回复上限。';
    }
    if (/空内容|No message generated|empty/i.test(text)) {
        return '模型没有返回可用正文。请检查回复上限、内容过滤和当前模型设置。';
    }
    if (/moderation|safety|blocked|filtered|内容过滤|安全/i.test(text)) {
        return '模型或上游接口拦截了这次内容。可更换模型，或减少过于敏感的输入后重试。';
    }
    if (/422|400|参数|payload|request/i.test(text)) {
        return '当前模型拒绝了请求参数。请确认连接配置、模型名称和回复上限。';
    }
    if (/网络|连接|fetch|timeout|超时|status 5/i.test(text)) {
        return '请求没有正常到达模型服务，请检查酒馆连接状态和反向代理。';
    }
    return '请检查当前模型连接与返回内容后重试。';
}

async function copyText(text) {
    if (navigator.clipboard?.writeText && globalThis.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('浏览器拒绝复制。');
}

async function copyCurrentResult() {
    const text = state.overlay?.querySelector('#pf-result')?.textContent?.trim() || '';
    if (!text) return;
    try {
        await copyText(text);
        const button = state.overlay.querySelector('#pf-copy');
        const old = button.textContent;
        button.textContent = '✓ 已复制';
        button.classList.add('is-copied');
        notify('success', '人设正文已复制到剪贴板。');
        setTimeout(() => {
            button.textContent = old;
            button.classList.remove('is-copied');
        }, 1400);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Copy failed`, error);
        notify('error', '复制失败，请长按结果区域手动复制。');
    }
}

function bindContextEvents() {
    const ctx = getContext();
    const refresh = () => {
        if (!state.overlay?.classList.contains('is-open')) return;
        state.lastContextSignature = '';
        refreshContextUi(true).catch(console.error);
    };

    const candidates = [
        'CHAT_CHANGED',
        'CHARACTER_EDITED',
        'CHARACTER_PAGE_LOADED',
        'WORLDINFO_UPDATED',
        'WORLDINFO_SETTINGS_UPDATED',
        'PERSONA_CHANGED',
        'MESSAGE_SWIPED',
        'CONNECTION_PROFILE_LOADED',
        'CONNECTION_PROFILE_UPDATED',
        'API_CHANGED',
        'CHAT_COMPLETION_SETTINGS_UPDATED',
    ];

    subscribeHostEvents(ctx, candidates, refresh);
}

export async function init() {
    try {
        await initializeHostCompatibility();
        state.capabilities = detectHostCapabilities(getContext());
        createStaticUi();
        createSettingsUi();
        ensureSettings();
        const compatibilityNote = state.overlay?.querySelector('#pf-compat-note');
        if (compatibilityNote && state.capabilities.compatibilityMode) {
            compatibilityNote.hidden = false;
            compatibilityNote.textContent = state.capabilities.missing.length
                ? `旧版兼容模式：${state.capabilities.missing.join('、')}不可用，其余功能已自动适配。`
                : '旧版酒馆兼容模式已启用，现有功能将按可用接口自动适配。';
        }
        updateFloatingButton();
        bindContextEvents();
        await detectWorldBooks();
        console.info(`[${DISPLAY_NAME}] v${VERSION} loaded.`);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Init failed`, error);
    }
}

// SillyTavern loads extension scripts as modules. Start once the host DOM is ready.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
} else {
    init();
}
