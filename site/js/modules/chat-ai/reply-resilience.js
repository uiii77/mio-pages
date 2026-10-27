(function () {
    'use strict';

    const SESSION_KEY = 'ovo_reply_ui_session_v1';
    const DIAGNOSTIC_KEY = 'ovo_reply_lifecycle_log_v1';
    const RUNNING_STATES = new Set(['preparing', 'requesting', 'streaming', 'recovering', 'finalizing']);
    const RECOVERABLE_STATES = new Set(['stalled', 'interrupted']);
    const PENDING_STATES = new Set(['queued', ...RUNNING_STATES, ...RECOVERABLE_STATES]);
    const CHECKPOINT_DELAY = 450;
    const ownerId = `reply_owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const pendingWrites = new Map();
    const activeTasks = new Map();
    const taskLockReleases = new Map();
    const jobs = new Map();
    const records = new Map();
    const occupied = new Set();
    const scopeOf = chat => String(chat?.chatArchiveScopeId || '');
    const laneOf = task => JSON.stringify([task.chatType, task.chatId, task.archiveScope]);
    function scopeMatches(task) { const chat = getChat(task.chatId, task.chatType); return !!chat && task.archiveScope === scopeOf(chat); }
    function revision(message) {
        if (!message) return '';
        const text = JSON.stringify([message.content, message.parts, message.isContextDisabled, message.excludeFromContext]);
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        return String(hash >>> 0);
    }
    function inputMatches(task) {
        const chat = getChat(task.chatId, task.chatType);
        return scopeMatches(task) && (task.userMessageId == null || task.userMessageId === '' || revision(chat.history?.find(message => message.id === task.userMessageId)) === task.inputRevision);
    }

    function renderQueue() {
        if (typeof currentChatId === 'undefined' || typeof document === 'undefined' || !document.createElement) return;
        const indicator = document.getElementById('typing-indicator');
        if (!indicator) return;
        let bar = document.getElementById('chat-task-status');
        if (!bar) { bar = document.createElement('div'); bar.id = 'chat-task-status'; bar.className = 'chat-task-status'; bar.setAttribute('role', 'status'); indicator.after(bar); }
        const relevant = [...records.values()].filter(task => task.chatId === currentChatId && task.chatType === currentChatType && scopeMatches(task) && !['completed', 'cancelled', 'abandoned'].includes(task.state));
        bar.replaceChildren(); bar.hidden = !relevant.length;
        const running = relevant.find(task => RUNNING_STATES.has(task.state));
        const queued = relevant.find(task => task.state === 'queued');
        const failed = relevant.find(task => ['interrupted', 'failed', 'stalled'].includes(task.state));
        const text = document.createElement('span');
        text.textContent = running ? `正在回复${queued ? ' · 新输入已排队' : ''}` : queued ? '等待回复' : '上次任务未完成';
        if (failed && !running && !queued) { text.title = failed.error?.message || ''; text.textContent = `未完成：${failed.error?.message || '请重试'}`; }
        bar.append(text);
        const action = (label, work) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = () => void work().catch(error => typeof showToast === 'function' && showToast(error.message)); bar.append(button); };
        if (running) action('停止', () => cancelTask(running.id));
        if (queued) action('取消排队', () => cancelTask(queued.id));
        if (failed && !running && !queued) { action('重试', () => retryTask(failed.id)); action('取消', () => cancelTask(failed.id)); }
        if (typeof getReplyBtn !== 'undefined') getReplyBtn.disabled = false;
    }

    async function enqueue(details, execute) {
        const chat = getChat(details.chatId, details.chatType);
        if (!chat) return false;
        const archiveScope = scopeOf(chat), inputId = getLatestUserMessageId(chat);
        const tipId = chat.history?.at(-1)?.id ?? '';
        const kind = details.isSummary ? 'summary' : 'reply';
        const operation = JSON.stringify([kind, details.isBackground, details.queueOptions?.regenerate || null, details.queueOptions?.backgroundReason || '', details.queueOptions?.followUpTaskId || '', details.queueOptions?.memberIds || [], details.queueOptions?.isCharBlockedMonologue, details.queueOptions?.isPhoneControlRevokeAttempt]);
        const same = task => task.chatId === details.chatId && task.chatType === details.chatType && task.archiveScope === archiveScope && task.operation === operation;
        if (!details.recoveryTaskId) {
            const queued = [...jobs.values()].find(job => same(job.task) && job.task.state === 'queued');
            if (queued) {
                queued.task.userMessageId = inputId; queued.task.inputTipId = tipId;
                queued.task.inputRevision = revision(chat.history?.find(message => message.id === inputId));
                queued.execute = execute; queued.task.queueOptions = details.queueOptions || {};
                await putTask(queued.task); renderQueue(); return queued.promise;
            }
            const existing = [...jobs.values()].find(job => same(job.task) && job.task.userMessageId === inputId && job.task.inputTipId === tipId);
            if (existing) return existing.promise;
        }
        let task = details.recoveryTaskId ? await getTask(details.recoveryTaskId) : null;
        if (task && !inputMatches(task)) throw new Error('原存档或输入已经变化，请重新点击回复');
        task ||= { id: createId(), chatId: details.chatId, chatType: details.chatType, archiveScope, kind, operation, userMessageId: inputId, inputTipId: tipId, inputRevision: revision(chat.history?.find(message => message.id === inputId)), createdAt: Date.now(), attempt: 0 };
        task.state = 'queued'; task.ownerId = ownerId; task.isBackground = !!details.isBackground;
        task.queueVersion = 1; task.cancelRequestedAt = null; task.error = null;
        task.queueOptions = details.queueOptions || task.queueOptions || {};
        const job = { task, execute, controller: new AbortController() };
        job.promise = new Promise(resolve => { job.resolve = resolve; });
        jobs.set(task.id, job); records.set(task.id, task);
        try { await putTask(task); } catch (error) { jobs.delete(task.id); records.delete(task.id); job.resolve(false); throw error; }
        if (!details.recoveryTaskId) {
            for (const previous of records.values()) {
                if (previous.id !== task.id && same(previous) && ['failed', 'interrupted', 'stalled'].includes(previous.state)) {
                    previous.state = 'abandoned'; await putTask(previous);
                }
            }
        }
        renderQueue(); pumpQueue();
        return job.promise;
    }

    function pumpQueue() {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        const waiting = [...jobs.values()].filter(job => job.task.state === 'queued').sort((a, b) => Number(a.task.isBackground) - Number(b.task.isBackground) || a.task.createdAt - b.task.createdAt);
        for (const job of waiting) {
            const lane = laneOf(job.task);
            if (occupied.has(lane) || job.claiming) continue;
            occupied.add(lane); job.claiming = true;
            void runJob(job).finally(() => { occupied.delete(lane); jobs.delete(job.task.id); renderQueue(); pumpQueue(); });
        }
    }

    async function runJob(job) {
        const task = job.task;
        const run = async () => {
            if (job.controller.signal.aborted || !inputMatches(task)) throw new DOMException('任务已取消、输入已修改或存档已切换', 'AbortError');
            // Another tab may have completed the same clicked input while we waited for the chat lock.
            const rows = table() ? await table().where('chatId').equals(task.chatId).toArray() : [];
            if (rows.some(row => row.id !== task.id && row.state === 'completed' && row.completedAt >= task.createdAt && row.archiveScope === task.archiveScope && row.chatType === task.chatType && row.operation === task.operation && row.inputTipId === task.inputTipId && row.userMessageId === task.userMessageId && row.inputRevision === task.inputRevision)) { await complete(task); return true; }
            task.state = 'preparing'; await putTask(task); renderQueue();
            const result = await job.execute(task, job.controller.signal);
            if (!['completed', 'cancelled', 'failed', 'interrupted'].includes(task.state)) {
                if (result === true) await complete(task);
                else await fail(task, new Error('任务未完成，可重试'), job.controller.signal.aborted);
            }
            return result;
        };
        try {
            const name = `mio-chat-${typeof dexieDB !== 'undefined' ? dexieDB.name : ''}-${laneOf(task)}`;
            const result = navigator.locks?.request ? await navigator.locks.request(name, { signal: job.controller.signal }, run) : await run();
            job.resolve(result);
        } catch (error) { await fail(task, error, error.name === 'AbortError').catch(() => {}); job.resolve(false); }
    }

    async function cancelTask(id) {
        const task = jobs.get(id)?.task || await getTask(id);
        if (!task) return false;
        task.cancelRequestedAt = Date.now();
        const job = jobs.get(id); job?.controller.abort();
        await fail(task, new DOMException('用户已停止任务', 'AbortError'), true);
        if (job && !job.claiming) { jobs.delete(id); job.resolve(false); }
        renderQueue(); return true;
    }

    async function retryTask(id) {
        const task = await getTask(id);
        if (!task || !scopeMatches(task) || task.archiveScope === undefined) throw new Error('无法确认原任务的存档，请在当前聊天重新点击回复');
        if (getChat(task.chatId, task.chatType)?.history?.some(message => message.replyRequestId === task.id)) {
            const saved = task.chatType === 'group' ? await saveGroup(task.chatId) : await saveCharacter(task.chatId);
            if (saved === false) throw new Error('回复保存失败，请保留页面后重试');
            await complete(task); renderQueue();
            if (typeof showToast === 'function') showToast('此任务已有保存的回复，未重复调用；可继续发送或重新生成');
            return false;
        }
        if (task.requestStartedAt && typeof showAppConfirmDialog === 'function') {
            const decision = await showAppConfirmDialog({ title: '重新尝试回复', message: '上次请求可能已经计费。已保存的消息会保留；重试会重新请求模型。', confirmText: '重试', dismissText: '' });
            if (decision !== 'confirm') return false;
        }
        return getAiReply(task.chatId, task.chatType, task.isBackground, task.kind === 'summary', !!task.queueOptions?.isCharBlockedMonologue, !!task.queueOptions?.isPhoneControlRevokeAttempt, { ...task.queueOptions, recoveryTaskId: task.id });
    }

    async function markRequested(task) {
        if (!task) return;
        task.requestStartedAt = Date.now(); task.state = 'requesting'; await flush(task);
    }
    let sessionSaveTimer = null;
    let recoveryTimer = null;
    let initialized = false;

    function table() {
        return typeof dexieDB !== 'undefined' && dexieDB && dexieDB.pendingReplies ? dexieDB.pendingReplies : null;
    }

    function createId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return `reply_${globalThis.crypto.randomUUID()}`;
        return `reply_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function cloneSafe(value) {
        if (value === undefined) return undefined;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    }

    function logEvent(event, task, details) {
        try {
            const entries = JSON.parse(localStorage.getItem(DIAGNOSTIC_KEY) || '[]');
            entries.push({
                at: Date.now(),
                event,
                taskId: task && task.id || '',
                chatId: task && task.chatId || '',
                state: task && task.state || '',
                visibility: typeof document !== 'undefined' ? document.visibilityState : '',
                online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
                details: details || ''
            });
            localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(entries.slice(-120)));
        } catch (_) { /* diagnostics must never affect chat */ }
    }

    function getChat(chatId, chatType) {
        if (typeof db === 'undefined') return null;
        return chatType === 'group'
            ? (db.groups || []).find(item => item.id === chatId)
            : (db.characters || []).find(item => item.id === chatId);
    }

    function getLatestUserMessageId(chat) {
        const message = [...(chat && chat.history || [])].reverse().find(item => item && item.role === 'user' && !item.excludeFromContext);
        return message ? message.id : '';
    }

    async function putTask(task) {
        const store = table();
        if (!store || !task) return task;
        task.updatedAt = Date.now();
        records.set(task.id, task);
        if (task.ownerId === ownerId && RUNNING_STATES.has(task.state)) activeTasks.set(task.id, task);
        else activeTasks.delete(task.id);
        await store.put(cloneSafe(task));
        return task;
    }

    function taskLockName(taskId) {
        return `ovo-reply-task-${taskId}`;
    }

    function holdTaskLock(task) {
        if (!task || taskLockReleases.has(task.id) || typeof navigator === 'undefined'
            || !navigator.locks || typeof navigator.locks.request !== 'function') return;
        let releaseLock;
        const lockLifetime = new Promise(resolve => { releaseLock = resolve; });
        taskLockReleases.set(task.id, releaseLock);
        navigator.locks.request(taskLockName(task.id), async lock => {
            if (!lock) return;
            await lockLifetime;
        }).catch(error => {
            taskLockReleases.delete(task.id);
            console.warn('[ReplyResilience] task lock unavailable:', error);
        });
    }

    function releaseTaskLock(task) {
        if (!task) return;
        const releaseLock = taskLockReleases.get(task.id);
        if (releaseLock) releaseLock();
        taskLockReleases.delete(task.id);
    }

    async function getTask(id) {
        if (!id) return null;
        if (jobs.has(id)) return jobs.get(id).task;
        if (activeTasks.has(id)) return activeTasks.get(id);
        const store = table();
        const task = store ? await store.get(id) : null;
        if (task) records.set(id, task);
        return task || null;
    }

    async function findRecoverable(chatId, chatType, userMessageId, isBackground, memberId = '') {
        const store = table();
        if (!store) return null;
        const candidates = await store.where('chatId').equals(chatId).toArray();
        return candidates
            .filter(task => task.chatType === chatType && scopeMatches(task) && !!task.isBackground === !!isBackground && PENDING_STATES.has(task.state)
                && (task.memberId || '') === memberId
                && (!userMessageId || !task.userMessageId || task.userMessageId === userMessageId))
            .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0] || null;
    }

    async function begin(details) {
        const chat = getChat(details.chatId, details.chatType);
        const userMessageId = details.userMessageId || getLatestUserMessageId(chat);
        let task = details.queueTaskId || details.recoveryTaskId ? await getTask(details.queueTaskId || details.recoveryTaskId) : null;
        if (!task && details.reuseExisting !== false) {
            task = await findRecoverable(details.chatId, details.chatType, userMessageId, details.isBackground, details.memberId || '');
        }
        const now = Date.now();
        if (task) {
            const continuingInterruptedTask = task.state === 'interrupted' || task.state === 'stalled';
            if (task.rawPartial) task.previousPartial = task.rawPartial;
            task.state = details.recoveryTaskId ? 'recovering' : (details.initialState || 'requesting');
            task.attempt = Math.max(1, Number(task.attempt) || 1) + ((details.recoveryTaskId || continuingInterruptedTask) ? 1 : 0);
            task.ownerId = ownerId;
            task.provider = details.provider || task.provider || '';
            task.model = details.model || task.model || '';
            task.streamEnabled = !!details.streamEnabled;
            task.isBackground = details.isBackground !== undefined ? !!details.isBackground : !!task.isBackground;
            task.rawPartial = '';
            task.reasoningPartial = '';
            task.receivedBytes = 0;
            task.lastChunkAt = 0;
            task.error = null;
            task.recoveredAt = details.recoveryTaskId ? now : task.recoveredAt || null;
        } else {
            task = {
                id: createId(),
                chatId: details.chatId,
                chatType: details.chatType,
                memberId: details.memberId || '',
                archiveScope: scopeOf(chat),
                userMessageId,
                state: details.initialState || 'requesting',
                provider: details.provider || '',
                model: details.model || '',
                streamEnabled: !!details.streamEnabled,
                isBackground: !!details.isBackground,
                rawPartial: '',
                reasoningPartial: '',
                receivedBytes: 0,
                lastChunkAt: 0,
                attempt: 1,
                ownerId,
                createdAt: now,
                updatedAt: now,
                hiddenAt: null,
                completedAt: null,
                error: null
            };
        }
        await putTask(task);
        holdTaskLock(task);
        if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskStart === 'function') {
            window.KeepAliveModule.notifyTaskStart(task.id);
        }
        logEvent(details.recoveryTaskId ? 'recovery-started' : 'request-started', task);
        return task;
    }

    function scheduleCheckpoint(task) {
        if (!task || pendingWrites.has(task.id)) return;
        const timer = setTimeout(() => {
            pendingWrites.delete(task.id);
            putTask(task).catch(error => console.warn('[ReplyResilience] checkpoint failed:', error));
        }, CHECKPOINT_DELAY);
        pendingWrites.set(task.id, timer);
    }

    function checkpoint(task, content, reasoning, extra) {
        if (!task || task.cancelRequestedAt || ['cancelled', 'completed'].includes(task.state)) return;
        const requestedState = extra && extra.state;
        if (content !== undefined) task.rawPartial = String(content || '');
        if (reasoning !== undefined) task.reasoningPartial = String(reasoning || '');
        if (extra && typeof extra === 'object') Object.assign(task, extra);
        task.state = requestedState || (task.state === 'recovering' ? 'recovering' : 'streaming');
        task.receivedBytes = task.rawPartial.length + task.reasoningPartial.length;
        task.lastChunkAt = Date.now();
        task.updatedAt = task.lastChunkAt;
        activeTasks.set(task.id, task);
        scheduleCheckpoint(task);
    }

    async function flush(task) {
        if (!task) return;
        const timer = pendingWrites.get(task.id);
        if (timer) clearTimeout(timer);
        pendingWrites.delete(task.id);
        await putTask(task);
    }

    async function flushAll() {
        await Promise.all([...activeTasks.values()].map(task => flush(task).catch(() => {})));
    }

    async function markFinalizing(task, rawResponse) {
        if (!task) return;
        task.state = 'finalizing';
        task.rawPartial = String(rawResponse || task.rawPartial || '');
        await flush(task);
    }

    async function complete(task) {
        if (!task) return;
        task.state = 'completed';
        task.completedAt = Date.now();
        task.error = null;
        task.rawPartial = '';
        task.reasoningPartial = '';
        task.previousPartial = '';
        task.transportBytes = 0;
        await flush(task);
        activeTasks.delete(task.id);
        releaseTaskLock(task);
        if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskEnd === 'function') {
            window.KeepAliveModule.notifyTaskEnd(task.id);
        }
        logEvent('completed', task);
    }

    function hasActive(chatId, chatType) {
        return [...activeTasks.values()].some(task => task.chatId === chatId && task.chatType === chatType
            && task.ownerId === ownerId && RUNNING_STATES.has(task.state));
    }

    function canFinalize(task) {
        return !!task && task.ownerId === ownerId && RUNNING_STATES.has(task.state) && !task.cancelRequestedAt && scopeMatches(task);
    }

    async function fail(task, error, cancelled) {
        if (!task) return;
        const status = error && error.response && Number(error.response.status);
        const permanentClientError = error?.retryable === false || status >= 400 && status < 500 && status !== 408 && status !== 429;
        task.state = cancelled || task.cancelRequestedAt ? 'cancelled' : permanentClientError ? 'failed' : 'interrupted';
        task.error = error ? { name: error.name || 'Error', message: String(error.message || error).slice(0, 500) } : null;
        await flush(task);
        activeTasks.delete(task.id);
        releaseTaskLock(task);
        if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskEnd === 'function') {
            window.KeepAliveModule.notifyTaskEnd(task.id);
        }
        logEvent(task.state, task, task.error && task.error.name);
    }

    async function cancelForChat(chatId, chatType) {
        let cancelledJob = false;
        for (const job of [...jobs.values()]) {
            if (job.task.chatId === chatId && job.task.chatType === chatType && scopeMatches(job.task)) cancelledJob = await cancelTask(job.task.id);
        }
        const store = table();
        const storedTasks = store ? await store.where('chatId').equals(chatId).toArray() : [];
        const candidates = new Map();
        storedTasks.forEach(task => {
            if (task.chatType === chatType && !task.isBackground && PENDING_STATES.has(task.state) && scopeMatches(task)) candidates.set(task.id, task);
        });
        activeTasks.forEach(task => {
            if (task.chatId === chatId && task.chatType === chatType && !task.isBackground && PENDING_STATES.has(task.state)) {
                candidates.set(task.id, task);
            }
        });
        if (!candidates.size) return cancelledJob;
        const now = Date.now();
        for (const task of candidates.values()) {
            task.cancelRequestedAt = now;
            task.state = 'cancelled';
            task.error = { name: 'AbortError', message: '用户已停止本次调用' };
            await putTask(task);
            activeTasks.delete(task.id);
            releaseTaskLock(task);
            if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskEnd === 'function') {
                window.KeepAliveModule.notifyTaskEnd(task.id);
            }
            logEvent('cancelled', task, 'user-requested');
        }
        return true;
    }

    function readSession() {
        try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
    }

    function captureSession() {
        const activeScreen = document.querySelector('.screen.active');
        const messageInputElement = document.getElementById('message-input');
        const messageAreaElement = document.getElementById('message-area');
        return {
            activeScreen: activeScreen ? activeScreen.id : 'home-screen',
            chatId: typeof currentChatId !== 'undefined' ? currentChatId : null,
            chatType: typeof currentChatType !== 'undefined' ? currentChatType : null,
            currentPage: typeof currentPage !== 'undefined' ? currentPage : 1,
            inputDraft: messageInputElement ? messageInputElement.value : '',
            scrollTop: messageAreaElement ? messageAreaElement.scrollTop : 0,
            scrollHeight: messageAreaElement ? messageAreaElement.scrollHeight : 0,
            updatedAt: Date.now()
        };
    }

    function saveSessionNow() {
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(captureSession())); } catch (_) { /* storage can be unavailable */ }
    }

    function scheduleSessionSave() {
        clearTimeout(sessionSaveTimer);
        sessionSaveTimer = setTimeout(saveSessionNow, 180);
    }

    function restoreSession() {
        const session = readSession();
        if (!session) return false;
        if (session.activeScreen === 'chat-room-screen' && session.chatId && getChat(session.chatId, session.chatType)
            && typeof openChatRoom === 'function') {
            openChatRoom(session.chatId, session.chatType);
            if (typeof currentPage !== 'undefined' && Number.isFinite(Number(session.currentPage))) {
                currentPage = Math.max(1, Number(session.currentPage));
                if (currentPage > 1 && typeof renderMessages === 'function') renderMessages(false, false);
            }
            const input = document.getElementById('message-input');
            if (input && session.inputDraft) input.value = session.inputDraft;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const area = document.getElementById('message-area');
                if (!area) return;
                const distanceFromBottom = Math.max(0, Number(session.scrollHeight || 0) - Number(session.scrollTop || 0));
                area.scrollTop = Math.max(0, area.scrollHeight - distanceFromBottom);
            }));
            return true;
        }
        return false;
    }

    async function recoverPending() {
        const store = table();
        if (!store || typeof getAiReply !== 'function') return;
        for (const task of await store.toArray()) {
            if (!jobs.has(task.id)) records.set(task.id, task);
            if (!PENDING_STATES.has(task.state) || jobs.has(task.id) || activeTasks.has(task.id) && task.ownerId === ownerId) continue;
            if (navigator.locks?.query) {
                const locks = await navigator.locks.query();
                const lane = `mio-chat-${typeof dexieDB !== 'undefined' ? dexieDB.name : ''}-${laneOf(task)}`;
                if (locks.held.some(lock => lock.name === taskLockName(task.id) || lock.name === lane)) continue;
            }
            if (task.ownerId !== ownerId && Date.now() - task.updatedAt < 6000) {
                clearTimeout(recoveryTimer); recoveryTimer = setTimeout(() => void recoverPending(), 6500); continue;
            }
            const chat = getChat(task.chatId, task.chatType);
            if (task.archiveScope === undefined || !scopeMatches(task)) {
                task.state = 'interrupted'; task.error = { message: '原存档无法确认或已切换，未自动重新调用' };
                await putTask(task); continue;
            }
            if (chat?.history?.some(message => message.replyRequestId === task.id)) { await complete(task); continue; }
            if (task.queueVersion === 1 && task.state === 'queued' && !task.requestStartedAt && !task.isBackground) {
                void getAiReply(task.chatId, task.chatType, false, task.kind === 'summary', !!task.queueOptions?.isCharBlockedMonologue, !!task.queueOptions?.isPhoneControlRevokeAttempt, { ...task.queueOptions, recoveryTaskId: task.id }).catch(error => { task.state = 'interrupted'; task.error = { message: error.message }; void putTask(task); });
            } else {
                task.state = 'interrupted'; task.error = { message: '上次任务已中断，已保留进度；请确认后重试' };
                await putTask(task);
            }
        }
        renderQueue();
    }

    function bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                const now = Date.now();
                activeTasks.forEach(task => { if (RUNNING_STATES.has(task.state)) task.hiddenAt = now; });
                saveSessionNow();
                logEvent('hidden');
                void flushAll();
            } else {
                logEvent('visible');
                activeTasks.forEach(task => { task.lastVisibleAt = Date.now(); scheduleCheckpoint(task); });
            }
        });
        window.addEventListener('pagehide', () => { saveSessionNow(); logEvent('pagehide'); void flushAll(); });
        window.addEventListener('pageshow', event => {
            logEvent(event.persisted ? 'pageshow-bfcache' : 'pageshow');
            if (event.persisted || document.wasDiscarded) void recoverPending();
        });
        window.addEventListener('online', () => { logEvent('online'); pumpQueue(); void recoverPending(); });
        document.addEventListener('freeze', () => { saveSessionNow(); void flushAll(); });
        document.addEventListener('resume', () => { void recoverPending(); });
        document.addEventListener('input', event => {
            if (event.target && event.target.id === 'message-input') scheduleSessionSave();
        });
        const area = document.getElementById('message-area');
        if (area) area.addEventListener('scroll', scheduleSessionSave, { passive: true });
    }

    async function init() {
        if (initialized) return;
        initialized = true;
        bindLifecycle();
        // 刷新后保留默认首页，不自动恢复上次打开的聊天页面。
        const store = table();
        if (store) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const oldCompleted = await store.filter(task => task.state === 'completed' && (task.completedAt || task.updatedAt || 0) < cutoff).primaryKeys();
            if (oldCompleted.length) await store.bulkDelete(oldCompleted);
        }
        // 不阻塞其余模块初始化；恢复调用在完整 UI 就绪后异步开始。
        setTimeout(() => { void recoverPending(); }, 0);
    }

    window.ReplyResilience = {
        init,
        begin,
        checkpoint,
        flush,
        flushAll,
        markFinalizing,
        complete,
        fail,
        cancelForChat,
        canFinalize,
        getTask,
        findRecoverable,
        hasActive,
        saveSessionNow,
        scheduleSessionSave,
        restoreSession,
        recoverPending,
        enqueue, cancelTask, retryTask, renderQueue, markRequested,
        _test: { RUNNING_STATES, RECOVERABLE_STATES, PENDING_STATES, captureSession, readSession, createId }
    };
})();
