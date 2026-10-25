(function attachPeriodHealth(global) {
    'use strict';

    const state = { records: [], settings: null, roleId: '', loading: false };
    const promptCache = new Map();
    const sharingSaves = new Set();
    let settingsSaving = false;
    let recording = false, calendarMonth = '';
    const field = name => global.document?.querySelector(`#period-screen [data-period="${name}"]`);
    const byId = id => global.document?.getElementById(id);
    const core = () => global.PeriodHealthCore;
    const table = () => global.dexieDB?.periodRecords;
    const roles = () => Array.isArray(global.db?.characters) ? global.db.characters : [];
    const role = () => roles().find(item => String(item.id) === String(state.roleId)) || null;
    const notify = message => global.showToast?.(message);
    const escapeHtml = value => { const node = global.document.createElement('div'); node.textContent = String(value ?? ''); return node.innerHTML; };

    function userToday() {
        const clock = global.VirtualClock;
        const config = clock?.resolveUser ? clock.resolveUser(null, global.db?.userTimeline) : null;
        if (clock?.dateKey) return clock.dateKey(config);
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    function normalizeSettings() { return core().normalizeSettings(global.db?.healthPeriodSettings); }
    function selectedRole() { return role(); }
    function statusText() {
        const status = core().computeStatus(state.records, state.settings, userToday());
        const title = byId('period-status-title');
        const detail = byId('period-status-detail');
        const prediction = byId('period-status-prediction');
        if (!status.lastStart) {
            if (title) title.textContent = '暂无记录';
            if (detail) detail.textContent = '';
            if (prediction) prediction.textContent = '';
            return;
        }
        if (title) title.textContent = status.unknown ? '已记开始，结束尚未记录' : '最近一轮已记录结束';
        if (detail) detail.textContent = `最近一轮开始于 ${status.lastStart}${status.lastEnd ? `，结束于 ${status.lastEnd}` : '，尚未记录结束'}。`;
        if (prediction) prediction.textContent = core().predictionText(status);
    }

    function renderRoles() {
        const select = byId('period-role-select');
        if (!select) return;
        const preferred = state.roleId || roles()[0]?.id || '';
        select.innerHTML = roles().map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.remarkName || item.realName || item.name || '角色')}</option>`).join('');
        state.roleId = roles().some(item => String(item.id) === String(preferred)) ? String(preferred) : String(roles()[0]?.id || '');
        select.value = state.roleId;
        const current = selectedRole();
        const share = byId('period-role-share');
        if (share) share.checked = current?.periodHealthSharingEnabled === true;
        const hint = byId('period-share-status');
        if (hint) hint.textContent = current?.periodHealthSharingEnabled === true ? '已授权：聊天时只注入必要状态摘要，不写入长期记忆。' : '关闭时不会注入聊天提示，也不会进入长期记忆。';
    }

    function renderSettings() {
        const settings = state.settings || normalizeSettings();
        const cycle = byId('period-cycle-length');
        const length = byId('period-length');
        const status = byId('period-settings-status');
        if (cycle) cycle.value = settings.cycleLength == null ? '' : String(settings.cycleLength);
        if (length) length.value = settings.periodLength == null ? '' : String(settings.periodLength);
        if (field('mode')) field('mode').value = settings.predictionMode;
        if (field('manual-settings')) field('manual-settings').hidden = settings.predictionMode !== 'manual';
        if (status) status.textContent = settings.predictionMode === 'manual' ? '仅使用你选填的参考周期，不将估算写成实际记录。' : '周期来自实际记录；旧设置的数值仍保留，但不会自动当作你的真实周期。';
    }

    function renderRecords() {
        const list = byId('period-record-list');
        const empty = byId('period-record-empty');
        if (!list) return;
        const records = core().effectiveRecords(state.records).slice().reverse();
        if (empty) empty.style.display = records.length ? 'none' : '';
        list.innerHTML = records.map(record => `<button type="button" class="period-record-row" data-period-record-id="${escapeHtml(record.id)}"><span>${escapeHtml(record.date)}</span><strong>${record.kind === 'start' ? '开始' : '结束'}</strong><span aria-hidden="true">›</span></button>`).join('');
    }

    function renderCalendar() {
        const host = field('calendar'); if (!host) return;
        const today = userToday();
        if (!calendarMonth) calendarMonth = today.slice(0, 7);
        field('month').textContent = calendarMonth.replace('-', ' 年 ') + ' 月';
        const first = calendarMonth + '-01';
        const startWeekday = new Date(first + 'T00:00:00Z').getUTCDay();
        const intervals = core().getIntervals(state.records, today);
        const events = core().effectiveRecords(state.records).filter(item => item.date <= today);
        const status = core().computeStatus(state.records, state.settings, today);
        field('statistics').textContent = [status.observedCycle ? `平均周期 ${status.observedCycle} 天` : '', status.periodLength ? `平均经期 ${status.periodLength} 天` : ''].filter(Boolean).join(' · ');
        host.replaceChildren();
        for (const day of '日一二三四五六') { const node = document.createElement('span'); node.textContent = day; host.append(node); }
        for (let index = 0; index < startWeekday; index++) host.append(document.createElement('span'));
        for (let index = 0; index < 31; index++) {
            const date = core().addDays(first, index); if (!date.startsWith(calendarMonth)) break;
            const node = document.createElement('button'); node.type = 'button'; node.textContent = String(index + 1);
            const kinds = events.filter(item => item.date === date).map(item => item.kind === 'start' ? '开始' : '结束');
            const actual = kinds.length || intervals.some(item => !item.open && date >= item.start && date <= item.end);
            const predicted = status.predictionFrom && date >= today && date >= status.predictionFrom && date <= status.predictionTo;
            if (actual) node.classList.add('period-calendar-recorded');
            else if (predicted) node.classList.add('period-calendar-estimate');
            if (date === today) node.classList.add('period-calendar-today');
            node.setAttribute('aria-label', `${date}${kinds.length ? ' 已记' + kinds.join('、') : actual ? ' 已记录经期' : predicted ? ' 参考日期，非实际记录' : ''}`);
            node.setAttribute('aria-pressed', String(field('date').value === date));
            node.disabled = date > today;
            node.onclick = () => { field('date').value = date; renderCalendar(); };
            host.append(node);
        }
    }
    function render() { statusText(); renderRoles(); renderSettings(); renderRecords(); renderCalendar(); }

    function openRecordEditor(recordId) {
        const record = state.records.find(item => String(item.id) === String(recordId));
        const editor = field('record-dialog')?.querySelector('[data-period-record-id]');
        if (!record || !editor) return;
        editor.dataset.periodRecordId = record.id;
        editor.querySelector('.period-record-date').value = record.date;
        editor.querySelector('.period-record-kind').value = record.kind;
        editor.querySelector('.period-record-date').max = userToday();
        field('record-dialog').showModal();
    }

    function closeDialog(name) { if (field(name)?.open) field(name).close(); }

    async function load() {
        if (field('date')) field('date').max = userToday();
        state.settings = normalizeSettings();
        state.records = table() ? await table().toArray() : [];
        render();
        return state;
    }

    async function refresh() { state.records = table() ? await table().toArray() : []; render(); return state.records; }

    async function saveSettings(value) {
        if (settingsSaving) return;
        settingsSaving = true;
        promptCache.clear();
        const input = value || { predictionMode: field('mode')?.value || 'auto', cycleLength: byId('period-cycle-length')?.value, periodLength: byId('period-length')?.value };
        const mode = input.predictionMode;
        const settings = core().normalizeSettings(input);
        if (mode === 'manual' && !settings.cycleLength || input.cycleLength && !settings.cycleLength || input.periodLength && !settings.periodLength) { settingsSaving = false; notify('请设置有效的参考天数'); return false; }
        const previous = global.db.healthPeriodSettings;
        global.db.healthPeriodSettings = settings;
        try {
            const saved = await global.saveGlobalSettings?.(['healthPeriodSettings']);
            if (saved !== true) throw new Error('周期设置保存失败');
            state.settings = settings;
            promptCache.clear();
            renderSettings(); statusText(); renderCalendar(); notify('周期设置已保存');
            return true;
        } catch (error) {
            global.db.healthPeriodSettings = previous;
            notify(error.message || '周期设置保存失败');
            return false;
        } finally { settingsSaving = false; promptCache.clear(); }
    }

    async function saveRoleShare(roleId, enabled) {
        const current = roleId == null ? selectedRole() : roles().find(item => String(item.id) === String(roleId));
        if (!current) return notify('请先选择角色');
        const id = String(current.id);
        if (sharingSaves.has(id)) return;
        const previous = current.periodHealthSharingEnabled;
        sharingSaves.add(id);
        promptCache.delete(id);
        current.periodHealthSharingEnabled = roleId == null ? byId('period-role-share')?.checked === true : enabled === true;
        try {
            const saved = await global.saveCharacter?.(current.id);
            if (saved !== true) throw new Error('角色共享权限保存失败');
            notify(current.periodHealthSharingEnabled ? '已授权该角色读取生理期摘要' : '已关闭该角色的生理期共享');
            return true;
        } catch (error) {
            current.periodHealthSharingEnabled = previous;
            notify(error.message || '角色共享权限保存失败');
            return false;
        } finally {
            sharingSaves.delete(id);
            promptCache.delete(id);
            renderRoles();
        }
    }

    async function saveRecord(recordId, row) {
        if (!table()) throw new Error('生理期数据库尚未初始化');
        const date = row.querySelector('.period-record-date')?.value || '';
        const kind = row.querySelector('.period-record-kind')?.value || 'start';
        if (!core().validDate(date) || date > userToday()) throw new Error('请输入不晚于今天的有效日期');
        const old = state.records.find(item => String(item.id) === String(recordId));
        const next = core().normalizeRecord({ ...(old || {}), date, kind, id: core().recordId(date, kind), updatedAt: Date.now(), timestamp: old?.timestamp || Date.now() });
        await global.dexieDB.transaction('rw', table(), async () => {
            const stored = await table().get(recordId);
            if (!old || !stored || stored.updatedAt !== old.updatedAt) throw new Error('记录已变化，请重新打开页面后编辑');
            if (old.id !== next.id && await table().get(next.id)) throw new Error('该日期已有同类记录，请先检查现有记录');
            if (old.id !== next.id) await table().delete(old.id);
            await table().put(next);
        });
        await refresh();
        promptCache.clear();
        notify('生理期记录已保存');
    }

    async function deleteRecord(recordId) {
        if (!table()) return false;
        if (!global.confirm?.('确定删除这条生理期记录吗？')) return false;
        await table().delete(recordId);
        await refresh();
        promptCache.clear();
        notify('生理期记录已删除');
        return true;
    }

    async function addRecord(kind, selectedDate) {
        if (!table()) return notify('生理期数据库尚未初始化');
        if (recording) return;
        const date = selectedDate || field('date')?.value || userToday();
        if (!core().validDate(date) || date > userToday() || !['start', 'end'].includes(kind)) return notify('请选择不晚于今天的有效记录日期');
        const id = core().recordId(date, kind);
        recording = true;
        try {
            await global.dexieDB.transaction('rw', table(), async () => {
                if (await table().get(id)) throw new Error('这一天已有同类记录，无需重复添加');
                await table().put(core().normalizeRecord({ id, date, kind, timestamp: Date.now(), updatedAt: Date.now() }));
            });
            await refresh(); promptCache.clear();
            notify(kind === 'start' ? '已记录生理期开始' : '已记录生理期结束');
        } catch (error) { notify(error.message || '记录失败，请重试'); }
        finally { recording = false; }
    }

    async function prepareForChat(character) {
        const id = String(character?.id || '');
        if (!id || settingsSaving || sharingSaves.has(id) || character?.periodHealthSharingEnabled !== true || !table()) { if (id) promptCache.delete(id); return ''; }
        const records = await table().toArray();
        if (settingsSaving || sharingSaves.has(id) || character.periodHealthSharingEnabled !== true) return '';
        const settings = normalizeSettings();
        const block = core().buildPromptSummary(records, settings, userToday());
        promptCache.set(id, { block, at: Date.now() });
        return block;
    }

    function getPromptBlock(character) {
        if (settingsSaving || sharingSaves.has(String(character?.id)) || character?.periodHealthSharingEnabled !== true) return '';
        return promptCache.get(String(character.id))?.block || '';
    }

    function setup() {
        const screen = byId('period-screen');
        if (!screen || screen.dataset.ready) return;
        screen.dataset.ready = 'true';
        field('date').value = userToday(); field('date').max = userToday();
        field('date').onchange = () => { if (core().validDate(field('date').value)) calendarMonth = field('date').value.slice(0, 7); renderCalendar(); };
        field('today').onclick = () => { field('date').value = userToday(); calendarMonth = userToday().slice(0, 7); renderCalendar(); };
        for (const [name, offset] of [['previous-month', -1], ['next-month', 1]]) field(name).onclick = () => {
            const date = new Date(calendarMonth + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + offset); calendarMonth = date.toISOString().slice(0, 7); renderCalendar();
        };
        byId('period-record-start-btn')?.addEventListener('click', () => void addRecord('start'));
        byId('period-record-end-btn')?.addEventListener('click', () => void addRecord('end'));
        byId('period-save-settings-btn')?.addEventListener('click', () => void saveSettings());
        byId('period-save-share-btn')?.addEventListener('click', () => void saveRoleShare());
        byId('period-role-select')?.addEventListener('change', event => { state.roleId = String(event.target.value || ''); renderRoles(); });
        field('mode').onchange = () => { if (field('manual-settings')) field('manual-settings').hidden = field('mode').value !== 'manual'; };
        field('settings-open').onclick = () => { renderSettings(); renderRoles(); field('settings-dialog').showModal(); };
        field('settings-close').onclick = () => closeDialog('settings-dialog');
        field('record-cancel').onclick = () => closeDialog('record-dialog');
        for (const name of ['settings-dialog', 'record-dialog']) field(name).addEventListener('cancel', event => { event.preventDefault(); closeDialog(name); });
        byId('period-record-list')?.addEventListener('click', event => {
            const row = event.target.closest('[data-period-record-id]');
            if (row) openRecordEditor(row.dataset.periodRecordId);
        });
        field('record-dialog').addEventListener('click', event => {
            const action = event.target.closest('[data-period-action]')?.dataset.periodAction;
            const row = field('record-dialog').querySelector('[data-period-record-id]');
            if (!action || !row?.dataset.periodRecordId) return;
            if (action === 'save') void saveRecord(row.dataset.periodRecordId, row).then(() => closeDialog('record-dialog')).catch(error => notify(error?.message || '保存失败'));
            if (action === 'delete') void deleteRecord(row.dataset.periodRecordId).then(deleted => { if (deleted) closeDialog('record-dialog'); });
        });
        void load();
    }

    function open() { if (typeof global.switchScreen === 'function') global.switchScreen('period-screen'); render(); }
    async function getLocalStatus() { return core().computeStatus(await table().toArray(), normalizeSettings(), userToday()); }
    async function getCalendarRecords() { return core().effectiveRecords(await table().toArray()).map(row => ({ id: row.id, date: row.date, kind: row.kind })); }
    // Calendar UI uses the same event records and prediction core, never a daily copy.
    async function getCalendarSnapshot() {
        if (!table()) throw new Error('生理期记录尚未就绪');
        const records = await table().toArray(), settings = normalizeSettings(), today = userToday();
        return { records, settings, today, intervals: core().getIntervals(records, today), status: core().computeStatus(records, settings, today) };
    }

    async function editCalendarRecords({ previous = [], next = [] }) {
        if (!table()) throw new Error('生理期记录尚未就绪');
        if (previous.length > 2 || next.length > 2 || !previous.length && !next.length) throw new Error('请选择记录日期');
        const today = userToday();
        if (next.some(row => !core().validDate(row.date) || row.date > today || !['start', 'end'].includes(row.kind))) throw new Error('请选择不晚于今天的日期');
        const start = next.find(row => row.kind === 'start'), end = next.find(row => row.kind === 'end');
        if (start && end && start.date > end.date) throw new Error('结束日期不能早于开始日期');
        const stamp = Date.now();
        const after = next.map((row, index) => {
            const old = previous.find(item => item.kind === row.kind);
            return { ...old, ...core().normalizeRecord({ ...row, id: old?.date === row.date ? old.id : core().recordId(row.date, row.kind), timestamp: start && end && start.date === end.date ? stamp + index : old?.timestamp || stamp + index, updatedAt: stamp + index }) };
        });
        if (new Set(after.map(row => row.id)).size !== after.length) throw new Error('请勿重复选择同类记录');
        await global.dexieDB.transaction('rw', table(), async () => {
            for (const old of previous) {
                const stored = await table().get(old.id);
                if (JSON.stringify(stored) !== JSON.stringify(old)) throw new Error('记录已变化，请重新打开后编辑');
            }
            const all = await table().toArray(), oldIds = new Set(previous.map(row => row.id));
            for (const row of after) {
                if (all.some(item => !oldIds.has(item.id) && item.date === row.date && item.kind === row.kind)) throw new Error('这一天已有同类记录');
            }
            if (start && end) {
                const other = all.filter(row => !oldIds.has(row.id));
                if (other.some(row => row.date >= start.date && row.date <= end.date) || core().getIntervals(other, today).some(span => !span.open && span.start <= end.date && span.end >= start.date)) throw new Error('所选日期已有记录，请调整原记录');
            }
            for (const old of previous) await table().delete(old.id);
            for (const row of after) await table().put(row);
        });
        promptCache.clear();
        await refresh();
        return { before: previous.map(row => ({ ...row })), after };
    }

    async function undoCalendarEdit(receipt) {
        await global.dexieDB.transaction('rw', table(), async () => {
            const all = await table().toArray();
            for (const row of receipt.after) {
                if (JSON.stringify(await table().get(row.id)) !== JSON.stringify(row)) throw new Error('记录已变化，无法撤销');
            }
            for (const old of receipt.before) {
                const current = await table().get(old.id);
                if (current && !receipt.after.some(row => row.id === old.id)) throw new Error('原日期已有新记录，无法撤销');
                if (all.some(row => row.id !== old.id && row.date === old.date && row.kind === old.kind && !receipt.after.some(item => item.id === row.id))) throw new Error('原日期已有新记录，无法撤销');
            }
            for (const row of receipt.after) await table().delete(row.id);
            for (const row of receipt.before) await table().put(row);
        });
        promptCache.clear();
        await refresh();
    }

    global.PeriodHealth = { setup, open, load, render, getLocalStatus, getCalendarRecords, getCalendarSnapshot, editCalendarRecords, undoCalendarEdit, prepareForChat, getPromptBlock, addRecord, saveRecord, deleteRecord, saveSettings, saveRoleShare, get state() { return state; } };
})(typeof window !== 'undefined' ? window : globalThis);
