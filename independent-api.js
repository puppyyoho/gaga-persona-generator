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
        ? input.modelOptions.map(item => String(item ?? '').trim()).filter(Boolean)
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
    // OpenAI-compatible APIs normally return `{ data: [{ id: ... }] }`, but
    // gateways also commonly use `{ models: [...] }`, nested `result` objects,
    // or a map keyed by model ID. Walk all of those shapes instead of keeping
    // only the first entry/first known container.
    const models = [];
    const modelSet = new Set();
    const seen = new WeakSet();
    const containerKeys = new Set([
        'data', 'models', 'model_list', 'modelList', 'items', 'results', 'result', 'values',
    ]);
    const identityKeys = ['id', 'model', 'name', 'value', 'slug'];
    const ignoredMapKeys = new Set([
        'data', 'models', 'model_list', 'modelList', 'items', 'results', 'result', 'values',
        'object', 'created', 'owned_by', 'permission', 'root', 'parent', 'error', 'message',
    ]);

    const add = value => {
        const model = String(value ?? '').trim();
        if (model && !modelSet.has(model)) {
            modelSet.add(model);
            models.push(model);
        }
    };

    const visit = (node, { allowString = false, allowMapKeys = false } = {}) => {
        if (typeof node === 'string') {
            if (allowString) add(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) visit(item, { allowString: true, allowMapKeys: false });
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);

        let hasIdentity = false;
        for (const key of identityKeys) {
            if (node[key] !== undefined && node[key] !== null) {
                hasIdentity = true;
                add(node[key]);
                break;
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (containerKeys.has(key)) {
                visit(value, { allowString: true, allowMapKeys: key === 'data' || key === 'models' || key === 'model_list' || key === 'modelList' });
            } else if (allowMapKeys && !hasIdentity && !ignoredMapKeys.has(key)) {
                // Some providers return `{ models: { "provider/model": {...} } }`.
                add(key);
                visit(value, { allowString: false, allowMapKeys: false });
            }
        }
    };

    visit(data, { allowString: true, allowMapKeys: false });
    return models;
}

export function buildIndependentApiModelsUrl(endpoint) {
    const base = normalizeIndependentApiUrl(endpoint);
    return base ? `${base}/models` : '';
}

