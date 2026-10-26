(function attachExchangeDiary(global) {
    'use strict';
    const state = { characterId: '', date: '', entry: null, busy: false };
    const byId = id => global.document?.getElementById(id);
    const core = () => global.ExchangeDiaryCore;
    const table = () => global.dexieDB?.exchangeDiaryEntries;
    const notify = message => global.showToast?.(message);
    const roles = () => Array.isArray(global.db?.characters) ? global.db.characters : [];
    const role = () => roles().find(item => String(item.id) === state.characterId) || null;
    function currentType() { try { if (typeof currentChatType !== 'undefined') return currentChatType; } catch (_) {} return global.currentChatType || ''; }
    function currentId() { try { if (typeof currentChatId !== 'undefined') return currentChatId; } catch (_) {} return global.currentChatId || ''; }
    function characterName(value) { return value?.remarkName || value?.realName || value?.name || '角色'; }
    function escapeHtml(value) { const node = global.document.createElement('div'); node.textContent = String(value ?? ''); return node.innerHTML; }
    function todayFor(character) {
        const clock = global.VirtualClock;
        if (clock?.dateKey && clock?.resolveCharacter) return clock.dateKey(clock.resolveCharacter(character));
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    function binding() { return global.FeatureApiRegistry?.readRegistry(global.db) || { schemaVersion: 1, configs: {}, routes: {} }; }
    function resolveApi() { return global.FeatureApiRegistry?.resolve('exchangeDiary', { context:role(),registry: global.db?.apiFeatureRegistry }) || { enabled: false, configured: false, reason: 'registry-unavailable' }; }
    function apiStatus(result) {return global.FeatureApiRegistry?.sourceLabel(result)||'请配置主 API';}
    function apiConfigId() { return 'exchange-diary-global'; }
    function persistGlobal(keys) { return typeof global.saveGlobalSettings === 'function' ? global.saveGlobalSettings(keys) : Promise.resolve(false); }
    async function persistEntry(value) { if (!table()) throw new Error('交换日记数据库尚未初始化'); const normalized = core().normalizeEntry({ ...value, updatedAt: Date.now() }, { characterId: state.characterId, date: state.date }); await table().put(normalized); state.entry = normalized; return normalized; }
    async function loadEntry() { if (!state.characterId || !state.date) { state.entry = null; return null; } const found = await table()?.get(core().entryId(state.characterId, state.date)); state.entry = found ? core().normalizeEntry(found) : core().emptyEntry(state.characterId, state.date); return state.entry; }
    function showScreen() { if (typeof global.switchScreen === 'function') global.switchScreen('exchange-diary-screen'); else { try { if (typeof switchScreen === 'function') switchScreen('exchange-diary-screen'); } catch (_) {} } }
    function renderRoles() { const select = byId('exchange-diary-role-select'); if (!select) return; const preferred = state.characterId || (currentType() === 'private' ? currentId() : '') || roles()[0]?.id || ''; select.innerHTML = roles().map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(characterName(item))}</option>`).join(''); state.characterId = roles().some(item => String(item.id) === String(preferred)) ? String(preferred) : String(roles()[0]?.id || ''); if (!state.date && role()) state.date = todayFor(role()); select.value = state.characterId; }
    function renderApi() {global.FeatureApiSettings?.mount('exchangeDiary','exchange-diary-api',apiConfigId());const status=byId('exchange-diary-api-status');if(status)status.textContent=apiStatus(resolveApi());}
    const field = name => byId('exchange-diary-screen')?.querySelector(`[data-diary-${name}]`);
    function showSettings(visible) {
        field('panel="pages"').hidden = visible;
        field('panel="settings"').hidden = !visible;
        field('settings').setAttribute('aria-expanded', String(visible));
        byId('exchange-diary-screen').querySelector('main').scrollTop = 0;
        (visible ? field('close-settings') : field('settings')).focus();
    }
    function renderStatus() {
        const current = role(), entry = state.entry || core().emptyEntry(state.characterId, state.date);
        const dateParts = state.date.split('-');
        if (field('date-heading')) field('date-heading').textContent = dateParts.length === 3 ? `${dateParts[0]} 年 ${Number(dateParts[1])} 月 ${Number(dateParts[2])} 日` : '今天的日记';
        if (field('character-heading')) field('character-heading').textContent = `${characterName(current)}写下的`;
        if (field('settings-role')) field('settings-role').textContent = `与 ${characterName(current)} 交换`;
        const stateEl = byId('exchange-diary-state');
        if (stateEl) stateEl.textContent = { draft: '还在书写', waiting: '等待回信…', replied: '已交换 · 双方都写下了', failed: '回信未送达，可重试' }[entry.status] || '还在书写';
        const archive = byId('exchange-diary-archive-status');
        if (archive) archive.textContent = entry.archiveStatus === 'archived' ? '已存入记忆' : entry.archiveStatus === 'failed' ? '归档失败，可重试' : '未归档';
        const request = byId('exchange-diary-request-btn');
        if (request) { request.disabled = state.busy || !current?.exchangeDiaryEnabled; request.textContent = state.busy ? '等待回信…' : entry.characterText ? '再邀请一次' : '邀请回复'; }
        for (const name of ['role-select', 'date', 'save-btn', 'archive-btn', 'clear-btn', 'user-text', 'character-text', 'role-save-btn', 'api-save-btn']) {
            const control = byId('exchange-diary-' + name); if (control) control.disabled = state.busy;
        }
        if (field('hint')) field('hint').textContent = state.busy ? '正在等待对方写下这一页…' : !current?.exchangeDiaryEnabled ? '可以先写下并保存。到右上角设置开启与对方交换。' : !resolveApi().configured || !resolveApi().enabled ? '日记可以保存在本地。邀请回复前，请在设置中配置回复服务。' : '保存只留在本地；邀请回复时才发送给回复服务。';
    }
    function renderReply() {
        const text = byId('exchange-diary-character-text')?.value || '';
        if (field('reply')) { field('reply').textContent = text || '写好这一页，邀请对方留下回信。'; field('reply').classList.toggle('is-empty', !text.trim()); }
    }
    function renderEntry() {
        const entry = state.entry || core().emptyEntry(state.characterId, state.date);
        const enabled = byId('exchange-diary-role-enabled'); if (enabled) enabled.checked = role()?.exchangeDiaryEnabled === true;
        const date = byId('exchange-diary-date'); if (date) date.value = state.date;
        const user = byId('exchange-diary-user-text'); if (user) user.value = entry.userText;
        const character = byId('exchange-diary-character-text'); if (character) character.value = entry.characterText;
        renderReply(); renderStatus();
    }
    async function confirmDiscard() {
        const entry = state.entry || {};
        if ((byId('exchange-diary-user-text')?.value || '') === (entry.userText || '') && (byId('exchange-diary-character-text')?.value || '') === (entry.characterText || '')) return true;
        return await global.showAppConfirmDialog({ title: '离开这页日记', message: '这页还有未保存的文字。放弃修改并翻到另一页？', confirmText: '放弃修改', cancelText: '继续写', dismissText: '' }) === 'confirm';
    }
    function render() { renderRoles(); renderEntry(); renderApi(); }
    async function selectRole(characterId) { byId('exchange-diary-role-select').value = state.characterId; if (state.busy || !await confirmDiscard()) return; state.characterId = String(characterId || ''); state.date = todayFor(role()); await loadEntry(); render(); }
    async function selectDate(date) { byId('exchange-diary-date').value = state.date; if (state.busy || !await confirmDiscard()) return; state.date = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : todayFor(role()); await loadEntry(); renderEntry(); }
    async function saveRoleSettings() { const current = role(); if (!current) return notify('请先选择角色'); current.exchangeDiaryEnabled = byId('exchange-diary-role-enabled')?.checked === true; const saved = await global.saveCharacter?.(current.id); if (saved === false) return notify('角色设置保存失败'); renderStatus(); notify(current.exchangeDiaryEnabled ? '已启用当前角色的交换日记' : '已关闭当前角色的交换日记'); }
    async function saveApiSettings() {const next=global.FeatureApiSettings.saveRegistryFeature(binding(),'exchangeDiary','exchange-diary-api',apiConfigId());await global.FeatureApiSettings.persistRegistry(next);renderApi();renderStatus();notify('交换日记 API 设置已保存');}
    function recentContext(current) { return (current?.history || []).filter(item => item && !item.isThinking && !item.isContextDisabled && !item.excludeFromContext).slice(-8).map(item => { const raw = global.MessageReference?.extractText ? global.MessageReference.extractText(item) : item.content || ''; const parsed = global.MessageContentParser?.parse ? global.MessageContentParser.parse(raw) : { original: raw }; return `${item.role === 'user' ? '用户' : characterName(current)}：${String(parsed.original || '').slice(0, 800)}`; }).join('\n'); }
    async function saveEntry() { const current = role(); if (!current) return null; const existing = state.entry || core().emptyEntry(current.id, state.date); const userText = byId('exchange-diary-user-text')?.value || ''; const characterText = byId('exchange-diary-character-text')?.value || ''; return persistEntry({ ...existing, characterId: current.id, date: state.date, userText, characterText, status: characterText.trim() ? 'replied' : 'draft', lastError: '', userUpdatedAt: userText.trim() ? Date.now() : existing.userUpdatedAt, characterUpdatedAt: characterText.trim() ? Date.now() : existing.characterUpdatedAt }); }
    async function requestReply() { if (state.busy) return; const current = role(); const userText = byId('exchange-diary-user-text')?.value.trim() || ''; if (!current) return notify('请先选择角色'); if (current.exchangeDiaryEnabled !== true) return notify('请先启用当前角色的交换日记'); if (!userText) return notify('请先写下今天的日记'); const api = resolveApi(); if (!api.enabled || !api.configured) return notify(api.reason === 'disabled' ? '交换日记 API 已关闭' : '请先配置并启用交换日记 API'); const base = state.entry || core().emptyEntry(current.id, state.date); state.busy = true; await persistEntry({ ...base, userText, status: 'waiting', lastError: '', userUpdatedAt: Date.now() }); renderEntry(); try { let persona = current.persona || ''; try { persona = global.getEffectivePersona?.(current) || persona; } catch (_) {} const messages = core().buildAiMessages({ roleName: characterName(current), persona, date: state.date, userText, recentContext: recentContext(current) }); if (typeof global.fetchAiResponse !== 'function') throw new Error('AI 请求服务尚未加载'); const config = api.config; const endpoint = global.getApiConfigEndpoint?.(config, false) || `${String(config.url || config.baseUrl || '').replace(/\/$/, '')}/v1/chat/completions`; const headers = global.getApiConfigHeaders?.(config) || { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) }; const response = await global.fetchAiResponse(config, { model: config.model, messages, temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.85, max_tokens: 1200, stream: false }, headers, endpoint, false); const characterText = core().parseReply(response); await persistEntry({ ...state.entry, characterText, status: 'replied', lastError: '', characterUpdatedAt: Date.now() }); renderEntry(); notify('角色已写下交换日记'); } catch (error) { await persistEntry({ ...state.entry, status: 'failed', lastError: error?.message || String(error) }); renderEntry(); notify(error?.message || '交换日记请求失败'); } finally { state.busy = false; renderEntry(); } }
    async function archiveEntry() { const current = role(); const entry = state.entry; if (!current || !entry || (!entry.userText && !entry.characterText)) return notify('当前没有可归档的日记'); if (entry.archiveStatus === 'archived') return notify('这篇交换日记已经归档'); const content = core().buildArchiveContent(entry, characterName(current)); try { let archiveNodeId = `exchange-diary-memory:${entry.id}`; if (global.MemoryPalace?.saveNode) { await global.MemoryPalace.saveNode({ id: archiveNodeId, characterId: current.id, content, room: 'living_room', layer: 'experience', tags: ['exchange_diary', entry.date], mood: 'exchange_diary', source: { type: 'exchange_diary', entryId: entry.id, date: entry.date } }, { silentEmbeddingError: true }); } else { throw new Error('记忆宫殿模块尚未加载'); } await persistEntry({ ...entry, archiveStatus: 'archived', archiveNodeId }); renderEntry(); notify('已归档到记忆宫殿'); } catch (error) { await persistEntry({ ...entry, archiveStatus: 'failed', lastError: error?.message || String(error) }); renderEntry(); notify(error?.message || '归档失败'); } }
    async function clearEntry(force = false) { if (!state.entry || !table()) return false; if (!force && await global.showAppConfirmDialog({ title: '清除当天日记', message: `清除 ${state.date} 你和${characterName(role())}的日记？此操作不能撤销，已归档的记忆仍保留。`, confirmText: '清除日记', cancelText: '取消', dismissText: '' }) !== 'confirm') return false; await table().delete(state.entry.id); state.entry = core().emptyEntry(state.characterId, state.date); renderEntry(); notify('当前交换日记已清除'); return true; }
    async function open(characterId = currentId()) {
        if (state.busy) { showScreen(); return notify('正在等待回信，请稍后再切换日记'); }
        const next = String(characterId || '');
        if (!next || !roles().some(item => String(item.id) === next)) return notify('请先选择一个角色');
        const source = global.document.querySelector('.screen.active')?.id;
        const back = byId('exchange-diary-screen')?.querySelector('.back-btn');
        if (back && source !== 'exchange-diary-screen') back.dataset.target = source === 'couple-space-screen' ? source : 'chat-room-screen';
        state.characterId = next;
        state.date = todayFor(role());
        await loadEntry();
        showScreen();
        render();
        showSettings(false);
    }
    function setup() { if (!byId('exchange-diary-screen') || byId('exchange-diary-screen').dataset.ready) return; byId('exchange-diary-screen').dataset.ready = 'true';
        field('settings')?.addEventListener('click', () => showSettings(field('panel="settings"').hidden));
        field('close-settings')?.addEventListener('click', () => showSettings(false));
        field('edit')?.addEventListener('click', () => {
            const editor = byId('exchange-diary-character-text'); editor.hidden = !editor.hidden;
            field('reply').hidden = !editor.hidden; field('edit').textContent = editor.hidden ? '修改' : '完成';
            field('edit').setAttribute('aria-expanded', String(!editor.hidden));
            renderReply(); if (!editor.hidden) editor.focus();
        });
        for (const id of ['exchange-diary-user-text', 'exchange-diary-character-text']) byId(id)?.addEventListener('input', () => {
            if (field('hint')) field('hint').textContent = '有未保存的文字，记得保存这一页。';
        }); byId('exchange-diary-role-select')?.addEventListener('change', event => void selectRole(event.target.value)); byId('exchange-diary-date')?.addEventListener('change', event => void selectDate(event.target.value)); byId('exchange-diary-role-save-btn')?.addEventListener('click', () => void saveRoleSettings()); byId('exchange-diary-api-save-btn')?.addEventListener('click', () => void saveApiSettings()); byId('exchange-diary-save-btn')?.addEventListener('click', () => void saveEntry().then(() => { renderEntry(); notify('交换日记已保存'); }).catch(error => notify(error?.message || '保存失败'))); byId('exchange-diary-request-btn')?.addEventListener('click', () => void (async () => {
            if (byId('exchange-diary-character-text')?.value.trim() && await global.showAppConfirmDialog({title:'重新邀请回复',message:'新的回信会替换当前对方的日记，是否继续？',confirmText:'重新邀请',cancelText:'保留这页',dismissText:''}) !== 'confirm') return;
            await requestReply();
        })().catch(error => notify(error?.message || '邀请失败'))); byId('exchange-diary-archive-btn')?.addEventListener('click', () => void saveEntry().then(archiveEntry).catch(error => notify(error?.message || '归档失败'))); byId('exchange-diary-clear-btn')?.addEventListener('click', () => void clearEntry()); render(); }
    global.ExchangeDiary = { setup, open, render, loadEntry, saveEntry, requestReply, archiveEntry, clearEntry, resolveApi, get state() { return state; } };
})(typeof window !== 'undefined' ? window : globalThis);
