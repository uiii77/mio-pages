// Calendar presentation only. PeriodHealth owns records, settings and permissions.
(function (global) {
    'use strict';
    const f = name => document.querySelector(`#health-screen [data-period-ui="${name}"]`);
    const owner = () => global.PeriodHealth;
    const core = () => global.PeriodHealthCore;
    const short = date => date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日` : '未选择';
    let snapshot, selected, onChange, draft, month, choosingEnd = false, busy = false, receipt = null, ready = false, opening = 0;
    function element(tag, text, cls) { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; }
    function button(text, click, cls) { const el = element('button', text, cls); el.type = 'button'; el.onclick = click; return el; }
    function message(text = '') { f('message').textContent = text; }
    function showPanel(name) { f('day').hidden = name !== 'day'; f('edit').hidden = name !== 'edit'; message(); }
    function related() {
        const validIds = new Set(core().effectiveRecords(snapshot.records).map(row => row.id));
        const records = snapshot.records.filter(row => validIds.has(row.id));
        const interval = snapshot.intervals.find(span => selected >= span.start && selected <= span.end);
        if (interval) return records.filter(row => row.kind === 'start' && row.date === interval.start || !interval.open && row.kind === 'end' && row.date === interval.end);
        return records.filter(row => row.date === selected);
    }
    function renderDay() {
        showPanel('day');
        f('title').textContent = short(selected);
        const rows = related(), status = snapshot.status;
        const actual = snapshot.intervals.some(span => selected >= span.start && selected <= span.end);
        const predicted = !actual && status.predictionFrom && selected >= snapshot.today && selected >= status.predictionFrom && selected <= status.predictionTo;
        f('day-status').textContent = actual ? '已记录经期' : rows.length ? '已记录结束' : predicted ? '预计经期' : '暂无记录';
        f('day-status').classList.toggle('is-predicted', !!predicted);
        const host = f('entries'); host.replaceChildren();
        for (const row of rows) {
            const line = element('div', '', 'period-entry');
            line.append(element('span', row.kind === 'start' ? '开始' : '结束'), button(short(row.date) + ' ›', () => edit([row], row.kind), 'period-text-button'));
            host.append(line);
        }
        f('remove').hidden = !rows.length;
        f('start').parentElement.hidden = rows.length === 2;
        for (const kind of ['start', 'end']) {
            const control = f(kind);
            control.disabled = selected > snapshot.today || snapshot.records.some(row => row.date === selected && row.kind === kind);
        }
        f('range').disabled = selected > snapshot.today;
        f('range').textContent = rows.length ? '调整这次记录' : '选择连续日期';
        f('undo').hidden = !receipt;
    }
    function edit(previous, kind) {
        if (busy) return;
        draft = { previous, kind, start: previous.find(row => row.kind === 'start')?.date || selected, end: previous.find(row => row.kind === 'end')?.date || (kind === 'end' ? selected : '') };
        month = (kind === 'end' ? draft.end : draft.start).slice(0, 7);
        choosingEnd = false; showPanel('edit');
        f('title').textContent = previous.length ? '调整日期' : '选择连续日期';
        renderPicker();
    }
    function renderPicker() {
        f('month').textContent = `${month.slice(0, 4)}年 ${Number(month.slice(5))}月`;
        f('from').textContent = (draft.kind === 'end' ? '结束 ' : '开始 ') + short(draft.kind === 'end' ? draft.end : draft.start);
        f('to').hidden = draft.kind !== 'range';
        f('to').previousElementSibling.hidden = draft.kind !== 'range';
        f('to').textContent = '结束 ' + short(draft.end);
        f('from').setAttribute('aria-pressed', String(!choosingEnd));
        f('to').setAttribute('aria-pressed', String(choosingEnd));
        const host = f('picker'); host.replaceChildren();
        for (const text of '一二三四五六日') host.append(element('span', text, 'period-weekday'));
        const first = month + '-01', offset = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
        for (let i = 0; i < offset; i++) host.append(element('span', ''));
        for (let i = 0; i < 31; i++) {
            const date = core().addDays(first, i); if (!date.startsWith(month)) break;
            const el = button(String(i + 1), () => {
                if (busy) return;
                if (draft.kind === 'end') draft.end = date;
                else if (draft.kind === 'start') draft.start = date;
                else if (!choosingEnd) { draft.start = date; if (draft.end < date) draft.end = ''; choosingEnd = true; }
                else if (date < draft.start) { draft.start = date; draft.end = ''; }
                else { draft.end = date; choosingEnd = false; }
                renderPicker();
            });
            el.dataset.periodDate = date;
            el.setAttribute('aria-label', date);
            const from = draft.kind === 'end' ? draft.end : draft.start;
            el.setAttribute('aria-pressed', String(date === from || draft.kind === 'range' && date === draft.end));
            if (draft.kind === 'range' && date > draft.start && date < draft.end) el.classList.add('is-between');
            el.disabled = date > snapshot.today; host.append(el);
        }
        f('save').disabled = draft.kind === 'range' ? !draft.start || !draft.end : false;
    }
    async function change(next, previous = []) {
        if (busy) return;
        busy = true; f('sheet').setAttribute('aria-busy', 'true'); message('保存中…');
        try {
            receipt = await owner().editCalendarRecords({ previous, next });
            snapshot = await owner().getCalendarSnapshot();
            await onChange?.(); renderDay(); message('已保存');
        } catch (error) { message(error.message || '保存失败，请重试'); }
        finally { busy = false; f('sheet').removeAttribute('aria-busy'); }
    }
    function setup() {
        if (ready) return; ready = true;
        f('close').onclick = () => { if (!busy) { opening++; f('sheet').close(); } };
        f('sheet').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        f('cancel-edit').onclick = () => { if (!busy) renderDay(); };
        for (const kind of ['start', 'end']) f(kind).onclick = () => void change([{ date: selected, kind }]);
        f('range').onclick = () => { const rows = related(); edit(rows, rows.length === 1 && rows[0].kind === 'end' ? 'end' : 'range'); };
        f('remove').onclick = async () => {
            if (busy) return;
            const previous = related();
            busy = true; f('sheet').close();
            let result;
            try { result = await global.showAppConfirmDialog({ title: '生理期记录', message: '撤销这次生理期记录？', dismissText: '' }); }
            finally { busy = false; f('sheet').showModal(); f('remove').focus(); }
            if (result === 'confirm') await change([], previous);
        };
        f('undo').onclick = async () => {
            if (busy || !receipt) return; busy = true;
            try { await owner().undoCalendarEdit(receipt); receipt = null; snapshot = await owner().getCalendarSnapshot(); await onChange?.(); renderDay(); message('已撤销'); }
            catch (error) { message(error.message); }
            finally { busy = false; }
        };
        f('save').onclick = () => {
            if (busy) return;
            const next = draft.kind === 'end' ? [{ date: draft.end, kind: 'end' }] : [{ date: draft.start, kind: 'start' }];
            if (draft.kind === 'range') next.push({ date: draft.end, kind: 'end' });
            void change(next, draft.previous);
        };
        f('from').onclick = () => { choosingEnd = false; renderPicker(); };
        f('to').onclick = () => { choosingEnd = true; renderPicker(); };
        for (const [name, offset] of [['previous', -1], ['next', 1]]) f(name).onclick = () => {
            const date = new Date(month + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + offset); month = date.toISOString().slice(0, 7); renderPicker();
        };
        f('settings-close').onclick = () => { if (!busy) f('settings').close(); };
        f('settings').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        f('settings-save').onclick = async () => {
            if (busy) return; busy = true; f('settings-save').disabled = true;
            try {
                if (await owner().saveSettings(settingsDraft) !== true) { f('settings-status').textContent = '保存失败，请检查周期天数后重试'; return; }
                await onChange?.(); f('settings').close();
            } catch (error) { f('settings-status').textContent = error.message; }
            finally { busy = false; f('settings-save').disabled = false; }
        };
        document.querySelectorAll('[data-period-mode]').forEach(el => el.onclick = () => { if (!busy) { settingsDraft.predictionMode = el.dataset.periodMode; renderSettings(); } });
        document.querySelectorAll('[data-period-step]').forEach(el => el.onclick = () => {
            if (busy) return;
            const key = el.dataset.periodStep, limits = key === 'cycleLength' ? [15, 90, 28] : [1, 14, 5];
            settingsDraft[key] = Math.max(limits[0], Math.min(limits[1], settingsDraft[key] == null ? limits[2] : settingsDraft[key] + Number(el.dataset.delta)));
            renderSettings();
        });
        f('clear-length').onclick = () => { if (!busy) { settingsDraft.periodLength = null; renderSettings(); } };
    }
    let settingsDraft;
    function renderSettings() {
        document.querySelectorAll('[data-period-mode]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.periodMode === settingsDraft.predictionMode)));
        f('parameters').hidden = settingsDraft.predictionMode !== 'manual';
        for (const key of ['cycleLength', 'periodLength']) f(key).textContent = settingsDraft[key] ? `${settingsDraft[key]} 天` : '未设置';
        f('mode-hint').textContent = { auto: '根据已记录的周期估算', manual: '使用参考周期估算', off: '仅显示实际记录' }[settingsDraft.predictionMode];
    }
    async function open(date, callback) {
        setup(); if (busy) return;
        const token = ++opening, value = await owner().getCalendarSnapshot();
        if (token !== opening) return;
        snapshot = value; selected = date; onChange = callback;
        renderDay(); if (!f('sheet').open) f('sheet').showModal();
    }
    async function openSettings(callback) {
        setup(); if (busy) return;
        const token = ++opening, value = await owner().getCalendarSnapshot();
        if (token !== opening) return;
        snapshot = value; onChange = callback; settingsDraft = { ...snapshot.settings };
        renderSettings(); f('settings-status').textContent = ''; f('settings').showModal();
    }
    global.PeriodCalendarUI = Object.freeze({ open, openSettings });
})(window);
