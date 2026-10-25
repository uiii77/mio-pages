// 角色日程：复用 VirtualClock 与独立 schedule API，默认关闭，不改变旧聊天。
(function attachSchedule(global) {
    'use strict';

    const Core = global.ScheduleCore;
    const runtime = new Map();
    const locks = new Set();
    const ui = { characterId: '', dateOverride: '' };

    function ensureSettings(character) {
        if (!character) return;
        if (character.scheduleEnabled === undefined) character.scheduleEnabled = false;
        if (!Core.ALLOWED_STYLES.includes(character.scheduleStyle)) character.scheduleStyle = 'lifestyle';
        if (character.scheduleAutoGenerate === undefined) character.scheduleAutoGenerate = true;
        if (character.scheduleTimeUnlockEnabled === undefined) character.scheduleTimeUnlockEnabled = false;
        if (character.scheduleWeatherImpactEnabled === undefined) character.scheduleWeatherImpactEnabled = false;
    }

    function character(id) { return (global.db?.characters || []).find(item => String(item.id) === String(id)) || null; }
    function clockFor(char) { return global.VirtualClock?.resolveCharacter ? global.VirtualClock.resolveCharacter(char) : {}; }
    function currentParts(char, realNow = Date.now()) {
        const clock = clockFor(char);
        if (global.VirtualClock?.getParts) return global.VirtualClock.getParts(clock, realNow);
        const date = new Date(realNow);
        return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), instantMs: realNow, timeZone: '' };
    }
    function dateKey(char, realNow = Date.now()) {
        if (global.VirtualClock?.dateKey) return global.VirtualClock.dateKey(clockFor(char), realNow);
        const parts = currentParts(char, realNow);
        return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    }
    function dayName(char, realNow = Date.now()) {
        const parts = currentParts(char, realNow);
        const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
        return ['日', '一', '二', '三', '四', '五', '六'][date.getUTCDay()];
    }
    function featureConfig(char) {
        const fallbackConfig = global.db?.apiSettings || null;
        const result = global.FeatureApiRegistry?.resolve('schedule', { context: char, fallbackConfig });
        return result?.configured && result.config ? result.config : null;
    }
    function endpointFor(config) {
        return global.getApiConfigEndpoint ? global.getApiConfigEndpoint(config, false) : `${String(config.url || config.baseUrl || '').replace(/\/$/, '')}/v1/chat/completions`;
    }
    function headersFor(config) {
        return global.getApiConfigHeaders ? global.getApiConfigHeaders(config) : { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) };
    }
    async function persistStatus(char) {
        try { if (typeof global.saveCharacter === 'function') await global.saveCharacter(char.id); }
        catch (error) { console.warn('[Schedule] status persistence failed:', error); }
    }
    function messageText(message) {
        if (!message || !['user', 'assistant'].includes(message.role) || message.isThinking || message.isContextDisabled) return '';
        const type = global.MessageReference?.classify ? global.MessageReference.classify(message) : 'text';
        if (['image', 'video', 'file', 'sticker', 'system'].includes(type)) return '';
        const sanitized = global.MessageContentParser?.sanitizeMessageForModel ? global.MessageContentParser.sanitizeMessageForModel(message) : message;
        const raw = global.MessageReference?.extractText ? global.MessageReference.extractText(sanitized) : sanitized?.content;
        return global.MessageContentParser?.parse ? global.MessageContentParser.parse(raw).original.trim() : String(raw || '').trim();
    }
    function recentHistory(char) {
        return (char.history || []).map(message => ({ role: message.role, text: messageText(message) })).filter(item => item.text).slice(-80);
    }
    function generationPrompt(char, date, weekday, history, completed) {
        const style = char.scheduleStyle === 'mindful' ? '意识/思绪' : '生活化';
        const historyText = history.length ? history.map(item => `${item.role === 'user' ? (char.myName || '用户') : (char.remarkName || char.name || '角色')}：${item.text}`).join('\n') : '无';
        const completedText = completed.length ? completed.map(item => `${item.activity}（${item.status === 'completed' ? '已完成' : item.status === 'skipped' ? '已跳过' : '已取消'}）`).join('、') : '无';
        return [
            `你是角色“${char.remarkName || char.name || '角色'}”的日程整理器。今天是角色当地日期 ${date}，星期${weekday}。`,
            `日程风格：${style}。请生成 5-7 个从早到晚的时间段，每项包含 startTime(HH:MM)、activity、description、emoji、location、innerThought；户外活动可额外标记 weatherSensitive，并提供 weatherAlternative 或 weatherRescheduleTime。`,
            '活动必须体现角色自己的生活/思绪，不要把“等待用户、给用户发消息”作为主要活动；可以在描述中自然提到聊天影响。不要编造聊天中未出现的确定事实。',
            `已完成/跳过/取消的活动，除非明确是新的日期或合理变化，不要重复安排：${completedText}`,
            '只返回 JSON：{"slots":[{"startTime":"08:00","activity":"...","description":"...","emoji":"☕","location":"...","innerThought":"..."}],"flowNarrative":{"morning":"...","afternoon":"...","evening":"..."}}。',
            '', '最近聊天原文（翻译不提供给你）：', historyText,
        ].join('\n');
    }

    async function listLedger(char, date) {
        if (!global.dexieDB?.scheduleActivityLedger) return [];
        return global.dexieDB.scheduleActivityLedger.where('characterId').equals(char.id).and(item => String(item.date) === String(date)).toArray();
    }
    async function getActivityLedger(char, date, activityKey, options = {}) {
        const rows = await listLedger(char, date);
        return Core.findLedgerEntry(rows, activityKey, options);
    }
    async function getSchedule(char, realNow = Date.now()) {
        ensureSettings(char);
        const date = dateKey(char, realNow);
        if (!global.dexieDB?.dailySchedules) return null;
        const record = await global.dexieDB.dailySchedules.get(`${char.id}:${date}`);
        if (!record) return null;
        return Core.applyLedger(Core.normalizeSchedule(record, { characterId: char.id, date }), await listLedger(char, date));
    }
    async function getScheduleForDate(char, date) {
        ensureSettings(char);
        const normalizedDate = String(date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return getSchedule(char);
        if (!global.dexieDB?.dailySchedules) return null;
        const record = await global.dexieDB.dailySchedules.get(`${char.id}:${normalizedDate}`);
        if (!record) return null;
        return Core.applyLedger(Core.normalizeSchedule(record, { characterId: char.id, date: normalizedDate }), await listLedger(char, normalizedDate));
    }
    async function saveSchedule(schedule) {
        if (!global.dexieDB?.dailySchedules) return schedule;
        const normalized = Core.normalizeSchedule(schedule);
        await global.dexieDB.dailySchedules.put(normalized);
        return normalized;
    }
    async function recordActivity(char, input = {}) {
        if (!global.dexieDB?.scheduleActivityLedger) return;
        const date = input.date || dateKey(char);
        const activityKey = input.activityKey || '';
        const activityTrace = global.ActivityTraceCore?.withSchedule(input.activityTrace, {
            characterId: char.id, date, activityKey, activity: input.activity,
        }) || input.activityTrace;
        const record = Core.normalizeLedger({
            id: input.id || `${char.id}:${date}:${activityKey}`,
            characterId: char.id, date, activityKey,
            activity: input.activity, status: input.status, source: input.source,
            runKey: input.runKey, taskId: input.taskId, activityTrace, completedAt: input.completedAt, updatedAt: Date.now(),
        });
        await global.dexieDB.scheduleActivityLedger.put(record);
        return record;
    }
    async function isActivitySettled(char, activityKey, options = {}) {
        if (!char || !activityKey) return false;
        const date = options.date || dateKey(char, options.realNow || Date.now());
        const entry = await getActivityLedger(char, date, activityKey, options);
        return !!entry && Core.isSettledLedgerStatus(entry.status);
    }
    async function saveLedger(char, schedule, slot) {
        await recordActivity(char, {
            date: schedule.date, activityKey: slot.activityKey, activity: slot.activity,
            status: slot.status, source: Core.LEDGER_SOURCES.schedule, completedAt: slot.completedAt,
        });
    }
    async function applyWeatherRules(char, schedule, options = {}) {
        ensureSettings(char);
        if (!char?.scheduleWeatherImpactEnabled || !schedule || !global.RealtimeContextHub?.fetchWeatherSnapshot) return schedule;
        try {
            const snapshot = await global.RealtimeContextHub.fetchWeatherSnapshot(char, 'character');
            if (!snapshot) return schedule;
            const result = Core.applyWeatherSnapshot(schedule, snapshot, {
                currentMinutes: options.currentMinutes,
                now: options.now || Date.now(),
            });
            if (!result.changed) return schedule;
            const saved = await saveSchedule(result.schedule);
            for (const impact of result.impacts) {
                const slot = saved.slots.find(item => item.id === impact.slotId);
                if (slot && slot.status === Core.STATUSES.cancelled) await saveLedger(char, saved, slot);
            }
            return saved;
        } catch (error) {
            console.warn('[Schedule] weather rule failed without blocking chat:', error);
            return schedule;
        }
    }
    async function generate(char, options = {}) {
        ensureSettings(char);
        if (!char?.scheduleEnabled) return { skipped: true, reason: 'disabled', error: '请先开启角色日程' };
        if (locks.has(char.id)) return { skipped: true, reason: 'lock' };
        const config = featureConfig(char);
        if (!config || typeof global.fetchAiResponse !== 'function') {
            char.scheduleLastAttemptAt = Date.now();
            char.scheduleLastError = '未配置可用的日程 API';
            await persistStatus(char);
            return { skipped: true, reason: 'api-unavailable', error: char.scheduleLastError };
        }
        locks.add(char.id);
        try {
            const realNow = Date.now();
            const date = dateKey(char, realNow);
            const existing = await getSchedule(char, realNow);
            if (!options.force) {
                if (existing) { runtime.set(char.id, { schedule: existing, date, preparedAt: realNow }); return { skipped: true, reason: 'exists', schedule: existing }; }
            }
            const ledger = await listLedger(char, date);
            const parts = currentParts(char, realNow);
            const payload = {
                model: config.model,
                messages: [{ role: 'user', content: generationPrompt(char, date, dayName(char, realNow), recentHistory(char), ledger) }],
                temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.75,
                stream: false,
            };
            const response = await global.fetchAiResponse(config, payload, headersFor(config), endpointFor(config), false);
            const parsed = Core.parseJson(response);
            if (!parsed || !Array.isArray(parsed.slots) || !parsed.slots.length) {
                char.scheduleLastAttemptAt = realNow;
                char.scheduleLastError = '日程 API 未返回可识别的时段 JSON';
                await persistStatus(char);
                return { skipped: true, reason: 'invalid-response', error: char.scheduleLastError };
            }
            const generatedSlots = parsed.slots.map(slot => ({ ...slot, source: 'generated' }));
            // 刷新只替换由 Mio 标记的自动时段。手动时段、已结算时段及旧版
            // 无来源标记的数据都保留，避免升级后第一次刷新误删用户内容。
            const preservedSlots = options.force && existing
                ? existing.slots.filter(slot => slot.source !== 'generated' || ['completed', 'skipped', 'cancelled'].includes(slot.status))
                : [];
            const preservedKeys = new Set(preservedSlots.map(slot => slot.activityKey));
            const slots = [...preservedSlots, ...generatedSlots.filter(slot => {
                const normalized = Core.normalizeSlot(slot, { characterId: char.id, date });
                return !preservedKeys.has(normalized.activityKey);
            })];
            const schedule = Core.applyLedger(Core.normalizeSchedule({
                id: `${char.id}:${date}`, characterId: char.id, date, style: char.scheduleStyle,
                slots, flowNarrative: parsed.flowNarrative, weatherImpactLog: existing?.weatherImpactLog,
                generatedAt: existing?.generatedAt || realNow, updatedAt: realNow,
            }), ledger);
            const saved = await saveSchedule(schedule);
            const adjusted = await applyWeatherRules(char, saved, { currentMinutes: parts.hour * 60 + parts.minute, now: realNow });
            runtime.set(char.id, { schedule: adjusted, date, preparedAt: realNow });
            char.scheduleLastAttemptAt = realNow;
            char.scheduleLastGeneratedAt = realNow;
            char.scheduleLastError = '';
            await persistStatus(char);
            return { skipped: false, schedule: adjusted };
        } catch (error) {
            console.warn('[Schedule] generation failed without blocking chat:', error);
            char.scheduleLastAttemptAt = Date.now();
            char.scheduleLastError = error.message || String(error);
            await persistStatus(char);
            return { skipped: false, error: error.message || String(error) };
        } finally { locks.delete(char.id); }
    }
    async function prepareContext(char) {
        ensureSettings(char);
        if (!char?.scheduleEnabled) { runtime.delete(char?.id); return ''; }
        try {
            const original = await getSchedule(char);
            const date = dateKey(char);
            if (!original || original.date !== date) { runtime.delete(char.id); return ''; }
            const parts = currentParts(char);
            const schedule = await applyWeatherRules(char, original, { currentMinutes: parts.hour * 60 + parts.minute });
            const block = Core.formatContext(schedule, { currentMinutes: parts.hour * 60 + parts.minute, includeFullDay: false, includeClock: true, timeUnlockEnabled: char.scheduleTimeUnlockEnabled === true });
            runtime.set(char.id, { schedule, date, block, preparedAt: Date.now() });
            return block;
        } catch (error) { console.warn('[Schedule] context preparation failed:', error); return ''; }
    }
    function getContext(char) { ensureSettings(char); return char?.scheduleEnabled ? runtime.get(char.id)?.block || '' : ''; }
    async function ensureCurrentSchedule(char) {
        ensureSettings(char);
        if (!char?.scheduleEnabled || char.scheduleAutoGenerate === false) return { skipped: true, reason: 'disabled' };
        const existing = await getSchedule(char);
        return existing ? { skipped: true, reason: 'exists', schedule: existing } : generate(char);
    }
    async function setSlotStatus(char, slotIdValue, nextStatus, options = {}) {
        const schedule = options.date ? await getScheduleForDate(char, options.date) : await getSchedule(char);
        if (!schedule) return false;
        const slot = schedule.slots.find(item => item.id === slotIdValue);
        if (!slot) return false;
        slot.status = Core.STATUSES[nextStatus] || Core.STATUSES.planned;
        slot.completedAt = slot.status === 'completed' ? Date.now() : null;
        slot.updatedAt = Date.now();
        slot.revision += 1;
        await saveSchedule(schedule);
        await saveLedger(char, schedule, slot);
        runtime.delete(char.id);
        return true;
    }
    function escape(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    function currentCharacter() { return character(ui.characterId || global.currentChatId); }
    async function render() {
        const char = currentCharacter();
        const list = document.getElementById('schedule-list');
        const summary = document.getElementById('schedule-summary');
        if (!char || !list) return;
        const original = ui.dateOverride ? await getScheduleForDate(char, ui.dateOverride) : await getSchedule(char);
        const parts = currentParts(char);
        const schedule = await applyWeatherRules(char, original, { currentMinutes: parts.hour * 60 + parts.minute });
        if (summary) summary.textContent = schedule
            ? `${char.remarkName || char.name || '角色'} · ${schedule.date} · ${schedule.slots.length} 个时段${char.scheduleLastError ? ` · 上次刷新失败：${char.scheduleLastError}` : ''}`
            : `${char.remarkName || char.name || '角色'} · 今天还没有日程${char.scheduleLastError ? ` · ${char.scheduleLastError}` : ''}`;
        if (!schedule) { list.innerHTML = '<div class="schedule-empty">暂无今日日程。可点击生成，或直接新增时段。</div>'; return; }
        const currentMinutes = parts.hour * 60 + parts.minute;
        list.innerHTML = schedule.slots.map(slot => {
            const locked = char.scheduleTimeUnlockEnabled === true && !Core.isSlotUnlocked(slot, currentMinutes);
            const unlockLabel = locked ? '<em class="schedule-status schedule-status-locked">待解锁</em>' : '';
            return `<div class="schedule-row${locked ? ' schedule-row-locked' : ''}" data-id="${escape(slot.id)}"><div class="schedule-row-main"><div class="schedule-row-time">${escape(slot.startTime)}</div><div class="schedule-row-content"><strong>${escape(slot.emoji)} ${escape(slot.activity)}</strong><span>${escape(slot.location || '')}${slot.description ? `${slot.location ? ' · ' : ''}${escape(slot.description)}` : ''}</span><em class="schedule-status schedule-status-${escape(slot.status)}">${escape(Core.STATUS_LABELS[slot.status] || slot.status)}</em>${unlockLabel}</div></div><div class="schedule-row-actions"><button class="btn btn-small btn-secondary" data-action="edit">编辑</button><button class="btn btn-small btn-secondary" data-action="complete">完成</button><button class="btn btn-small btn-secondary" data-action="skip">跳过</button></div></div>`;
        }).join('');
    }
    async function editSlotFields(slot, save) {
        let draft = slot;
        while (true) {
            const fields = await global.showAppFormDialog({ title: slot.id ? '编辑时段' : '新增时段', confirmText: '保存', fields: [
                { name: 'startTime', label: '开始时间', type: 'time', value: draft.startTime || '09:00', required: true },
                { name: 'activity', label: '活动名称', value: draft.activity || '', required: true },
                { name: 'description', label: '活动说明', type: 'textarea', value: draft.description || '' },
            ] });
            if (!fields) return false;
            draft = fields;
            try {
                if (!fields.activity.trim()) throw new Error('请填写活动名称');
                await save(fields);
                return true;
            } catch (error) { global.showToast?.(error?.message || '保存时段失败，请重试'); }
        }
    }
    async function addSlot() {
        const char = currentCharacter(); if (!char) return;
        const date = ui.dateOverride || dateKey(char);
        const saved = await editSlotFields({}, async fields => {
            let schedule = await getScheduleForDate(char, date);
            if (!schedule) {
                schedule = Core.normalizeSchedule({ id: `${char.id}:${date}`, characterId: char.id, date, style: char.scheduleStyle, slots: [] });
            }
            schedule.slots.push(Core.normalizeSlot({ ...fields, status: 'planned', source: 'manual' }, { date: schedule.date, characterId: char.id, index: schedule.slots.length }));
            await saveSchedule(schedule);
        });
        if (saved) await render();
    }
    async function modify(event) {
        const button = event.target.closest('button[data-action]'); const row = button?.closest('[data-id]'); const char = currentCharacter();
        if (!button || !row || !char) return;
        const schedule = ui.dateOverride ? await getScheduleForDate(char, ui.dateOverride) : await getSchedule(char); const slot = schedule?.slots.find(item => item.id === row.dataset.id); if (!schedule || !slot) return;
        const action = button.dataset.action;
        if (action === 'complete' || action === 'skip') { await setSlotStatus(char, slot.id, action === 'complete' ? 'completed' : 'skipped', { date: schedule.date }); await render(); return; }
        const saved = await editSlotFields(slot, async fields => {
            schedule.slots = schedule.slots.map(item => item.id === slot.id
                ? Core.normalizeSlot({ ...slot, ...fields, source: 'manual', revision: slot.revision + 1, updatedAt: Date.now() }, { date: schedule.date })
                : item);
            await saveSchedule(schedule);
        });
        if (saved) await render();
    }
    function focusSlot(slotId) {
        if (!slotId) return;
        const row = [...document.querySelectorAll('#schedule-list [data-id]')].find(item => item.dataset.id === String(slotId));
        if (!row) return;
        row.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        row.classList.add('schedule-row-trace-focus');
        global.setTimeout?.(() => row.classList.remove('schedule-row-trace-focus'), 2200);
    }
    function open(characterId, options = {}) {
        const nextId = characterId || global.currentChatId || '';
        if (!options.preserveView || nextId !== ui.characterId) ui.dateOverride = /^\d{4}-\d{2}-\d{2}$/.test(String(options.date || '')) ? String(options.date) : '';
        ui.characterId = nextId;
        global.CharacterStatusUI.show(ui.characterId, 'schedule');
        return Promise.resolve(render()).then(() => focusSlot(options.slotId));
    }
    function setup() {
        global.CharacterStatusUI?.setup();
        document.getElementById('setting-open-schedule-btn')?.addEventListener('click', () => open(global.currentChatId));
        document.getElementById('schedule-open-btn')?.addEventListener('click', () => open(global.currentChatId));
        document.getElementById('schedule-add-btn')?.addEventListener('click', () => void addSlot());
        document.getElementById('schedule-generate-btn')?.addEventListener('click', async () => { const char = currentCharacter(); if (!char) return; const result = await generate(char, { force: true }); if (result.error) global.showToast?.(`日程生成失败：${result.error}`); else if (!result.skipped) { ui.dateOverride = ''; global.showToast?.('角色日程已刷新'); } await render(); });
        document.getElementById('schedule-list')?.addEventListener('click', event => void modify(event));
    }
    global.Schedule = { VERSION: Core.VERSION, ensureSettings, getSchedule, getScheduleForDate, saveSchedule, generate, prepareContext, getContext, ensureCurrentSchedule, setSlotStatus, getActivityLedger, recordActivity, isActivitySettled, evaluateWeatherImpact: Core.evaluateWeatherImpact, applyWeatherImpact: Core.applyWeatherImpact, applyWeatherSnapshot: Core.applyWeatherSnapshot, applyWeatherRules, isSlotUnlocked: Core.isSlotUnlocked, open, setup };
    global.prepareScheduleContext = prepareContext;
    global.getScheduleContextBlock = getContext;
    global.setupScheduleScreen = setup;
})(typeof window !== 'undefined' ? window : globalThis);
