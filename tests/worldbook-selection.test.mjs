import assert from 'node:assert/strict';
import {
    WORLD_ENTRY_MODE_ALL,
    WORLD_ENTRY_MODE_CUSTOM,
    compactWorldEntrySelection,
    createWorldEntryId,
    embeddedBookSourceKey,
    normalizeWorldEntrySelections,
    selectedWorldEntries,
    worldBookSourceKey,
} from '../worldbook-selection.js';

assert.deepEqual(normalizeWorldEntrySelections(null), {});
assert.deepEqual(normalizeWorldEntrySelections({
    'world:学院': { mode: 'custom', ids: ['entry:1', 'entry:1', '', 2] },
    'world:城市': { mode: 'unknown', ids: 'bad' },
    empty: null,
}), {
    'world:学院': { mode: WORLD_ENTRY_MODE_CUSTOM, strategy: 'include', ids: ['entry:1', '2'] },
    'world:城市': { mode: WORLD_ENTRY_MODE_ALL, strategy: 'include', ids: [] },
});

assert.equal(worldBookSourceKey('学院'), 'world:学院');
assert.equal(embeddedBookSourceKey('card.png'), 'embedded:card.png');
assert.equal(createWorldEntryId({ uid: 42 }, '5', 5), 'entry:42');
assert.equal(createWorldEntryId({}, '5', 5), 'entry:5');

const entries = [
    { entryId: 'entry:1', content: '一' },
    { entryId: 'entry:2', content: '二' },
];
assert.deepEqual(selectedWorldEntries(entries, 'world:学院', {}), entries);
assert.deepEqual(selectedWorldEntries(entries, 'world:学院', {
    'world:学院': { mode: WORLD_ENTRY_MODE_CUSTOM, ids: ['entry:2'] },
}), [entries[1]]);
assert.deepEqual(selectedWorldEntries(entries, 'world:学院', {
    'world:学院': { mode: WORLD_ENTRY_MODE_CUSTOM, strategy: 'exclude', ids: ['entry:1'] },
}), [entries[1]]);
assert.deepEqual(compactWorldEntrySelection(entries, new Set(['entry:2'])), {
    mode: WORLD_ENTRY_MODE_CUSTOM,
    strategy: 'include',
    ids: ['entry:2'],
});
assert.deepEqual(compactWorldEntrySelection(entries, new Set(entries.map(entry => entry.entryId))), {
    mode: WORLD_ENTRY_MODE_ALL,
    strategy: 'include',
    ids: [],
});
const manyEntries = [1, 2, 3, 4].map(id => ({ entryId: `entry:${id}` }));
assert.deepEqual(compactWorldEntrySelection(manyEntries, new Set(['entry:1', 'entry:2', 'entry:3'])), {
    mode: WORLD_ENTRY_MODE_CUSTOM,
    strategy: 'exclude',
    ids: ['entry:4'],
});

console.log('worldbook selection logic ok');
