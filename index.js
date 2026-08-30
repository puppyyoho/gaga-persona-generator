const EXTENSION_NAME = 'persona-forge';
const SETTINGS_KEY = 'personaForge';
const VERSION = '0.1.0';
const MAX_LORE_CHARS_DEFAULT = 52000;

const state = {
    overlay: null,
    panel: null,
    settingsPanel: null,
    worldInfoRuntime: null,
    allWorldNames: [],
    activeWorldNames: [],
    selectedWorldNames: new Set(),
    embeddedBook: null,
    lastContextSignature: '',
    generating: false,
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
        toast[type](message, 'Persona Forge');
        return;
    }
    console[type === 'error' ? 'error' : 'log'](`[Persona Forge] ${message}`);
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
        console.warn('[Persona Forge] Could not import world-info runtime. Falling back to context-only detection.', error);
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

    // 5) Current Persona lorebook.
    active.push(...normalizeArray(ctx.powerUserSettings?.persona_description_lorebook));

    state.allWorldNames = unique(allWorldNames);
    state.activeWorldNames = unique(active).filter(name => state.allWorldNames.length === 0 || state.allWorldNames.includes(name));
    state.embeddedBook = getEmbeddedCharacterBook(character);

    // On first context load, default to active books. Preserve manual user selection afterward.
    const signature = JSON.stringify({
        character: getCharacterName(character),
        active: state.activeWorldNames,
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
        embedded: state.embeddedBook,
    };
}

function ensureSettings() {
    const ctx = getContext();
    const root = ctx.extensionSettings;
    if (!root[SETTINGS_KEY]) {
        root[SETTINGS_KEY] = {
            showFloatingButton: true,
            maxLoreChars: MAX_LORE_CHARS_DEFAULT,
            lastResult: '',
            lastMode: 'random',
            lastStyle: 'balanced',
        };
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
                    <div class="pf-kicker">Persona Forge <span class="pf-version">v${VERSION}</span></div>
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

                    <div class="pf-grid pf-grid-2 pf-top-gap">
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
                            <span>附加要求 <small>随机模式也可填写</small></span>
                            <input id="pf-extra-short" type="text" autocomplete="off" placeholder="例如：不要贵族、偏日常、年龄30岁左右">
                        </label>
                    </div>

                    <div id="pf-directed-fields" class="pf-directed-fields" hidden>
                        <div class="pf-grid pf-grid-2">
                            <label class="pf-field">
                                <span>姓名</span>
                                <input id="pf-name" type="text" autocomplete="off" placeholder="留空则由模型生成">
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
                    <div class="pf-empty" id="pf-empty">还没有生成内容。</div>
                    <pre class="pf-result" id="pf-result" tabindex="0" hidden></pre>
                </section>
            </div>

            <footer class="pf-footer">
                <button class="pf-secondary-button" type="button" id="pf-regenerate" disabled>↻ 再生成一次</button>
                <button class="pf-primary-button" type="button" id="pf-generate">✨ 生成人设</button>
            </footer>
        </section>
    `;

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.panel = overlay.querySelector('.pf-modal');

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
                <b>Persona Forge</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>读取当前角色与世界书，调用当前 SillyTavern 模型生成适配世界观的 User Persona。</p>
                <button type="button" class="menu_button" id="pf-open-settings">打开 Persona Forge</button>
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
        button.title = '打开 Persona Forge';
        button.setAttribute('aria-label', '打开 Persona Forge');
        button.innerHTML = '<span aria-hidden="true">✨</span><span class="pf-fab-text">Persona</span>';
        button.addEventListener('click', openPanel);
        document.body.appendChild(button);
    }
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

    root.querySelectorAll('.pf-segment').forEach(button => {
        button.addEventListener('click', () => setMode(button.dataset.mode));
    });

    root.querySelector('#pf-style')?.addEventListener('change', () => {
        ensureSettings().lastStyle = root.querySelector('#pf-style').value;
        saveSettings();
    });

    root.querySelector('#pf-copy')?.addEventListener('click', copyCurrentResult);
    root.querySelector('#pf-generate')?.addEventListener('click', generatePersona);
    root.querySelector('#pf-regenerate')?.addEventListener('click', generatePersona);
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
    root.querySelectorAll('.pf-segment').forEach(button => {
        const active = button.dataset.mode === valid;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
    root.querySelector('#pf-directed-fields').hidden = valid !== 'directed';
    ensureSettings().lastMode = valid;
    saveSettings();
}

function currentMode() {
    return state.overlay?.querySelector('.pf-segment.is-active')?.dataset.mode || 'random';
}

async function openPanel() {
    createStaticUi();
    await refreshContextUi(false);

    const settings = ensureSettings();
    setMode(settings.lastMode || 'random');
    const style = state.overlay.querySelector('#pf-style');
    if (style) style.value = settings.lastStyle || 'balanced';

    const saved = String(settings.lastResult || '');
    if (saved) setResult(saved, '上次生成结果');

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
        : '当前未选择单角色；仍可使用全局、聊天与 Persona 世界书生成。';

    renderActiveChips();
    renderWorldBookList();
    const embeddedNote = state.overlay.querySelector('#pf-embedded-note');
    embeddedNote.hidden = !state.embeddedBook;
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
            keys: unique([...(Array.isArray(entry.key) ? entry.key : []), ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : [])]),
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

async function collectWorldLore() {
    const ctx = getContext();
    const settings = ensureSettings();
    const limit = Math.max(12000, Number(settings.maxLoreChars) || MAX_LORE_CHARS_DEFAULT);
    const entries = [];
    const failures = [];

    for (const name of state.selectedWorldNames) {
        try {
            const book = await ctx.loadWorldInfo?.(name);
            if (book) entries.push(...extractEntries(book, name));
            else failures.push(name);
        } catch (error) {
            console.warn(`[Persona Forge] Failed to load World Info: ${name}`, error);
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
        const text = entryToText(entry);
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
    const character = getCurrentCharacter();
    if (!character) return '当前未选择单角色。';

    const name = getCharacterName(character);
    const fields = [
        ['姓名', name],
        ['Description', getField(character, 'description')],
        ['Personality', getField(character, 'personality')],
        ['Scenario', getField(character, 'scenario')],
        ['Creator Notes', getField(character, 'creator_notes', 'creatorcomment')],
        ['System Prompt', getField(character, 'system_prompt')],
        ['Post-History Instructions', getField(character, 'post_history_instructions')],
    ].filter(([, value]) => value);

    return fields.map(([label, value]) => `【${label}】\n${value}`).join('\n\n');
}

function styleInstruction(style) {
    const map = {
        'balanced': '在世界观一致性、人物独立性和剧情可用性之间保持均衡。优先生成自然、可长期使用的人设。',
        'world-first': '世界观一致性拥有最高优先级。身份、阶层、职业、能力、时代常识和资源条件必须严密符合设定。',
        'dramatic': '在不破坏世界观事实的前提下，提高与当前角色发生剧情、冲突、合作或复杂关系的潜力，但不要强行制造狗血关系。',
        'rare': '从世界观允许的小概率身份与经历中取材。可以特别，但必须能够解释其存在条件，禁止凭空添加设定体系。',
    };
    return map[style] || map.balanced;
}

function collectUserDirection() {
    const root = state.overlay;
    const mode = currentMode();
    const style = root.querySelector('#pf-style')?.value || 'balanced';
    const shortExtra = root.querySelector('#pf-extra-short')?.value?.trim() || '';

    if (mode === 'random') {
        return {
            mode,
            style,
            text: `生成模式：完全随机\n附加要求：${shortExtra || '无'}\n随机扰动标识：${crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`,
        };
    }

    const name = root.querySelector('#pf-name')?.value?.trim() || '';
    const keywords = root.querySelector('#pf-keywords')?.value?.trim() || '';
    const hard = root.querySelector('#pf-hard')?.value?.trim() || '';
    const extra = root.querySelector('#pf-extra')?.value?.trim() || '';

    return {
        mode,
        style,
        text: [
            '生成模式：定向生成',
            `姓名：${name || '未指定，可自行生成'}`,
            `关键词：${keywords || '未指定'}`,
            `锁定条件：${hard || '无'}`,
            `附加要求：${[shortExtra, extra].filter(Boolean).join('；') || '无'}`,
        ].join('\n'),
    };
}

function buildSystemPrompt() {
    return `你是 SillyTavern 的 User Persona 设计器。你的任务是根据给定角色卡与世界书，生成一个原本就应该存在于该世界里的 {{user}}。\n\n规则：\n1. 世界书与角色卡中明确写出的事实视为硬事实。不得创造与其冲突的时代、地域、制度、种族、魔法、科技、组织、身份体系。\n2. 用户提供的“锁定条件”拥有最高优先级，除非它与硬事实直接冲突；发生冲突时，以最小改动方式兼容，并在正文末尾用“【设定兼容说明】”简短说明。\n3. 用户给出的姓名、年龄、职业、关系等明确条件不得擅自修改。关键词是强倾向。未指定部分可以创造。\n4. 当前角色仅是世界中的一个人物。生成的 {{user}} 必须拥有独立人生、社会关系、生活资源、判断与欲望，不能只是为了迎合 {{char}} 而存在。\n5. 可以设计与当前角色有剧情潜力的联系，但除非用户明确要求，不要自动套用恋人、宿敌、青梅竹马、血缘等强绑定关系。\n6. 财务、教育、职业、年龄与生活方式要互相匹配。特殊能力或特殊身份必须有世界观依据。\n7. 不读取也不推断当前聊天剧情。仅依据本次提供的角色卡、世界书和用户条件。\n8. 输出最终可直接粘贴进 SillyTavern Persona Description 的中文正文。不要输出 JSON，不要解释你的推理过程，不要用代码块。\n9. 根据世界类型自行调整字段。现代世界可写职业、教育、家庭、经济与日常；奇幻世界可改为种族、出身、阵营、能力体系等。不要为了凑模板硬填不适用字段。\n10. 内容应具体、有区分度、便于长期角色扮演。避免堆砌空泛形容词。`;
}

function buildGenerationPrompt(characterContext, lore, direction) {
    const characterName = getCharacterName(getCurrentCharacter());
    return `请生成一个 User Persona。\n\n【生成倾向】\n${styleInstruction(direction.style)}\n\n【当前角色卡】\n${characterContext}\n\n【当前世界书资料】\n${lore.text || '未读取到世界书正文。请只依据角色卡与用户条件生成，不要自行假设额外体系。'}\n\n【用户定向条件】\n${direction.text}\n\n【输出建议】\n请优先形成一份完整、自然的人设正文。通常可以包含：基本身份、外貌气质、性格与行为逻辑、成长与家庭、教育/职业或世界内等价身份、经济与资源、能力与限制、生活习惯、重要关系、与 ${characterName} 的已知或潜在关系、当前处境。世界观不适用的栏目自行删改。\n\n只输出最终 Persona 正文。`;
}

async function generatePersona() {
    if (state.generating) return;
    const ctx = getContext();
    if (typeof ctx.generateRaw !== 'function') {
        notify('error', '当前版本未提供 generateRaw()。');
        return;
    }

    state.generating = true;
    setLoading(true);

    try {
        await refreshContextUi(false);
        const lore = await collectWorldLore();
        const direction = collectUserDirection();
        const characterContext = collectCharacterContext();
        const prompt = buildGenerationPrompt(characterContext, lore, direction);

        const result = await ctx.generateRaw({
            systemPrompt: buildSystemPrompt(),
            prompt,
        });

        const text = String(result ?? '').trim();
        if (!text) throw new Error('模型返回了空内容。');

        const notes = [];
        notes.push(`已读取 ${lore.includedEntries}/${lore.totalEntries} 条世界书内容`);
        if (lore.truncated) notes.push('世界书较大，已按广义规则优先截取');
        if (lore.failures.length) notes.push(`${lore.failures.length} 个世界书读取失败`);

        setResult(text, notes.join(' · '));
        const settings = ensureSettings();
        settings.lastResult = text;
        settings.lastMode = direction.mode;
        settings.lastStyle = direction.style;
        saveSettings();
    } catch (error) {
        console.error('[Persona Forge] Generation failed', error);
        notify('error', `生成失败：${error?.message || error}`);
        setResultError(error?.message || String(error));
    } finally {
        state.generating = false;
        setLoading(false);
    }
}

function setLoading(loading) {
    const root = state.overlay;
    if (!root) return;
    const generate = root.querySelector('#pf-generate');
    const regenerate = root.querySelector('#pf-regenerate');
    const copy = root.querySelector('#pf-copy');

    generate.disabled = loading;
    regenerate.disabled = loading || !root.querySelector('#pf-result')?.textContent?.trim();
    copy.disabled = loading || !root.querySelector('#pf-result')?.textContent?.trim();
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
        console.error('[Persona Forge] Copy failed', error);
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
        console.info(`[Persona Forge] v${VERSION} loaded.`);
    } catch (error) {
        console.error('[Persona Forge] Init failed', error);
    }
}

// SillyTavern loads extension scripts as modules. Start once the host DOM is ready.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
} else {
    init();
}
