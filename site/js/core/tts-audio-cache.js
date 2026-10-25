// Persistent storage for reproducible TTS assets. Explicitly retained entries are
// never removed by quota pruning; API credentials are never written or hashed.
(function (global) {
    'use strict';

    let writeQueue = Promise.resolve();

    function table() {
        return global.dexieDB && global.dexieDB.ttsAudioCache;
    }

    function stableStringify(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }

    function hash53(text, seed = 0) {
        let h1 = 0xdeadbeef ^ seed;
        let h2 = 0x41c6ce57 ^ seed;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    function enqueue(task) {
        const run = writeQueue.then(task, task);
        writeQueue = run.catch(() => {});
        return run;
    }

    async function detachSharedRecord(record) {
        if (!record || !global.SharedAssets) return;
        try {
            if (record.sharedAssetId) await global.SharedAssets.detach(record.sharedAssetId, `ttsCache:${record.key}:payload`);
            else await global.SharedAssets.detachOwner?.('ttsCache', record.key, 'payload');
        } catch (error) {
            console.warn('[TTS Cache] shared asset detach skipped:', error);
        }
    }

    async function get(key) {
        const store = table();
        if (!store || !key) return null;
        try {
            const record = await store.get(key);
            if (!record || !(record.blob instanceof Blob)) return null;
            record.lastUsedAt = Date.now();
            void enqueue(() => store.put(record));
            return record;
        } catch (error) {
            console.warn('[TTS Cache] 读取失败:', error);
            return null;
        }
    }

    async function prune(maxBytes) {
        const store = table();
        const limit = Math.max(0, Number(maxBytes) || 0);
        if (!store || !limit) return 0;
        const records = await store.toArray();
        const removable = records.filter(item => Number(item.permanent) !== 1)
            .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
        let total = removable.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        const keys = [];
        for (const item of removable) {
            if (total <= limit) break;
            total -= Number(item.size) || 0;
            keys.push(item.key);
        }
        if (keys.length) {
            for (const record of removable.filter(item => keys.includes(item.key))) await detachSharedRecord(record);
            await store.bulkDelete(keys);
        }
        return keys.length;
    }

    async function put(key, blob, metadata = {}, options = {}) {
        const store = table();
        if (!store || !key || !(blob instanceof Blob)) return false;
        return enqueue(async () => {
            try {
                const existing = await store.get(key);
                const now = Date.now();
                const record = {
                    key,
                    blob,
                    mimeType: blob.type || existing?.mimeType || 'audio/mpeg',
                    size: blob.size,
                    createdAt: existing?.createdAt || now,
                    lastUsedAt: now,
                    permanent: options.permanent || Number(existing?.permanent) === 1 ? 1 : 0,
                    characterId: metadata.characterId || existing?.characterId || '',
                    messageId: metadata.messageId || existing?.messageId || '',
                    sharedAssetId: existing?.sharedAssetId || ''
                };
                await store.put(record);
                if (global.SharedAssets?.registerExternal) {
                    try {
                        const shared = await global.SharedAssets.registerExternal({
                            type: 'audio', name: metadata.name || `TTS-${key}`, mimeType: blob.type || existing?.mimeType || 'audio/mpeg',
                            size: blob.size, externalStore: 'ttsAudioCache', externalKey: key,
                            contentHash: await global.SharedAssets.digest(blob),
                            permanent: options.permanent === true,
                            metadata: { characterId: metadata.characterId || '', messageId: metadata.messageId || '' },
                        });
                        await global.SharedAssets.attach(shared.id, { ownerType: 'ttsCache', ownerId: key, role: 'payload' });
                        await global.SharedAssets.setPermanent?.(shared.id, Number(record.permanent) === 1);
                        if (record.sharedAssetId !== shared.id) {
                            record.sharedAssetId = shared.id;
                            await store.put(record);
                        }
                    } catch (assetError) {
                        console.warn('[TTS Cache] shared asset registration skipped:', assetError);
                    }
                }
                if (options.maxBytes) await prune(options.maxBytes);
                return true;
            } catch (error) {
                console.warn('[TTS Cache] 写入失败:', error);
                return false;
            }
        });
    }

    async function setPermanent(key, permanent, metadata = {}) {
        const store = table();
        if (!store || !key) return false;
        return enqueue(async () => {
            const record = await store.get(key);
            if (!record) return false;
            record.permanent = permanent ? 1 : 0;
            record.characterId = metadata.characterId || record.characterId || '';
            record.messageId = metadata.messageId || record.messageId || '';
            record.lastUsedAt = Date.now();
            await store.put(record);
            try {
                const sharedId = record.sharedAssetId || (await global.SharedAssets?.findExternal?.('ttsAudioCache', key))?.id;
                if (sharedId) await global.SharedAssets.setPermanent?.(sharedId, permanent === true);
            } catch (error) {
                console.warn('[TTS Cache] shared asset retention update skipped:', error);
            }
            return true;
        });
    }

    async function clearReproducible() {
        const store = table();
        if (!store) return 0;
        return enqueue(async () => {
            const records = await store.toArray();
            const keys = records.filter(item => Number(item.permanent) !== 1).map(item => item.key);
            if (keys.length) {
                for (const record of records.filter(item => keys.includes(item.key))) await detachSharedRecord(record);
                await store.bulkDelete(keys);
            }
            return keys.length;
        });
    }

    async function stats() {
        const store = table();
        if (!store) return { count: 0, bytes: 0, permanentCount: 0, permanentBytes: 0 };
        const records = await store.toArray();
        return records.reduce((result, item) => {
            const size = Number(item.size) || 0;
            result.count++;
            result.bytes += size;
            if (Number(item.permanent) === 1) {
                result.permanentCount++;
                result.permanentBytes += size;
            }
            return result;
        }, { count: 0, bytes: 0, permanentCount: 0, permanentBytes: 0 });
    }

    global.TTSAudioCache = {
        makeKey: descriptor => `tts_${hash53(stableStringify(descriptor))}`,
        get,
        put,
        prune,
        setPermanent,
        clearReproducible,
        stats,
        stableStringify
    };
})(globalThis);
