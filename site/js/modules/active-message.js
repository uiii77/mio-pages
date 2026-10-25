// 主动消息 2.0：本地前台任务调度。
// 复用 OvO 现有后台 API、聊天写入和角色 VirtualClock；可靠的关闭页面后推送留给后续 Worker 模块。
(function attachActiveMessage(global) {
    'use strict';

    const Core = global.ActiveMessageCore;
    if (!Core) return;

    let checkRunning = false;
    let initialized = false;

    const getCharacter = id => (global.db?.characters || []).find(item => String(item.id) === String(id)) || null;
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const stateFor = (character, now = Date.now()) => {
        character.activeMessageV2 = Core.normalizeState(character.activeMessageV2, now);
        return character.activeMessageV2;
    };
    const persist = async character => {
        if (typeof global.saveCharacter === 'function') return global.saveCharacter(character.id);
        if (typeof global.saveData === 'function') return global.saveData();
        return true;
    };

    function statusText(task) {
        if (task?.status === 'skipped') return '已由日程结算';
        if (task.status === 'pending') return task.retryAt > Date.now() ? '等待重试' : '待执行';
        if (task.status === 'running') return '执行中';
        if (task.status === 'sent') return '已完成';
        if (task.status === 'failed') return `失败（${task.lastError || '可重试'}）`;
        if (task.status === 'cancelled') return '已取消';
        if (task.status === 'expired') return '已过期';
        return task.status;
    }

    function taskKindText(kind) {
        return kind === 'fixed' ? '固定消息' : kind === 'prompt' ? '提示词生成' : '自动生成';
    }

    function recurrenceText(recurrence) {
        return recurrence === 'daily' ? '每天' : recurrence === 'weekly' ? '每周' : '单次';
    }

    function renderTaskList(character) {
        const container = document.getElementById('setting-active-message-list');
        if (!container) return;
        const state = stateFor(character);
        if (!state.tasks.length) {
            container.innerHTML = '<p class="kkt-item-hint">还没有主动消息任务。关闭此功能不会删除已经保存的任务。</p>';
            return;
        }
        container.innerHTML = state.tasks.map(task => {
            const preview = task.kind === 'fixed' ? task.content : (task.prompt || '按角色当前上下文生成');
            const action = ['failed', 'skipped', 'cancelled', 'expired', 'sent'].includes(task.status)
                ? `<button type="button" class="btn btn-small btn-secondary" data-active-message-retry="${escapeHtml(task.id)}">重试</button>`
                : `<button type="button" class="btn btn-small btn-secondary" data-active-message-cancel="${escapeHtml(task.id)}">取消</button>`;
            return `<div class="kkt-item active-message-task-row"><div class="kkt-item-label"><strong>${escapeHtml(task.title || taskKindText(task.kind))}</strong><p class="kkt-item-hint">${escapeHtml(taskKindText(task.kind))} · ${escapeHtml(recurrenceText(task.recurrence))} · ${escapeHtml(statusText(task))}<br>${escapeHtml(preview.slice(0, 100))}</p></div><div class="kkt-item-control">${action}</div></div>`;
        }).join('');
    }

    async function loadScheduleActivityOptions(character) {
        const select = document.getElementById('setting-active-message-schedule-activity-key');
        if (!select) return;
        const previous = select.value;
        const options = [{ value: '', label: '不关联' }];
        try {
            const schedule = global.Schedule?.getSchedule ? await global.Schedule.getSchedule(character) : null;
            (schedule?.slots || []).forEach(slot => options.push({ value: slot.activityKey, label: `${slot.startTime} · ${slot.activity}` }));
        } catch (error) {
            console.warn('[ActiveMessage] 日程活动读取失败，继续使用不关联模式:', error);
        }
        select.innerHTML = options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
        if (previous && options.some(option => option.value === previous)) select.value = previous;
    }

    function defaultDueInput(character, realNow = Date.now()) {
        const clock = global.VirtualClock?.resolveCharacter?.(character);
        const virtualNow = clock && global.VirtualClock?.virtualInstantMs
            ? global.VirtualClock.virtualInstantMs(clock, realNow + 30 * 60 * 1000)
            : realNow + 30 * 60 * 1000;
        if (global.VirtualClock?.inputValue) return global.VirtualClock.inputValue(virtualNow, clock?.timeZone || '', false);
        const date = new Date(virtualNow);
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function loadCharacterSettings(character) {
        if (!character) return;
        const state = stateFor(character);
        const enabled = document.getElementById('setting-active-message-enabled');
        const options = document.getElementById('setting-active-message-options');
        if (enabled) enabled.checked = state.enabled;
        if (options) options.style.display = state.enabled ? 'block' : 'none';
        const due = document.getElementById('setting-active-message-due-at');
        if (due) due.value = defaultDueInput(character);
        renderTaskList(character);
        void loadScheduleActivityOptions(character);
    }

    function saveCharacterSettings(character) {
        if (!character) return;
        const state = stateFor(character);
        const enabled = document.getElementById('setting-active-message-enabled');
        if (enabled) state.enabled = enabled.checked;
        character.activeMessageV2 = state;
    }

    async function addTaskFromForm() {
        const character = getCharacter(global.currentChatId);
        if (!character) return global.showToast?.('请先打开一个角色聊天');
        const kind = document.getElementById('setting-active-message-kind')?.value || 'generated';
        const title = document.getElementById('setting-active-message-title')?.value || '';
        const content = document.getElementById('setting-active-message-content')?.value || '';
        const prompt = document.getElementById('setting-active-message-prompt')?.value || '';
        const recurrence = document.getElementById('setting-active-message-recurrence')?.value || 'once';
        const activitySelect = document.getElementById('setting-active-message-schedule-activity-key');
        const scheduleActivityKey = activitySelect?.value || '';
        const scheduleActivityLabel = activitySelect?.selectedOptions?.[0]?.textContent || '';
        const dueInput = document.getElementById('setting-active-message-due-at')?.value || '';
        const dueAt = Core.resolveVirtualWallClock(character, dueInput) ?? Date.parse(dueInput);
        if (!Number.isFinite(dueAt)) return global.showToast?.('请设置有效的执行时间');
        const clock = global.VirtualClock?.resolveCharacter?.(character) || {};
        try {
            const result = Core.addTask(stateFor(character), {
                kind, title, content, prompt, recurrence, nextRunAt: dueAt,
                scheduleActivityKey, scheduleActivityLabel,
                clockRate: Number(clock.rate) || 1
            });
            character.activeMessageV2 = result.state;
            await persist(character);
            const contentEl = document.getElementById('setting-active-message-content');
            const promptEl = document.getElementById('setting-active-message-prompt');
            const titleEl = document.getElementById('setting-active-message-title');
            if (contentEl) contentEl.value = '';
            if (promptEl) promptEl.value = '';
            if (titleEl) titleEl.value = '';
            if (activitySelect) activitySelect.value = '';
            renderTaskList(character);
            global.showToast?.('主动消息任务已保存');
        } catch (error) {
            global.showToast?.(error.message || '主动消息任务保存失败');
        }
    }

    async function updateTask(character, operation) {
        const result = operation(stateFor(character));
        if (!result?.accepted) return;
        character.activeMessageV2 = result.state;
        await persist(character);
        renderTaskList(character);
    }

    function bindSettings() {
        const enabled = document.getElementById('setting-active-message-enabled');
        const options = document.getElementById('setting-active-message-options');
        enabled?.addEventListener('change', () => {
            if (options) options.style.display = enabled.checked ? 'block' : 'none';
        });
        document.getElementById('setting-active-message-add')?.addEventListener('click', () => { void addTaskFromForm(); });
        const updateKindFields = kind => {
            const content = document.getElementById('setting-active-message-content');
            const prompt = document.getElementById('setting-active-message-prompt');
            if (content) content.closest('.kkt-item')?.classList.toggle('active-message-hidden', kind !== 'fixed');
            if (prompt) prompt.closest('.kkt-item')?.classList.toggle('active-message-hidden', kind !== 'prompt');
        };
        document.getElementById('setting-active-message-kind')?.addEventListener('change', event => updateKindFields(event.target.value));
        const initialKind = document.getElementById('setting-active-message-kind')?.value;
        if (initialKind) updateKindFields(initialKind);
        document.getElementById('setting-active-message-list')?.addEventListener('click', event => {
            const cancelId = event.target.closest('[data-active-message-cancel]')?.dataset.activeMessageCancel;
            const retryId = event.target.closest('[data-active-message-retry]')?.dataset.activeMessageRetry;
            const character = getCharacter(global.currentChatId);
            if (!character) return;
            if (cancelId) void updateTask(character, state => Core.cancelTask(state, cancelId));
            if (retryId) void updateTask(character, state => Core.retryTask(state, retryId));
        });
    }

    function appendFixedMessage(character, task) {
        const raw = task.content.trim();
        if (!raw) return false;
        const name = character.realName || character.remarkName || '角色';
        const content = /^\[[^\]]+的(?:消息|语音|转账|照片|视频)[：:]/.test(raw) ? raw : `[${name}的消息：${raw}]`;
        const activityTrace = global.ActivityTraceCore?.withSchedule(task.activityTrace, {
            characterId: character.id, activityKey: task.scheduleActivityKey, activity: task.scheduleActivityLabel,
        }) || task.activityTrace;
        const message = {
            id: `msg_${Date.now()}_${Math.random()}`,
            role: 'assistant', content, parts: [{ type: 'text', text: content }], timestamp: Date.now(),
            isActiveMessage: true, activeMessageTaskId: task.id,
            ...(activityTrace ? { activityTrace } : {})
        };
        character.history ||= [];
        character.history.push(message);
        if (global.currentChatId === character.id && global.currentChatType === 'private' && typeof global.addMessageBubble === 'function') {
            global.addMessageBubble(message, character.id, 'private');
        }
        if (typeof global.renderChatList === 'function') global.renderChatList();
        return true;
    }

    async function executeTask(character, task) {
        if (task.kind === 'fixed') {
            const sent = appendFixedMessage(character, task);
            if (sent) await persist(character);
            return sent;
        }
        if (typeof global.getAiReply !== 'function') throw new Error('聊天回复入口尚未加载');
        const prompt = task.kind === 'prompt' ? task.prompt : '';
        return (await global.getAiReply(character.id, 'private', true, false, false, false, {
            backgroundReason: 'activeMessage',
            activeMessageTaskId: task.id,
            activeMessagePrompt: prompt,
            scheduleActivityKey: task.scheduleActivityKey,
            scheduleActivityLabel: task.scheduleActivityLabel,
            activityTrace: global.ActivityTraceCore?.withSchedule(task.activityTrace, {
                characterId: character.id, activityKey: task.scheduleActivityKey, activity: task.scheduleActivityLabel,
            }) || task.activityTrace,
        })) === true;
    }

    async function processCharacter(character, now) {
        let state = Core.expireTasks(stateFor(character, now), now);
        if (!state.enabled || character.isBlocked) {
            character.activeMessageV2 = state;
            return;
        }
        const recentBackgroundAt = Math.max(
            Number(character.autoReply?.lastSuccessTime || 0),
            Number(character.followUpReply?.lastSuccessAt || 0)
        );
        if (recentBackgroundAt && now - recentBackgroundAt < 60 * 1000) {
            character.activeMessageV2 = state;
            return;
        }
        const claim = Core.claimNext(state, now);
        state = claim.state;
        if (!claim.task) {
            character.activeMessageV2 = state;
            return;
        }
        const task = claim.task;
        character.activeMessageV2 = state;
        await persist(character);

        // Linked schedule activities share one ledger. If another path already
        // settled the slot, do not send a duplicate proactive message.
        if (task.scheduleActivityKey && global.Schedule?.isActivitySettled) {
            try {
                if (await global.Schedule.isActivitySettled(character, task.scheduleActivityKey)) {
                    const skipped = Core.skipTask(state, task.id, '关联日程已完成，无需重复执行', now);
                    character.activeMessageV2 = skipped.state;
                    await persist(character);
                    return;
                }
            } catch (error) {
                console.warn('[ActiveMessage] 日程账本检查失败，保持主动消息原有执行路径:', error);
            }
        }

        if (typeof global.isInQuietHours === 'function' && global.isInQuietHours(character.id)) {
            const released = Core.releaseTask(state, task.id, task.leaseId, '免打扰时段，稍后重试', now + 15 * 60 * 1000, now);
            character.activeMessageV2 = released.state;
            await persist(character);
            return;
        }
        if (global.FollowUpReply?.hasPending?.(character)) {
            const released = Core.releaseTask(state, task.id, task.leaseId, '等待已有追发任务完成', now + 60 * 1000, now);
            character.activeMessageV2 = released.state;
            await persist(character);
            return;
        }
        if (global.isGenerating) {
            const released = Core.releaseTask(state, task.id, task.leaseId, '当前已有回复生成中', now + 60 * 1000, now);
            character.activeMessageV2 = released.state;
            await persist(character);
            return;
        }

        let success = false;
        let errorMessage = '';
        try {
            success = await executeTask(character, task);
        } catch (error) {
            errorMessage = error?.message || String(error);
            console.warn('[ActiveMessage] task failed:', error);
        }
        const completed = Core.completeTask(state, task.id, task.leaseId, { success, error: errorMessage }, Date.now());
        character.activeMessageV2 = completed.state;
        await persist(character);
        if (success && task.scheduleActivityKey && global.Schedule?.recordActivity) {
            try {
                await global.Schedule.recordActivity(character, {
                    activityKey: task.scheduleActivityKey,
                    activity: task.scheduleActivityLabel,
                    status: 'completed',
                    source: global.ScheduleCore?.LEDGER_SOURCES?.activeMessage || 'active-message',
                    runKey: task.runKey,
                    taskId: task.id,
                    activityTrace: global.ActivityTraceCore?.withSchedule(task.activityTrace, {
                        characterId: character.id, activityKey: task.scheduleActivityKey, activity: task.scheduleActivityLabel,
                    }) || task.activityTrace,
                });
            } catch (error) {
                console.warn('[ActiveMessage] 日程账本写入失败，不阻塞主动消息:', error);
            }
        }
    }

    async function checkDue(now = Date.now()) {
        if (checkRunning || !Array.isArray(global.db?.characters)) return;
        checkRunning = true;
        try {
            // 每个角色每轮最多处理一条，避免恢复前台时集中发送多条消息。
            for (const character of global.db.characters) await processCharacter(character, now);
        } finally {
            checkRunning = false;
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;
        bindSettings();
    }

    global.ActiveMessageScheduler = {
        init, checkDue, loadCharacterSettings, saveCharacterSettings, renderTaskList,
        ensureState: stateFor,
        _test: { appendFixedMessage, processCharacter, defaultDueInput }
    };
})(typeof window !== 'undefined' ? window : globalThis);
