(function (global) {
    'use strict';
    function normalize(value) {
        const text = (key, max) => {
            const result = String(value?.[key] ?? '').trim();
            if (result.length > max) throw new Error('内容过长');
            return result;
        };
        const title = text('title', 120), date = global.PeriodHealthCore.validDate(value?.date);
        if (!title || !date) throw new Error('请填写标题和有效日期');
        const endDate = value?.endDate == null || value.endDate === '' ? date : global.PeriodHealthCore.validDate(value.endDate);
        if (!endDate || endDate < date) throw new Error('结束日期不能早于开始日期');
        const allDay = value.allDay !== false;
        const start = allDay ? '' : text('start', 5), end = allDay ? '' : text('end', 5);
        const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
        if (!allDay && (!time.test(start) || (end && !time.test(end)) || (endDate > date ? !end : end && end <= start))) throw new Error('请填写有效时段，结束须晚于开始；跨日需填写结束时间');
        return { title, date, ...(endDate > date ? { endDate } : {}), allDay, start, end, location: text('location', 200), notes: text('notes', 2000) };
    }
    function lastDate(event) {
        const end = event.endDate || event.date;
        return event.allDay === false && event.end === '00:00' && end > event.date ? global.PeriodHealthCore.addDays(end, -1) : end;
    }
    // Recurrence is a pure projection. Stored events and old normalization stay unchanged.
    function recurrence(value, anchor) {
        if (value == null || value.frequency === 'none') return null;
        if (!value || !['daily', 'weekly', 'monthly'].includes(value.frequency)) throw new Error('重复规则无效');
        const until = value.until == null || value.until === '' ? '' : global.PeriodHealthCore.validDate(value.until);
        if (!global.PeriodHealthCore.validDate(anchor) || (value.until != null && value.until !== '' && !until) || (until && until < anchor)) throw new Error('重复结束日期无效');
        return { frequency: value.frequency, ...(until ? { until } : {}) };
    }
    const dayNumber = date => Math.floor(Date.parse(date + 'T00:00:00Z') / 86400000);
    function isOccurrence(anchor, rule, date) {
        if (!global.PeriodHealthCore.validDate(anchor) || !global.PeriodHealthCore.validDate(date)) return false;
        const normalized = recurrence(rule, anchor);
        if (!normalized) return date === anchor;
        if (date < anchor || normalized.until && date > normalized.until) return false;
        const distance = dayNumber(date) - dayNumber(anchor);
        return normalized.frequency === 'daily' || (normalized.frequency === 'weekly' ? distance % 7 === 0 : date.slice(8) === anchor.slice(8));
    }
    function expand(value, rule, from, to, exceptions = {}) {
        const valid = global.PeriodHealthCore.validDate;
        if (!valid(from) || !valid(to) || from > to) throw new Error('日期范围无效');
        const base = normalize(value), repeat = recurrence(rule, base.date);
        if (!repeat) {
            if (Object.keys(exceptions).length) throw new Error('非重复日程不能包含单次修改');
            return base.date <= to && lastDate(base) >= from ? [{ ...base, occurrenceDate: base.date }] : [];
        }
        const span = dayNumber(base.endDate || base.date) - dayNumber(base.date);
        const start = Math.max(dayNumber(base.date), dayNumber(from) - span);
        const end = dayNumber(to);
        // Reject oversized work explicitly; never silently omit instances.
        if (end - start > 3660 || Object.keys(exceptions).length > 10000) throw new Error('查询范围过大，请缩小日期范围');
        const result = [];
        const project = originalDate => {
            const offset = dayNumber(originalDate) - dayNumber(base.date);
            const event = normalize({ ...base, date: originalDate, endDate: base.endDate ? global.PeriodHealthCore.addDays(base.endDate, offset) : originalDate });
            const override = exceptions[originalDate];
            if (override === null) return;
            const effective = override === undefined ? event : normalize(override);
            if (effective.date <= to && lastDate(effective) >= from) result.push({ ...effective, occurrenceDate: originalDate });
        };
        const visited = new Set();
        for (let day = start; day <= end; day++) {
            const date = new Date(day * 86400000).toISOString().slice(0, 10);
            if (isOccurrence(base.date, repeat, date)) { visited.add(date); project(date); }
        }
        // A moved exception can intersect this window even when its original date does not.
        for (const date of Object.keys(exceptions)) {
            if (!valid(date) || !isOccurrence(base.date, repeat, date)) throw new Error('单次修改与重复规则不匹配');
            if (!visited.has(date)) project(date);
        }
        return result.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.occurrenceDate.localeCompare(b.occurrenceDate));
    }
    const occursOn = (event, date) => event.date <= date && lastDate(event) >= date;
    global.PersonalScheduleCore = Object.freeze({ normalize, lastDate, occursOn, recurrence, isOccurrence, expand });
})(globalThis);
