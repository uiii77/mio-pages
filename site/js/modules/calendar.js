// Personal calendar is a read-only projection; source modules own every write.
(function (global) {
    'use strict';
    const field = name => document.querySelector(`#health-screen [data-cal="${name}"]`);
    const dates = () => global.PeriodHealthCore;
    const eventOccursOn = (event, date) => global.PersonalScheduleCore.occursOn(event, date);
    let ready = false, selected = '', view = 'month', sourceId = '', generation = 0, sourceChosen = false;
    let snapshots = [];
    let displaySaving = false, displayError = '';
    function displaySettings(value) {
        return {
            schemaVersion: 1,
            view: ['month', 'week', 'day'].includes(value?.view) ? value.view : 'month',
            sourceId: typeof value?.sourceId === 'string' ? value.sourceId : null,
            showPeriod: value?.showPeriod === true,
        };
    }
    function applyDisplay(value) {
        const settings = displaySettings(value);
        view = settings.view; sourceId = settings.sourceId || ''; sourceChosen = settings.sourceId !== null;
        field('period').checked = settings.showPeriod;
    }
    async function saveDisplay(patch) {
        if (displaySaving) return;
        displaySaving = true; displayError = '';
        const controls = [...document.querySelectorAll('#health-screen [data-cal-view]'), field('source'), field('period')];
        controls.forEach(control => { control.disabled = true; });
        const previous = global.db.calendarDisplaySettings;
        global.db.calendarDisplaySettings = displaySettings({ ...displaySettings(previous), ...patch });
        try {
            if (await global.saveGlobalSettings?.(['calendarDisplaySettings']) !== true) throw new Error('save failed');
        } catch {
            global.db.calendarDisplaySettings = previous;
            displayError = '日历显示设置保存失败，请重试';
        } finally {
            displaySaving = false;
            controls.forEach(control => { control.disabled = false; });
        }
        await open();
    }
    const today = () => global.VirtualClock.dateKey(global.VirtualClock.resolveUser(null, global.db?.userTimeline));
    const dayLabel = date => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 · 周${'日一二三四五六'[new Date(date + 'T00:00:00Z').getUTCDay()]}`;
    function range(date, mode) {
        if (!dates().validDate(date)) throw new Error('日期无效');
        const first = mode === 'month' ? date.slice(0, 7) + '-01' : date;
        const weekday = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
        const start = mode === 'day' ? date : dates().addDays(first, -weekday);
        return Array.from({ length: mode === 'month' ? 42 : mode === 'week' ? 7 : 1 }, (_, i) => dates().addDays(start, i));
    }
    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text != null) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    function action(text, handler) {
        const button = node('button', text); button.type = 'button'; button.onclick = handler; return button;
    }
    async function render() {
        const token = ++generation;
        const requested = range(selected, view), includePeriod = field('period').checked;
        field('status').textContent = '正在读取';
        field('grid').replaceChildren(); field('agenda').replaceChildren();
        let sourceError = '', periodError = '', personalError = '', reminderError = '';
        let reminders = [];
        try { reminders = global.ReminderCalendar.list(requested[0], requested.at(-1)); }
        catch { reminderError = '提醒读取失败'; }
        const [available, period, events] = await Promise.all([
            global.Timetable.listSnapshots().catch(() => { sourceError = '课表读取失败'; return snapshots; }),
            includePeriod ? global.PeriodHealth.getCalendarSnapshot().catch(() => { periodError = '生理期读取失败'; return null; }) : null,
            global.PersonalSchedule.listOccurrences(requested[0], requested.at(-1)).catch(() => { personalError = '个人日程读取失败'; return []; }),
        ]);
        if (token !== generation) return;
        const records = period ? dates().effectiveRecords(period.records) : [];
        snapshots = available;
        if (!sourceChosen && snapshots.length === 1) { sourceId = snapshots[0].id; sourceChosen = true; }
        if (sourceId && !snapshots.some(item => item.id === sourceId)) sourceId = '';
        field('source').replaceChildren(new Option('不显示', ''), ...snapshots.map((item, i) => new Option(`${item.semester} · 课表 ${i + 1}`, item.id)));
        field('source').value = sourceId;
        field('source').closest('label').hidden = !snapshots.length;
        const projected = sourceId && !sourceError ? await global.Timetable.getCalendarDays(sourceId, requested).catch(() => { sourceError = '课表读取失败'; return []; }) : [];
        if (token !== generation) return;
        field('heading').textContent = view === 'month' ? selected.slice(0, 7).replace('-', '年') + '月' : view === 'day' ? selected : `${requested[0].slice(5)} — ${requested.at(-1).slice(5)}`;
        document.querySelectorAll('#health-screen [data-cal-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.calView === view)));
        field('period-summary').hidden = field('period-legend').hidden = !includePeriod;
        field('period-edit').disabled = !!periodError;
        const intervals = period?.intervals || [];
        const status = period?.status || {};
        field('period-title').textContent = periodError || (status.lastStart ? status.unknown ? '已记开始 · 待记结束' : '最近经期 ' + status.lastStart.slice(5).replace('-', '/') + ' — ' + status.lastEnd.slice(5).replace('-', '/') : '暂无记录');
        field('period-subtitle').textContent = status.predictionMode === 'off' ? '预测已关闭' : status.predictionFrom ? `${status.predictionPast ? '上次预计' : '下次预计'} ${status.predictionFrom.slice(5).replace('-', '/')}${status.predictionTo !== status.predictionFrom ? ' — ' + status.predictionTo.slice(5).replace('-', '/') : ''}` : '暂无预测';
        const grid = field('grid'); grid.hidden = view === 'day';
        if (view !== 'day') {
            for (const weekday of ['一', '二', '三', '四', '五', '六', '日']) grid.append(node('span', weekday, 'calendar-weekday'));
            for (const date of requested) {
                const day = projected.find(item => item.date === date);
                const hasPeriod = records.some(item => item.date === date) || intervals.some(item => date >= item.start && date <= item.end);
                const predicted = !hasPeriod && status.predictionFrom && date >= today() && date >= status.predictionFrom && date <= status.predictionTo;
                const button = action(String(Number(date.slice(-2))), async () => { selected = date; await render(); if (includePeriod) await openPeriod(date); });
                button.className = 'calendar-date'; button.dataset.date = date;
                if (hasPeriod) button.classList.add('calendar-period-actual');
                else if (predicted) button.classList.add('calendar-period-predicted');
                if (view === 'month' && date.slice(0, 7) !== selected.slice(0, 7)) button.classList.add('calendar-other-month');
                button.setAttribute('aria-pressed', String(date === selected));
                button.setAttribute('aria-label', `${date}${day?.courses.length ? ' 有课程' : ''}${hasPeriod ? ' 有生理期记录' : predicted ? ' 预计经期' : ''}`);
                if (date === today()) button.setAttribute('aria-current', 'date');
                if (day?.courses.length) button.append(node('span', '·', 'calendar-course-dot'));
                if (hasPeriod) button.append(node('span', '·', 'calendar-period-dot'));
                if (events.some(item => eventOccursOn(item, date)) || reminders.some(item => item.date === date)) {
                    button.append(node('span', '·', 'calendar-personal-dot'));
                    button.setAttribute('aria-label', button.getAttribute('aria-label') + (events.some(item => eventOccursOn(item, date)) ? ' 有个人日程' : '') + (reminders.some(item => item.date === date) ? ' 有提醒' : ''));
                }
                grid.append(button);
            }
        }
        const agendaDates = view === 'week' ? requested : [selected];
        for (const date of agendaDates) {
            const section = node('section'); section.append(node('h2', dayLabel(date)));
            const day = projected.find(item => item.date === date);
            if (sourceId) {
                if (sourceError) section.append(node('p', sourceError, 'calendar-muted'));
                else if (!day?.covered) section.append(node('p', day?.reason === 'ambiguous-date' ? '课表日期需核对' : '课表未覆盖此日期', 'calendar-muted'));
                else {
                    if (!day.courses.length) section.append(node('p', '该课表当天无课程', 'calendar-muted'));
                    for (const course of day.courses) {
                        const time = course.startTime && course.endTime ? `${course.startTime}–${course.endTime}` : `第 ${course.sections.join('、')} 节`;
                        const snapshotId = sourceId;
                        const button = action('', () => showCourse(course, date, snapshotId)); button.className = 'calendar-course';
                        button.append(node('strong', course.name), node('span', `${time} · ${course.location || '地点未提供'}`, 'calendar-muted'));
                        section.append(button);
                    }
                    if (day.missingCount || day.conflicts.length) section.append(node('p', '部分课程或个人调整需核对', 'calendar-muted'));
                }
            }
            for (const record of records.filter(item => item.date === date)) section.append(action(record.kind === 'start' ? '生理期 · 已记开始' : '生理期 · 已记结束', () => void openPeriod(date)));
            for (const event of events.filter(item => eventOccursOn(item, date))) {
                const button = action('', () => showEvent(event)); button.className = 'calendar-course';
                button.dataset.personalEventId = event.id;
                if (event.seriesId) button.dataset.occurrenceDate = event.occurrenceDate;
                button.append(node('strong', event.title), node('span', `个人${event.seriesId ? ' · ' + repeatLabels[event.recurrence.frequency] : ''} · ${eventTime(event)}${event.location ? ' · ' + event.location : ''}`, 'calendar-muted'));
                section.append(button);
            }
            for (const reminder of reminders.filter(item => item.date === date)) {
                const button = action('', () => showReminder(reminder)); button.className = 'calendar-course';
                button.append(node('strong', reminder.title), node('span', `提醒 · ${reminder.characterName} · ${reminder.time || '未设时间'} · ${reminderStatus(reminder)}`, 'calendar-muted'));
                section.append(button);
            }
            if (personalError || reminderError) section.append(node('p', [personalError, reminderError].filter(Boolean).join(' · '), 'calendar-muted'));
            if (!personalError && !reminderError && !sourceId && !records.some(item => item.date === date) && !events.some(item => eventOccursOn(item, date)) && !reminders.some(item => item.date === date)) section.append(node('p', '暂无日程', 'calendar-muted'));
            field('agenda').append(section);
        }
        const source = snapshots.find(item => item.id === sourceId);
        field('status').textContent = [displayError, sourceError, periodError, source ? source.semester : ''].filter(Boolean).join(' · ');
    }
    async function openPeriod(date) {
        try { await global.PeriodCalendarUI.open(date, render); }
        catch { field('status').textContent = '生理期读取失败，请重试'; }
    }
    const reminderStatus = reminder => reminder.done ? '已完成' : reminder.triggered ? '已触发' : '未完成';
    function showReminder(reminder) {
        const content = field('detail-content'); content.replaceChildren(node('h2', reminder.title));
        const repeat = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' };
        for (const text of [`来自 ${reminder.characterName} · 提醒我`, `${reminder.date} ${reminder.time || '未设时间'}`, reminderStatus(reminder), repeat[reminder.repeat]]) content.append(node('p', text));
        content.append(node('p', '在对应聊天的“提醒”中管理。', 'calendar-muted'));
        field('detail').showModal();
    }
    function showCourse(course, date, snapshotId) {
        const content = field('detail-content'); content.replaceChildren(node('h2', course.name));
        for (const text of [date, `第 ${course.sections.join('、')} 节`, course.location || '地点未提供', course.teacher || '教师未提供']) content.append(node('p', text));
        content.append(action('打开课表', () => {
            if (global.TimetableUI.openFromCalendar({ snapshotId, date, courseId: course.id })) field('detail').close();
            else content.append(node('p', '课表正忙，请稍后重试', 'calendar-muted'));
        }));
        field('detail').showModal();
    }
    const eventField = key => document.querySelector(`#health-screen [data-event="${key}"]`);
    function eventTime(event) {
        if (!event.endDate) return event.allDay ? '全天' : event.start + (event.end ? '–' + event.end : '');
        return event.allDay ? `全天 · ${event.date} — ${event.endDate}` : `${event.date} ${event.start} — ${event.endDate} ${event.end}`;
    }
    let editScope = 'one', editOccurrence = '', repeatFrequency = 'none';
    const repeatLabels = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' };
    const scopeLabels = { one: '仅此次', future: '此次及以后', all: '整组' };
    let editing = null, originalDraft = '', saving = false, previousStartDate = '';
    function draft() {
        return { ...Object.fromEntries(['title', 'date', 'endDate', 'allDay', 'start', 'end', 'location', 'notes'].map(key => [key, key === 'allDay' ? eventField(key).checked : eventField(key).value])), repeatFrequency, until: eventField('until').value };
    }
    const pickerButton = key => document.querySelector(`#health-screen [data-event-pick="${key}"]`);
    const dateText = value => dates().validDate(value) ? `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月${Number(value.slice(8))}日` : '选择日期';
    let activePicker = '', pickerMonth = '', pendingTime = '';
    function updateTimes() {
        const allDay = eventField('allDay').checked;
        for (const key of ['date', 'endDate', 'start', 'end', 'until']) {
            const isDate = ['date', 'endDate', 'until'].includes(key);
            const button = pickerButton(key), value = eventField(key).value;
            button.textContent = key === 'until' && !value ? '永不结束' : isDate ? dateText(value) : value || '选择时间';
            button.setAttribute('aria-label', `${{ date: '开始日期', endDate: '结束日期', start: '开始时间', end: '结束时间', until: '重复至' }[key]}：${button.textContent}`);
            if (!isDate) button.hidden = allDay;
        }
    }
    function closePicker(restoreFocus = true) {
        const previous = activePicker;
        activePicker = ''; field('event-picker').hidden = true;
        if (previous) pickerButton(previous).setAttribute('aria-expanded', 'false');
        field('edit-save').disabled = saving;
        if (restoreFocus && previous) pickerButton(previous).focus();
    }
    function chooseDate(value) {
        eventField(activePicker).value = value;
        eventField(activePicker).dispatchEvent(new Event('change'));
        closePicker();
    }
    function renderDatePicker() {
        const panel = field('event-picker'); panel.replaceChildren();
        const head = node('div', null, 'calendar-picker-head');
        const shiftMonth = offset => {
            const date = new Date(pickerMonth + 'T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + offset);
            const value = date.toISOString().slice(0, 10);
            if (dates().validDate(value)) { pickerMonth = value; renderDatePicker(); panel.querySelector(offset < 0 ? '[data-picker-prev]' : '[data-picker-next]').focus(); }
        };
        const prev = action('‹', () => shiftMonth(-1)), next = action('›', () => shiftMonth(1));
        prev.dataset.pickerPrev = ''; next.dataset.pickerNext = '';
        prev.setAttribute('aria-label', '上个月'); next.setAttribute('aria-label', '下个月');
        const heading = node('strong', `${Number(pickerMonth.slice(0, 4))}年${Number(pickerMonth.slice(5, 7))}月`);
        heading.setAttribute('aria-live', 'polite'); head.append(prev, heading, next); panel.append(head);
        const grid = node('div', null, 'calendar-picker-grid');
        for (const day of ['一', '二', '三', '四', '五', '六', '日']) grid.append(node('span', day));
        for (const date of range(pickerMonth, 'month')) {
            const button = action(String(Number(date.slice(8))), () => chooseDate(date));
            button.dataset.pickerDate = date; button.setAttribute('aria-label', dateText(date));
            button.setAttribute('aria-pressed', String(date === eventField(activePicker).value));
            button.disabled = ['endDate', 'until'].includes(activePicker) && date < eventField('date').value;
            if (date.slice(0, 7) !== pickerMonth.slice(0, 7)) button.className = 'is-other-month';
            if (date === today()) button.setAttribute('aria-current', 'date');
            grid.append(button);
        }
        panel.append(grid);
        const footer = node('div', null, 'calendar-picker-footer');
        const current = action('今天', () => chooseDate(today()));
        current.disabled = ['endDate', 'until'].includes(activePicker) && today() < eventField('date').value;
        footer.append(current, action('收起', () => closePicker())); panel.append(footer);
    }
    function renderTimePicker() {
        const panel = field('event-picker'); panel.replaceChildren();
        const head = node('div', null, 'calendar-picker-head');
        const preview = node('strong', `${activePicker === 'start' ? '开始' : '结束'}时间 · ${pendingTime}`);
        preview.setAttribute('aria-live', 'polite'); head.append(preview); panel.append(head);
        const columns = node('div', null, 'calendar-time-columns');
        for (const [index, count, label] of [[0, 24, '时'], [1, 60, '分']]) {
            const column = node('div', null, 'calendar-time-column'), options = node('div', null, 'calendar-time-options');
            column.append(node('span', label)); options.setAttribute('role', 'group'); options.setAttribute('aria-label', label);
            for (let i = 0; i < count; i++) {
                const value = String(i).padStart(2, '0');
                const button = action(value, () => {
                    const parts = pendingTime.split(':'); parts[index] = value; pendingTime = parts.join(':');
                    for (const item of options.children) item.setAttribute('aria-pressed', String(item === button));
                    preview.textContent = `${activePicker === 'start' ? '开始' : '结束'}时间 · ${pendingTime}`;
                });
                button.dataset[index ? 'pickerMinute' : 'pickerHour'] = value;
                button.setAttribute('aria-label', `${value}${label}`);
                button.setAttribute('aria-pressed', String(value === pendingTime.split(':')[index])); options.append(button);
            }
            column.append(options); columns.append(column);
        }
        panel.append(columns);
        const footer = node('div', null, 'calendar-picker-footer');
        if (activePicker === 'end' && eventField('date').value === eventField('endDate').value) footer.append(action('不设结束', () => { eventField('end').value = ''; updateTimes(); closePicker(); }));
        footer.append(action('取消', () => closePicker()), action('确定', () => {
            eventField(activePicker).value = pendingTime; updateTimes(); closePicker();
        })); panel.append(footer);
        // Scroll only the two local lists, preserving the editor and calendar positions.
        for (const options of panel.querySelectorAll('.calendar-time-options')) {
            const pressed = options.querySelector('[aria-pressed="true"]');
            options.scrollTop = pressed.offsetTop - options.firstElementChild.offsetTop - 60;
        }
    }
    function openPicker(key) {
        if (saving) return;
        if (activePicker === key) { closePicker(); return; }
        closePicker(false); activePicker = key;
        pickerButton(key).setAttribute('aria-expanded', 'true');
        field('event-picker').hidden = false; field('edit-save').disabled = true;
        if (['date', 'endDate', 'until'].includes(key)) {
            pickerMonth = (eventField(key).value || eventField('date').value).slice(0, 7) + '-01'; renderDatePicker();
        } else {
            pendingTime = eventField(key).value || eventField('start').value || '09:00'; renderTimePicker();
        }
        const focus = field('event-picker').querySelector('[aria-pressed="true"]:not(:disabled)') || field('event-picker').querySelector('button:not(:disabled)');
        focus?.focus();
    }
    function editEvent(event, scope = 'one', occurrence = '') {
        editScope = scope; editOccurrence = occurrence;
        repeatFrequency = event?.recurrence?.frequency || 'none';
        eventField('until').value = event?.recurrence?.until || '';
        field('repeat-options').hidden = true;
        editing = event || { id: 'personal:' + global.crypto.randomUUID(), revision: 0, date: selected, allDay: true };
        for (const key of ['title', 'date', 'endDate', 'allDay', 'start', 'end', 'location', 'notes']) {
            if (key === 'allDay') eventField(key).checked = editing.allDay;
            else eventField(key).value = editing[key] || (key === 'endDate' ? editing.date : '');
        }
        closePicker(false);
        field('edit-title').textContent = event ? '编辑日程' : '新增日程';
        updateRepeat();
        previousStartDate = editing.date;
        updateTimes(); originalDraft = JSON.stringify(draft()); field('edit-status').textContent = '';
        field('editor').showModal();
        field('editor').scrollTop = 0;
    }
    function cancelEdit() {
        if (!saving && (JSON.stringify(draft()) === originalDraft || global.confirm('放弃未保存的修改？'))) field('editor').close();
    }
    function updateRepeat() {
        field('repeat-choice').textContent = repeatLabels[repeatFrequency];
        field('repeat-choice').disabled = !!editing?.recurrence && editScope === 'one';
        field('repeat-until-row').hidden = repeatFrequency === 'none';
        pickerButton('until').disabled = !!editing?.recurrence && editScope === 'one';
        field('repeat-clear').disabled = !!editing?.recurrence && editScope === 'one';
        field('repeat-scope').textContent = editing?.recurrence ? `修改范围 · ${scopeLabels[editScope]}` : '';
        document.querySelectorAll('#health-screen [data-repeat]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.repeat === repeatFrequency)));
    }
    function scopeChoices(event, handler) {
        const content = field('detail-content'); content.replaceChildren(node('h2', '选择操作范围'));
        for (const scope of ['one', 'future', 'all']) { const button = action(scopeLabels[scope], async () => {
            try { await handler(scope); }
            catch (error) { content.append(node('p', error.message, 'calendar-muted')); }
        }); button.dataset.eventScope = scope; content.append(button); }
        content.append(action('取消', () => showEvent(event)));
    }
    function showEvent(event) {
        const content = field('detail-content'); content.replaceChildren(node('h2', event.title));
        for (const text of [event.endDate ? '' : event.date, eventTime(event), event.seriesId ? repeatLabels[event.recurrence.frequency] : '', event.location, event.notes]) if (text) content.append(node('p', text));
        content.append(action('编辑', () => {
            if (!event.seriesId) { field('detail').close(); editEvent(event); return; }
            scopeChoices(event, async scope => {
                const series = await global.PersonalSchedule.getSeries(event.id, event.revision);
                const target = scope === 'all' ? series : { ...event, recurrence: series.recurrence };
                field('detail').close(); editEvent(target, scope, event.occurrenceDate);
            });
        }));
        const remove = action('删除', async () => {
            if (event.seriesId) {
                scopeChoices(event, async scope => {
                    if (!global.confirm(`删除${scopeLabels[scope]}的日程？`)) return;
                    await global.PersonalSchedule.changeOccurrence(event.id, event.occurrenceDate, scope, null, event.revision);
                    field('detail').close(); await render();
                }); return;
            }
            if (!global.confirm('删除这条个人日程？删除后仅可从已有备份恢复。')) return;
            remove.disabled = true;
            try { await global.PersonalSchedule.remove(event.id, event.revision); field('detail').close(); await render(); }
            catch (error) { content.append(node('p', error.message, 'calendar-muted')); }
            finally { remove.disabled = false; }
        });
        content.append(remove); field('detail').showModal();
    }
    function openTimetable() {
        document.querySelector('#timetable-screen .back-btn').dataset.target = 'health-screen';
        switchScreen('timetable-screen');
    }
    function shift(offset) {
        if (view === 'month') {
            const date = new Date(selected.slice(0, 7) + '-01T00:00:00Z');
            date.setUTCMonth(date.getUTCMonth() + offset); selected = date.toISOString().slice(0, 10);
        } else selected = dates().addDays(selected, offset * (view === 'week' ? 7 : 1));
        return render();
    }
    function setup() {
        if (ready) return; ready = true;
        field('repeat-choice').onclick = () => { field('repeat-options').hidden = !field('repeat-options').hidden; };
        document.querySelectorAll('#health-screen [data-repeat]').forEach(button => button.onclick = () => { repeatFrequency = button.dataset.repeat; if (repeatFrequency === 'none') eventField('until').value = ''; updateRepeat(); updateTimes(); field('repeat-options').hidden = true; });
        field('repeat-clear').onclick = () => { eventField('until').value = ''; updateTimes(); };
        field('add').onclick = () => editEvent();
        eventField('allDay').onchange = () => { closePicker(false); updateTimes(); };
        document.querySelectorAll('#health-screen [data-event-pick]').forEach(button => { button.onclick = () => openPicker(button.dataset.eventPick); });
        eventField('date').onchange = () => {
            if (!eventField('endDate').value || eventField('endDate').value === previousStartDate) eventField('endDate').value = eventField('date').value;
            previousStartDate = eventField('date').value; updateTimes();
        };
        eventField('endDate').onchange = updateTimes;
        eventField('until').onchange = updateTimes;
        field('edit-cancel').onclick = cancelEdit;
        field('editor').addEventListener('cancel', event => { event.preventDefault(); if (activePicker) closePicker(); else cancelEdit(); });
        field('event-form').onsubmit = async event => {
            event.preventDefault(); if (saving || activePicker) return;
            const value = draft(); saving = true;
            field('edit-status').textContent = '正在保存…';
            const controls = [...field('event-form').elements]; controls.forEach(control => { control.disabled = true; });
            try {
                let saved;
                if (editing.recurrence) saved = await global.PersonalSchedule.changeOccurrence(editing.id, editOccurrence, editScope, value, editing.revision, editScope === 'future' ? 'personal:' + global.crypto.randomUUID() : undefined, editScope === 'one' ? undefined : { frequency: repeatFrequency, until: value.until });
                else if (repeatFrequency !== 'none') saved = await global.PersonalSchedule.saveSeries(editing.id, value, { frequency: repeatFrequency, until: value.until }, editing.revision);
                else saved = await global.PersonalSchedule.save(editing.id, value, editing.revision);
                if (editing.recurrence && editScope === 'one') saved = value;
                field('editor').close(); selected = editScope === 'all' && editing.recurrence || eventOccursOn(saved, selected) ? selected : saved.date; await render();
            } catch (error) { field('edit-status').textContent = error.message; }
            finally { saving = false; controls.forEach(control => { control.disabled = false; }); updateRepeat(); }
        };
        field('previous').onclick = () => void shift(-1); field('next').onclick = () => void shift(1);
        field('today').onclick = () => { selected = today(); void render(); };
        field('source').onchange = () => void saveDisplay({ sourceId: field('source').value });
        field('period').onchange = () => void saveDisplay({ showPeriod: field('period').checked });
        field('timetable').onclick = openTimetable;
        field('period-edit').onclick = () => void openPeriod(selected);
        field('period-settings').onclick = () => global.PeriodCalendarUI.openSettings(render).catch(() => { field('status').textContent = '设置读取失败，请重试'; });
        document.querySelectorAll('#health-screen [data-cal-view]').forEach(button => button.onclick = () => void saveDisplay({ view: button.dataset.calView }));
    }
    async function open() {
        setup(); if (!selected) selected = today();
        applyDisplay(global.db?.calendarDisplaySettings);
        try { await render(); }
        catch { field('status').textContent = '日历读取失败，请重新打开'; }
    }
    global.MioCalendar = Object.freeze({ open, range });
})(window);
