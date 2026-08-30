import assert from 'node:assert/strict';
import {
    buildPersonaGenerationPrompt,
    buildPersonaSystemPrompt,
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
assert.deepEqual(
    parseStructuredResponse('模型说明如下：\n{"name_candidates":[{"name":"测试",}],"profile":{"基本身份":{"年龄":30,},}}\n以上。'),
    { name_candidates: [{ name: '测试' }], profile: { 基本身份: { 年龄: 30 } } },
);
assert.deepEqual(
    parseStructuredResponse('{"profile":{"备注":"第一行\n第二行"},}'),
    { profile: { 备注: '第一行\n第二行' } },
);
assert.deepEqual(
    parseStructuredResponse('{"profile":{"备注":"他说"你好"然后继续"}}'),
    { profile: { 备注: '他说"你好"然后继续' } },
);
assert.deepEqual(
    parseStructuredResponse('{"profile":{"备注":"他说"你好"}}'),
    { profile: { 备注: '他说"你好' } },
);
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
assert.match(buildPersonaSystemPrompt(), /冰山式取舍/);
assert.match(buildPersonaSystemPrompt(), /身体、社会与心理三个维度/);
assert.match(buildPersonaSystemPrompt(), /目标、阻碍、策略、代价/);
assert.match(buildPersonaSystemPrompt(), /经历、解释、习惯、选择、后果/);
assert.match(buildPersonaSystemPrompt(), /刺激、即时反应、权衡、行动、后果/);
assert.match(buildPersonaSystemPrompt(), /令人意外的选择/);
assert.match(buildPersonaSystemPrompt(), /持续变化的地位协商/);
assert.match(buildPersonaSystemPrompt(), /保留发展接口/);
assert.match(buildPersonaSystemPrompt(), /绝对禁止使用“不是……而是……”/);
assert.match(buildPersonaSystemPrompt(), /绝对禁止使用破折号/);
assert.match(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /不得使用先否定后肯定的对照句式/);

console.log('persona-data logic ok');
