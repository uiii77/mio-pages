(function attachTrpgBroadcastCore(global) {
    'use strict';

    const VERSION = 1;
    const MAX_ENTRIES = 100;
    const MAX_TEXT_CHARS = 4000;

    function text(value, fallback = '', max = 160) {
        const result = String(value ?? '').trim();
        return (result || fallback).slice(0, max);
    }

    function number(value, fallback, min, max) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }

    function normalizeSpeakerType(value) {
        return value === 'character' ? 'character' : 'narrator';
    }

    function normalizeVoiceConfig(value) {
        if (!value || typeof value !== 'object') return {};
        const allowed = ['elevenStability', 'elevenSimilarityBoost', 'elevenStyle', 'elevenUseSpeakerBoost', 'elevenVoicePrompt'];
        return Object.fromEntries(allowed
            .filter(key => value[key] !== undefined)
            .map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 1000) : value[key]]));
    }

    function normalizeEntry(value, index = 0) {
        const source = value && typeof value === 'object' ? value : {};
        const speakerType = normalizeSpeakerType(source.speakerType);
        return {
            id: text(source.id, `entry-${index + 1}`, 180),
            speakerType,
            speakerId: text(source.speakerId, '', 180),
            speakerName: text(source.speakerName, speakerType === 'character' ? '角色' : '旁白', 80),
            text: text(source.text, '', MAX_TEXT_CHARS),
            voiceId: text(source.voiceId, '', 180),
            language: text(source.language, 'auto', 24),
            speed: number(source.speed, 1, 0.5, 2),
            voiceConfig: normalizeVoiceConfig(source.voiceConfig),
        };
    }

    function normalizeSession(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const entries = Array.isArray(source.entries)
            ? source.entries.slice(0, MAX_ENTRIES).map((entry, index) => normalizeEntry(entry, index))
            : [];
        const now = Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now();
        return {
            id: text(source.id, '', 180),
            title: text(source.title, options.title || '未命名 TRPG 播报', 120),
            createdAt: now,
            updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
            entries,
        };
    }

    function makePlaybackKey(sessionId, entryId) {
        return `trpg:${text(sessionId, 'session', 100)}:${text(entryId, 'entry', 100)}`;
    }

    function hasPlayableText(entry) {
        return !!normalizeEntry(entry).text;
    }

    global.TRPGBroadcastCore = Object.freeze({
        VERSION,
        MAX_ENTRIES,
        MAX_TEXT_CHARS,
        normalizeEntry,
        normalizeSession,
        normalizeSpeakerType,
        makePlaybackKey,
        hasPlayableText,
    });
})(window);
