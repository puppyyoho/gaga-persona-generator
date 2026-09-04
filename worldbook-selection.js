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

export function selectedWorldEntries(entries, sourceKey, selections) {
    const config = normalizeWorldEntrySelections(selections)[sourceKey];
    if (!config || config.mode !== WORLD_ENTRY_MODE_CUSTOM) return [...entries];
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
    if (selected.size >= allIds.length) {
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
