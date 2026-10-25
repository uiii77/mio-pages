// 角色日程纯领域层：角色本地日期、时段状态、完成账本和上下文渲染。
(function attachScheduleCore(global) {
    'use strict';

    const VERSION = 1;
    const STATUSES = Object.freeze({ planned: 'planned', active: 'active', completed: 'completed', skipped: 'skipped', cancelled: 'cancelled' });
    const STATUS_LABELS = Object.freeze({ planned: '计划', active: '进行中', completed: '已完成', skipped: '已跳过', cancelled: '已取消' });
    const ALLOWED_STYLES = Object.freeze(['lifestyle', 'mindful']);
    const MAX_SLOTS = 12;
    const LEDGER_SOURCES = Object.freeze({ schedule: 'schedule', activeMessage: 'active-message', other: 'other' });
    const WEATHER_ACTIONS = Object.freeze({ none: 'none', cancel: 'cancel', reschedule: 'reschedule', substitute: 'substitute' });
    const WEATHER_LOG_LIMIT = 40;
    const WEATHER_SENSITIVE_PATTERN = /(户外|室外|公园|步行|散步|跑步|旅行|出门|野餐|露营|运动|外出|outdoor|park|walk|run|trip|picnic|camp)/i;
    const WEATHER_SEVERE_PATTERN = /(雷|暴|台风|飓风|强阵雨|大雨|暴雪|冰雹|storm|thunder|hurricane|typhoon|blizzard|hail)/i;
    const WEATHER_ADVERSE_PATTERN = /(雨|雪|雾|霾|冻|冰|rain|snow|fog|sleet|hail)/i;

    function cleanText(value, max = 600) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
    function stableHash(value) {
        const text = String(value || '').normalize('NFKC').toLowerCase();
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
        return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }
    function normalizeTime(value) {
        const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return '00:00';
        const hour = Math.min(23, Math.max(0, Number(match[1]) || 0));
        const minute = Math.min(59, Math.max(0, Number(match[2]) || 0));
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    function minutes(value) { const [hour, minute] = normalizeTime(value).split(':').map(Number); return hour * 60 + minute; }
    function status(value) { return Object.prototype.hasOwnProperty.call(STATUSES, value) ? value : STATUSES.planned; }
    function slotActivityKey(date, slot) { return stableHash(`${date}|${normalizeTime(slot.startTime)}|${cleanText(slot.activity, 120)}|${cleanText(slot.location, 120)}`); }
    function slotId(date, slot, index) { return String(slot.id || `schedule:${date}:${index}:${slotActivityKey(date, slot)}`); }

    function normalizeWeatherSnapshot(value) {
        const source = value?.weather && typeof value.weather === 'object' ? value.weather : (value && typeof value === 'object' ? value : {});
        const trace = value?.trace && typeof value.trace === 'object' ? value.trace : {};
        const number = candidate => Number.isFinite(Number(candidate)) ? Number(candidate) : null;
        return {
            description: cleanText(source.description || source.condition || source.text, 120),
            temp: number(source.temp ?? source.temperature),
            feelsLike: number(source.feelsLike ?? source.feels_like),
            humidity: number(source.humidity),
            city: cleanText(source.city || source.name || trace.city, 120),
            provider: cleanText(source.provider || trace.provider, 40),
            requestedProvider: cleanText(source.requestedProvider || trace.requestedProvider, 40),
            observedAt: number(source.observedAt),
            fetchedAt: number(trace.fetchedAt || source.observedAt),
            fallback: trace.fallback === true,
        };
    }

    function isWeatherSensitive(slot) {
        const value = slot && typeof slot === 'object' ? slot : {};
        if (value.weatherSensitive === true) return true;
        return WEATHER_SENSITIVE_PATTERN.test(`${value.activity || ''} ${value.description || ''} ${value.location || ''}`);
    }

    function evaluateWeatherImpact(slot, snapshot, options = {}) {
        const weather = normalizeWeatherSnapshot(snapshot);
        const currentMinutes = options.currentMinutes == null ? null : Math.max(0, Math.min(1439, Number(options.currentMinutes) || 0));
        const slotMinutes = minutes(slot?.startTime);
        const eligible = isWeatherSensitive(slot);
        if (!weather.description && weather.temp === null) return { eligible, severity: 'unknown', action: WEATHER_ACTIONS.none, reason: 'weather-unavailable' };
        if (!eligible) return { eligible: false, severity: 'normal', action: WEATHER_ACTIONS.none, reason: 'activity-not-weather-sensitive' };
        if ([STATUSES.completed, STATUSES.skipped, STATUSES.cancelled].includes(slot?.status)) return { eligible: true, severity: 'settled', action: WEATHER_ACTIONS.none, reason: 'activity-settled' };
        if (currentMinutes !== null && slotMinutes < currentMinutes) return { eligible: true, severity: 'past', action: WEATHER_ACTIONS.none, reason: 'activity-already-started' };
        const description = weather.description;
        const severe = WEATHER_SEVERE_PATTERN.test(description);
        const adverse = severe || WEATHER_ADVERSE_PATTERN.test(description) || (weather.temp !== null && (weather.temp < 5 || weather.temp > 35));
        const severity = severe ? 'severe' : adverse ? 'adverse' : 'normal';
        let action = WEATHER_ACTIONS.none;
        if (severe) action = WEATHER_ACTIONS.cancel;
        else if (adverse && slot.weatherAlternative) action = WEATHER_ACTIONS.substitute;
        else if (adverse && slot.weatherRescheduleTime) action = WEATHER_ACTIONS.reschedule;
        else if (adverse) action = WEATHER_ACTIONS.cancel;
        return {
            eligible: true,
            severity,
            action,
            reason: `${weather.city ? `${weather.city} ` : ''}${weather.description || '当前天气'}${weather.temp === null ? '' : `，${weather.temp}℃`}`,
        };
    }

    function normalizeWeatherImpact(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const snapshot = normalizeWeatherSnapshot(source.snapshot || source.weather || {});
        return {
            id: String(source.id || `weather:${source.slotId || ''}:${source.fetchedAt || snapshot.fetchedAt || options.now || Date.now()}`),
            slotId: String(source.slotId || ''),
            action: Object.values(WEATHER_ACTIONS).includes(source.action) ? source.action : WEATHER_ACTIONS.none,
            severity: cleanText(source.severity, 20),
            reason: cleanText(source.reason, 240),
            before: source.before && typeof source.before === 'object' ? {
                activity: cleanText(source.before.activity, 120), startTime: normalizeTime(source.before.startTime), location: cleanText(source.before.location, 120), status: status(source.before.status),
            } : null,
            after: source.after && typeof source.after === 'object' ? {
                activity: cleanText(source.after.activity, 120), startTime: normalizeTime(source.after.startTime), location: cleanText(source.after.location, 120), status: status(source.after.status),
            } : null,
            snapshot: {
                description: snapshot.description,
                temp: snapshot.temp,
                feelsLike: snapshot.feelsLike,
                humidity: snapshot.humidity,
                city: snapshot.city,
                provider: snapshot.provider,
                requestedProvider: snapshot.requestedProvider,
                observedAt: snapshot.observedAt,
                fetchedAt: snapshot.fetchedAt,
                fallback: snapshot.fallback,
            },
            appliedAt: Math.max(0, Number(source.appliedAt) || Number(options.now) || Date.now()),
            source: 'weather-rule',
        };
    }

    function normalizeSlot(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const date = String(options.date || source.date || '');
        const createdAt = Math.max(0, Number(source.createdAt) || Number(options.now) || Date.now());
        const activity = cleanText(source.activity || source.title, 120);
        const startTime = normalizeTime(source.startTime);
        const id = slotId(date, source, Number(options.index) || 0);
        const activityKey = String(source.activityKey || slotActivityKey(date, { ...source, startTime, activity }));
        const activityTrace = global.ActivityTraceCore?.withSchedule(source.activityTrace, {
            characterId: options.characterId || source.characterId,
            date, slotId: id, activityKey, activity,
        }) || source.activityTrace;
        const sourceKind = ['manual', 'generated', 'legacy'].includes(source.source) ? source.source : 'legacy';
        return {
            id,
            activity,
            startTime,
            description: cleanText(source.description, 500),
            emoji: cleanText(source.emoji, 8),
            location: cleanText(source.location, 120),
            weatherSensitive: source.weatherSensitive === true,
            weatherAlternative: cleanText(source.weatherAlternative, 120),
            weatherRescheduleTime: source.weatherRescheduleTime ? normalizeTime(source.weatherRescheduleTime) : '',
            innerThought: cleanText(source.innerThought, 800),
            status: status(source.status),
            completedAt: source.completedAt == null ? null : Math.max(0, Number(source.completedAt) || createdAt),
            revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
            createdAt,
            updatedAt: Math.max(createdAt, Number(source.updatedAt) || createdAt),
            activityKey,
            source: sourceKind,
            ...(activityTrace ? { activityTrace } : {}),
        };
    }

    function normalizeSchedule(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const characterId = String(source.characterId || source.charId || options.characterId || '');
        const date = String(source.date || options.date || '');
        const createdAt = Math.max(0, Number(source.generatedAt || source.createdAt) || Number(options.now) || Date.now());
        const slots = (Array.isArray(source.slots) ? source.slots : [])
            .map((slot, index) => normalizeSlot(slot, { characterId, date, index, now: createdAt }))
            .filter(slot => slot.activity)
            .sort((left, right) => minutes(left.startTime) - minutes(right.startTime))
            .slice(0, MAX_SLOTS);
        const style = ALLOWED_STYLES.includes(source.style || source.scheduleStyle) ? (source.style || source.scheduleStyle) : 'lifestyle';
        const flow = source.flowNarrative && typeof source.flowNarrative === 'object' ? Object.fromEntries(['morning', 'afternoon', 'evening'].map(key => [key, cleanText(source.flowNarrative[key], 800)]).filter(([, text]) => text)) : {};
        const weatherImpactLog = (Array.isArray(source.weatherImpactLog) ? source.weatherImpactLog : [])
            .map(item => normalizeWeatherImpact(item, { now: createdAt }))
            .slice(-WEATHER_LOG_LIMIT);
        return {
            id: String(source.id || `${characterId}:${date}`),
            schemaVersion: VERSION,
            characterId,
            date,
            style,
            slots,
            flowNarrative: flow,
            weatherImpactLog,
            generatedAt: createdAt,
            updatedAt: Math.max(createdAt, Number(source.updatedAt) || createdAt),
        };
    }

    function normalizeLedger(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const now = Math.max(0, Number(options.now) || Date.now());
        const characterId = String(source.characterId || options.characterId || '');
        const date = String(source.date || options.date || '');
        const activityKey = String(source.activityKey || '');
        const activityTrace = global.ActivityTraceCore?.withSchedule(source.activityTrace, {
            characterId, date, activityKey, activity: source.activity,
        }) || source.activityTrace;
        return {
            id: String(source.id || `${characterId}:${date}:${activityKey}`),
            characterId,
            date,
            activityKey,
            activity: cleanText(source.activity, 120),
            status: status(source.status),
            source: Object.values(LEDGER_SOURCES).includes(source.source) ? source.source : (options.source || LEDGER_SOURCES.schedule),
            runKey: cleanText(source.runKey, 240),
            taskId: cleanText(source.taskId, 160),
            ...(activityTrace ? { activityTrace } : {}),
            completedAt: source.completedAt == null ? null : Math.max(0, Number(source.completedAt) || now),
            updatedAt: Math.max(0, Number(source.updatedAt) || now),
        };
    }

    function isSettledLedgerStatus(value) {
        return [STATUSES.completed, STATUSES.skipped, STATUSES.cancelled].includes(value);
    }

    function findLedgerEntry(rows, activityKey, options = {}) {
        const key = String(activityKey || '');
        if (!key) return null;
        const source = options.source ? String(options.source) : '';
        return (Array.isArray(rows) ? rows : [])
            .map(row => normalizeLedger(row, options))
            .filter(row => row.activityKey === key && (!source || row.source === source))
            .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
    }

    function applyLedger(schedule, ledgerRows = []) {
        const normalized = normalizeSchedule(schedule);
        const map = new Map((Array.isArray(ledgerRows) ? ledgerRows : [])
            .map(row => normalizeLedger(row))
            // An active-message completion is intentionally allowed to settle the
            // linked schedule slot; unrelated activity rows must not alter cards.
            .filter(row => row.source === LEDGER_SOURCES.schedule || row.source === LEDGER_SOURCES.activeMessage)
            .map(row => [String(row.activityKey || ''), row]));
        return { ...normalized, slots: normalized.slots.map(slot => {
            const ledger = map.get(slot.activityKey);
            if (!ledger || ledger.status === STATUSES.planned) return slot;
            return { ...slot, status: ledger.status, completedAt: ledger.completedAt, updatedAt: Math.max(slot.updatedAt, ledger.updatedAt), ...(ledger.activityTrace ? { activityTrace: global.ActivityTraceCore?.merge(slot.activityTrace, ledger.activityTrace) || slot.activityTrace } : {}) };
        }) };
    }

    function resolveCurrent(schedule, currentMinutes) {
        const normalized = normalizeSchedule(schedule);
        const minute = Math.max(0, Math.min(1439, Number(currentMinutes) || 0));
        let current = -1;
        normalized.slots.forEach((slot, index) => { if (minutes(slot.startTime) <= minute) current = index; });
        return { currentIndex: current, current: current >= 0 ? normalized.slots[current] : null, next: current + 1 < normalized.slots.length ? normalized.slots[current + 1] : null };
    }

    /** 角色本地时间是否已经到达该时段；不读取设备时区。 */
    function isSlotUnlocked(slot, currentMinutes) {
        const minute = Math.max(0, Math.min(1439, Number(currentMinutes) || 0));
        return minutes(slot?.startTime) <= minute;
    }

    function formatContext(schedule, options = {}) {
        const normalized = normalizeSchedule(schedule);
        if (!normalized.slots.length) return '';
        const minute = Math.max(0, Math.min(1439, Number(options.currentMinutes) || 0));
        const timeUnlockEnabled = options.timeUnlockEnabled === true;
        const visibleSlots = timeUnlockEnabled
            ? normalized.slots.filter(slot => isSlotUnlocked(slot, minute))
            : normalized.slots;
        const visibleSchedule = visibleSlots.length === normalized.slots.length
            ? normalized
            : { ...normalized, slots: visibleSlots };
        const current = resolveCurrent(visibleSchedule, minute);
        const includeFullDay = options.includeFullDay === true;
        const includeClock = options.includeClock !== false;
        const line = slot => `${includeClock ? `${slot.startTime} ` : ''}${slot.activity}${slot.location ? `（${slot.location}）` : ''}${slot.status === 'completed' ? '【已完成】' : slot.status === 'skipped' ? '【已跳过】' : slot.status === 'cancelled' ? '【已取消】' : ''}`;
        const rows = [];
        if (current.current) rows.push(`当前日程：${line(current.current)}`);
        else if (current.next) rows.push(`接下来日程：${line(current.next)}`);
        else if (timeUnlockEnabled) {
            const nextLocked = normalized.slots.find(slot => !isSlotUnlocked(slot, minute));
            if (nextLocked) rows.push(`当前暂无已解锁日程；下一项将在 ${nextLocked.startTime} 解锁`);
        }
        if (current.current && current.next) rows.push(`之后安排：${line(current.next)}`);
        if (includeFullDay) {
            const fullDaySlots = timeUnlockEnabled ? visibleSlots : normalized.slots;
            rows.push(`${timeUnlockEnabled ? '今日已解锁日程' : '今日完整日程'}：\n${fullDaySlots.map(slot => `- ${line(slot)}${slot.description ? `：${slot.description}` : ''}`).join('\n')}`);
        }
        return `【角色当日日程｜${normalized.date}】\n${rows.join('\n')}\n日程是角色自己的计划；已完成、跳过或取消的活动不要重复声称正在进行。`;
    }

    function parseJson(value) {
        let text = typeof value === 'string' ? value : value?.choices?.[0]?.message?.content || value?.content || '';
        if (Array.isArray(text)) text = text.map(item => typeof item === 'string' ? item : item?.text || '').join('');
        text = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end < start) return null;
        try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
    }

    function applyWeatherImpact(schedule, slotIdValue, decision = {}, snapshot = {}, options = {}) {
        const normalized = normalizeSchedule(schedule);
        const index = normalized.slots.findIndex(slot => String(slot.id) === String(slotIdValue));
        if (index < 0) return { schedule: normalized, impact: null, rejectedReason: 'slot-not-found' };
        const slot = normalized.slots[index];
        const evaluation = evaluateWeatherImpact(slot, snapshot, options);
        const action = Object.values(WEATHER_ACTIONS).includes(decision.action) ? decision.action : evaluation.action;
        if (!evaluation.eligible || action === WEATHER_ACTIONS.none) return { schedule: normalized, impact: null, evaluation };
        const now = Math.max(0, Number(options.now) || Date.now());
        const before = { activity: slot.activity, startTime: slot.startTime, location: slot.location, status: slot.status };
        const next = { ...slot, revision: slot.revision + 1, updatedAt: now };
        if (action === WEATHER_ACTIONS.cancel) {
            next.status = STATUSES.cancelled;
            next.completedAt = null;
        } else if (action === WEATHER_ACTIONS.reschedule) {
            const time = decision.startTime || slot.weatherRescheduleTime;
            if (!time || normalizeTime(time) === slot.startTime) return { schedule: normalized, impact: null, evaluation, rejectedReason: 'reschedule-time-required' };
            if (options.currentMinutes != null && minutes(time) < Math.max(0, Math.min(1439, Number(options.currentMinutes) || 0))) return { schedule: normalized, impact: null, evaluation, rejectedReason: 'reschedule-time-in-past' };
            next.startTime = normalizeTime(time);
            next.status = STATUSES.planned;
            next.completedAt = null;
        } else if (action === WEATHER_ACTIONS.substitute) {
            const activity = cleanText(decision.activity || slot.weatherAlternative, 120);
            if (!activity || activity === slot.activity) return { schedule: normalized, impact: null, evaluation, rejectedReason: 'substitute-activity-required' };
            next.activity = activity;
            if (decision.location !== undefined) next.location = cleanText(decision.location, 120);
            next.status = STATUSES.planned;
            next.completedAt = null;
        }
        const weather = normalizeWeatherSnapshot(snapshot);
        const impact = normalizeWeatherImpact({ slotId: slot.id, action, severity: evaluation.severity, reason: evaluation.reason, before, after: { activity: next.activity, startTime: next.startTime, location: next.location, status: next.status }, snapshot: weather, appliedAt: now }, { now });
        const snapshotKey = item => `${item.snapshot.fetchedAt || ''}|${item.snapshot.observedAt || ''}|${item.snapshot.provider || ''}|${item.snapshot.description || ''}|${item.snapshot.temp ?? ''}`;
        const duplicate = normalized.weatherImpactLog.some(item => item.slotId === impact.slotId && item.action === impact.action && snapshotKey(item) === snapshotKey(impact));
        if (duplicate) return { schedule: normalized, impact: null, evaluation, rejectedReason: 'already-applied' };
        const slots = normalized.slots.slice();
        slots[index] = next;
        return { schedule: { ...normalized, slots, updatedAt: now, weatherImpactLog: [...normalized.weatherImpactLog, impact].slice(-WEATHER_LOG_LIMIT) }, impact, evaluation };
    }

    function applyWeatherSnapshot(schedule, snapshot, options = {}) {
        let current = normalizeSchedule(schedule);
        const impacts = [];
        for (const slot of current.slots) {
            const result = applyWeatherImpact(current, slot.id, {}, snapshot, options);
            if (result.impact) { current = result.schedule; impacts.push(result.impact); }
        }
        return { schedule: current, impacts, changed: impacts.length > 0 };
    }

    global.ScheduleCore = Object.freeze({ VERSION, STATUSES, STATUS_LABELS, ALLOWED_STYLES, MAX_SLOTS, LEDGER_SOURCES, WEATHER_ACTIONS, WEATHER_LOG_LIMIT, cleanText, normalizeTime, minutes, slotActivityKey, normalizeWeatherSnapshot, isWeatherSensitive, evaluateWeatherImpact, normalizeWeatherImpact, normalizeSlot, normalizeSchedule, normalizeLedger, isSettledLedgerStatus, findLedgerEntry, applyLedger, resolveCurrent, isSlotUnlocked, formatContext, parseJson, applyWeatherImpact, applyWeatherSnapshot });
})(typeof window !== 'undefined' ? window : globalThis);
