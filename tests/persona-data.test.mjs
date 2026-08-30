import assert from 'node:assert/strict';
import {
    buildPersonaGenerationPrompt,
    createDefaultSectionSelection,
    getSelectedSections,
    LENGTH_PRESETS,
    neutralizePersonaReferences,
    normalizeStructuredResult,
    parseStructuredResponse,
    renderStructuredResult,
    resolveTargetLength,
} from '../persona-data.js';

const options = {
    gender: '女',
    species: 'human',
    speciesDetail: '',
    nameCount: 3,
    lengthPreset: 'custom',
    targetLength: 1250,
    fixedName: '',
    style: 'balanced',
    sections: getSelectedSections(createDefaultSectionSelection()),
    directionText: 'test generation',
};

const payload = {
    name_candidates: [
        { name: '当前U', aliases: [] },
        { name: '林知夏', aliases: ['知夏'] },
        { name: '沈遥', aliases: [] },
    ],
    profile: {
        基本身份: {
            姓名: '林知夏',
            年龄: 31,
            性别: '男',
        },
        外貌与体型: '林知夏身形修长',
    },
};

const fenced = String.fromCharCode(96).repeat(3) + 'json\n' + JSON.stringify(payload) + '\n' + String.fromCharCode(96).repeat(3);
const parsed = parseStructuredResponse(fenced);
const result = normalizeStructuredResult(parsed, options, '当前U');
const yaml = renderStructuredResult(result, 1, 'yaml');
const natural = renderStructuredResult(result, 0, 'natural');

assert.match(yaml, /姓名: "沈遥"/);
assert.match(yaml, /性别: "女"/);
assert.doesNotMatch(yaml, /林知夏/);
assert.doesNotMatch(yaml, /当前U/);
assert.match(natural, /【基本身份】/);
assert.match(natural, /林知夏/);
assert.doesNotMatch(natural, /设定摘要/);
assert.equal(
    neutralizePersonaReferences('{{user}}与{{char}}', '旧U', '角色A'),
    '[[PF_NAME]]与角色A',
);

assert.equal(LENGTH_PRESETS.standard.targetLength, 1000);
assert.equal(resolveTargetLength('extensive', 1000), LENGTH_PRESETS.extensive.targetLength);
assert.equal(resolveTargetLength('custom', 1299), 1299);
assert.equal(resolveTargetLength('custom', 10000), 6000);
assert.match(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /1250/);
assert.doesNotMatch(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /design_summary/);

console.log('persona-data logic ok');
