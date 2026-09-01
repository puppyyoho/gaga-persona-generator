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
    const hasQuietGeneration = typeof ctx?.generateQuietPrompt === 'function';
    const hasChatStreaming = typeof ctx?.ChatCompletionService?.sendRequest === 'function';
    const hasTextStreaming = typeof ctx?.TextCompletionService?.sendRequest === 'function';
    const hasProfileStreaming = typeof ctx?.ConnectionManagerRequestService?.sendRequest === 'function';
    const hasEvents = typeof ctx?.eventSource?.on === 'function'
        && Boolean(ctx?.eventTypes ?? ctx?.event_types);
    const hasWorldInfoRuntime = typeof ctx?.loadWorldInfo === 'function';
    const missing = [];

    if (!hasRawGeneration && !hasQuietGeneration) missing.push('人设生成');
    if (!hasWorldInfoRuntime) missing.push('世界书正文读取');
    if (!hasEvents) missing.push('上下文自动刷新');
    if (!hasChatStreaming && !hasTextStreaming && !hasProfileStreaming) missing.push('流式输出');

    return {
        generation: hasRawGeneration || hasQuietGeneration,
        rawGeneration: hasRawGeneration,
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
            || !hasRawGeneration,
        missing,
    };
}

export async function generateRawCompat(ctx, { systemPrompt = '', prompt = '', responseLength = null } = {}) {
    if (typeof ctx?.generateRaw === 'function') {
        return await ctx.generateRaw({ systemPrompt, prompt, responseLength });
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
