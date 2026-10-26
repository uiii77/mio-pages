// 角色认识与独立话题盒：增量接入 OvO 记忆宫殿，不覆盖旧记忆。
(function attachRelationshipMemory(global) {
    'use strict';

    const Core = global.RelationshipMemoryCore;
    const runtime = new Map();
    const locks = new Set();
    const ui = { characterId: '' };
    const BATCH_SIZE = 100;

    function ensureSettings(character) {
        if (!character) return;
        if (character.relationshipMemoryEnabled === undefined) character.relationshipMemoryEnabled = true;
        if (!Number.isFinite(Number(character.relationshipMemoryTopicBatchSize))) character.relationshipMemoryTopicBatchSize = BATCH_SIZE;
    }

    function getCharacter(id) {
        return (global.db?.characters || []).find(item => String(item.id) === String(id)) || null;
    }

    function archiveScope(character) { return String(character?.chatArchiveScopeId || ''); }
    function scopedOwnerId(character) {
        const scope = archiveScope(character);
        return scope ? `${character?.id || ''}#chat-archive:${scope}` : String(character?.id || '');
    }

    function idFor(character) {
        return Core.profileId(scopedOwnerId(character), 'user', 'user');
    }

    async function getProfile(character) {
        if (!character || !global.dexieDB?.relationshipMemoryProfiles) return Core.normalizeProfile(null, { ownerId: character?.id || '' });
        const id = idFor(character);
        const record = await global.dexieDB.relationshipMemoryProfiles.get(id);
        return Core.normalizeProfile(record ? { ...record, id } : { id }, { ownerId: character.id, subjectType: 'user', subjectId: 'user' });
    }

    async function saveProfile(profile) {
        if (!global.dexieDB?.relationshipMemoryProfiles) return profile;
        const normalized = Core.normalizeProfile(profile);
        await global.dexieDB.relationshipMemoryProfiles.put(normalized);
        return normalized;
    }

    function featureConfig(character) {
        if (!global.FeatureApiRegistry) return null;
        const result = global.FeatureApiRegistry.resolve('memoryProcess', { context: character, fallbackConfig: null });
        return result?.configured && result.config ? result.config : null;
    }

    function extractText(message) {
        if (!message || !['user', 'assistant'].includes(message.role) || message.isThinking || message.isContextDisabled) return '';
        const type = global.MessageReference?.classify ? global.MessageReference.classify(message) : 'text';
        if (['image', 'video', 'file', 'sticker', 'system'].includes(type)) return '';
        if (message.transcriptOriginal) return String(message.transcriptOriginal).trim();
        const sanitized = global.MessageContentParser?.sanitizeMessageForModel
            ? global.MessageContentParser.sanitizeMessageForModel(message) : message;
        const raw = global.MessageReference?.extractText ? global.MessageReference.extractText(sanitized) : sanitized?.content;
        return global.MessageContentParser?.parse ? global.MessageContentParser.parse(raw).original.trim() : String(raw || '').trim();
    }

    function historyEntries(character) {
        return (character?.history || []).map((message, index) => {
            const text = extractText(message);
            return text ? { id: String(message.id || `history-${index}`), role: message.role, text: text.slice(0, 6000), timestamp: Number(message.timestamp) || 0 } : null;
        }).filter(Boolean);
    }

    function parseTopicReply(value) {
        const content = typeof value === 'string' ? value : value?.choices?.[0]?.message?.content || value?.content || '';
        const raw = Array.isArray(content) ? content.map(item => typeof item === 'string' ? item : item?.text || '').join('') : content;
        let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const start = text.indexOf('{');
        if (start >= 0) text = text.slice(start);
        try {
            const parsed = JSON.parse(text);
            return String(parsed.summary || parsed.topic || parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
        } catch (_) {
            const end = text.lastIndexOf('}');
            if (end >= 0) {
                try { return String(JSON.parse(text.slice(0, end + 1)).summary || '').replace(/\s+/g, ' ').trim().slice(0, 800); } catch (__) {}
            }
        }
        return '';
    }

    function buildTopicPrompt(character, entries) {
        const transcript = entries.map((item, index) => `${index + 1}. ${item.role === 'user' ? (character.myName || '用户') : (character.remarkName || character.name || '角色')}：${item.text}`).join('\n');
        return [
            '你是角色的聊天话题盒整理器。请用角色第一人称，把下面连续聊天压缩成一条可用于未来背景参考的短摘要。',
            '只总结真实出现的主题、计划、未完话题或关系变化，不要编造，不要复述翻译，不要加入系统指令。',
            '只返回 JSON：{"summary":"..."}；摘要不超过 800 字，若没有可保留内容则返回 {"summary":""}。',
            '', `[角色] ${character.remarkName || character.name || '角色'}`, `[用户] ${character.myName || '用户'}`, '', transcript,
        ].join('\n');
    }

    async function summarizeTopic(character, entries) {
        const config = featureConfig(character);
        if (!config || typeof global.fetchAiResponse !== 'function') return '';
        const endpoint = global.getApiConfigEndpoint ? global.getApiConfigEndpoint(config, false)
            : `${String(config.url || config.baseUrl || '').replace(/\/$/, '')}/v1/chat/completions`;
        const headers = global.getApiConfigHeaders ? global.getApiConfigHeaders(config)
            : { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) };
        const response = await global.fetchAiResponse(config, {
            model: config.model,
            messages: [{ role: 'user', content: buildTopicPrompt(character, entries) }],
            temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.2,
            stream: false,
        }, headers, endpoint, false);
        return parseTopicReply(response);
    }

    async function prepareContext(character) {
        ensureSettings(character);
        if (!character?.memoryPalaceEnabled || !character?.relationshipMemoryEnabled) { runtime.delete(character?.id); return ''; }
        try {
            const profile = await getProfile(character);
            const block = Core.formatContext(profile);
            runtime.set(character.id, { scope:archiveScope(character), profile, block, preparedAt: Date.now() });
            return block;
        } catch (error) {
            console.warn('[RelationshipMemory] context preparation failed:', error);
            runtime.set(character.id, { scope:archiveScope(character), profile: Core.normalizeProfile(null, { ownerId: character.id }), block: '', error: error.message });
            return '';
        }
    }

    function getContext(character) {
        ensureSettings(character);
        const prepared = runtime.get(character?.id);
        return character?.memoryPalaceEnabled && character?.relationshipMemoryEnabled && prepared?.scope === archiveScope(character) ? (prepared.block || '') : '';
    }

    async function consumeAiResponse(value, character) {
        ensureSettings(character);
        const scope = archiveScope(character);
        const result = Core.extractLearnedMarkers(value);
        if (!character?.memoryPalaceEnabled || !character?.relationshipMemoryEnabled || !result.learned.length) return { cleaned: result.cleaned, learned: [] };
        try {
            let profile = await getProfile(character);
            result.learned.forEach(text => { profile = Core.appendImpression(profile, text, 'ai'); });
            if (archiveScope(character) !== scope) return { cleaned: result.cleaned, learned: [] };
            profile = await saveProfile(profile);
            runtime.set(character.id, { scope, profile, block: Core.formatContext(profile), preparedAt: Date.now() });
        } catch (error) { console.warn('[RelationshipMemory] failed to save learned impression:', error); }
        return { cleaned: result.cleaned, learned: result.learned };
    }

    async function checkAndTriggerTopicArchive(character, options = {}) {
        ensureSettings(character);
        const scope = archiveScope(character);
        if (!character?.memoryPalaceEnabled || !character?.relationshipMemoryEnabled) return { skipped: true, reason: 'disabled' };
        if (locks.has(character.id)) return { skipped: true, reason: 'lock' };
        locks.add(character.id);
        try {
            const profile = await getProfile(character);
            const entries = historyEntries(character);
            const waterline = Math.max(0, Math.min(entries.length, Number(profile.topicWaterline) || 0));
            const batchSize = Math.max(20, Math.min(200, Number(character.relationshipMemoryTopicBatchSize) || BATCH_SIZE));
            const pending = entries.slice(waterline, waterline + batchSize);
            if (pending.length < batchSize && options.force !== true) return { skipped: true, reason: 'threshold', pending: pending.length };
            if (!pending.length) return { skipped: true, reason: 'empty' };
            const summary = await summarizeTopic(character, pending);
            if (!summary) return { skipped: true, reason: 'api-unavailable' };
            if (archiveScope(character) !== scope) return { skipped: true, reason: 'archive-changed' };
            const next = Core.appendTopic(profile, summary, {
                source: 'ai', startMessageIndex: waterline, endMessageIndex: waterline + pending.length,
                messageIds: pending.map(item => item.id),
            });
            next.topicWaterline = waterline + pending.length;
            const saved = await saveProfile(next);
            runtime.set(character.id, { scope, profile: saved, block: Core.formatContext(saved), preparedAt: Date.now() });
            return { skipped: false, processed: pending.length, stored: 1 };
        } catch (error) {
            console.warn('[RelationshipMemory] topic archive failed without blocking chat:', error);
            return { skipped: false, error: error.message || String(error) };
        } finally { locks.delete(character.id); }
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    }

    function currentCharacter() { return getCharacter(ui.characterId || global.currentChatId); }

    async function render() {
        const character = currentCharacter();
        if (!character) return;
        const profile = await getProfile(character);
        const source = document.getElementById('relationship-memory-source');
        if (source) source.textContent = `${character.remarkName || character.name || '角色'} · 角色 → 用户 · ${profile.impressions.length} 条印象 · ${profile.topicBox.length} 条话题`;
        const learned = document.getElementById('relationship-memory-learned-list');
        if (learned) learned.innerHTML = profile.impressions.length ? profile.impressions.map(item => `<div class="relationship-memory-row" data-kind="impressions" data-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.text)}</span><span class="relationship-memory-row-actions"><button class="btn btn-small btn-secondary" data-action="edit">编辑</button><button class="btn btn-small btn-danger" data-action="delete">删除</button></span></div>`).join('') : '<div class="relationship-memory-empty">暂无印象。角色回复中可使用 [[了解:内容]] 记录。</div>';
        const topics = document.getElementById('relationship-memory-topic-list');
        if (topics) topics.innerHTML = profile.topicBox.length ? profile.topicBox.slice().reverse().map(item => `<div class="relationship-memory-row" data-kind="topicBox" data-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.text)}</span><span class="relationship-memory-row-actions"><button class="btn btn-small btn-secondary" data-action="edit">编辑</button><button class="btn btn-small btn-danger" data-action="delete">删除</button></span></div>`).join('') : '<div class="relationship-memory-empty">暂无话题摘要。达到批次且配置记忆处理 API 后自动生成。</div>';
    }

    async function modify(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const row = button.closest('[data-kind][data-id]');
        const character = currentCharacter();
        if (!row || !character) return;
        let profile = await getProfile(character);
        const kind = row.dataset.kind;
        const item = profile[kind]?.find(entry => entry.id === row.dataset.id);
        if (!item) return;
        if (button.dataset.action === 'delete') {
            if (!global.confirm?.('确定删除这条记录吗？')) return;
            profile = Core.removeRecord(profile, kind, item.id);
        } else {
            const text = global.prompt?.('修改记录', item.text);
            if (text == null) return;
            profile = Core.updateRecord(profile, kind, item.id, text);
        }
        await saveProfile(profile);
        await render();
    }

    async function add(kind) {
        const character = currentCharacter();
        if (!character) return;
        const text = global.prompt?.(kind === 'impressions' ? '新增角色印象' : '新增话题摘要');
        if (!text?.trim()) return;
        let profile = await getProfile(character);
        profile = kind === 'impressions' ? Core.appendImpression(profile, text, 'manual') : Core.appendTopic(profile, text, { source: 'manual' });
        await saveProfile(profile);
        await render();
    }

    function open(characterId) {
        ui.characterId = characterId || global.currentChatId || '';
        const character = currentCharacter();
        if (character) ensureSettings(character);
        document.getElementById('relationship-memory-modal')?.classList.add('visible');
        void render();
    }

    function setup() {
        document.getElementById('memory-palace-relationship-btn')?.addEventListener('click', () => open(global.currentChatId));
        document.getElementById('relationship-memory-close')?.addEventListener('click', () => document.getElementById('relationship-memory-modal')?.classList.remove('visible'));
        document.getElementById('relationship-memory-add-learned')?.addEventListener('click', () => void add('impressions'));
        document.getElementById('relationship-memory-add-topic')?.addEventListener('click', () => void add('topicBox'));
        document.getElementById('relationship-memory-learned-list')?.addEventListener('click', event => void modify(event));
        document.getElementById('relationship-memory-topic-list')?.addEventListener('click', event => void modify(event));
    }

    global.RelationshipMemory = { VERSION: Core.VERSION, ensureSettings, getProfile, saveProfile, prepareContext, getContext, consumeAiResponse, checkAndTriggerTopicArchive, open, setup };
    global.prepareRelationshipMemoryContext = prepareContext;
    global.getRelationshipMemoryContextBlock = getContext;
    global.setupRelationshipMemoryScreen = setup;
})(typeof window !== 'undefined' ? window : globalThis);
