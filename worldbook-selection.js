export const WORLD_ENTRY_MODE_ALL = 'all';
export const WORLD_ENTRY_MODE_CUSTOM = 'custom';

export function normalizeWorldEntrySelections(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized = {};
    for (const [sourceKey, raw] of Object.entries(value)) {
        const key = String(sourceKey || '').trim();
        if (!key || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        normalized[key] = {
            mode: raw.mode === WORLD_ENTRY_MODE_CUSTOM
                ? WORLD_ENTRY_MODE_CUSTOM
                : WORLD_ENTRY_MODE_ALL,
            strategy: raw.strategy === 'exclude' ? 'exclude' : 'include',
            ids: [...new Set(
                (Array.isArray(raw.ids) ? raw.ids : [])
                    .map(id => String(id ?? '').trim())
                    .filter(Boolean),
            )],
        };
    }
    return normalized;
}

export function worldBookSourceKey(name) {
    return 'world:' + String(name ?? '').trim();
}

export function embeddedBookSourceKey(identity) {
    return 'embedded:' + String(identity || 'current-character').trim();
}

export function createWorldEntryId(entry, fallbackKey, index = 0) {
    const explicit = entry?.uid
        ?? entry?.id
        ?? entry?.displayIndex
        ?? entry?.display_index;
    const value = explicit !== undefined && explicit !== null && String(explicit).trim()
        ? String(explicit).trim()
        : String(fallbackKey ?? index).trim();
    return 'entry:' + (value || String(index));
}

function parseJsonContainer(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text || !'[{'.includes(text[0])) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function entryContent(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const nested = entry.data && typeof entry.data === 'object' ? entry.data : {};
    return String(
        entry.content
        ?? entry.text
        ?? entry.value
        ?? nested.content
        ?? nested.text
        ?? '',
    ).trim();
}

function looksLikeEntryMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const records = value instanceof Map ? [...value.values()] : Object.values(value);
    return records.some(entry => entry && typeof entry === 'object' && entryContent(entry));
}

export function normalizeWorldBookPayload(value) {
    const queue = [value];
    const visited = new Set();
    let emptyBook = null;
    while (queue.length) {
        const current = parseJsonContainer(queue.shift());
        if (!current || typeof current !== 'object' || visited.has(current)) continue;
        visited.add(current);

        if (Array.isArray(current) || current instanceof Map) {
            const book = { entries: current };
            if (entryPairs(current).length) return book;
            emptyBook ??= book;
        }
        const parsedEntries = parseJsonContainer(current.entries);
        if (Array.isArray(parsedEntries)
            || parsedEntries instanceof Map
            || (parsedEntries && typeof parsedEntries === 'object')) {
            const book = parsedEntries === current.entries
                ? current
                : { ...current, entries: parsedEntries };
            // Some provider wrappers expose an empty top-level `entries` field
            // while the real book lives under data/result. Keep searching until
            // a non-empty entry collection is found.
            if (entryPairs(parsedEntries).length) return book;
            emptyBook ??= book;
        }
        if (looksLikeEntryMap(current)) return { entries: current };

        for (const key of [
            'data',
            'result',
            'response',
            'payload',
            'content',
            'book',
            'worldInfo',
            'world_info',
            'lorebook',
            'character_book',
            'originalData',
            'items',
            'records',
        ]) {
            if (current[key] !== undefined) queue.push(current[key]);
        }
    }
    return emptyBook;
}

function entryPairs(rawEntries) {
    rawEntries = parseJsonContainer(rawEntries);
    if (rawEntries instanceof Map) return [...rawEntries.entries()].map(([key, value]) => [String(key), value]);
    if (Array.isArray(rawEntries)) return rawEntries.map((entry, index) => [String(index), entry]);
    if (rawEntries && typeof rawEntries === 'object') return Object.entries(rawEntries);
    return [];
}

function normalizeKeys(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
}

function disabledEntry(entry) {
    const enabled = entry?.enabled;
    const disabled = entry?.disable ?? entry?.disabled;
    return enabled === false
        || enabled === 0
        || String(enabled).toLowerCase() === 'false'
        || disabled === true
        || disabled === 1
        || String(disabled).toLowerCase() === 'true';
}

export function extractWorldBookEntries(book, sourceName, sourceKey = worldBookSourceKey(sourceName)) {
    const normalizedBook = normalizeWorldBookPayload(book);
    if (!normalizedBook) return [];
    return entryPairs(normalizedBook.entries)
        .map(([key, entry]) => [key, parseJsonContainer(entry) ?? entry])
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .map(([fallbackKey, rawEntry], index) => {
            if (typeof rawEntry !== 'object') rawEntry = { content: String(rawEntry) };
            const nested = rawEntry.data && typeof rawEntry.data === 'object' ? rawEntry.data : {};
            const entry = { ...nested, ...rawEntry };
            return {
                source: sourceName,
                sourceKey,
                entryId: createWorldEntryId(entry, fallbackKey, index),
                index,
                comment: String(entry.comment ?? entry.name ?? entry.title ?? entry.memo ?? '').trim(),
                keys: [...new Set([
                    ...normalizeKeys(entry.key),
                    ...normalizeKeys(entry.keys),
                    ...normalizeKeys(entry.keysecondary),
                    ...normalizeKeys(entry.secondary_keys),
                ].map(String).map(key => key.trim()).filter(Boolean))],
                content: entryContent(entry),
                constant: Boolean(entry.constant ?? entry.alwaysActive ?? entry.always_active),
                order: Number(entry.order ?? entry.insertion_order ?? entry.position ?? 0),
                enabled: !disabledEntry(entry),
            };
        })
        .filter(entry => entry.content);
}

export function selectedWorldEntries(entries, sourceKey, selections) {
    const config = normalizeWorldEntrySelections(selections)[sourceKey];
    if (!config || config.mode !== WORLD_ENTRY_MODE_CUSTOM) {
        return entries.filter(entry => entry.enabled !== false);
    }
    const ids = new Set(config.ids);
    return entries.filter(entry => (
        config.strategy === 'exclude'
            ? !ids.has(String(entry.entryId))
            : ids.has(String(entry.entryId))
    ));
}

export function compactWorldEntrySelection(entries, selectedIds) {
    const selected = new Set([...selectedIds].map(String));
    const allIds = entries.map(entry => String(entry.entryId));
    const defaultIds = entries
        .filter(entry => entry.enabled !== false)
        .map(entry => String(entry.entryId));
    if (selected.size === defaultIds.length && defaultIds.every(id => selected.has(id))) {
        return { mode: WORLD_ENTRY_MODE_ALL, strategy: 'include', ids: [] };
    }
    const excluded = allIds.filter(id => !selected.has(id));
    if (excluded.length < selected.size) {
        return { mode: WORLD_ENTRY_MODE_CUSTOM, strategy: 'exclude', ids: excluded };
    }
    return {
        mode: WORLD_ENTRY_MODE_CUSTOM,
        strategy: 'include',
        ids: allIds.filter(id => selected.has(id)),
    };
}
