// 联系人印象与话题盒纯领域层。
// 当前默认只启用“角色认识用户”这一方向，但 owner/subject 字段保留了未来双向或角色间关系的扩展边界。
(function attachRelationshipMemoryCore(global) {
    'use strict';

    const VERSION = 1;
    const MAX_IMPRESSIONS = 8;
    const MAX_TOPICS = 30;
    const CONTEXT_TOPIC_LIMIT = 10;

    function now() { return Date.now(); }

    function cleanText(value, max = 800) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function encode(value) {
        return encodeURIComponent(String(value == null ? '' : value));
    }

    function profileId(ownerId, subjectType = 'user', subjectId = 'user') {
        return `rmp:${encode(ownerId)}:${encode(subjectType)}:${encode(subjectId)}`;
    }

    function recordId(prefix = 'rmi') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function normalizeImpression(value, options = {}) {
        const source = typeof value === 'string' ? { text: value } : (value && typeof value === 'object' ? value : {});
        const timestamp = Math.max(0, Number(source.createdAt) || Number(options.now) || now());
        const text = cleanText(source.text || source.content, 800);
        return {
            id: String(source.id || recordId('rmi')),
            text,
            source: source.source === 'manual' ? 'manual' : 'ai',
            createdAt: timestamp,
            updatedAt: Math.max(timestamp, Number(source.updatedAt) || timestamp),
        };
    }

    function normalizeTopic(value, options = {}) {
        const source = value && typeof value === 'object' ? value : { text: value };
        const timestamp = Math.max(0, Number(source.createdAt) || Number(options.now) || now());
        const messageIds = Array.isArray(source.messageIds)
            ? [...new Set(source.messageIds.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 120)
            : [];
        return {
            id: String(source.id || recordId('rmt')),
            text: cleanText(source.text || source.summary || source.content, 800),
            source: source.source === 'manual' ? 'manual' : 'ai',
            createdAt: timestamp,
            updatedAt: Math.max(timestamp, Number(source.updatedAt) || timestamp),
            startMessageIndex: Math.max(0, Number.isFinite(Number(source.startMessageIndex)) ? Math.floor(Number(source.startMessageIndex)) : 0),
            endMessageIndex: Math.max(0, Number.isFinite(Number(source.endMessageIndex)) ? Math.floor(Number(source.endMessageIndex)) : 0),
            messageIds,
        };
    }

    function legacyImpressions(value, options) {
        if (Array.isArray(value)) return value;
        if (typeof value !== 'string') return [];
        return value.split(/\r?\n/).map(text => text.trim()).filter(Boolean).map(text => normalizeImpression({ text }, options));
    }

    function normalizeProfile(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const ownerId = String(source.ownerId || options.ownerId || '');
        const subjectType = String(source.subjectType || options.subjectType || 'user');
        const subjectId = String(source.subjectId || options.subjectId || 'user');
        const createdAt = Math.max(0, Number(source.createdAt) || Number(options.now) || now());
        const updatedAt = Math.max(createdAt, Number(source.updatedAt) || createdAt);
        const impressions = legacyImpressions(source.impressions ?? source.learned, { now: createdAt })
            .map(item => normalizeImpression(item, { now: createdAt }))
            .filter(item => item.text)
            .slice(-MAX_IMPRESSIONS);
        const topics = (Array.isArray(source.topicBox) ? source.topicBox : Array.isArray(source.topics) ? source.topics : [])
            .map(item => normalizeTopic(item, { now: createdAt }))
            .filter(item => item.text)
            .slice(-MAX_TOPICS);
        return {
            id: String(source.id || profileId(ownerId, subjectType, subjectId)),
            schemaVersion: VERSION,
            ownerId,
            subjectType,
            subjectId,
            direction: String(source.direction || 'owner_to_subject'),
            enabled: source.enabled === true,
            impressions,
            // 保留 SullyOS 的 topicBox 语义，同时用对象数组承载可追溯消息范围。
            topicBox: topics,
            topicWaterline: Math.max(0, Math.floor(Number(source.topicWaterline) || 0)),
            createdAt,
            updatedAt,
        };
    }

    function appendImpression(profile, text, source = 'ai', options = {}) {
        const normalized = normalizeProfile(profile, options);
        const nextText = cleanText(text, 800);
        if (!nextText) return normalized;
        if (normalized.impressions.some(item => item.text === nextText)) return normalized;
        const entry = normalizeImpression({ text: nextText, source }, options);
        return { ...normalized, impressions: [...normalized.impressions, entry].slice(-MAX_IMPRESSIONS), updatedAt: entry.updatedAt };
    }

    function appendTopic(profile, text, metadata = {}, options = {}) {
        const normalized = normalizeProfile(profile, options);
        const nextText = cleanText(text, 800);
        if (!nextText) return normalized;
        const entry = normalizeTopic({ ...metadata, text: nextText, source: metadata.source || 'ai' }, options);
        return { ...normalized, topicBox: [...normalized.topicBox, entry].slice(-MAX_TOPICS), updatedAt: entry.updatedAt };
    }

    function updateRecord(profile, collection, id, text, options = {}) {
        const normalized = normalizeProfile(profile, options);
        const key = collection === 'topicBox' ? 'topicBox' : 'impressions';
        const index = normalized[key].findIndex(item => item.id === id);
        if (index < 0) return normalized;
        const current = normalized[key][index];
        const next = collection === 'topicBox'
            ? normalizeTopic({ ...current, text, source: 'manual', updatedAt: now() }, options)
            : normalizeImpression({ ...current, text, source: 'manual', updatedAt: now() }, options);
        const list = normalized[key].slice();
        if (!next.text) list.splice(index, 1); else list[index] = next;
        return { ...normalized, [key]: list, updatedAt: now() };
    }

    function removeRecord(profile, collection, id, options = {}) {
        const normalized = normalizeProfile(profile, options);
        const key = collection === 'topicBox' ? 'topicBox' : 'impressions';
        return { ...normalized, [key]: normalized[key].filter(item => item.id !== id), updatedAt: now() };
    }

    function extractLearnedMarkers(value) {
        let cleaned = String(value == null ? '' : value);
        const learned = [];
        cleaned = cleaned.replace(/\[\[了解\s*[:：]\s*([\s\S]*?)\]\]/g, (_, text) => {
            const item = cleanText(text, 800);
            if (item && !learned.includes(item)) learned.push(item);
            return '';
        }).replace(/\n{3,}/g, '\n\n').trim();
        return { cleaned, learned };
    }

    function formatContext(value, options = {}) {
        const profile = normalizeProfile(value, options);
        const sections = [];
        if (profile.impressions.length) {
            sections.push(`【关系认识（来自对方自述，未必属实）】\n${profile.impressions.map(item => `- ${item.text}`).join('\n')}`);
        }
        const topics = profile.topicBox.slice(-Math.max(1, Number(options.topicLimit) || CONTEXT_TOPIC_LIMIT));
        if (topics.length) {
            sections.push(`【近期话题盒（仅作背景参考）】\n${topics.map(item => `- ${item.text}`).join('\n')}`);
        }
        return sections.join('\n\n');
    }

    global.RelationshipMemoryCore = Object.freeze({
        VERSION, MAX_IMPRESSIONS, MAX_TOPICS, CONTEXT_TOPIC_LIMIT,
        profileId, normalizeImpression, normalizeTopic, normalizeProfile,
        appendImpression, appendTopic, updateRecord, removeRecord,
        extractLearnedMarkers, formatContext,
    });
})(typeof window !== 'undefined' ? window : globalThis);
