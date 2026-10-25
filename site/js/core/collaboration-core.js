(function attachCollaborationCore(global) {
    'use strict';

    const VERSION = 2;
    const MODES = Object.freeze(['immersive', 'focused']);
    const MODE_LABELS = Object.freeze({ immersive: '沉浸式协同', focused: '中度协同' });
    const MAX_TITLE_LENGTH = 120;
    const MAX_PREVIEW_LENGTH = 240;
    const DEFAULT_CONTEXT_LIMIT = 24;
    const MAX_PERSONA_LENGTH = 4000;
    const MAX_ATTACHMENT_SUMMARIES = 40;
    const MAX_ATTACHMENT_EXCERPT_LENGTH = 320;

    function text(value, fallback = '') {
        return String(value ?? fallback).trim();
    }

    function normalizeMode(value) {
        return MODES.includes(value) ? value : 'focused';
    }

    function clampInteger(value, fallback, min, max) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.max(min, Math.min(max, Math.round(number)));
    }

    function normalizeId(value, fallback = '') {
        return text(value, fallback).slice(0, 180);
    }

    function normalizeTitle(value, characterName = '角色') {
        const title = text(value) || `与 ${text(characterName, '角色')} 协同`;
        return title.slice(0, MAX_TITLE_LENGTH);
    }

    function normalizeAttachment(value) {
        if (!value || typeof value !== 'object') return null;
        const assetId = normalizeId(value.assetId || value.id);
        if (!assetId) return null;
        return {
            assetId,
            name: text(value.name || '共享资料').slice(0, 180),
            mimeType: text(value.mimeType || 'application/octet-stream').slice(0, 120),
            size: Math.max(0, Number(value.size) || 0),
            kind: ['source', 'artifact', 'installable'].includes(value.kind) ? value.kind : 'source',
        };
    }

    function normalizeAttachmentReference(value) {
        if (!value || typeof value !== 'object') return null;
        const assetId = normalizeId(value.assetId || value.id);
        if (!assetId) return null;
        return {
            assetId,
            segmentIndex: clampInteger(value.segmentIndex, 0, 0, 1000000),
            segmentOffset: clampInteger(value.segmentOffset, 0, 0, 1000000),
        };
    }

    function attachmentReferences(value) {
        const source = value && typeof value === 'object' ? value : {};
        const raw = [
            ...(Array.isArray(source.attachmentRefs) ? source.attachmentRefs : []),
            ...(Array.isArray(source.attachmentIds) ? source.attachmentIds.map(assetId => ({ assetId })) : []),
        ];
        const seen = new Set();
        return raw.map(normalizeAttachmentReference).filter(reference => {
            if (!reference || seen.has(reference.assetId)) return false;
            seen.add(reference.assetId);
            return true;
        }).slice(0, 80);
    }

    function normalizeSession(value = {}, defaults = {}) {
        const now = Date.now();
        const createdAt = Number(value.createdAt) || Number(defaults.createdAt) || now;
        const updatedAt = Math.max(createdAt, Number(value.updatedAt) || createdAt);
        const attachmentRefs = attachmentReferences(value);
        return {
            id: normalizeId(value.id || defaults.id),
            characterId: normalizeId(value.characterId || defaults.characterId),
            title: normalizeTitle(value.title || defaults.title, defaults.characterName),
            mode: normalizeMode(value.mode || defaults.mode),
            contextMessageLimit: clampInteger(value.contextMessageLimit, DEFAULT_CONTEXT_LIMIT, 4, 80),
            attachmentIds: attachmentRefs.map(reference => reference.assetId),
            attachmentRefs,
            lastMessagePreview: text(value.lastMessagePreview).slice(0, MAX_PREVIEW_LENGTH),
            createdAt,
            updatedAt,
            archivedAt: Number(value.archivedAt) || null,
            schemaVersion: VERSION,
        };
    }

    function originalContent(value) {
        if (value && typeof value === 'object') {
            return text(value.originalContent || value.originalText || value.content);
        }
        return text(value);
    }

    function normalizeMessage(value = {}, defaults = {}) {
        const role = ['user', 'assistant', 'system'].includes(value.role) ? value.role : 'user';
        const content = originalContent(value.content ?? value.originalContent ?? value.originalText);
        const createdAt = Number(value.createdAt) || Date.now();
        const attachments = (Array.isArray(value.attachments) ? value.attachments : [])
            .map(normalizeAttachment).filter(Boolean);
        return {
            id: normalizeId(value.id || defaults.id),
            sessionId: normalizeId(value.sessionId || defaults.sessionId),
            role,
            content: content.slice(0, 20000),
            attachments,
            createdAt,
            schemaVersion: VERSION,
        };
    }

    function makeContextWindow(messages, options = {}) {
        const limit = clampInteger(options.limit, DEFAULT_CONTEXT_LIMIT, 1, 80);
        return (Array.isArray(messages) ? messages : [])
            .map(item => normalizeMessage(item))
            .filter(item => ['user', 'assistant'].includes(item.role) && item.content)
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-limit)
            .map(item => ({
                role: item.role,
                content: item.content,
                attachments: item.attachments,
                createdAt: item.createdAt,
            }));
    }

    function previewForMessage(message) {
        return originalContent(message?.content).replace(/\s+/g, ' ').slice(0, MAX_PREVIEW_LENGTH);
    }

    function summarizeText(value, maxLength = MAX_ATTACHMENT_EXCERPT_LENGTH) {
        const normalized = text(value).replace(/\s+/g, ' ');
        if (normalized.length <= maxLength) return normalized;
        const sentences = normalized.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
        let summary = '';
        for (const sentence of sentences) {
            if (summary && summary.length + sentence.length + 1 > maxLength) break;
            summary = summary ? `${summary} ${sentence}` : sentence;
        }
        if (!summary) summary = normalized.slice(0, maxLength);
        return `${summary.slice(0, maxLength).trimEnd()}…`;
    }

    function formatAttachmentSummary(value = {}) {
        const name = text(value.name || value.title || '共享资料').slice(0, 180);
        const format = text(value.format || value.mimeType || 'document').slice(0, 80);
        const index = clampInteger(value.segmentIndex, 0, 0, 1000000) + 1;
        const total = clampInteger(value.segmentCount, 0, 0, 1000000);
        const locator = total ? `第 ${index} / ${total} 段` : `第 ${index} 段`;
        const excerpt = summarizeText(value.text);
        return `${name}（${format}，${locator}）${excerpt ? `摘要摘录：${excerpt}` : '暂无可读摘要'}`;
    }

    function characterName(character) {
        return text(character?.name || character?.realName || character?.charName, '角色').slice(0, 120);
    }

    function buildApiMessages(character, session, messages, options = {}) {
        const mode = normalizeMode(session?.mode);
        const modeLabel = MODE_LABELS[mode];
        const persona = text(character?.persona || character?.description || character?.personality).slice(0, MAX_PERSONA_LENGTH);
        const attachmentSummaries = (Array.isArray(options.attachmentSummaries) ? options.attachmentSummaries : [])
            .map(item => text(item).replace(/\s+/g, ' ').slice(0, 240))
            .filter(Boolean)
            .slice(0, MAX_ATTACHMENT_SUMMARIES);
        const system = [
            `你正在与用户进行${modeLabel}。这是独立的协同工作会话，不是普通聊天。`,
            `当前角色：${characterName(character)}。只依据下面的协同会话上下文继续工作。`,
            '请保持角色设定与上下文连续；不要把未提供的资料当作事实。',
            persona ? `角色设定：${persona}` : '',
            session?.title ? `会话名称：${normalizeTitle(session.title)}` : '',
            attachmentSummaries.length ? `用户明确选择的共享资料（仅摘要与章节定位，不含整份正文）：\n${attachmentSummaries.map(item => `- ${text(item).slice(0, 480)}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        return [{ role: 'system', content: system }, ...makeContextWindow(messages, { limit: session?.contextMessageLimit })
            .map(item => ({ role: item.role, content: item.content }))];
    }

    global.CollaborationCore = Object.freeze({
        VERSION,
        MODES,
        MODE_LABELS,
        DEFAULT_CONTEXT_LIMIT,
        normalizeMode,
        normalizeAttachment,
        normalizeAttachmentReference,
        attachmentReferences,
        normalizeSession,
        normalizeMessage,
        makeContextWindow,
        previewForMessage,
        summarizeText,
        formatAttachmentSummary,
        buildApiMessages,
    });
}(typeof window !== 'undefined' ? window : globalThis));
