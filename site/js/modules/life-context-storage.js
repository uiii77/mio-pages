(function attachLifeContextStorage(global) {
    'use strict';

    const FORMAT = 'miolife';
    const FORMAT_REVISION = 1;
    const MAX_PACKS = 200;
    const MAX_SOURCES = 2000;
    const MAX_CHUNKS = 20000;
    const MAX_RAW_SOURCE_CHARS = 500000;

    function core() {
        return global.LifeContextCore;
    }

    function table(name) {
        return global.dexieDB && global.dexieDB[name] ? global.dexieDB[name] : null;
    }

    function requireTables() {
        const names = ['lifePacks', 'lifeSources', 'lifeChunks', 'lifeEvents'];
        const missing = names.filter(name => !table(name));
        if (missing.length) throw new Error(`生活脉络数据表不可用: ${missing.join(', ')}`);
    }

    function parsePayload(input) {
        if (typeof input === 'string') {
            try { return JSON.parse(input); } catch (_) { throw new Error('生活资料包必须是有效 JSON'); }
        }
        if (!input || typeof input !== 'object') throw new Error('生活资料包格式无效');
        return input;
    }

    function normalizePackPayload(input) {
        const value = parsePayload(input);
        const sourceManifest = value.manifest || value;
        const manifest = core().normalizeLifePackManifest(sourceManifest);
        const validation = core().validateLifePackManifest(sourceManifest);
        if (!validation.valid) return { manifest, sources: [], chunks: [], validation };

        const sources = (Array.isArray(value.sources) ? value.sources : manifest.sources)
            .map(item => core().normalizeSource(item, { packId: manifest.id }))
            .map(item => ({ ...item, packId: manifest.id }))
            .slice(0, MAX_SOURCES);
        const sourceIds = new Set(sources.map(item => item.id));
        const explicitChunks = (Array.isArray(value.chunks) ? value.chunks : [])
            .map(item => core().normalizeLifeChunk(item, { packId: manifest.id }))
            .map(item => ({ ...item, packId: manifest.id }))
            .filter(item => !item.sourceId || sourceIds.has(item.sourceId))
            .slice(0, MAX_CHUNKS);
        const explicitSourceIds = new Set(explicitChunks.map(chunk => chunk.sourceId).filter(Boolean));
        const generatedChunks = sources
            .filter(source => source.rawText && !explicitSourceIds.has(source.id))
            .flatMap(source => core().chunkLifeSourceText(source, { packId: manifest.id }))
            .slice(0, MAX_CHUNKS);
        const chunks = [...explicitChunks, ...generatedChunks].slice(0, MAX_CHUNKS);
        return { manifest, sources, chunks, validation: { ...validation, manifest } };
    }

    function persistedManifest(manifest) {
        return { ...manifest, sources: [] };
    }

    async function savePack(input, options = {}) {
        requireTables();
        const payload = normalizePackPayload(input);
        if (!payload.validation.valid) return { success: false, validation: payload.validation };
        const now = Date.now();
        const pack = { ...persistedManifest(payload.manifest), updatedAt: payload.manifest.updatedAt || now, createdAt: payload.manifest.createdAt || now };
        const replaceExisting = options.replaceExisting === true;
        await global.dexieDB.transaction('rw', [table('lifePacks'), table('lifeSources'), table('lifeChunks')], async () => {
            if (replaceExisting) {
                await table('lifeSources').where('packId').equals(pack.id).delete();
                await table('lifeChunks').where('packId').equals(pack.id).delete();
            }
            await table('lifePacks').put(pack);
            if (payload.sources.length) await table('lifeSources').bulkPut(payload.sources);
            if (payload.chunks.length) await table('lifeChunks').bulkPut(payload.chunks);
        });
        return { success: true, pack, sourceCount: payload.sources.length, chunkCount: payload.chunks.length, warnings: payload.validation.warnings };
    }

    async function getPack(packId) {
        requireTables();
        const id = String(packId || '');
        const pack = await table('lifePacks').get(id);
        if (!pack) return null;
        const [sources, chunks] = await Promise.all([
            table('lifeSources').where('packId').equals(id).toArray(),
            table('lifeChunks').where('packId').equals(id).toArray(),
        ]);
        return { manifest: { ...pack, sources }, sources, chunks };
    }

    async function listPacks() {
        requireTables();
        return table('lifePacks').orderBy('updatedAt').reverse().limit(MAX_PACKS).toArray();
    }

    async function listChunks(options = {}) {
        requireTables();
        const rows = await table('lifeChunks').toArray();
        const packIds = Array.isArray(options.packIds) ? new Set(options.packIds.map(String)) : null;
        const sourceIds = Array.isArray(options.sourceIds) ? new Set(options.sourceIds.map(String)) : null;
        return rows.filter(chunk => (!packIds || packIds.has(String(chunk.packId))) && (!sourceIds || sourceIds.has(String(chunk.sourceId || '')))
            && (!options.reviewStatus || chunk.reviewStatus === options.reviewStatus))
            .slice(0, Math.min(MAX_CHUNKS, Math.max(1, Number(options.limit) || MAX_CHUNKS)));
    }

    async function listSources(options = {}) {
        requireTables();
        const rows = await table('lifeSources').toArray();
        const packIds = Array.isArray(options.packIds) ? new Set(options.packIds.map(String)) : null;
        return rows.filter(source => (!packIds || packIds.has(String(source.packId))) && (!options.reviewStatus || source.reviewStatus === options.reviewStatus))
            .slice(0, Math.min(MAX_SOURCES, Math.max(1, Number(options.limit) || MAX_SOURCES)));
    }

    async function listCards(options = {}) {
        requireTables();
        const packIds = Array.isArray(options.packIds) ? new Set(options.packIds.map(String)) : null;
        const packs = await table('lifePacks').toArray();
        return packs.flatMap(pack => (Array.isArray(pack.cards) ? pack.cards : [])
            .map(card => core().normalizePackCards([card], pack.id)[0])
            .filter(card => card && (!packIds || packIds.has(String(card.packId || pack.id))) && (!options.reviewStatus || card.reviewStatus === options.reviewStatus))
            .map(card => ({ ...card, packId: card.packId || pack.id })))
            .slice(0, Math.min(64 * MAX_PACKS, Math.max(1, Number(options.limit) || 64 * MAX_PACKS)));
    }

    async function updateSource(value) {
        requireTables();
        const source = core().normalizeSource(value);
        if (!source.id || !source.packId || (!source.title && !source.rawText)) return { success: false, error: '资料来源缺少 id、资料包或标题' };
        source.updatedAt = Date.now();
        await table('lifeSources').put(source);
        return { success: true, source };
    }

    async function updateChunk(value) {
        requireTables();
        const chunk = core().normalizeLifeChunk(value);
        if (!chunk.id || !chunk.packId || !chunk.text) return { success: false, error: '资料片段缺少 id、资料包或正文' };
        chunk.updatedAt = Date.now();
        chunk.revision = Math.max(0, Number(chunk.revision) || 0) + 1;
        await table('lifeChunks').put(chunk);
        return { success: true, chunk };
    }

    async function generateCards(packId, options = {}) {
        requireTables();
        const pack = await table('lifePacks').get(String(packId || ''));
        if (!pack) return { success: false, error: '资料包不存在' };
        const chunks = await table('lifeChunks').where('packId').equals(pack.id).toArray();
        const generated = core().extractLifeCards(chunks, options);
        const existing = Array.isArray(pack.cards) ? pack.cards.map(card => core().normalizePackCards([card], pack.id)[0]).filter(Boolean) : [];
        const existingKeys = new Set(existing.map(card => card.contentHash || core().stableHash?.(card.text || '') || card.id));
        const merged = [...existing];
        generated.forEach(card => {
            const key = core().stableHash ? core().stableHash(card.text) : card.id;
            if (!existingKeys.has(key) && !existing.some(item => item.id === card.id)) merged.push(card);
        });
        pack.cards = merged.slice(0, 64);
        pack.cardsGeneratedAt = Date.now();
        pack.cardsRevision = Math.max(0, Number(pack.cardsRevision) || 0) + 1;
        await table('lifePacks').put(pack);
        return { success: true, pack, generatedCount: generated.length, cards: pack.cards };
    }

    async function updateCard(value) {
        requireTables();
        const card = core().normalizePackCards([value], value?.packId)[0];
        if (!card?.id || !card.packId || !card.text) return { success: false, error: '资料卡缺少 id、资料包或正文' };
        const pack = await table('lifePacks').get(card.packId);
        if (!pack) return { success: false, error: '资料包不存在' };
        const cards = Array.isArray(pack.cards) ? pack.cards : [];
        const index = cards.findIndex(item => String(item.id) === card.id);
        if (index < 0) return { success: false, error: '资料卡不存在' };
        card.createdAt = cards[index].createdAt || Date.now();
        card.updatedAt = Date.now();
        card.revision = Math.max(0, Number(cards[index].revision) || 0) + 1;
        cards[index] = card;
        pack.cards = cards.slice(0, 64);
        await table('lifePacks').put(pack);
        return { success: true, card };
    }

    async function deleteCard(packId, cardId) {
        requireTables();
        const pack = await table('lifePacks').get(String(packId || ''));
        if (!pack) return false;
        pack.cards = (Array.isArray(pack.cards) ? pack.cards : []).filter(card => String(card.id) !== String(cardId || ''));
        await table('lifePacks').put(pack);
        return true;
    }

    async function saveExpansionCandidates(packId, candidates, metadata = {}) {
        requireTables();
        const pack = await table('lifePacks').get(String(packId || ''));
        if (!pack) return { success: false, error: '资料包不存在' };
        const existing = Array.isArray(pack.cards) ? pack.cards : [];
        const keys = new Set(existing.map(card => core().stableHash(card.text || card.title || card.id)));
        const added = [];
        (Array.isArray(candidates) ? candidates : []).slice(0, 24).forEach((candidate, index) => {
            const normalized = core().normalizePackCards([{
                ...candidate,
                id: candidate.id || `${pack.id}:expansion:${Date.now()}:${index}`,
                packId: pack.id,
                generatedBy: 'life-expansion-api',
                reviewStatus: 'unreviewed',
                needsSource: candidate.needsSource !== false && !candidate.citation && !candidate.sourceUrl,
                createdAt: Date.now(), updatedAt: Date.now(), revision: 0,
            }], pack.id)[0];
            if (!normalized?.text) return;
            const key = core().stableHash(normalized.text);
            if (keys.has(key)) return;
            keys.add(key);
            added.push(normalized);
        });
        pack.cards = [...existing, ...added].slice(0, 64);
        pack.lifeExpansionState = {
            ...(pack.lifeExpansionState || {}),
            lastRequestedAt: Number(metadata.requestedAt) || Date.now(),
            lastGapKey: String(metadata.gapKey || ''),
            lastCandidateCount: added.length,
            requestCount: Math.max(0, Number(pack.lifeExpansionState?.requestCount) || 0) + 1,
        };
        await table('lifePacks').put(pack);
        return { success: true, pack, added };
    }

    async function applyCardVerification(packId, results, metadata = {}) {
        requireTables();
        const id = String(packId || '');
        const pack = await table('lifePacks').get(id);
        if (!pack) return { success: false, error: '璧勬枡鍖呬笉瀛樺湪' };
        const byId = new Map((Array.isArray(results) ? results : []).map(item => [String(item?.cardId || item?.id || ''), item]));
        const updated = [];
        const cards = (Array.isArray(pack.cards) ? pack.cards : []).map(raw => {
            const card = core().normalizePackCards([raw], id)[0];
            const result = byId.get(String(card?.id || ''));
            if (!card || !result) return raw;
            const status = core().VERIFICATION_STATUSES.includes(result.verificationStatus) ? result.verificationStatus : 'unverified';
            const next = core().normalizePackCards([{
                ...card,
                citation: result.citation || card.citation,
                sourceUrl: result.sourceUrl || card.sourceUrl,
                verificationStatus: status,
                verificationProvider: result.provider || metadata.provider || card.verificationProvider,
                verificationCheckedAt: Number(result.checkedAt || metadata.checkedAt) || Date.now(),
                verificationNotes: result.notes || result.reason || card.verificationNotes,
                verificationQuote: result.quote || card.verificationQuote,
                // Verification never silently promotes or rejects a card.
                reviewStatus: card.reviewStatus,
                updatedAt: Date.now(), revision: Number(card.revision || 0) + 1,
            }], id)[0];
            updated.push(next);
            return next;
        });
        pack.cards = cards.slice(0, 64);
        pack.lifeVerificationState = {
            ...(pack.lifeVerificationState || {}),
            lastRunAt: Number(metadata.checkedAt) || Date.now(),
            lastProvider: String(metadata.provider || ''),
            lastCount: updated.length,
            runCount: Math.max(0, Number(pack.lifeVerificationState?.runCount) || 0) + 1,
        };
        await table('lifePacks').put(pack);
        return { success: true, pack, updated };
    }

    async function updateSourceSubscriptions(packId, subscriptions, policy) {
        requireTables();
        const id = String(packId || '');
        const pack = await table('lifePacks').get(id);
        if (!pack) return { success: false, error: '资料包不存在' };
        const manifest = core().normalizeLifePackManifest({ ...pack, sourceSubscriptions: subscriptions, sourcePolicy: policy || pack.sourcePolicy });
        pack.sourceSubscriptions = manifest.sourceSubscriptions;
        pack.sourcePolicy = manifest.sourcePolicy;
        pack.updatedAt = Date.now();
        await table('lifePacks').put(pack);
        return { success: true, pack, subscriptions: pack.sourceSubscriptions, policy: pack.sourcePolicy };
    }

    async function saveNetworkRefresh(packId, payload, metadata = {}) {
        requireTables();
        const id = String(packId || '');
        const pack = await table('lifePacks').get(id);
        if (!pack) return { success: false, error: '资料包不存在' };
        const now = Number(metadata.checkedAt) || Date.now();
        const incomingSources = Array.isArray(payload?.sources) ? payload.sources : [];
        const incomingCards = Array.isArray(payload?.cards) ? payload.cards : [];
        const savedSources = [];
        const savedChunks = [];
        for (const item of incomingSources.slice(0, 24)) {
            const source = core().normalizeSource({ ...item, packId: id, kind: item.kind || 'web', reviewStatus: 'unreviewed', sourceState: 'active', subscriptionId: item.subscriptionId || metadata.subscriptionId, updatedAt: now });
            if (!source.id || !source.uri && !source.citation && !source.rawText) continue;
            const existing = await table('lifeSources').get(source.id);
            if (existing?.sourceState === 'withdrawn' && metadata.reactivate !== true) continue;
            savedSources.push({ ...source, reviewStatus: existing?.reviewStatus || 'unreviewed', sourceState: existing?.sourceState || 'active' });
            if (source.rawText) savedChunks.push(...core().chunkLifeSourceText(source, { packId: id, reviewStatus: 'unreviewed' }));
        }
        if (savedSources.length) await table('lifeSources').bulkPut(savedSources);
        if (savedChunks.length) await table('lifeChunks').bulkPut(savedChunks.slice(0, 240));
        const existingCards = Array.isArray(pack.cards) ? pack.cards : [];
        const cardKeys = new Set(existingCards.map(card => core().stableHash(card.text || card.title || card.id)));
        const addedCards = [];
        incomingCards.slice(0, 24).forEach((item, index) => {
            const card = core().normalizePackCards([{
                ...item,
                id: item.id || `${id}:network:${now}:${index}`,
                packId: id,
                generatedBy: 'life-source-subscription',
                reviewStatus: 'unreviewed',
                sourceState: 'active',
                sourceSubscriptionId: item.sourceSubscriptionId || metadata.subscriptionId,
                createdAt: now, updatedAt: now, revision: 0,
            }], id)[0];
            if (!card?.text) return;
            const key = core().stableHash(card.text);
            if (cardKeys.has(key)) return;
            cardKeys.add(key);
            addedCards.push(card);
        });
        pack.cards = [...existingCards, ...addedCards].slice(0, 64);
        const subscriptionUpdates = new Map((Array.isArray(metadata.subscriptions) ? metadata.subscriptions : []).map(item => [String(item.id), item]));
        pack.sourceSubscriptions = (Array.isArray(pack.sourceSubscriptions) ? pack.sourceSubscriptions : []).map(item => {
            const update = subscriptionUpdates.get(String(item.id));
            return update ? { ...item, ...update, updatedAt: now } : item;
        });
        pack.lifeSourceSubscriptionState = {
            ...(pack.lifeSourceSubscriptionState || {}), lastRunAt: now,
            lastStatus: String(metadata.status || 'success'), lastError: String(metadata.error || ''),
            addedSources: savedSources.length, addedChunks: savedChunks.length, addedCards: addedCards.length,
            runCount: Math.max(0, Number(pack.lifeSourceSubscriptionState?.runCount) || 0) + 1,
        };
        pack.updatedAt = now;
        await table('lifePacks').put(pack);
        return { success: true, pack, addedSources: savedSources, addedChunks: savedChunks, addedCards };
    }

    async function withdrawSource(packId, sourceId, reason = '') {
        requireTables();
        const id = String(packId || '');
        const sourceKey = String(sourceId || '');
        const pack = await table('lifePacks').get(id);
        if (!pack || !sourceKey) return { success: false, error: '来源不存在' };
        const now = Date.now();
        const source = await table('lifeSources').get(sourceKey);
        if (source) await table('lifeSources').put({ ...source, sourceState: 'withdrawn', sourceWithdrawnAt: now, sourceWithdrawReason: String(reason || '用户撤回') });
        const chunks = await table('lifeChunks').where('packId').equals(id).toArray();
        const affectedChunks = chunks.filter(chunk => String(chunk.sourceId || '') === sourceKey).map(chunk => ({ ...chunk, sourceState: 'withdrawn', sourceWithdrawnAt: now, sourceWithdrawReason: String(reason || '用户撤回'), updatedAt: now }));
        if (affectedChunks.length) await table('lifeChunks').bulkPut(affectedChunks);
        pack.cards = (Array.isArray(pack.cards) ? pack.cards : []).map(raw => {
            const card = core().normalizePackCards([raw], id)[0];
            if (!card || !card.sourceIds.includes(sourceKey)) return raw;
            return { ...card, sourceState: 'withdrawn', sourceWithdrawnAt: now, sourceWithdrawReason: String(reason || '用户撤回'), updatedAt: now, revision: Number(card.revision || 0) + 1 };
        });
        await table('lifePacks').put(pack);
        try { await global.SharedAssets?.detachOwner?.('lifeSource', sourceKey, 'document'); }
        catch (error) { console.warn('[LifeContext] shared source detach skipped:', error); }
        return { success: true, sourceId: sourceKey, chunkCount: affectedChunks.length };
    }

    async function deletePack(packId) {
        requireTables();
        const id = String(packId || '');
        const sources = await table('lifeSources').where('packId').equals(id).toArray();
        await global.dexieDB.transaction('rw', [table('lifePacks'), table('lifeSources'), table('lifeChunks')], async () => {
            await table('lifeSources').where('packId').equals(id).delete();
            await table('lifeChunks').where('packId').equals(id).delete();
            await table('lifePacks').delete(id);
        });
        for (const source of sources) {
            try { await global.SharedAssets?.detachOwner?.('lifeSource', source.id, 'document'); }
            catch (error) { console.warn('[LifeContext] shared source detach skipped:', error); }
        }
        return true;
    }

    async function exportPack(packId) {
        const pack = await getPack(packId);
        if (!pack) return null;
        return { format: FORMAT, formatRevision: FORMAT_REVISION, exportedAt: Date.now(), manifest: pack.manifest, sources: pack.sources, chunks: pack.chunks };
    }

    function validatePackImport(input) {
        try {
            const value = parsePayload(input);
            if (value.format && value.format !== FORMAT) return { valid: false, errors: ['unsupported-format'], warnings: [] };
            if (value.formatRevision && Number(value.formatRevision) > FORMAT_REVISION) return { valid: false, errors: ['unsupported-format-revision'], warnings: [] };
            const payload = normalizePackPayload(value);
            const errors = [...payload.validation.errors];
            const rawSources = Array.isArray(value.sources) ? value.sources : (Array.isArray(value.manifest?.sources) ? value.manifest.sources : []);
            const rawChunks = Array.isArray(value.chunks) ? value.chunks : [];
            if (rawSources.length > MAX_SOURCES) errors.push('too-many-sources');
            if (rawChunks.length > MAX_CHUNKS) errors.push('too-many-chunks');
            if (rawSources.some(source => String(source?.rawText || source?.content || source?.text || '').length > MAX_RAW_SOURCE_CHARS)) errors.push('source-too-large');
            if (/<\/?script\b/i.test(JSON.stringify(value))) errors.push('scripts-not-allowed');
            return { valid: errors.length === 0, errors, warnings: payload.validation.warnings, manifest: payload.manifest, sourceCount: payload.sources.length, chunkCount: payload.chunks.length, generatedChunkCount: Math.max(0, payload.chunks.length - rawChunks.length) };
        } catch (error) {
            return { valid: false, errors: [error.message], warnings: [] };
        }
    }

    async function importPack(input, options = {}) {
        const validation = validatePackImport(input);
        if (!validation.valid) return { success: false, validation };
        const value = parsePayload(input);
        return { ...(await savePack(value, { replaceExisting: options.mode === 'replace' })), validation };
    }

    async function saveLifeEvent(value) {
        requireTables();
        const event = core().normalizeLifeEvent(value);
        if (!event.id || !event.characterId || !event.localDate) return { success: false, error: '生活事件需要 id、characterId 和 localDate' };
        await table('lifeEvents').put(event);
        return { success: true, event };
    }

    async function listLifeEvents(options = {}) {
        requireTables();
        const rows = await table('lifeEvents').toArray();
        return rows.map(item => core().normalizeLifeEvent(item)).filter(event => {
            if (options.characterId && event.characterId !== String(options.characterId)) return false;
            if (options.localDate && event.localDate !== String(options.localDate)) return false;
            if (options.status && event.status !== options.status) return false;
            return true;
        }).sort((left, right) => `${right.localDate}:${right.startMinute}`.localeCompare(`${left.localDate}:${left.startMinute}`));
    }

    async function deleteLifeEvent(id) {
        requireTables();
        await table('lifeEvents').delete(String(id || ''));
        return true;
    }

    global.LifeContextStorage = Object.freeze({
        FORMAT,
        FORMAT_REVISION,
        normalizePackPayload,
        validatePackImport,
        savePack,
        getPack,
        listPacks,
        listSources,
        listChunks,
        listCards,
        updateSource,
        updateChunk,
        generateCards,
        updateCard,
        deleteCard,
        saveExpansionCandidates,
        applyCardVerification,
        updateSourceSubscriptions,
        saveNetworkRefresh,
        withdrawSource,
        deletePack,
        exportPack,
        importPack,
        saveLifeEvent,
        listLifeEvents,
        deleteLifeEvent,
    });
}(window));
