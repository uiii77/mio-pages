// Cross-feature trace references for schedule, moments, and chat records.
(function attachActivityTraceCore(global) {
    'use strict';

    const VERSION = 1;
    const MAX_REFS = 32;
    const text = (value, max = 240) => String(value == null ? '' : value).trim().slice(0, max);
    const unique = (values, max = MAX_REFS) => [...new Set((Array.isArray(values) ? values : []).map(value => text(value)).filter(Boolean))].slice(-max);
    const object = value => value && typeof value === 'object' ? value : {};

    function normalizeScheduleRef(value) {
        const source = object(value);
        const result = {
            characterId: text(source.characterId || source.charId, 120),
            date: text(source.date, 20),
            slotId: text(source.slotId, 180),
            activityKey: text(source.activityKey, 240),
            activity: text(source.activity, 160),
        };
        return Object.values(result).some(Boolean) ? result : null;
    }

    function normalizeMessageRef(value) {
        const source = object(value);
        const result = { chatId: text(source.chatId, 160), chatType: text(source.chatType || 'private', 24), messageId: text(source.messageId || source.id, 240) };
        return result.chatId && result.messageId ? result : null;
    }

    function normalize(value) {
        const source = object(value?.activityTrace || value);
        const schedule = normalizeScheduleRef(source.schedule);
        const moments = object(source.moments);
        const messages = [];
        const seenMessages = new Set();
        for (const message of (Array.isArray(source.messages) ? source.messages : []).map(normalizeMessageRef).filter(Boolean)) {
            const key = `${message.chatType}:${message.chatId}:${message.messageId}`;
            if (seenMessages.has(key)) continue;
            seenMessages.add(key);
            messages.push(message);
        }
        const result = { version: VERSION, schedule, moments: { postIds: unique(moments.postIds), eventIds: unique(moments.eventIds) }, messages };
        return result.schedule || result.moments.postIds.length || result.moments.eventIds.length || result.messages.length ? result : null;
    }

    function merge(...values) {
        const normalized = values.map(normalize).filter(Boolean);
        if (!normalized.length) return null;
        return normalize({
            schedule: normalized.map(item => item.schedule).find(Boolean),
            moments: { postIds: normalized.flatMap(item => item.moments.postIds), eventIds: normalized.flatMap(item => item.moments.eventIds) },
            messages: normalized.flatMap(item => item.messages),
        });
    }

    function withSchedule(value, ref = {}) {
        const current = normalize(value);
        const schedule = normalizeScheduleRef({ ...(current?.schedule || {}), ...object(ref) });
        return merge(current, schedule ? { schedule } : null);
    }
    function withMoment(value, ref = {}) {
        const current = normalize(value), moments = current?.moments || { postIds: [], eventIds: [] };
        return merge(current, { moments: { postIds: [...moments.postIds, text(ref.postId, 180)], eventIds: [...moments.eventIds, text(ref.eventId, 180)] } });
    }
    function withMessage(value, ref = {}) {
        const current = normalize(value), message = normalizeMessageRef(ref);
        return merge(current, message ? { messages: [message] } : null);
    }
    function fromSchedule(ref = {}) { return withSchedule(null, ref); }

    global.ActivityTraceCore = Object.freeze({ VERSION, MAX_REFS, normalize, merge, withSchedule, withMoment, withMessage, fromSchedule, normalizeScheduleRef, normalizeMessageRef });
})(typeof window !== 'undefined' ? window : globalThis);
