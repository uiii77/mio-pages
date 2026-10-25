(function (global) {
    'use strict';
    const table = () => global.dexieDB.personalEvents;
    const normalize = value => global.PersonalScheduleCore.normalize(value);
    const revision = row => Number.isSafeInteger(row?.revision) && row.revision >= 1 ? row.revision : 1;
    async function list(from, to) {
        if (!global.PeriodHealthCore.validDate(from) || !global.PeriodHealthCore.validDate(to) || from > to) throw new Error('日期范围无效');
        // An event can begin before the requested window; retain the existing date index and table.
        const rows = await table().where('date').belowOrEqual(to)
            .filter(row => global.PersonalScheduleCore.lastDate(row) >= from).toArray();
        return rows.map(row => ({ ...normalize(row), id: row.id, revision: revision(row) }))
            .sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    }
    async function save(id, value, expectedRevision = 0) {
        if (typeof id !== 'string' || !/^personal:[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('日程标识无效');
        const fields = normalize(value);
        return global.dexieDB.transaction('rw', table(), async () => {
            const old = await table().get(id);
            if ((old ? revision(old) : 0) !== expectedRevision) throw new Error('日程已变化，请关闭后重新打开，避免覆盖修改');
            if (old?.recurrence) throw new Error('重复日程请选择操作范围');
            const row = { ...fields, id, revision: expectedRevision + 1, createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
            await table().put(row); return row;
        });
    }
    async function remove(id, expectedRevision) {
        return global.dexieDB.transaction('rw', table(), async () => {
            const old = await table().get(id);
            if (!old || revision(old) !== expectedRevision) throw new Error('日程已变化，请重新打开');
            if (old.recurrence) throw new Error('重复日程请选择操作范围');
            await table().delete(id);
        });
    }
    const core = () => global.PersonalScheduleCore;
    function validId(id) {
        if (typeof id !== 'string' || !/^personal:[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('日程标识无效');
    }
    async function checked(id, expected) {
        validId(id);
        const old = await table().get(id);
        if ((old ? revision(old) : 0) !== expected) throw new Error('日程已变化，请重新打开');
        return old;
    }
    function makeRow(id, fields, rule, exceptions, old, expected) {
        return { ...fields, ...(rule ? { recurrence: rule, exceptions } : {}), id,
            revision: expected + 1, createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
    }
    async function saveSeries(id, value, rule, expected = 0) {
        validId(id);
        const fields = normalize(value), repeat = core().recurrence(rule, fields.date);
        if (!repeat) throw new Error('请选择重复规则');
        return global.dexieDB.transaction('rw', table(), async () => {
            const old = await checked(id, expected), exceptions = old?.exceptions || {};
            // Preserve every exception; incompatible anchor/rule edits require explicit resolution.
            if (!repeat && Object.keys(exceptions).length) throw new Error('已有单次修改，请先保留重复规则');
                for (const date of Object.keys(exceptions)) if (!core().isOccurrence(fields.date, repeat, date)) throw new Error('规则变更与已有单次修改冲突，请先处理单次修改');
            const row = makeRow(id, fields, repeat, exceptions, old, expected);
            await table().put(row); return row;
        });
    }
    async function listOccurrences(from, to) {
        if (!global.PeriodHealthCore.validDate(from) || !global.PeriodHealthCore.validDate(to) || from > to) throw new Error('日期范围无效');
        // Include future-anchored series: an exception may have moved into this window.
        const rows = await table().toArray();
        return rows.flatMap(row => {
            // Exclude ordinary out-of-window records before normalizing potentially large notes.
            // Recurring rows must still expand: future anchors can have exceptions moved backward.
            if (!row.recurrence && (row.date > to || core().lastDate(row) < from)) return [];
            return core().expand(row, row.recurrence, from, to, row.exceptions || {})
                .map(item => ({ ...item, id: row.id, seriesId: row.recurrence ? row.id : null, recurrence: row.recurrence || null, revision: revision(row) }));
        })
            .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    }
    async function getSeries(id, expected) {
        const row = await checked(id, expected);
        if (!row?.recurrence) throw new Error('重复日程不存在');
        return { ...normalize(row), id: row.id, recurrence: { ...row.recurrence }, revision: revision(row) };
    }
    // value=null deletes; value is a complete event. For 'all', dates refer to the series anchor.
    async function changeOccurrence(id, occurrenceDate, scope, value, expected, newId, rule) {
        if (!['one', 'future', 'all'].includes(scope)) throw new Error('操作范围无效');
        const fields = value === null ? null : normalize(value);
        return global.dexieDB.transaction('rw', table(), async () => {
            const old = await checked(id, expected);
            if (!old?.recurrence || !core().isOccurrence(old.date, old.recurrence, occurrenceDate)) throw new Error('重复实例无效');
            const exceptions = { ...(old.exceptions || {}) };
            if (scope === 'one') {
                exceptions[occurrenceDate] = fields;
                const row = makeRow(id, normalize(old), old.recurrence, exceptions, old, expected);
                await table().put(row); return row;
            }
            if (scope === 'all') {
                if (!fields) { await table().delete(id); return null; }
                const repeat = core().recurrence(rule === undefined ? old.recurrence : rule, fields.date);
                if (!repeat && Object.keys(exceptions).length) throw new Error('已有单次修改，请先保留重复规则');
                for (const date of Object.keys(exceptions)) if (!core().isOccurrence(fields.date, repeat, date)) throw new Error('规则变更与已有单次修改冲突，请先处理单次修改');
                const row = makeRow(id, fields, repeat, exceptions, old, expected);
                await table().put(row); return row;
            }
            const before = {}, after = {};
            for (const [date, item] of Object.entries(exceptions)) (date < occurrenceDate ? before : after)[date] = item;
            let next = null;
            if (fields) {
                validId(newId);
                if (newId === id || await table().get(newId)) throw new Error('后续日程标识已存在');
                const repeat = core().recurrence(rule === undefined ? old.recurrence : rule, fields.date);
                if (!repeat && Object.keys(after).length) throw new Error('后续有单次修改，请先保留重复规则');
                for (const date of Object.keys(after)) if (!core().isOccurrence(fields.date, repeat, date)) throw new Error('后续规则与已有单次修改冲突，请先处理单次修改');
                next = makeRow(newId, fields, repeat, after, null, 0);
            }
            if (occurrenceDate === old.date) await table().delete(id);
            else await table().put(makeRow(id, normalize(old), { ...old.recurrence, until: global.PeriodHealthCore.addDays(occurrenceDate, -1) }, before, old, expected));
            if (next) await table().put(next);
            return next;
        });
    }
    global.PersonalSchedule = Object.freeze({ list, save, remove, saveSeries, listOccurrences, changeOccurrence, getSeries });
})(window);
