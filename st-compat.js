export const MINIMUM_SILLYTAVERN_VERSION = '1.14.0';

let contextFactory = null;

function resolveGlobalContextFactory() {
    const factory = globalThis.SillyTavern?.getContext;
    return typeof factory === 'function' ? factory.bind(globalThis.SillyTavern) : null;
}

export async function initializeHostCompatibility() {
    contextFactory = resolveGlobalContextFactory();
    if (contextFactory) return contextFactory();

    // 1.14+ normally exposes SillyTavern.getContext(). The module fallback keeps
    // the extension usable when third-party modules load before the global namespace.
    const candidates = ['../../../st-context.js', '/scripts/st-context.js'];
    let lastError;
    for (const path of candidates) {
        try {
            const runtime = await import(path);
            const factory = runtime.getContext ?? runtime.default;
            if (typeof factory === 'function') {
                contextFactory = factory;
                return contextFactory();
            }
        } catch (error) {
            lastError = error;
        }
    }

    const detail = lastError?.message ? `（${lastError.message}）` : '';
    throw new Error(`未检测到 SillyTavern 上下文接口，请确认版本不低于 ${MINIMUM_SILLYTAVERN_VERSION}${detail}`);
}

export function getHostContext() {
    contextFactory ??= resolveGlobalContextFactory();
    if (!contextFactory) {
        throw new Error(`未检测到 SillyTavern 上下文接口，请确认版本不低于 ${MINIMUM_SILLYTAVERN_VERSION}`);
    }
    return contextFactory();
}

export function detectHostCapabilities(ctx = getHostContext()) {
    const hasRawGeneration = typeof ctx?.generateRaw === 'function';
    const hasRawDataGeneration = typeof ctx?.generateRawData === 'function';
    const hasQuietGeneration = typeof ctx?.generateQuietPrompt === 'function';
    const hasChatStreaming = typeof ctx?.ChatCompletionService?.sendRequest === 'function';
    const hasTextStreaming = typeof ctx?.TextCompletionService?.sendRequest === 'function';
    const hasProfileStreaming = typeof ctx?.ConnectionManagerRequestService?.sendRequest === 'function';
    const hasEvents = typeof ctx?.eventSource?.on === 'function'
        && Boolean(ctx?.eventTypes ?? ctx?.event_types);
    const hasWorldInfoRuntime = typeof ctx?.loadWorldInfo === 'function';
    const missing = [];

    if (!hasRawGeneration && !hasRawDataGeneration && !hasQuietGeneration) missing.push('人设生成');
    if (!hasWorldInfoRuntime) missing.push('世界书正文读取');
    if (!hasEvents) missing.push('上下文自动刷新');
    if (!hasChatStreaming && !hasTextStreaming && !hasProfileStreaming) missing.push('流式输出');

    return {
        generation: hasRawGeneration || hasRawDataGeneration || hasQuietGeneration,
        rawGeneration: hasRawGeneration,
        rawDataGeneration: hasRawDataGeneration,
        quietGenerationFallback: !hasRawGeneration && hasQuietGeneration,
        worldInfo: hasWorldInfoRuntime,
        worldInfoNames: typeof ctx?.getWorldInfoNames === 'function',
        persona: Boolean(ctx?.powerUserSettings && typeof ctx.powerUserSettings === 'object'),
        activeGreeting: Array.isArray(ctx?.chat),
        events: hasEvents,
        stopGeneration: typeof ctx?.stopGeneration === 'function',
        streaming: hasChatStreaming || hasTextStreaming || hasProfileStreaming,
        compatibilityMode: typeof ctx?.getWorldInfoNames !== 'function'
            || !ctx?.Popup?.show
            || (!hasRawGeneration && !hasRawDataGeneration),
        missing,
    };
}

export function readSelectedConnectionProfile(ctx) {
    const extensionSettings = ctx?.extensionSettings;
    const connectionManager = extensionSettings?.connectionManager;
    const disabled = Array.isArray(extensionSettings?.disabledExtensions)
        && extensionSettings.disabledExtensions.includes('connection-manager');
    const profileId = connectionManager?.selectedProfile;
    const profiles = Array.isArray(connectionManager?.profiles) ? connectionManager.profiles : [];
    if (disabled || !profileId) return null;
    const profile = profiles.find(item => item?.id === profileId);
    return profile ? { ...profile, id: profileId } : null;
}

function modelFromSettings(ctx, settings) {
    if (!settings || typeof settings !== 'object') return '';
    try {
        const model = ctx?.getChatCompletionModel?.(settings);
        if (model) return String(model).trim();
    } catch (error) {
        console.warn('[Persona Forge] Could not read the current Chat Completion model.', error);
    }

    const source = String(settings.chat_completion_source || '').toLowerCase();
    const fieldBySource = {
        claude: 'claude_model',
        openai: 'openai_model',
        makersuite: 'google_model',
        vertexai: 'vertexai_model',
        openrouter: 'openrouter_model',
        mistralai: 'mistralai_model',
        custom: 'custom_model',
        cohere: 'cohere_model',
        groq: 'groq_model',
        siliconflow: 'siliconflow_model',
        minimax: 'minimax_model',
        electronhub: 'electronhub_model',
        chutes: 'chutes_model',
        nanogpt: 'nanogpt_model',
        deepseek: 'deepseek_model',
        aimlapi: 'aimlapi_model',
        xai: 'xai_model',
        pollinations: 'pollinations_model',
        cometapi: 'cometapi_model',
        moonshot: 'moonshot_model',
        fireworks: 'fireworks_model',
        zai: 'zai_model',
        workers_ai: 'workers_ai_model',
    };
    const field = fieldBySource[source];
    return String((field && settings[field]) || settings.model || settings.model_name || '').trim();
}

export function getActiveModelInfo(ctx) {
    const profile = readSelectedConnectionProfile(ctx);
    const settings = ctx?.chatCompletionSettings;
    const mainApi = String(ctx?.mainApi || '').toLowerCase();
    const source = String(
        settings?.chat_completion_source
        || (mainApi === 'textgenerationwebui' ? settings?.api_type : mainApi)
        || '',
    ).trim();
    const liveModel = modelFromSettings(ctx, settings);
    const profileModel = String(profile?.model || '').trim();
    const model = liveModel || profileModel;
    const profileName = String(profile?.name || '').trim();
    const provider = String(profile?.api || source || mainApi || '当前连接').trim();

    return {
        profile,
        profileName,
        provider,
        liveModel,
        profileModel,
        model,
        source,
        label: [profileName || provider, model].filter(Boolean).join(' · ') || '跟随 SillyTavern 当前连接',
    };
}

function firstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value;
        if (Array.isArray(value)) {
            const text = value
                .map(item => typeof item === 'string' ? item : item?.text)
                .filter(item => typeof item === 'string' && item.trim())
                .join('');
            if (text.trim()) return text;
        }
    }
    return '';
}

export function extractGeneratedTextCompat(ctx, data, activeApi = null) {
    if (typeof data === 'string') return data;

    // SillyTavern's own extractor knows provider-specific response shapes.
    if (typeof ctx?.extractMessageFromData === 'function') {
        try {
            const extracted = ctx.extractMessageFromData(data, activeApi || ctx.mainApi || null);
            if (typeof extracted === 'string' && extracted.trim()) return extracted;
        } catch (error) {
            console.warn('[Persona Forge] Host response extractor failed.', error);
        }
    }

    return firstText(
        data?.content,
        data?.text,
        data?.response,
        data?.message?.content,
        data?.choices?.[0]?.message?.content,
        data?.choices?.[0]?.text,
        data?.results?.[0]?.text,
        data?.output,
        data?.candidates?.[0]?.content?.parts,
    );
}

export function extractReasoningCompat(data) {
    if (!data || typeof data !== 'object') return '';
    const parts = data?.responseContent?.parts;
    const thoughtParts = Array.isArray(parts)
        ? parts.filter(part => part?.thought).map(part => part.text).filter(Boolean).join('')
        : '';
    return firstText(
        data?.reasoning,
        data?.reasoning_content,
        data?.thinking,
        data?.thoughts,
        data?.message?.reasoning,
        data?.message?.reasoning_content,
        data?.choices?.[0]?.message?.reasoning,
        data?.choices?.[0]?.message?.reasoning_content,
        thoughtParts,
    );
}

export async function generateRawDataCompat(ctx, {
    systemPrompt = '',
    prompt = '',
    responseLength = null,
    api = null,
} = {}) {
    if (typeof ctx?.generateRawData === 'function') {
        return await ctx.generateRawData({ systemPrompt, prompt, responseLength, api });
    }
    return null;
}

export async function generateRawCompat(ctx, {
    systemPrompt = '',
    prompt = '',
    responseLength = null,
    trimNames = false,
} = {}) {
    if (typeof ctx?.generateRawData === 'function') {
        const raw = await generateRawDataCompat(ctx, { systemPrompt, prompt, responseLength });
        const text = extractGeneratedTextCompat(ctx, raw);
        if (text.trim()) return text;

        const reasoning = extractReasoningCompat(raw);
        if (reasoning.trim()) {
            throw new Error('模型只返回了思考内容，没有最终人设正文。请降低思考强度或提高回复上限后重试。');
        }
        throw new Error('模型返回了空内容。请检查当前模型的回复上限与内容过滤设置后重试。');
    }
    if (typeof ctx?.generateRaw === 'function') {
        return await ctx.generateRaw({ systemPrompt, prompt, responseLength, trimNames });
    }
    if (typeof ctx?.generateQuietPrompt === 'function') {
        const combinedPrompt = [systemPrompt, prompt].filter(Boolean).join('\n\n');
        return await ctx.generateQuietPrompt(combinedPrompt, false, false, responseLength);
    }
    throw new Error('当前 SillyTavern 未提供可用的人设生成接口。');
}

export function readPersonaCompat(ctx) {
    const powerUser = ctx?.powerUserSettings && typeof ctx.powerUserSettings === 'object'
        ? ctx.powerUserSettings
        : {};
    const name = ctx?.name1
        ?? powerUser.name1
        ?? globalThis.document?.querySelector?.('#your_name')?.value
        ?? '';
    const description = powerUser.persona_description
        ?? powerUser.personaDescription
        ?? '';
    return {
        name: String(name).trim(),
        description: String(description).trim(),
    };
}

export function readOpeningGreetingCompat(ctx, defaultGreeting = '') {
    const firstMessage = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
    const activeGreeting = firstMessage && !firstMessage.is_user && !firstMessage.is_system
        ? String(firstMessage.mes ?? firstMessage.message ?? '').trim()
        : '';
    if (activeGreeting) {
        return { text: activeGreeting, source: '当前聊天正在显示的开场白' };
    }
    const fallback = String(defaultGreeting || '').trim();
    return {
        text: fallback,
        source: fallback ? '角色卡默认开场白（第一个）' : '',
    };
}

export function subscribeHostEvents(ctx, eventKeys, listener) {
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types;
    if (typeof source?.on !== 'function' || !types) return [];

    const subscribed = [];
    for (const key of eventKeys) {
        if (!types[key]) continue;
        source.on(types[key], listener);
        subscribed.push(key);
    }
    return subscribed;
}

export function buildLegacyChatStreamingPayload(settings, messages, model, service = null) {
    const source = settings?.chat_completion_source;
    const request = {
        ...settings,
        type: 'normal',
        messages,
        model,
        temperature: Number(settings?.temp_openai ?? settings?.temperature ?? 1),
        frequency_penalty: Number(settings?.freq_pen_openai ?? settings?.frequency_penalty ?? 0),
        presence_penalty: Number(settings?.pres_pen_openai ?? settings?.presence_penalty ?? 0),
        top_p: Number(settings?.top_p_openai ?? settings?.top_p ?? 1),
        top_k: Number(settings?.top_k_openai ?? settings?.top_k ?? 0),
        top_a: Number(settings?.top_a_openai ?? settings?.top_a ?? 0),
        min_p: Number(settings?.min_p_openai ?? settings?.min_p ?? 0),
        repetition_penalty: Number(settings?.repetition_penalty_openai ?? settings?.repetition_penalty ?? 1),
        max_tokens: Number(settings?.openai_max_tokens ?? settings?.max_tokens ?? 1000),
        stream: true,
        chat_completion_source: source,
        include_reasoning: Boolean(settings?.show_thoughts),
    };
    return typeof service?.createRequestData === 'function'
        ? service.createRequestData(request)
        : request;
}

export function buildLegacyTextStreamingPayload(settings, presetPayload, overridePayload, service = null, apiServer = '') {
    const apiType = presetPayload?.api_type ?? settings?.api_type ?? settings?.type;
    const request = {
        ...settings,
        ...presetPayload,
        ...overridePayload,
        api_type: apiType,
        api_server: (presetPayload?.api_server ?? settings?.api_server ?? apiServer) || undefined,
    };
    return typeof service?.createRequestData === 'function'
        ? service.createRequestData(request)
        : request;
}