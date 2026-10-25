(function attachCoupleSpace(global) {
    'use strict';

    const state = { characterId: '', space: null, items: [], editingId: '', loading: false };
    const byId = id => global.document?.getElementById(id);
    const core = () => global.CoupleSpaceCore;
    const spaces = () => global.dexieDB?.coupleSpaces;
    const itemsTable = () => global.dexieDB?.coupleSpaceItems;
    const roles = () => Array.isArray(global.db?.characters) ? global.db.characters : [];
    const role = () => roles().find(item => String(item.id) === String(state.characterId)) || null;
    const notify = message => global.showToast?.(message);
    const esc = value => String(value == null ? '' : value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
    const roleName = value => String(value?.remarkName || value?.realName || value?.name || value?.id || '角色');
    const kindLabel = kind => core().LABELS[kind] || '共同内容';

    function today() {
        const clock = global.VirtualClock;
        if (clock?.dateKey && clock?.resolveUser) {
            try { return clock.dateKey(clock.resolveUser(null, global.db?.userTimeline)); } catch (_) {}
        }
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function currentId() {
        try { if (typeof currentChatId !== 'undefined' && currentChatId) return currentChatId; } catch (_) {}
        return global.currentChatId || '';
    }

    function binding() {
        return global.FeatureApiRegistry?.readRegistry(global.db) || { schemaVersion: 1, configs: {}, routes: {} };
    }

    function resolveApi() {
        return global.FeatureApiRegistry?.resolve('coupleSpace', { registry: global.db?.apiFeatureRegistry }) || { enabled: false, configured: false, reason: 'registry-unavailable' };
    }

    function apiConfigId() { return 'couple-space-global'; }

    function apiStatus(result) {
        if (result?.configured) return result.enabled ? `已配置 · ${result.config?.model || '默认模型'}` : '已关闭';
        if (result?.reason === 'disabled') return '已关闭';
        return '未配置；当前版本不会自动调用';
    }

    function renderRoles() {
        const select = byId('couple-space-role-select');
        if (!select) return;
        const preferred = state.characterId || currentId() || roles()[0]?.id || '';
        select.innerHTML = roles().map(item => `<option value="${esc(item.id)}">${esc(roleName(item))}</option>`).join('');
        state.characterId = roles().some(item => String(item.id) === String(preferred)) ? String(preferred) : String(roles()[0]?.id || '');
        select.value = state.characterId;
    }

    function renderApi() {
        const result = resolveApi();
        const registry = binding();
        const route = registry.routes?.coupleSpace || {};
        const config = registry.configs?.[route.configId] || result.config || {};
        const enabled = byId('couple-space-api-enabled');
        if (enabled) enabled.checked = route.enabled === true;
        const url = byId('couple-space-api-url');
        if (url) url.value = config.url || config.baseUrl || '';
        const key = byId('couple-space-api-key');
        if (key) key.value = config.key || config.apiKey || '';
        const model = byId('couple-space-api-model');
        if (model) model.value = config.model || '';
        const status = byId('couple-space-api-status');
        if (status) status.textContent = apiStatus(result);
    }

    function renderSpace() {
        const current = role();
        const space = state.space || core().normalizeSpace(null, state.characterId);
        const title = byId('couple-space-title');
        if (title) title.textContent = current ? `${roleName(current)} 的情侣空间` : '情侣空间';
        const status = byId('couple-space-status');
        if (status) status.textContent = core().LABELS[space.status] || space.status;
        const detail = byId('couple-space-detail');
        if (detail) {
            const details = {
                none: '还没有建立空间。发出邀请后，由你确认接受或拒绝。',
                invited: '邀请已记录在本机，等待你确认对方是否接受。',
                active: '空间正在使用中，可以维护共同内容。',
                rejected: '这次邀请已标记为拒绝；可以重新发起邀请。',
                paused: '空间已暂停，历史仍保留；恢复后才能编辑共同内容。',
                ended: '关系已解除，历史仍保留；重新开始需要发起新的邀请。'
            };
            detail.textContent = details[space.status] || '';
        }
        const buttons = {
            invite: byId('couple-space-invite-btn'), accept: byId('couple-space-accept-btn'), reject: byId('couple-space-reject-btn'),
            pause: byId('couple-space-pause-btn'), resume: byId('couple-space-resume-btn'), end: byId('couple-space-end-btn'),
            remove: byId('couple-space-delete-btn')
        };
        Object.values(buttons).forEach(button => { if (button) button.hidden = true; });
        if (space.status === 'none' || space.status === 'rejected' || space.status === 'ended') buttons.invite.hidden = false;
        if (space.status === 'invited') { buttons.accept.hidden = false; buttons.reject.hidden = false; }
        if (space.status === 'active') buttons.pause.hidden = false;
        if (space.status === 'paused') buttons.resume.hidden = false;
        if (['invited', 'active', 'paused'].includes(space.status)) buttons.end.hidden = false;
        if (space.status !== 'none') buttons.remove.hidden = false;
        const editable = core().canEdit(space.status);
        const form = byId('couple-space-item-form');
        if (form) form.classList.toggle('is-readonly', !editable);
        ['couple-space-item-kind', 'couple-space-item-title', 'couple-space-item-date', 'couple-space-item-owner', 'couple-space-item-status', 'couple-space-item-body', 'couple-space-item-save-btn'].forEach(id => { const element = byId(id); if (element) element.disabled = !editable; });
        const hint = byId('couple-space-edit-hint');
        if (hint) hint.textContent = editable ? '共同内容仅由你手动保存；本版本不会自动让角色写入。' : '空间暂停或解除后只读，历史不会自动删除。';
    }

    function renderForm() {
        const item = state.editingId ? state.items.find(value => value.id === state.editingId) : null;
        const kind = byId('couple-space-item-kind');
        const title = byId('couple-space-item-title');
        const date = byId('couple-space-item-date');
        const owner = byId('couple-space-item-owner');
        const status = byId('couple-space-item-status');
        const body = byId('couple-space-item-body');
        if (kind) kind.value = item?.kind || 'note';
        if (title) title.value = item?.title || '';
        if (date) date.value = item?.date || (item ? '' : today());
        if (owner) owner.value = item?.owner || 'shared';
        if (status) status.value = item?.status || 'open';
        if (body) body.value = item?.body || '';
        const save = byId('couple-space-item-save-btn');
        if (save) save.textContent = item ? '保存修改' : '添加到空间';
        const cancel = byId('couple-space-item-cancel-btn');
        if (cancel) cancel.hidden = !item;
    }

    function renderItems() {
        const list = byId('couple-space-item-list');
        const empty = byId('couple-space-item-empty');
        if (!list) return;
        if (!state.items.length) {
            list.innerHTML = '';
            if (empty) empty.hidden = false;
            return;
        }
        if (empty) empty.hidden = true;
        list.innerHTML = core().sortItems(state.items).map(item => `<article class="couple-space-item" data-item-id="${esc(item.id)}"><div class="couple-space-item-head"><span class="couple-space-item-kind">${esc(kindLabel(item.kind))}</span><span>${esc(item.date || '无日期')}</span></div><h3>${esc(item.title || '未命名内容')}</h3>${item.body ? `<p>${esc(item.body).replace(/\n/g, '<br>')}</p>` : ''}<div class="couple-space-item-meta"><span>${esc(item.owner === 'user' ? '我' : item.owner === 'character' ? '角色' : '共同')} · ${esc(core().LABELS[item.status] || item.status)}</span><span class="couple-space-item-actions"><button type="button" class="btn btn-small btn-secondary" data-couple-action="edit">编辑</button>${item.kind === 'wish' && core().canEdit(state.space?.status) ? `<button type="button" class="btn btn-small btn-secondary" data-couple-action="toggle">${item.status === 'done' ? '重新打开' : '完成'}</button>` : ''}<button type="button" class="btn btn-small btn-danger" data-couple-action="delete">删除</button></span></div></article>`).join('');
    }

    function render() {
        renderRoles();
        renderSpace();
        renderForm();
        renderItems();
        renderApi();
    }

    async function load() {
        const characterId = String(state.characterId || '');
        if (!characterId || !spaces() || !itemsTable()) {
            state.space = core().normalizeSpace(null, characterId);
            state.items = [];
            render();
            return state.space;
        }
        state.loading = true;
        try {
            const [space, items] = await Promise.all([spaces().get(core().spaceId(characterId)), itemsTable().where('characterId').equals(characterId).toArray()]);
            state.space = core().normalizeSpace(space, characterId);
            state.items = core().sortItems(items.map(item => core().normalizeItem(item)));
        } finally {
            state.loading = false;
        }
        render();
        return state.space;
    }

    async function selectRole(characterId) {
        state.characterId = String(characterId || '');
        state.editingId = '';
        await load();
    }

    async function applyTransition(action) {
        if (!state.characterId) return notify('请先选择角色');
        const result = core().transition(state.space, action);
        if (!result.ok) return notify('当前状态不能执行该操作');
        state.space = result.space;
        if (spaces()) await spaces().put(state.space);
        render();
        notify(`情侣空间${core().LABELS[state.space.status] || '状态'}已保存`);
    }

    async function deleteSpace() {
        if (!state.characterId || !spaces() || !itemsTable()) return false;
        if (!global.confirm?.('确定删除该角色的情侣空间及其中的纪念日、便签、愿望和里程碑吗？聊天、日记、钱包、记忆和生理期数据不会删除。')) return false;
        const records = await itemsTable().where('characterId').equals(state.characterId).toArray();
        if (records.length) await itemsTable().bulkDelete(records.map(item => item.id));
        await spaces().delete(core().spaceId(state.characterId));
        state.space = core().normalizeSpace(null, state.characterId);
        state.items = [];
        state.editingId = '';
        render();
        notify('情侣空间数据已删除，其他模块未受影响');
        return true;
    }

    async function saveItem() {
        if (!core().canEdit(state.space?.status)) return notify('请先让情侣空间进入进行中状态');
        const title = byId('couple-space-item-title')?.value.trim() || '';
        const body = byId('couple-space-item-body')?.value || '';
        const date = byId('couple-space-item-date')?.value || '';
        if (!title && !body.trim()) return notify('请填写标题或内容');
        if (date && !core().validDate(date)) return notify('日期格式无效');
        const existing = state.editingId ? state.items.find(item => item.id === state.editingId) : null;
        const now = Date.now();
        const value = core().createItem({
            ...(existing || {}), characterId: state.characterId, spaceId: core().spaceId(state.characterId),
            kind: byId('couple-space-item-kind')?.value, title, body, date,
            owner: byId('couple-space-item-owner')?.value, status: byId('couple-space-item-status')?.value,
            createdAt: existing?.createdAt
        }, existing?.id || `couple-item:${state.characterId}:${now}:${Math.random().toString(36).slice(2, 8)}`, now);
        if (!itemsTable()) return notify('情侣空间数据库尚未初始化');
        await itemsTable().put(value);
        state.items = core().sortItems([...state.items.filter(item => item.id !== value.id), value]);
        state.editingId = '';
        render();
        notify(existing ? '共同内容已更新' : '共同内容已添加');
    }

    function editItem(id) {
        if (!core().canEdit(state.space?.status)) return notify('空间当前为只读');
        if (!state.items.some(item => item.id === id)) return;
        state.editingId = id;
        renderForm();
        byId('couple-space-item-title')?.focus();
    }

    async function toggleItem(id) {
        if (!core().canEdit(state.space?.status)) return notify('空间当前为只读');
        const current = state.items.find(item => item.id === id);
        if (!current || current.kind !== 'wish' || !itemsTable()) return;
        const updated = core().normalizeItem({ ...current, status: current.status === 'done' ? 'open' : 'done', updatedAt: Date.now() });
        await itemsTable().put(updated);
        state.items = core().sortItems(state.items.map(item => item.id === id ? updated : item));
        renderItems();
    }

    async function deleteItem(id) {
        if (!itemsTable() || !global.confirm?.('确定删除这条情侣空间内容吗？')) return false;
        await itemsTable().delete(id);
        state.items = state.items.filter(item => item.id !== id);
        if (state.editingId === id) state.editingId = '';
        render();
        notify('共同内容已删除');
        return true;
    }

    async function saveApiSettings() {
        const enabled = byId('couple-space-api-enabled')?.checked === true;
        const configId = apiConfigId();
        const config = { id: configId, name: '情侣空间', feature: 'coupleSpace', service: 'llm', provider: 'newapi', url: byId('couple-space-api-url')?.value.trim() || '', key: byId('couple-space-api-key')?.value.trim() || '', model: byId('couple-space-api-model')?.value.trim() || '', enabled: true };
        let registry = binding();
        if (config.url || config.key || config.model) registry = global.FeatureApiRegistry.upsertConfig(registry, config, configId);
        registry = global.FeatureApiRegistry.setRoute(registry, 'coupleSpace', { enabled, configId, fallbackMode: 'none' });
        global.db.apiFeatureRegistry = registry;
        const saved = typeof global.saveGlobalSettings === 'function' ? await global.saveGlobalSettings(['apiFeatureRegistry']) : false;
        if (saved === false) return notify('情侣空间 API 设置保存失败');
        renderApi();
        notify('情侣空间 API 设置已保存；当前版本不会自动调用');
    }

    function openDiary() {
        if (!state.characterId) return notify('请先选择角色');
        if (global.ExchangeDiary?.open) return void global.ExchangeDiary.open(state.characterId);
        notify('交换日记模块尚未加载');
    }

    function showScreen() {
        if (typeof global.switchScreen === 'function') global.switchScreen('couple-space-screen');
        else { try { if (typeof switchScreen === 'function') switchScreen('couple-space-screen'); } catch (_) {} }
    }

    async function open(characterId = '') {
        const next = String(characterId || currentId() || roles()[0]?.id || '');
        if (!next || !roles().some(item => String(item.id) === next)) return notify('请先创建角色');
        state.characterId = next;
        state.editingId = '';
        await load();
        showScreen();
        render();
    }

    function setup() {
        const screen = byId('couple-space-screen');
        if (!screen || screen.dataset.ready) return;
        screen.dataset.ready = 'true';
        byId('couple-space-role-select')?.addEventListener('change', event => void selectRole(event.target.value));
        byId('couple-space-invite-btn')?.addEventListener('click', () => void applyTransition('invite'));
        byId('couple-space-accept-btn')?.addEventListener('click', () => void applyTransition('accept'));
        byId('couple-space-reject-btn')?.addEventListener('click', () => void applyTransition('reject'));
        byId('couple-space-pause-btn')?.addEventListener('click', () => void applyTransition('pause'));
        byId('couple-space-resume-btn')?.addEventListener('click', () => void applyTransition('resume'));
        byId('couple-space-end-btn')?.addEventListener('click', () => void applyTransition('end'));
        byId('couple-space-delete-btn')?.addEventListener('click', () => void deleteSpace());
        byId('couple-space-item-save-btn')?.addEventListener('click', () => void saveItem());
        byId('couple-space-item-cancel-btn')?.addEventListener('click', () => { state.editingId = ''; renderForm(); });
        byId('couple-space-item-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-couple-action]');
            const item = button?.closest('[data-item-id]');
            if (!button || !item) return;
            const id = item.getAttribute('data-item-id');
            if (button.dataset.coupleAction === 'edit') editItem(id);
            if (button.dataset.coupleAction === 'toggle') void toggleItem(id);
            if (button.dataset.coupleAction === 'delete') void deleteItem(id);
        });
        byId('couple-space-open-diary-btn')?.addEventListener('click', openDiary);
        byId('couple-space-api-save-btn')?.addEventListener('click', () => void saveApiSettings());
        render();
    }

    global.CoupleSpace = { setup, open, load, render, saveItem, deleteItem, deleteSpace, applyTransition, saveApiSettings, resolveApi, get state() { return state; } };
})(window);
