(function attachCollaborationModule(global) {
    'use strict';

    const state = { characterId: '', sessionId: '', returnScreen: 'chat-room-screen', busy: false };
    const core = () => global.CollaborationCore;
    const table = name => global.dexieDB?.[name];
    const notify = (message, duration) => { if (typeof global.showToast === 'function') global.showToast(message, duration); };
    const byId = id => global.document?.getElementById(id);
    const supportedReadingFormats = () => global.ReadingCore?.FORMATS || ['txt', 'docx', 'pdf', 'epub'];

    function currentType() {
        try { if (typeof currentChatType !== 'undefined') return currentChatType; } catch (_) { /* global lexical binding not available */ }
        return global.currentChatType || 'private';
    }

    function characterFor(id) {
        return (global.db?.characters || []).find(item => String(item.id) === String(id)) || null;
    }

    function makeId(prefix, value) {
        const random = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        return `${prefix}:${value}:${random}`.slice(0, 180);
    }

    function apiConfigId(characterId) {
        const safe = String(characterId || 'role').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 54) || 'role';
        return `collab-${safe}`;
    }

    function persistGlobal(keys) {
        if (typeof global.saveGlobalSettings === 'function') return global.saveGlobalSettings(keys);
        try { if (typeof saveGlobalSettings === 'function') return saveGlobalSettings(keys); } catch (_) { /* lexical binding unavailable */ }
        return Promise.resolve(false);
    }

    function featureBinding(character) {
        return character?.featureApiBindings?.collaboration || character?.apiFeatureBindings?.collaboration || null;
    }

    function resolveApi(character) {
        if (!global.FeatureApiRegistry) return { configured: false, enabled: false, reason: 'registry-unavailable' };
        return global.FeatureApiRegistry.resolve('collaboration', { context: character, registry: global.db?.apiFeatureRegistry });
    }

    function apiStateText(result) {
        if (result?.configured) return result.enabled ? `已配置 · ${result.config?.model || '默认模型'}` : '已关闭';
        if (result?.reason === 'disabled') return '已关闭';
        if (result?.reason === 'config-missing') return '已启用，但配置档不存在';
        if (result?.reason === 'registry-unavailable') return '独立 API 注册表不可用';
        return '未配置，不会调用';
    }

    async function listSessions(characterId = state.characterId) {
        const sessionsTable = table('collaborationSessions');
        if (!sessionsTable || !characterId) return [];
        const rows = await sessionsTable.where('characterId').equals(String(characterId)).toArray();
        return rows.map(row => core().normalizeSession(row)).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function getSession(sessionId = state.sessionId) {
        if (!sessionId || !table('collaborationSessions')) return null;
        const row = await table('collaborationSessions').get(String(sessionId));
        return row ? core().normalizeSession(row) : null;
    }

    async function listMessages(sessionId = state.sessionId) {
        const messagesTable = table('collaborationMessages');
        if (!messagesTable || !sessionId) return [];
        const rows = await messagesTable.where('sessionId').equals(String(sessionId)).toArray();
        return rows.map(row => core().normalizeMessage(row)).sort((a, b) => a.createdAt - b.createdAt);
    }

    async function saveSession(value) {
        const character = characterFor(value.characterId || state.characterId);
        const session = core().normalizeSession(value, {
            characterId: value.characterId || state.characterId,
            characterName: character?.name || character?.charName || '角色',
        });
        if (!session.id || !session.characterId || !table('collaborationSessions')) throw new Error('协同会话数据不完整');
        await table('collaborationSessions').put(session);
        return session;
    }

    async function saveMessage(value) {
        const messagesTable = table('collaborationMessages');
        if (!messagesTable) throw new Error('协同消息数据表尚未就绪');
        const sessionId = String(value?.sessionId || state.sessionId || '');
        const session = await getSession(sessionId);
        if (!session) throw new Error('协同会话不存在');
        const message = core().normalizeMessage(value, { id: makeId('collab-message', sessionId), sessionId });
        if (!message.content) throw new Error('协同消息不能为空');
        await messagesTable.put(message);
        await saveSession({ ...session, lastMessagePreview: core().previewForMessage(message), updatedAt: message.createdAt });
        return message;
    }

    async function createSession(characterId = state.characterId, options = {}) {
        const character = characterFor(characterId);
        if (!characterId || !character) throw new Error('角色不存在，无法创建协同会话');
        const now = Date.now();
        return saveSession({
            id: makeId('collab', characterId),
            characterId: String(characterId),
            title: options.title || `与 ${character.name || character.charName || '角色'} 协同`,
            mode: options.mode || 'focused',
            createdAt: now,
            updatedAt: now,
        });
    }

    function renderMode(session) {
        document.querySelectorAll('[data-collaboration-mode]').forEach(button => {
            const active = button.dataset.collaborationMode === session.mode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const note = byId('collaboration-mode-note');
        if (note) note.textContent = `${core().MODE_LABELS[session.mode]}：当前只把协同会话边界提供给协同 API，不会注入普通聊天翻译或改写普通聊天记录。`;
    }

    function renderSessions(sessions) {
        const list = byId('collaboration-session-list');
        if (!list) return;
        list.replaceChildren();
        sessions.forEach(session => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `collaboration-session-card${session.id === state.sessionId ? ' is-active' : ''}`;
            button.dataset.collaborationSession = session.id;
            const title = document.createElement('strong');
            title.textContent = session.title;
            const meta = document.createElement('small');
            meta.textContent = `${core().MODE_LABELS[session.mode]}${session.lastMessagePreview ? ` · ${session.lastMessagePreview}` : ''}`;
            button.append(title, meta);
            list.appendChild(button);
        });
        const empty = byId('collaboration-session-empty');
        if (empty) empty.hidden = sessions.length > 0;
    }

    function renderMessages(messages) {
        const list = byId('collaboration-message-list');
        if (!list) return;
        list.replaceChildren();
        if (!messages.length) {
            const empty = document.createElement('p');
            empty.className = 'collaboration-empty';
            empty.textContent = '还没有回合。发送第一条消息后，回复只会保存到当前协同会话。';
            list.appendChild(empty);
            return;
        }
        messages.forEach(message => {
            const item = document.createElement('article');
            item.className = `collaboration-message collaboration-message-${message.role}`;
            const role = document.createElement('small');
            role.textContent = message.role === 'assistant' ? '角色' : message.role === 'system' ? '系统' : '我';
            const content = document.createElement('p');
            content.textContent = message.content;
            item.append(role, content);
            list.appendChild(item);
        });
        list.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
    }

    function attachmentStatusClass(status) {
        if (status === 'ready') return 'is-ready';
        if (status === 'missing' || status === 'summary-failed') return 'is-error';
        return 'is-muted';
    }

    function renderAttachmentRow(row) {
        const asset = row.asset;
        const card = document.createElement('article');
        card.className = `collaboration-attachment-card${row.selected ? ' is-selected' : ''}`;
        card.dataset.collaborationAttachment = row.assetId;

        const heading = document.createElement('div');
        heading.className = 'collaboration-attachment-heading';
        const label = document.createElement('label');
        label.className = 'collaboration-attachment-select';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = row.selected;
        checkbox.disabled = row.status !== 'ready' && !row.selected;
        checkbox.dataset.collaborationAttachmentToggle = row.assetId;
        const name = document.createElement('strong');
        name.textContent = asset?.name || `${row.assetId}（已删除）`;
        label.append(checkbox, name);
        const meta = document.createElement('small');
        const format = row.format || asset?.metadata?.format || asset?.mimeType || '未知格式';
        meta.textContent = asset ? `${format} · ${asset.mimeType || '未标注 MIME'}${asset.state === 'orphaned' ? ' · 待挂载' : ''}` : '共享资产记录已不存在';
        heading.append(label, meta);
        card.appendChild(heading);

        const controls = document.createElement('div');
        controls.className = 'collaboration-attachment-controls';
        if (row.status === 'ready') {
            const locator = document.createElement('label');
            locator.className = 'collaboration-attachment-locator';
            locator.textContent = '章节/段落';
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '1';
            input.max = String(Math.max(1, row.document?.segmentCount || 1));
            input.value = String((row.reference?.segmentIndex || 0) + 1);
            input.dataset.collaborationAttachmentSegment = row.assetId;
            input.disabled = !row.selected;
            locator.appendChild(input);
            controls.appendChild(locator);
        }
        const status = document.createElement('span');
        status.className = `collaboration-attachment-status ${attachmentStatusClass(row.status)}`;
        status.textContent = row.selected ? row.statusText : (row.status === 'ready' ? '可选择' : row.statusText);
        controls.appendChild(status);
        if (row.selected) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'collaboration-attachment-remove';
            remove.dataset.collaborationAttachmentRemove = row.assetId;
            remove.textContent = '取消引用';
            controls.appendChild(remove);
        }
        card.appendChild(controls);
        if (row.selected && row.summary) {
            const preview = document.createElement('p');
            preview.className = 'collaboration-attachment-preview';
            preview.textContent = row.summary;
            card.appendChild(preview);
        }
        return card;
    }

    async function renderAttachments(session) {
        const list = byId('collaboration-attachment-list');
        const empty = byId('collaboration-attachment-empty');
        const status = byId('collaboration-attachment-status');
        if (!list) return;
        const library = await listAttachmentAssets(session);
        if (library.serviceUnavailable) {
            list.replaceChildren();
            if (empty) { empty.hidden = false; empty.textContent = '共享资产服务尚未加载，暂时无法选择资料。'; }
            if (status) status.textContent = '不可用';
            return;
        }
        const bridge = await buildAttachmentContexts(session);
        const bridgeById = new Map(bridge.results.map(item => [item.assetId, item]));
        const rows = library.rows.map(row => row.selected && bridgeById.has(row.assetId)
            ? { ...row, ...bridgeById.get(row.assetId), asset: row.asset, reference: row.reference, selected: true }
            : row);
        list.replaceChildren(...rows.map(renderAttachmentRow));
        if (empty) {
            empty.hidden = rows.length > 0;
            empty.textContent = '暂无已登记文档；请先在「一起读」导入 TXT、DOCX、PDF 或 EPUB。';
        }
        const selectedCount = rows.filter(row => row.selected).length;
        const issueCount = rows.filter(row => row.selected && row.status !== 'ready').length;
        if (status) status.textContent = issueCount ? `已选 ${selectedCount} 项 · ${issueCount} 项需处理` : `已选 ${selectedCount} 项`;
    }

    function renderApiSettings(character) {
        const result = resolveApi(character);
        const binding = featureBinding(character) || {};
        const registry = global.FeatureApiRegistry?.readRegistry(global.db) || { configs: {}, routes: {} };
        const config = registry.configs[binding.configId] || result.config || {};
        if (byId('collaboration-api-enabled')) byId('collaboration-api-enabled').checked = binding.enabled === true;
        if (byId('collaboration-api-url')) byId('collaboration-api-url').value = config.url || config.baseUrl || '';
        if (byId('collaboration-api-key')) byId('collaboration-api-key').value = config.key || config.apiKey || '';
        if (byId('collaboration-api-model')) byId('collaboration-api-model').value = config.model || '';
        if (byId('collaboration-api-stream')) byId('collaboration-api-stream').checked = config.streamEnabled === true;
        if (byId('collaboration-api-status')) byId('collaboration-api-status').textContent = apiStateText(result);
    }

    async function saveApiSettings() {
        const character = characterFor(state.characterId);
        if (!character) return;
        const configId = featureBinding(character)?.configId || apiConfigId(character.id);
        const config = {
            id: configId, name: `协同工作 · ${character.name || character.charName || '角色'}`,
            feature: 'collaboration', service: 'llm', provider: 'newapi',
            url: byId('collaboration-api-url')?.value.trim() || '',
            key: byId('collaboration-api-key')?.value.trim() || '',
            model: byId('collaboration-api-model')?.value.trim() || '',
            streamEnabled: byId('collaboration-api-stream')?.checked === true,
            enabled: true,
        };
        let registry = global.FeatureApiRegistry?.readRegistry(global.db) || { configs: {}, routes: {} };
        if (config.url || config.key || config.model) registry = global.FeatureApiRegistry.upsertConfig(registry, config, configId);
        global.db.apiFeatureRegistry = registry;
        await persistGlobal(['apiFeatureRegistry']);
        character.featureApiBindings = { ...(character.featureApiBindings || {}), collaboration: {
            enabled: byId('collaboration-api-enabled')?.checked === true,
            configId,
            fallbackMode: 'none',
        } };
        if (typeof global.saveCharacter === 'function') await global.saveCharacter(character.id);
        renderApiSettings(character);
        notify('协同 API 设置已保存');
    }

    function attachmentReferenceId(sessionId, assetId) {
        return `collaboration-session:${sessionId}:attachment:${assetId}`.slice(0, 180);
    }

    function selectedAttachmentRefs(session) {
        return core().normalizeSession(session || {}).attachmentRefs || [];
    }

    function segmentIndexFor(document, reference) {
        const count = Math.max(0, Number(document?.segmentCount) || 0);
        const requested = Math.max(0, Number(reference?.segmentIndex) || 0);
        return count ? Math.min(count - 1, requested) : requested;
    }

    async function readingDocumentForAsset(assetId) {
        if (!assetId || typeof global.Reading?.getDocumentByAssetId !== 'function') return null;
        return global.Reading.getDocumentByAssetId(assetId);
    }

    async function describeAttachmentAsset(asset, reference = {}) {
        const assetId = reference.assetId || asset?.id || '';
        if (!asset) return { assetId, status: 'missing', statusText: '资产不存在或已删除' };
        if (asset.type !== 'document') return {
            assetId, asset, status: 'unsupported', statusText: '当前首期只支持文档/资料摘要',
        };
        let document;
        try {
            document = await readingDocumentForAsset(asset.id);
        } catch (error) {
            return { assetId, asset, status: 'summary-failed', statusText: `阅读资料读取失败：${apiErrorMessage(error)}` };
        }
        const format = document?.format || asset.metadata?.format || '';
        if (!document || !supportedReadingFormats().includes(format)) return {
            assetId, asset, document, status: 'unsupported', statusText: '格式不支持摘要桥接', format,
        };
        return {
            assetId, asset, document, format,
            segmentIndex: segmentIndexFor(document, reference),
            status: 'ready', statusText: '可引用摘要',
        };
    }

    async function listAttachmentAssets(session) {
        const refs = selectedAttachmentRefs(session);
        const selectedIds = new Set(refs.map(reference => reference.assetId));
        if (!global.SharedAssets?.list) return { rows: [], serviceUnavailable: true };
        let assets = [];
        try {
            assets = await global.SharedAssets.list({ limit: 500 });
        } catch (error) {
            return { rows: [], serviceUnavailable: true, error };
        }
        const assetMap = new Map(assets
            .filter(asset => selectedIds.has(asset.id) || (asset.type === 'document' && asset.externalStore !== 'sharedDocuments'))
            .map(asset => [asset.id, asset]));
        refs.forEach(reference => { if (!assetMap.has(reference.assetId)) assetMap.set(reference.assetId, null); });
        const rows = await Promise.all([...assetMap.entries()].map(async ([assetId, asset]) => {
            const reference = refs.find(item => item.assetId === assetId) || { assetId };
            const detail = await describeAttachmentAsset(asset, reference);
            return { ...detail, reference, selected: selectedIds.has(assetId) };
        }));
        return { rows: rows.sort((a, b) => Number(b.selected) - Number(a.selected) || String(a.asset?.name || a.assetId).localeCompare(String(b.asset?.name || b.assetId), 'zh-CN')) };
    }

    async function buildAttachmentContexts(session) {
        const refs = selectedAttachmentRefs(session);
        const results = [];
        for (const reference of refs) {
            let detail;
            try {
                const asset = await global.SharedAssets?.get?.(reference.assetId);
                detail = await describeAttachmentAsset(asset, reference);
                if (detail.status === 'ready') {
                    const chunk = await global.Reading?.getChunk?.(detail.document.id, detail.segmentIndex);
                    if (!chunk?.text?.trim()) {
                        detail = { ...detail, status: 'summary-failed', statusText: '选定章节没有可读摘要' };
                    } else {
                        detail.summary = core().formatAttachmentSummary({
                            name: asset.name || detail.document.title,
                            format: detail.format,
                            segmentIndex: detail.segmentIndex,
                            segmentCount: detail.document.segmentCount,
                            text: chunk.text,
                        });
                    }
                }
            } catch (error) {
                detail = { assetId: reference.assetId, status: 'summary-failed', statusText: `摘要生成失败：${apiErrorMessage(error)}` };
            }
            results.push({ ...detail, reference });
        }
        return {
            results,
            summaries: results.filter(item => item.status === 'ready' && item.summary).map(item => item.summary).slice(0, 40),
            issues: results.filter(item => item.status !== 'ready'),
        };
    }

    function apiErrorMessage(error) {
        const message = String(error?.message || error || '协同 API 请求失败').replace(/\s+/g, ' ').trim();
        return message.length > 220 ? `${message.slice(0, 220)}…` : message;
    }

    async function setAttachmentSelection(assetId, selected) {
        const session = await getSession();
        if (!session || !assetId) return;
        const refs = selectedAttachmentRefs(session);
        const existing = refs.find(reference => reference.assetId === assetId);
        if (!selected) {
            if (global.SharedAssets?.detach) await global.SharedAssets.detach(assetId, attachmentReferenceId(session.id, assetId));
            await saveSession({
                ...session,
                attachmentRefs: refs.filter(reference => reference.assetId !== assetId),
                updatedAt: Date.now(),
            });
            await render();
            return;
        }
        const asset = await global.SharedAssets?.get?.(assetId);
        const detail = await describeAttachmentAsset(asset, existing || { assetId });
        if (detail.status !== 'ready') {
            notify(detail.statusText || '这份资料暂时不能用于摘要桥接');
            await renderAttachments(session);
            return;
        }
        const readingSession = typeof global.Reading?.getSession === 'function'
            ? await global.Reading.getSession(state.characterId, detail.document.id)
            : null;
        const reference = core().normalizeAttachmentReference({
            assetId,
            segmentIndex: existing?.segmentIndex ?? readingSession?.segmentIndex ?? 0,
            segmentOffset: existing?.segmentOffset || 0,
        });
        if (!reference) return;
        if (global.SharedAssets?.attach) {
            const result = await global.SharedAssets.attach(assetId, {
                id: attachmentReferenceId(session.id, assetId),
                ownerType: 'collaboration-session', ownerId: session.id, role: 'attachment', createdAt: Date.now(),
            });
            if (!result?.success) throw new Error('共享资产引用挂载失败');
        }
        await saveSession({
            ...session,
            attachmentRefs: [...refs.filter(item => item.assetId !== assetId), reference],
            updatedAt: Date.now(),
        });
        await render();
    }

    async function updateAttachmentSegment(assetId, rawValue) {
        const session = await getSession();
        if (!session || !assetId) return;
        const refs = selectedAttachmentRefs(session);
        const current = refs.find(reference => reference.assetId === assetId);
        if (!current) return;
        const asset = await global.SharedAssets?.get?.(assetId);
        const detail = await describeAttachmentAsset(asset, current);
        if (detail.status !== 'ready') {
            notify(detail.statusText || '这份资料暂时不能定位章节');
            await renderAttachments(session);
            return;
        }
        const reference = core().normalizeAttachmentReference({
            ...current,
            segmentIndex: Math.max(0, Number(rawValue) - 1 || 0),
        });
        await saveSession({
            ...session,
            attachmentRefs: refs.map(item => item.assetId === assetId ? reference : item),
            updatedAt: Date.now(),
        });
        await render();
    }

    async function requestTurn(character, session, messages) {
        const result = resolveApi(character);
        if (!result.enabled || !result.configured) {
            if (result.reason === 'disabled') throw new Error('当前角色的协同 API 已关闭');
            throw new Error('请先为当前角色配置协同 API 地址和模型');
        }
        const config = result.config || {};
        if (!config.url || !config.model) throw new Error('协同 API 地址和模型不能为空');
        if (typeof global.fetchAiResponse !== 'function') throw new Error('协同请求服务尚未加载');
        const attachmentBridge = await buildAttachmentContexts(session);
        const apiMessages = core().buildApiMessages(character, session, messages, { attachmentSummaries: attachmentBridge.summaries });
        const stream = config.streamEnabled === true;
        const body = { model: config.model, messages: apiMessages, stream };
        const endpoint = typeof global.getApiConfigEndpoint === 'function'
            ? global.getApiConfigEndpoint(config, stream)
            : `${String(config.url).replace(/\/$/, '')}/v1/chat/completions`;
        const headers = typeof global.getApiConfigHeaders === 'function'
            ? global.getApiConfigHeaders(config)
            : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key || ''}` };
        const response = await global.fetchAiResponse(config, body, headers, endpoint, stream);
        const content = core().normalizeMessage({ role: 'assistant', content: response }).content;
        if (!content) throw new Error('协同 API 未返回有效内容');
        return { content, attachmentIssues: attachmentBridge.issues };
    }

    function setTurnStatus(message, kind = '') {
        const status = byId('collaboration-turn-status');
        if (!status) return;
        status.textContent = message || '';
        status.classList.toggle('is-error', kind === 'error');
        status.classList.toggle('is-busy', kind === 'busy');
    }

    async function sendTurn() {
        if (state.busy) return;
        const input = byId('collaboration-composer');
        const content = input?.value.trim() || '';
        if (!content) return;
        const session = await getSession();
        const character = characterFor(state.characterId);
        if (!session || !character) return notify('请先选择协同角色和会话');
        state.busy = true;
        if (input) input.value = '';
        setTurnStatus('正在发送…', 'busy');
        try {
            await saveMessage({ sessionId: session.id, role: 'user', content, createdAt: Date.now() });
            renderMessages(await listMessages(session.id));
            const response = await requestTurn(character, session, await listMessages(session.id));
            await saveMessage({ sessionId: session.id, role: 'assistant', content: response.content, createdAt: Date.now() });
            await render();
            setTurnStatus(response.attachmentIssues?.length
                ? `本回合已保存；${response.attachmentIssues.length} 项资料未能桥接摘要`
                : '本回合已保存到协同会话');
        } catch (error) {
            console.error('[Collaboration] turn failed:', error);
            setTurnStatus(apiErrorMessage(error), 'error');
            notify(apiErrorMessage(error));
        } finally {
            state.busy = false;
        }
    }

    async function render() {
        const sessions = await listSessions();
        let session = sessions.find(item => item.id === state.sessionId) || sessions[0];
        if (!session) session = await createSession(state.characterId);
        state.sessionId = session.id;
        const title = byId('collaboration-title');
        if (title) title.textContent = session.title;
        const character = characterFor(state.characterId);
        const name = byId('collaboration-character-name');
        if (name) name.textContent = character?.name || character?.charName || '角色';
        renderSessions(await listSessions());
        renderMode(session);
        if (global.SharedDocuments?.renderSession) await global.SharedDocuments.renderSession(session);
        await renderAttachments(session);
        renderMessages(await listMessages(session.id));
        renderApiSettings(character);
    }

    async function open(characterId = global.currentChatId, returnScreen = 'chat-room-screen') {
        const type = currentType();
        if (type && type !== 'private') return notify('协同工作目前只支持角色私聊');
        if (!characterId || !characterFor(characterId)) return notify('请先打开一个角色聊天');
        if (!table('collaborationSessions') || !table('collaborationMessages')) return notify('协同会话数据表尚未就绪，请刷新 Mio');
        state.characterId = String(characterId);
        state.returnScreen = returnScreen || 'chat-room-screen';
        state.sessionId = '';
        if (typeof global.switchScreen === 'function') global.switchScreen('collaboration-screen');
        else if (typeof switchScreen === 'function') switchScreen('collaboration-screen');
        await render();
    }

    async function selectSession(sessionId) {
        const session = await getSession(sessionId);
        if (!session || session.characterId !== state.characterId) return;
        state.sessionId = session.id;
        await render();
    }

    async function changeMode(mode) {
        const session = await getSession();
        if (!session || !core().MODES.includes(mode)) return;
        await saveSession({ ...session, mode, updatedAt: Date.now() });
        await render();
    }

    async function newSession() {
        if (state.busy) return;
        state.busy = true;
        try {
            const character = characterFor(state.characterId);
            const suggested = `与 ${character?.name || character?.charName || '角色'} 协同`;
            const title = typeof global.prompt === 'function' ? global.prompt('协同会话名称', suggested) : suggested;
            if (title === null) return;
            const session = await createSession(state.characterId, { title: title.trim() || suggested });
            state.sessionId = session.id;
            await render();
        } catch (error) {
            console.error('创建协同会话失败:', error);
            notify(error?.message || '创建协同会话失败');
        } finally {
            state.busy = false;
        }
    }

    async function runAttachmentAction(action) {
        try {
            await action();
        } catch (error) {
            console.error('[Collaboration] attachment action failed:', error);
            notify(apiErrorMessage(error));
            await render();
        }
    }

    function setup() {
        byId('collaboration-new-btn')?.addEventListener('click', () => void newSession());
        byId('collaboration-send-btn')?.addEventListener('click', () => void sendTurn());
        byId('collaboration-api-save-btn')?.addEventListener('click', () => void saveApiSettings());
        byId('collaboration-session-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-collaboration-session]');
            if (button) void selectSession(button.dataset.collaborationSession);
        });
        byId('collaboration-attachment-list')?.addEventListener('change', event => {
            const toggle = event.target.closest('[data-collaboration-attachment-toggle]');
            if (toggle) {
                void runAttachmentAction(() => setAttachmentSelection(toggle.dataset.collaborationAttachmentToggle, toggle.checked));
                return;
            }
            const segment = event.target.closest('[data-collaboration-attachment-segment]');
            if (segment) void runAttachmentAction(() => updateAttachmentSegment(segment.dataset.collaborationAttachmentSegment, segment.value));
        });
        byId('collaboration-attachment-list')?.addEventListener('click', event => {
            const remove = event.target.closest('[data-collaboration-attachment-remove]');
            if (remove) void runAttachmentAction(() => setAttachmentSelection(remove.dataset.collaborationAttachmentRemove, false));
        });
        byId('collaboration-composer')?.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void sendTurn();
            }
        });
        document.querySelectorAll('[data-collaboration-mode]').forEach(button => {
            button.addEventListener('click', () => void changeMode(button.dataset.collaborationMode));
        });
    }

    global.Collaboration = Object.freeze({ VERSION: 3, setup, open, render, listSessions, getSession, listMessages, saveSession, saveMessage, createSession, sendTurn, buildAttachmentContexts });
}(typeof window !== 'undefined' ? window : globalThis));
