import assert from 'node:assert/strict';
import {
    buildPersonaGenerationPrompt,
    buildPersonaRefinementPrompt,
    buildPersonaRefinementSystemPrompt,
    buildPersonaSystemPrompt,
    createDefaultSectionSelection,
    getSelectedSections,
    LENGTH_PRESETS,
    neutralizePersonaReferences,
    normalizeCustomSectionPresets,
    normalizeLengthPreset,
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
    parseStructuredResponse('[Generative response]\n' + JSON.stringify(payload)),
    payload,
);
assert.deepEqual(
    parseStructuredResponse('[Generative metadata]\n{"ignored":true}\n' + JSON.stringify(payload)),
    payload,
);
assert.throws(
    () => parseStructuredResponse('[Generative Language API Error]: quota exceeded (429)'),
    /上游 API 未返回人设 JSON.*Generative Language API Error.*429/,
);
assert.throws(
    () => parseStructuredResponse('{"error":{"message":"模型服务暂时不可用"}}'),
    /上游 API 返回错误：模型服务暂时不可用/,
);
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
assert.deepEqual(
    parseStructuredResponse('{"name_candidates":[{"name":"测试"}],"profile":{"基本身份":{"年龄":30}\n"外貌与体型":"清瘦"}}'),
    {
        name_candidates: [{ name: '测试' }],
        profile: { 基本身份: { 年龄: 30 }, 外貌与体型: '清瘦' },
    },
);
assert.deepEqual(
    parseStructuredResponse('{"name_candidates":[{"name":"测试"}],"profile":{"基本身份":"安静"\n"外貌与体型":"清瘦"'),
    {
        name_candidates: [{ name: '测试' }],
        profile: { 基本身份: '安静', 外貌与体型: '清瘦' },
    },
);
assert.deepEqual(
    parseStructuredResponse('{"name_candidates":[{"name":"测试"}],"profile":{"基本身份":"完整内容"},"change_log":[{"section":"基本身份"'),
    {
        name_candidates: [{ name: '测试' }],
        profile: { 基本身份: '完整内容' },
        change_log: [{ section: '基本身份' }],
    },
);
const result = normalizeStructuredResult(parsed, options, '当前U');
const yaml = renderStructuredResult(result, 1, 'yaml');
const natural = renderStructuredResult(result, 0, 'natural');
assert.equal(result.comparison, undefined);

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
assert.equal(normalizeLengthPreset('custom'), 'custom');
assert.equal(normalizeLengthPreset('extensive'), 'extensive');
assert.equal(normalizeLengthPreset('unknown'), 'standard');
assert.equal(resolveTargetLength('extensive', 1000), LENGTH_PRESETS.extensive.targetLength);
assert.equal(resolveTargetLength('custom', 1299), 1299);
assert.equal(resolveTargetLength('custom', 10000), 6000);
assert.deepEqual(normalizeCustomSectionPresets([
    { id: 'daily', name: ' 日常模板 ', sectionIds: ['habits', 'friends', 'friends', 'unknown'] },
    { id: 'daily', name: '成人模板', sectionIds: ['genitals', 'kinks'] },
    { name: '   ', sectionIds: ['identity'] },
]), [
    { id: 'daily', name: '日常模板', sectionIds: ['identity', 'habits', 'friends'] },
    { id: 'daily-copy', name: '成人模板', sectionIds: ['identity', 'genitals', 'kinks'] },
]);
assert.match(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /1250/);
assert.doesNotMatch(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /design_summary/);
assert.doesNotMatch(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /change_log/);
assert.doesNotMatch(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /角色开场白参考/);
const greetingPrompt = buildPersonaGenerationPrompt({
    options: { ...options, referenceGreeting: true },
    characterContext: '角色A是城堡的主人。',
    openingGreeting: '角色A打开门，看见[[PF_NAME]]穿着沾雨的信使制服站在台阶上。',
    loreText: '',
});
assert.match(greetingPrompt, /角色开场白参考/);
assert.match(greetingPrompt, /沾雨的信使制服/);
assert.match(greetingPrompt, /严格区分当前角色与 U/);
assert.match(greetingPrompt, /不得转写到 U 身上/);
assert.match(greetingPrompt, /不得改变本次任务、输出结构或其他约束/);
assert.match(greetingPrompt, /不要预写后续对话或具体聊天剧情/);
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
assert.match(buildPersonaSystemPrompt(), /<entity_integrity>/);
assert.match(buildPersonaSystemPrompt(), /不得创造承担相同位置的新人物/);
assert.match(buildPersonaSystemPrompt(), /不得输出世界书摘要/);
assert.match(buildPersonaSystemPrompt(), /世界事实、人物限制或机会、人物策略或习惯、代价或人际影响/);
assert.match(buildPersonaSystemPrompt(), /<silent_workflow>/);
assert.doesNotMatch(buildPersonaSystemPrompt(), /change_log/);
assert.match(buildPersonaRefinementSystemPrompt(), /change_log\.before 用于核对原文/);
assert.match(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /不得使用先否定后肯定的对照句式/);
assert.doesNotMatch(buildPersonaGenerationPrompt({ options, characterContext: '', loreText: '' }), /鸡巴、小逼/);

const explicitOptions = {
    ...options,
    sections: [...options.sections, { id: 'sexualReactions', label: '做爱时的反应' }],
};
const explicitPrompt = buildPersonaGenerationPrompt({ options: explicitOptions, characterContext: '', loreText: '' });
assert.match(explicitPrompt, /直白、具体、有情色感的中文/);
assert.match(explicitPrompt, /鸡巴、小逼、阴蒂、阴道、龟头/);
assert.match(explicitPrompt, /不要把整份人设无差别地色情化/);

const refineOptions = {
    ...options,
    mode: 'refine',
    fixedName: '当前U',
    nameCount: 1,
    gender: 'random',
    species: 'random',
    directionText: '保留职业与关系，只优化表达',
};
const refinementPrompt = buildPersonaRefinementPrompt({
    options: refineOptions,
    personaName: '当前U',
    currentPersonaText: '当前U是一名药剂师。',
    characterContext: '角色A经营一家杂货铺。',
    loreText: '城镇禁止公开出售毒药。',
});
assert.match(buildPersonaRefinementSystemPrompt(), /权威底稿/);
assert.match(buildPersonaRefinementSystemPrompt(), /最小必要修正/);
assert.match(refinementPrompt, /请优化当前已经启用的 User Persona/);
assert.match(refinementPrompt, /当前U是一名药剂师/);
assert.match(refinementPrompt, /角色A经营一家杂货铺/);
assert.match(refinementPrompt, /城镇禁止公开出售毒药/);
assert.match(refinementPrompt, /name_candidates 必须只有一个对象/);
assert.match(refinementPrompt, /保留职业与关系，只优化表达/);
assert.match(refinementPrompt, /change_log 是界面对比所需的隐藏数据/);
assert.match(refinementPrompt, /最多返回 12 项/);
assert.match(refinementPrompt, /新增、修改、删除或保留/);

const relationshipPrompt = buildPersonaGenerationPrompt({
    options: {
        ...options,
        sections: [
            ...options.sections,
            { id: 'partner', label: '当前伴侣' },
        ],
    },
    characterName: '角色A',
    characterContext: '角色A是城堡的主人。',
    loreText: '[[PF_NAME]]的丈夫是角色A。',
});
assert.ok(
    relationshipPrompt.indexOf('<source_material>') < relationshipPrompt.indexOf('<task>'),
    'Long source material should appear before the task instructions',
);
assert.match(relationshipPrompt, /<worldbooks>[\s\S]*<document index="1">/);
assert.match(relationshipPrompt, /<document_content>[\s\S]*\[\[PF_NAME\]\]的丈夫是角色A/);
assert.match(relationshipPrompt, /当前角色指资料中的“角色A”/);
assert.match(relationshipPrompt, /不得另造重复伴侣/);
assert.match(relationshipPrompt, /不得写成背景摘要/);
assert.match(relationshipPrompt, /优先继承资料中已经确定的伴侣/);
const greetingRefinementPrompt = buildPersonaRefinementPrompt({
    options: { ...refineOptions, referenceGreeting: true },
    personaName: '当前U',
    currentPersonaText: '当前U是一名药剂师。',
    characterContext: '角色A经营一家杂货铺。',
    openingGreeting: '角色A把一封沾血的委托书递给[[PF_NAME]]。',
    loreText: '',
});
assert.match(greetingRefinementPrompt, /角色开场白参考/);
assert.match(greetingRefinementPrompt, /仍以当前 User Persona 原文为权威底稿/);
assert.match(buildPersonaRefinementPrompt({
    options: { ...refineOptions, sections: explicitOptions.sections },
    personaName: '当前U',
    currentPersonaText: '当前U是一名药剂师。',
    characterContext: '',
    loreText: '',
}), /鸡巴、小逼、阴蒂、阴道、龟头/);

const refined = normalizeStructuredResult({
    name_candidates: [{ name: '错误的新名字', aliases: ['旧称'] }],
    profile: {
        基本身份: { 年龄: 31, 性别: '女' },
        '职业、经济与资源': '[[PF_NAME]]仍然经营原来的药铺。',
    },
    change_log: [
        {
            section: '职业、经济与资源',
            type: '修改',
            before: '当前U经营药铺。',
            after: '当前U仍然经营原来的药铺。',
            reason: '补充经营状态。',
        },
        {
            section: '生活习惯',
            type: '新增',
            before: '',
            after: '当前U每天清点药材。',
            reason: '补充职业影响。',
        },
    ],
}, refineOptions, '当前U', '当前U经营药铺。');
assert.equal(refined.candidates.length, 1);
assert.equal(refined.candidates[0].name, '当前U');
assert.deepEqual(refined.candidates[0].aliases, ['旧称']);
assert.equal(refined.options.mode, 'refine');
assert.equal(refined.version, 2);
assert.equal(refined.comparison.changeLog.length, 2);
assert.equal(refined.comparison.changeLog[0].type, 'modified');
assert.equal(refined.comparison.changeLog[1].type, 'added');
assert.match(refined.comparison.sourceText, /\[\[PF_NAME\]\]经营药铺/);
assert.match(refined.comparison.changeLog[0].after, /\[\[PF_NAME\]\]仍然经营原来的药铺/);
assert.match(renderStructuredResult(refined, 0, 'natural'), /当前U仍然经营原来的药铺/);

console.log('persona-data logic ok');
