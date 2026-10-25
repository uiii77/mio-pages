(function attachSharedDocuments(global) {
    'use strict';

    const state = { sessionId: '', characterId: '', documentId: '', expectedRevision: 0, busy: false, setupComplete: false, comments: [], suggestions: [] };
    const core = () => global.SharedDocumentCore;
    const table = name => global.dexieDB?.[name];
    const byId = id => global.document?.getElementById(id);
    const notify = message => { if (typeof global.showToast === 'function') global.showToast(message); };

    function makeId(prefix) {
        const random = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        return `${prefix}:${random}`.slice(0, 180);
    }

    function requireTables() {
        const names = ['sharedDocuments', 'sharedDocumentBlocks', 'sharedDocumentRevisions', 'sharedDocumentComments', 'sharedDocumentSuggestions'];
        if (!names.every(name => table(name))) throw new Error('共享文档数据表尚未就绪，请刷新 Mio 后重试。');
    }

    async function runTransaction(callback) {
        requireTables();
        if (typeof global.dexieDB?.transaction === 'function') {
            return global.dexieDB.transaction('rw', table('sharedDocuments'), table('sharedDocumentBlocks'), table('sharedDocumentRevisions'), table('sharedDocumentComments'), table('sharedDocumentSuggestions'), callback);
        }
        return callback();
    }

    async function listDocuments(sessionId = state.sessionId) {
        if (!table('sharedDocuments') || !sessionId) return [];
        const rows = await table('sharedDocuments').where('sessionId').equals(String(sessionId)).toArray();
        return rows.map(row => core().normalizeDocument(row)).sort((left, right) => right.updatedAt - left.updatedAt);
    }

    async function getDocument(documentId = state.documentId) {
        if (!table('sharedDocuments') || !documentId) return null;
        const row = await table('sharedDocuments').get(String(documentId));
        return row ? core().normalizeDocument(row) : null;
    }

    async function listBlocks(documentId = state.documentId) {
        if (!table('sharedDocumentBlocks') || !documentId) return [];
        const rows = await table('sharedDocumentBlocks').where('documentId').equals(String(documentId)).toArray();
        rows.sort((left, right) => Number(left.position) - Number(right.position));
        return core().normalizeBlocks(rows, { documentId }).sort((left, right) => left.position - right.position);
    }

    async function listRevisions(documentId = state.documentId) {
        if (!table('sharedDocumentRevisions') || !documentId) return [];
        const rows = await table('sharedDocumentRevisions').where('documentId').equals(String(documentId)).toArray();
        return rows.map(row => core().normalizeRevision(row)).sort((left, right) => right.revision - left.revision);
    }

    async function listComments(documentId = state.documentId) {
        if (!table('sharedDocumentComments') || !documentId) return [];
        const rows = await table('sharedDocumentComments').where('documentId').equals(String(documentId)).toArray();
        return rows.map(row => core().normalizeComment(row)).sort((left, right) => left.createdAt - right.createdAt);
    }

    async function listSuggestions(documentId = state.documentId) {
        if (!table('sharedDocumentSuggestions') || !documentId) return [];
        const rows = await table('sharedDocumentSuggestions').where('documentId').equals(String(documentId)).toArray();
        return rows.map(row => core().normalizeSuggestion(row)).sort((left, right) => right.createdAt - left.createdAt);
    }

    async function blockFor(documentId, blockId) {
        const blocks = await listBlocks(documentId);
        return blocks.find(block => block.id === String(blockId || '')) || null;
    }

    async function syncSharedAsset(document, blocks) {
        if (!global.SharedAssets) return null;
        const content = core().serializeBlocks(blocks, document.format);
        const asset = await global.SharedAssets.registerExternal({
            id: document.assetId,
            type: 'document',
            name: document.title,
            mimeType: document.format === 'text' ? 'text/plain' : 'text/markdown',
            size: new TextEncoder().encode(content).byteLength,
            contentHash: core().contentFingerprint(document, blocks),
            externalStore: 'sharedDocuments',
            externalKey: document.id,
            metadata: { source: 'shared-document', format: document.format, revision: document.revision, sessionId: document.sessionId },
        });
        await global.SharedAssets.attach(asset.id, {
            id: `shared-document:${document.id}`,
            ownerType: 'collaboration-session',
            ownerId: document.sessionId,
            role: 'shared-document',
        });
        return asset;
    }

    async function createDocument(session, options = {}) {
        requireTables();
        if (!session?.id || !session?.characterId) throw new Error('请先选择有效的协同会话。');
        const now = Date.now();
        const documentId = makeId('shared-document');
        const block = core().normalizeBlock({
            id: makeId('shared-block'), documentId, text: options.text || '', position: 0, createdAt: now, updatedAt: now,
        });
        const document = core().normalizeDocument({
            id: documentId,
            sessionId: session.id,
            characterId: session.characterId,
            assetId: makeId('shared-document-asset'),
            title: options.title,
            format: options.format,
            revision: 1,
            createdAt: now,
            updatedAt: now,
        });
        const revision = core().normalizeRevision({
            documentId, revision: 1, title: document.title, format: document.format,
            blocks: [block], reason: 'create', createdAt: now,
        });
        await runTransaction(async () => {
            await table('sharedDocuments').put(document);
            await table('sharedDocumentBlocks').put(block);
            await table('sharedDocumentRevisions').put(revision);
        });
        try { await syncSharedAsset(document, [block]); } catch (error) { console.warn('[SharedDocuments] asset registration failed:', error); }
        return document;
    }

    async function createComment(input = {}) {
        requireTables();
        const document = await getDocument(input.documentId);
        if (!document) throw new Error('共享文档不存在。');
        const block = await blockFor(document.id, input.blockId);
        if (!block) throw new Error('目标段落不存在，请重新载入文档。');
        const comment = core().normalizeComment({
            id: makeId('shared-comment'), documentId: document.id, blockId: block.id,
            authorType: input.authorType, authorName: input.authorName || '我', content: input.content,
            status: 'open', createdAt: Date.now(), updatedAt: Date.now(),
        });
        if (!comment.content) throw new Error('批注内容不能为空。');
        await runTransaction(() => table('sharedDocumentComments').put(comment));
        return comment;
    }

    async function createSuggestion(input = {}) {
        requireTables();
        const document = await getDocument(input.documentId);
        if (!document) throw new Error('共享文档不存在。');
        const block = await blockFor(document.id, input.blockId);
        if (!block) throw new Error('目标段落不存在，请重新载入文档。');
        const originalText = input.originalText == null ? block.text : String(input.originalText);
        if (originalText !== block.text) {
            const error = new Error('目标段落已经变化，请重新载入后创建建议。');
            error.code = 'SHARED_DOCUMENT_SUGGESTION_CONFLICT';
            throw error;
        }
        const suggestion = core().normalizeSuggestion({
            id: makeId('shared-suggestion'), documentId: document.id, blockId: block.id,
            source: input.source,
            authorType: input.authorType, authorName: input.authorName || '我',
            baseRevision: document.revision, originalText, replacementText: input.replacementText, note: input.note,
            status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
        });
        await runTransaction(() => table('sharedDocumentSuggestions').put(suggestion));
        return suggestion;
    }

    function characterFor(id = state.characterId) {
        return (global.db?.characters || []).find(item => String(item.id) === String(id)) || null;
    }

    function collaborationApiFor(character) {
        return global.FeatureApiRegistry?.resolve('collaboration', {
            context: character,
            registry: global.db?.apiFeatureRegistry,
        }) || { enabled: false, configured: false, reason: 'registry-unavailable' };
    }

    async function requestCharacterSuggestion(input = {}) {
        requireTables();
        const document = await getDocument(input.documentId || state.documentId);
        if (!document) throw new Error('共享文档不存在。');
        const block = await blockFor(document.id, input.blockId);
        if (!block) throw new Error('目标段落不存在，请重新载入文档。');
        const character = characterFor(document.characterId);
        if (!character) throw new Error('当前共享文档绑定的角色不存在。');
        const resolved = collaborationApiFor(character);
        if (!resolved.enabled || !resolved.configured) {
            if (resolved.reason === 'disabled') throw new Error('当前角色的协同 API 已关闭。');
            throw new Error('请先为当前角色配置协同 API 地址和模型。');
        }
        const config = resolved.config || {};
        if (!config.url || !config.model) throw new Error('协同 API 地址和模型不能为空。');
        if (typeof global.fetchAiResponse !== 'function') throw new Error('协同请求服务尚未加载。');
        const messages = core().buildCharacterSuggestionMessages(document, block, character);
        const stream = config.streamEnabled === true;
        const body = { model: config.model, messages, temperature: 0.3, stream };
        const endpoint = typeof global.getApiConfigEndpoint === 'function'
            ? global.getApiConfigEndpoint(config, stream)
            : `${String(config.url).replace(/\/$/, '')}/v1/chat/completions`;
        const headers = typeof global.getApiConfigHeaders === 'function'
            ? global.getApiConfigHeaders(config)
            : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key || ''}` };
        const response = await global.fetchAiResponse(config, body, headers, endpoint, stream);
        const structured = core().parseCharacterSuggestionResponse(response);
        return createSuggestion({
            documentId: document.id,
            blockId: block.id,
            source: 'character',
            authorType: 'character',
            authorName: character.name || character.charName || character.realName || '角色',
            originalText: block.text,
            replacementText: structured.replacementText,
            note: structured.note,
        });
    }

    async function updateCommentStatus(commentId, status) {
        const current = await table('sharedDocumentComments')?.get(String(commentId || ''));
        if (!current) throw new Error('批注不存在。');
        const next = core().normalizeComment({ ...current, status, updatedAt: Date.now(), resolvedAt: status === 'resolved' ? Date.now() : null });
        await runTransaction(() => table('sharedDocumentComments').put(next));
        return next;
    }

    async function updateSuggestionStatus(suggestionId, status) {
        const current = await table('sharedDocumentSuggestions')?.get(String(suggestionId || ''));
        if (!current) throw new Error('修改建议不存在。');
        const next = core().normalizeSuggestion({ ...current, status, updatedAt: Date.now(), resolvedAt: status === 'pending' ? null : Date.now() });
        await runTransaction(() => table('sharedDocumentSuggestions').put(next));
        return next;
    }

    async function resolveComment(commentId) {
        return updateCommentStatus(commentId, 'resolved');
    }

    async function rejectSuggestion(suggestionId) {
        const current = await table('sharedDocumentSuggestions')?.get(String(suggestionId || ''));
        if (!current || core().normalizeSuggestion(current).status !== 'pending') throw new Error('只有待处理建议可以拒绝。');
        return updateSuggestionStatus(suggestionId, 'rejected');
    }

    async function replaceBlocks(documentId, blocks) {
        const blocksTable = table('sharedDocumentBlocks');
        const previous = await blocksTable.where('documentId').equals(documentId).toArray();
        const nextIds = new Set(blocks.map(block => block.id));
        const staleIds = previous.filter(block => !nextIds.has(block.id)).map(block => block.id);
        if (staleIds.length && typeof blocksTable.bulkDelete === 'function') await blocksTable.bulkDelete(staleIds);
        else for (const id of staleIds) await blocksTable.delete(id);
        if (typeof blocksTable.bulkPut === 'function') await blocksTable.bulkPut(blocks);
        else for (const block of blocks) await blocksTable.put(block);
    }

    async function saveDocument(input = {}) {
        requireTables();
        const documentId = String(input.documentId || state.documentId || '');
        const current = await getDocument(documentId);
        if (!current) throw new Error('共享文档不存在。');
        core().assertExpectedRevision(current, input.expectedRevision);
        const now = Date.now();
        const previousBlocks = await listBlocks(documentId);
        const previousById = new Map(previousBlocks.map(block => [block.id, block]));
        let blocks = core().normalizeBlocks((Array.isArray(input.blocks) ? input.blocks : []).map(block => ({
            ...block,
            createdAt: block.createdAt || previousById.get(String(block.id || ''))?.createdAt || now,
        })), { documentId, updatedAt: now });
        if (!blocks.length) {
            blocks = [core().normalizeBlock({ id: makeId('shared-block'), documentId, text: '', position: 0, createdAt: now, updatedAt: now })];
        }
        blocks = blocks.map((block, position) => core().normalizeBlock({ ...block, documentId, position, updatedAt: now }, { createdAt: block.createdAt || now }));
        const next = core().normalizeDocument({
            ...current,
            title: input.title,
            format: input.format,
            revision: current.revision + 1,
            updatedAt: now,
        });
        const revision = core().normalizeRevision({
            documentId,
            revision: next.revision,
            title: next.title,
            format: next.format,
            blocks,
            reason: input.reason,
            restoredFromRevision: input.restoredFromRevision,
            createdAt: now,
        });
        await runTransaction(async () => {
            const latest = await table('sharedDocuments').get(documentId);
            core().assertExpectedRevision(latest, input.expectedRevision);
            let acceptedSuggestion = null;
            if (input.acceptedSuggestionId) {
                acceptedSuggestion = core().normalizeSuggestion(await table('sharedDocumentSuggestions').get(String(input.acceptedSuggestionId)));
                if (!acceptedSuggestion.id || acceptedSuggestion.status !== 'pending'
                    || acceptedSuggestion.documentId !== documentId
                    || acceptedSuggestion.baseRevision !== current.revision) {
                    throw new Error('修改建议已失效，请重新载入后处理。');
                }
                const target = blocks.find(block => block.id === acceptedSuggestion.blockId);
                if (!target || target.text !== acceptedSuggestion.replacementText) {
                    throw new Error('修改建议目标已变化，请重新载入后处理。');
                }
            }
            await replaceBlocks(documentId, blocks);
            await table('sharedDocuments').put(next);
            await table('sharedDocumentRevisions').put(revision);
            if (acceptedSuggestion) {
                await table('sharedDocumentSuggestions').put(core().normalizeSuggestion({
                    ...acceptedSuggestion, status: 'accepted', updatedAt: now, resolvedAt: now, resolvedRevision: next.revision,
                }));
            }
        });
        try { await syncSharedAsset(next, blocks); } catch (error) { console.warn('[SharedDocuments] asset update failed:', error); }
        return { document: next, blocks, revision };
    }

    async function acceptSuggestion(suggestionId) {
        const raw = await table('sharedDocumentSuggestions')?.get(String(suggestionId || ''));
        const suggestion = raw ? core().normalizeSuggestion(raw) : null;
        if (!suggestion || suggestion.status !== 'pending') throw new Error('只有待处理建议可以接受。');
        const document = await getDocument(suggestion.documentId);
        const block = document ? await blockFor(document.id, suggestion.blockId) : null;
        if (!document || !block || document.revision !== suggestion.baseRevision || block.text !== suggestion.originalText) {
            await updateSuggestionStatus(suggestion.id, 'conflict');
            const error = new Error('文档或目标段落已有新版本，建议未写入正文，已标记为冲突。');
            error.code = 'SHARED_DOCUMENT_SUGGESTION_CONFLICT';
            throw error;
        }
        const blocks = (await listBlocks(document.id)).map(item => item.id === suggestion.blockId
            ? { ...item, text: suggestion.replacementText }
            : item);
        return saveDocument({
            documentId: document.id,
            title: document.title,
            format: document.format,
            blocks,
            expectedRevision: document.revision,
            reason: 'save',
            acceptedSuggestionId: suggestion.id,
        });
    }

    async function restoreRevision(documentId, revisionNumber, expectedRevision) {
        const revisions = await listRevisions(documentId);
        const snapshot = revisions.find(item => item.revision === Number(revisionNumber));
        if (!snapshot) throw new Error('所选历史版本不存在。');
        return saveDocument({
            documentId,
            title: snapshot.title,
            format: snapshot.format,
            blocks: snapshot.blocks,
            expectedRevision,
            reason: 'restore',
            restoredFromRevision: snapshot.revision,
        });
    }

    function setStatus(message, tone = '') {
        const status = byId('shared-document-status');
        if (!status) return;
        status.textContent = message;
        status.className = `shared-document-status${tone ? ` is-${tone}` : ''}`;
    }

    function setEditorEnabled(enabled) {
        const editor = byId('shared-document-editor');
        const empty = byId('shared-document-empty');
        if (editor) editor.hidden = !enabled;
        if (empty) empty.hidden = enabled;
    }

    function renderPicker(documents) {
        const select = byId('shared-document-select');
        if (!select) return;
        select.replaceChildren();
        if (!documents.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无共享文档';
            select.appendChild(option);
            select.disabled = true;
            return;
        }
        select.disabled = false;
        documents.forEach(item => {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = `${item.title} · v${item.revision}`;
            option.selected = item.id === state.documentId;
            select.appendChild(option);
        });
    }

    function feedbackForBlock(blockId) {
        return {
            comments: state.comments.filter(item => item.blockId === blockId && item.status === 'open').length,
            suggestions: state.suggestions.filter(item => item.blockId === blockId && item.status === 'pending').length,
        };
    }

    function createBlockRow(block, position, count) {
        const row = document.createElement('article');
        row.className = 'shared-document-block';
        row.dataset.sharedDocumentBlock = block.id;
        const heading = document.createElement('div');
        heading.className = 'shared-document-block-heading';
        const label = document.createElement('span');
        label.textContent = `段落 ${position + 1} · ${block.id.slice(-8)}`;
        const controls = document.createElement('div');
        controls.className = 'shared-document-block-controls';
        [['↑', 'up'], ['↓', 'down'], ['删除', 'remove']].forEach(([caption, action]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = caption;
            button.dataset.sharedDocumentBlockAction = action;
            button.dataset.blockId = block.id;
            if ((action === 'up' && position === 0) || (action === 'down' && position === count - 1) || (action === 'remove' && count === 1)) button.disabled = true;
            controls.appendChild(button);
        });
        const feedback = feedbackForBlock(block.id);
        [['批注', 'comment', feedback.comments], ['建议', 'suggestion', feedback.suggestions], ['角色建议', 'character-suggestion', 0]].forEach(([caption, action, countValue]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = `${caption}${countValue ? ` ${countValue}` : ''}`;
            button.dataset.sharedDocumentFeedbackAction = action;
            button.dataset.blockId = block.id;
            controls.appendChild(button);
        });
        heading.append(label, controls);
        const textarea = document.createElement('textarea');
        textarea.rows = 4;
        textarea.maxLength = 50000;
        textarea.value = block.text;
        textarea.dataset.sharedDocumentBlockText = block.id;
        textarea.setAttribute('aria-label', `段落 ${position + 1}`);
        row.append(heading, textarea);
        return row;
    }

    function renderBlocks(blocks) {
        const list = byId('shared-document-block-list');
        if (!list) return;
        list.replaceChildren();
        blocks.forEach((block, position) => list.appendChild(createBlockRow(block, position, blocks.length)));
    }

    function feedbackTargetLabel(blocks, blockId) {
        const position = blocks.findIndex(block => block.id === blockId);
        return position < 0 ? '已删除段落' : `段落 ${position + 1}`;
    }

    function feedbackButton(label, action, id) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'collaboration-secondary-btn shared-document-feedback-btn';
        button.textContent = label;
        button.dataset.sharedDocumentFeedbackAction = action;
        button.dataset.feedbackId = id;
        return button;
    }

    function renderFeedback(blocks) {
        const list = byId('shared-document-feedback-list');
        if (!list) return;
        list.replaceChildren();
        const items = [];
        state.comments.forEach(comment => {
            const card = document.createElement('article');
            card.className = `shared-document-feedback-card${comment.status === 'resolved' ? ' is-resolved' : ''}`;
            const heading = document.createElement('div');
            heading.className = 'shared-document-feedback-heading';
            const label = document.createElement('strong');
            label.textContent = `${feedbackTargetLabel(blocks, comment.blockId)} · ${comment.authorName}`;
            const status = document.createElement('small');
            status.textContent = comment.status === 'resolved' ? '已解决' : '待处理批注';
            heading.append(label, status);
            const content = document.createElement('p');
            content.textContent = comment.content;
            card.append(heading, content);
            if (comment.status === 'open') card.appendChild(feedbackButton('标记已解决', 'resolve-comment', comment.id));
            items.push({ createdAt: comment.createdAt, card });
        });
        state.suggestions.forEach(suggestion => {
            const card = document.createElement('article');
            card.className = `shared-document-feedback-card shared-document-suggestion-card is-${suggestion.status}`;
            const heading = document.createElement('div');
            heading.className = 'shared-document-feedback-heading';
            const label = document.createElement('strong');
            label.textContent = `${feedbackTargetLabel(blocks, suggestion.blockId)} · ${suggestion.authorName}${suggestion.source === 'character' ? ' · 角色建议' : ''}`;
            const status = document.createElement('small');
            status.textContent = suggestion.status === 'pending' ? `待处理 · 基于 v${suggestion.baseRevision}`
                : suggestion.status === 'accepted' ? `已接受 · v${suggestion.resolvedRevision}`
                    : suggestion.status === 'rejected' ? '已拒绝' : '基础版本冲突';
            heading.append(label, status);
            const original = document.createElement('p');
            original.className = 'shared-document-feedback-original';
            original.textContent = `原文：${suggestion.originalText || '（空段落）'}`;
            const replacement = document.createElement('p');
            replacement.className = 'shared-document-feedback-replacement';
            replacement.textContent = `建议：${suggestion.replacementText || '（删除段落内容）'}`;
            card.append(heading, original, replacement);
            if (suggestion.note) {
                const note = document.createElement('p');
                note.className = 'shared-document-feedback-note';
                note.textContent = `说明：${suggestion.note}`;
                card.appendChild(note);
            }
            if (suggestion.status === 'pending') {
                const actions = document.createElement('div');
                actions.className = 'shared-document-feedback-actions';
                actions.append(feedbackButton('接受并保存新版本', 'accept-suggestion', suggestion.id), feedbackButton('拒绝', 'reject-suggestion', suggestion.id));
                card.appendChild(actions);
            }
            items.push({ createdAt: suggestion.createdAt, card });
        });
        items.sort((left, right) => right.createdAt - left.createdAt).forEach(item => list.appendChild(item.card));
        const empty = byId('shared-document-feedback-empty');
        if (empty) empty.hidden = items.length > 0;
    }

    function collectDraft() {
        const rows = [...(byId('shared-document-block-list')?.querySelectorAll('[data-shared-document-block]') || [])];
        const blocks = rows.map((row, position) => ({
            id: row.dataset.sharedDocumentBlock,
            documentId: state.documentId,
            text: row.querySelector('[data-shared-document-block-text]')?.value || '',
            position,
        }));
        return {
            documentId: state.documentId,
            title: byId('shared-document-title-input')?.value || '',
            format: byId('shared-document-format')?.value || 'markdown',
            blocks,
            expectedRevision: state.expectedRevision,
        };
    }

    function renderRevisions(revisions, currentDocument) {
        const select = byId('shared-document-revision-select');
        if (!select) return;
        select.replaceChildren();
        revisions.forEach(revision => {
            const option = document.createElement('option');
            option.value = String(revision.revision);
            const suffix = revision.reason === 'restore' ? ` · 恢复自 v${revision.restoredFromRevision}` : revision.reason === 'create' ? ' · 初始版本' : '';
            option.textContent = `v${revision.revision}${suffix} · ${new Date(revision.createdAt).toLocaleString()}`;
            option.disabled = revision.revision === currentDocument.revision;
            select.appendChild(option);
        });
        const restorable = revisions.find(revision => revision.revision !== currentDocument.revision);
        if (restorable) select.value = String(restorable.revision);
        select.disabled = !restorable;
        const restore = byId('shared-document-restore-btn');
        if (restore) restore.disabled = !restorable;
    }

    async function render() {
        const documents = await listDocuments();
        let current = documents.find(item => item.id === state.documentId) || documents[0] || null;
        state.documentId = current?.id || '';
        renderPicker(documents);
        setEditorEnabled(Boolean(current));
        if (!current) {
            state.expectedRevision = 0;
            state.comments = [];
            state.suggestions = [];
            renderFeedback([]);
            setStatus('新建文档后即可开始按段落编辑');
            return;
        }
        state.expectedRevision = current.revision;
        const title = byId('shared-document-title-input');
        const format = byId('shared-document-format');
        if (title) title.value = current.title;
        if (format) format.value = current.format;
        const blocks = await listBlocks(current.id);
        const visibleBlocks = blocks.length ? blocks : [core().normalizeBlock({ id: makeId('shared-block'), documentId: current.id, position: 0 })];
        renderRevisions(await listRevisions(current.id), current);
        state.comments = await listComments(current.id);
        state.suggestions = await listSuggestions(current.id);
        renderBlocks(visibleBlocks);
        renderFeedback(visibleBlocks);
        setStatus(`已保存 v${current.revision} · ${blocks.length || 1} 个稳定段落`);
    }

    async function renderSession(session) {
        const nextSessionId = String(session?.id || '');
        if (state.sessionId !== nextSessionId) state.documentId = '';
        state.sessionId = nextSessionId;
        state.characterId = String(session?.characterId || '');
        await render();
    }

    async function newDocument() {
        if (state.busy || !state.sessionId) return;
        const session = await global.Collaboration?.getSession?.(state.sessionId);
        if (!session) return notify('请先选择协同会话。');
        const suggested = '未命名共享文档';
        const title = typeof global.prompt === 'function' ? global.prompt('共享文档名称', suggested) : suggested;
        if (title === null) return;
        state.busy = true;
        try {
            const created = await createDocument(session, { title: title.trim() || suggested });
            state.documentId = created.id;
            await render();
            notify('共享文档已创建。');
        } catch (error) {
            console.error('[SharedDocuments] create failed:', error);
            notify(error?.message || '创建共享文档失败。');
        } finally { state.busy = false; }
    }

    async function saveCurrent() {
        if (state.busy || !state.documentId) return;
        state.busy = true;
        setStatus('正在保存…', 'busy');
        try {
            const result = await saveDocument({ ...collectDraft(), reason: 'save' });
            state.expectedRevision = result.document.revision;
            await render();
            notify(`已保存为 v${result.document.revision}。`);
        } catch (error) {
            console.error('[SharedDocuments] save failed:', error);
            setStatus(error?.message || '保存失败', 'error');
            notify(error?.message || '保存共享文档失败。');
        } finally { state.busy = false; }
    }

    async function restoreCurrent() {
        if (state.busy || !state.documentId) return;
        const revisionNumber = Number(byId('shared-document-revision-select')?.value);
        if (!revisionNumber) return;
        if (typeof global.confirm === 'function' && !global.confirm(`恢复 v${revisionNumber}？当前内容不会被删除，恢复结果会保存为一个新版本。`)) return;
        state.busy = true;
        setStatus(`正在恢复 v${revisionNumber}…`, 'busy');
        try {
            const result = await restoreRevision(state.documentId, revisionNumber, state.expectedRevision);
            state.expectedRevision = result.document.revision;
            await render();
            notify(`已从 v${revisionNumber} 恢复为 v${result.document.revision}。`);
        } catch (error) {
            console.error('[SharedDocuments] restore failed:', error);
            setStatus(error?.message || '恢复失败', 'error');
            notify(error?.message || '恢复历史版本失败。');
        } finally { state.busy = false; }
    }

    function addBlock() {
        if (!state.documentId) return;
        const draft = collectDraft();
        draft.blocks.push({ id: makeId('shared-block'), documentId: state.documentId, text: '', position: draft.blocks.length });
        renderBlocks(core().normalizeBlocks(draft.blocks, { documentId: state.documentId }));
        byId('shared-document-block-list')?.lastElementChild?.querySelector('textarea')?.focus();
    }

    async function addCommentForBlock(blockId) {
        const block = await blockFor(state.documentId, blockId);
        if (!block) return notify('目标段落已不存在，请重新载入文档。');
        const content = typeof global.prompt === 'function' ? global.prompt('给这一段添加批注', '') : '';
        if (content === null || !content.trim()) return;
        try {
            await createComment({ documentId: state.documentId, blockId, content, authorName: '我' });
            await render();
            notify('批注已保存。');
        } catch (error) {
            console.error('[SharedDocuments] comment failed:', error);
            notify(error?.message || '保存批注失败。');
        }
    }

    async function addSuggestionForBlock(blockId) {
        const block = await blockFor(state.documentId, blockId);
        if (!block) return notify('目标段落已不存在，请重新载入文档。');
        const replacement = typeof global.prompt === 'function' ? global.prompt('建议替换为（可留空表示清空这一段）', block.text) : block.text;
        if (replacement === null) return;
        const note = typeof global.prompt === 'function' ? global.prompt('修改说明（可留空）', '') : '';
        if (note === null) return;
        try {
            await createSuggestion({ documentId: state.documentId, blockId, originalText: block.text, replacementText: replacement, note, authorName: '我' });
            await render();
            notify('修改建议已保存，等待接受或拒绝。');
        } catch (error) {
            console.error('[SharedDocuments] suggestion failed:', error);
            notify(error?.message || '保存修改建议失败。');
        }
    }

    async function requestCharacterSuggestionForBlock(blockId) {
        if (state.busy) return;
        const block = await blockFor(state.documentId, blockId);
        if (!block) return notify('目标段落已不存在，请重新载入文档。');
        const visibleText = byId('shared-document-block-list')?.querySelector(`[data-shared-document-block="${global.CSS?.escape ? global.CSS.escape(blockId) : blockId}"] [data-shared-document-block-text]`)?.value;
        if (visibleText != null && visibleText !== block.text) return notify('这一段有尚未保存的修改，请先保存新版本再请求角色建议。');
        state.busy = true;
        setStatus('角色正在为所选段落生成修改建议…', 'busy');
        try {
            await requestCharacterSuggestion({ documentId: state.documentId, blockId });
            await render();
            notify('角色建议已生成，请预览后接受或拒绝。');
        } catch (error) {
            console.error('[SharedDocuments] character suggestion failed:', error);
            setStatus(error?.message || '角色建议生成失败。', 'error');
            notify(error?.message || '角色建议生成失败。');
        } finally { state.busy = false; }
    }

    async function runFeedbackAction(action, feedbackId) {
        if (state.busy || !feedbackId) return;
        state.busy = true;
        try {
            if (action === 'resolve-comment') {
                await resolveComment(feedbackId);
                notify('批注已标记为已解决。');
            } else if (action === 'reject-suggestion') {
                await rejectSuggestion(feedbackId);
                notify('修改建议已拒绝。');
            } else if (action === 'accept-suggestion') {
                const result = await acceptSuggestion(feedbackId);
                state.expectedRevision = result.document.revision;
                notify(`修改建议已接受，正文保存为 v${result.document.revision}。`);
            }
            await render();
        } catch (error) {
            console.error('[SharedDocuments] feedback action failed:', error);
            await render();
            notify(error?.message || '处理反馈失败。');
        } finally { state.busy = false; }
    }

    function changeBlock(blockId, action) {
        const draft = collectDraft();
        const index = draft.blocks.findIndex(block => block.id === blockId);
        if (index < 0) return;
        if (action === 'remove' && draft.blocks.length > 1) draft.blocks.splice(index, 1);
        if (action === 'up' && index > 0) [draft.blocks[index - 1], draft.blocks[index]] = [draft.blocks[index], draft.blocks[index - 1]];
        if (action === 'down' && index < draft.blocks.length - 1) [draft.blocks[index + 1], draft.blocks[index]] = [draft.blocks[index], draft.blocks[index + 1]];
        renderBlocks(core().normalizeBlocks(draft.blocks, { documentId: state.documentId }));
    }

    function exportText(format = 'markdown', draft = collectDraft()) {
        return core().serializeBlocks(draft.blocks, format);
    }

    function downloadCurrent(format) {
        if (!state.documentId) return;
        const draft = collectDraft();
        const content = exportText(format, draft);
        const blob = new Blob([content], { type: format === 'text' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = core().exportFileName(draft.title, format);
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setStatus(`已导出当前编辑内容：${link.download}`);
    }

    function setup() {
        if (state.setupComplete) return;
        state.setupComplete = true;
        byId('shared-document-new-btn')?.addEventListener('click', () => void newDocument());
        byId('shared-document-select')?.addEventListener('change', event => { state.documentId = event.target.value; void render(); });
        byId('shared-document-add-block-btn')?.addEventListener('click', addBlock);
        byId('shared-document-save-btn')?.addEventListener('click', () => void saveCurrent());
        byId('shared-document-restore-btn')?.addEventListener('click', () => void restoreCurrent());
        byId('shared-document-export-markdown-btn')?.addEventListener('click', () => downloadCurrent('markdown'));
        byId('shared-document-export-text-btn')?.addEventListener('click', () => downloadCurrent('text'));
        byId('shared-document-block-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-shared-document-block-action]');
            if (button) {
                changeBlock(button.dataset.blockId, button.dataset.sharedDocumentBlockAction);
                return;
            }
            const feedback = event.target.closest('[data-shared-document-feedback-action]');
            if (!feedback) return;
            if (feedback.dataset.sharedDocumentFeedbackAction === 'comment') void addCommentForBlock(feedback.dataset.blockId);
            if (feedback.dataset.sharedDocumentFeedbackAction === 'suggestion') void addSuggestionForBlock(feedback.dataset.blockId);
            if (feedback.dataset.sharedDocumentFeedbackAction === 'character-suggestion') void requestCharacterSuggestionForBlock(feedback.dataset.blockId);
        });
        byId('shared-document-feedback-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-shared-document-feedback-action]');
            if (button) void runFeedbackAction(button.dataset.sharedDocumentFeedbackAction, button.dataset.feedbackId);
        });
    }

    function isReady() { return state.setupComplete; }

    global.SharedDocuments = Object.freeze({
        VERSION: 3, setup, isReady, render, renderSession, listDocuments, getDocument, listBlocks, listRevisions,
        listComments, listSuggestions, createDocument, createComment, createSuggestion, requestCharacterSuggestion, saveDocument,
        restoreRevision, acceptSuggestion, resolveComment, rejectSuggestion, exportText,
    });
}(typeof window !== 'undefined' ? window : globalThis));
