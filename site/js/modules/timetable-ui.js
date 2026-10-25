(function (global) {
    'use strict';
    const field = name => document.querySelector(`#timetable-screen [data-tt="${name}"]`);
    const api = () => global.Timetable;
    let ready = false, snapshots = [], selected = null, generation = 0, busy = false;
    let view = 'day', dateCovered = false;
    let detailCourse = null, editableCourses = [], dirty = false, panel = '', panelTrigger = null;
    let syncState = null;
    let editBaseline = null;
    let confirming = false, manualDraft = null;
    let pendingShareRole = null;
    let pendingCalendarTarget = null;
    const note = text => { field('status').textContent = text; field('panel-status').textContent = text; };
    const element = (tag, text, className) => {
        const node = document.createElement(tag); node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const week = () => {
        const value = Number(field('week').value);
        if (!Number.isInteger(value) || value < 1 || value > 60) throw new Error('请输入 1 至 60 的教学周');
        return value;
    };
    function button(text, action) {
        const node = element('button', text); node.type = 'button';
        node.onclick = () => void run(action); return node;
    }
    async function run(action) {
        if (busy || confirming) return;
        busy = true;
        const controls = [...document.querySelectorAll('#timetable-screen button, #timetable-screen input, #timetable-screen select')];
        const previous = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try { await action(); }
        catch (error) { note(error.message || '课表操作失败，请重试'); }
        finally {
            controls.forEach((control, index) => { control.disabled = previous[index]; });
            busy = false; updateControls();
        }
    }
    async function confirmAction(message) {
        if (confirming) return false;
        confirming = true;
        const dialog = field('dialog'), wasOpen = dialog.open;
        const trigger = document.activeElement;
        if (wasOpen) dialog.close();
        try { return await global.showAppConfirmDialog({ title: '课程表', message, dismissText: '' }) === 'confirm'; }
        finally { confirming = false; if (wasOpen) { dialog.showModal(); trigger?.focus?.(); } }
    }
    function connectionStatus() {
        const state = global.TimetableBridge?.getStatus?.() || { code: 'unchecked' };
        const messages = {
            unchecked: ['尚未检查连接', '点击“检查连接”读取当前扩展状态，不会同步课程。'],
            timeout: ['未收到扩展响应', '请在当前 Mio 标签页点击课表扩展，再检查连接。未响应不能确定是未安装还是通道未恢复。'],
            unavailable: ['扩展连接不可用', '确认学校课表页仍打开；若学校页刷新、关闭或切换过账号，请在扩展中断开后重新配对。'],
            'query-required': ['已配对 · 等待学校查询', '去学校的“学生课表按周次查询”正常查询一次，再回来检查连接。'],
            ready: ['查询通道已就绪 · 待同步验证', '可同步学校所选周。通道就绪不代表学校登录仍有效，也不代表已取得最新课表。'],
            'authorization-required': ['学校登录已失效', '请在学校页面正常重新登录、查询课表，再检查连接。'],
            'invalid-response': ['连接返回内容异常', '请重新加载课表扩展并配对，确认学校所选学期和教学周。已有课表保留。'],
        };
        let [title, help] = messages[state.code] || messages.unavailable;
        if (state.ready && selected && (selected.provider !== 'sdmu-weekly' || selected.scopeKey !== state.scopeKey || selected.semester !== state.semester)) {
            title = '当前通道与所选缓存课表不同';
            help = '“同步学校所选周”将使用当前配对及学期；旧课表和个人调整保留，不会自动合并。';
        }
        field('bridge-status').textContent = title;
        field('bridge-help').textContent = help;
        field('bridge-check-time').textContent = state.checkedAt ? `最近检查：${new Date(state.checkedAt).toLocaleTimeString('zh-CN')}` : '';
        field('sync-school').disabled = busy || !state.ready;
        return title;
    }
    function updateControls() {
        connectionStatus();
        const bridge = global.TimetableBridge?.getStatus?.();
        const canRefresh = selected && api().canRefresh(selected.provider, selected.scopeKey)
            && !(selected.provider === 'sdmu-weekly' && bridge?.ready && bridge.semester !== selected.semester);
        const currentWeek = Number(field('week').value) || 1;
        field('previous-week').disabled = busy || !selected || currentWeek <= 1;
        field('next-week').disabled = busy || !selected || currentWeek >= (selected?.manualConfig?.weekCount || 60);
        document.querySelector('#timetable-screen [data-tt-open="edit"]').disabled = busy;
        field('share-save').disabled = busy || !field('share-role').value || field('share-range').value !== 'off' && !selected;
        field('refresh').disabled = busy || !canRefresh;
        field('refresh-current').disabled = busy || !canRefresh || !global.TimetableCore.resolveDate(selected, api().schoolDate()).covered;
        field('auto-sync').disabled = busy || !selected || selected.provider !== 'sdmu-weekly' || !syncState?.autoSyncEnabled && !api().canRefresh(selected.provider, selected.scopeKey);
        field('disconnect').disabled = busy || !selected || selected.provider === 'manual';
        field('delete-manual').hidden = selected?.provider !== 'manual';
        field('delete-manual').disabled = busy || selected?.provider !== 'manual';
        field('week').max = selected?.manualConfig?.weekCount || 60;
        field('save').disabled = busy || !selected || view === 'day' && !dateCovered || field('type').value !== 'add' && !field('target').value;
        field('semester').disabled = busy || snapshots.length === 0;
        field('target-label').hidden = field('type').value === 'add';
        field('fields').disabled = field('type').value === 'cancel';
        field('fields').hidden = field('type').value === 'cancel';
    }
    function fillCourse() {
        const course = editableCourses.find(item => item.id === field('target').value);
        editBaseline = course || null;
        if (field('type').value === 'add') {
            for (const key of ['name', 'location', 'teacher', 'sections']) field(key).value = '';
            field('weeks').value = selected?.provider === 'manual' ? `1-${selected.manualConfig.weekCount}` : field('week').value;
            field('weekday').value = String(view === 'day' ? global.TimetableCore.resolveDate(selected, field('date').value).weekday || 1 : 1);
        } else if (course) {
            for (const key of ['name', 'location', 'teacher', 'weekday']) field(key).value = course[key];
            field('sections').value = course.sections.join(','); field('weeks').value = course.weeks.join(',');
        }
        field('edit-hint').textContent = selected?.provider === 'manual'
            ? `手工学期共 ${selected.manualConfig.weekCount} 周，每天 ${selected.manualConfig.sectionCount} 节；未设置具体钟点。`
            : '只修改 Mio 中的个人安排，不回写学校课表；取消课程可在“我的调整”中撤销。';
        updateControls();
    }
    async function createManual() {
        if (field('dialog').open) field('dialog').close();
        const start = new Date(`${api().schoolDate()}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
        const draft = manualDraft || { semester: '', startDate: start.toISOString().slice(0, 10), weekCount: 20, sectionCount: 12 };
        const result = await global.showAppFormDialog({ title: '新建手工课表', confirmText: '创建学期',
            message: '无需连接学校。课程与教务来源独立保存；开始日填写第一教学周的周一，节次不推算具体钟点。',
            fields: [
                { name: 'semester', label: '学期名称', value: draft.semester, required: true, maxLength: 80 },
                { name: 'startDate', label: '学期开始日（第一周周一）', type: 'date', value: draft.startDate, required: true },
                { name: 'weekCount', label: '教学周数（1–60）', type: 'number', value: draft.weekCount, min: 1, max: 60, step: 1, required: true },
                { name: 'sectionCount', label: '每天节数（1–30）', type: 'number', value: draft.sectionCount, min: 1, max: 30, step: 1, required: true },
            ] });
        if (!result) return;
        manualDraft = result;
        const snapshot = await api().createManualSemester(result);
        manualDraft = null; dirty = false; panel = '';
        field('semester').append(new Option(snapshot.semester, snapshot.id)); field('semester').value = snapshot.id;
        selected = snapshot; view = 'day'; field('date').value = snapshot.manualConfig.startDate; field('week').value = '1';
        await render();
        await openPanel('edit'); field('type').value = 'add'; field('scope').value = 'all'; fillCourse();
        note('手工课表已创建，现在可以添加课程');
    }
    async function render(calendarTarget = null) {
        const token = ++generation;
        let currentWeek = week();
        const rows = await api().listSnapshots();
        if (token !== generation) return;
        snapshots = rows.sort((a, b) => b.updatedAt - a.updatedAt);
        const previousId = selected?.id;
        selected = calendarTarget ? snapshots.find(row => row.id === calendarTarget.snapshotId) || null
            : snapshots.find(row => row.id === field('semester').value) || snapshots[0] || null;
        if (calendarTarget) { view = 'day'; field('date').value = calendarTarget.date; }
        const roleId = field('share-role').value;
        field('share-role').replaceChildren(...(global.db?.characters || []).map(role => new Option(role.remarkName || role.realName || role.name || '角色', String(role.id))));
        if ([...field('share-role').options].some(option => option.value === roleId)) field('share-role').value = roleId;
        await renderSharing();
        if (token !== generation) return;
        if (!calendarTarget && selected?.coverage === 'weekly' && previousId !== selected.id) {
            const today = global.TimetableCore.resolveDate(selected, api().schoolDate());
            const cachedWeeks = Object.keys(selected.weekDates || {}).map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 60).sort((a, b) => b - a);
            currentWeek = today.covered ? today.week : selected.provider === 'manual' ? 1 : cachedWeeks[0] || currentWeek;
            field('week').value = String(currentWeek);
            if (view === 'day') field('date').value = selected.provider === 'manual' && !today.covered ? selected.manualConfig.startDate : api().schoolDate();
        }
        field('semester').replaceChildren(...snapshots.map((row, index) => new Option(`${row.semester} · ${row.provider === 'manual' ? '手工课表' : `课表 ${index + 1}`}`, row.id)));
        if (selected) field('semester').value = selected.id;
        else if (calendarTarget) field('semester').value = '';
        field('courses').replaceChildren(); field('adjustments').replaceChildren(); field('changes').replaceChildren();
        updateControls();
        field('date-label').hidden = false;
        field('week-view').setAttribute('aria-pressed', String(view === 'week'));
        field('day-view').setAttribute('aria-pressed', String(view === 'day'));
        field('coverage').textContent = '';
        if (!selected) {
            dateCovered = false;
            syncState = null; field('auto-sync').checked = false; field('auto-status').textContent = '连接并首次同步后可开启自动刷新';
            editableCourses = []; field('target').replaceChildren();
            field('connection').textContent = '尚无已保存的学校课表'; field('sync-time').textContent = '';
            const bridge = global.TimetableBridge?.getStatus?.();
            const lastAttempt = bridge?.scopeKey ? await api().getSyncState('sdmu-weekly', bridge.scopeKey) : null;
            if (token !== generation) return;
            if (lastAttempt?.requiresAuthorization) field('connection').textContent += ' · 上次同步登录失效，请在学校页重新登录';
            else if (lastAttempt?.status === 'error') field('connection').textContent += ' · 上次同步失败，请核对学校查询与连接后重试';
            field('courses').append(element('p', '还没有课表。点击“添加课程”即可新建手工学期，无需连接学校；也可在“同步”中连接教务。', 'tt-empty'));
            renderNavigation(null, currentWeek);
            field('sync-brief').textContent = `${connectionStatus()} ›`;
            return;
        }
        const snapshot = selected;
        const [state, effective, adjustments, changes] = await Promise.all([
            api().getSyncState(snapshot.provider, snapshot.scopeKey),
            view === 'day' ? api().getEffectiveDate(snapshot.provider, snapshot.scopeKey, snapshot.semester, field('date').value) : api().getEffectiveWeek(snapshot.provider, snapshot.scopeKey, snapshot.semester, currentWeek),
            api().listAdjustments(snapshot.id), api().listChanges(snapshot.id),
        ]);
        if (token !== generation) return;
        editableCourses = global.TimetableCore.applyAdjustments(snapshot.courses, adjustments, {
            week: effective.week || currentWeek, date: view === 'day' ? field('date').value : '', semester: snapshot.semester, scopeKey: snapshot.scopeKey,
        }).courses;
        // Week projection also includes adjustments limited to an individual mapped date.
        editableCourses = editableCourses.map(course => effective.courses.find(item => item.id === course.id) || course);
        const targetId = field('target').value;
        field('target').replaceChildren(...editableCourses.map(course => new Option(`${course.name} · 周${course.weekday} · ${course.sections.join(',')}节`, course.id)));
        if (editableCourses.some(course => course.id === targetId)) field('target').value = targetId;
        syncState = state;
        field('auto-sync').checked = state?.autoSyncEnabled === true;
        const autoLabels = { off: '自动刷新已关闭', waiting: '已开启：等待下次前台刷新', running: '正在自动刷新本周与下周', hidden: '已暂停：Mio 页面当前不可见', offline: '已暂停：当前离线', mapping: '已暂停：缺少今天的学校日期映射，请先选择教学周同步', error: '已暂停：请手动刷新成功后恢复', unavailable: '已暂停：请恢复当前课表的扩展连接' };
        field('auto-status').textContent = state?.autoSyncEnabled ? autoLabels[global.TimetableBridge?.autoStatus(snapshot.scopeKey)] || autoLabels.unavailable : autoLabels.off;
        const labels = { connected: '上次同步成功', disconnected: '已断开连接', syncing: '正在同步', partial: '同步内容不完整，已保留上次课表', 'authorization-required': '登录已过期，请在学校页面重新登录', error: '同步失败，已保留上次课表' };
        field('connection').textContent = `${labels[state?.status] || '本地缓存'}${api().canRefresh(snapshot.provider, snapshot.scopeKey) ? '' : ' · 当前同步连接不可用'}`;
        const format = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '暂无';
        field('sync-time').textContent = `成功同步：${format(state?.lastSuccessAt)}；最近尝试：${format(state?.lastAttemptAt)}（北京时间）`;
        field('sync-brief').textContent = `${connectionStatus()} · ${labels[state?.status] || '本地缓存'} ›`;
        if (snapshot.provider === 'manual') {
            field('connection').textContent = '手工课表 · 未经教务核验';
            field('sync-time').textContent = `${snapshot.manualConfig.startDate} 起 · ${snapshot.manualConfig.weekCount} 周 · 每天 ${snapshot.manualConfig.sectionCount} 节`;
            field('auto-status').textContent = '手工课表不参与学校同步';
            field('sync-brief').textContent = `${snapshot.semester} · 手工课表 · 来源与设置 ›`;
        }
        field('changes-entry').textContent = `变动记录${changes.some(item => !item.acknowledged) ? ` · ${changes.filter(item => !item.acknowledged).length}` : ''}`;
        if (view === 'day' && effective.covered) {
            currentWeek = effective.week; field('week').value = String(currentWeek);
        }
        const weekDates = snapshot.weekDates?.[currentWeek];
        const covered = view === 'day' ? effective.covered : snapshot.coverage !== 'weekly' || Array.isArray(weekDates) && weekDates.length === 7;
        dateCovered = view === 'day' && covered;
        renderNavigation(snapshot, currentWeek);
        const missing = snapshot.weekStatus?.[currentWeek]?.missingCount || 0;
        field('coverage').textContent = !covered
            ? snapshot.provider === 'manual' ? '该日期或周次不在手工学期范围内，请选择学期内日期。' : effective.reason === 'ambiguous-date' ? '该日期对应多个教学周，请核对学校日期映射。' : view === 'day' ? '该日期尚无已同步的学校日期映射，不能判断是否有课。' : '该教学周尚未同步，不能判断是否有课。'
            : `${view === 'day' ? `${effective.date} · ` : ''}第 ${currentWeek} 教学周${missing ? ` · 有 ${missing} 条来源缺失课程暂保留，需核对` : ''}`;
        renderCourses(effective.courses, covered, changes, adjustments, currentWeek, weekDates);
        if (effective.conflicts.length) field('courses').prepend(element('p', `有 ${effective.conflicts.length} 项调整无法应用，请在“我的调整”中核对并撤销。`, 'tt-note'));
        for (const adjustment of adjustments) {
            const row = element('article', '');
            const name = adjustment.course?.name || snapshot.courses.find(course => course.id === adjustment.targetCourseId)?.name
                || adjustments.find(item => item.type === 'add' && item.course.id === adjustment.targetCourseId)?.course.name || '原课程已移除';
            row.append(element('p', `${({ add: '新增', modify: '修改', cancel: '取消' })[adjustment.type]} · ${name}`));
            row.append(element('p', adjustment.date || (adjustment.week ? `第 ${adjustment.week} 周` : '所有适用教学周'), 'tt-note'));
            if (adjustment.type === 'modify') row.append(element('p', Object.entries(adjustment.patch).map(([key, value]) => `${({ name: '名称', location: '教室', teacher: '教师', weekday: '星期', sections: '节次', weeks: '周次' })[key] || key}：${value}`).join(' · '), 'tt-note'));
            row.append(button('撤销调整', async () => {
                if (!await confirmAction(`撤销“${name}”的这项调整？教务原数据保留。`)) return;
                await api().deleteAdjustment(adjustment.id, adjustment.revision); await render(); note('调整已撤销');
            })); field('adjustments').append(row);
        }
        if (!adjustments.length) field('adjustments').append(element('p', '尚无手动调整', 'tt-note'));
        for (const change of changes) {
            const row = element('article', '');
            row.append(element('p', `${changeLabel(change)} · ${change.after?.name || change.before?.name || ''}`));
            row.append(element('p', `发现时间：${format(change.detectedAt)}`, 'tt-note'));
            for (const changeField of change.fields || []) row.append(element('p', `${({ location: '教室', teacher: '教师', weekday: '星期', sections: '节次', weeks: '教学周', name: '名称' })[changeField.field] || changeField.field}：${changeField.before} → ${changeField.after}`, 'tt-note'));
            if (!change.acknowledged) row.append(button('已知晓', async () => { await api().acknowledgeChanges(change.id); await render(); }));
            else row.append(element('p', '已知晓', 'tt-note'));
            field('changes').append(row);
        }
        if (!changes.length) field('changes').append(element('p', '暂无变动记录', 'tt-note'));
        return { snapshotId: snapshot.id, effective };
    }
    async function openPanel(name) {
        if (confirming || dirty && !await confirmAction('放弃尚未保存的修改？')) return false;
        dirty = false; panel = name;
        const dialog = field('dialog');
        if (!dialog.open) panelTrigger = document.activeElement;
        for (const node of dialog.querySelectorAll('[data-tt-panel]')) {
            node.hidden = node.dataset.ttPanel !== name;
            if (node.tagName === 'DETAILS') node.open = true;
        }
        field('panel-title').textContent = ({ sync: '课表同步', edit: '调整课程', detail: '课程详情', adjustments: '我的调整', changes: '变动记录', sharing: '角色共享' })[name];
        dialog.setAttribute('aria-label', field('panel-title').textContent);
        field('panel-status').textContent = '';
        if (!dialog.open) dialog.showModal();
        dialog.scrollTop = 0;
        return true;
    }
    async function closePanel() {
        if (busy || confirming || dirty && !await confirmAction('放弃尚未保存的修改？')) return;
        dirty = false; panel = ''; field('dialog').close(); panelTrigger?.focus?.();
    }
    function changeLabel(change) {
        if (change.type === 'added') return '新增课程';
        if (change.type === 'removed') return '课表中已移除';
        const keys = (change.fields || []).map(item => item.field);
        return [keys.some(key => ['weekday', 'sections', 'weeks', 'startTime', 'endTime'].includes(key)) ? '上课安排变更' : '', keys.includes('location') ? '教室变更' : ''].filter(Boolean).join(' · ') || '课程信息变更';
    }
    function renderNavigation(snapshot, currentWeek) {
        const dates = snapshot?.weekDates?.[currentWeek] || [];
        const sorted = dates.map(item => item.date).sort();
        field('week-title').textContent = snapshot ? `第 ${currentWeek} 教学周` : '今天的课程';
        field('date-range').textContent = sorted.length === 7 ? `${sorted[0]} — ${sorted[6]}` : '日期映射尚未同步';
        field('dates').replaceChildren();
        for (let day = 1; day <= 7; day++) {
            const date = dates.find(item => item.weekday === day)?.date;
            const node = button('', async () => { field('date').value = date; view = 'day'; await render(); });
            node.append(element('span', '一二三四五六日'[day - 1]), element('strong', date ? date.slice(8) : '—'));
            node.disabled = !date;
            node.setAttribute('aria-label', date ? `星期${'一二三四五六日'[day - 1]} ${date}` : '该日日期未同步');
            node.setAttribute('aria-pressed', String(view === 'day' && date === field('date').value));
            if (date === api().schoolDate()) node.classList.add('tt-today');
            field('dates').append(node);
        }
        field('grid-hint').hidden = view !== 'week';
    }
    async function showCourse(course) {
        if (!await openPanel('detail')) return;
        detailCourse = course;
        const body = field('course-detail'); body.replaceChildren(element('h3', course.name));
        for (const [label, value] of [['时间', course.startTime && course.endTime ? `${course.startTime}–${course.endTime}` : '学校未提供具体钟点'], ['星期', '一二三四五六日'[course.weekday - 1]], ['节次', course.sections.join('、')], ['教学周', course.weeks.join('、')], ['教室', course.location || '未提供'], ['教师', course.teacher || '未提供'], ['来源', course.source === 'manual' ? '手动新增' : '学校课表（已应用个人调整）']]) body.append(element('p', `${label} · ${value}`));
    }
    function renderCourses(courses, covered, changes, adjustments, currentWeek, dates) {
        const host = field('courses'); host.className = view === 'week' ? 'tt-grid-scroll' : 'tt-day-list';
        host.tabIndex = view === 'week' ? 0 : -1;
        host.setAttribute('aria-label', view === 'week' ? '按星期和节次排列的课表，可横向滚动' : '当日课程');
        if (!covered) { host.append(element('p', selected?.provider === 'manual' ? '请选择手工学期内的教学周或日期。' : '尚未同步此范围。可在“同步”中刷新对应教学周。', 'tt-empty')); return; }
        const card = course => {
            const node = button('', () => showCourse(course)); node.className = 'tt-course';
            node.dataset.courseId = course.id;
            node.setAttribute('aria-label', `${course.name}，星期${'一二三四五六日'[course.weekday - 1]}，${course.sections.join('、')}节，${course.location || '教室未提供'}，查看详情`);
            node.append(element('span', course.startTime && course.endTime ? `${course.startTime}–${course.endTime}` : `${course.sections.join('、')} 节`, 'tt-course-time'), element('strong', course.name), element('span', course.location || '教室未提供', 'tt-course-place'));
            const latest = changes.find(change => change.courseId === course.id && !change.acknowledged);
            const adjusted = adjustments.some(item => item.targetCourseId === course.id && (!item.week || item.week === currentWeek) && (!item.date || item.date === (view === 'day' ? field('date').value : dates?.find(row => row.weekday === course.weekday)?.date)));
            const badge = course.source === 'manual' ? '手动新增' : adjusted ? '已手动调整' : latest ? changeLabel(latest) : '';
            if (badge) node.append(element('small', badge, 'tt-badge'));
            return node;
        };
        if (view === 'day') {
            host.append(element('h3', `${field('date').value === api().schoolDate() ? '今天' : field('date').value} · ${courses.length} 门课`));
            if (!courses.length) host.append(element('p', '这一天，课表上没有课程。', 'tt-empty'));
            courses.forEach(course => host.append(card(course))); return;
        }
        const maxSection = Math.max(selected?.manualConfig?.sectionCount || 8, ...courses.flatMap(course => course.sections));
        const grid = element('div', '', 'tt-week-grid');
        const numbers = element('div', '', 'tt-section-column'); numbers.append(element('div', '节次', 'tt-grid-heading'));
        for (let section = 1; section <= maxSection; section++) numbers.append(element('div', String(section), 'tt-section-number'));
        grid.append(numbers);
        for (let day = 1; day <= 7; day++) {
            const column = element('div', '', 'tt-day-column');
            const date = dates?.find(item => item.weekday === day)?.date;
            column.append(element('div', `周${'一二三四五六日'[day - 1]}${date ? ' · ' + date.slice(5) : ''}`, 'tt-grid-heading'));
            const slots = element('div', '', 'tt-slots'); slots.style.gridTemplateRows = `repeat(${maxSection}, 84px)`;
            const runs = [];
            for (const course of courses.filter(item => item.weekday === day)) {
                let run;
                for (const section of course.sections) {
                    if (!run || section !== run.end + 1) { run = { course, start: section, end: section }; runs.push(run); }
                    else run.end = section;
                }
            }
            const ends = [];
            runs.sort((a, b) => a.start - b.start || a.end - b.end).forEach(run => {
                let lane = ends.findIndex(end => end < run.start);
                if (lane < 0) lane = ends.length;
                ends[lane] = run.end;
                const node = card(run.course); node.style.gridRow = `${run.start} / ${run.end + 1}`; node.style.gridColumn = String(lane + 1);
                slots.append(node);
            });
            slots.style.gridTemplateColumns = `repeat(${Math.max(1, ends.length)}, minmax(88px, 1fr))`;
            column.append(slots); grid.append(column);
        }
        host.append(grid);
    }
    async function renderSharing() {
        const roleId = field('share-role').value;
        const grant = roleId ? await api().getRoleShare(roleId) : null;
        if (roleId !== field('share-role').value) return;
        const matches = grant && selected && grant.provider === selected.provider && grant.scopeKey === selected.scopeKey && grant.semester === selected.semester;
        field('share-range').value = matches ? grant.range : 'off';
        field('share-location').checked = matches && grant.location;
        field('share-teacher').checked = matches && grant.teacher;
        field('share-status').textContent = !roleId ? '请先创建角色。' : matches ? '已共享当前课表。修改后请保存。' : grant ? '该角色已共享其他课表；保存新授权将替换原授权，保存“不共享”将撤销全部课表授权。' : '该角色尚未授权。';
        updateControls();
    }
    async function save() {
        const snapshot = selected;
        if (!snapshot) throw new Error('请先新建手工学期或同步学校课表');
        if (view === 'day' && !dateCovered) throw new Error('该日期尚未对应教学周，请切换周课表后调整');
        const type = field('type').value;
        const values = Object.fromEntries(['name', 'location', 'teacher', 'weekday', 'sections', 'weeks'].map(key => [key, field(key).value]));
        const normalized = type === 'cancel' ? null : global.TimetableCore.normalizeCourse(values, snapshot);
        const original = editBaseline;
        if (type !== 'add' && (!original || original.id !== field('target').value)) throw new Error('请选择要调整的课程');
        const patch = {};
        if (type === 'modify') for (const key of Object.keys(values)) if (JSON.stringify(original?.[key]) !== JSON.stringify(normalized[key])) patch[key] = normalized[key];
        if (type === 'modify' && !Object.keys(patch).length) throw new Error('还没有修改课程内容');
        await api().saveAdjustment(snapshot.id, {
            id: `adjustment:${global.crypto.randomUUID()}`, type, targetCourseId: original?.id || '',
            week: field('scope').value === 'week' ? week() : null,
            ...(type === 'add' ? { course: values } : { patch }),
        }, { expectedRevision: 0 });
        dirty = false; field('dialog').close(); panel = '';
        await render(); note('调整已保存'); panelTrigger?.focus?.();
    }
    function setup() {
        if (ready) return; ready = true;
        const dialog = field('dialog');
        document.querySelectorAll('#timetable-screen [data-tt-panel]').forEach(node => dialog.append(node));
        field('close-panel').onclick = closePanel;
        dialog.addEventListener('cancel', event => { event.preventDefault(); closePanel(); });
        dialog.addEventListener('input', () => { if (panel === 'edit' || panel === 'sharing') dirty = true; });
        field('create-manual').onclick = () => void run(createManual);
        field('delete-manual').onclick = () => void run(async () => {
            const snapshot = selected;
            if (snapshot?.provider !== 'manual' || !await confirmAction('删除这个手工学期及其课程和调整？其他手工学期与学校课表保持不变。')) return;
            await api().clearScope(snapshot.provider, snapshot.scopeKey);
            field('dialog').close(); panel = ''; field('semester').value = ''; selected = null;
            await render(); note('手工学期已删除');
        });
        document.querySelectorAll('#timetable-screen [data-tt-open]').forEach(node => {
            node.onclick = async () => {
                if (busy || confirming) return;
                if (node.dataset.ttOpen === 'edit' && !selected) { await run(createManual); return; }
                if (await openPanel(node.dataset.ttOpen) && node.dataset.ttOpen === 'edit') { field('type').value = 'add'; field('scope').value = selected.provider === 'manual' ? 'all' : 'week'; fillCourse(); }
            };
        });
        field('edit-course').onclick = async () => {
            if (busy || !detailCourse || !await openPanel('edit')) return;
            field('type').value = 'modify'; field('target').value = detailCourse.id; fillCourse();
            editBaseline = detailCourse; field('scope').value = 'week';
            for (const key of ['name', 'location', 'teacher', 'weekday']) field(key).value = detailCourse[key];
            field('sections').value = detailCourse.sections.join(','); field('weeks').value = detailCourse.weeks.join(',');
        };
        field('cancel-course').onclick = async () => {
            if (busy || !detailCourse || !await openPanel('edit')) return;
            field('type').value = 'cancel'; field('scope').value = 'week'; field('target').value = detailCourse.id; fillCourse();
        };
        field('check-connection').onclick = () => void run(async () => {
            await global.TimetableBridge?.probe(); await render(); note('连接检查完成；未请求学校课表数据。');
        });
        field('sync-school').onclick = () => void run(async () => {
            try {
                await global.TimetableBridge.refresh();
                field('semester').value = ''; selected = null;
                note('学校所选周已同步，个人调整保留');
            } finally { await render(); }
        });
        for (const [name, offset] of [['previous-week', -1], ['next-week', 1]]) field(name).onclick = () => void run(async () => {
            const targetWeek = Math.max(1, Math.min(selected?.manualConfig?.weekCount || 60, week() + offset));
            const day = global.TimetableCore.resolveDate(selected, field('date').value).weekday || 1;
            const date = selected?.weekDates?.[targetWeek]?.find(row => row.weekday === day)?.date;
            field('week').value = String(targetWeek);
            if (date) field('date').value = date; else view = 'week';
            await render();
        });
        field('share-role').onchange = () => void run(renderSharing);
        field('share-range').onchange = updateControls;
        field('share-save').onclick = () => void run(async () => {
            const range = field('share-range').value;
            await api().setRoleShare(field('share-role').value, selected?.id, range === 'off' ? null : { range, location: field('share-location').checked, teacher: field('share-teacher').checked });
            dirty = false;
            await renderSharing(); note(range === 'off' ? '已撤销该角色的课表共享' : '已保存该角色的课表共享');
        });
        field('semester').onchange = () => void run(async () => { await render(); fillCourse(); note(''); });
        field('date').value = api().schoolDate();
        field('week').onchange = () => void run(async () => { view = 'week'; await render(); });
        field('date').onchange = () => void run(async () => { view = 'day'; await render(); });
        field('week-view').onclick = () => void run(async () => { view = 'week'; await render(); });
        field('day-view').onclick = () => void run(async () => {
            if (view === 'week') {
                const mapping = global.TimetableCore.resolveDate(selected, field('date').value);
                const dates = selected?.weekDates?.[week()];
                const date = dates?.find(row => row.weekday === mapping.weekday)?.date || dates?.[0]?.date;
                if (!date) { note('该教学周尚无日期映射，请先同步；已保留周视图。'); return; }
                field('date').value = date;
            }
            view = 'day'; await render();
        });
        for (const [name, offset] of [['today', 0], ['tomorrow', 86400000]]) field(name).onclick = () => void run(async () => {
            view = 'day'; field('date').value = api().schoolDate(Date.now() + offset); await render();
        });
        field('type').onchange = fillCourse; field('target').onchange = fillCourse;
        field('form').onsubmit = event => { event.preventDefault(); void run(save); };
        field('refresh').onclick = () => void run(async () => {
            try { await api().refresh({ ...selected, week: week() }); note('刷新完成'); }
            finally { await global.TimetableBridge?.scheduleAuto(); await render(); }
        });
        field('refresh-current').onclick = () => void run(async () => {
            try {
                const result = await api().refreshCurrent(selected);
                view = 'week'; field('week').value = String(result.currentWeek); note('本周与下周已同步');
            } finally { await global.TimetableBridge?.scheduleAuto(); await render(); }
        });
        field('auto-sync').onchange = () => {
            const enabled = field('auto-sync').checked;
            void run(async () => {
                try { await api().setAutoSync(selected.provider, selected.scopeKey, enabled); }
                finally { await global.TimetableBridge?.scheduleAuto(); await render(); }
                note(enabled ? '已开启前台自动刷新' : '自动刷新已关闭');
            });
        };
        global.addEventListener('mio-timetable-auto-state', () => {
            if (!busy && !dialog.open && document.querySelector('#timetable-screen')?.classList.contains('active')) void run(render);
        });
        field('disconnect').onclick = () => void run(async () => {
            const snapshot = selected;
            if (!await confirmAction('断开当前连接？本地课表和调整将保留。')) return;
            try { await api().disconnect(snapshot.provider, snapshot.scopeKey); note('连接已断开，本地课表已保留'); }
            finally { await render(); }
        });
        const reconnect = () => {
            if (busy || confirming || dialog.open && panel !== 'sync' || !document.querySelector('#timetable-screen')?.classList.contains('active')) return;
            void run(async () => { await global.TimetableBridge?.probe(); await render(); });
        };
        global.addEventListener('focus', reconnect);
        global.addEventListener('mio-timetable-connection', reconnect);
    }
    global.TimetableUI = Object.freeze({
        async openFromCalendar(target) {
            if (busy || confirming || !target || typeof target.snapshotId !== 'string' || !target.snapshotId || typeof target.courseId !== 'string' || !target.courseId) return false;
            try { global.TimetableCore.resolveDate(null, target.date); }
            catch { return false; }
            const destination = { snapshotId: target.snapshotId, date: target.date, courseId: target.courseId };
            if (dirty && !await confirmAction('放弃尚未保存的修改？')) return false;
            dirty = false; panel = ''; detailCourse = null; field('dialog').close();
            pendingShareRole = null;
            pendingCalendarTarget = destination;
            document.querySelector('#timetable-screen .back-btn').dataset.target = 'health-screen';
            switchScreen('timetable-screen');
            return true;
        },
        openForRole(roleId) {
            if (busy || confirming || !global.db?.characters?.some(role => String(role.id) === String(roleId))) return;
            pendingCalendarTarget = null;
            pendingShareRole = String(roleId);
            document.querySelector('#timetable-screen .back-btn').dataset.target = 'chat-settings-screen';
            switchScreen('timetable-screen');
        },
        open() {
            setup();
            const roleId = pendingShareRole;
            const calendarTarget = pendingCalendarTarget;
            pendingShareRole = null; pendingCalendarTarget = null;
            return run(async () => {
                view = 'day'; field('date').value = api().schoolDate();
                if (calendarTarget) {
                    selected = null; detailCourse = null; editableCourses = []; field('courses').replaceChildren(); note('');
                } else await global.TimetableBridge?.probe();
                const result = await render(calendarTarget); fillCourse();
                if (calendarTarget) {
                    if (!result) { note('原课表已移除，请重新选择课表'); return; }
                    if (!result.effective.covered) { note(field('coverage').textContent); return; }
                    const matches = result.effective.courses.filter(course => course.id === calendarTarget.courseId);
                    if (matches.length !== 1) { note('该课程已变化或不在此日期，请核对当天课表'); return; }
                    const card = [...field('courses').querySelectorAll('[data-course-id]')].find(node => node.dataset.courseId === calendarTarget.courseId);
                    card?.focus({ preventScroll: true }); card?.scrollIntoView({ block: 'center', behavior: 'instant' });
                    await showCourse(matches[0]);
                    return;
                }
                if (roleId && global.db?.characters?.some(role => String(role.id) === roleId)) {
                    const grant = await api().getRoleShare(roleId);
                    const snapshot = grant && snapshots.find(row => row.provider === grant.provider && row.scopeKey === grant.scopeKey && row.semester === grant.semester);
                    if (snapshot) { field('semester').value = snapshot.id; await render(); }
                    field('share-role').value = roleId;
                    await renderSharing();
                    await openPanel('sharing');
                }
            });
        }
    });
})(window);
