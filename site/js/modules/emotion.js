// 角色情绪基础：异步评估、角色状态持久化与手动管理。
(function attachEmotion(global) {
    'use strict';

    const Core = global.EmotionCore;
    const runtime = new Map();
    const locks = new Set();
    const ui = { characterId: '', editing: false };

    function ensureSettings(character) {
        if (!character) return character;
        if (character.emotionEnabled === undefined) character.emotionEnabled = false;
        if (character.emotionAutoEvaluate === undefined) character.emotionAutoEvaluate = true;
        if (!['lifestyle', 'mindful'].includes(character.emotionStyle)) character.emotionStyle = 'lifestyle';
        const state = Core.normalizeState(character, { now: 0 });
        if (!Array.isArray(character.activeBuffs)) character.activeBuffs = state.activeBuffs;
        if (character.buffInjection === undefined) character.buffInjection = state.buffInjection;
        if (character.emotionInnerState === undefined) character.emotionInnerState = state.innerState;
        if (character.emotionUpdatedAt === undefined) character.emotionUpdatedAt = state.updatedAt;
        if (character.emotionLastEvaluatedAt === undefined) character.emotionLastEvaluatedAt = state.lastEvaluatedAt;
        if (character.emotionRevision === undefined) character.emotionRevision = state.revision;
        return character;
    }

    function findCharacter(id) {
        return (global.db?.characters || []).find(item => String(item.id) === String(id)) || null;
    }

    function featureConfig(character) {
        const result = global.FeatureApiRegistry?.resolve('emotion', {
            context: character,
            fallbackConfig: global.db?.apiSettings || null,
        });
        return result?.configured && result.config ? result.config : null;
    }

    function endpointFor(config) {
        return global.getApiConfigEndpoint
            ? global.getApiConfigEndpoint(config, false)
            : `${String(config.url || config.baseUrl || '').replace(/\/$/, '')}/v1/chat/completions`;
    }

    function headersFor(config) {
        return global.getApiConfigHeaders
            ? global.getApiConfigHeaders(config)
            : { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) };
    }

    function messageText(message) {
        if (!message || !['user', 'assistant'].includes(message.role) || message.isThinking || message.isContextDisabled) return '';
        const type = global.MessageReference?.classify ? global.MessageReference.classify(message) : 'text';
        if (['image', 'video', 'file', 'sticker', 'system', 'transfer', 'location'].includes(type)) return '';
        if (message.transcriptOriginal) return String(message.transcriptOriginal).trim();
        const raw = global.MessageReference?.extractText ? global.MessageReference.extractText(message) : message.content;
        const parsed = global.MessageContentParser?.parse ? global.MessageContentParser.parse(raw) : { original: raw };
        return String(parsed.original || '').trim();
    }

    function recentHistory(character) {
        return (character.history || []).map(message => ({ role: message.role, text: messageText(message) }))
            .filter(item => item.text).slice(-40);
    }

    function stateFor(character) {
        return Core.normalizeState({
            activeBuffs: character.activeBuffs,
            buffInjection: character.buffInjection,
            innerState: character.emotionInnerState,
            updatedAt: character.emotionUpdatedAt,
            lastEvaluatedAt: character.emotionLastEvaluatedAt,
            revision: character.emotionRevision,
        });
    }

    function buildPrompt(character) {
        const history = recentHistory(character);
        const roleName = character.remarkName || character.name || '角色';
        const userName = character.myName || '用户';
        const historyText = history.length
            ? history.map(item => `${item.role === 'user' ? userName : roleName}：${item.text}`).join('\n')
            : '（暂无可用原文）';
        const current = stateFor(character);
        const currentBuffs = current.activeBuffs.length
            ? JSON.stringify(current.activeBuffs)
            : '[]';
        const style = character.emotionStyle === 'mindful' ? '意识、思绪和内在感受' : '日常生活与可观察情绪';
        return [
            `你是“${roleName}”的情绪状态评估器。只根据最近对话原文和角色设定，判断角色当前的${style}。`,
            `角色设定：${typeof global.getEffectivePersona === 'function' ? global.getEffectivePersona(character) : (character.persona || '')}`,
            `当前 Buff：${currentBuffs}`,
            '对话原文（其中可能包含用户输入和角色回复；翻译不提供给你）：',
            historyText,
            '请只返回 JSON，不要 Markdown、解释或额外文本：{"changed":true,"buffs":[{"id":"...","name":"...","label":"...","intensity":1,"emoji":"","description":""}],"injection":"给角色后续行为使用的简短情绪影响","innerState":"仅供系统保存的内在状态"}。',
            'changed=false 表示本轮不需要改变现有 Buff 或注入文本；不要凭空添加没有对话依据的事实。Buff 最多 8 个，intensity 只能是 1、2、3。',
        ].join('\n');
    }

    function applyResult(character, result) {
        if (!character || !result) return false;
        ensureSettings(character);
        if (result.innerState !== undefined) character.emotionInnerState = String(result.innerState || '').trim().slice(0, 1200);
        if (result.changed === true) {
            character.activeBuffs = Core.normalizeBuffs(result.buffs || []);
            character.buffInjection = String(result.injection || '').trim().slice(0, 4000);
        }
        const now = Date.now();
        character.emotionUpdatedAt = now;
        character.emotionLastEvaluatedAt = now;
        character.emotionRevision = Math.max(0, Number(character.emotionRevision) || 0) + 1;
        runtime.delete(character.id);
        if (typeof global.saveCharacter === 'function') return global.saveCharacter(character.id).then(() => true);
        return Promise.resolve(true);
    }

    async function evaluate(character, options = {}) {
        ensureSettings(character);
        if (!character?.emotionEnabled) return { skipped: true, reason: 'disabled' };
        if (character.emotionAutoEvaluate === false && options.force !== true) return { skipped: true, reason: 'manual-only' };
        if (locks.has(character.id)) return { skipped: true, reason: 'lock' };
        const config = featureConfig(character);
        if (!config || typeof global.fetchAiResponse !== 'function') return { skipped: true, reason: 'api-unavailable' };
        locks.add(character.id);
        try {
            const payload = {
                model: config.model,
                messages: [{ role: 'user', content: buildPrompt(character) }],
                temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.85,
                max_tokens: Number(config.max_tokens || config.maxTokens) || 2200,
                stream: false,
            };
            const response = await global.fetchAiResponse(config, payload, headersFor(config), endpointFor(config), false);
            const result = Core.parseResult(response);
            if (!result) return { skipped: true, reason: 'invalid-response' };
            await applyResult(character, result);
            return { skipped: false, result };
        } catch (error) {
            console.warn('[Emotion] evaluation failed without blocking chat:', error);
            return { skipped: false, error: error.message || String(error) };
        } finally {
            locks.delete(character.id);
        }
    }

    async function prepareContext(character) {
        ensureSettings(character);
        if (!character?.emotionEnabled) { runtime.delete(character?.id); return ''; }
        const block = Core.formatContext(stateFor(character));
        runtime.set(character.id, { block, preparedAt: Date.now() });
        return block;
    }

    function getContext(character) {
        ensureSettings(character);
        return character?.emotionEnabled ? runtime.get(character.id)?.block || Core.formatContext(stateFor(character)) : '';
    }

    async function saveManualState(character, value) {
        ensureSettings(character);
        const state = Core.normalizeState(value, { now: Date.now() });
        character.activeBuffs = state.activeBuffs;
        character.buffInjection = state.buffInjection;
        character.emotionInnerState = state.innerState;
        character.emotionUpdatedAt = Date.now();
        character.emotionRevision = Math.max(0, Number(character.emotionRevision) || 0) + 1;
        runtime.delete(character.id);
        if (typeof global.saveCharacter === 'function') await global.saveCharacter(character.id);
        return state;
    }

    async function clear(character) {
        return saveManualState(character, { activeBuffs: [], buffInjection: '', innerState: '' });
    }

    function escape(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function currentCharacter() { return findCharacter(ui.characterId || global.currentChatId); }

    function setEditing(editing) {
        ui.editing = editing;
        document.getElementById('emotion-overview').hidden = editing;
        document.getElementById('emotion-editor').hidden = !editing;
        const edit = document.getElementById('emotion-edit-btn');
        edit.hidden = editing;
        edit.setAttribute('aria-expanded', String(editing));
        document.getElementById('emotion-evaluate-btn').hidden = editing;
    }

    function editorRow(buff, index) {
        return `<div class="emotion-buff-row" data-emotion-index="${index}"><div class="emotion-buff-fields"><label>情绪名称<input data-emotion-field="label" value="${escape(buff.label)}" placeholder="例如：安心"></label><label>强度（1–3）<input data-emotion-field="intensity" type="number" min="1" max="3" value="${buff.intensity || 2}"></label><label>简短说明<input data-emotion-field="description" value="${escape(buff.description || '')}" placeholder="说说此刻的感受"></label></div><button type="button" class="btn btn-small btn-secondary" data-emotion-action="remove">移除</button></div>`;
    }

    async function render() {
        const character = currentCharacter();
        const summary = document.getElementById('emotion-summary');
        const list = document.getElementById('emotion-buff-list');
        if (!character || !list) return;
        ensureSettings(character);
        const state = stateFor(character);
        if (summary) summary.textContent = `${character.remarkName || character.name || '角色'} · 当前心情`;
        document.getElementById('emotion-updated-at').textContent = state.updatedAt ? `最近更新 · ${new Date(state.updatedAt).toLocaleString()}` : '还没有记录';
        document.getElementById('emotion-state-list').innerHTML = state.activeBuffs.length
            ? state.activeBuffs.map(buff => `<article class="emotion-state-item"><div><strong>${escape(buff.emoji || '')} ${escape(buff.label)}</strong><small>强度 · ${escape(Core.INTENSITIES[buff.intensity])}</small></div>${buff.description ? `<p>${escape(buff.description)}</p>` : ''}</article>`).join('')
            : '<div class="emotion-empty">还没有记录当前心情。可以新增情绪，或根据对话评估。</div>';
        for (const [id, text] of [['emotion-expression-preview', state.buffInjection], ['emotion-inner-preview', state.innerState]]) {
            const note = document.getElementById(id);
            note.hidden = !text;
            note.querySelector('p').textContent = text;
        }
        list.innerHTML = state.activeBuffs.length ? state.activeBuffs.map(editorRow).join('') : '<div class="emotion-empty">还没有添加情绪。</div>';
        const injection = document.getElementById('emotion-injection');
        const inner = document.getElementById('emotion-inner-state');
        if (injection) injection.value = character.buffInjection || '';
        if (inner) inner.value = character.emotionInnerState || '';
        setEditing(ui.editing);
    }

    function addBuff() {
        const list = document.getElementById('emotion-buff-list');
        if (!list) return;
        setEditing(true);
        const empty = list.querySelector('.emotion-empty');
        if (empty) empty.remove();
        const index = list.querySelectorAll('[data-emotion-index]').length;
        list.insertAdjacentHTML('beforeend', editorRow({}, index));
        list.lastElementChild.querySelector('input')?.focus({ preventScroll: true });
    }

    async function saveFromUi() {
        const character = currentCharacter();
        if (!character) return;
        const previous = Object.fromEntries(['activeBuffs', 'buffInjection', 'emotionInnerState', 'emotionUpdatedAt', 'emotionRevision'].map(key => [key, character[key]]));
        const buffs = Array.from(document.querySelectorAll('#emotion-buff-list [data-emotion-index]')).map((row, index) => ({
            id: `manual_${index}`,
            name: row.querySelector('[data-emotion-field="label"]')?.value || '',
            label: row.querySelector('[data-emotion-field="label"]')?.value || '',
            intensity: row.querySelector('[data-emotion-field="intensity"]')?.value,
            description: row.querySelector('[data-emotion-field="description"]')?.value || '',
        }));
        try {
            await saveManualState(character, { activeBuffs: buffs, buffInjection: document.getElementById('emotion-injection')?.value || '', innerState: document.getElementById('emotion-inner-state')?.value || '' });
            global.showToast?.('角色情绪已保存');
            if (currentCharacter()?.id === character.id) { setEditing(false); await render(); document.getElementById('emotion-edit-btn')?.focus({ preventScroll: true }); }
        } catch (error) {
            if (character.emotionRevision === Math.max(0, Number(previous.emotionRevision) || 0) + 1) Object.assign(character, previous);
            global.showToast?.(error?.message || '保存情绪失败，请重试');
        }
    }

    function open(characterId, options = {}) {
        const nextId = characterId || global.currentChatId || '';
        const preserveView = ui.characterId === nextId && (options.preserveView || ui.editing);
        ui.characterId = nextId;
        if (!preserveView) ui.editing = false;
        global.CharacterStatusUI.show(ui.characterId, 'emotion');
        if (!preserveView) return render();
    }

    function setup() {
        document.getElementById('setting-open-emotion-btn')?.addEventListener('click', () => open(global.currentChatId));
        document.getElementById('emotion-open-btn')?.addEventListener('click', () => open(global.currentChatId));
        document.getElementById('emotion-add-btn')?.addEventListener('click', addBuff);
        document.getElementById('emotion-edit-btn')?.addEventListener('click', () => { setEditing(true); document.querySelector('#emotion-buff-list input')?.focus({ preventScroll: true }); });
        document.getElementById('emotion-cancel-btn')?.addEventListener('click', async () => { setEditing(false); await render(); document.getElementById('emotion-edit-btn')?.focus({ preventScroll: true }); });
        document.getElementById('emotion-save-btn')?.addEventListener('click', () => void saveFromUi());
        document.getElementById('emotion-clear-btn')?.addEventListener('click', async () => { const character = currentCharacter(); if (character) { await clear(character); await render(); } });
        document.getElementById('emotion-evaluate-btn')?.addEventListener('click', async () => { const character = currentCharacter(); if (character) { const result = await evaluate(character, { force: true }); if (result.error) global.showToast?.(`情绪评估失败：${result.error}`); await render(); } });
        document.getElementById('emotion-buff-list')?.addEventListener('click', event => { if (event.target.closest('[data-emotion-action="remove"]')) event.target.closest('[data-emotion-index]')?.remove(); });
    }

    global.Emotion = { VERSION: Core?.VERSION || 1, ensureSettings, evaluate, prepareContext, getContext, saveManualState, clear, open, render, setup };
    global.prepareEmotionContext = prepareContext;
    global.getEmotionContextBlock = getContext;
    global.setupEmotionScreen = setup;
})(typeof window !== 'undefined' ? window : globalThis);
