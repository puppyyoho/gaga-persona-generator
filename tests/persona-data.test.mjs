import assert from 'node:assert/strict';
import {
    createDefaultSectionSelection,
    getSelectedSections,
    neutralizePersonaReferences,
    normalizeStructuredResult,
    parseStructuredResponse,
    renderStructuredResult,
} from '../persona-data.js';

const options = {
    gender: '女',
    species: 'human',
    speciesDetail: '',
    nameCount: 3,
    fixedName: '',
    sections: getSelectedSections(createDefaultSectionSelection()),
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
assert.equal(
    neutralizePersonaReferences('{{user}}与{{char}}', '旧U', '角色A'),
    '[[PF_NAME]]与角色A',
);

console.log('persona-data logic ok');
