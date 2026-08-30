import {
    LENGTH_PRESETS,
    SECTION_GROUPS,
    SECTION_PRESETS,
    buildNameRerollPrompt,
    buildPersonaGenerationPrompt,
    buildPersonaSystemPrompt,
    createDefaultSectionSelection,
    getSelectedSections,
    neutralizePersonaReferences,
    normalizeNameCandidates,
    normalizeStructuredResult,
    parseStructuredResponse,
    resolveTargetLength,
    renderStructuredResult,
} from './persona-data.js';

const EXTENSION_NAME = 'persona-forge';
const DISPLAY_NAME = '嘎嘎人设生成器';
const SETTINGS_KEY = 'personaForge';
const VERSION = '0.2.2';
const MAX_LORE_CHARS_DEFAULT = 52000;

const state = {
    overlay: null,
    panel: null,
    settingsPanel: null,
    worldInfoRuntime: null,
    allWorldNames: [],
    activeWorldNames: [],
    personaWorldNames: [],
    selectedWorldNames: new Set(),
    embeddedBook: null,
    lastContextSignature: '',
    generating: false,
    generationEpoch: 0,
    structuredResult: null,
    selectedCandidateIndex: 0,
};

function getContext() {
    const st = globalThis.SillyTavern;
    if (!st?.getContext) {
        throw new Error('未检测到 SillyTavern.getContext()。请确认 SillyTavern 版本不低于 1.18.0。');
    }
    return st.getContext();
}

function notify(type, message) {
    const toast = globalThis.toastr;
    if (toast?.[type]) {
        toast[type](message, DISPLAY_NAME);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(String);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
}

function unique(values) {
    return [...new Set(values.filter(Boolean).map(v => String(v).trim()).filter(Boolean))];
}

function getCurrentCharacter(ctx = getContext()) {
    const id = Number(ctx.characterId);
    if (!Number.isInteger(id) || id < 0 || !ctx.characters?.[id]) return null;
    return ctx.characters[id];
}

function characterData(character) {
    return character?.data ?? character ?? {};
}

function getField(character, ...names) {
    const data = characterData(character);
    for (const name of names) {
        const value = data?.[name] ?? character?.[name];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function getCharacterName(character) {
    return getField(character, 'name') || '未选择角色';
}

function getCharacterPrimaryWorld(character) {
    const data = characterData(character);
    return data?.extensions?.world || character?.extensions?.world || '';
}

function getEmbeddedCharacterBook(character) {
    const data = characterData(character);
    const book = data?.character_book || character?.character_book;
    if (!book || typeof book !== 'object') return null;
    return book;
}

async function getWorldInfoRuntime() {
    if (state.worldInfoRuntime) return state.worldInfoRuntime;
    try {
        // This tiny compatibility import is used only to identify SillyTavern's currently selected
        // global books and additional character lorebooks. Lorebook loading itself uses getContext().loadWorldInfo().
        state.worldInfoRuntime = await import('../../../world-info.js');
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not import world-info runtime. Falling back to context-only detection.`, error);
        state.worldInfoRuntime = {};
    }
    return state.worldInfoRuntime;
}

function resolveCharacterLoreMatches(character, charLore) {
    if (!Array.isArray(charLore) || !character) return [];
    const data = characterData(character);
    const aliases = unique([
        character.avatar,
        data.avatar,
        character.name,
        data.name,
        character.filename,
        data.filename,
    ]);

    const matched = [];
    for (const binding of charLore) {
        if (!binding || typeof binding !== 'object') continue;
        const bindingName = String(binding.name ?? '').trim();
        if (!bindingName) continue;
        const isMatch = aliases.some(alias => alias === bindingName || alias.replace(/\.png$/i, '') === bindingName.replace(/\.png$/i, ''));
        if (isMatch) matched.push(...normalizeArray(binding.extraBooks));
    }
    return matched;
}

async function detectWorldBooks() {
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);
    const runtime = await getWorldInfoRuntime();

    const allWorldNames = typeof ctx.getWorldInfoNames === 'function'
        ? normalizeArray(ctx.getWorldInfoNames())
        : normalizeArray(runtime.world_names);

    const active = [];

    // 1) Global World Info selected in SillyTavern.
    active.push(...normalizeArray(runtime.selected_world_info));
    active.push(...normalizeArray(runtime.world_info?.globalSelect));

    // 2) Character primary lorebook.
    active.push(getCharacterPrimaryWorld(character));

    // 3) Character additional lorebooks.
    active.push(...resolveCharacterLoreMatches(character, runtime.world_info?.charLore));

    // 4) Current chat lorebook.
    active.push(...normalizeArray(ctx.chatMetadata?.world_info));

    // Current Persona lorebooks are detected but intentionally not selected by default.
    // This prevents the active User identity from contaminating a newly generated Persona.
    const personaWorlds = normalizeArray(ctx.powerUserSettings?.persona_description_lorebook);

    state.allWorldNames = unique(allWorldNames);
    state.activeWorldNames = unique(active).filter(name => state.allWorldNames.length === 0 || state.allWorldNames.includes(name));
    state.personaWorldNames = unique(personaWorlds).filter(name => state.allWorldNames.length === 0 || state.allWorldNames.includes(name));
    state.embeddedBook = getEmbeddedCharacterBook(character);

    // On first context load, default to active books. Preserve manual user selection afterward.
    const signature = JSON.stringify({
        character: getCharacterName(character),
        active: state.activeWorldNames,
        persona: state.personaWorldNames,
        all: state.allWorldNames,
        embedded: Boolean(state.embeddedBook),
    });

    if (signature !== state.lastContextSignature) {
        state.selectedWorldNames = new Set(state.activeWorldNames);
        state.lastContextSignature = signature;
    }

    return {
        all: state.allWorldNames,
        active: state.activeWorldNames,
        persona: state.personaWorldNames,
        embedded: state.embeddedBook,
    };
}

function ensureSettings() {
    const ctx = getContext();
    const root = ctx.extensionSettings;
    const defaults = {
        showFloatingButton: true,
        maxLoreChars: MAX_LORE_CHARS_DEFAULT,
        lastResult: '',
        lastStructuredResult: null,
        lastMode: 'random',
        lastStyle: 'balanced',
        lastOutputFormat: 'natural',
        lastSelectedCandidateIndex: 0,
        gender: 'random',
        species: 'random',
        speciesDetail: '',
        nameCount: 5,
        lengthPreset: 'standard',
        targetLength: LENGTH_PRESETS.standard.targetLength,
        sectionSelection: createDefaultSectionSelection(),
    };
    const current = root[SETTINGS_KEY] && typeof root[SETTINGS_KEY] === 'object'
        ? root[SETTINGS_KEY]
        : {};
    const mergedSections = {
        ...defaults.sectionSelection,
        ...(current.sectionSelection && typeof current.sectionSelection === 'object' ? current.sectionSelection : {}),
        identity: true,
    };
    const migrated = {
        ...defaults,
        ...current,
        sectionSelection: mergedSections,
    };
    const changed = JSON.stringify(current) !== JSON.stringify(migrated);
    root[SETTINGS_KEY] = migrated;
    if (changed) {
        ctx.saveSettingsDebounced?.();
    }
    return root[SETTINGS_KEY];
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

function escapeAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function createStaticUi() {
    if (document.getElementById('pf-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'pf-overlay';
    overlay.className = 'pf-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <section class="pf-modal" role="dialog" aria-modal="true" aria-labelledby="pf-title">
            <header class="pf-header">
                <div class="pf-heading-wrap">
                    <div class="pf-kicker">${DISPLAY_NAME} <span class="pf-version">v${VERSION}</span></div>
                    <h2 id="pf-title">世界观适配 User 人设生成器</h2>
                    <div class="pf-context-line" id="pf-context-line">正在读取当前角色与世界书…</div>
                </div>
                <button class="pf-icon-button" id="pf-close" type="button" aria-label="关闭">✕</button>
            </header>

            <div class="pf-scroll">
                <section class="pf-card pf-status-card">
                    <div class="pf-status-grid">
                        <div>
                            <span class="pf-label-mini">当前角色</span>
                            <strong id="pf-character-name">—</strong>
                        </div>
                        <div>
                            <span class="pf-label-mini">生成模型</span>
                            <strong>跟随 SillyTavern 当前连接</strong>
                        </div>
                    </div>
                    <div class="pf-book-summary">
                        <span class="pf-label-mini">自动识别到的世界书</span>
                        <div class="pf-chip-wrap" id="pf-active-book-chips"></div>
                    </div>
                </section>

                <section class="pf-card">
                    <div class="pf-section-head">
                        <div>
                            <h3>生成方式</h3>
                            <p>随机生成会主动补全身份；定向生成会优先服从你给出的条件。</p>
                        </div>
                    </div>
                    <div class="pf-segmented" role="radiogroup" aria-label="生成方式">
                        <button type="button" class="pf-segment is-active" data-mode="random" role="radio" aria-checked="true">🎲 随机生成</button>
                        <button type="button" class="pf-segment" data-mode="directed" role="radio" aria-checked="false">🎯 定向生成</button>
                    </div>

                    <div class="pf-grid pf-grid-3 pf-top-gap">
                        <label class="pf-field">
                            <span>生成倾向</span>
                            <select id="pf-style">
                                <option value="balanced">均衡适配</option>
                                <option value="world-first">世界观优先</option>
                                <option value="dramatic">高剧情潜力</option>
                                <option value="rare">小概率但合理</option>
                            </select>
                        </label>
                        <label class="pf-field">
                            <span>性别</span>
                            <select id="pf-gender">
                                <option value="random">随机</option>
                                <option value="男">男</option>
                                <option value="女">女</option>
                                <option value="双性">双性</option>
                            </select>
                        </label>
                        <label class="pf-field">
                            <span>种族</span>
                            <select id="pf-species">
                                <option value="random">随机</option>
                                <option value="human">人类</option>
                                <option value="nonhuman">人外</option>
                            </select>
                        </label>
                    </div>

                    <div class="pf-grid pf-grid-3">
                        <label class="pf-field" id="pf-species-detail-field" hidden>
                            <span>具体种族 <small>留空则跟随世界观</small></span>
                            <input id="pf-species-detail" type="text" autocomplete="off" placeholder="例如：狐族兽人、吸血鬼、机器人">
                        </label>
                        <label class="pf-field">
                            <span>候选姓名数量</span>
                            <select id="pf-name-count">
                                <option value="3">3 个</option>
                                <option value="5">5 个</option>
                                <option value="7">7 个</option>
                            </select>
                        </label>
                        <label class="pf-field">
                            <span>人设长度</span>
                            <select id="pf-length-preset">
                                <option value="concise">精简（约 600 字）</option>
                                <option value="standard">标准（约 1000 字）</option>
                                <option value="detailed">详细（约 1800 字）</option>
                                <option value="extensive">超详细（约 2800 字）</option>
                                <option value="custom">自定义字数</option>
                            </select>
                        </label>
                        <label class="pf-field" id="pf-target-length-field" hidden>
                            <span>目标字数 <small>允许上下浮动约 20%</small></span>
                            <input id="pf-target-length" type="number" min="300" max="6000" step="100" inputmode="numeric" value="1000">
                        </label>
                        <label class="pf-field pf-field-wide">
                            <span>附加要求 <small>随机模式也可填写</small></span>
                            <input id="pf-extra-short" type="text" autocomplete="off" placeholder="例如：不要贵族、偏日常、年龄30岁左右">
                        </label>
                    </div>
                    <button type="button" class="pf-content-jump" id="pf-jump-content">↓ 选择生成内容（可勾选）</button>

                    <div id="pf-directed-fields" class="pf-directed-fields" hidden>
                        <div class="pf-grid pf-grid-2">
                            <label class="pf-field">
                                <span>指定姓名 <small>填写后不生成候选名</small></span>
                                <input id="pf-name" type="text" autocomplete="off" placeholder="留空则生成多个候选姓名">
                            </label>
                            <label class="pf-field">
                                <span>关键词</span>
                                <input id="pf-keywords" type="text" autocomplete="off" placeholder="如：植物学教授，漂亮，聪明，有点娇气">
                            </label>
                        </div>
                        <label class="pf-field">
                            <span>锁定条件 <small>模型不得自行修改</small></span>
                            <textarea id="pf-hard" rows="3" placeholder="例如：31岁；与{{char}}是前妻；职业必须是大学教师"></textarea>
                        </label>
                        <label class="pf-field">
                            <span>补充说明</span>
                            <textarea id="pf-extra" rows="3" placeholder="想要怎样的家庭背景、关系张力、生活习惯等，都可以写在这里"></textarea>
                        </label>
                    </div>
                </section>

                <section class="pf-card pf-content-card" id="pf-content-details">
                    <div class="pf-section-head pf-content-head">
                        <div>
                            <h3>生成内容（可勾选）</h3>
                            <p>下面的栏目会直接决定人设里生成哪些内容；不需要的项目可以取消勾选。</p>
                        </div>
                        <small id="pf-section-count">0 项已选</small>
                    </div>
                    <div class="pf-detail-body">
                        <div class="pf-preset-toolbar" aria-label="内容预设">
                            <button class="pf-mini-button" type="button" data-preset="compact">精简</button>
                            <button class="pf-mini-button is-active" type="button" data-preset="standard">标准</button>
                            <button class="pf-mini-button" type="button" data-preset="story">剧情丰富</button>
                            <button class="pf-mini-button" type="button" data-preset="custom">自定义</button>
                        </div>
                        <div id="pf-section-groups" class="pf-section-groups"></div>
                    </div>
                </section>

                <details class="pf-card pf-details" id="pf-book-details">
                    <summary>
                        <span>世界书范围</span>
                        <small id="pf-book-count">0 个已选</small>
                    </summary>
                    <div class="pf-detail-body">
                        <p class="pf-muted">默认勾选当前真正启用或绑定的世界书。也可以手动补选其他世界书，生成时不会读取当前聊天正文。</p>
                        <div class="pf-book-toolbar">
                            <button class="pf-mini-button" type="button" id="pf-select-active">只选当前启用</button>
                            <button class="pf-mini-button" type="button" id="pf-select-all">全选</button>
                            <button class="pf-mini-button" type="button" id="pf-select-none">清空</button>
                            <button class="pf-mini-button" type="button" id="pf-refresh">刷新识别</button>
                        </div>
                        <div id="pf-book-list" class="pf-book-list"></div>
                        <div class="pf-inline-note" id="pf-embedded-note" hidden>✓ 当前角色卡还包含内嵌 Character Book，将自动读取。</div>
                        <div class="pf-inline-note" id="pf-persona-book-note" hidden>检测到当前 Persona 绑定的世界书，默认不勾选，避免沿用当前 User 身份。</div>
                    </div>
                </details>

                <section class="pf-card pf-result-card" id="pf-result-card">
                    <div class="pf-section-head pf-result-head">
                        <div>
                            <h3>生成结果</h3>
                            <p id="pf-result-meta">生成完成后可直接一键复制。</p>
                        </div>
                        <button type="button" class="pf-copy-button" id="pf-copy" disabled>⧉ 一键复制</button>
                    </div>
                    <div class="pf-candidate-panel" id="pf-candidate-panel" hidden>
                        <div class="pf-candidate-head">
                            <span class="pf-label-mini">候选姓名</span>
                            <button class="pf-mini-button" type="button" id="pf-reroll-names">换一批名字</button>
                        </div>
                        <div class="pf-name-candidates" id="pf-name-candidates"></div>
                    </div>
                    <div class="pf-output-toolbar" id="pf-output-toolbar">
                        <span class="pf-label-mini">输出格式</span>
                        <div class="pf-format-toggle" role="radiogroup" aria-label="输出格式">
                            <button type="button" class="pf-format-button" data-format="yaml" role="radio" aria-checked="false">YAML</button>
                            <button type="button" class="pf-format-button is-active" data-format="natural" role="radio" aria-checked="true">自然语言</button>
                        </div>
                    </div>
                    <div class="pf-empty" id="pf-empty">还没有生成内容。</div>
                    <pre class="pf-result" id="pf-result" tabindex="0" hidden></pre>
                </section>
            </div>

            <footer class="pf-footer">
                <button class="pf-secondary-button" type="button" id="pf-regenerate" disabled>↻ 再生成一次</button>
                <button class="pf-secondary-button pf-cancel-button" type="button" id="pf-cancel" hidden>停止生成</button>
                <button class="pf-primary-button" type="button" id="pf-generate">✨ 生成人设</button>
            </footer>
        </section>
    `;

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.panel = overlay.querySelector('.pf-modal');

    renderSectionOptions();
    bindUiEvents();
}

function createSettingsUi() {
    if (document.getElementById('pf-settings')) return;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return;

    const settings = ensureSettings();
    const block = document.createElement('div');
    block.id = 'pf-settings';
    block.className = 'extension_container pf-settings';
    block.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${DISPLAY_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>读取当前角色与世界书，调用当前 SillyTavern 模型生成适配世界观的 User Persona。</p>
                <button type="button" class="menu_button" id="pf-open-settings">打开${DISPLAY_NAME}</button>
                <label class="checkbox_label pf-settings-check">
                    <input id="pf-show-fab" type="checkbox" ${settings.showFloatingButton ? 'checked' : ''}>
                    <span>显示移动端友好的悬浮入口</span>
                </label>
            </div>
        </div>
    `;
    container.appendChild(block);
    state.settingsPanel = block;

    block.querySelector('#pf-open-settings')?.addEventListener('click', openPanel);
    block.querySelector('#pf-show-fab')?.addEventListener('change', event => {
        settings.showFloatingButton = Boolean(event.target.checked);
        saveSettings();
        updateFloatingButton();
    });
}

function updateFloatingButton() {
    const settings = ensureSettings();
    let button = document.getElementById('pf-fab');
    if (!settings.showFloatingButton) {
        button?.remove();
        return;
    }

    if (!button) {
        button = document.createElement('button');
        button.id = 'pf-fab';
        button.className = 'pf-fab';
        button.type = 'button';
        button.title = `打开${DISPLAY_NAME}`;
        button.setAttribute('aria-label', `打开${DISPLAY_NAME}`);
        button.innerHTML = '<span aria-hidden="true">✨</span><span class="pf-fab-text">嘎嘎</span>';
        button.addEventListener('click', openPanel);
        document.body.appendChild(button);
    }
}

function renderSectionOptions() {
    const root = state.overlay;
    const container = root?.querySelector('#pf-section-groups');
    if (!container) return;
    const settings = ensureSettings();
    container.replaceChildren();

    for (const group of SECTION_GROUPS) {
        const section = document.createElement('section');
        section.className = 'pf-option-group';

        const title = document.createElement('h4');
        title.textContent = group.label;
        section.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'pf-option-grid';

        for (const option of group.sections) {
            const label = document.createElement('label');
            label.className = 'pf-option-item';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.sectionId = option.id;
            input.checked = option.required || Boolean(settings.sectionSelection[option.id]);
            input.disabled = Boolean(option.required);

            const text = document.createElement('span');
            text.textContent = option.label;
            label.append(input, text);
            grid.appendChild(label);

            input.addEventListener('change', () => {
                settings.sectionSelection[option.id] = input.checked;
                markPreset('custom');
                updateSectionCount();
                saveSettings();
            });
        }

        section.appendChild(grid);
        container.appendChild(section);
    }

    updateSectionCount();
    detectAndMarkPreset();
}

function getCurrentSectionSelection() {
    const settings = ensureSettings();
    const selection = { ...settings.sectionSelection, identity: true };
    state.overlay?.querySelectorAll('[data-section-id]').forEach(input => {
        selection[input.dataset.sectionId] = input.checked;
    });
    return selection;
}

function updateSectionCount() {
    const count = getSelectedSections(getCurrentSectionSelection()).length;
    const target = state.overlay?.querySelector('#pf-section-count');
    if (target) target.textContent = count + ' 项已选';
}

function markPreset(preset) {
    state.overlay?.querySelectorAll('[data-preset]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.preset === preset);
    });
}

function detectAndMarkPreset() {
    const selection = getCurrentSectionSelection();
    const activeIds = Object.entries(selection).filter(([, active]) => active).map(([id]) => id).sort();
    for (const [preset, ids] of Object.entries(SECTION_PRESETS)) {
        const sorted = [...ids].sort();
        if (JSON.stringify(activeIds) === JSON.stringify(sorted)) {
            markPreset(preset);
            return;
        }
    }
    markPreset('custom');
}

function applySectionPreset(preset) {
    if (preset === 'custom') {
        markPreset('custom');
        return;
    }
    const ids = new Set(SECTION_PRESETS[preset] || SECTION_PRESETS.standard);
    const settings = ensureSettings();
    state.overlay?.querySelectorAll('[data-section-id]').forEach(input => {
        const checked = input.disabled || ids.has(input.dataset.sectionId);
        input.checked = checked;
        settings.sectionSelection[input.dataset.sectionId] = checked;
    });
    settings.sectionSelection.identity = true;
    markPreset(preset);
    updateSectionCount();
    saveSettings();
}

function updateSpeciesDetailVisibility() {
    const root = state.overlay;
    const species = root?.querySelector('#pf-species')?.value;
    const field = root?.querySelector('#pf-species-detail-field');
    if (field) field.hidden = species !== 'nonhuman';
}

function updateLengthVisibility() {
    const root = state.overlay;
    const preset = root?.querySelector('#pf-length-preset')?.value || 'standard';
    const field = root?.querySelector('#pf-target-length-field');
    if (field) field.hidden = preset !== 'custom';
}

function setOutputFormat(format, persist = true) {
    const valid = format === 'yaml' ? 'yaml' : 'natural';
    state.overlay?.querySelectorAll('[data-format]').forEach(button => {
        const active = button.dataset.format === valid;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
    if (persist) {
        ensureSettings().lastOutputFormat = valid;
        saveSettings();
    }
    renderCurrentResult();
}

function syncControlsFromSettings() {
    const root = state.overlay;
    const settings = ensureSettings();
    const values = {
        '#pf-style': settings.lastStyle || 'balanced',
        '#pf-gender': settings.gender || 'random',
        '#pf-species': settings.species || 'random',
        '#pf-species-detail': settings.speciesDetail || '',
        '#pf-name-count': String(settings.nameCount || 5),
        '#pf-length-preset': settings.lengthPreset || 'standard',
        '#pf-target-length': String(settings.targetLength || LENGTH_PRESETS.standard.targetLength),
    };
    for (const [selector, value] of Object.entries(values)) {
        const input = root?.querySelector(selector);
        if (input) input.value = value;
    }
    updateSpeciesDetailVisibility();
    updateLengthVisibility();
    setOutputFormat(settings.lastOutputFormat || 'natural', false);
}

function bindUiEvents() {
    const root = state.overlay;
    root.querySelector('#pf-close')?.addEventListener('click', closePanel);
    root.addEventListener('pointerdown', event => {
        if (event.target === root) closePanel();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.overlay?.classList.contains('is-open')) closePanel();
    });

    root.querySelectorAll('.pf-segment[data-mode]').forEach(button => {
        button.addEventListener('click', () => setMode(button.dataset.mode));
    });

    root.querySelector('#pf-style')?.addEventListener('change', () => {
        ensureSettings().lastStyle = root.querySelector('#pf-style').value;
        saveSettings();
    });
    root.querySelector('#pf-gender')?.addEventListener('change', event => {
        ensureSettings().gender = event.target.value;
        saveSettings();
    });
    root.querySelector('#pf-species')?.addEventListener('change', event => {
        ensureSettings().species = event.target.value;
        updateSpeciesDetailVisibility();
        saveSettings();
    });
    root.querySelector('#pf-species-detail')?.addEventListener('change', event => {
        ensureSettings().speciesDetail = event.target.value.trim();
        saveSettings();
    });
    root.querySelector('#pf-name-count')?.addEventListener('change', event => {
        ensureSettings().nameCount = Number(event.target.value) || 5;
        saveSettings();
    });
    root.querySelector('#pf-length-preset')?.addEventListener('change', event => {
        ensureSettings().lengthPreset = event.target.value;
        updateLengthVisibility();
        saveSettings();
    });
    root.querySelector('#pf-target-length')?.addEventListener('change', event => {
        const value = resolveTargetLength('custom', event.target.value);
        event.target.value = String(value);
        ensureSettings().targetLength = value;
        saveSettings();
    });
    root.querySelectorAll('[data-preset]').forEach(button => {
        button.addEventListener('click', () => applySectionPreset(button.dataset.preset));
    });
    root.querySelectorAll('[data-format]').forEach(button => {
        button.addEventListener('click', () => setOutputFormat(button.dataset.format));
    });

    root.querySelector('#pf-copy')?.addEventListener('click', copyCurrentResult);
    root.querySelector('#pf-generate')?.addEventListener('click', generatePersona);
    root.querySelector('#pf-regenerate')?.addEventListener('click', generatePersona);
    root.querySelector('#pf-reroll-names')?.addEventListener('click', rerollNames);
    root.querySelector('#pf-cancel')?.addEventListener('click', cancelGeneration);
    root.querySelector('#pf-jump-content')?.addEventListener('click', () => {
        const content = root.querySelector('#pf-content-details');
        content?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        root.querySelector('[data-section-id]')?.focus({ preventScroll: true });
    });
    root.querySelector('#pf-select-active')?.addEventListener('click', () => {
        state.selectedWorldNames = new Set(state.activeWorldNames);
        renderWorldBookList();
    });
    root.querySelector('#pf-select-all')?.addEventListener('click', () => {
        state.selectedWorldNames = new Set(state.allWorldNames);
        renderWorldBookList();
    });
    root.querySelector('#pf-select-none')?.addEventListener('click', () => {
        state.selectedWorldNames.clear();
        renderWorldBookList();
    });
    root.querySelector('#pf-refresh')?.addEventListener('click', async () => {
        state.lastContextSignature = '';
        await refreshContextUi(true);
        notify('success', '已重新识别角色与世界书。');
    });
}

function setMode(mode) {
    const valid = mode === 'directed' ? 'directed' : 'random';
    const root = state.overlay;
    root.querySelectorAll('.pf-segment[data-mode]').forEach(button => {
        const active = button.dataset.mode === valid;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
    root.querySelector('#pf-directed-fields').hidden = valid !== 'directed';
    ensureSettings().lastMode = valid;
    saveSettings();
}

function currentMode() {
    return state.overlay?.querySelector('.pf-segment[data-mode].is-active')?.dataset.mode || 'random';
}

async function openPanel() {
    createStaticUi();
    await refreshContextUi(false);

    const settings = ensureSettings();
    setMode(settings.lastMode || 'random');
    syncControlsFromSettings();
    renderSectionOptions();

    if (settings.lastStructuredResult && typeof settings.lastStructuredResult === 'object') {
        state.structuredResult = settings.lastStructuredResult;
        state.selectedCandidateIndex = Math.min(
            Number(settings.lastSelectedCandidateIndex) || 0,
            Math.max(0, (state.structuredResult.candidates?.length || 1) - 1),
        );
        renderCurrentResult('上次生成结果');
    } else {
        const saved = String(settings.lastResult || '');
        if (saved) setResult(saved, '上次生成结果');
    }

    state.overlay.classList.add('is-open');
    state.overlay.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('pf-modal-open');
    state.overlay.querySelector('#pf-close')?.focus({ preventScroll: true });
}

function closePanel() {
    if (!state.overlay) return;
    state.overlay.classList.remove('is-open');
    state.overlay.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('pf-modal-open');
}

async function refreshContextUi(force = false) {
    if (!state.overlay) return;
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);

    if (force) state.worldInfoRuntime = null;
    await detectWorldBooks();

    state.overlay.querySelector('#pf-character-name').textContent = getCharacterName(character);
    state.overlay.querySelector('#pf-context-line').textContent = character
        ? `已读取当前角色 · ${state.activeWorldNames.length} 个绑定/启用世界书${state.embeddedBook ? ' · 含卡内世界书' : ''}`
        : '当前未选择单角色；仍可使用全局与聊天世界书生成。';

    renderActiveChips();
    renderWorldBookList();
    const embeddedNote = state.overlay.querySelector('#pf-embedded-note');
    embeddedNote.hidden = !state.embeddedBook;
    const personaNote = state.overlay.querySelector('#pf-persona-book-note');
    personaNote.hidden = state.personaWorldNames.length === 0;
}

function renderActiveChips() {
    const wrap = state.overlay.querySelector('#pf-active-book-chips');
    wrap.replaceChildren();

    const chips = [...state.activeWorldNames];
    if (state.embeddedBook) chips.push('角色卡内嵌 Character Book');

    if (!chips.length) {
        const empty = document.createElement('span');
        empty.className = 'pf-chip pf-chip-muted';
        empty.textContent = '未识别到绑定世界书';
        wrap.appendChild(empty);
        return;
    }

    for (const name of chips) {
        const chip = document.createElement('span');
        chip.className = 'pf-chip';
        chip.textContent = name;
        wrap.appendChild(chip);
    }
}

function renderWorldBookList() {
    const list = state.overlay.querySelector('#pf-book-list');
    const count = state.overlay.querySelector('#pf-book-count');
    list.replaceChildren();

    if (!state.allWorldNames.length) {
        const empty = document.createElement('div');
        empty.className = 'pf-inline-note';
        empty.textContent = '当前没有可枚举的 World Info 文件。';
        list.appendChild(empty);
    } else {
        for (const name of state.allWorldNames) {
            const label = document.createElement('label');
            label.className = 'pf-book-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selectedWorldNames.has(name);
            checkbox.addEventListener('change', () => {
                checkbox.checked ? state.selectedWorldNames.add(name) : state.selectedWorldNames.delete(name);
                updateBookCount();
            });

            const text = document.createElement('span');
            text.className = 'pf-book-item-text';
            text.textContent = name;

            if (state.activeWorldNames.includes(name)) {
                const badge = document.createElement('small');
                badge.className = 'pf-active-badge';
                badge.textContent = '当前启用';
                text.append(' ', badge);
            } else if (state.personaWorldNames.includes(name)) {
                const badge = document.createElement('small');
                badge.className = 'pf-active-badge pf-persona-badge';
                badge.textContent = '当前 Persona';
                text.append(' ', badge);
            }

            label.append(checkbox, text);
            list.appendChild(label);
        }
    }

    updateBookCount();
}

function updateBookCount() {
    const count = state.overlay?.querySelector('#pf-book-count');
    if (count) count.textContent = `${state.selectedWorldNames.size} 个已选`;
}

function extractEntries(book, sourceName) {
    if (!book || typeof book !== 'object') return [];
    const raw = book.entries ?? book.data?.entries ?? [];
    const entries = Array.isArray(raw) ? raw : Object.values(raw || {});

    return entries
        .filter(entry => entry && typeof entry === 'object')
        .filter(entry => entry.enabled !== false && entry.disable !== true)
        .map((entry, index) => ({
            source: sourceName,
            index,
            comment: String(entry.comment ?? entry.name ?? '').trim(),
            keys: unique([
                ...(Array.isArray(entry.key) ? entry.key : []),
                ...(Array.isArray(entry.keys) ? entry.keys : []),
                ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
                ...(Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []),
            ]),
            content: String(entry.content ?? '').trim(),
            constant: Boolean(entry.constant),
            order: Number(entry.order ?? entry.insertion_order ?? 0),
        }))
        .filter(entry => entry.content);
}

function entryToText(entry) {
    const title = entry.comment ? `｜${entry.comment}` : '';
    const keys = entry.keys.length ? `\n关键词：${entry.keys.join(' / ')}` : '';
    return `【世界书：${entry.source}${title}】${keys}\n${entry.content}`;
}

function getContextBudgets() {
    const ctx = getContext();
    const maxContext = Number(ctx.maxContext) || 0;
    if (!maxContext) {
        return {
            characterChars: 18000,
            totalSafeChars: MAX_LORE_CHARS_DEFAULT + 22000,
        };
    }
    return {
        characterChars: Math.max(2500, Math.min(18000, Math.floor(maxContext * 0.32))),
        totalSafeChars: Math.max(6000, Math.floor(maxContext * 0.8)),
    };
}

async function collectWorldLore(characterContextLength = 0) {
    const ctx = getContext();
    const settings = ensureSettings();
    const budgets = getContextBudgets();
    const configuredLimit = Math.max(1500, Number(settings.maxLoreChars) || MAX_LORE_CHARS_DEFAULT);
    const availableForLore = Math.max(1500, budgets.totalSafeChars - characterContextLength - 3500);
    const limit = Math.min(configuredLimit, availableForLore);
    const entries = [];
    const failures = [];

    for (const name of state.selectedWorldNames) {
        try {
            const book = await ctx.loadWorldInfo?.(name);
            if (book) entries.push(...extractEntries(book, name));
            else failures.push(name);
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] Failed to load World Info: ${name}`, error);
            failures.push(name);
        }
    }

    if (state.embeddedBook) {
        entries.push(...extractEntries(state.embeddedBook, '角色卡内嵌 Character Book'));
    }

    // Constants and high-order rules tend to contain broad setting constraints, so keep them first if a large lorebook must be trimmed.
    entries.sort((a, b) => Number(b.constant) - Number(a.constant) || b.order - a.order || a.index - b.index);

    let usedChars = 0;
    let included = 0;
    const blocks = [];
    for (const entry of entries) {
        const text = neutralizePersonaReferences(
            entryToText(entry),
            ctx.name1,
            getCharacterName(getCurrentCharacter(ctx)),
        );
        if (usedChars + text.length > limit && blocks.length) continue;
        blocks.push(text.slice(0, Math.max(0, limit - usedChars)));
        usedChars += Math.min(text.length, Math.max(0, limit - usedChars));
        included += 1;
        if (usedChars >= limit) break;
    }

    return {
        text: blocks.join('\n\n'),
        totalEntries: entries.length,
        includedEntries: included,
        truncated: included < entries.length,
        failures,
        chars: usedChars,
    };
}

function collectCharacterContext() {
    const ctx = getContext();
    const character = getCurrentCharacter(ctx);
    if (!character) return '当前未选择单角色。';

    const name = getCharacterName(character);
    const maxChars = getContextBudgets().characterChars;
    const fields = [
        ['姓名', name],
        ['Description', getField(character, 'description')],
        ['Personality', getField(character, 'personality')],
        ['Scenario', getField(character, 'scenario')],
        ['Creator Notes', getField(character, 'creator_notes', 'creatorcomment')],
        ['System Prompt', getField(character, 'system_prompt')],
        ['Post-History Instructions', getField(character, 'post_history_instructions')],
    ].filter(([, value]) => value);

    const blocks = fields.map(([label, value]) => {
        const cleaned = neutralizePersonaReferences(value, ctx.name1, name);
        return '【' + label + '】\n' + cleaned;
    });
    return blocks.join('\n\n').slice(0, maxChars);
}

function collectGenerationOptions() {
    const root = state.overlay;
    const mode = currentMode();
    const style = root.querySelector('#pf-style')?.value || 'balanced';
    const shortExtra = root.querySelector('#pf-extra-short')?.value?.trim() || '';
    const gender = root.querySelector('#pf-gender')?.value || 'random';
    const species = root.querySelector('#pf-species')?.value || 'random';
    const speciesDetail = species === 'nonhuman'
        ? root.querySelector('#pf-species-detail')?.value?.trim() || ''
        : '';
    const nameCount = Number(root.querySelector('#pf-name-count')?.value) || 5;
    const lengthPreset = root.querySelector('#pf-length-preset')?.value || 'standard';
    const targetLength = resolveTargetLength(
        lengthPreset,
        root.querySelector('#pf-target-length')?.value,
    );
    const sections = getSelectedSections(getCurrentSectionSelection());
    const randomId = globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + String(Math.random());

    if (mode === 'random') {
        return {
            mode,
            style,
            gender,
            species,
            speciesDetail,
            nameCount,
            lengthPreset,
            targetLength,
            fixedName: '',
            sections,
            directionText: [
                '生成模式：随机生成',
                '附加要求：' + (shortExtra || '无'),
                '随机扰动标识：' + randomId,
            ].join('\n'),
        };
    }

    const name = root.querySelector('#pf-name')?.value?.trim() || '';
    const keywords = root.querySelector('#pf-keywords')?.value?.trim() || '';
    const hard = root.querySelector('#pf-hard')?.value?.trim() || '';
    const extra = root.querySelector('#pf-extra')?.value?.trim() || '';

    return {
        mode,
        style,
        gender,
        species,
        speciesDetail,
        nameCount: name ? 1 : nameCount,
        lengthPreset,
        targetLength,
        fixedName: name,
        sections,
        directionText: [
            '生成模式：定向生成',
            '姓名：' + (name || '未指定，生成多个候选姓名'),
            '关键词：' + (keywords || '未指定'),
            '锁定条件：' + (hard || '无'),
            '附加要求：' + ([shortExtra, extra].filter(Boolean).join('；') || '无'),
        ].join('\n'),
    };
}

async function generatePersona() {
    if (state.generating) return;
    const ctx = getContext();
    if (typeof ctx.generateRaw !== 'function') {
        notify('error', '当前版本未提供 generateRaw()。');
        return;
    }

    state.generating = true;
    const generationId = ++state.generationEpoch;
    setLoading(true);

    try {
        await refreshContextUi(false);
        const options = collectGenerationOptions();
        const characterContext = collectCharacterContext();
        const lore = await collectWorldLore(characterContext.length);
        const prompt = buildPersonaGenerationPrompt({
            options,
            characterContext,
            loreText: lore.text,
        });

        const result = await ctx.generateRaw({
            systemPrompt: buildPersonaSystemPrompt(),
            prompt,
        });

        if (generationId !== state.generationEpoch) return;
        const payload = parseStructuredResponse(result);
        state.structuredResult = normalizeStructuredResult(payload, options, ctx.name1);
        state.selectedCandidateIndex = 0;

        const notes = [];
        notes.push('已读取 ' + lore.includedEntries + '/' + lore.totalEntries + ' 条世界书内容');
        if (lore.truncated) notes.push('世界书较大，已按广义规则优先截取');
        if (lore.failures.length) notes.push(lore.failures.length + ' 个世界书读取失败');

        const settings = ensureSettings();
        settings.lastStructuredResult = state.structuredResult;
        settings.lastSelectedCandidateIndex = 0;
        settings.lastResult = '';
        settings.lastMode = options.mode;
        settings.lastStyle = options.style;
        settings.gender = options.gender;
        settings.species = options.species;
        settings.speciesDetail = options.speciesDetail;
        settings.nameCount = options.nameCount;
        settings.lengthPreset = options.lengthPreset;
        settings.targetLength = options.targetLength;
        settings.sectionSelection = getCurrentSectionSelection();
        saveSettings();
        renderCurrentResult(notes.join(' · '));
    } catch (error) {
        if (generationId !== state.generationEpoch) return;
        console.error(`[${DISPLAY_NAME}] Generation failed`, error);
        notify('error', '生成失败：' + (error?.message || error));
        setResultError(error?.message || String(error));
    } finally {
        if (generationId === state.generationEpoch) {
            state.generating = false;
            setLoading(false);
        }
    }
}

async function rerollNames() {
    if (state.generating || !state.structuredResult) return;
    if (state.structuredResult.options?.fixedName) {
        notify('info', '当前使用的是指定姓名。');
        return;
    }

    const ctx = getContext();
    if (typeof ctx.generateRaw !== 'function') return;
    const count = Number(state.structuredResult.options?.nameCount) || Number(ensureSettings().nameCount) || 5;
    const generationId = ++state.generationEpoch;
    state.generating = true;
    setLoading(true);

    try {
        const result = await ctx.generateRaw({
            systemPrompt: buildPersonaSystemPrompt(),
            prompt: buildNameRerollPrompt(state.structuredResult, count),
        });
        if (generationId !== state.generationEpoch) return;
        const payload = parseStructuredResponse(result);
        const candidates = normalizeNameCandidates(payload, ctx.name1);
        if (!candidates.length) throw new Error('模型没有返回新的候选姓名。');

        state.structuredResult = {
            ...state.structuredResult,
            candidates,
        };
        state.selectedCandidateIndex = 0;
        const settings = ensureSettings();
        settings.lastStructuredResult = state.structuredResult;
        settings.lastSelectedCandidateIndex = 0;
        saveSettings();
        renderCurrentResult('已更换候选姓名');
    } catch (error) {
        if (generationId !== state.generationEpoch) return;
        console.error(`[${DISPLAY_NAME}] Name reroll failed`, error);
        notify('error', '更换姓名失败：' + (error?.message || error));
    } finally {
        if (generationId === state.generationEpoch) {
            state.generating = false;
            setLoading(false);
        }
    }
}

function cancelGeneration() {
    if (!state.generating) return;
    state.generationEpoch += 1;
    state.generating = false;
    try {
        getContext().stopGeneration?.();
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not stop the underlying request.`, error);
    }
    setLoading(false);
    notify('info', '已停止生成。');
}

function selectCandidate(index) {
    if (!state.structuredResult?.candidates?.[index]) return;
    state.selectedCandidateIndex = index;
    const settings = ensureSettings();
    settings.lastSelectedCandidateIndex = index;
    saveSettings();
    renderCurrentResult();
}

function renderCandidateButtons() {
    const root = state.overlay;
    const panel = root?.querySelector('#pf-candidate-panel');
    const wrap = root?.querySelector('#pf-name-candidates');
    if (!panel || !wrap) return;
    const candidates = state.structuredResult?.candidates || [];
    panel.hidden = candidates.length === 0;
    wrap.replaceChildren();

    candidates.forEach((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pf-name-button';
        button.classList.toggle('is-active', index === state.selectedCandidateIndex);
        button.textContent = candidate.name;
        if (candidate.style) button.title = candidate.style;
        button.addEventListener('click', () => selectCandidate(index));
        wrap.appendChild(button);
    });

    const reroll = root.querySelector('#pf-reroll-names');
    if (reroll) reroll.hidden = Boolean(state.structuredResult?.options?.fixedName);
}

function renderCurrentResult(meta = '生成完成，可切换姓名和输出格式') {
    if (!state.structuredResult) return;
    const format = ensureSettings().lastOutputFormat || 'natural';
    const text = renderStructuredResult(state.structuredResult, state.selectedCandidateIndex, format);
    renderCandidateButtons();
    setResult(text, meta);
}

function setLoading(loading) {
    const root = state.overlay;
    if (!root) return;
    const generate = root.querySelector('#pf-generate');
    const regenerate = root.querySelector('#pf-regenerate');
    const copy = root.querySelector('#pf-copy');
    const cancel = root.querySelector('#pf-cancel');
    const rerollNamesButton = root.querySelector('#pf-reroll-names');

    generate.disabled = loading;
    regenerate.disabled = loading || !root.querySelector('#pf-result')?.textContent?.trim();
    copy.disabled = loading || !root.querySelector('#pf-result')?.textContent?.trim();
    if (cancel) cancel.hidden = !loading;
    if (rerollNamesButton) rerollNamesButton.disabled = loading;
    root.querySelectorAll('.pf-name-button, .pf-format-button').forEach(button => {
        button.disabled = loading;
    });
    generate.classList.toggle('is-loading', loading);
    generate.textContent = loading ? '正在生成…' : '✨ 生成人设';
    root.querySelector('.pf-modal')?.setAttribute('aria-busy', String(loading));
}

function setResult(text, meta = '生成完成') {
    const root = state.overlay;
    if (!root) return;
    const result = root.querySelector('#pf-result');
    const empty = root.querySelector('#pf-empty');
    result.textContent = text;
    result.hidden = false;
    empty.hidden = true;
    root.querySelector('#pf-result-meta').textContent = meta;
    root.querySelector('#pf-copy').disabled = false;
    root.querySelector('#pf-regenerate').disabled = false;
}

function setResultError(message) {
    const root = state.overlay;
    if (!root) return;
    const result = root.querySelector('#pf-result');
    const empty = root.querySelector('#pf-empty');
    result.hidden = true;
    result.textContent = '';
    const candidatePanel = root.querySelector('#pf-candidate-panel');
    if (candidatePanel) candidatePanel.hidden = true;
    empty.hidden = false;
    empty.textContent = `生成失败：${message}`;
    root.querySelector('#pf-result-meta').textContent = '请检查当前 API 连接后重试。';
    root.querySelector('#pf-copy').disabled = true;
    root.querySelector('#pf-regenerate').disabled = false;
}

async function copyText(text) {
    if (navigator.clipboard?.writeText && globalThis.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('浏览器拒绝复制。');
}

async function copyCurrentResult() {
    const text = state.overlay?.querySelector('#pf-result')?.textContent?.trim() || '';
    if (!text) return;
    try {
        await copyText(text);
        const button = state.overlay.querySelector('#pf-copy');
        const old = button.textContent;
        button.textContent = '✓ 已复制';
        button.classList.add('is-copied');
        notify('success', '人设正文已复制到剪贴板。');
        setTimeout(() => {
            button.textContent = old;
            button.classList.remove('is-copied');
        }, 1400);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Copy failed`, error);
        notify('error', '复制失败，请长按结果区域手动复制。');
    }
}

function bindContextEvents() {
    const ctx = getContext();
    const source = ctx.eventSource;
    const types = ctx.eventTypes ?? ctx.event_types;
    if (!source?.on || !types) return;

    const refresh = () => {
        if (!state.overlay?.classList.contains('is-open')) return;
        state.lastContextSignature = '';
        refreshContextUi(true).catch(console.error);
    };

    const candidates = [
        'CHAT_CHANGED',
        'CHARACTER_EDITED',
        'CHARACTER_PAGE_LOADED',
        'WORLDINFO_UPDATED',
        'WORLDINFO_SETTINGS_UPDATED',
        'PERSONA_CHANGED',
    ];

    for (const key of candidates) {
        if (types[key]) source.on(types[key], refresh);
    }
}

export async function init() {
    try {
        createStaticUi();
        createSettingsUi();
        ensureSettings();
        updateFloatingButton();
        bindContextEvents();
        await detectWorldBooks();
        console.info(`[${DISPLAY_NAME}] v${VERSION} loaded.`);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Init failed`, error);
    }
}

// SillyTavern loads extension scripts as modules. Start once the host DOM is ready.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
} else {
    init();
}
