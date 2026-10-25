(function attachPeriodHealthCore(global) {
    'use strict';

    const VERSION = 1;
    const DEFAULT_CYCLE_LENGTH = 28;
    const DEFAULT_PERIOD_LENGTH = 5;
    const MIN_CYCLE_LENGTH = 15;
    const MAX_CYCLE_LENGTH = 90;
    const MIN_PERIOD_LENGTH = 1;
    const MAX_PERIOD_LENGTH = 14;
    const AUTO_CLOSE_DAYS = 10;
    const text = value => String(value ?? '').trim();

    function validDate(value) {
        const candidate = text(value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return '';
        const [year, month, day] = candidate.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? candidate : '';
    }

    function addDays(value, amount) {
        const date = validDate(value);
        if (!date) return '';
        const [year, month, day] = date.split('-').map(Number);
        const result = new Date(Date.UTC(year, month - 1, day + Number(amount || 0)));
        return `${String(result.getUTCFullYear()).padStart(4, '0')}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
    }

    function diffDays(from, to) {
        const start = validDate(from);
        const end = validDate(to);
        if (!start || !end) return 0;
        return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
    }

    function normalizeSettings(value = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const cycleLength = Number(source.cycleLength);
        const periodLength = Number(source.periodLength);
        return {
            schemaVersion: VERSION,
            cycleLength: Number.isInteger(cycleLength) && cycleLength >= MIN_CYCLE_LENGTH && cycleLength <= MAX_CYCLE_LENGTH ? cycleLength : null,
            periodLength: Number.isInteger(periodLength) && periodLength >= MIN_PERIOD_LENGTH && periodLength <= MAX_PERIOD_LENGTH ? periodLength : null,
            predictionMode: ['auto', 'manual', 'off'].includes(source.predictionMode) ? source.predictionMode : 'auto',
        };
    }

    function recordId(date, kind) { return `period:${validDate(date) || 'undated'}:${kind === 'end' ? 'end' : 'start'}`; }

    function normalizeRecord(value = {}, defaults = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const date = validDate(source.date || defaults.date) || '1970-01-01';
        const kind = source.kind === 'end' ? 'end' : 'start';
        const now = Number(defaults.now) || Date.now();
        return {
            schemaVersion: VERSION,
            id: text(source.id) || recordId(date, kind),
            type: 'health_period_event',
            module: 'period',
            kind,
            date,
            timestamp: Number(source.timestamp) || now,
            updatedAt: Number(source.updatedAt) || now,
            recordedBy: 'user',
            reviewStatus: 'confirmed',
        };
    }

    function effectiveRecords(records) {
        return (Array.isArray(records) ? records : [])
            .filter(item => item && validDate(item.date) && ['start', 'end'].includes(item.kind) && item.reviewStatus !== 'rejected')
            .map(item => normalizeRecord(item))
            .filter(item => item.reviewStatus !== 'rejected')
            .sort((a, b) => a.date === b.date ? a.timestamp - b.timestamp : a.date.localeCompare(b.date));
    }

    function computeStatus(records, settings, today) {
        const day = validDate(today) || '1970-01-01';
        const config = normalizeSettings(settings);
        const events = effectiveRecords(records).filter(item => item.date <= day);
        const lastStart = [...events].reverse().find(item => item.kind === 'start');
        if (!lastStart) return { inPeriod: false, unknown: true, cycleLength: null, periodLength: null, sampleCount: 0, predictionMode: config.predictionMode };
        const lastEnd = [...events].reverse().find(item => item.kind === 'end' && item.date >= lastStart.date && !(item.date === lastStart.date && item.timestamp < lastStart.timestamp));
        const elapsed = diffDays(lastStart.date, day);
        const inPeriod = !lastEnd && elapsed >= 0; // An open record, not a physiological determination.
        const starts = [...new Set(events.filter(item => item.kind === 'start').map(item => item.date))].slice(-7);
        const gaps = starts.slice(1).map((date, index) => diffDays(starts[index], date));
        const complete = getIntervals(events, day).filter(item => !item.open);
        const average = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : null;
        const observedCycle = average(gaps);
        const enough = gaps.length >= 2 && gaps.every(gap => gap >= MIN_CYCLE_LENGTH && gap <= MAX_CYCLE_LENGTH);
        const cycleLength = config.predictionMode === 'manual' ? config.cycleLength : observedCycle;
        const canPredict = config.predictionMode === 'manual' ? !!config.cycleLength : config.predictionMode === 'auto' && enough;
        const nextPredicted = canPredict ? addDays(lastStart.date, cycleLength) : '';
        const predictionFrom = canPredict ? addDays(lastStart.date, config.predictionMode === 'manual' ? cycleLength : Math.min(...gaps)) : '';
        const predictionTo = canPredict ? addDays(lastStart.date, config.predictionMode === 'manual' ? cycleLength : Math.max(...gaps)) : '';
        return {
            inPeriod,
            unknown: !lastEnd,
            dayN: inPeriod ? elapsed + 1 : undefined,
            lastStart: lastStart.date,
            lastEnd: lastEnd?.date || '',
            nextPredicted,
            daysUntilNext: nextPredicted ? diffDays(day, nextPredicted) : null,
            cycleLength, observedCycle, sampleCount: gaps.length,
            periodLength: average(complete.slice(-6).map(item => diffDays(item.start, item.end) + 1)),
            predictionMode: config.predictionMode, predictionFrom, predictionTo,
            predictionPast: !!predictionTo && predictionTo < day,
        };
    }

    function getIntervals(records, today) {
        const day = validDate(today) || '1970-01-01';
        const events = effectiveRecords(records).filter(item => item.date <= day);
        const intervals = [];
        let open = '';
        for (const event of events) {
            if (event.kind === 'start') {
                if (open && open !== event.date) intervals.push({ start: open, end: open, open: true });
                open = event.date;
            } else if (event.kind === 'end' && open) {
                intervals.push({ start: open, end: event.date < open ? open : event.date, open: false });
                open = '';
            }
        }
        if (open) {
            intervals.push({ start: open, end: open, open: true });
        }
        return intervals;
    }

    function predictionText(status) {
        if (status.predictionMode === 'off') return '已关闭日期估算，只保留实际记录。';
        if (!status.nextPredicted) return '记录不足或间隔不适合估算，暂不预测；不知道周期也可以正常记录。';
        const source = status.predictionMode === 'manual' ? '按你选填的周期' : `按最近 ${status.sampleCount} 个开始间隔`;
        return `${source}推算的参考日期：${status.predictionFrom}${status.predictionTo !== status.predictionFrom ? ' 至 ' + status.predictionTo : ''}。${status.predictionPast ? '该参考日期已过去，可能有漏记或变化，不滚动生成新周期。' : ''}仅是历史参考，不代表一定发生，也不用于避孕或判断排卵。`;
    }
    function buildPromptSummary(records, settings, today) {
        const status = computeStatus(records, settings, today);
        if (!status.lastStart) return '';
        const lines = [
            '<period_health_context>',
            '用户已明确授权你读取以下有限的生理期摘要。它来自用户手动记录，不是医疗诊断。只在用户主动提及身体状态时谨慎参考，不要主动猜测、催促、诊断或把估算说成确定事实。',
            `最近记录开始于 ${status.lastStart}${status.lastEnd ? `，记录结束于 ${status.lastEnd}` : '，结束日期尚未记录，不能据此确定当前是否仍在经期'}。不推断没有记录的身体状态。`,
        ];
        lines.push(predictionText(status));
        lines.push('</period_health_context>');
        return lines.join('\n');
    }

    global.PeriodHealthCore = Object.freeze({
        VERSION, DEFAULT_CYCLE_LENGTH, DEFAULT_PERIOD_LENGTH, MIN_CYCLE_LENGTH, MAX_CYCLE_LENGTH,
        MIN_PERIOD_LENGTH, MAX_PERIOD_LENGTH, AUTO_CLOSE_DAYS, validDate, addDays, diffDays,
        normalizeSettings, recordId, normalizeRecord, effectiveRecords, computeStatus, getIntervals,
        buildPromptSummary, predictionText,
    });
})(typeof window !== 'undefined' ? window : globalThis);
