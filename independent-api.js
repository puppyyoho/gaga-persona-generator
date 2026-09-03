const DEFAULT_ENDPOINT = '';

export const INDEPENDENT_API_SOURCE = 'custom';

export const DEFAULT_INDEPENDENT_API_SETTINGS = Object.freeze({
    endpoint: DEFAULT_ENDPOINT,
    model: '',
    secretId: '',
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
    return url.replace(/\/+$/, '');
}

export function normalizeIndependentApiSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const maxTokens = Number(input.maxTokens);
    const temperature = Number(input.temperature);
    return {
        endpoint: normalizeIndependentApiUrl(input.endpoint),
        model: String(input.model ?? '').trim(),
        secretId: String(input.secretId ?? '').trim(),
        maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : '',
        temperature: Number.isFinite(temperature)
            ? Math.min(2, Math.max(0, temperature))
            : DEFAULT_INDEPENDENT_API_SETTINGS.temperature,
    };
}

export function hasIndependentApiSettings(value) {
    const settings = normalizeIndependentApiSettings(value);
    return Boolean(settings.endpoint && settings.model && settings.secretId);
}

export function buildIndependentApiPayload(config, messages, { stream = false } = {}) {
    const settings = normalizeIndependentApiSettings(config);
    const payload = {
        chat_completion_source: INDEPENDENT_API_SOURCE,
        custom_url: settings.endpoint,
        secret_id: settings.secretId,
        model: settings.model,
        messages: Array.isArray(messages) ? messages : [],
        stream: Boolean(stream),
        temperature: settings.temperature,
    };
    if (settings.maxTokens) payload.max_tokens = settings.maxTokens;
    return payload;
}

