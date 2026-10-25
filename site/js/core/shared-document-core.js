(function attachSharedDocumentCore(global) {
    'use strict';

    const VERSION = 1;
    const FORMATS = Object.freeze(['markdown', 'text']);
    const MAX_TITLE_LENGTH = 160;
    const MAX_BLOCK_LENGTH = 50000;
    const MAX_BLOCKS = 500;
    const MAX_FEEDBACK_LENGTH = 12000;

    function cleanId(value, fallback = '') {
        return String(value ?? fallback).trim().slice(0, 180);
    }

    function cleanTitle(value, fallback = '未命名共享文档') {
        return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) || fallback;
    }

    function cleanBlockText(value) {
        return String(value ?? '').replace(/\u0000/g, '').slice(0, MAX_BLOCK_LENGTH);
    }

    function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
    }

    function normalizeFormat(value) {
        return FORMATS.includes(value) ? value : 'markdown';
    }

    function normalizeBlock(value = {}, defaults = {}) {
        return {
            id: cleanId(value.id || defaults.id),
            documentId: cleanId(value.documentId || defaults.documentId),
            type: 'paragraph',
            text: cleanBlockText(value.text),
            position: integer(value.position, integer(defaults.position), 0, MAX_BLOCKS - 1),
            createdAt: integer(value.createdAt, integer(defaults.createdAt, Date.now()), 0),
            updatedAt: integer(value.updatedAt, integer(defaults.updatedAt, Date.now()), 0),
            schemaVersion: VERSION,
        };
    }

    function normalizeBlocks(values, defaults = {}) {
        const seen = new Set();
        return (Array.isArray(values) ? values : []).slice(0, MAX_BLOCKS).map((value, position) => {
            const block = normalizeBlock(value, { ...defaults, position });
            if (!block.id || seen.has(block.id)) return null;
            seen.add(block.id);
            block.position = position;
            return block;
        }).filter(Boolean);
    }

    function normalizeDocument(value = {}, defaults = {}) {
        const now = Date.now();
        const createdAt = integer(value.createdAt, integer(defaults.createdAt, now), 0);
        return {
            id: cleanId(value.id || defaults.id),
            sessionId: cleanId(value.sessionId || defaults.sessionId),
            characterId: cleanId(value.characterId || defaults.characterId),
            assetId: cleanId(value.assetId || defaults.assetId),
            title: cleanTitle(value.title || defaults.title),
            format: normalizeFormat(value.format || defaults.format),
            revision: integer(value.revision, integer(defaults.revision), 0),
            createdAt,
            updatedAt: Math.max(createdAt, integer(value.updatedAt, createdAt, 0)),
            schemaVersion: VERSION,
        };
    }

    function normalizeRevision(value = {}, defaults = {}) {
        const documentId = cleanId(value.documentId || defaults.documentId);
        const revision = integer(value.revision, integer(defaults.revision), 1);
        const snapshotBlocks = Array.isArray(value.blocks)
            ? [...value.blocks].sort((left, right) => integer(left?.position, 0) - integer(right?.position, 0))
            : [];
        return {
            id: cleanId(value.id || defaults.id || `${documentId}:revision:${revision}`),
            documentId,
            revision,
            title: cleanTitle(value.title || defaults.title),
            format: normalizeFormat(value.format || defaults.format),
            blocks: normalizeBlocks(snapshotBlocks, { documentId }),
            reason: ['create', 'save', 'restore'].includes(value.reason) ? value.reason : 'save',
            restoredFromRevision: value.restoredFromRevision == null ? null : integer(value.restoredFromRevision, 0, 1),
            createdAt: integer(value.createdAt, integer(defaults.createdAt, Date.now()), 0),
            schemaVersion: VERSION,
        };
    }

    function normalizeComment(value = {}, defaults = {}) {
        const now = Date.now();
        const createdAt = integer(value.createdAt, integer(defaults.createdAt, now), 0);
        return {
            id: cleanId(value.id || defaults.id),
            documentId: cleanId(value.documentId || defaults.documentId),
            blockId: cleanId(value.blockId || defaults.blockId),
            authorType: ['user', 'character'].includes(value.authorType) ? value.authorType : 'user',
            authorName: cleanTitle(value.authorName || defaults.authorName, '我').slice(0, 80),
            content: String(value.content ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_FEEDBACK_LENGTH),
            status: ['open', 'resolved'].includes(value.status) ? value.status : 'open',
            createdAt,
            updatedAt: Math.max(createdAt, integer(value.updatedAt, createdAt, 0)),
            resolvedAt: value.resolvedAt == null ? null : integer(value.resolvedAt, 0, 0),
            schemaVersion: VERSION,
        };
    }

    function normalizeSuggestion(value = {}, defaults = {}) {
        const now = Date.now();
        const createdAt = integer(value.createdAt, integer(defaults.createdAt, now), 0);
        return {
            id: cleanId(value.id || defaults.id),
            documentId: cleanId(value.documentId || defaults.documentId),
            blockId: cleanId(value.blockId || defaults.blockId),
            source: ['manual', 'character'].includes(value.source) ? value.source : 'manual',
            authorType: ['user', 'character'].includes(value.authorType) ? value.authorType : 'user',
            authorName: cleanTitle(value.authorName || defaults.authorName, '我').slice(0, 80),
            baseRevision: integer(value.baseRevision, integer(defaults.baseRevision), 0),
            originalText: cleanBlockText(value.originalText),
            replacementText: cleanBlockText(value.replacementText),
            note: String(value.note ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_FEEDBACK_LENGTH),
            status: ['pending', 'accepted', 'rejected', 'conflict'].includes(value.status) ? value.status : 'pending',
            createdAt,
            updatedAt: Math.max(createdAt, integer(value.updatedAt, createdAt, 0)),
            resolvedAt: value.resolvedAt == null ? null : integer(value.resolvedAt, 0, 0),
            resolvedRevision: value.resolvedRevision == null ? null : integer(value.resolvedRevision, 0, 0),
            schemaVersion: VERSION,
        };
    }

    function serializeBlocks(blocks, format = 'markdown') {
        const normalized = normalizeBlocks(blocks);
        const separator = normalizeFormat(format) === 'text' ? '\n\n' : '\n\n';
        return normalized.map(block => block.text).join(separator).replace(/[ \t]+$/gm, '').trimEnd();
    }

    function contentFingerprint(document, blocks) {
        const normalized = normalizeDocument(document);
        const payload = JSON.stringify({
            title: normalized.title,
            format: normalized.format,
            blocks: normalizeBlocks(blocks).map(block => ({ id: block.id, text: block.text, position: block.position })),
        });
        let hash = 2166136261;
        for (let index = 0; index < payload.length; index += 1) {
            hash ^= payload.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `shared_doc_${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function exportFileName(title, format = 'markdown') {
        const base = cleanTitle(title).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 100);
        return `${base || '共享文档'}.${normalizeFormat(format) === 'text' ? 'txt' : 'md'}`;
    }

    function assertExpectedRevision(document, expectedRevision) {
        const actual = normalizeDocument(document).revision;
        const expected = integer(expectedRevision, -1, -1);
        if (expected !== actual) {
            const error = new Error(`文档已有新版本（当前 ${actual}，编辑基于 ${expected}），请重新载入后再保存。`);
            error.code = 'SHARED_DOCUMENT_REVISION_CONFLICT';
            throw error;
        }
        return true;
    }

    function buildCharacterSuggestionMessages(documentValue, blockValue, character = {}) {
        const document = normalizeDocument(documentValue);
        const block = normalizeBlock(blockValue, { documentId: document.id });
        const characterName = cleanTitle(character.name || character.charName || character.realName, '角色').slice(0, 80);
        const persona = String(character.persona || character.description || '').replace(/\u0000/g, '').trim().slice(0, 4000);
        const metadata = JSON.stringify({
            documentTitle: document.title,
            documentFormat: document.format,
            baseRevision: document.revision,
            blockId: block.id,
            characterName,
        });
        return [
            {
                role: 'system',
                content: `你是共享文档中的角色编辑 ${characterName}。只针对用户明确选择的一个段落提出整段替换建议。不得续写整篇文档，不得假设未提供的上下文。严格只输出一个 JSON 对象，格式为 {"replacementText":"替换后的完整段落","note":"简短修改说明"}；不要输出 Markdown 代码围栏或其他文字。${persona ? `\n角色设定：${persona}` : ''}`,
            },
            {
                role: 'user',
                content: `文档元数据：${metadata}\n\n目标段落原文：\n${block.text}`,
            },
        ];
    }

    function parseCharacterSuggestionResponse(value) {
        let text = String(value ?? '').trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let parsed;
        try { parsed = JSON.parse(text); } catch (_) {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start < 0 || end <= start) throw new Error('角色没有返回有效的结构化修改建议。');
            try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { throw new Error('角色没有返回有效的结构化修改建议。'); }
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.replacementText !== 'string') {
            throw new Error('角色修改建议缺少 replacementText 字段。');
        }
        return {
            replacementText: cleanBlockText(parsed.replacementText),
            note: String(parsed.note ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_FEEDBACK_LENGTH),
        };
    }

    global.SharedDocumentCore = Object.freeze({
        VERSION, FORMATS, MAX_BLOCKS, normalizeFormat, normalizeBlock, normalizeBlocks,
        normalizeDocument, normalizeRevision, normalizeComment, normalizeSuggestion,
        serializeBlocks, contentFingerprint,
        exportFileName, assertExpectedRevision, buildCharacterSuggestionMessages, parseCharacterSuggestionResponse,
    });
}(typeof window !== 'undefined' ? window : globalThis));
