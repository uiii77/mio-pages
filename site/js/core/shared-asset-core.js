(function attachSharedAssetCore(global) {
    'use strict';

    const VERSION = 1;
    const TYPES = Object.freeze(['document', 'audio', 'image', 'annotation']);
    const STATES = Object.freeze(['active', 'orphaned']);
    const STORAGE_KINDS = Object.freeze(['inline-text', 'external', 'metadata-only']);
    const MAX = Object.freeze({ id: 180, name: 240, mime: 120, hash: 160, refs: 128, metadata: 32 });

    function clean(value, max = 240) {
        return String(value == null ? '' : value).replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
    }
    function stableHash(value) {
        const text = typeof value === 'string' ? value.normalize('NFKC') : JSON.stringify(value ?? '');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
        return `asset_${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }
    function number(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
        if (value === null || value === '' || value === undefined || !Number.isFinite(Number(value))) return fallback;
        return Math.min(max, Math.max(min, Number(value)));
    }
    function normalizeMetadata(value) {
        if (!value || typeof value !== 'object') return {};
        return Object.fromEntries(Object.entries(value).slice(0, MAX.metadata).map(([key, item]) => [clean(key, 80), typeof item === 'string' ? clean(item, 500) : item]).filter(([key]) => key));
    }
    function normalizeReference(value) {
        const source = value && typeof value === 'object' ? value : {};
        return {
            id: clean(source.id || `${source.ownerType || 'owner'}:${source.ownerId || ''}:${source.role || 'use'}`, MAX.id),
            ownerType: clean(source.ownerType || 'unknown', 80), ownerId: clean(source.ownerId, MAX.id),
            role: clean(source.role || 'use', 80), createdAt: number(source.createdAt, Date.now(), 0),
        };
    }
    function normalize(value) {
        const source = value && typeof value === 'object' ? value : {};
        const type = TYPES.includes(source.type) ? source.type : 'document';
        const storageKind = STORAGE_KINDS.includes(source.storageKind) ? source.storageKind : (source.inlineText ? 'inline-text' : 'metadata-only');
        const references = (Array.isArray(source.references) ? source.references : []).map(normalizeReference).slice(0, MAX.refs);
        const refCount = Math.max(references.length, number(source.refCount, 0, 0, MAX.refs));
        return {
            id: clean(source.id || `asset:${type}:${source.contentHash || stableHash(source.name || Date.now())}`, MAX.id),
            type, name: clean(source.name || source.fileName || 'Unnamed asset', MAX.name),
            mimeType: clean(source.mimeType || source.mime, MAX.mime), size: number(source.size, 0, 0),
            contentHash: clean(source.contentHash || stableHash(source.inlineText || source.externalKey || source.name), MAX.hash),
            storageKind, inlineText: storageKind === 'inline-text' ? clean(source.inlineText, 500000) : '',
            externalStore: clean(source.externalStore, 100), externalKey: clean(source.externalKey, MAX.id),
            references, refCount, state: STATES.includes(source.state) ? source.state : (refCount ? 'active' : 'orphaned'),
            permanent: source.permanent === true, metadata: normalizeMetadata(source.metadata),
            createdAt: number(source.createdAt, Date.now(), 0), updatedAt: number(source.updatedAt, Date.now(), 0),
        };
    }
    function makeId(type, contentHash) { return `asset:${TYPES.includes(type) ? type : 'document'}:${clean(contentHash, MAX.hash) || stableHash(Date.now())}`; }
    function isOrphan(value) { const asset = normalize(value); return asset.refCount === 0 && asset.permanent !== true && asset.state === 'orphaned'; }

    global.SharedAssetCore = Object.freeze({ VERSION, TYPES, STATES, STORAGE_KINDS, clean, stableHash, normalize, normalizeReference, makeId, isOrphan });
}(typeof window !== 'undefined' ? window : globalThis));
