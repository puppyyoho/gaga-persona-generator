const DEFAULT_ENDPOINT = '';

export const INDEPENDENT_API_SOURCE = 'custom';

export const DEFAULT_INDEPENDENT_API_SETTINGS = Object.freeze({
    endpoint: DEFAULT_ENDPOINT,
    model: '',
    secretId: '',
    modelOptions: [],
    maxTokens: '',
    temperature: 0.8,
});

/**
 * Store the provider base URL rather than a complete endpoint. SillyTavern's
 * custom Chat Completion backend appends `/chat/completions` itself.
 */
export function normalizeIndependentApiUrl(value) {
    let url = String(value ?? '').trim();
    if (!url) return '';
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/chat\/completions$/i, '');
    url = url.replace(/\/models$/i, '');
    return url.replace(/\/+$/, '');
}

export function normalizeIndependentApiSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const maxTokens = Number(input.maxTokens);
    const temperature = Number(input.temperature);
    const modelOptions = Array.isArray(input.modelOptions)
        ? input.modelOptions.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 500)
        : [];
    return {
        endpoint: normalizeIndependentApiUrl(input.endpoint),
        model: String(input.model ?? '').trim(),
        secretId: String(input.secretId ?? '').trim(),
        modelOptions: [...new Set(modelOptions)],
        maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : '',
        temperature: Number.isFinite(temperature)
            ? Math.min(2, Math.max(0, temperature))
            : DEFAULT_INDEPENDENT_API_SETTINGS.temperature,
    };
}

export function hasIndependentApiSettings(value) {
    const settings = normalizeIndependentApiSettings(value);
    // The model may intentionally be blank: the caller can resolve it from
    // SillyTavern's currently active model before sending the request.
    return Boolean(settings.endpoint && settings.secretId);
}

export function buildIndependentApiPayload(config, messages, { stream = false } = {}) {
    const settings = normalizeIndependentApiSettings(config);
    const payload = {
        chat_completion_source: INDEPENDENT_API_SOURCE,
        custom_url: settings.endpoint,
        secret_id: settings.secretId,
        messages: Array.isArray(messages) ? messages : [],
        stream: Boolean(stream),
        temperature: settings.temperature,
    };
    if (settings.model) payload.model = settings.model;
    if (settings.maxTokens) payload.max_tokens = settings.maxTokens;
    return payload;
}

export function parseIndependentApiModels(data) {
    const raw = Array.isArray(data)
        ? data
        : data?.data ?? data?.models ?? data?.result?.data ?? data?.result?.models ?? [];
    if (!Array.isArray(raw)) return [];
    const models = raw.map(item => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        return item.id ?? item.model ?? item.name ?? item.value ?? '';
    }).map(item => String(item ?? '').trim()).filter(Boolean);
    return [...new Set(models)].slice(0, 500);
}

export function buildIndependentApiModelsUrl(endpoint) {
    const base = normalizeIndependentApiUrl(endpoint);
    return base ? `${base}/models` : '';
}

