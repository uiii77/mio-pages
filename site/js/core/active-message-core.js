/*
 * Mio 主动消息 2.0 的本地任务契约。
 *
 * 这是 SullyOS activeMsgStore/runtime 的前台、无服务端子集：任务有稳定 ID、
 * 可重复的 runKey、租约和失败状态，页面刷新或重复 tick 不会把同一任务发送两次。
 * 任务保存在角色记录的新增字段中，不改变 OvO 的聊天历史或 Dexie 表结构。
 */
(function attachActiveMessageCore(global) {
    'use strict';

    const VERSION = 1;
    const MAX_TASKS = 64;
    const MAX_TEXT_LENGTH = 4000;
    const DEFAULT_LEASE_MS = 2 * 60 * 1000;
    const DEFAULT_RETRY_MS = 60 * 1000;
    const MAX_RETRY_MS = 15 * 60 * 1000;
    const RECURRENCE_MS = Object.freeze({ once: 0, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 });
    const KINDS = new Set(['fixed', 'generated', 'prompt']);
    const RECURRENCES = new Set(Object.keys(RECURRENCE_MS));
    const TERMINAL_STATES = new Set(['sent', 'skipped', 'cancelled', 'expired', 'failed']);

    const asFinite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const asText = (value, max = MAX_TEXT_LENGTH) => String(value ?? '').trim().slice(0, max);
    const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, asFinite(value, fallback)));
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function makeId(prefix = 'amsg') {
        if (global.crypto?.randomUUID) return `${prefix}_${global.crypto.randomUUID()}`;
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    function defaultState() {
        return { schemaVersion: VERSION, enabled: false, maxTasks: 8, tasks: [], lastTickAt: 0 };
    }

    function normalizeTask(input, now = Date.now()) {
        const source = input && typeof input === 'object' ? input : {};
        const kind = KINDS.has(source.kind) ? source.kind : 'generated';
        const recurrence = RECURRENCES.has(source.recurrence) ? source.recurrence : 'once';
        const dueAt = asFinite(source.nextRunAt ?? source.dueAt, 0);
        const id = asText(source.id, 160) || makeId('amsg_task');
        const repeatIntervalMs = RECURRENCE_MS[recurrence];
        const maxAttempts = Math.round(clamp(source.maxAttempts, 1, 4, 3));
        const status = ['pending', 'running', ...TERMINAL_STATES].includes(source.status) ? source.status : 'pending';
        return {
            id,
            kind,
            title: asText(source.title, 120),
            content: asText(source.content),
            prompt: asText(source.prompt),
            recurrence,
            repeatIntervalMs,
            clockRate: clamp(source.clockRate, 0.01, 100, 1),
            nextRunAt: dueAt > 0 ? dueAt : now,
            retryAt: Math.max(0, asFinite(source.retryAt, 0)),
            expiresAt: Math.max(0, asFinite(source.expiresAt, 0)),
            status,
            enabled: source.enabled !== false,
            failureCount: Math.round(clamp(source.failureCount, 0, maxAttempts, 0)),
            maxAttempts,
            lastSentAt: Math.max(0, asFinite(source.lastSentAt, 0)),
            lastError: asText(source.lastError, 500),
            leaseId: asText(source.leaseId, 160),
            leaseUntil: Math.max(0, asFinite(source.leaseUntil, 0)),
            runKey: asText(source.runKey, 240),
            // Optional bridge to the character schedule activity ledger. Empty keeps
            // legacy active-message tasks completely unchanged.
            scheduleActivityKey: asText(source.scheduleActivityKey, 240),
            scheduleActivityLabel: asText(source.scheduleActivityLabel, 160),
            createdAt: Math.max(0, asFinite(source.createdAt, now)) || now,
            updatedAt: Math.max(0, asFinite(source.updatedAt, now)) || now
        };
    }

    function normalizeState(input, now = Date.now()) {
        const source = input && typeof input === 'object' ? input : {};
        const tasks = Array.isArray(source.tasks)
            ? source.tasks.map(task => normalizeTask(task, now)).filter(Boolean).slice(0, MAX_TASKS)
            : [];
        const seen = new Set();
        return {
            schemaVersion: VERSION,
            enabled: source.enabled === true,
            maxTasks: Math.round(clamp(source.maxTasks, 1, MAX_TASKS, 8)),
            tasks: tasks.filter(task => {
                if (seen.has(task.id)) return false;
                seen.add(task.id);
                return true;
            }),
            lastTickAt: Math.max(0, asFinite(source.lastTickAt, 0))
        };
    }

    function createTask(input = {}, now = Date.now(), idFactory = makeId) {
        const source = { ...input, id: input.id || idFactory('amsg_task'), createdAt: now, updatedAt: now, status: 'pending', enabled: input.enabled !== false };
        const task = normalizeTask(source, now);
        if (task.kind === 'fixed' && !task.content) throw new Error('固定主动消息需要正文');
        if (task.kind === 'prompt' && !task.prompt) throw new Error('提示词主动消息需要提示内容');
        if (task.kind !== 'fixed') task.content = '';
        task.runKey = `${task.id}:${task.nextRunAt}`;
        return task;
    }

    function addTask(state, input, now = Date.now(), idFactory = makeId) {
        const next = normalizeState(state, now);
        if (next.tasks.length >= next.maxTasks) throw new Error(`主动消息任务最多保存 ${next.maxTasks} 条`);
        const task = createTask(input, now, idFactory);
        if (next.tasks.some(item => item.id === task.id)) throw new Error('主动消息任务 ID 重复');
        next.tasks.push(task);
        return { state: next, task };
    }

    function getTask(state, taskId) {
        return normalizeState(state).tasks.find(task => task.id === taskId) || null;
    }

    function isDue(task, now = Date.now()) {
        if (!task || !task.enabled || task.status !== 'pending') return false;
        if (task.expiresAt && now >= task.expiresAt) return false;
        return now >= Math.max(task.nextRunAt, task.retryAt || 0);
    }

    function claimNext(state, now = Date.now(), leaseMs = DEFAULT_LEASE_MS, idFactory = makeId) {
        const next = normalizeState(state, now);
        const candidates = next.tasks
            .filter(task => isDue(task, now) && (!task.leaseUntil || task.leaseUntil <= now))
            .sort((left, right) => left.nextRunAt - right.nextRunAt || left.createdAt - right.createdAt);
        const task = candidates[0];
        if (!task) {
            next.lastTickAt = now;
            return { state: next, task: null };
        }
        task.status = 'running';
        task.leaseId = idFactory('amsg_lease');
        task.leaseUntil = now + Math.max(1000, asFinite(leaseMs, DEFAULT_LEASE_MS));
        task.runKey = `${task.id}:${task.nextRunAt}`;
        task.updatedAt = now;
        next.lastTickAt = now;
        return { state: next, task: clone(task) };
    }

    function clearLease(task, now) {
        task.leaseId = '';
        task.leaseUntil = 0;
        task.updatedAt = now;
    }

    function completeTask(state, taskId, leaseId, result = {}, now = Date.now()) {
        const next = normalizeState(state, now);
        const task = next.tasks.find(item => item.id === taskId);
        if (!task || task.status !== 'running' || (leaseId && task.leaseId !== leaseId)) return { state: next, task: null, accepted: false };
        const success = result.success === true;
        if (success) {
            task.lastSentAt = now;
            task.lastError = '';
            task.failureCount = 0;
            task.retryAt = 0;
            if (task.recurrence === 'once') {
                task.status = 'sent';
                task.enabled = false;
            } else {
                const interval = task.repeatIntervalMs / Math.max(0.01, task.clockRate || 1);
                task.nextRunAt = Math.max(now + interval, task.nextRunAt + interval);
                task.runKey = `${task.id}:${task.nextRunAt}`;
                task.status = 'pending';
            }
        } else {
            task.failureCount += 1;
            task.lastError = asText(result.error || '主动消息执行失败', 500);
            if (task.failureCount >= task.maxAttempts) {
                task.status = 'failed';
                task.enabled = false;
            } else {
                task.status = 'pending';
                const retryMs = Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * (2 ** (task.failureCount - 1)));
                task.retryAt = now + retryMs;
            }
        }
        clearLease(task, now);
        return { state: next, task: clone(task), accepted: true };
    }

    function releaseTask(state, taskId, leaseId, reason = '任务暂缓', retryAt = Date.now() + DEFAULT_RETRY_MS, now = Date.now()) {
        const next = normalizeState(state, now);
        const task = next.tasks.find(item => item.id === taskId);
        if (!task || task.status !== 'running' || (leaseId && task.leaseId !== leaseId)) return { state: next, task: null, accepted: false };
        task.status = 'pending';
        task.retryAt = Math.max(now + 1000, asFinite(retryAt, now + DEFAULT_RETRY_MS));
        task.lastError = asText(reason, 500);
        clearLease(task, now);
        return { state: next, task: clone(task), accepted: true };
    }

    function cancelTask(state, taskId, now = Date.now()) {
        const next = normalizeState(state, now);
        const task = next.tasks.find(item => item.id === taskId);
        if (!task) return { state: next, task: null, accepted: false };
        task.status = 'cancelled';
        task.enabled = false;
        task.lastError = '';
        clearLease(task, now);
        return { state: next, task: clone(task), accepted: true };
    }

    function retryTask(state, taskId, now = Date.now()) {
        const next = normalizeState(state, now);
        const task = next.tasks.find(item => item.id === taskId);
        if (!task || !['failed', 'skipped', 'cancelled', 'expired', 'sent'].includes(task.status)) return { state: next, task: null, accepted: false };
        task.status = 'pending';
        task.enabled = true;
        task.failureCount = 0;
        task.retryAt = 0;
        task.nextRunAt = now;
        task.runKey = `${task.id}:${now}`;
        task.lastError = '';
        task.updatedAt = now;
        return { state: next, task: clone(task), accepted: true };
    }

    function skipTask(state, taskId, reason = '已由其他活动完成', now = Date.now()) {
        const next = normalizeState(state, now);
        const task = next.tasks.find(item => item.id === taskId);
        if (!task || !['pending', 'running'].includes(task.status)) return { state: next, task: null, accepted: false };
        task.status = 'skipped';
        task.enabled = false;
        task.lastError = asText(reason, 500);
        clearLease(task, now);
        return { state: next, task: clone(task), accepted: true };
    }

    function expireTasks(state, now = Date.now()) {
        const next = normalizeState(state, now);
        next.tasks.forEach(task => {
            if (task.enabled && task.status === 'pending' && task.expiresAt && now >= task.expiresAt) {
                task.status = 'expired';
                task.enabled = false;
                task.lastError = '任务已过期';
                task.updatedAt = now;
            }
            if (task.status === 'running' && task.leaseUntil && task.leaseUntil <= now) {
                task.status = 'pending';
                task.retryAt = now + DEFAULT_RETRY_MS;
                task.lastError = '上一次前台执行中断，已安排重试';
                clearLease(task, now);
            }
        });
        return next;
    }

    function resolveVirtualWallClock(character, value, realNow = Date.now(), clockApi = global.VirtualClock) {
        if (!clockApi?.wallClockToTimestamp) return null;
        const clock = clockApi.resolveCharacter ? clockApi.resolveCharacter(character) : {};
        const virtualMs = clockApi.wallClockToTimestamp(value, clock.timeZone || '');
        if (!Number.isFinite(virtualMs)) return null;
        if (!clock.enabled || !Number.isFinite(clock.anchorRealMs) || !Number.isFinite(clock.anchorVirtualMs)) return virtualMs;
        return clock.anchorRealMs + (virtualMs - clock.anchorVirtualMs) / Math.max(0.01, Number(clock.rate) || 1);
    }

    function virtualWallClockInput(character, realNow = Date.now(), clockApi = global.VirtualClock) {
        if (!clockApi?.resolveCharacter || !clockApi?.virtualInstantMs || !clockApi?.inputValue) return '';
        const clock = clockApi.resolveCharacter(character);
        const virtualMs = clockApi.virtualInstantMs(clock, realNow);
        return clockApi.inputValue(virtualMs, clock.timeZone || '', false);
    }

    global.ActiveMessageCore = Object.freeze({
        VERSION, MAX_TASKS, RECURRENCE_MS,
        defaultState, normalizeTask, normalizeState, createTask, addTask, getTask,
        isDue, claimNext, completeTask, releaseTask, cancelTask, retryTask, skipTask, expireTasks,
        resolveVirtualWallClock, virtualWallClockInput, clone
    });
})(typeof window !== 'undefined' ? window : globalThis);
