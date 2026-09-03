import assert from 'node:assert/strict';
import test from 'node:test';
import {
    INDEPENDENT_API_SOURCE,
    buildIndependentApiPayload,
    hasIndependentApiSettings,
    normalizeIndependentApiSettings,
    normalizeIndependentApiUrl,
    parseIndependentApiModels,
    buildIndependentApiModelsUrl,
} from '../independent-api.js';

test('normalizes the custom endpoint to a provider base URL', () => {
    assert.equal(normalizeIndependentApiUrl(' https://example.test/v1/// '), 'https://example.test/v1');
    assert.equal(normalizeIndependentApiUrl('https://example.test/v1/chat/completions'), 'https://example.test/v1');
    assert.equal(normalizeIndependentApiUrl(''), '');
});

test('normalizes independent API settings without retaining a raw key', () => {
    const settings = normalizeIndependentApiSettings({
        endpoint: 'https://example.test/v1/chat/completions',
        model: '  model-a ',
        secretId: 'secret-1',
        maxTokens: '1800.8',
        temperature: 4,
        apiKey: 'should-not-be-used',
    });
    assert.deepEqual(settings, {
        endpoint: 'https://example.test/v1',
        model: 'model-a',
        secretId: 'secret-1',
        modelOptions: [],
        maxTokens: 1800,
        temperature: 2,
    });
    assert.equal(hasIndependentApiSettings(settings), true);
});

test('builds SillyTavern custom Chat Completion payloads', () => {
    const payload = buildIndependentApiPayload({
        endpoint: 'https://example.test/v1',
        model: 'model-a',
        secretId: 'secret-1',
        maxTokens: 1200,
        temperature: 0.4,
    }, [{ role: 'user', content: 'hello' }], { stream: true });
    assert.equal(payload.chat_completion_source, INDEPENDENT_API_SOURCE);
    assert.equal(payload.custom_url, 'https://example.test/v1');
    assert.equal(payload.secret_id, 'secret-1');
    assert.equal(payload.model, 'model-a');
    assert.equal(payload.stream, true);
    assert.equal(payload.max_tokens, 1200);
    assert.equal('api_key' in payload, false);
});

test('allows the model to be selected after fetching the independent list', () => {
    const settings = normalizeIndependentApiSettings({
        endpoint: 'https://example.test/v1',
        secretId: 'secret-1',
    });
    assert.equal(hasIndependentApiSettings(settings), true);
    const payload = buildIndependentApiPayload(settings, [], { stream: false });
    assert.equal('model' in payload, false);
});

test('parses standard and provider-specific model list shapes', () => {
    assert.deepEqual(parseIndependentApiModels({
        data: [{ id: 'gpt-a' }, { id: 'gpt-b' }, { id: 'gpt-a' }],
    }), ['gpt-a', 'gpt-b']);
    assert.deepEqual(parseIndependentApiModels({
        models: [{ name: 'local-a' }, 'local-b'],
    }), ['local-a', 'local-b']);
    assert.deepEqual(parseIndependentApiModels({
        result: { models: { 'provider/model-a': {}, 'provider/model-b': {} } },
    }), ['provider/model-a', 'provider/model-b']);
    assert.deepEqual(parseIndependentApiModels({
        data: { 'provider/model-c': {}, 'provider/model-d': {} },
    }), ['provider/model-c', 'provider/model-d']);
    const manyModels = Array.from({ length: 650 }, (_, index) => ({ id: `model-${index}` }));
    assert.equal(parseIndependentApiModels({ data: manyModels }).length, manyModels.length);
    assert.equal(buildIndependentApiModelsUrl('https://example.test/v1/chat/completions'), 'https://example.test/v1/models');
});

