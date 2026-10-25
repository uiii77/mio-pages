(function attachSharedAssets(global) {
    'use strict';

    const MAX_INLINE_TEXT = 500000;
    function core() { return global.SharedAssetCore; }
    function table(name = 'sharedAssets') { return global.dexieDB && global.dexieDB[name]; }
    function requireTable() { if (!table()) throw new Error('Shared asset table is unavailable'); }
    function clone(value) { if (value == null) return value; try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }

    async function digest(value) {
        let bytes;
        if (typeof value === 'string') bytes = new TextEncoder().encode(value);
        else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else if (typeof Blob !== 'undefined' && value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
        else bytes = new TextEncoder().encode(JSON.stringify(value ?? ''));
        if (global.crypto?.subtle) {
            try {
                const hash = await global.crypto.subtle.digest('SHA-256', bytes);
                return [...new Uint8Array(hash)].map(item => item.toString(16).padStart(2, '0')).join('');
            } catch (_) { /* deterministic fallback below */ }
        }
        let text = '';
        for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
        return core().stableHash(text);
    }
    function contentValue(input) { return input?.content ?? input?.inlineText ?? input?.payload ?? ''; }
    function storageKind(input, content) {
        if (input?.externalStore || input?.externalKey) return 'external';
        if (typeof content === 'string' && content.length <= MAX_INLINE_TEXT) return 'inline-text';
        return 'metadata-only';
    }

    async function upsert(input = {}, options = {}) {
        requireTable();
        const content = contentValue(input);
        const contentHash = String(input.contentHash || await digest(content));
        const type = core().TYPES.includes(input.type) ? input.type : 'document';
        const existing = input.id ? await table().get(String(input.id)) : await table().where('contentHash').equals(contentHash).first();
        const kind = storageKind(input, content);
        const asset = core().normalize({
            ...(existing || {}), ...input, id: input.id || existing?.id || core().makeId(type, contentHash), type, contentHash,
            storageKind: kind, inlineText: kind === 'inline-text' ? String(content).slice(0, MAX_INLINE_TEXT) : '',
            size: Number(input.size) || (typeof content === 'string' ? new TextEncoder().encode(content).byteLength : Number(content?.byteLength || content?.size) || 0),
            state: existing?.state || (input.refCount ? 'active' : 'orphaned'), updatedAt: Date.now(),
        });
        if (options.permanent === true) asset.permanent = true;
        await table().put(asset);
        return clone(asset);
    }
    async function get(id) { requireTable(); const asset = await table().get(String(id || '')); return asset ? core().normalize(asset) : null; }
    async function list(options = {}) {
        requireTable();
        const rows = await table().toArray();
        return rows.map(core().normalize).filter(asset => (!options.type || asset.type === options.type) && (!options.state || asset.state === options.state)).slice(0, Math.max(1, Number(options.limit) || 500));
    }
    async function attach(id, reference) {
        const asset = await get(id);
        if (!asset) return { success: false, error: 'Asset not found' };
        const ref = core().normalizeReference(reference);
        asset.references = asset.references.filter(item => item.id !== ref.id).concat(ref).slice(-128);
        asset.refCount = asset.references.length; asset.state = 'active'; asset.updatedAt = Date.now();
        await table().put(asset); return { success: true, asset: clone(asset) };
    }
    async function detach(id, referenceId) {
        const asset = await get(id);
        if (!asset) return { success: false, error: 'Asset not found' };
        asset.references = asset.references.filter(item => item.id !== String(referenceId || ''));
        asset.refCount = asset.references.length; asset.state = asset.refCount ? 'active' : 'orphaned'; asset.updatedAt = Date.now();
        await table().put(asset); return { success: true, asset: clone(asset) };
    }
    async function detachOwner(ownerType, ownerId, role = '') {
        requireTable();
        const type = String(ownerType || '');
        const owner = String(ownerId || '');
        if (!type || !owner) return { success: false, error: 'Owner is required', updated: 0, assetIds: [] };
        const rows = await table().toArray();
        const changed = [];
        for (const raw of rows) {
            const asset = core().normalize(raw);
            const references = asset.references.filter(reference => !(
                reference.ownerType === type
                && reference.ownerId === owner
                && (!role || reference.role === String(role))
            ));
            if (references.length === asset.references.length) continue;
            asset.references = references;
            asset.refCount = references.length;
            asset.state = references.length ? 'active' : 'orphaned';
            asset.updatedAt = Date.now();
            await table().put(asset);
            changed.push(asset.id);
        }
        return { success: true, updated: changed.length, assetIds: changed };
    }
    async function findExternal(externalStore, externalKey) {
        requireTable();
        const store = String(externalStore || '');
        const key = String(externalKey || '');
        if (!store || !key) return null;
        const rows = await table().toArray();
        const asset = rows.find(item => String(item.externalStore || '') === store && String(item.externalKey || '') === key);
        return asset ? core().normalize(asset) : null;
    }
    async function setPermanent(id, permanent) {
        const asset = await get(id);
        if (!asset) return false;
        asset.permanent = permanent === true;
        asset.updatedAt = Date.now();
        await table().put(asset);
        return true;
    }
    async function registerExternal(input = {}) {
        return upsert({ ...input, storageKind: 'external', content: '', externalStore: input.externalStore, externalKey: input.externalKey, contentHash: input.contentHash || core().stableHash(`${input.externalStore}:${input.externalKey}`) });
    }
    async function listOrphans(options = {}) { return (await list({ limit: options.limit || 500 })).filter(core().isOrphan); }
    async function cleanupOrphans(options = {}) {
        requireTable(); const orphans = await listOrphans(options);
        if (options.dryRun === true) return { success: true, removed: 0, candidates: orphans };
        for (const asset of orphans) await table().delete(asset.id);
        return { success: true, removed: orphans.length, candidates: orphans };
    }
    async function exportManifest(options = {}) {
        const assets = await list({ limit: options.limit || 5000 });
        return { format: 'mio-shared-assets', formatRevision: 1, exportedAt: Date.now(), assets: assets.map(asset => options.includeInlineText === false ? ({ ...asset, inlineText: '' }) : asset) };
    }
    global.SharedAssets = Object.freeze({ VERSION: 1, digest, upsert, get, list, attach, detach, detachOwner, findExternal, setPermanent, registerExternal, listOrphans, cleanupOrphans, exportManifest });
}(typeof window !== 'undefined' ? window : globalThis));
