import assert from 'node:assert/strict';
import {
    WORLD_ENTRY_MODE_ALL,
    WORLD_ENTRY_MODE_CUSTOM,
    compactWorldEntrySelection,
    createWorldEntryId,
    embeddedBookSourceKey,
    extractWorldBookEntries,
    normalizeWorldBookPayload,
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

const standardBook = {
    entries: {
        4: { uid: 4, key: ['学院'], comment: '学院', content: '学院正文', disable: false },
        5: { uid: 5, key: ['隐藏'], content: '禁用正文', disable: true },
    },
};
assert.equal(normalizeWorldBookPayload(standardBook), standardBook);
assert.deepEqual(extractWorldBookEntries(standardBook, '世界书'), [
    {
        source: '世界书',
        sourceKey: 'world:世界书',
        entryId: 'entry:4',
        index: 0,
        comment: '学院',
        keys: ['学院'],
        content: '学院正文',
        constant: false,
        order: 0,
        enabled: true,
    },
    {
        source: '世界书',
        sourceKey: 'world:世界书',
        entryId: 'entry:5',
        index: 1,
        comment: '',
        keys: ['隐藏'],
        content: '禁用正文',
        constant: false,
        order: 0,
        enabled: false,
    },
]);
assert.equal(
    extractWorldBookEntries({ data: { result: standardBook } }, '包装世界书').length,
    2,
);
assert.equal(
    extractWorldBookEntries(JSON.stringify({ data: standardBook }), 'JSON 世界书').length,
    2,
);
assert.deepEqual(extractWorldBookEntries({
    character_book: {
        entries: [{
            id: 9,
            keys: '人物',
            secondary_keys: ['关系'],
            title: '卡内条目',
            text: '卡内正文',
            enabled: true,
            always_active: true,
            insertion_order: 12,
        }],
    },
}, '卡内世界书', 'embedded:card'), [{
    source: '卡内世界书',
    sourceKey: 'embedded:card',
    entryId: 'entry:9',
    index: 0,
    comment: '卡内条目',
    keys: ['人物', '关系'],
    content: '卡内正文',
    constant: true,
    order: 12,
    enabled: true,
}]);

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
const mixedEntries = [
    { entryId: 'entry:on', enabled: true },
    { entryId: 'entry:off', enabled: false },
];
assert.deepEqual(selectedWorldEntries(mixedEntries, 'world:混合', {}), [mixedEntries[0]]);
assert.deepEqual(compactWorldEntrySelection(mixedEntries, new Set(['entry:on'])), {
    mode: WORLD_ENTRY_MODE_ALL,
    strategy: 'include',
    ids: [],
});
const selectDisabled = compactWorldEntrySelection(mixedEntries, new Set(['entry:on', 'entry:off']));
assert.equal(selectDisabled.mode, WORLD_ENTRY_MODE_CUSTOM);
assert.deepEqual(selectedWorldEntries(mixedEntries, 'world:混合', {
    'world:混合': selectDisabled,
}), mixedEntries);

console.log('worldbook selection logic ok');
