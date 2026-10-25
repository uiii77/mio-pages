(function attachReadingModule(global) {
    'use strict';

    const state = { characterId: '', documentId: '', busy: false, aiBusy: false, speechRequest: 0, speechKey: '', pendingAnchor: null, pendingQuote: '' };
    function core() { return global.ReadingCore; }
    function table(name) { return global.dexieDB?.[name]; }
    function notify(message, duration) { if (typeof global.showToast === 'function') global.showToast(message, duration); }
    function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
    function tts() { return global.TTSService || global.MinimaxTTSService || null; }
    function speechKey(session) { return core().makeSpeechKey(state.characterId, state.documentId, session?.segmentIndex); }
    function speechState() { return tts()?.getPlayState?.() || { currentPlayKey: null, isPlaying: false, isPaused: false }; }

    function updateSpeechControls() {
        const button = documentRef('reading-speak-btn');
        const stop = documentRef('reading-speak-stop-btn');
        if (!button || !stop) return;
        const current = speechState();
        const active = !!state.speechKey && current.currentPlayKey === state.speechKey && current.isPlaying;
        button.textContent = active && current.isPaused ? '继续朗读' : (active ? '暂停朗读' : '朗读本段');
        button.setAttribute('aria-label', button.textContent);
        button.disabled = state.busy;
        stop.disabled = !current.isPlaying && !state.speechKey;
    }

    function stopSpeech() {
        state.speechRequest += 1;
        state.speechKey = '';
        tts()?.stop?.();
        updateSpeechControls();
    }

    async function speakCurrentSegment() {
        const document = await getDocument(state.documentId);
        const session = document && await getSession(state.characterId, state.documentId);
        const chunk = document && session && await getChunk(document.id, session.segmentIndex);
        const text = core().speechText(chunk?.text);
        const service = tts();
        if (!document || !session || !text) return notify('这一段没有可朗读的正文');
        if (!service?.synthesizeAndPlay) return notify('朗读服务尚未就绪，请重新打开 Mio');

        const key = speechKey(session);
        const current = speechState();
        if (current.currentPlayKey === key && current.isPlaying) {
            service.togglePause?.();
            updateSpeechControls();
            return;
        }

        stopSpeech();
        const voice = global.VoiceSelector?.getVoiceConfig?.(state.characterId, 'char') || {};
        const request = ++state.speechRequest;
        state.speechKey = key;
        updateSpeechControls();
        try {
            const completed = await service.synthesizeAndPlay(text, voice.voiceId || '', voice.language || 'auto', {
                speed: voice.speed,
                playKey: key,
                chatId: state.characterId,
                messageId: key,
            });
            if (request === state.speechRequest && completed !== false) state.speechKey = '';
        } catch (error) {
            if (request === state.speechRequest) {
                state.speechKey = '';
                notify(error?.message || '本段朗读失败');
            }
        } finally {
            if (request === state.speechRequest) updateSpeechControls();
        }
    }

    async function listDocuments() {
        if (!table('readingDocuments')) return [];
        return (await table('readingDocuments').toArray()).map(core().normalizeDocument).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function listLibraryEntries(characterId) {
        if (!table('readingLibraryEntries') || !String(characterId || '').trim()) return [];
        const rows = await table('readingLibraryEntries').where('characterId').equals(String(characterId)).toArray();
        return rows.map(item => core().normalizeLibraryEntry(item)).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function getLibraryEntry(characterId, documentId) {
        const id = core().makeLibraryEntryId(characterId, documentId);
        const row = await table('readingLibraryEntries')?.get(id);
        const document = await getDocument(documentId);
        return row && document ? core().normalizeLibraryEntry(row, document) : null;
    }

    async function saveLibraryEntry(value) {
        const document = await getDocument(value?.documentId);
        if (!document) throw new Error('阅读文档不存在');
        const previous = await getLibraryEntry(value.characterId, value.documentId);
        const normalized = core().normalizeLibraryEntry({ ...previous, ...value, updatedAt: Date.now() }, document);
        await table('readingLibraryEntries').put(normalized);
        return normalized;
    }

    async function ensureLibraryEntry(characterId, documentId, changes = {}) {
        const existing = await getLibraryEntry(characterId, documentId);
        return saveLibraryEntry({ ...(existing || { characterId, documentId }), ...changes });
    }

    function currentCharacterName() {
        return global.db?.characters?.find?.(item => String(item.id) === state.characterId)?.name || '角色';
    }

    function currentCharacter() {
        return global.db?.characters?.find?.(item => String(item.id) === state.characterId) || null;
    }

    function apiConfigId(characterId) {
        const safe = String(characterId || 'role').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 53) || 'role';
        return `reading-${safe}`;
    }

    function featureBinding(character) {
        return character?.featureApiBindings?.reading || character?.apiFeatureBindings?.reading || null;
    }

    function resolveReadingApi(character) {
        if (!global.FeatureApiRegistry) return { configured: false, enabled: false, reason: 'registry-unavailable' };
        return global.FeatureApiRegistry.resolve('reading', { context: character, registry: global.db?.apiFeatureRegistry });
    }

    function apiStateText(result) {
        if (result?.configured) return result.enabled ? `已配置 · ${result.config?.model || '默认模型'}` : '已关闭';
        if (result?.reason === 'disabled') return '已关闭';
        if (result?.reason === 'config-missing') return '已启用，但配置档不存在';
        if (result?.reason === 'registry-unavailable') return '独立 API 注册表不可用';
        return '未配置，不会调用';
    }

    function persistGlobal(keys) {
        if (typeof global.saveGlobalSettings === 'function') return global.saveGlobalSettings(keys);
        try { if (typeof saveGlobalSettings === 'function') return saveGlobalSettings(keys); } catch (_) { /* lexical binding unavailable */ }
        return Promise.resolve(false);
    }

    function renderApiSettings() {
        const character = currentCharacter();
        if (!character) return;
        const result = resolveReadingApi(character);
        const binding = featureBinding(character) || {};
        const registry = global.FeatureApiRegistry?.readRegistry(global.db) || { configs: {}, routes: {} };
        const config = registry.configs[binding.configId] || result.config || {};
        const enabled = documentRef('reading-api-enabled');
        if (enabled) enabled.checked = binding.enabled === true;
        const url = documentRef('reading-api-url'); if (url) url.value = config.url || config.baseUrl || '';
        const key = documentRef('reading-api-key'); if (key) key.value = config.key || config.apiKey || '';
        const model = documentRef('reading-api-model'); if (model) model.value = config.model || '';
        const status = documentRef('reading-api-status'); if (status) status.textContent = apiStateText(result);
    }

    async function saveApiSettings() {
        const character = currentCharacter();
        if (!character) throw new Error('当前角色不存在');
        const configId = featureBinding(character)?.configId || apiConfigId(character.id);
        const config = {
            id: configId, name: `角色共读 · ${character.name || character.charName || '角色'}`,
            feature: 'reading', service: 'llm', provider: 'newapi',
            url: documentRef('reading-api-url')?.value.trim() || '',
            key: documentRef('reading-api-key')?.value.trim() || '',
            model: documentRef('reading-api-model')?.value.trim() || '', enabled: true,
        };
        let registry = global.FeatureApiRegistry?.readRegistry(global.db) || { configs: {}, routes: {} };
        if (config.url || config.key || config.model) registry = global.FeatureApiRegistry.upsertConfig(registry, config, configId);
        global.db.apiFeatureRegistry = registry;
        await persistGlobal(['apiFeatureRegistry']);
        character.featureApiBindings = { ...(character.featureApiBindings || {}), reading: {
            enabled: documentRef('reading-api-enabled')?.checked === true, configId, fallbackMode: 'none',
        } };
        if (typeof global.saveCharacter === 'function') await global.saveCharacter(character.id);
        renderApiSettings();
        notify('角色共读 API 设置已保存');
    }

    async function listAnnotations(characterId, documentId, options = {}) {
        if (!table('readingAnnotations')) return [];
        const document = await getDocument(documentId);
        if (!document) return [];
        const rows = await table('readingAnnotations').where('characterId').equals(String(characterId || '')).toArray();
        const annotations = rows
            .filter(item => item.documentId === document.id && (options.includeDeleted || item.status !== 'deleted'))
            .map(item => core().normalizeAnnotation(item, document))
            .sort((a, b) => a.createdAt - b.createdAt);
        const chunks = new Map();
        for (const annotation of annotations) {
            if (annotation.anchorStatus !== 'valid') continue;
            const index = annotation.anchor.segmentIndex;
            if (!chunks.has(index)) chunks.set(index, await getChunk(document.id, index));
            const chunk = chunks.get(index);
            annotation.anchor = core().validateAnchor(annotation.anchor, document, chunk);
            if (!chunk) annotation.anchor.status = 'needs-relocation';
            annotation.anchorStatus = annotation.anchor.status;
        }
        return annotations;
    }

    async function saveAnnotation(value) {
        const document = await getDocument(value?.documentId);
        if (!document) throw new Error('阅读文档不存在');
        const normalized = core().normalizeAnnotation({ ...value, updatedAt: Date.now() }, document);
        const chunk = await getChunk(document.id, normalized.anchor.segmentIndex);
        normalized.anchor = core().validateAnchor(normalized.anchor, document, chunk);
        normalized.anchorStatus = normalized.anchor.status;
        if (!normalized.characterId || normalized.anchorStatus !== 'valid' || !chunk) throw new Error('批注锚点已失效，请重新选择正文');
        const quote = String(chunk.text || '').slice(normalized.anchor.startOffset, normalized.anchor.endOffset);
        if (!quote || quote !== normalized.quote || core().hashQuote(quote) !== normalized.anchor.quoteHash) throw new Error('所选正文已变化，请重新选择');
        if (normalized.kind !== 'highlight' && !normalized.content) throw new Error('请输入笔记或批注内容');
        await table('readingAnnotations').put(normalized);
        return normalized;
    }

    async function deleteAnnotation(annotationId) {
        const row = await table('readingAnnotations')?.get(String(annotationId || ''));
        if (!row || row.characterId !== state.characterId) return false;
        await table('readingAnnotations').delete(row.id);
        return true;
    }

    function setAiStatus(message, kind = '') {
        const status = documentRef('reading-ai-status');
        if (status) {
            status.textContent = message || '';
            status.classList.toggle('is-error', kind === 'error');
            status.classList.toggle('is-busy', kind === 'busy');
        }
        ['reading-ai-annotation-btn', 'reading-discussion-send-btn', 'reading-study-generate'].forEach(id => {
            const button = documentRef(id);
            if (button) button.disabled = state.aiBusy;
        });
    }

    function setStudyStatus(message, kind = '') {
        const status = documentRef('reading-study-status');
        if (status) {
            status.textContent = message || '';
            status.classList.toggle('is-error', kind === 'error');
            status.classList.toggle('is-busy', kind === 'busy');
        }
        ['reading-ai-annotation-btn', 'reading-discussion-send-btn', 'reading-study-generate'].forEach(id => {
            const button = documentRef(id);
            if (button) button.disabled = state.aiBusy;
        });
    }

    function readingAiClient() {
        const character = currentCharacter();
        const result = resolveReadingApi(character);
        if (!result.enabled || !result.configured) {
            if (result.reason === 'disabled') throw new Error('当前角色的共读 API 已关闭');
            throw new Error('请先在角色共读中配置并启用 API');
        }
        const config = { ...(result.config || {}) };
        if (!config.url || !config.model) throw new Error('角色共读 API 地址和模型不能为空');
        if (typeof global.fetchAiResponse !== 'function') throw new Error('AI 请求服务尚未加载');
        let persona = character?.persona || '';
        try { if (typeof global.getEffectivePersona === 'function') persona = global.getEffectivePersona(character) || persona; } catch (_) { /* retain stored persona */ }
        return { character, config, persona };
    }

    async function callReadingAi(client, messages, maxTokens = 900) {
        const { config } = client;
        await client.guard?.();
        const response = await global.fetchAiResponse(config, {
            model: config.model, messages, temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.6,
            max_tokens: maxTokens, stream: false,
        }, headersFor(config), endpointFor(config), false,{signal:client.signal,beforeRequest:client.guard,isAllowed:()=>!client.signal?.aborted});
        await client.guard?.();
        const content = core().normalizeAiText(response,client.maxChars||4000);
        if (!content) throw new Error('角色共读 API 未返回有效内容');
        return content;
    }

    function endpointFor(config) {
        return typeof global.getApiConfigEndpoint === 'function'
            ? global.getApiConfigEndpoint(config, false)
            : `${String(config.url || config.baseUrl || '').replace(/\/$/, '')}/v1/chat/completions`;
    }

    function headersFor(config) {
        return typeof global.getApiConfigHeaders === 'function'
            ? global.getApiConfigHeaders(config)
            : { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) };
    }

    async function requestInteraction(mode,details,options={}){
        const safe=await guardReadingContext(details),client=readingAiClient();client.signal=options.signal;
        client.guard=async()=>{if(options.signal?.aborted)throw Error('REQUEST_CANCELLED');await safe.guard();await options.guard?.();};
        const sourceText=String(safe.details.chunk?.text||'');if(!sourceText.trim()&&mode!=='free-chat')throw Error('当前为图片或空段落，请手动推进，不能推断未提供的画面');
        const scope=await global.SharedAssets.digest(sourceText),history=await options.history?.(scope)||[];
        const messages=global.ReadingPlayCore.messages(mode,{roleName:client.character?.realName||client.character?.name,persona:client.persona,sourceText:sourceText||'当前为图片，未提供图片像素。',question:details.question,history});
        const content=await callReadingAi(client,messages,1400);
        return {content,scope,context:safe.preview?{campaignId:safe.preview.campaignId,revision:safe.preview.revision}:null,guard:client.guard};
    }
    async function configureWorkspace(characterId,documentId,patch,expectedVersion){
        const existing=await getSession(characterId,documentId);if(!existing)throw Error('阅读会话不存在');
        return global.dexieDB.transaction('rw',table('readingSessions'),async()=>{const record=await table('readingSessions').get(existing.id)||existing,previous=global.ReadingPlayCore.settings(record.workspace);if(previous.version!==expectedVersion||previous.version===Number.MAX_SAFE_INTEGER)throw Error('玩法设置已更新，请重新打开');const workspace=global.ReadingPlayCore.settings({...previous,...patch,schemaVersion:Math.max(previous.schemaVersion,patch.tutor?2:patch.schemaVersion||previous.schemaVersion),version:previous.version+1});await table('readingSessions').put({...record,workspace});return workspace;});
    }
    async function requestReadingAi(mode, details) {
        const safe=await guardReadingContext(details);details=safe.details;
        if (!String(details?.chunk?.text || '').trim()) throw new Error('当前内容为图片，请选择有文字的段落进行共读');
        const client = readingAiClient();
        const { character, persona } = client;
        client.guard=safe.guard;
        const messages = core().buildAiMessages(mode, {
            roleName: character?.remarkName || character?.name || '角色', persona,
            title: details.document.title, segmentIndex: details.session.segmentIndex,
            segmentText: details.chunk.text, quote: details.quote, question: details.question,
        });
        return callReadingAi(client, messages, 900);
    }

    async function currentReadingDetails() {
        const document = await getDocument(state.documentId);
        const session = document && await getSession(state.characterId, state.documentId);
        const chunk = document && session && await getChunk(document.id, session.segmentIndex);
        return document && session && chunk ? { document, session, chunk } : null;
    }

    function partitionStudyText(parts, maxChars = 8000) {
        const batches = [];
        let current = '';
        for (const part of parts) {
            const text = String(part || '');
            if (!text) continue;
            if (current && current.length + text.length + 2 > maxChars) { batches.push(current); current = ''; }
            if (text.length > maxChars) {
                if (current) { batches.push(current); current = ''; }
                for (let offset = 0; offset < text.length; offset += maxChars) batches.push(text.slice(offset, offset + maxChars));
            } else current = current ? `${current}\n\n${text}` : text;
        }
        if (current) batches.push(current);
        return batches;
    }

    async function buildStudyContext(scope, details) {
        if (scope === 'selection') {
            if (!state.pendingAnchor || !state.pendingQuote || state.pendingAnchor.segmentIndex !== details.session.segmentIndex) throw new Error('请先选择当前段落中的原文');
            const anchor = core().validateAnchor(state.pendingAnchor, details.document, details.chunk);
            if (anchor.status !== 'valid' || details.chunk.text.slice(anchor.startOffset, anchor.endOffset) !== state.pendingQuote) throw new Error('当前选区已失效，请重新选择');
            return {
                scope:'selection',scopeLabel:`第 ${details.session.segmentIndex + 1} 段的用户选区`,batches:[state.pendingQuote],
                anchor:{...anchor},quote:state.pendingQuote,chapterId:details.chunk.chapterId || '',
                startIndex:details.session.segmentIndex,endIndex:details.session.segmentIndex + 1,inputChars:state.pendingQuote.length,
            };
        }
        const chapter = details.document.chapters.find(item => details.session.segmentIndex >= item.startIndex && details.session.segmentIndex < item.endIndex);
        if (!chapter) throw new Error('这份读物没有可定位的章节结构，请改用当前选区');
        const parts = [];
        let anchorChunk = null;
        for (let index = chapter.startIndex; index < chapter.endIndex; index += 1) {
            const chunk = await getChunk(details.document.id, index);
            if (!chunk) throw new Error('章节内容已变化，请重新打开读物');
            if (String(chunk.text || '').trim()) {
                parts.push(`[第 ${index + 1} 段 · ${chunk.blockId}]\n${chunk.text}`);
                if (!anchorChunk) anchorChunk = chunk;
            } else if (chunk.kind === 'image') {
                parts.push(`[图片引用 · 第 ${index + 1} 段 · ${chunk.blockId} · ${chunk.alt || '无替代文字'}]`);
            }
        }
        if (!anchorChunk) throw new Error('当前章节没有可供总结的文字');
        const quote = anchorChunk.text.slice(0, Math.min(120, anchorChunk.text.length));
        return {
            scope:'chapter',scopeLabel:`章节“${chapter.title || chapter.id}”`,batches:partitionStudyText(parts),
            anchor:core().makeAnchor(details.document,anchorChunk.index,0,quote.length,quote,anchorChunk),quote,
            chapterId:chapter.id,startIndex:chapter.startIndex,endIndex:chapter.endIndex,
            inputChars:parts.reduce((sum,part)=>sum+part.length,0),
        };
    }

    async function requestStudyAi(mode, context, details, onProgress, options={}) {
        const safe=await guardReadingContext(details);details=safe.details;context={...context,batches:[...context.batches]};if(safe.preview)context={...context,batches:[safe.preview.text],scopeLabel:'角色已知的剧情内容'};
        const client=readingAiClient(),{character,persona}=client;client.signal=options.signal;client.maxChars=mode==='lecture'?50000:mode==='tutor'?12000:4000;
        client.guard=async()=>{if(options.signal?.aborted)throw Error('REQUEST_CANCELLED');await safe.guard();await options.guard?.();};
        const scope=await global.SharedAssets.digest(context.batches.join('\n\n')),history=await options.history?.(scope)||[];
        const finish=data=>({...data,scope,context:safe.preview?{campaignId:safe.preview.campaignId,revision:safe.preview.revision}:null,guard:client.guard});
        let requestCount=0;
        const ask=async(promptMode,sourceText,maxTokens)=>{
            requestCount++;onProgress?.(requestCount);
            return callReadingAi(client,core().buildStudyMessages(promptMode,{roleName:character?.realName||character?.remarkName||character?.name||'学习导师',persona,title:details.document.title,scopeLabel:context.scopeLabel,sourceText,question:context.question,style:context.style,history}),maxTokens);
        };
        const prompt=mode==='lecture'?'lecture':mode==='tutor'?'tutor':mode==='explanation'?'explanation':'summary';
        if(context.batches.length===1)return finish({content:await ask('study-'+prompt,context.batches[0],['tutor','lecture'].includes(mode)?2200:mode==='explanation'?1400:1100),requestCount});
        let notes=[];
        for(let index=0;index<context.batches.length;index++)notes.push(await ask('study-extract',`分片 ${index+1} / ${context.batches.length}\n${context.batches[index]}`,650));
        while(notes.join('\n\n').length>14000){const groups=partitionStudyText(notes.map((note,index)=>`摘记 ${index+1}\n${note}`),12000),reduced=[];for(const group of groups)reduced.push(await ask('study-extract',group,650));notes=reduced;}
        return finish({content:await ask('study-synthesis-'+prompt,notes.map((note,index)=>`分片摘记 ${index+1}\n${note}`).join('\n\n'),['tutor','lecture'].includes(mode)?2200:mode==='explanation'?1400:1100),requestCount});
    }
    async function prepareTeachingContext(scope,details,anchor){
        if(scope==='chapter')return buildStudyContext('chapter',details);
        const chunk=details.chunk;if(!chunk?.text?.trim())throw Error('当前段落没有可供讲解的文字');
        let sourceText=chunk.text,selected=core().makeAnchor(details.document,chunk.index,0,sourceText.length,sourceText,chunk);
        if(scope==='selection'){
            selected=core().validateAnchor(anchor,details.document,chunk);if(selected.status!=='valid'||selected.segmentIndex!==details.session.segmentIndex)throw Error('选区已失效，请重新选择');
            sourceText=chunk.text.slice(selected.startOffset,selected.endOffset);if(!sourceText||core().hashQuote(sourceText)!==selected.quoteHash)throw Error('选区内容已变化');
        }else if(scope!=='paragraph')throw Error('未知讲解范围');
        return {scope,scopeLabel:scope==='selection'?'用户选中的原文':'当前段落',batches:partitionStudyText([sourceText]),anchor:selected,quote:sourceText,startIndex:chunk.index,endIndex:chunk.index+1,inputChars:sourceText.length};
    }

    async function listStudyNotes(characterId, documentId) {
        return (await listAnnotations(characterId,documentId)).filter(item => item.kind === 'study-summary' || item.kind === 'study-explanation').sort((a,b)=>b.createdAt-a.createdAt);
    }

    async function generateStudyNote() {
        if (state.aiBusy) return;
        const details = await currentReadingDetails();
        if (!details) return notify('当前内容暂时无法读取');
        const scope = documentRef('reading-study-scope')?.value === 'chapter' ? 'chapter' : 'selection';
        const mode = documentRef('reading-study-mode')?.value === 'explanation' ? 'explanation' : 'summary';
        const snapshot = {characterId:state.characterId,documentId:state.documentId,segmentIndex:details.session.segmentIndex};
        state.aiBusy = true;
        setStudyStatus('正在准备明确选择的学习范围…','busy');
        try {
            const context = await buildStudyContext(scope,details);
            setStudyStatus(`将读取 ${context.inputChars.toLocaleString()} 字，正在发起第 1 次请求…`,'busy');
            const result = await requestStudyAi(mode,context,details,count=>setStudyStatus(`已读取 ${context.inputChars.toLocaleString()} 字，正在执行第 ${count} 次请求…`,'busy'));
            if (state.characterId !== snapshot.characterId || state.documentId !== snapshot.documentId) throw new Error('读物已切换，本次结果未保存');
            await saveAnnotation({
                characterId:snapshot.characterId,documentId:snapshot.documentId,
                kind:mode === 'explanation' ? 'study-explanation' : 'study-summary',
                authorId:snapshot.characterId,authorName:currentCharacterName(),visibility:'private',source:'ai',
                content:result.content,quote:context.quote,anchor:context.anchor,studyScope:context.scope,
                studyChapterId:context.chapterId,contextStartIndex:context.startIndex,contextEndIndex:context.endIndex,
                inputChars:context.inputChars,requestCount:result.requestCount,
            });
            setStudyStatus(`学习结果已保存 · 读取 ${context.inputChars.toLocaleString()} 字 · ${result.requestCount} 次请求`);
            await renderStudyNotes(snapshot.characterId,snapshot.documentId);
        } catch (error) {
            setStudyStatus(error?.message || '学习内容生成失败','error');
        } finally {
            state.aiBusy = false;
            setStudyStatus(documentRef('reading-study-status')?.textContent || '');
        }
    }

    async function generateSelectedAnnotation() {
        if (state.aiBusy) return;
        if (!state.pendingAnchor || !state.pendingQuote) return notify('请先选择当前段落中的原文');
        const snapshot = { characterId: state.characterId, documentId: state.documentId, anchor: { ...state.pendingAnchor }, quote: state.pendingQuote };
        const details = await currentReadingDetails();
        if (!details || details.session.segmentIndex !== snapshot.anchor.segmentIndex) return notify('当前段落已变化，请重新选择');
        state.aiBusy = true;
        setAiStatus('角色正在阅读所选文字…', 'busy');
        try {
            const content = await requestReadingAi('annotation', { ...details, quote: snapshot.quote });
            const current = await currentReadingDetails();
            if (state.characterId !== snapshot.characterId || state.documentId !== snapshot.documentId || current?.session.segmentIndex !== snapshot.anchor.segmentIndex) throw new Error('阅读位置已变化，本次结果未保存');
            await saveAnnotation({
                characterId: snapshot.characterId, documentId: snapshot.documentId, kind: 'character-annotation',
                authorId: snapshot.characterId, authorName: currentCharacterName(), visibility: 'shared', source: 'ai',
                content, quote: snapshot.quote, anchor: snapshot.anchor,
            });
            state.pendingAnchor = null; state.pendingQuote = '';
            setAiStatus('AI 批注已保存，并标记为 AI 生成。');
            const latest = await currentReadingDetails();
            if (latest) await renderReader(latest.document, latest.session);
        } catch (error) {
            setAiStatus(error?.message || 'AI 批注生成失败', 'error');
        } finally {
            state.aiBusy = false;
            setAiStatus(documentRef('reading-ai-status')?.textContent || '');
        }
    }

    async function sendDiscussion() {
        if (state.aiBusy) return;
        const input = documentRef('reading-discussion-input');
        const question = input?.value.trim() || '';
        if (!question) return notify('请先写下想和角色讨论的问题');
        const details = await currentReadingDetails();
        if (!details) return notify('当前段落暂时无法读取');
        const snapshot = { characterId: state.characterId, documentId: state.documentId, segmentIndex: details.session.segmentIndex };
        const quote = state.pendingAnchor?.segmentIndex === details.session.segmentIndex
            ? state.pendingQuote
            : String(details.chunk.text || '').slice(0, Math.min(240, String(details.chunk.text || '').length));
        const anchor = state.pendingAnchor?.segmentIndex === details.session.segmentIndex
            ? { ...state.pendingAnchor }
            : core().makeAnchor(details.document, details.session.segmentIndex, 0, quote.length, quote, details.chunk);
        state.aiBusy = true;
        setAiStatus('角色正在回应当前段落…', 'busy');
        try {
            const content = await requestReadingAi('discussion', { ...details, question });
            const current = await currentReadingDetails();
            if (state.characterId !== snapshot.characterId || state.documentId !== snapshot.documentId || current?.session.segmentIndex !== snapshot.segmentIndex) throw new Error('阅读位置已变化，本次结果未保存');
            const threadId = core().makeAnnotationId();
            const userRecord = await saveAnnotation({
                characterId: snapshot.characterId, documentId: snapshot.documentId, kind: 'discussion-user',
                authorId: 'user', authorName: '我', visibility: 'shared', source: 'manual', content: question,
                quote, anchor, threadId,
            });
            try {
                await saveAnnotation({
                    characterId: snapshot.characterId, documentId: snapshot.documentId, kind: 'discussion-character',
                    authorId: snapshot.characterId, authorName: currentCharacterName(), visibility: 'shared', source: 'ai', content,
                    quote, anchor, threadId, replyToId: userRecord.id,
                });
            } catch (error) {
                await table('readingAnnotations').delete(userRecord.id);
                throw error;
            }
            if (input) input.value = '';
            setAiStatus('这一轮共读讨论已保存。');
            const latest = await currentReadingDetails();
            if (latest) await renderReader(latest.document, latest.session);
        } catch (error) {
            setAiStatus(error?.message || '共读讨论失败', 'error');
        } finally {
            state.aiBusy = false;
            setAiStatus(documentRef('reading-ai-status')?.textContent || '');
        }
    }

    async function getDocument(documentId) {
        const row = await table('readingDocuments')?.get(String(documentId || ''));
        return row ? core().normalizeDocument(row) : null;
    }

    async function getDocumentByAssetId(assetId) {
        if (!assetId || !table('readingDocuments')) return null;
        const row = await table('readingDocuments').where('assetId').equals(String(assetId)).first();
        return row ? core().normalizeDocument(row) : null;
    }

    async function getChunk(documentId, index) {
        const row = await table('readingDocumentChunks')?.get(`${documentId}:${index}`);
        if (!row) return null;
        const document = await getDocument(documentId);
        return document ? core().normalizeChunk(row, document) : null;
    }

    async function getSession(characterId, documentId) {
        const id = core().makeSessionId(characterId, documentId);
        const row = await table('readingSessions')?.get(id);
        const document = await getDocument(documentId);
        if (!document) return null;
        const links=(await table('globalSettings')?.get('mioTrpgReadingLinksV1'))?.value;
        if(links)core().normalizeTrpgLinks(links);
        const link=links?.links?.[id];
        const source = {...(row || {characterId,documentId}),...(link?{trpgCampaignId:link.campaignId,trpgBindingRevision:link.version}:{})};
        const session = core().normalizeSession(source, document);
        const chunk = await getChunk(documentId, session.segmentIndex);
        const normalized = core().normalizeSession(source, document, chunk);
        if (!chunk) normalized.anchor.status = 'needs-relocation';
        return normalized;
    }

    async function bindCampaign(characterId,documentId,campaignId){
        const session=await getSession(characterId,documentId);if(!session||!campaignId)throw Error('请选择阅读文档和对应跑团');
        return global.dexieDB.transaction('rw',[table('readingSessions'),table('globalSettings'),table('trpgCampaigns')],async()=>{
            const campaign=await global.CoC7.get(campaignId);if(!campaign.cards.some(card=>card.characterId===String(characterId)))throw Error('此角色尚未参与所选跑团');
            const key='mioTrpgReadingLinksV1',stored=(await table('globalSettings').get(key))?.value||{version:1,links:{}};core().normalizeTrpgLinks(stored);
            const old=stored.links[session.id],link={characterId:String(characterId),documentId,campaignId,version:(old?.version||0)+1};
            await table('globalSettings').put({key,value:{version:1,links:{...stored.links,[session.id]:link}}});
            const current=await table('readingSessions').get(session.id)||session;await table('readingSessions').put({...current,trpgCampaignId:campaignId,trpgBindingRevision:link.version});return link;
        });
    }
    async function guardReadingContext(details){
        const actorId=state.characterId,documentId=details.document.id,viewDocumentId=state.documentId;
        const assertActor=()=>{if(state.characterId!==actorId||state.documentId!==viewDocumentId)throw Error('阅读角色或文档已变化，请重新请求');};
        const session=await getSession(actorId,documentId),campaignId=session?.trpgCampaignId;
        if(!campaignId)return {details,guard:async()=>{assertActor();const latest=await getSession(actorId,documentId);if(latest?.trpgCampaignId)throw Error('阅读知识权限已变化，请重新请求');}};
        if(!global.CoC7)throw Error('跑团知识保护尚未加载');
        const preview=await global.CoC7.buildContext(campaignId,{viewer:'player',characterId:actorId,remote:true});
        if(!preview.itemIds.length&&!preview.citations.length)throw Error('该角色尚未获知可共读的剧情内容，请先通过明确剧情事件授权');
        const guard=async()=>{assertActor();const latest=await getSession(actorId,documentId);if(latest?.trpgCampaignId!==campaignId)throw Error('阅读关联已变化，请重新请求');const fresh=await global.CoC7.buildContext(campaignId,{viewer:'player',characterId:actorId,remote:true});if(fresh.revision!==preview.revision||fresh.text!==preview.text)throw Error('剧情或知识权限已变化，请重新请求');};
        return {details:{...details,document:{...details.document,title:'当前跑团（仅已授权知识）'},chunk:{...details.chunk,text:preview.text},quote:'',session},guard,preview};
    }
    async function saveSession(session) {
        const document = await getDocument(session.documentId);
        if (!document) throw new Error('阅读文档不存在');
        let normalized = core().normalizeSession(session, document);
        const chunk = await getChunk(document.id, normalized.segmentIndex);
        normalized = core().normalizeSession(session, document, chunk);
        if (!chunk || normalized.anchor.status !== 'valid') throw new Error('阅读位置已失效，请重新定位');
        await global.dexieDB.transaction('rw',table('readingSessions'),async()=>{const previous=await table('readingSessions').get(normalized.id);if(previous?.trpgCampaignId){normalized.trpgCampaignId=previous.trpgCampaignId;normalized.trpgBindingRevision=previous.trpgBindingRevision||0;}if(previous?.workspace)normalized.workspace=core().normalizeWorkspace(previous.workspace);normalized.positionVersion=(previous?.positionVersion||0)+(previous&&(previous.segmentIndex!==normalized.segmentIndex||previous.segmentOffset!==normalized.segmentOffset)?1:0);await table('readingSessions').put(normalized);});
        if (global.SharedAssets && normalized.assetId) {
            await global.SharedAssets.attach(normalized.assetId, {
                id: `reading-session:${normalized.id}`,
                ownerType: 'reading-session', ownerId: normalized.id, role: 'document', createdAt: normalized.createdAt,
            });
        }
        return normalized;
    }

    function base64(bytes) {
        let binary = '';
        for (let offset=0; offset<bytes.length; offset+=8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
        return global.btoa(binary);
    }

    async function prepareEpub(parsed, file) {
        if (!global.SharedAssets || !table('readingResources')) throw new Error('EPUB 资源存储尚未就绪，请重新打开 Mio');
        const sourceHash = await global.SharedAssets.digest(parsed.epub.sourceBytes);
        const sourceAssetId = `asset:document:epub-source-${sourceHash}`;
        const resources = [{id:sourceAssetId,contentHash:sourceHash,mimeType:parsed.mimeType,name:file.name,size:parsed.epub.sourceBytes.length,data:base64(parsed.epub.sourceBytes)}];
        const images = new Map();
        for (const image of parsed.epub.resources) {
            const hash = await global.SharedAssets.digest(image.bytes), id = `asset:image:${hash}`;
            images.set(image.path,{path:image.path,assetId:id,mimeType:image.mimeType});
            if (!resources.some(resource=>resource.id===id)) resources.push({id,contentHash:hash,mimeType:image.mimeType,name:image.path,size:image.bytes.length,data:base64(image.bytes)});
        }
        const chunks = [], chapters = [], sectionPositions = new Map();
        for (const [sectionIndex, section] of parsed.epub.sections.entries()) {
            const id = `chapter:${sectionIndex}`, startIndex = chunks.length;
            for (const block of section.blocks) chunks.push({...block,index:chunks.length,chapterId:id,blockId:`${id}:${block.blockId}`,imageAssetId:images.get(block.imagePath)?.assetId || ''});
            chapters.push({id,title:section.title || `第 ${sectionIndex+1} 章`,href:section.path,startIndex,endIndex:chunks.length});
            if (!sectionPositions.has(section.path)) sectionPositions.set(section.path,{id,startIndex,section});
        }
        const toc = parsed.epub.toc.map(item => {
            const target = sectionPositions.get(item.path);
            const local = item.fragment ? target?.section.anchors[item.fragment] : 0;
            const index = target && Number.isSafeInteger(local) && local < target.section.blocks.length ? target.startIndex+local : null;
            return {...item,chapterId:target?.id || '',segmentIndex:index,blockId:index==null?'':chunks[index].blockId};
        });
        return {sourceHash,sourceAssetId,resources,images:[...images.values()],chunks,chapters,toc};
    }

    async function getResource(documentId, assetId) {
        const document = await getDocument(documentId);
        if (!document || !(document.sourceAssetId===assetId || document.resources.some(item=>item.assetId===assetId))) return null;
        return await table('readingResources')?.get(assetId) || null;
    }

    // Explicit document removal owns only reading data; shared resource bytes survive
    // as long as another document references them. UI confirmation belongs to the caller.
    async function listImageOccurrences(documentId) {
        const document = await getDocument(documentId);
        if (!document) return [];
        const chunks = await table('readingDocumentChunks').where('documentId').equals(documentId).toArray();
        const images = chunks.filter(chunk => chunk.kind === 'image' && document.resources.some(resource => resource.assetId === chunk.imageAssetId)).sort((a, b) => a.index - b.index);
        const counts = new Map();
        images.forEach(chunk => counts.set(chunk.imageAssetId, (counts.get(chunk.imageAssetId) || 0) + 1));
        return images.map(chunk => {
            const chapter = document.chapters.find(item => chunk.index >= item.startIndex && chunk.index < item.endIndex);
            return {
                documentId, versionId: document.versionId, blockId: chunk.blockId, segmentIndex: chunk.index,
                assetId: chunk.imageAssetId, alt: chunk.alt || '', occurrences: counts.get(chunk.imageAssetId),
                chapterId: chunk.chapterId || '', chapterTitle: chapter?.title || '',
                citation: `[图片 · ${document.title || '未命名读物'} · ${chapter?.title || '正文'} · 第 ${chunk.index + 1} 段]`,
            };
        });
    }

    function imageBytes(resource) {
        if (!resource || !/^image\/(png|jpeg|gif|webp)$/i.test(resource.mimeType) || !/^[a-z0-9+/=\r\n]+$/i.test(resource.data)) throw new Error('图片资源格式无效');
        const binary = global.atob(resource.data.replace(/\s/g, ''));
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    async function imageSignature(resource) {
        const bytes = imageBytes(resource);
        if (typeof global.Blob !== 'function') throw new Error('浏览器不支持本地图片解码');
        const blob = new global.Blob([bytes], { type: resource.mimeType });
        let source;
        if (typeof global.createImageBitmap === 'function') source = await global.createImageBitmap(blob);
        else {
            source = await new Promise((resolve, reject) => {
                const image = new global.Image();
                const url = global.URL.createObjectURL(blob);
                image.onload = () => { global.URL.revokeObjectURL(url); resolve(image); };
                image.onerror = () => { global.URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
                image.src = url;
            });
        }
        try {
            const canvas = global.document.createElement('canvas');
            canvas.width = 9; canvas.height = 8;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('浏览器不支持本地图片比较');
            context.drawImage(source, 0, 0, 9, 8);
            const pixels = context.getImageData(0, 0, 9, 8).data;
            let red = 0, green = 0, blue = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
                red += pixels[offset]; green += pixels[offset + 1]; blue += pixels[offset + 2];
            }
            const count = pixels.length / 4;
            const color = [red, green, blue].map(total => Math.min(15, Math.round(total / count / 17)).toString(16)).join('');
            const luminance = Math.min(15, Math.round((red * 299 + green * 587 + blue * 114) * 15 / count / 255000)).toString(16);
            let bits = '';
            for (let row = 0; row < 8; row += 1) {
                for (let column = 0; column < 6; column += 1) {
                    const offset = (row * 9 + column) * 4, next = offset + 4;
                    const gray = pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114;
                    const nextGray = pixels[next] * 299 + pixels[next + 1] * 587 + pixels[next + 2] * 114;
                    bits += gray > nextGray ? '1' : '0';
                }
            }
            let signature = color + luminance;
            for (let index = 0; index < bits.length; index += 4) signature += parseInt(bits.slice(index, index + 4), 2).toString(16);
            return core().normalizeImageSignature(signature);
        } finally {
            source?.close?.();
        }
    }

    async function scanSimilarImages(documentId, options = {}) {
        const occurrences = await listImageOccurrences(documentId);
        const unique = [...new Map(occurrences.map(item => [item.assetId, item])).values()];
        const signatures = [], failures = [];
        for (let index = 0; index < unique.length; index += 1) {
            const item = unique[index];
            try {
                const resource = await getResource(documentId, item.assetId);
                signatures.push({ assetId: item.assetId, signature: await imageSignature(resource) });
            } catch (error) {
                failures.push({ assetId: item.assetId, reason: error?.message || '图片无法比较' });
            }
            options.onProgress?.(index + 1, unique.length);
            if (index % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
        }
        return { occurrences, pairs: core().findSimilarImages(signatures, options.threshold ?? 8), failures };
    }

    async function resolveImageReference(reference) {
        const document = reference && await getDocument(reference.documentId);
        if (!document || reference.versionId !== document.versionId || !Number.isInteger(reference.segmentIndex)) throw new Error('图片引用已失效');
        const chunk = await getChunk(document.id, reference.segmentIndex);
        if (!chunk || chunk.kind !== 'image' || chunk.blockId !== reference.blockId || chunk.imageAssetId !== reference.assetId) throw new Error('图片引用已失效');
        const resource = await getResource(document.id, reference.assetId);
        if (!resource) throw new Error('图片资源不存在');
        return { document, chunk, resource };
    }

    async function setImageHidden(characterId, reference, hidden) {
        await resolveImageReference(reference);
        const images = await listImageOccurrences(reference.documentId);
        if (!images.some(image => image.blockId === reference.blockId)) throw new Error('图片引用已失效');
        const session = await getSession(characterId, reference.documentId);
        const blocks = new Set(session.hiddenImageBlocks);
        if (hidden) blocks.add(reference.blockId); else blocks.delete(reference.blockId);
        return saveSession({ ...session, hiddenImageBlocks: [...blocks], updatedAt: Date.now() });
    }

    async function removeDocument(documentId) {
        const document = await getDocument(documentId);
        if (!document) return false;
        const names = ['readingDocuments','readingDocumentChunks','readingSessions','readingLibraryEntries','readingAnnotations','readingActivities','readingResources','sharedAssets'];
        await global.dexieDB.transaction('rw',names.map(table).filter(Boolean),async()=>{
            const sessions = await table('readingSessions').where('documentId').equals(documentId).toArray();
            for (const name of ['readingDocumentChunks','readingSessions','readingLibraryEntries','readingAnnotations',...(table('readingActivities')?['readingActivities']:[])]) {
                for (const row of await table(name).where('documentId').equals(documentId).toArray()) await table(name).delete(row.id);
            }
            await table('readingDocuments').delete(documentId);
            if (global.SharedAssets) {
                for (const session of sessions) await global.SharedAssets.detachOwner('reading-session',session.id);
                await global.SharedAssets.detachOwner('reading-document',documentId);
            }
            const remaining = await listDocuments();
            for (const assetId of new Set([document.sourceAssetId,...document.resources.map(item=>item.assetId)].filter(Boolean))) {
                if (remaining.some(item=>item.sourceAssetId===assetId || item.resources.some(resource=>resource.assetId===assetId))) continue;
                if ((await global.SharedAssets?.get(assetId))?.refCount > 0) continue;
                await table('readingResources')?.delete(assetId);
                await global.SharedAssets?.setPermanent(assetId,false);
            }
        });
        if (state.documentId===documentId) { stopSpeech(); state.documentId=''; }
        return true;
    }

    async function importFile(file, characterId, options = {}) {
        if (!table('readingDocuments') || !table('readingDocumentChunks') || !table('readingSessions') || !table('readingLibraryEntries')) throw new Error('阅读数据表尚未就绪，请重新打开 Mio');
        if (!global.ReadingParsers) throw new Error('阅读解析组件尚未就绪，请重新打开 Mio');
        if (!String(characterId || '').trim()) throw new Error('请先打开一个角色聊天');
        const parsed = await global.ReadingParsers.parse(file, options);
        const epub = parsed.epub ? await prepareEpub(parsed,file) : null;
        const text = parsed.text;
        const contentHash = global.SharedAssets ? await global.SharedAssets.digest(text) : global.SharedAssetCore.stableHash(text);
        const documentId = core().makeDocumentId(epub ? `epub-${epub.sourceHash}` : contentHash);
        let document = await getDocument(documentId);
        if (!document) {
            const chunks = epub?.chunks || await core().chunkTextAsync(text, { onProgress: options.onProgress });
            const now = Date.now();
            const assetId = global.SharedAssetCore?.makeId?.('document', epub ? `epub-${epub.sourceHash}` : contentHash) || '';
            document = core().normalizeDocument({
                id: documentId, assetId, contentHash, format: parsed.format,
                ...(epub ? {versionId:`epub-v1:${epub.sourceHash}`,sourceHash:epub.sourceHash,sourceAssetId:epub.sourceAssetId,chapters:epub.chapters,toc:epub.toc,resources:epub.images,rights:parsed.metadata.rights} : {}),
                title: String(file.name || '未命名文本').replace(/\.(txt|docx|pdf|epub)$/i, ''),
                fileName: file.name, encoding: parsed.encoding, totalChars: text.length, segmentCount: chunks.length, createdAt: now, updatedAt: now,
            });
            const rows = chunks.map(chunk => core().normalizeChunk({ ...chunk, documentId }, document));
            const transactionTables = [table('readingDocuments'), table('readingDocumentChunks')];
            if (epub) transactionTables.push(table('readingResources'));
            if (global.SharedAssets && table('sharedAssets')) transactionTables.push(table('sharedAssets'));
            await global.dexieDB.transaction('rw', transactionTables, async () => {
                if (options.signal?.aborted) throw new Error('已取消导入');
                if (epub) for (const resource of epub.resources) {
                    if (!await table('readingResources').get(resource.id)) await table('readingResources').put(resource);
                    await global.SharedAssets.registerExternal({id:resource.id,type:resource.mimeType.startsWith('image/')?'image':'document',name:resource.name,
                        mimeType:resource.mimeType,size:resource.size,contentHash:resource.contentHash,permanent:true,externalStore:'readingResources',externalKey:resource.id});
                    await global.SharedAssets.attach(resource.id,{id:`reading-resource:${documentId}`,ownerType:'reading-document',ownerId:documentId,role:resource.id===epub.sourceAssetId?'original':'image'});
                }
                if (global.SharedAssets) {
                    const asset = await global.SharedAssets.registerExternal({
                        id: assetId || undefined, type: 'document', name: file.name, mimeType: parsed.mimeType,
                        size: file.size || new TextEncoder().encode(text).byteLength,
                        contentHash:epub ? epub.sourceHash : contentHash, externalStore: 'readingDocuments', externalKey: documentId,
                        metadata: {
                            format: parsed.format, segmentCount: chunks.length,
                            parser: parsed.metadata?.parser || 'mio-text', parserWarningCount: parsed.warnings.length,
                            ...(parsed.metadata?.title ? { title: String(parsed.metadata.title).slice(0, 240) } : {}),
                            ...(Number.isFinite(Number(parsed.metadata?.chapterCount)) ? { chapterCount: Number(parsed.metadata.chapterCount) } : {}),
                            ...(Number.isFinite(Number(parsed.metadata?.extractedChapters)) ? { extractedChapters: Number(parsed.metadata.extractedChapters) } : {}),
                        },
                    });
                    document.assetId = asset.id;
                }
                await table('readingDocuments').put(document);
                await table('readingDocumentChunks').bulkPut(rows);
                if (global.SharedAssets && document.assetId) {
                    await global.SharedAssets.attach(document.assetId, { id: `reading-document:${document.id}`, ownerType: 'reading-document', ownerId: document.id, role: 'source', createdAt: now });
                }
            });
        }
        const sessionId = core().makeSessionId(characterId, document.id);
        const existingSession = await table('readingSessions').get(sessionId);
        const session = await saveSession(existingSession || { characterId, documentId: document.id, assetId: document.assetId, segmentIndex: 0 });
        const libraryEntry = await ensureLibraryEntry(characterId, document.id, { assetId: document.assetId });
        return { document, session, libraryEntry, warnings: parsed.warnings };
    }

    async function importTxt(file, characterId, options = {}) {
        if (!/\.txt$/i.test(file?.name || '')) throw new Error('请选择 TXT 文件');
        return importFile(file, characterId, options);
    }

    async function openDocument(documentId) {
        stopSpeech();
        const document = await getDocument(documentId);
        if (!document) return notify('这份文本已不存在');
        state.documentId = document.id;
        state.pendingAnchor = null;
        state.pendingQuote = '';
        await saveSession(await getSession(state.characterId, document.id));
        await ensureLibraryEntry(state.characterId, document.id, { lastOpenedAt: Date.now(), status: (await getLibraryEntry(state.characterId, document.id))?.status === 'finished' ? 'finished' : 'reading' });
        await render();
        restorePosition(await getSession(state.characterId, document.id));
    }

    function restorePosition(session) {
        const body = documentRef('reading-text');
        if (!body || !session) return;
        body.scrollIntoView?.({ block: 'start' });
        if (!session.segmentOffset || !global.document.createTreeWalker) return;
        const walker = global.document.createTreeWalker(body, 4);
        let node, remaining = session.segmentOffset;
        while ((node = walker.nextNode())) {
            if (remaining > node.textContent.length) { remaining -= node.textContent.length; continue; }
            const range = global.document.createRange();
            range.setStart(node, remaining); range.collapse(true);
            const rect = range.getBoundingClientRect();
            const main = body.closest('.reading-main');
            if (main && rect.height) main.scrollTop += rect.top - main.getBoundingClientRect().top - 12;
            break;
        }
    }

    async function navigateTo(characterId, documentId, segmentIndex) {
        const document = await getDocument(documentId);
        const session = document && await getSession(characterId, documentId);
        if (!document || !session) throw new Error('阅读文档不存在');
        if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= document.segmentCount) throw new Error('阅读位置超出范围');
        // Explicit navigation creates a new anchor; stale anchors must never be carried to another block.
        return saveSession({ ...session, segmentIndex, segmentOffset: 0, anchor: null, updatedAt: Date.now() });
    }

    async function setPreferences(characterId, documentId, patch) {
        const session = await getSession(characterId, documentId);
        if (!session) throw new Error('阅读文档不存在');
        return saveSession({ ...session, preferences: { ...session.preferences, ...patch }, updatedAt: Date.now() });
    }

    async function move(delta, targetIndex) {
        stopSpeech();
        const document = await getDocument(state.documentId);
        const session = document && await getSession(state.characterId, state.documentId);
        if (!document || !session) return;
        const index = targetIndex ?? Math.max(0, Math.min(document.segmentCount - 1, session.segmentIndex + delta));
        const saved = await navigateTo(state.characterId, document.id, index);
        state.pendingAnchor = null;
        state.pendingQuote = '';
        await renderReader(document, saved);
        documentRef('reading-text')?.scrollIntoView?.({ block: 'start' });
    }

    function applyPreferences(session) {
        const preferences = core().normalizePreferences(session.preferences);
        const screen = documentRef('reading-screen');
        if (screen) screen.dataset.readingTheme = preferences.theme;
        const body = documentRef('reading-text');
        if (body) {
            body.style.fontSize = `${preferences.fontSize}px`;
            body.style.fontFamily = { system: 'inherit', serif: 'Songti SC, SimSun, serif', sans: 'PingFang SC, Microsoft YaHei, sans-serif' }[preferences.font];
        }
        for (const [id, value] of [['reading-font', preferences.font], ['reading-font-size', preferences.fontSize], ['reading-theme', preferences.theme]]) {
            const input = documentRef(id);
            if (input) {
                if (id === 'reading-font-size' && !Array.from(input.options).some(option => option.value === String(value))) {
                    const option = global.document.createElement('option'); option.value = String(value); option.textContent = String(value); input.append(option);
                }
                input.value = String(value);
            }
        }
    }

    function renderToc(document, session) {
        const container = documentRef('reading-toc');
        if (!container) return;
        const items = document.toc?.length ? document.toc : (document.chapters || []).map(chapter => ({ ...chapter, segmentIndex: chapter.startIndex }));
        const byId = new Map(items.map(item => [item.id, item]));
        let active = null;
        for (const item of items) if (Number.isInteger(item.segmentIndex) && item.segmentIndex <= session.segmentIndex && (!active || item.segmentIndex >= active.segmentIndex)) active = item;
        container.replaceChildren();
        if (!items.length) { container.textContent = '此书没有保存目录，可使用段落跳转。旧 EPUB 可重新导入原文件以读取目录。'; return; }
        for (const item of items) {
            const button = global.document.createElement('button');
            button.type = 'button';
            let parent = item.parentId, depth = 0;
            const seen = new Set([item.id]);
            while (parent && byId.has(parent) && !seen.has(parent)) { seen.add(parent); depth++; parent = byId.get(parent).parentId; }
            button.style.paddingInlineStart = `${12 + Math.min(depth, 6) * 14}px`;
            button.textContent = item.title || '未命名章节';
            button.disabled = !Number.isInteger(item.segmentIndex) || item.segmentIndex < 0 || item.segmentIndex >= document.segmentCount;
            if (button.disabled) button.textContent += '（无法定位）';
            else button.dataset.readingIndex = String(item.segmentIndex);
            if (item === active) button.setAttribute('aria-current', 'location');
            container.append(button);
        }
    }

    let readerOperation = Promise.resolve();
    function queueReaderOperation(operation) {
        const characterId = state.characterId, documentId = state.documentId;
        readerOperation = readerOperation.then(async () => {
            if (state.characterId === characterId && state.documentId === documentId) await operation();
        }).catch(error => notify(error?.message || '阅读设置保存失败'));
    }

    function renderMarkedText(container, text, annotations) {
        if (!container) return;
        const ranges = annotations
            .filter(item => item.kind === 'highlight' && item.anchorStatus === 'valid')
            .map(item => ({ start: item.anchor.startOffset, end: item.anchor.endOffset }))
            .filter(item => item.start >= 0 && item.end > item.start && item.end <= text.length)
            .sort((a, b) => a.start - b.start || a.end - b.end);
        const merged = [];
        ranges.forEach(range => {
            const previous = merged[merged.length - 1];
            if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
            else merged.push({ ...range });
        });
        const fragment = document.createDocumentFragment();
        let offset = 0;
        merged.forEach(range => {
            if (range.start > offset) fragment.append(document.createTextNode(text.slice(offset, range.start)));
            const mark = document.createElement('mark');
            mark.className = 'reading-highlight';
            mark.textContent = text.slice(range.start, range.end);
            fragment.append(mark);
            offset = range.end;
        });
        if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
        container.replaceChildren(fragment);
    }

    function renderAnnotationList(annotations) {
        const list = documentRef('reading-annotation-list');
        if (!list) return;
        const labels = { highlight: '划线', 'user-note': '我的笔记', 'character-annotation': '角色批注', 'discussion-user': '我的共读问题', 'discussion-character': '角色共读回应' };
        list.innerHTML = annotations.length ? annotations.map(item => `<article class="reading-annotation-card reading-annotation-${escapeHtml(item.kind)}"><div class="reading-annotation-head"><strong>${labels[item.kind] || '阅读记录'}</strong><span>${item.source === 'ai' ? 'AI 生成' : (item.kind === 'character-annotation' ? '手动整理 · 角色署名' : '手动')}</span><button type="button" data-reading-delete-annotation="${escapeHtml(item.id)}" aria-label="删除这条${labels[item.kind] || '记录'}">删除</button></div><blockquote>${escapeHtml(item.quote)}</blockquote>${item.content ? `<p>${escapeHtml(item.content)}</p>` : ''}${item.anchorStatus === 'needs-relocation' ? '<small class="reading-anchor-warning">原文已变化，需要重新定位</small>' : ''}</article>`).join('') : '<p class="reading-annotation-empty">当前段落还没有划线、批注或讨论。</p>';
    }

    async function renderStudyNotes(characterId, documentId) {
        const list = documentRef('reading-study-list');
        if (!list) return;
        const notes = await listStudyNotes(characterId,documentId);
        if (state.characterId !== characterId || state.documentId !== documentId) return;
        const document = await getDocument(documentId);
        const chapters = new Map((document?.chapters || []).map(item=>[item.id,item.title || item.id]));
        list.innerHTML = notes.length ? notes.map(item => {
            const scope = item.studyScope === 'chapter'
                ? `章节 · ${chapters.get(item.studyChapterId) || item.studyChapterId || '未知章节'}`
                : '当前选区';
            const label = item.kind === 'study-explanation' ? '分层讲解' : '总结';
            return `<article class="reading-study-card"><div class="reading-annotation-head"><strong>${label}</strong><span>${escapeHtml(scope)} · ${item.inputChars.toLocaleString()} 字 · ${item.requestCount} 次请求</span><button type="button" data-reading-delete-study="${escapeHtml(item.id)}" aria-label="删除这条学习笔记">删除</button></div><p>${escapeHtml(item.content)}</p></article>`;
        }).join('') : '<p class="reading-annotation-empty">还没有学习笔记。选择原文或当前章节后按需生成。</p>';
    }

    async function captureSelection(options = {}) {
        const body = documentRef('reading-text');
        const selection = global.getSelection?.();
        if (!body || !selection || selection.rangeCount < 1 || selection.isCollapsed) {
            if (options.silent !== true) notify('请先在当前段落中选择一小段文字');
            return false;
        }
        const range = selection.getRangeAt(0);
        if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) {
            if (options.silent !== true) notify('只能选择当前阅读段落的正文');
            return false;
        }
        const prefix = range.cloneRange();
        prefix.selectNodeContents(body);
        prefix.setEnd(range.startContainer, range.startOffset);
        const startOffset = prefix.toString().length;
        const quote = range.toString();
        if (!quote.trim()) { if (options.silent !== true) notify('请选择包含文字的范围'); return false; }
        if (quote.length > 1200) { if (options.silent !== true) notify('单次选区不能超过 1200 字'); return false; }
        const characterId = state.characterId, documentId = state.documentId;
        const document = await getDocument(documentId);
        const session = document && await getSession(characterId, documentId);
        if (!document || !session) return false;
        const chunk = await getChunk(document.id, session.segmentIndex);
        if (state.characterId !== characterId || state.documentId !== documentId || !body.contains(range.startContainer)) return false;
        state.pendingQuote = quote;
        state.pendingAnchor = core().makeAnchor(document, session.segmentIndex, startOffset, startOffset + quote.length, quote, chunk);
        const status = documentRef('reading-selection-status');
        if (status) status.textContent = `已选择 ${quote.length} 字：${quote.slice(0, 36)}${quote.length > 36 ? '…' : ''}`;
        if (options.focus !== false) documentRef('reading-annotation-content')?.focus();
        selection.removeAllRanges();
        return true;
    }

    let sheetTrigger = null;
    function closeReadingSheets(restoreFocus = true) {
        documentRef('reading-screen')?.querySelectorAll('[data-reading-sheet-overlay]').forEach(overlay => {
            overlay.classList.add('reading-hidden');
            overlay.setAttribute('aria-hidden','true');
        });
        documentRef('reading-screen')?.querySelectorAll('[data-reading-sheet]').forEach(button => button.setAttribute('aria-expanded','false'));
        if (restoreFocus && sheetTrigger?.isConnected) sheetTrigger.focus();
        sheetTrigger = null;
    }

    async function openReadingSheet(name, trigger) {
        if (name === 'notes' || name === 'study' || name === 'more') await captureSelection({focus:false,silent:true});
        closeReadingSheets(false);
        const overlay = documentRef('reading-screen')?.querySelector(`[data-reading-sheet-overlay="${name}"]`);
        if (!overlay) return;
        overlay.classList.remove('reading-hidden');
        overlay.setAttribute('aria-hidden','false');
        trigger?.setAttribute('aria-expanded','true');
        sheetTrigger = trigger;
        overlay.querySelector('[data-reading-close-sheet]')?.focus();
    }

    async function renderImageList(includeSimilar = false) {
        const characterId = state.characterId, documentId = state.documentId;
        const status = documentRef('reading-images-status');
        const scanButton = documentRef('reading-images-scan');
        if (scanButton) scanButton.disabled = true;
        if (status) status.textContent = includeSimilar ? '正在本地生成图片指纹…' : '正在读取图片引用…';
        let result;
        try {
            result = includeSimilar
                ? await scanSimilarImages(documentId, { onProgress: (done, total) => {
                    if (status && state.characterId === characterId && state.documentId === documentId) status.textContent = `正在本地比较图片 ${done} / ${total}…`;
                } })
                : { occurrences: await listImageOccurrences(documentId), pairs: [], failures: [] };
        } finally {
            if (scanButton) scanButton.disabled = false;
        }
        const images = result.occurrences;
        const session = await getSession(characterId, documentId);
        const container = documentRef('reading-images-list');
        if (!container || !session || state.characterId !== characterId || state.documentId !== documentId) return;
        container.replaceChildren();
        if (!images.length) {
            container.textContent = '这本书没有可用的已保存图片。';
            if (status) status.textContent = '未找到可比较的已保存图片。';
            return;
        }
        if (status) status.textContent = includeSimilar
            ? `找到 ${images.length} 处图片 · ${result.pairs.length} 组相似项${result.failures.length ? ` · ${result.failures.length} 张未读取` : ''}`
            : `${images.length} 处图片`;
        const resourceCache = new Map();
        for (const reference of images) {
            const row = global.document.createElement('div');
            const resource = resourceCache.has(reference.assetId) ? resourceCache.get(reference.assetId) : await getResource(documentId, reference.assetId);
            resourceCache.set(reference.assetId, resource);
            if (resource) {
                let safePreview = false;
                try { imageBytes(resource); safePreview = true; } catch (_) { /* Preserve reference text; never render an unsafe data URL. */ }
                if (safePreview) {
                const preview = global.document.createElement('img');
                preview.className = 'reading-image-preview';
                preview.src = `data:${resource.mimeType};base64,${resource.data}`;
                preview.alt = reference.alt || '书籍插图缩略图';
                row.append(preview);
                }
            }
            const label = global.document.createElement('span');
            const matches = result.pairs.filter(pair => pair.leftAssetId === reference.assetId || pair.rightAssetId === reference.assetId);
            label.textContent = `第 ${reference.segmentIndex + 1} 段 · ${reference.alt || '插图'}${reference.occurrences > 1 ? ` · 完全相同图片共 ${reference.occurrences} 处` : ''}${matches.length ? ` · 视觉相似 ${Math.max(...matches.map(match => match.similarity))}%` : ''}`;
            row.append(label);
            const citation = global.document.createElement('code');
            citation.className = 'reading-image-citation';
            citation.textContent = reference.citation;
            row.append(citation);
            const locate = global.document.createElement('button'); locate.type = 'button'; locate.className = 'btn btn-secondary'; locate.textContent = '定位';
            locate.addEventListener('click', () => queueReaderOperation(async () => {
                if (state.characterId !== characterId || state.documentId !== documentId) return;
                await resolveImageReference(reference); await move(0, reference.segmentIndex);
            }));
            row.append(locate);
            if (global.navigator?.clipboard?.writeText) {
                const copy = global.document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-secondary'; copy.textContent = '复制引用';
                copy.addEventListener('click', () => void global.navigator.clipboard.writeText(reference.citation).then(() => notify('图片引用已复制')).catch(() => notify('复制失败，请长按引用文本复制')));
                row.append(copy);
            }
            if (reference.occurrences > 1 || matches.length || session.hiddenImageBlocks.includes(reference.blockId)) {
                const hidden = session.hiddenImageBlocks.includes(reference.blockId);
                const toggle = global.document.createElement('button'); toggle.type = 'button'; toggle.className = 'btn btn-secondary'; toggle.textContent = hidden ? '恢复此处' : '隐藏此处';
                toggle.addEventListener('click', () => queueReaderOperation(async () => {
                    if (state.characterId !== characterId || state.documentId !== documentId) return;
                    const saved = await setImageHidden(characterId, reference, !hidden);
                    await renderReader(await getDocument(documentId), saved); await renderImageList(includeSimilar);
                }));
                row.append(toggle);
            }
            container.append(row);
        }
    }

    async function renderReader(document, session) {
        global.ReadingTutor?.sync(session);
        const chunk = await getChunk(document.id, session.segmentIndex);
        const annotations = (await listAnnotations(state.characterId, document.id)).filter(item => item.anchor.segmentIndex === session.segmentIndex && item.kind !== 'study-summary' && item.kind !== 'study-explanation');
        const title = document.title || '一起读';
        applyPreferences(session);
        renderToc(document, session);
        const jump = documentRef('reading-jump-index');
        if (jump) { jump.max = String(document.segmentCount); jump.value = String(session.segmentIndex + 1); }
        const titleEl = documentRef('reading-title');
        if (titleEl) titleEl.textContent = title;
        documentRef('reading-library-view')?.classList.add('reading-hidden');
        documentRef('reading-reader-view')?.classList.remove('reading-hidden');
        documentRef('reading-screen')?.classList.add('reading-open');
        const body = documentRef('reading-text');
        documentRef('reading-images-list')?.replaceChildren();
        if (body && chunk?.kind === 'image' && session.hiddenImageBlocks.includes(chunk.blockId)) {
            body.textContent = '此处图片已隐藏';
        } else if (body && chunk?.kind==='image') {
            const resource = await getResource(document.id,chunk.imageAssetId);
            body.replaceChildren();
            if (resource && /^image\/(png|jpeg|gif|webp)$/i.test(resource.mimeType) && /^[a-z0-9+/=\r\n]+$/i.test(resource.data)) {
                const img = global.document.createElement('img');
                img.src=`data:${resource.mimeType};base64,${resource.data}`; img.alt=chunk.alt || '书籍插图';
                img.style.maxWidth='100%'; img.style.height='auto'; body.append(img);
            } else body.textContent=chunk.alt ? `图片暂不可用：${chunk.alt}` : '图片暂不可用，原始资源保留在 EPUB 文件中。';
        } else renderMarkedText(body, chunk?.text || '这一段暂时无法读取。', annotations);
        renderAnnotationList(annotations);
        await renderStudyNotes(state.characterId,document.id);
        renderApiSettings();
        const selectionStatus = documentRef('reading-selection-status');
        if (selectionStatus) selectionStatus.textContent = state.pendingAnchor ? `已选择 ${state.pendingQuote.length} 字：${state.pendingQuote.slice(0, 36)}${state.pendingQuote.length > 36 ? '…' : ''}` : '先选择正文，再保存划线或批注。';
        const progress = core().progress(session, document);
        const progressEl = documentRef('reading-progress');
        if (progressEl) progressEl.textContent = `第 ${Math.min(session.segmentIndex + 1, document.segmentCount)} / ${document.segmentCount} 段 · ${progress}%`;
        const bar = documentRef('reading-progress-bar');
        if (bar) bar.style.width = `${progress}%`;
        const previous = documentRef('reading-prev-btn');
        const next = documentRef('reading-next-btn');
        if (previous) previous.disabled = session.segmentIndex <= 0;
        if (next) next.disabled = session.segmentIndex >= document.segmentCount - 1;
        updateSpeechControls();
    }

    function documentRef(id) { return global.document.getElementById(id); }

    async function render() {
        const entries = await listLibraryEntries(state.characterId);
        const documents = (await Promise.all(entries.map(async entry => ({ entry, document: await getDocument(entry.documentId) })))).filter(item => item.document);
        const list = documentRef('reading-document-list');
        const empty = documentRef('reading-empty');
        if (list) {
            const labels = { 'want-to-read': '想读', reading: '在读', finished: '读完' };
            list.innerHTML = documents.map(({ document: item, entry }) => `<article class="reading-book-card" data-reading-entry="${escapeHtml(entry.id)}"><button type="button" class="reading-book-open" data-reading-document="${escapeHtml(item.id)}"><span class="reading-book-icon">${escapeHtml(item.format.toUpperCase())}</span><span class="reading-book-copy"><strong>${escapeHtml(item.title)}</strong><small>${item.segmentCount} 段 · ${item.totalChars.toLocaleString()} 字</small></span><span class="reading-book-arrow">›</span></button><div class="reading-book-meta"><select data-reading-status="${escapeHtml(item.id)}" aria-label="《${escapeHtml(item.title)}》阅读状态">${core().LIBRARY_STATUSES.map(status => `<option value="${status}"${entry.status === status ? ' selected' : ''}>${labels[status]}</option>`).join('')}</select><button type="button" class="reading-favorite-btn${entry.favorite ? ' is-active' : ''}" data-reading-favorite="${escapeHtml(item.id)}" aria-pressed="${entry.favorite}">${entry.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div><input class="reading-recommendation-input" data-reading-recommendation="${escapeHtml(item.id)}" value="${escapeHtml(entry.recommendation)}" maxlength="500" placeholder="写一句推荐语（可选）" aria-label="《${escapeHtml(item.title)}》推荐语"></article>`).join('');
        }
        if (empty) empty.style.display = documents.length ? 'none' : '';
        if (state.documentId) {
            const document = await getDocument(state.documentId);
            const session = document && await getSession(state.characterId, state.documentId);
            if (document && session) return renderReader(document, session);
            state.documentId = '';
        }
        documentRef('reading-reader-view')?.classList.add('reading-hidden');
        const screen = documentRef('reading-screen');
        if (screen) { delete screen.dataset.readingTheme; screen.classList.remove('reading-open'); }
        closeReadingSheets();
        documentRef('reading-library-view')?.classList.remove('reading-hidden');
        const title = documentRef('reading-title');
        if (title) title.textContent = '一起读';
    }

    async function open(characterId = global.currentChatId) {
        if (!characterId || global.currentChatType !== 'private') return notify('请先打开一个角色聊天');
        stopSpeech();
        state.characterId = String(characterId);
        const sessions = await table('readingSessions').where('characterId').equals(state.characterId).toArray();
        sessions.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
        state.documentId = sessions[0]?.documentId || '';
        if (typeof switchScreen === 'function') switchScreen('reading-screen');
        await render();
        if (state.documentId) restorePosition(await getSession(state.characterId, state.documentId));
    }

    function setup() {
        global.ReadingWorkspace?.setup();
        global.ReadingTutor?.setup();
        documentRef('reading-images-scan')?.addEventListener('click', () => queueReaderOperation(() => renderImageList(true)));
        documentRef('reading-btn')?.addEventListener('click', () => { void open(); if (global.showPanel) global.showPanel('none'); });
        documentRef('reading-import-btn')?.addEventListener('click', () => documentRef('reading-file-input')?.click());
        documentRef('reading-library-btn')?.addEventListener('click', () => { stopSpeech(); state.documentId = ''; void render(); });
        documentRef('reading-prev-btn')?.addEventListener('click', () => queueReaderOperation(() => move(-1)));
        documentRef('reading-next-btn')?.addEventListener('click', () => queueReaderOperation(() => move(1)));
        documentRef('reading-screen')?.addEventListener('click', event => {
            const trigger = event.target.closest('[data-reading-sheet]');
            if (trigger) void openReadingSheet(trigger.dataset.readingSheet,trigger).catch(error => notify(error.message));
            if (event.target.closest('[data-reading-close-sheet]')) closeReadingSheets();
            const overlay = event.target.closest('[data-reading-sheet-overlay]');
            if (overlay && event.target === overlay) closeReadingSheets();
        });
        global.document.addEventListener('keydown', event => {
            if (!documentRef('reading-screen')?.classList.contains('active')) return;
            const overlay = documentRef('reading-screen').querySelector('[data-reading-sheet-overlay]:not(.reading-hidden)');
            if (!overlay) return;
            if (event.key === 'Escape') { event.preventDefault(); closeReadingSheets(); }
            if (event.key === 'Tab') {
                const controls = [...overlay.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
                const first = controls[0], last = controls.at(-1), active = global.document.activeElement;
                if (first && (!overlay.contains(active) || event.shiftKey && active === first || !event.shiftKey && active === last)) {
                    event.preventDefault(); (event.shiftKey ? last : first).focus();
                }
            }
        });
        documentRef('reading-toc')?.addEventListener('click', event => {
            const button = event.target.closest('[data-reading-index]');
            if (button) { closeReadingSheets(); queueReaderOperation(() => move(0, Number(button.dataset.readingIndex))); }
        });
        documentRef('reading-jump-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const index = Number(documentRef('reading-jump-index')?.value) - 1;
            closeReadingSheets();
            queueReaderOperation(() => move(0, index));
        });
        for (const [id, key] of [['reading-font', 'font'], ['reading-font-size', 'fontSize'], ['reading-theme', 'theme']]) {
            documentRef(id)?.addEventListener('change', event => {
                const value = event.target.value;
                queueReaderOperation(async () => {
                    const session = await setPreferences(state.characterId, state.documentId, { [key]: value });
                    applyPreferences(session);
                });
            });
        }
        documentRef('reading-speak-btn')?.addEventListener('click', () => void speakCurrentSegment());
        documentRef('reading-speak-stop-btn')?.addEventListener('click', stopSpeech);
        document.addEventListener('ttsStateChange', updateSpeechControls);
        documentRef('reading-document-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-reading-document]');
            if (button) void openDocument(button.dataset.readingDocument);
            const favorite = event.target.closest('[data-reading-favorite]');
            if (favorite) void (async () => {
                const entry = await getLibraryEntry(state.characterId, favorite.dataset.readingFavorite);
                await saveLibraryEntry({ ...entry, favorite: !entry.favorite });
                await render();
            })();
        });
        documentRef('reading-document-list')?.addEventListener('change', event => {
            const status = event.target.closest('[data-reading-status]');
            if (status) void ensureLibraryEntry(state.characterId, status.dataset.readingStatus, { status: status.value }).then(render);
        });
        documentRef('reading-document-list')?.addEventListener('focusout', event => {
            const input = event.target.closest('[data-reading-recommendation]');
            if (input) void ensureLibraryEntry(state.characterId, input.dataset.readingRecommendation, {
                recommendation: input.value, recommendationSource: 'user', recommendedAt: input.value.trim() ? Date.now() : 0,
            });
        });
        documentRef('reading-capture-selection-btn')?.addEventListener('click', () => { void captureSelection().catch(error => notify(error.message)); });
        documentRef('reading-annotation-kind')?.addEventListener('change', event => {
            const textarea = documentRef('reading-annotation-content');
            const visibility = documentRef('reading-annotation-visibility');
            if (textarea) textarea.placeholder = event.target.value === 'highlight' ? '划线不需要填写内容' : (event.target.value === 'character-annotation' ? '手动整理角色在这里留下的想法' : '写下你的笔记');
            if (visibility && event.target.value === 'character-annotation') visibility.value = 'shared';
        });
        documentRef('reading-annotation-form')?.addEventListener('submit', event => {
            event.preventDefault();
            void (async () => {
                if (!state.pendingAnchor || !state.pendingQuote) return notify('请先选择当前段落中的正文');
                const kind = documentRef('reading-annotation-kind')?.value || 'highlight';
                const content = documentRef('reading-annotation-content')?.value || '';
                const visibility = documentRef('reading-annotation-visibility')?.value || 'private';
                try {
                    await saveAnnotation({
                        characterId: state.characterId, documentId: state.documentId, kind, content, visibility,
                        source: 'manual', quote: state.pendingQuote, anchor: state.pendingAnchor,
                        authorId: kind === 'character-annotation' ? state.characterId : 'user',
                        authorName: kind === 'character-annotation' ? currentCharacterName() : '我',
                    });
                    state.pendingAnchor = null;
                    state.pendingQuote = '';
                    const textarea = documentRef('reading-annotation-content');
                    if (textarea) textarea.value = '';
                    notify(kind === 'highlight' ? '划线已保存' : '批注已保存');
                    const document = await getDocument(state.documentId);
                    const session = document && await getSession(state.characterId, state.documentId);
                    if (document && session) await renderReader(document, session);
                } catch (error) { notify(error?.message || '批注保存失败'); }
            })();
        });
        documentRef('reading-annotation-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-reading-delete-annotation]');
            if (!button) return;
            void (async () => {
                if (!await deleteAnnotation(button.dataset.readingDeleteAnnotation)) return;
                const document = await getDocument(state.documentId);
                const session = document && await getSession(state.characterId, state.documentId);
                if (document && session) await renderReader(document, session);
            })();
        });
        documentRef('reading-ai-save-btn')?.addEventListener('click', () => void saveApiSettings().catch(error => setAiStatus(error?.message || 'API 设置保存失败', 'error')));
        documentRef('reading-ai-annotation-btn')?.addEventListener('click', () => void generateSelectedAnnotation());
        documentRef('reading-discussion-send-btn')?.addEventListener('click', () => void sendDiscussion());
        documentRef('reading-study-generate')?.addEventListener('click', () => void generateStudyNote());
        documentRef('reading-study-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-reading-delete-study]');
            if (!button) return;
            void (async()=>{ await deleteAnnotation(button.dataset.readingDeleteStudy); await renderStudyNotes(state.characterId,state.documentId); })();
        });
        documentRef('reading-file-input')?.addEventListener('change', async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || state.busy) return;
            state.busy = true;
            const importButton = documentRef('reading-import-btn');
            if (importButton) importButton.disabled = true;
            try {
                const format = global.ReadingParsers?.adapterFor(file)?.format?.toUpperCase() || '文档';
                notify(`正在导入 ${format}…`);
                stopSpeech();
                const result = await importFile(file, state.characterId);
                state.documentId = result.document.id;
                notify(result.warnings.length ? `${format} 已导入，解析器提示 ${result.warnings.length} 项` : `${format} 已导入，阅读位置会自动保存`);
                await render();
            } catch (error) {
                console.error('阅读文档导入失败:', error);
                notify(error?.message || '文档导入失败');
            } finally {
                state.busy = false;
                if (importButton) importButton.disabled = false;
            }
        });
    }

    global.Reading = Object.freeze({ VERSION: 13, prepareTeachingContext,captureSelection,selectedAnchor:()=>state.pendingAnchor?{...state.pendingAnchor}:null,details:currentReadingDetails,refresh:render,requestInteraction,configureWorkspace, current:()=>({characterId:state.characterId,documentId:state.documentId}), bindCampaign,guardReadingContext, setup, open, stopSpeech, importFile, importTxt, listDocuments, listLibraryEntries, getLibraryEntry, saveLibraryEntry, ensureLibraryEntry, listAnnotations, listStudyNotes, saveAnnotation, deleteAnnotation, resolveReadingApi, requestReadingAi, buildStudyContext, requestStudyAi, getDocument, getDocumentByAssetId, getSession, saveSession, getChunk, getResource, removeDocument, navigateTo, setPreferences, listImageOccurrences, resolveImageReference, setImageHidden, imageSignature, scanSimilarImages });
}(typeof window !== 'undefined' ? window : globalThis));
