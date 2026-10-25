// --- 提醒事项模块 ---

// Calendar receives detached user-facing records only. No scheduling or persistence here.
window.ReminderCalendar = Object.freeze({
    list(from, to) {
        if (!window.PeriodHealthCore.validDate(from) || !window.PeriodHealthCore.validDate(to) || from > to) throw new Error('提醒日期范围无效');
        const rows = [];
        for (const char of db.characters || []) {
            for (const reminder of Array.isArray(char.reminders) ? char.reminders : []) {
                if (!reminder || reminder.type !== 'toUser' || !window.PeriodHealthCore.validDate(reminder.date) || reminder.date < from || reminder.date > to) continue;
                rows.push({
                    characterId: char.id, id: reminder.id,
                    characterName: String(char.remarkName || char.realName || '角色'),
                    title: String(reminder.title || '提醒'), date: reminder.date,
                    time: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminder.time || '') ? reminder.time : '',
                    done: !!reminder.done, triggered: !!reminder.triggered,
                    repeat: ['daily', 'weekly', 'monthly'].includes(reminder.repeat) ? reminder.repeat : 'none',
                });
            }
        }
        return rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.characterName.localeCompare(b.characterName));
    },
});

let reminderCalYear, reminderCalMonth, reminderSelectedDate;
let reminderCurrentTab = 'char'; // 'char' 或 'user'
let reminderCheckInterval = null;

// Keep remote execution ownership in the existing reminder record (and its backups).
// Credentials are never persisted here. Web Locks serialize foreground and handover across tabs.
async function hydrateReminderBackground(char) {
    if(typeof dexieDB==='undefined' || !dexieDB.characters) return;
    const saved=await dexieDB.characters.get(char.id);
    if(dexieDB.reminderExecutions && saved) {
        for(const record of saved.reminders || []) {
            const entry=await dexieDB.reminderExecutions.get(JSON.stringify([char.id,record.id]));
            if(entry) {
                if(entry.backgroundTask) record.backgroundTask=entry.backgroundTask;
                else delete record.backgroundTask;
                if(entry.triggered) record.triggered=true;
            }
        }
    }
    // Refresh reminder fields under the execution lock before making decisions.
    // A stale tab must not cancel a newer revision or revive a deleted reminder.
    const current=new Map((char.reminders || []).map(item=>[item.id,item]));
    char.reminders=(saved?.reminders || []).map(record=>{
        const item=current.get(record.id);
        if(!item) return record;
        for(const key of Object.keys(item)) if(!(key in record)) delete item[key];
        Object.assign(item,record);
        return item;
    });
}
const ReminderBackground=window.ReminderBackground=(()=>{
    const transport=()=>window.BackgroundTasks;
    const lock=work=>window.navigator?.locks ? navigator.locks.request('mio-reminder-execution',work) : work();
    const signature=r=>JSON.stringify([r.title,r.date,r.time,r.repeat || 'none',r.type]);
    const find=(charId,id)=>{
        const char=db.characters.find(item=>String(item.id)===String(charId));
        const reminder=char?.reminders?.find(item=>item.id===id);
        if(!reminder) throw Error('提醒已不存在');
        return {char,reminder};
    };
    async function persist(char) {
        if(!dexieDB.reminderExecutions || !dexieDB.transaction) {
            if(await saveCharacter(char.id)!==true) throw Error('本地保存失败，任务状态保留待核对');
            return;
        }
        // Update only reminders, preserving concurrent chat/history writes.
        await dexieDB.transaction('rw',dexieDB.characters,dexieDB.reminderExecutions,async()=>{
            if(!await dexieDB.characters.get(char.id)) throw Error('角色已删除，后台状态保留待核对');
            await dexieDB.characters.update(char.id,{reminders:char.reminders});
            for(const reminder of char.reminders || []) {
                const id=JSON.stringify([char.id,reminder.id]);
                if(reminder.backgroundTask || await dexieDB.reminderExecutions.get(id)) {
                    await dexieDB.reminderExecutions.put({id,characterId:char.id,reminderId:reminder.id,
                        backgroundTask:reminder.backgroundTask || null,triggered:!!reminder.triggered});
                }
            }
        });
    }
    function sessionFor(background) {
        const session=transport()?.identity();
        if(!session || session.endpoint!==background.endpoint || session.ownerId!==background.ownerId) throw Error('请连接这条提醒原来的后台账号');
        return session;
    }
    function label(reminder) {
        const b=reminder.backgroundTask;
        if(b?.lastError) return b.lastError;
        if(b?.intent==='cancel' && !['succeeded','cancelled','expired','failed'].includes(b.status)) return '后台取消待同步';
        return ({submitting:'等待提交后台',pending:'后台待执行',running:'后台执行中',retry_wait:'后台等待重试',
            succeeded:'后台结果已保存',cancelled:'后台已取消',expired:'后台提醒已过期',failed:'后台执行失败'})[b?.status] || '后台状态待核对';
    }
    function validateJob(job,b) {
        if(!job || !/^[a-f0-9-]{36}$/i.test(job.id) || job.kind!=='reminder.fixed'
            || job.resourceId!==b.request.resourceId || job.inputRevision!==b.request.inputRevision
            || job.idempotencyKey!==b.request.idempotencyKey || b.jobId && b.jobId!==job.id
            || !['pending','running','retry_wait','succeeded','cancelled','expired','failed'].includes(job.status)) throw Error('后台结果与提醒不匹配');
        if(job.status==='succeeded' && (job.result?.eventId!==job.id || job.result.resourceId!==job.resourceId
            || job.result.inputRevision!==job.inputRevision || job.result.title!==b.request.payload.title
            || job.result.body!==b.request.payload.body)) throw Error('后台提醒结果无效');
    }
    async function syncOne(char,r) {
        const b=r.backgroundTask;if(!b) return;
        sessionFor(b);
        if(signature(r)!==b.signature || r.done) b.intent='cancel';
        let job=b.jobId ? await transport().request(`/v1/tasks/${b.jobId}`)
            : await transport().request('/v1/tasks',{method:'POST',body:b.request});
        validateJob(job,b);
        if(b.intent==='cancel' && !['succeeded','cancelled','expired','failed'].includes(job.status)) {
            job=await transport().request(`/v1/tasks/${job.id}/cancel`,{method:'POST'});validateJob(job,b);
        }
        const old=JSON.parse(JSON.stringify(b)), triggered=r.triggered;
        b.jobId=job.id;b.status=job.status;b.lastError='';
        const notify=job.status==='succeeded' && !b.appliedEventId && b.intent!=='cancel' && !r.done && signature(r)===b.signature;
        if(job.status==='succeeded') {b.appliedEventId=job.id;if(signature(r)===b.signature) r.triggered=true;}
        if(job.status==='expired') r.triggered=true;
        try {await persist(char);} catch(error) {r.backgroundTask=old;r.triggered=triggered;throw error;}
        if(notify) showToast({name:'提醒',message:r.title});
    }
    async function releaseOne(char,r) {
        if(!r.backgroundTask) return;
        r.backgroundTask.intent='cancel';await persist(char);
        await syncOne(char,r);
        if(!['succeeded','cancelled','expired','failed'].includes(r.backgroundTask.status)) throw Error('后台取消尚未确认');
        const old=r.backgroundTask;delete r.backgroundTask;
        try {await persist(char);} catch(error) {r.backgroundTask=old;throw error;}
    }
    async function run(charId,id,work) {
        return lock(async()=>{
            const {char}=find(charId,id);await hydrateReminderBackground(char);
            const {reminder}=find(charId,id);
            try {return await work(char,reminder);} finally {renderReminderList();}
        });
    }
    async function submit(charId,id) {
        if(!window.navigator?.locks) throw Error('当前浏览器不支持安全的后台交接，请继续使用前台提醒');
        return run(charId,id,async(char,r)=>{
            const session=transport()?.identity();if(!session) {transport()?.open();throw Error('请先连接后台服务');}
            if(r.backgroundTask) return syncOne(char,r);
            if(r.type!=='toUser' || r.repeat && r.repeat!=='none' || r.done || r.triggered || !r.time) throw Error('当前只支持未完成的单次定时“提醒我”');
            if(typeof r.title!=='string' || !r.title.trim() || r.title.length>120) throw Error('提醒内容需为 1–120 个字符');
            const value=`${r.date}T${r.time}:00`, date=new Date(value);
            if(!Number.isFinite(date.getTime()) || formatDateStr(date)!==r.date
                || `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`!==r.time
                || date.getTime()<=Date.now() || date.getTime()>Date.now()+366*86400000) throw Error('请选择未来一年内有效的提醒时间');
            const key=crypto.randomUUID();
            r.backgroundTask={...session,status:'submitting',signature:signature(r),intent:'execute',
                request:{kind:'reminder.fixed',resourceId:`reminder:${key}`,inputRevision:1,idempotencyKey:`reminder:${key}:1`,
                    runAt:date.toISOString(),expiresAt:new Date(date.getTime()+3600000).toISOString(),payload:{title:r.title,body:''}}};
            try {await persist(char);} catch(error) {delete r.backgroundTask;throw error;}
            // Reservation is durable before the network request. A timeout never falls back to local execution.
            try {await syncOne(char,r);} catch {r.backgroundTask.lastError='后台提交待核对，请重新连接后检查结果';await persist(char);}
        });
    }
    async function reconcileOrphans() {
        if(!dexieDB.reminderExecutions?.toArray) return;
        await lock(async()=>{
            for(const entry of await dexieDB.reminderExecutions.toArray()) {
                const b=entry.backgroundTask;
                if(!b || ['succeeded','cancelled','expired','failed'].includes(b.status)) continue;
                const char=await dexieDB.characters.get(entry.characterId);
                if(char?.reminders?.some(r=>r.id===entry.reminderId)) continue;
                sessionFor(b);
                b.intent='cancel';await dexieDB.reminderExecutions.put(entry);
                let job=b.jobId ? await transport().request(`/v1/tasks/${b.jobId}`)
                    : await transport().request('/v1/tasks',{method:'POST',body:b.request});
                validateJob(job,b);
                if(!['succeeded','cancelled','expired','failed'].includes(job.status)) {
                    job=await transport().request(`/v1/tasks/${job.id}/cancel`,{method:'POST'});validateJob(job,b);
                }
                b.jobId=job.id;b.status=job.status;
                if(job.status==='succeeded') b.appliedEventId=job.id;
                await dexieDB.reminderExecutions.put(entry);
            }
        });
    }
    async function syncAll() {
        await reconcileOrphans();
        for(const char of db.characters || []) for(const r of char.reminders || []) {
            await lock(()=>hydrateReminderBackground(char));
            if(!r.backgroundTask) continue;
            try {await run(char.id,r.id,syncOne);} catch {
                // Keep ownership even while offline, logged out or revoked; never silently fire locally.
                if(r.backgroundTask) r.backgroundTask.lastError='后台状态待核对，请连接原账号检查';
            }
        }
        renderReminderList();
    }
    async function removeCharacters(ids, remove) {
        return lock(async()=>{
            // Keep cancellation and local removal in the same execution lock.
            // Any uncertain remote result aborts deletion and preserves its reference.
            for(const id of ids) {
                const char=db.characters.find(item=>String(item.id)===String(id));
                if(!char) continue;
                await hydrateReminderBackground(char);
                for(const reminder of char.reminders || []) {
                    if(!reminder.backgroundTask) continue;
                    reminder.backgroundTask.intent='cancel';
                    await persist(char);
                    await syncOne(char,reminder);
                    if(!['succeeded','cancelled','expired','failed'].includes(reminder.backgroundTask.status)) {
                        throw Error('后台任务尚未停止，请连接原账号检查后再删除');
                    }
                }
            }
            return remove();
        });
    }
    return Object.freeze({submit,label,syncAll,removeCharacters,reconcileOrphans,
        sync:(charId,id)=>run(charId,id,syncOne),
        release:(charId,id)=>run(charId,id,releaseOne),
        change:(charId,id,work)=>run(charId,id,async(char,r)=>{await releaseOne(char,r);await work(char,r);await persist(char);}),
        localTick:()=>lock(checkLocalReminders),
    });
})();

function setupReminderModule() {
    window.BackgroundTasks?.init();
    const btn = document.getElementById('reminder-btn');
    if (btn) btn.addEventListener('click', openReminderScreen);

    // 日历导航
    const prevBtn = document.getElementById('reminder-cal-prev');
    const nextBtn = document.getElementById('reminder-cal-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { reminderCalMonth--; if (reminderCalMonth < 0) { reminderCalMonth = 11; reminderCalYear--; } renderReminderCalendar(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { reminderCalMonth++; if (reminderCalMonth > 11) { reminderCalMonth = 0; reminderCalYear++; } renderReminderCalendar(); });

    // Tabs 分类切换
    document.querySelectorAll('.reminder-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabsContainer = document.getElementById('reminder-tabs');
            
            document.querySelectorAll('.reminder-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            reminderCurrentTab = tab.dataset.tab;
            
            // 触发滑块动画
            if (reminderCurrentTab === 'user') {
                tabsContainer.classList.add('tab-user-active');
            } else {
                tabsContainer.classList.remove('tab-user-active');
            }
            
            renderReminderList();
        });
    });

    // 年月快速选择器
    const monthPicker = document.getElementById('reminder-month-picker');
    if (monthPicker) {
        monthPicker.addEventListener('change', (e) => {
            if (e.target.value) { // 格式如 "2026-03"
                const parts = e.target.value.split('-');
                reminderCalYear = parseInt(parts[0], 10);
                reminderCalMonth = parseInt(parts[1], 10) - 1; // JS月份是 0-11
                
                // 选择后重置选中的日期为该月1号
                reminderSelectedDate = formatDateStr(new Date(reminderCalYear, reminderCalMonth, 1));
                
                renderReminderCalendar();
                renderReminderList();
            }
        });
    }

    // 新建按钮
    const addBtn = document.getElementById('reminder-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => openReminderForm());

    // 表单
    const cancelBtn = document.getElementById('reminder-form-cancel');
    const saveBtn = document.getElementById('reminder-form-save');
    if (cancelBtn) cancelBtn.addEventListener('click', closeReminderForm);
    if (saveBtn) saveBtn.addEventListener('click', saveReminderForm);

    // 类型选择器
    document.querySelectorAll('.reminder-type-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.reminder-type-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
        });
    });

    // 模态框背景点击关闭
    const modal = document.getElementById('reminder-form-modal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeReminderForm(); });

    // 启动全局定时检查
    startReminderChecker();
}

function openReminderScreen() {
    const now = new Date();
    reminderCalYear = now.getFullYear();
    reminderCalMonth = now.getMonth();
    reminderSelectedDate = formatDateStr(now);
    renderReminderCalendar();
    renderReminderList();
    switchScreen('reminder-screen');
}

function getCharReminders() {
    if (currentChatType !== 'private') return [];
    const char = db.characters.find(c => c.id === currentChatId);
    if (!char) return [];
    if (!char.reminders) char.reminders = [];
    return char.reminders;
}

function formatDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function renderReminderCalendar() {
    const titleEl = document.getElementById('reminder-month-title');
    const daysEl = document.getElementById('reminder-calendar-days');
    const monthPicker = document.getElementById('reminder-month-picker');
    if (!titleEl || !daysEl) return;

    titleEl.textContent = `${reminderCalYear}年${reminderCalMonth + 1}月`;
    
    if (monthPicker) {
        const mStr = String(reminderCalMonth + 1).padStart(2, '0');
        monthPicker.value = `${reminderCalYear}-${mStr}`;
    }

    const reminders = getCharReminders();
    // 统计每天有哪些类型的提醒
    const dateMap = {};
    reminders.forEach(r => {
        if (!dateMap[r.date]) dateMap[r.date] = new Set();
        if (r.type === 'toUser') dateMap[r.date].add('user');
        else if (r.type === 'toSelf') dateMap[r.date].add('self');
        else if (r.type === 'remindChar') dateMap[r.date].add('char');
    });

    const firstDay = new Date(reminderCalYear, reminderCalMonth, 1);
    const lastDay = new Date(reminderCalYear, reminderCalMonth + 1, 0);

    const todayStr = formatDateStr(new Date());
    let html = '';

    // 当月 (横向滑动只渲染当月即可)
    for (let d = 1; d <= lastDay.getDate(); d++) {
        const dateStr = formatDateStr(new Date(reminderCalYear, reminderCalMonth, d));
        html += buildDayCell(d, dateStr, '', todayStr, dateMap);
    }

    daysEl.innerHTML = html;

    // 绑定点击
    daysEl.querySelectorAll('.calendar-day').forEach(el => {
        el.addEventListener('click', () => {
            reminderSelectedDate = el.dataset.date;
            renderReminderCalendar();
            renderReminderList();
        });
    });
    
    // 如果选中的日期在当前视图中，滚动到它
    const selectedEl = daysEl.querySelector('.calendar-day.selected');
    if (selectedEl) {
        // 使用 setTimeout 确保 DOM 渲染完成
        setTimeout(() => {
            selectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }, 10);
    }
}

function buildDayCell(dayNum, dateStr, extraClass, todayStr, dateMap) {
    let cls = 'calendar-day ' + extraClass;
    if (dateStr === todayStr) cls += ' today';
    if (dateStr === reminderSelectedDate) cls += ' selected';

    // 移除点标记显示,用户会自己点击查看
    return `<div class="${cls}" data-date="${dateStr}">${dayNum}</div>`;
}

function renderReminderList() {
    const area = document.getElementById('reminder-list-area');
    if (!area) return;

    const reminders = getCharReminders();
    let dayReminders = reminders.filter(r => r.date === reminderSelectedDate)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    // 根据当前 Tab 过滤
    if (reminderCurrentTab === 'char') {
        dayReminders = dayReminders.filter(r => r.type === 'remindChar' || r.type === 'toSelf');
    } else {
        dayReminders = dayReminders.filter(r => r.type === 'toUser');
    }

    if (dayReminders.length === 0) {
        const dateObj = new Date(reminderSelectedDate + 'T00:00:00');
        const label = dateObj.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
        area.innerHTML = `<div class="reminder-date-label">${label}</div><div class="reminder-empty">这一天暂无提醒事项</div>`;
        return;
    }

    const dateObj = new Date(reminderSelectedDate + 'T00:00:00');
    const label = dateObj.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    let html = `<div class="reminder-date-label">${label}</div>`;

    dayReminders.forEach(r => {
        const doneClass = r.done ? ' done' : '';
        const typeLabel = r.type === 'toUser' ? '提醒我' : r.type === 'toSelf' ? 'TA的待办' : '提醒TA';
        const typeClass = 'type-' + (r.type === 'toUser' ? 'user' : r.type === 'toSelf' ? 'self' : 'char');
        const tagClass = 'tag-' + r.type;
        
        // 获取当前角色信息
        const char = db.characters.find(c => c.id === currentChatId);
        const charRealName = char ? char.realName || char.name : '角色';
        const creatorLabel = r.createdBy === 'char' ? `${charRealName}创建` : '我创建';
        
        const repeatLabels = { none: '', daily: '每天', weekly: '每周', monthly: '每月' };
        const repeatTag = r.repeat && r.repeat !== 'none' ? `<span class="reminder-repeat-tag">${repeatLabels[r.repeat]}</span>` : '';

        html += `<div class="reminder-item ${typeClass}${doneClass}" data-id="${r.id}">
            <div class="reminder-check" data-id="${r.id}"></div>
            <div class="reminder-info">
                <div class="reminder-title">${escapeHtml(r.title)}</div>
                <div class="reminder-meta">
                    ${r.time ? `<span class="reminder-time-tag">${r.time}</span>` : ''}
                    <span class="reminder-type-tag ${tagClass}">${typeLabel}</span>
                    <span class="reminder-creator-tag">${creatorLabel}</span>
                    ${repeatTag}
                </div>
                <div class="reminder-background-actions">
                    ${r.backgroundTask ? `<span>${escapeHtml(ReminderBackground.label(r))}</span><button type="button" data-background-sync="${escapeHtml(r.id)}">检查结果</button><button type="button" data-background-local="${escapeHtml(r.id)}">取消后台</button>`
                    : r.type === 'toUser' && (!r.repeat || r.repeat === 'none') && r.time && !r.done && !r.triggered ? `<button type="button" data-background-submit="${escapeHtml(r.id)}">交给后台</button>` : ''}
                </div>
            </div>
            <button class="reminder-delete-btn" data-id="${r.id}">
                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
        </div>`;
    });

    area.innerHTML = html;
    for (const [attribute,action] of [['submit','submit'],['sync','sync'],['local','release']]) {
        area.querySelectorAll(`[data-background-${attribute}]`).forEach(button=>button.addEventListener('click',()=>{
            const characterId=currentChatId;
            void ReminderBackground[action](characterId,button.getAttribute(`data-background-${attribute}`)).catch(error=>showToast(error.message));
        }));
    }

    // 绑定完成切换
    area.querySelectorAll('.reminder-check').forEach(el => {
        el.addEventListener('click', () => {
            toggleReminderDone(el.dataset.id);
        });
    });

    // 绑定删除
    area.querySelectorAll('.reminder-delete-btn').forEach(el => {
        el.addEventListener('click', () => {
            deleteReminder(el.dataset.id);
        });
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function toggleReminderDone(id) {
    const char = db.characters.find(c => c.id === currentChatId);
    if (!char || !char.reminders) return;
    const r = char.reminders.find(rem => rem.id === id);
    if (r) {
        try {await ReminderBackground.change(char.id,id,(_,item)=>{item.done=!item.done;});} catch(error) {showToast(error.message);return;}
        renderReminderList();
        renderReminderCalendar();
    }
}

async function deleteReminder(id) {
    const char = db.characters.find(c => c.id === currentChatId);
    if (!char || !char.reminders) return;
    try {await ReminderBackground.change(char.id,id,owner=>{owner.reminders=owner.reminders.filter(r=>r.id!==id);});} catch(error) {showToast(error.message);return;}
    renderReminderList();
    renderReminderCalendar();
}

function openReminderForm(editId) {
    const modal = document.getElementById('reminder-form-modal');
    const titleEl = document.getElementById('reminder-form-title');
    const inputTitle = document.getElementById('reminder-input-title');
    const inputDate = document.getElementById('reminder-input-date');
    const inputTime = document.getElementById('reminder-input-time');
    const inputRepeat = document.getElementById('reminder-input-repeat');

    if (editId) {
        titleEl.textContent = '编辑提醒';
        const char = db.characters.find(c => c.id === currentChatId);
        const r = char && char.reminders ? char.reminders.find(rem => rem.id === editId) : null;
        if (r) {
            inputTitle.value = r.title;
            inputDate.value = r.date;
            inputTime.value = r.time || '';
            inputRepeat.value = r.repeat || 'none';
            document.querySelectorAll('.reminder-type-option').forEach(o => {
                o.classList.toggle('active', o.dataset.type === r.type);
            });
        }
        modal.dataset.editId = editId;
    } else {
        titleEl.textContent = '新建提醒';
        inputTitle.value = '';
        inputDate.value = reminderSelectedDate || formatDateStr(new Date());
        inputTime.value = '';
        inputRepeat.value = 'none';
        document.querySelectorAll('.reminder-type-option').forEach(o => {
            o.classList.toggle('active', o.dataset.type === 'toUser');
        });
        delete modal.dataset.editId;
    }

    modal.classList.add('visible');
    setTimeout(() => inputTitle.focus(), 100);
}

function closeReminderForm() {
    const modal = document.getElementById('reminder-form-modal');
    modal.classList.remove('visible');
}

async function saveReminderForm() {
    const modal = document.getElementById('reminder-form-modal');
    const title = document.getElementById('reminder-input-title').value.trim();
    const date = document.getElementById('reminder-input-date').value;
    const time = document.getElementById('reminder-input-time').value;
    const repeat = document.getElementById('reminder-input-repeat').value;
    const typeEl = document.querySelector('.reminder-type-option.active');
    const type = typeEl ? typeEl.dataset.type : 'toUser';

    if (!title) { showToast('请输入提醒内容'); return; }
    if (!date) { showToast('请选择日期'); return; }

    const char = db.characters.find(c => c.id === currentChatId);
    if (!char) return;
    if (!char.reminders) char.reminders = [];

    const editId = modal.dataset.editId;
    if (editId) {
        try {await ReminderBackground.change(char.id,editId,(_,r)=>{
            r.title = title;
            r.date = date;
            r.time = time;
            r.repeat = repeat;
            r.type = type;
        });} catch(error) {showToast(error.message);return;}
    } else {
        char.reminders.push({
            id: 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            title: title,
            date: date,
            time: time || '',
            repeat: repeat,
            type: type,
            createdBy: 'user',
            done: false,
            triggered: false,
            createdAt: Date.now()
        });
    }

    saveData();
    closeReminderForm();
    renderReminderCalendar();
    renderReminderList();
    showToast('提醒已保存');
}

// --- 全局提醒检查器 ---
function startReminderChecker() {
    if (reminderCheckInterval) clearInterval(reminderCheckInterval);
    reminderCheckInterval = setInterval(checkReminders, 30000); // 每30秒检查
    // 启动时也检查一次
    setTimeout(checkReminders, 3000);
}

async function checkReminders() {
    try {return await ReminderBackground.localTick();} catch {console.warn('提醒检查暂不可用，保留原状态');}
}

async function checkLocalReminders() {
    if (!db || !db.characters) return;
    const now = new Date();
    const todayStr = formatDateStr(now);
    const nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    for (const char of db.characters) {
        if (!char.reminders || char.reminders.length === 0) continue;
        await hydrateReminderBackground(char);
        const due=[];
        const created=[];

        char.reminders.forEach(r => {
            if (r.done || r.triggered || r.backgroundTask) return;
            if (r.date !== todayStr) return;
            if (!r.time) return;
            if (r.time > nowTime) return;

            // 时间已到，触发提醒
            r.triggered = true;
            due.push(r);

            // 处理重复
            if (r.repeat && r.repeat !== 'none') {
                const nextDate = getNextRepeatDate(r.date, r.repeat);
                const next={
                    id: 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                    title: r.title,
                    date: nextDate,
                    time: r.time,
                    repeat: r.repeat,
                    type: r.type,
                    createdBy: r.createdBy,
                    done: false,
                    triggered: false,
                    createdAt: Date.now()
                };
                char.reminders.push(next);created.push(next.id);
            }
        });
        if(due.length) {
            if(await saveCharacter(char.id)===false) {due.forEach(r=>r.triggered=false);char.reminders=char.reminders.filter(r=>!created.includes(r.id));continue;}
            due.forEach(r=>triggerReminder(char,r));
            await saveCharacter(char.id);
        }
    }
}

function getNextRepeatDate(dateStr, repeat) {
    const d = new Date(dateStr + 'T00:00:00');
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
    return formatDateStr(d);
}

function triggerReminder(char, reminder) {
    const typeLabels = { toUser: '提醒你', toSelf: '的待办到期', remindChar: '被提醒' };

    // Toast 通知
    if (reminder.type === 'toUser' || reminder.type === 'toSelf') {
        showToast({
            name: char.remarkName || char.name || char.realName,
            avatar: char.avatar,
            message: reminder.type === 'toUser'
                ? `提醒你：${reminder.title}`
                : `待办到期：${reminder.title}`
        });
    }

    // 聊天内系统消息
    if (char.showReminderMsg !== false) {
        let msgContent = '';
        if (reminder.type === 'toUser') {
            msgContent = `[${char.realName}提醒你：${reminder.title}]`;
        } else if (reminder.type === 'toSelf') {
            msgContent = `[${char.realName}的待办到期：${reminder.title}]`;
        } else if (reminder.type === 'remindChar') {
            msgContent = `[你提醒${char.realName}：${reminder.title}]`;
        }

        if (msgContent) {
            const message = {
                id: `msg_${Date.now()}_${Math.random()}`,
                role: reminder.type === 'remindChar' ? 'user' : 'assistant',
                content: msgContent,
                timestamp: Date.now(),
                isReminderMsg: true
            };
            char.history.push(message);

            // 如果当前在这个聊天界面，渲染消息
            if (currentChatType === 'private' && currentChatId === char.id) {
                addMessageBubble(message, char.id, 'private');
            }
        }
    }

    // 如果是提醒TA类型，触发角色回复
    if (reminder.type === 'remindChar' && currentChatType === 'private' && currentChatId === char.id) {
        setTimeout(() => {
            getAiReply(char.id, 'private', true);
        }, 1500);
    }

    // 如果是提醒用户类型且角色有提醒功能，触发角色用自己语气发消息
    if (reminder.type === 'toUser' && char.charReminderEnabled) {
        if (currentChatType === 'private' && currentChatId === char.id) {
            setTimeout(() => {
                getAiReply(char.id, 'private', true);
            }, 2000);
        }
    }

    // 更新聊天列表
    if (typeof renderChatList === 'function') renderChatList();
}

// --- AI 标签解析：从角色回复中提取提醒指令 ---
function parseReminderTags(content, charId) {
    const char = db.characters.find(c => c.id === charId);
    if (!char || !char.charReminderEnabled) return content;
    if (!char.reminders) char.reminders = [];

    let cleaned = content;

    // [创建提醒：日期 时间|内容] 或 [创建提醒：时间|内容]（默认今天）
    const reminderRegex = /\[创建提醒[：:]\s*([^\]|]+?)\|([^\]]+?)\]/g;
    let match;
    while ((match = reminderRegex.exec(content)) !== null) {
        const parsed = parseReminderDateTime(match[1].trim());
        const title = match[2].trim();
        if (title) {
            char.reminders.push({
                id: 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                title: title,
                date: parsed.date,
                time: parsed.time,
                repeat: 'none',
                type: 'toUser',
                createdBy: 'char',
                done: false,
                triggered: false,
                createdAt: Date.now()
            });

            // 插入系统消息
            if (char.showReminderMsg !== false) {
                const sysMsg = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'assistant',
                    content: `[${char.realName}创建了提醒：${parsed.time ? parsed.time + ' ' : ''}${title}]`,
                    timestamp: Date.now(),
                    isReminderMsg: true
                };
                char.history.push(sysMsg);
                if (currentChatType === 'private' && currentChatId === char.id) {
                    addMessageBubble(sysMsg, char.id, 'private');
                }
            }
        }
        cleaned = cleaned.replace(match[0], '');
    }

    // [创建待办：日期 时间|内容]
    const todoRegex = /\[创建待办[：:]\s*([^\]|]+?)\|([^\]]+?)\]/g;
    while ((match = todoRegex.exec(content)) !== null) {
        const parsed = parseReminderDateTime(match[1].trim());
        const title = match[2].trim();
        if (title) {
            char.reminders.push({
                id: 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                title: title,
                date: parsed.date,
                time: parsed.time,
                repeat: 'none',
                type: 'toSelf',
                createdBy: 'char',
                done: false,
                triggered: false,
                createdAt: Date.now()
            });

            if (char.showReminderMsg !== false) {
                const sysMsg = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'assistant',
                    content: `[${char.realName}添加了待办：${parsed.time ? parsed.time + ' ' : ''}${title}]`,
                    timestamp: Date.now(),
                    isReminderMsg: true
                };
                char.history.push(sysMsg);
                if (currentChatType === 'private' && currentChatId === char.id) {
                    addMessageBubble(sysMsg, char.id, 'private');
                }
            }
        }
        cleaned = cleaned.replace(match[0], '');
    }

    // [完成待办：内容关键词]
    const doneRegex = /\[完成待办[：:]\s*([^\]]+?)\]/g;
    while ((match = doneRegex.exec(content)) !== null) {
        const keyword = match[1].trim();
        const target = char.reminders.find(r => !r.done && r.type === 'toSelf' && r.title.includes(keyword));
        if (target) {
            target.done = true;
            if (char.showReminderMsg !== false) {
                const sysMsg = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'assistant',
                    content: `[${char.realName}完成了待办：${target.title}]`,
                    timestamp: Date.now(),
                    isReminderMsg: true
                };
                char.history.push(sysMsg);
                if (currentChatType === 'private' && currentChatId === char.id) {
                    addMessageBubble(sysMsg, char.id, 'private');
                }
            }
        }
        cleaned = cleaned.replace(match[0], '');
    }

    if (cleaned !== content) saveData();
    return cleaned.replace(/\n\s*\n/g, '\n').trim();
}

function parseReminderDateTime(str) {
    const now = new Date();
    let date = formatDateStr(now);
    let time = '';

    // 匹配 "今天 14:00" / "明天 10:00" / "2026-03-09 14:00" / "14:00"
    const fullDateMatch = str.match(/(\d{4}-\d{2}-\d{2})\s*(\d{1,2}:\d{2})?/);
    const relativeMatch = str.match(/(今天|明天|后天)\s*(\d{1,2}:\d{2})?/);
    const timeOnlyMatch = str.match(/^(\d{1,2}:\d{2})$/);

    if (fullDateMatch) {
        date = fullDateMatch[1];
        time = fullDateMatch[2] || '';
    } else if (relativeMatch) {
        const d = new Date();
        if (relativeMatch[1] === '明天') d.setDate(d.getDate() + 1);
        else if (relativeMatch[1] === '后天') d.setDate(d.getDate() + 2);
        date = formatDateStr(d);
        time = relativeMatch[2] || '';
    } else if (timeOnlyMatch) {
        time = timeOnlyMatch[1];
    }

    // 补齐时间格式
    if (time && time.length === 4) time = '0' + time; // "9:00" -> "09:00"

    return { date, time };
}

// --- 系统提示词注入 ---
function generateReminderPrompt(character) {
    if (!character.charReminderEnabled) return '';

    const reminders = (character.reminders || []).filter(r => !r.done);
    const now = new Date();
    const todayStr = formatDateStr(now);

    let prompt = '\n<reminders>\n';
    prompt += '【提醒事项】你拥有提醒事项/待办功能。你可以：\n';
    prompt += '1. 为用户创建提醒：[创建提醒：日期 时间|内容]（如 [创建提醒：今天 14:00|该上课了]）\n';
    prompt += '2. 为自己创建待办：[创建待办：日期 时间|内容]（如 [创建待办：明天 10:00|给用户准备惊喜]）\n';
    prompt += '3. 完成自己的待办：[完成待办：待办内容关键词]\n';
    prompt += '日期支持：今天、明天、后天、或 YYYY-MM-DD 格式。\n';
    prompt += '请在合适时机自然地使用，不要刻意。当用户提到需要在某个时间做某事时，可以主动创建提醒。你也可以给自己安排待办事项。\n\n';

    if (reminders.length > 0) {
        prompt += '当前未完成的提醒/待办：\n';
        reminders.forEach(r => {
            const typeLabel = r.type === 'toUser' ? '提醒用户' : r.type === 'toSelf' ? '自己的待办' : '用户提醒你';
            prompt += `- [${r.date} ${r.time || '全天'}] ${r.title}（${typeLabel}）\n`;
        });
    } else {
        prompt += '当前没有未完成的提醒或待办。\n';
    }

    prompt += '</reminders>\n\n';
    return prompt;
}
