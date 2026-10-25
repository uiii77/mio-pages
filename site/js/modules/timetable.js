// 用户课程表存储与同步编排：学校认证及网络请求由注册的外部 provider 负责。
(function attachTimetable(global) {
    'use strict';

    const providers = new Map();
    const refreshLocks = new Map();
    const connectionVersions = new Map();
    const sharingSaves = new Set();
    const sharingVersions = new Map();
    const ERROR_MESSAGES = Object.freeze({
        'authorization-required': '教务系统登录状态已过期，请重新授权',
        offline: '同步设备当前离线，请稍后重试',
        unavailable: '课程表同步服务暂不可用',
        'invalid-response': '同步结果不完整，已保留上次成功课表',
        unknown: '课程表同步失败，请稍后重试',
    });

    function core() {
        if (!global.TimetableCore) throw new Error('TimetableCore 尚未加载');
        return global.TimetableCore;
    }

    function tables() {
        const database = global.dexieDB;
        if (!database?.timetableSnapshots || !database?.timetableAdjustments || !database?.timetableSyncStates || !database?.timetableChanges) throw new Error('课程表数据库尚未就绪');
        return {
            database,
            snapshots: database.timetableSnapshots,
            adjustments: database.timetableAdjustments,
            states: database.timetableSyncStates,
            changes: database.timetableChanges,
        };
    }

    function clean(value, max = 160) { return core().clean(value, max); }
    function connectionId(provider, scopeKey) { return `timetable-sync:${clean(provider, 80)}:${core().stableHash(clean(scopeKey, 120))}`; }
    function snapshotId(provider, scopeKey, semester) { return core().normalizeSnapshot({ provider, scopeKey, semester, complete: false, courses: [] }).id; }
    function publicFailure(error) {
        const requested = clean(error?.code, 40).toLowerCase();
        const code = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, requested) ? requested : error?.requiresAuthorization === true ? 'authorization-required' : 'unknown';
        const failure = new Error(ERROR_MESSAGES[code]);
        failure.code = code;
        failure.requiresAuthorization = code === 'authorization-required';
        return failure;
    }

    function stateRecord(provider, scopeKey, current, patch, now) {
        return {
            id: connectionId(provider, scopeKey),
            provider: clean(provider, 80),
            scopeKey: clean(scopeKey, 120),
            status: clean(patch.status ?? current?.status ?? 'disconnected', 40),
            activeSemester: clean(patch.activeSemester ?? current?.activeSemester, 80),
            lastAttemptAt: Math.max(0, Number(patch.lastAttemptAt ?? current?.lastAttemptAt) || 0),
            lastSuccessAt: Math.max(0, Number(patch.lastSuccessAt ?? current?.lastSuccessAt) || 0),
            lastErrorCode: clean(patch.lastErrorCode ?? current?.lastErrorCode, 40),
            requiresAuthorization: patch.requiresAuthorization ?? (current?.requiresAuthorization === true),
            autoSyncEnabled: (patch.autoSyncEnabled ?? current?.autoSyncEnabled) === true,
            roleShares: core().normalizeShares(patch.roleShares ?? current?.roleShares),
            revision: Math.max(0, Number(current?.revision) || 0) + 1,
            updatedAt: Math.max(0, Number(now) || Date.now()),
        };
    }

    async function updateState(provider, scopeKey, patch, now = Date.now()) {
        const { database, states } = tables();
        return database.transaction('rw', states, async () => {
            const current = await states.get(connectionId(provider, scopeKey));
            const next = stateRecord(provider, scopeKey, current, patch, now);
            await states.put(next);
            return next;
        });
    }

    async function getSyncState(provider, scopeKey) { return tables().states.get(connectionId(provider, scopeKey)); }
    async function setAutoSync(provider, scopeKey, enabled) {
        if (provider !== 'sdmu-weekly' || !clean(scopeKey, 120) || typeof enabled !== 'boolean') throw new Error('无效的课表自动刷新设置');
        if (enabled && !canRefresh(provider, scopeKey)) throw new Error('请先恢复当前课表的扩展连接');
        return updateState(provider, scopeKey, { autoSyncEnabled: enabled });
    }
    async function listSnapshots() { return tables().snapshots.toArray(); }
    async function createManualSemester(value) {
        const snapshot = core().createManualSnapshot(value, `manual:${global.crypto.randomUUID()}`);
        const { database, snapshots } = tables();
        return database.transaction('rw', snapshots, async () => {
            if (await snapshots.get(snapshot.id)) throw new Error('手工课表标识冲突，请重试');
            const now = Date.now();
            const record = { ...snapshot, revision: 1, createdAt: now, updatedAt: now };
            await snapshots.put(record);
            return record;
        });
    }
    async function getRoleShare(roleId) {
        const matches = (await tables().states.toArray()).flatMap(state => core().normalizeShares(state.roleShares)
            .filter(share => share.roleId === String(roleId)).map(share => ({ ...share, provider: state.provider, scopeKey: state.scopeKey })));
        return matches.length === 1 ? matches[0] : null; // Ambiguous imported permissions fail closed.
    }

    async function setRoleShare(roleIdValue, snapshotIdValue, options = null) {
        const roleId = clean(roleIdValue, 120);
        if (!roleId || !global.db?.characters?.some(role => String(role.id) === roleId)) throw new Error('请选择现有角色');
        if (sharingSaves.has(roleId)) throw new Error('正在保存该角色的共享设置');
        sharingSaves.add(roleId);
        sharingVersions.set(roleId, (sharingVersions.get(roleId) || 0) + 1);
        try {
            const { database, states, snapshots } = tables();
            return await database.transaction('rw', states, snapshots, async () => {
                const snapshot = options ? await snapshots.get(snapshotIdValue) : null;
                if (options && !snapshot) throw new Error('课表不存在，请重新选择');
                const share = options ? core().normalizeShares([{ ...options, roleId, semester: snapshot.semester }])[0] : null;
                if (options && !share) throw new Error('请选择有效共享范围');
                const rows = await states.toArray();
                const target = snapshot ? connectionId(snapshot.provider, snapshot.scopeKey) : '';
                if (snapshot && !rows.some(row => row.id === target)) rows.push({ id: target, provider: snapshot.provider, scopeKey: snapshot.scopeKey });
                for (const state of rows) {
                    const current = core().normalizeShares(state.roleShares);
                    const next = current.filter(item => item.roleId !== roleId);
                    if (state.id === target && share) next.push(share);
                    if (JSON.stringify(current) !== JSON.stringify(next)) await states.put(stateRecord(state.provider, state.scopeKey, state, { roleShares: next }, Date.now()));
                }
            });
        } finally { sharingSaves.delete(roleId); }
    }

    async function prepareChatContext(roleIdValue, message, options = {}) {
        const roleId = String(roleIdValue || '');
        const version = sharingVersions.get(roleId) || 0;
        if (options.chatType !== 'private' || options.isSummary || options.isBackground || sharingSaves.has(roleId) || message?.role !== 'user' || !global.db?.characters?.some(role => String(role.id) === roleId)) return '';
        const parser = global.MessageContentParser;
        if (!parser?.sanitizeMessageForModel) return '';
        const safe = parser.sanitizeMessageForModel(message);
        const text = [safe.content, ...(safe.parts || []).filter(part => part.type === 'text').map(part => part.text)].filter(value => typeof value === 'string').join(' ').slice(0, 6000);
        if (!/课表|课程|上课|下课|有课|没课|什么课|几节课|调课|停课|补课|教室|第.{0,3}节课|\b(timetable|classes|class|courses?|classroom|lectures?)\b/i.test(text)) return '';
        const grant = await getRoleShare(roleId);
        if (!grant || sharingSaves.has(roleId)) return '';
        const now = options.now ?? Date.now();
        const today = schoolDate(now);
        let dates = [today];
        if (grant.range === 'two-days') dates.push(schoolDate(Number(now) + 86400000));
        if (grant.range === 'week') {
            const snapshot = await getSnapshot(grant.provider, grant.scopeKey, grant.semester);
            const mapping = core().resolveDate(snapshot, today);
            if (mapping.covered) dates = snapshot.weekDates[mapping.week].map(row => row.date).sort();
        }
        const days = await Promise.all(dates.map(date => getEffectiveDate(grant.provider, grant.scopeKey, grant.semester, date)));
        const currentGrant = await getRoleShare(roleId);
        if (sharingSaves.has(roleId) || version !== (sharingVersions.get(roleId) || 0) || JSON.stringify(currentGrant) !== JSON.stringify(grant) || !global.db?.characters?.some(role => String(role.id) === roleId)) return '';
        return core().summaryForChat(days, grant, grant.semester, grant.provider === 'manual' ? '用户手工课表（未经教务核验）' : grant.provider === 'sdmu-weekly' ? '山东管理学院教务系统（含用户手动调整）' : '用户课表本地缓存（含手动调整）');
    }
    function canRefresh(provider, scopeKey) {
        const entry = providers.get(provider);
        return !!entry && (!entry.isAvailable || entry.isAvailable(scopeKey));
    }
    async function getSnapshot(provider, scopeKey, semester) { return tables().snapshots.get(snapshotId(provider, scopeKey, semester)); }

    function changeRows(diff, snapshot, revision, now) {
        const rows = [];
        const add = (type, courseId, before, after, fields = []) => {
            const id = `timetable-change:${core().stableHash(`${snapshot.id}|${revision}|${type}|${courseId}|${JSON.stringify(fields)}`)}`;
            rows.push({ id, snapshotId: snapshot.id, type, courseId, before: before || null, after: after || null, fields, detectedAt: now, acknowledged: false });
        };
        diff.added.forEach(course => add('added', course.id, null, course));
        diff.removed.forEach(course => add('removed', course.id, course, null));
        diff.changed.forEach(change => add('changed', change.courseId, change.before, change.after, change.fields));
        return rows;
    }

    async function ingestSnapshot(value, options = {}) {
        const now = Math.max(0, Number(options.now) || Date.now());
        const normalized = core().normalizeSnapshot(value, { provider: options.provider, scopeKey: options.scopeKey, semester: options.semester, now });
        if (normalized.provider === 'manual') throw new Error('手工课表只能通过个人调整修改，不能导入教务来源');
        const { database, snapshots, changes, states } = tables();
        return database.transaction('rw', snapshots, changes, states, async () => {
            const current = await snapshots.get(normalized.id);
            const currentState = await states.get(connectionId(normalized.provider, normalized.scopeKey));
            if (!normalized.complete) {
                const state = stateRecord(normalized.provider, normalized.scopeKey, currentState, {
                    status: 'partial', activeSemester: normalized.semester, lastAttemptAt: now,
                    lastErrorCode: 'invalid-response', requiresAuthorization: false,
                }, now);
                await states.put(state);
                return { accepted: false, reason: 'incomplete-snapshot', snapshot: current || null, diff: { safe: false, reason: 'incomplete-snapshot', added: [], removed: [], changed: [] }, changes: [], state };
            }
            if (current?.coverage === 'weekly') throw new Error('按周课表必须通过 ingestWeek 更新');
            const diff = current ? core().diffSnapshots(current, normalized) : { safe: true, reason: '', added: [], removed: [], changed: [] };
            if (!diff.safe) throw Object.assign(new Error('课程表快照范围不一致'), { code: 'invalid-response' });
            const revision = Math.max(0, Number(current?.revision) || 0) + 1;
            const snapshot = { ...normalized, revision, createdAt: current?.createdAt || now, updatedAt: now };
            const rows = changeRows(diff, snapshot, revision, now);
            const state = stateRecord(normalized.provider, normalized.scopeKey, currentState, {
                status: 'connected', activeSemester: normalized.semester, lastAttemptAt: now, lastSuccessAt: now,
                lastErrorCode: '', requiresAuthorization: false,
            }, now);
            await snapshots.put(snapshot);
            if (rows.length) await changes.bulkPut(rows);
            await states.put(state);
            return { accepted: true, reason: '', snapshot, diff, changes: rows, state };
        });
    }

    // Week imports never erase another week, nor infer cancellations from missing rows.
    // Until school completeness/status semantics are verified, absent rows are retained.
    async function ingestWeek(value) {
        const week = Number(value?.week);
        if (!Number.isInteger(week) || week < 1 || week > 60 || !Array.isArray(value?.courses) || !Array.isArray(value?.dates) || value.dates.length !== 7) throw new Error('无效按周课表');
        const dates = value.dates.map((item, index) => {
            if (Number(item.weekday) !== index + 1 || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || new Date(item.date + 'T00:00:00Z').toISOString().slice(0, 10) !== item.date) throw new Error('无效教学周日期');
            return { weekday: index + 1, date: item.date };
        });
        if (new Set(dates.map(item => item.date)).size !== 7) throw new Error('重复教学周日期');
        const now = Date.now();
        const normalized = core().normalizeSnapshot({ ...value, complete: true }, { now });
        if (normalized.provider === 'manual') throw new Error('手工课表不能被学校同步覆盖');
        if (normalized.courses.some(course => course.weeks.length !== 1 || course.weeks[0] !== week)) throw new Error('课程超出查询周');
        const { database, snapshots, states, changes } = tables();
        return database.transaction('rw', snapshots, states, changes, async () => {
            const current = await snapshots.get(normalized.id);
            if (current && current.coverage !== 'weekly') throw new Error('不能将整学期来源覆盖为按周来源');
            const previous = (current?.courses || []).filter(course => course.weeks.includes(week));
            const incoming = new Map(normalized.courses.map(course => [course.id, course]));
            if ((current?.courses || []).some(course => incoming.has(course.id) && !course.weeks.includes(week))) throw new Error('跨周课程标识冲突');
            const missing = previous.filter(course => !incoming.has(course.id));
            const mergedWeek = [...normalized.courses, ...missing];
            const diff = current?.weekDates?.[week] ? core().diffSnapshots({ ...normalized, courses: previous }, { ...normalized, courses: mergedWeek }) : { safe: true, added: [], removed: [], changed: [] };
            const revision = (current?.revision || 0) + 1;
            const snapshot = { ...normalized, complete: false, coverage: 'weekly', revision,
                courses: [...(current?.courses || []).filter(course => !course.weeks.includes(week)), ...mergedWeek],
                weekDates: { ...current?.weekDates, [week]: dates },
                weekStatus: { ...current?.weekStatus, [week]: { fetchedAt: now, missingCount: missing.length, removalVerified: false } },
                createdAt: current?.createdAt || now, updatedAt: now };
            const rows = changeRows(diff, snapshot, revision, now);
            const currentState = await states.get(connectionId(normalized.provider, normalized.scopeKey));
            const state = stateRecord(normalized.provider, normalized.scopeKey, currentState, { status: 'connected', activeSemester: normalized.semester, lastAttemptAt: now, lastSuccessAt: now, lastErrorCode: '', requiresAuthorization: false }, now);
            await snapshots.put(snapshot);
            if (rows.length) await changes.bulkPut(rows);
            await states.put(state);
            return { accepted: true, snapshot, state, missingCount: missing.length };
        });
    }

    async function markFailure(provider, scopeKey, error, now = Date.now()) {
        const failure = publicFailure(error);
        const state = await updateState(provider, scopeKey, {
            status: failure.requiresAuthorization ? 'authorization-required' : 'error',
            lastAttemptAt: now,
            lastErrorCode: failure.code,
            requiresAuthorization: failure.requiresAuthorization,
        }, now);
        return { failure, state };
    }

    function registerProvider(id, provider) {
        const providerId = clean(id, 80);
        if (providerId === 'manual') throw new Error('手工课表不注册学校同步服务');
        if (!providerId || !provider || typeof provider.fetchSnapshot !== 'function' && typeof provider.fetchWeeks !== 'function') throw new Error('课程表 provider 必须提供 fetchSnapshot 或 fetchWeeks');
        const entry = Object.freeze({ fetchSnapshot: provider.fetchSnapshot, fetchWeeks: provider.fetchWeeks, isAvailable: provider.isAvailable, disconnect: typeof provider.disconnect === 'function' ? provider.disconnect : null });
        providers.set(providerId, entry);
        return () => { if (providers.get(providerId) === entry) providers.delete(providerId); };
    }

    async function refresh(request = {}) {
        const providerId = clean(request.provider, 80);
        const scopeKey = clean(request.scopeKey, 120);
        const semester = clean(request.semester, 80);
        const provider = providers.get(providerId);
        if (!provider || !canRefresh(providerId, scopeKey)) throw new Error('课程表同步 provider 未连接');
        if (!scopeKey || !semester) throw new Error('同步请求缺少账号隔离标识或学期');
        const lockKey = `${providerId}|${scopeKey}|${semester}${provider.fetchWeeks ? `|${Number(request.week)}` : ''}`;
        if (refreshLocks.has(lockKey)) return refreshLocks.get(lockKey);
        const task = (async () => {
            const versionKey = connectionId(providerId, scopeKey);
            const version = connectionVersions.get(versionKey) || 0;
            const isCurrent = () => (connectionVersions.get(versionKey) || 0) === version && providers.get(providerId) === provider;
            const assertCurrent = () => { if (!isCurrent()) throw Object.assign(new Error('连接已改变，已忽略此次同步'), { code: 'unavailable' }); };
            const now = Math.max(0, Number(request.now) || Date.now());
            await updateState(providerId, scopeKey, { status: 'syncing', activeSemester: semester, lastAttemptAt: now, lastErrorCode: '', requiresAuthorization: false }, now);
            try {
                if (provider.fetchWeeks) {
                    const requestedWeek = Number(request.week);
                    if (!Number.isInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > 60) throw Object.assign(new Error('无效教学周'), { code: 'invalid-response' });
                    const payloads = await provider.fetchWeeks(Object.freeze({ provider: providerId, scopeKey, semester, week: requestedWeek }));
                    assertCurrent();
                    const expected = requestedWeek === 60 ? [60] : [requestedWeek, requestedWeek + 1];
                    if (!Array.isArray(payloads) || payloads.length !== expected.length || payloads.some((payload, i) => payload?.provider !== providerId || payload?.scopeKey !== scopeKey || payload?.semester !== semester || payload?.week !== expected[i])) throw Object.assign(new Error('返回范围不匹配'), { code: 'invalid-response' });
                    const { database, snapshots, states, changes } = tables();
                    return await database.transaction('rw', snapshots, states, changes, async () => {
                        assertCurrent();
                        const results = [];
                        for (const payload of payloads) { results.push(await ingestWeek(payload)); assertCurrent(); }
                        return { accepted: true, snapshot: results.at(-1).snapshot, weeks: expected, missingCount: results.reduce((sum, result) => sum + result.missingCount, 0) };
                    });
                }
                const payload = await provider.fetchSnapshot(Object.freeze({ provider: providerId, scopeKey, semester, reason: clean(request.reason || 'manual', 40) }));
                assertCurrent();
                return await ingestSnapshot(payload, { provider: providerId, scopeKey, semester, now: Math.max(now, Date.now()) });
            } catch (error) {
                if (!isCurrent()) throw publicFailure({ code: 'unavailable' });
                const { failure } = await markFailure(providerId, scopeKey, error, Math.max(now, Date.now()));
                throw failure;
            }
        })().finally(() => refreshLocks.delete(lockKey));
        refreshLocks.set(lockKey, task);
        return task;
    }

    async function listAdjustments(snapshotIdValue) {
        return tables().adjustments.where('snapshotId').equals(clean(snapshotIdValue, 240)).toArray();
    }

    async function saveAdjustment(snapshotIdValue, value, options = {}) {
        const { database, snapshots, adjustments } = tables();
        return database.transaction('rw', snapshots, adjustments, async () => {
            const snapshot = await snapshots.get(clean(snapshotIdValue, 240));
            if (!snapshot) throw new Error('找不到课程表快照');
            core().validateManualAdjustment(snapshot, value);
            const normalized = core().normalizeAdjustment(value, { provider: snapshot.provider, semester: snapshot.semester, scopeKey: snapshot.scopeKey, now: options.now });
            const current = await adjustments.get(normalized.id);
            if (current && current.snapshotId !== snapshot.id) throw new Error('该调整属于其他课表，请刷新后重试');
            if (options.expectedRevision !== undefined && Math.max(0, Number(current?.revision) || 0) !== Number(options.expectedRevision)) throw new Error('课程调整已变化，请刷新后重试');
            const now = Math.max(0, Number(options.now) || Date.now());
            const record = { ...normalized, snapshotId: snapshot.id, provider: snapshot.provider, scopeKey: snapshot.scopeKey, semester: snapshot.semester, revision: Math.max(0, Number(current?.revision) || 0) + 1, createdAt: current?.createdAt || normalized.createdAt || now, updatedAt: now };
            await adjustments.put(record);
            return record;
        });
    }

    async function deleteAdjustment(id, expectedRevision) {
        const { database, adjustments } = tables();
        return database.transaction('rw', adjustments, async () => {
            const current = await adjustments.get(clean(id, 240));
            if (!current) return false;
            if (expectedRevision !== undefined && current.revision !== Number(expectedRevision)) throw new Error('课程调整已变化，请刷新后重试');
            await adjustments.delete(current.id);
            return true;
        });
    }

    async function getEffectiveWeek(provider, scopeKey, semester, week, context = {}) {
        context = { ...context, scopeKey, semester };
        const snapshot = await getSnapshot(provider, scopeKey, semester);
        if (!snapshot) return { snapshot: null, courses: [], conflicts: [] };
        const adjustments = await listAdjustments(snapshot.id);
        const dates = snapshot.weekDates?.[week];
        if (Array.isArray(dates) && dates.length === 7) {
            const days = dates.map(row => core().coursesForDay(snapshot.courses, adjustments, week, row.weekday, { ...context, date: row.date }));
            return { snapshot, courses: days.flatMap(day => day.courses), conflicts: [...new Map(days.flatMap(day => day.conflicts).map(item => [item.adjustmentId, item])).values()] };
        }
        return { snapshot, ...core().coursesForWeek(snapshot.courses, adjustments, week, context) };
    }

    async function getEffectiveDay(provider, scopeKey, semester, week, weekday, context = {}) {
        const snapshot = await getSnapshot(provider, scopeKey, semester);
        if (!snapshot) return { snapshot: null, courses: [], conflicts: [] };
        const adjustments = await listAdjustments(snapshot.id);
        return { snapshot, ...core().coursesForDay(snapshot.courses, adjustments, week, weekday, { ...context, scopeKey, semester }) };
    }

    function schoolDate(now = Date.now()) {
        return global.VirtualClock.dateKey({ timeZone: 'Asia/Shanghai' }, now);
    }

    async function getCurrentWeek(provider, scopeKey, semester, now = Date.now()) {
        const snapshot = await getSnapshot(provider, scopeKey, semester);
        return core().resolveDate(snapshot, schoolDate(now));
    }

    async function refreshCurrent(request = {}) {
        const mapping = await getCurrentWeek(request.provider, request.scopeKey, request.semester, request.now);
        if (!mapping.covered) throw new Error(mapping.reason === 'ambiguous-date' ? '今天对应多个教学周，请先核对日期映射' : '尚无今天的学校日期映射，请先选择教学周同步');
        const result = await refresh({ ...request, week: mapping.week });
        return { ...result, currentWeek: mapping.week };
    }

    async function getEffectiveDate(provider, scopeKey, semester, date) {
        const snapshot = await getSnapshot(provider, scopeKey, semester);
        const mapping = core().resolveDate(snapshot, date);
        if (!mapping.covered) return { snapshot, ...mapping, courses: [], conflicts: [] };
        const adjustments = await listAdjustments(snapshot.id);
        return { snapshot, ...mapping,
            ...core().coursesForDay(snapshot.courses, adjustments, mapping.week, mapping.weekday, { date, semester, scopeKey }),
            missingCount: snapshot.weekStatus?.[mapping.week]?.missingCount || 0 };
    }

    // Calendar projection: read one consistent source snapshot, never copy courses.
    async function getCalendarDays(id, dates) {
        if (!Array.isArray(dates) || dates.length > 42) throw new Error('日期范围无效');
        const { database, snapshots, adjustments } = tables();
        return database.transaction('r', snapshots, adjustments, async () => {
            const snapshot = await snapshots.get(id);
            const edits = snapshot ? await adjustments.where('snapshotId').equals(id).toArray() : [];
            return dates.map(date => {
                const mapping = core().resolveDate(snapshot, date);
                return { ...mapping, date, courses: [], conflicts: [],
                    ...(mapping.covered ? core().coursesForDay(snapshot.courses, edits, mapping.week, mapping.weekday, { date, semester: snapshot.semester, scopeKey: snapshot.scopeKey }) : {}),
                    missingCount: snapshot?.weekStatus?.[mapping.week]?.missingCount || 0,
                };
            });
        });
    }

    async function listChanges(snapshotIdValue, options = {}) {
        const rows = await tables().changes.where('snapshotId').equals(clean(snapshotIdValue, 240)).toArray();
        return rows.filter(row => options.unacknowledged !== true || row.acknowledged !== true).sort((left, right) => right.detectedAt - left.detectedAt);
    }

    async function acknowledgeChanges(ids, now = Date.now()) {
        const { database, changes } = tables();
        const requested = [...new Set((Array.isArray(ids) ? ids : [ids]).map(id => clean(id, 240)).filter(Boolean))];
        return database.transaction('rw', changes, async () => {
            let count = 0;
            for (const id of requested) {
                const current = await changes.get(id);
                if (!current || current.acknowledged === true) continue;
                await changes.put({ ...current, acknowledged: true, acknowledgedAt: Math.max(0, Number(now) || Date.now()) });
                count += 1;
            }
            return count;
        });
    }

    async function clearScope(provider, scopeKey) {
        const { database, snapshots, adjustments, states, changes } = tables();
        return database.transaction('rw', snapshots, adjustments, states, changes, async () => {
            const scoped = await snapshots.where('[provider+scopeKey]').equals([clean(provider, 80), clean(scopeKey, 120)]).toArray();
            const ids = scoped.map(item => item.id);
            for (const id of ids) {
                await adjustments.where('snapshotId').equals(id).delete();
                await changes.where('snapshotId').equals(id).delete();
                await snapshots.delete(id);
            }
            await states.delete(connectionId(provider, scopeKey));
            return ids.length;
        });
    }

    async function disconnect(providerIdValue, scopeKeyValue, options = {}) {
        const providerId = clean(providerIdValue, 80);
        const scopeKey = clean(scopeKeyValue, 120);
        const provider = providers.get(providerId);
        const versionKey = connectionId(providerId, scopeKey);
        connectionVersions.set(versionKey, (connectionVersions.get(versionKey) || 0) + 1);
        let disconnectError;
        try { if (provider?.disconnect) await provider.disconnect(Object.freeze({ provider: providerId, scopeKey })); }
        catch (error) { disconnectError = error; }
        if (options.deleteLocalData === true) return { deletedSnapshots: await clearScope(providerId, scopeKey), state: null };
        const state = await updateState(providerId, scopeKey, { status: 'disconnected', lastErrorCode: '', requiresAuthorization: false, autoSyncEnabled: false });
        if (disconnectError) throw publicFailure(disconnectError);
        return { deletedSnapshots: 0, state };
    }

    global.Timetable = Object.freeze({
        registerProvider, refresh, refreshCurrent, getCurrentWeek, setAutoSync, ingestSnapshot, ingestWeek, markFailure, getSyncState, getSnapshot, listSnapshots, canRefresh,
        saveAdjustment, deleteAdjustment, listAdjustments, getEffectiveWeek, getEffectiveDay, getEffectiveDate, schoolDate,
        listChanges, acknowledgeChanges, disconnect, clearScope,
        getRoleShare, setRoleShare, prepareChatContext, getCalendarDays,
        createManualSemester,
    });
})(window);
