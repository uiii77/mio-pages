(function attachSharedAssetMigration(global) {
    'use strict';

    const MAX_DEFAULT = 5000;
    function api() { return global.SharedAssets; }
    function hasApi() { return !!(api() && typeof api().registerExternal === 'function'); }
    function table(name) { return global.dexieDB?.[name] || null; }
    function list(value) { return Array.isArray(value) ? value : []; }
    function dataSize(value) {
        if (typeof value !== 'string') return 0;
        if (!value.startsWith('data:')) return value.length;
        const body = value.slice(value.indexOf(',') + 1).replace(/\s/g, '');
        return Math.floor(body.length * 0.75);
    }
    function messageMedia(chatType, chatId, message) {
        const candidates = [];
        const add = (type, value, name, mimeType, suffix) => {
            if (typeof value !== 'string' || !value.trim()) return;
            candidates.push({
                type, value, name: name || `${type}-${message.id || 'message'}`, mimeType: mimeType || '',
                externalKey: `${chatType}:${chatId}:${message.id || 'message'}:${suffix}:${value.slice(0, 80)}`,
            });
        };
        add('image', message.novelAiImageUrl, message.fileName || 'message-image', 'image/*', 'image-main');
        add('image', message.imageGenerationMeta?.originalImageUrl, 'generated-image-source', 'image/*', 'image-original');
        list(message._imageVersions).forEach((version, index) => {
            add('image', version?.imageUrl, version?.fileName || `image-version-${index + 1}`, version?.mimeType || 'image/*', `image-version-${index}`);
            add('image', version?.metadata?.originalImageUrl, `image-version-source-${index + 1}`, version?.metadata?.mimeType || 'image/*', `image-version-source-${index}`);
        });
        list(message.parts).forEach((part, index) => {
            if (!part || !['image', 'video', 'file', 'document'].includes(part.type)) return;
            const type = part.type === 'image' ? 'image' : (part.type === 'file' || part.type === 'document' ? 'document' : 'image');
            add(type, part.data || part.url, part.name || part.fileName || `${type}-${index + 1}`, part.mimeType || part.mime || '', `part-${index}`);
        });
        const unique = new Map();
        candidates.forEach(item => unique.set(`${item.type}:${item.value}`, item));
        return [...unique.values()];
    }
    async function register(input, reference, options, counts) {
        if (!hasApi()) return null;
        counts.seen += 1;
        if (options.dryRun) return { id: api().makeId ? api().makeId(input.type, input.contentHash || input.externalKey) : input.externalKey };
        const asset = await api().registerExternal(input);
        const attached = await api().attach(asset.id, reference);
        if (attached.success) counts.attached += 1;
        counts.registered += 1;
        return asset;
    }
    async function migrateRecordedAudio(options, counts) {
        const source = table('recordedAudioAssets');
        if (!source) return;
        const rows = (await source.toArray()).slice(0, options.limit);
        for (const row of rows) {
            const contentHash = await api().digest(row.dataUrl || `${row.id}:${row.size || 0}:${row.createdAt || 0}`);
            const asset = await register({
                id: row.sharedAssetId || undefined, type: 'audio', name: `录音-${row.id}`, mimeType: row.mimeType || 'audio/webm',
                size: Number(row.size) || dataSize(row.dataUrl), externalStore: 'recordedAudioAssets', externalKey: row.id, contentHash,
                metadata: { chatId: row.chatId || '', messageId: row.messageId || '', durationMs: row.durationMs || 0 },
            }, { ownerType: 'recordedAudioAsset', ownerId: row.id, role: 'payload' }, options, counts);
            if (!options.dryRun && asset && row.sharedAssetId !== asset.id) await source.put({ ...row, sharedAssetId: asset.id });
        }
    }
    async function migrateLifeSources(options, counts) {
        const source = table('lifeSources');
        if (!source) return;
        const rows = (await source.toArray()).slice(0, options.limit);
        for (const row of rows) {
            const content = row.rawText || row.content || row.text || `${row.id}:${row.updatedAt || 0}`;
            const contentHash = await api().digest(content);
            await register({
                type: 'document', name: row.title || row.fileName || row.id, mimeType: row.mimeType || 'text/plain',
                size: dataSize(content), externalStore: 'lifeSources', externalKey: row.id, contentHash,
                metadata: { packId: row.packId || '', sourceId: row.id, reviewStatus: row.reviewStatus || '' },
            }, { ownerType: 'lifeSource', ownerId: row.id, role: 'document' }, options, counts);
        }
    }
    async function migrateChatMedia(options, counts) {
        const chats = [
            ...list(global.db?.characters).map(chat => ({ type: 'private', chat })),
            ...list(global.db?.groups).map(chat => ({ type: 'group', chat })),
        ];
        let visited = 0;
        for (const entry of chats) {
            for (const message of list(entry.chat?.history)) {
                if (visited >= options.limit) return;
                visited += 1;
                for (const item of messageMedia(entry.type, entry.chat.id, message)) {
                    const contentHash = await api().digest(item.value);
                    await register({
                        type: item.type, name: item.name, mimeType: item.mimeType, size: dataSize(item.value),
                        externalStore: 'chatMessages', externalKey: item.externalKey, contentHash,
                        metadata: { chatType: entry.type, chatId: entry.chat.id, messageId: message.id || '' },
                    }, { ownerType: 'message', ownerId: `${entry.type}:${entry.chat.id}:${message.id || ''}`, role: item.type }, options, counts);
                }
            }
        }
    }
    async function migrateAnnotations(options, counts) {
        const favorites = list(global.db?.favorites);
        for (const favorite of favorites.slice(0, options.limit)) {
            const note = String(favorite?.note || '').trim();
            if (!note) continue;
            const asset = await (options.dryRun ? Promise.resolve(null) : api().upsert({
                id: `asset:annotation:favorite:${favorite.id}`,
                type: 'annotation', name: '收藏寄语', content: note, storageKind: 'inline-text',
                metadata: { favoriteId: favorite.id || '', messageId: favorite.messageId || '' },
            }));
            counts.seen += 1;
            if (asset) {
                await api().attach(asset.id, { ownerType: 'favorite', ownerId: favorite.id, role: 'annotation' });
                counts.registered += 1; counts.attached += 1;
            }
        }
    }
    async function migrateExisting(options = {}) {
        if (!hasApi()) return { success: false, error: 'Shared asset service is unavailable' };
        const normalized = { limit: Math.max(1, Number(options.limit) || MAX_DEFAULT), dryRun: options.dryRun === true };
        const counts = { seen: 0, registered: 0, attached: 0 };
        await migrateRecordedAudio(normalized, counts);
        await migrateLifeSources(normalized, counts);
        await migrateChatMedia(normalized, counts);
        await migrateAnnotations(normalized, counts);
        return { success: true, dryRun: normalized.dryRun, ...counts };
    }
    global.SharedAssetMigration = Object.freeze({ migrateExisting, messageMedia });
}(globalThis));
