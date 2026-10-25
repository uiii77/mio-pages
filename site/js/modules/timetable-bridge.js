// Optional transport adapter. Timetable owns all persistence and refresh transactions.
(function (global) {
    'use strict';
    const pending = new Map();
    let connection = null, unregister = null;
    const AUTO_INTERVAL = 15 * 60 * 1000;
    let autoTimer = null, autoGeneration = 0, autoRunning = false, autoStatus = 'unavailable';
    function publishAutoStatus(value) {
        if (autoStatus === value) return;
        autoStatus = value;
        global.dispatchEvent(new Event('mio-timetable-auto-state'));
    }
    function cancelAuto() { clearTimeout(autoTimer); autoTimer = null; autoGeneration++; }
    const visibleOnline = () => !global.document.hidden && global.navigator.onLine !== false;
    async function scheduleAuto() {
        cancelAuto();
        const generation = autoGeneration, current = connection;
        if (!current?.ready) { publishAutoStatus('unavailable'); return; }
        try {
            const saved = await global.Timetable.getSyncState('sdmu-weekly', current.scopeKey);
            if (generation !== autoGeneration || current !== connection) return;
            if (!saved?.autoSyncEnabled) { publishAutoStatus('off'); return; }
            if (global.document.hidden) { publishAutoStatus('hidden'); return; }
            if (global.navigator.onLine === false) { publishAutoStatus('offline'); return; }
            if (saved.requiresAuthorization || !['connected', 'syncing'].includes(saved.status)) { publishAutoStatus('error'); return; }
            const mapping = await global.Timetable.getCurrentWeek('sdmu-weekly', current.scopeKey, current.semester);
            if (generation !== autoGeneration || current !== connection) return;
            if (!mapping.covered) { publishAutoStatus('mapping'); return; }
            if (autoRunning) { publishAutoStatus('running'); return; }
            const elapsed = Math.max(0, Date.now() - (saved.lastAttemptAt || 0));
            const delay = saved.status === 'syncing' ? AUTO_INTERVAL : Math.max(1000, AUTO_INTERVAL - elapsed);
            publishAutoStatus('waiting');
            autoTimer = setTimeout(() => void tickAuto(generation, current), delay);
        } catch { if (generation === autoGeneration) publishAutoStatus('error'); }
    }
    async function tickAuto(generation, current) {
        autoTimer = null;
        if (autoRunning || generation !== autoGeneration || current !== connection || !visibleOnline()) return;
        autoRunning = true;
        try {
            const saved = await global.Timetable.getSyncState('sdmu-weekly', current.scopeKey);
            if (generation !== autoGeneration || current !== connection || !visibleOnline() || !saved?.autoSyncEnabled || saved.requiresAuthorization || saved.status !== 'connected' || Date.now() - saved.lastAttemptAt < AUTO_INTERVAL) return;
            const mapping = await global.Timetable.getCurrentWeek('sdmu-weekly', current.scopeKey, current.semester);
            if (!mapping.covered || generation !== autoGeneration || current !== connection || !visibleOnline()) return;
            publishAutoStatus('running');
            await global.Timetable.refresh({ provider: 'sdmu-weekly', scopeKey: current.scopeKey, semester: current.semester, week: mapping.week });
        } catch { publishAutoStatus('error'); } // Timetable records the sanitized sync failure.
        finally {
            autoRunning = false;
            await scheduleAuto();
            global.dispatchEvent(new Event('mio-timetable-auto-state'));
        }
    }
    const error = code => Object.assign(new Error(code === 'authorization-required' ? '学校登录已失效，请重新登录' : code === 'invalid-response' ? '课表内容或学期不匹配，已保留旧课表' : '请在当前 Mio 页点击课表扩展，恢复连接'), { code });
    function request(action, args = {}, timeout = 35000) {
        return new Promise((resolve, reject) => {
            const id = global.crypto.randomUUID();
            const timer = setTimeout(() => { pending.delete(id); reject(error('unavailable')); }, timeout);
            pending.set(id, { resolve, reject, timer });
            global.postMessage({ channel: 'mio-timetable', direction: 'request', id, action, ...args }, global.location.origin);
        });
    }
    global.addEventListener('message', event => {
        const data = event.data;
        if (event.source !== global || event.origin !== global.location.origin || data?.channel !== 'mio-timetable' || data.direction !== 'response') return;
        const task = pending.get(data.id);
        if (!task) return;
        pending.delete(data.id); clearTimeout(task.timer);
        if (data.response?.ok) task.resolve(data.response.result);
        else task.reject(error(['authorization-required', 'invalid-response'].includes(data.response?.code) ? data.response.code : 'unavailable'));
    });
    function drop() { cancelAuto(); connection = null; unregister?.(); unregister = null; publishAutoStatus('unavailable'); }
    async function probe() {
        try {
            const state = await request('status', {}, 1800);
            if (!state || typeof state.scopeKey !== 'string' || !state.scopeKey || state.scopeKey.length > 120) throw error('unavailable');
            if (connection?.scopeKey !== state.scopeKey) {
                drop();
                unregister = global.Timetable.registerProvider('sdmu-weekly', {
                    isAvailable: scope => !!connection?.ready && (!scope || scope === connection.scopeKey),
                    fetchWeeks: async args => (await request('refresh', args)).weeks,
                    disconnect: async args => {
                        if (args.scopeKey !== connection?.scopeKey) return;
                        try {
                            const result = await request('disconnect', { scopeKey: args.scopeKey }, 5000);
                            if (result.cleanupRequired) throw error('unavailable');
                        } finally { drop(); }
                    },
                });
            }
            connection = state;
            void scheduleAuto();
            return { ...state };
        } catch { drop(); return null; }
    }
    async function refresh() {
        const state = await probe();
        if (!state?.ready) throw new Error('请连接扩展，并在学校课表页正常查询一次');
        try { return await global.Timetable.refresh({ provider: 'sdmu-weekly', scopeKey: state.scopeKey, semester: state.semester, week: state.week }); }
        finally { await scheduleAuto(); }
    }
    global.document.addEventListener('visibilitychange', () => { void scheduleAuto(); });
    global.addEventListener('offline', () => { void scheduleAuto(); });
    global.addEventListener('online', () => { void scheduleAuto(); });
    global.addEventListener('pagehide', cancelAuto);
    global.TimetableBridge = Object.freeze({ probe, refresh, scheduleAuto,
        autoStatus(scopeKey) { return connection?.scopeKey === scopeKey ? autoStatus : 'unavailable'; },
    });
})(window);
