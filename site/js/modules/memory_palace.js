(function attachMemoryPalace(global) {
    'use strict';
    const Core = global.MemoryPalaceCore;
    const runtime = new Map();
    const archiveLocks = new Set();
    const historyRuns = new Map();
    const roomPlateWriteQueues = new Map();
    const roomLayoutWriteQueues = new Map();
    const anticipationWriteQueues = new Map();
    function withTimeout(promise, milliseconds = 45000) {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('记忆处理超时，可稍后重试')), milliseconds); })]).finally(() => clearTimeout(timer));
    }
    const ui = { page:0,filterKey:'',characterId: '', room: 'all', query: '', editingId: '', linksId: '', eventBoxNodeId: '', eventBoxId: '', anticipationEditingId: '' };

    function ensureSettings(character) {
        if (!character) return;
        if (character.legacyMemoryEnabled === undefined) character.legacyMemoryEnabled = true;
        if (character.memoryPalaceEnabled === undefined) character.memoryPalaceEnabled = false;
        if (!Number.isFinite(Number(character.memoryPalaceTopK))) character.memoryPalaceTopK = 8;
        if (character.memoryPalaceActivationEnabled === undefined) character.memoryPalaceActivationEnabled = true;
        if (!Number.isFinite(Number(character.memoryPalaceActivationMaxExpand))) character.memoryPalaceActivationMaxExpand = Core.ACTIVATION_MAX_EXPAND;
        if (character.autoArchiveEnabled === undefined) character.autoArchiveEnabled = true;
        if (character.memoryPalaceSevenEnabled === undefined) character.memoryPalaceSevenEnabled = true;
        if (character.memoryPalaceNightEnabled === undefined) character.memoryPalaceNightEnabled = true;
        if (character.relationshipMemoryEnabled === undefined) character.relationshipMemoryEnabled = true;
        if (!Number.isFinite(Number(character.memoryPalaceNightHour))) character.memoryPalaceNightHour = 3;
        character.memoryPalaceWaterline = Core.resolveWaterline(character.memoryPalaceWaterline);
        character.memoryPalaceArchiveState = Core.normalizeArchiveState(character.memoryPalaceArchiveState);
    }

    function featureConfig(feature, character) {
        const fallbackConfig = feature === 'embedding' ? (db.vectorApiSettings || null)
            : feature === 'memoryProcess' ? (db.apiSettings || null) : null;
        if (global.FeatureApiRegistry) {
            const result = global.FeatureApiRegistry.resolve(feature, { context: character, fallbackConfig });
            if (result.configured && result.config) return result.config;
        }
        if (feature === 'embedding' && fallbackConfig?.url && fallbackConfig?.model) return fallbackConfig;
        return null;
    }

    function originalMessageEntry(message, fullText = false) {
        if (!message || !['user', 'assistant'].includes(message.role) || message.isThinking || message.isContextDisabled) return null;
        const type = global.MessageReference?.classify ? global.MessageReference.classify(message) : 'text';
        if (['image', 'video', 'file', 'sticker', 'system'].includes(type)) return null;
        let text = message.transcriptOriginal && String(message.transcriptOriginal).trim();
        if (!text) {
            const sanitized = global.MessageContentParser?.sanitizeMessageForModel
                ? global.MessageContentParser.sanitizeMessageForModel(message) : message;
            const raw = global.MessageReference?.extractText ? global.MessageReference.extractText(sanitized) : sanitized.content;
            text = global.MessageContentParser?.parse ? global.MessageContentParser.parse(raw).original : String(raw || '').trim();
        }
        text = String(text || '').trim();
        if (!text || /^data:|^blob:/i.test(text)) return null;
        return { id: String(message.id ?? ''), role: message.role, text: fullText === true ? text : text.slice(0, 6000), timestamp: Number(message.timestamp) || 0 };
    }

    function parseExtractionReply(value) {
        let text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const objectStart = text.indexOf('{');
        const arrayStart = text.indexOf('[');
        const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
        if (start > 0) text = text.slice(start);
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (_) {
            const end = text.startsWith('[') ? text.lastIndexOf(']') : text.lastIndexOf('}');
            if (end < 0) throw new Error('记忆处理 API 未返回有效 JSON');
            parsed = JSON.parse(text.slice(0, end + 1));
        }
        const rows = Array.isArray(parsed) ? parsed : parsed?.memories;
        if (!Array.isArray(rows)) throw new Error('记忆处理 API 返回格式错误');
        const roomAliases = { 客厅: 'living_room', 卧室: 'bedroom', 书房: 'study', 用户房间: 'user_room', 自我房间: 'self_room', 阁楼: 'attic', 窗台: 'windowsill' };
        return rows.map(item => ({
            ...Core.normalizeNode(item),
            content: String(item?.content || item?.memory || '').trim().slice(0, 2000),
            room: roomAliases[item?.room] || item?.room,
            tags: item?.tags,
            entities: item?.entities,
            importance: item?.importance,
            mood: item?.mood,
            sourceMessageIds: [...new Set((Array.isArray(item?.sourceMessageIds || item?.messageIds) ? (item.sourceMessageIds || item.messageIds) : []).map(String))],
            mergeInto: String(item?.mergeInto || ''),
        })).filter(item => item.content);
    }

    function buildExtractionPrompt(character, messages) {
        const allowedIds = new Set(messages.map(item => item.id));
        const transcript = messages.map((item, index) => {
            const speaker = item.role === 'user' ? (character.myName || '用户') : (character.remarkName || character.name || '角色');
            const date = item.timestamp ? new Date(item.timestamp).toISOString() : '未知时间';
            return `M${index} | id=${item.id} | ${date} | ${speaker}：${item.text}`;
        }).join('\n');
        return [
            '你是聊天长期记忆整理器。只提取对未来互动有稳定价值的事实、关系变化、重要事件、偏好、承诺、目标或持续状态，不要复述寒暄。',
            '不得编造，不要把翻译、格式标签或系统说明当作事实。相似内容合并为一条，但不同日期发生的相似事件不得误合并。',
            '房间只能是 living_room、bedroom、study、user_room、self_room、attic、windowsill。importance 为 1-10。',
            '每条记忆另带 layer：episodes经历、facts事实、states近况、relations关系、knowledge知识、cognition认知、intentions愿望约定；房间与层独立。subject是事实主体；confidence为0到1；factKey仅用于同一主体同一属性（如饮食偏好），不确定留空。不得自行推测期限。',
            `sourceMessageIds 只能从以下 ID 中选择：${[...allowedIds].join(', ')}`,
            '只返回 JSON：{"memories":[{"content":"客观完整的记忆","room":"user_room","tags":["标签"],"entities":["实体"],"importance":7,"mood":"可选","sourceMessageIds":["消息ID"]}]}。没有值得长期保存的内容时返回 {"memories":[]}。',
            '',
            '[角色设定（仅用于辨认身份，不得自行扩写）]',
            `角色：${character.remarkName || character.name || '角色'}`,
            `用户：${character.myName || '用户'}`,
            '',
            '[聊天原文]', transcript
        ].join('\n');
    }

    async function extractArchiveChunk(character, messages, options = {}) {
        const config = featureConfig('memoryProcess', character);
        if (!config) throw new Error('未配置并启用记忆处理 API');
        const request = global.fetchAiResponse;
        if (typeof request !== 'function') throw new Error('记忆处理请求适配器不可用');
        const endpoint = global.getApiConfigEndpoint ? global.getApiConfigEndpoint(config, false)
            : `${String(config.url || config.baseUrl || '').replace(/\/$/, '')}/v1/chat/completions`;
        const headers = global.getApiConfigHeaders ? global.getApiConfigHeaders(config)
            : { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) };
        const response = await withTimeout(request(options.signal ? {...config,streamEnabled:false} : config, {
            model: config.model,
            messages: [{ role: 'user', content: buildExtractionPrompt(character, messages) + (options.existing?.length ? '\n[已有记忆，仅用于去重，不作为新事实来源]\n' + JSON.stringify(options.existing.map(n => ({id:n.id,content:n.content}))) + '\n仅当新事实与已有记忆含义完全一致时，返回该条事实及 mergeInto（已有记忆ID），补全来源；有新信息、变化或不同事件时必须独立保留。合并本批相同事实，避免碎片。' : '') }],
            temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.2,
            ...(options.signal ? {max_tokens:Math.min(2048,Math.max(256,Math.floor((Number(config.contextWindow || config.contextLength)||8192)/4)))} : {}),
            stream: false,
        }, headers, endpoint, false, options.signal ? {signal:options.signal,onUsage:options.onUsage,beforeRequest:options.onRequest} : null), options.timeout || 45000);
        return parseExtractionReply(response);
    }

    function historyEntries(character) {
        return (character.history || []).map((m, i) => {
            const entry = originalMessageEntry(m, true);
            return entry && { ...entry, ordinal: i + 1 };
        }).filter(Boolean);
    }
    const historyJobKey = id => `memoryPalaceHistoryJob:${id}`;
    async function getHistoryJob(characterId) {
        return (await dexieDB.globalSettings.get(historyJobKey(characterId)))?.value || null;
    }
    async function putHistoryJob(characterId, job) {
        await dexieDB.globalSettings.put({key:historyJobKey(characterId),value:job});
    }
    function historyProgress(job) {
        const done = job.batches.filter(b => b.status === 'success');
        const processed = done.reduce((sum,b) => sum + b.units.filter(u => u.last).length, 0);
        return { processed, remaining:job.total-processed, completed:done.length, totalBatches:job.batches.length };
    }
    async function renderHistoryProgress(character) {
        if (!character || character.id !== ui.characterId) return;
        const job = await getHistoryJob(character.id);
        if (character.id !== ui.characterId) return;
        const target = document.getElementById('palace-history-status');
        const actions = document.getElementById('palace-history-actions');
        if (!target || !actions) return;
        target.hidden = !job; actions.hidden = !job || ['completed','cancelled'].includes(job.status);
        if (!job) return;
        const p = historyProgress(job), active = historyRuns.has(character.id);
        const labels = {running:active?'正在整理':'已保存，等待继续',paused:'已暂停',failed:'本批失败',completed:'整理完成',cancelled:'已取消'};
        const summary=document.getElementById('palace-progress-open');if(summary){summary.hidden=false;summary.textContent=`${labels[job.status]||'整理进度'} · ${p.processed}/${job.total} 条 ›`;}
        target.textContent = `${labels[job.status] || '等待继续'} · 共 ${job.total} 条，已处理 ${p.processed} 条，剩余 ${p.remaining} 条 · 批次 ${Math.min(p.completed+1,p.totalBatches)}/${p.totalBatches}（成功 ${p.completed}，失败 ${job.batches.filter(b=>b.status==='failed').length}）${job.error?' · '+job.error:''}${job.linkError?' · '+job.linkError:''}`;
        actions.querySelector('[data-history-action="pause"]').hidden = !active;
        const resume = actions.querySelector('[data-history-action="resume"]');
        resume.hidden = active; resume.textContent = job.status === 'failed' ? '重试失败批次' : '继续整理';
    }
    async function createHistoryJob(character, selection) {
        if (!character.memoryPalaceEnabled) throw Error('请先开启记忆宫殿');
        const previous = await getHistoryJob(character.id);
        if (previous && !['completed','cancelled'].includes(previous.status)) throw Error('请先继续或取消已保存的整理任务');
        const config = featureConfig('memoryProcess',character);
        if (!config) throw Error('请先配置主 API；记忆宫殿会自动继承');
        const plan = Core.planHistoryArchive(historyEntries(character), selection, config);
        const job = {id:Core.id('mph'),status:'paused',createdAt:Date.now(),selection,...plan,concurrency:selection.concurrency===2?2:1,error:'',stored:0,merged:0};
        await putHistoryJob(character.id,job);
        return job;
    }
    async function commitHistoryBatch(character, job, index, candidates, mergeTargets, cache) {
        const batch = job.batches[index], ids = [...new Set(batch.units.map(u=>u.id))];
        const selectedIds=new Set(ids);
        const current = new Map((character.history||[]).filter(m=>selectedIds.has(String(m.id))).map(m=>originalMessageEntry(m,true)).filter(Boolean).map(m=>[m.id,m]));
        if (batch.units.some(u=>!current.has(u.id)||Core.memoryFingerprint(current.get(u.id).text)!==u.hash)) throw Error('本批原消息已变化，未保存结果；请重新选择范围');
        // Nodes and the success cursor commit together; an interrupted write cannot leave half a batch.
        await dexieDB.transaction('rw',dexieDB.memoryPalaceNodes,dexieDB.globalSettings,async()=>{
            const saved = await getHistoryJob(character.id);
            if (saved?.id !== job.id) throw Error('整理任务已变化，请重新打开');
            if (saved.batches[index]?.status === 'success') return;
            const existing = cache || await listNodes(character.id);
            const changed=[];
            for (const candidate of candidates) {
                const sources = candidate.sourceMessageIds.filter(id=>ids.includes(id));
                if (!sources.length) sources.push(...ids);
                const identical = existing.find(n => !n.archived && n.content.trim() === candidate.content.trim() && (n.subject || '') === (candidate.subject || '') && (n.layer !== 'episodes' || (n.source?.messageIds || []).some(id=>sources.includes(id))));
                const proposed = mergeTargets.find(n=>n.id===candidate.mergeInto);
                const semantic = proposed && existing.find(n=>n.id===proposed.id && n.content===proposed.content && !n.archived);
                const proposedMatch = identical || semantic;
                const match=proposedMatch ? await dexieDB.memoryPalaceNodes.get(proposedMatch.id) : null;
                if(match && match.content!==proposedMatch.content)throw Error('记忆已被编辑，整理结果已缓存，请重试保存');
                if (match) {
                    // Keep existing wording, room, annotations and ID; only append evidence.
                    match.source = {...match.source,messageIds:[...new Set([...(match.source?.messageIds || []),...sources])]};
                    match.revision = (match.revision || 0)+1; match.updatedAt=Date.now();
                    await dexieDB.memoryPalaceNodes.put(match);changed.push(match.id);existing[existing.findIndex(n=>n.id===match.id)]=match; job.merged++; continue;
                }
                const times=sources.map(id=>current.get(id)?.timestamp).filter(t=>t>0);
                const node = Core.normalizeNode({...candidate,id:Core.id('mpn'),characterId:character.id,source:{type:'history_archive',jobId:job.id,batch:index,messageIds:sources,startTimestamp:times.length?Math.min(...times):0,endTimestamp:times.length?Math.max(...times):0},revision:1});
                await dexieDB.memoryPalaceNodes.put(node); existing.push(node); job.stored++;
                changed.push(node.id);
            }
            batch.status='success'; batch.error=''; batch.finishedAt=Date.now(); job.error='';
            batch.nodeIds=changed;delete batch.result;delete batch.mergeTargets;
            await putHistoryJob(character.id,job);
        });
        runtime.delete(character.id);
    }
    function splitHistoryBatch(batch) {
        if (batch.units.length > 1) {
            const middle=Math.ceil(batch.units.length/2);
            return [batch.units.slice(0,middle),batch.units.slice(middle)];
        }
        const unit=batch.units[0];
        if (unit.end-unit.start<=256) return null;
        const middle=Math.floor((unit.start+unit.end)/2);
        return [[{...unit,end:middle,last:false}],[{...unit,start:middle}]];
    }
    async function runHistoryJob(character, lockHeld = false) {
        if (historyRuns.has(character.id)) return;
        if (global.navigator?.locks && !lockHeld) return navigator.locks.request(`mio-memory-archive:${character.id}`,{ifAvailable:true},async lock=>{
            if (!lock) throw Error('此角色正在其他页面整理，请稍后继续');
            return runHistoryJob(character,true);
        });
        if (archiveLocks.has(character.id)) throw Error('自动整理正在完成当前批，请稍后继续');
        const control = {action:''}; historyRuns.set(character.id,control); archiveLocks.add(character.id);
        let job, nodes;
        try {
            job=await getHistoryJob(character.id);
            if (!job || ['completed','cancelled'].includes(job.status)) return;
            if(job.status==='running'&&job.batches.some(b=>b.status==='running')){
                job.status='failed';job.error='上次请求中断，服务可能已计费；已返回的结果保留，请核对后再点重试';
                job.batches.filter(b=>b.status==='running').forEach(b=>{b.status='failed';b.error=job.error;});await putHistoryJob(character.id,job);return job;
            }
            job.status='running'; job.error=''; await putHistoryJob(character.id,job);
            const entries=historyEntries(character), byId=new Map(entries.map(m=>[m.id,m]));
            if (byId.size!==entries.length) throw Error('历史记录包含重复 ID，请先核对');
            nodes=await listNodes(character.id);
            let saveQueue=Promise.resolve();
            const checkpoint=()=>{saveQueue=saveQueue.then(()=>putHistoryJob(character.id,job));return saveQueue;};
            while(job.batches.some(b=>b.status!=='success')) {
                if(control.action || !character.memoryPalaceEnabled) {control.action ||= 'paused';break;}
                const pending=job.batches.filter(b=>b.status!=='success'&&b.status!=='ready').slice(0,job.concurrency===2?2:1);
                await Promise.all(pending.map(async batch=>{
                    const started=performance.now();
                    batch.metrics ||= {apiMs:0,prepareMs:0,writeMs:0,requests:0,inputTokens:0,outputTokens:0,usageReported:false};
                    const metrics=batch.metrics;
                    try {
                        const messages=batch.units.map(unit=>{const m=byId.get(unit.id);if(!m||Core.memoryFingerprint(m.text)!==unit.hash)throw Error('原消息已修改或缺失，请重新选择范围');return {...m,text:m.text.slice(unit.start,unit.end)};});
                        const words=Core.tokenize(messages.map(m=>m.text).join(' '));
                        const wordSet=new Set(words);
                        let size=0;
                        const config=featureConfig('memoryProcess',character)||{};
                        const budget=Math.min(1200,Math.floor((Number(config.contextWindow||config.contextLength)||8192)*0.15));
                        const existing=nodes.filter(n=>!n.archived).map(n=>({n,score:Core.tokenize(n.content).reduce((sum,w)=>sum+Number(wordSet.has(w)),0)})).sort((a,b)=>b.score-a.score).slice(0,6).map(x=>x.n).filter(n=>(size+=n.content.length)<=budget);
                        metrics.prepareMs+=performance.now()-started;
                        batch.status='running';await checkpoint();
                        for(let attempt=0;attempt<3;attempt++) {
                            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000),apiStart=performance.now();
                            batch.attempts++;metrics.requests++;
                            try {
                                batch.result=await extractArchiveChunk(character,messages,{signal:controller.signal,existing,onRequest:()=>{metrics.transportRequests=(metrics.transportRequests||0)+1;},onUsage:usage=>{
                                    if(!usage)return;metrics.usageReported=true;
                                    metrics.inputTokens+=Number(usage.prompt_tokens??usage.input_tokens??usage.promptTokenCount)||0;
                                    metrics.outputTokens+=Number(usage.completion_tokens??usage.output_tokens??usage.candidatesTokenCount)||0;
                                }});
                                batch.mergeTargets=existing.map(n=>({id:n.id,content:n.content}));batch.status='ready';batch.error='';
                                break;
                            }catch(error){
                                // A timed-out request may already be billed. Do not silently resubmit it.
                                if(/429|rate.limit|限流/i.test(error.message)&&attempt<2){job.concurrency=1;await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}
                                throw error;
                            }finally{clearTimeout(timer);metrics.apiMs+=performance.now()-apiStart;}
                        }
                        metrics.messageCount=new Set(batch.units.map(u=>u.id)).size;
                        metrics.estimatedInputTokens=Math.ceil(messages.reduce((n,m)=>n+m.text.length,0)/2)+800;
                    }catch(error){batch.status='failed';batch.error=error.name==='AbortError'?'请求超时，服务可能已计费；请核对后重试':error.message||String(error);}
                    metrics.elapsedMs=(metrics.elapsedMs||0)+performance.now()-started;
                    await checkpoint();
                }));
                for(let index=0;index<job.batches.length;index++) {
                    const batch=job.batches[index];if(batch.status==='success')continue;
                    if(batch.status==='failed'){
                        if(/context|token.*limit|too (?:long|large)|413|上下文/i.test(batch.error||'')){
                            const halves=splitHistoryBatch(batch);
                            if(halves){job.rejectedRequests=(job.rejectedRequests||0)+(batch.metrics?.requests||0);job.batches.splice(index,1,...halves.map(units=>({units,status:'pending',attempts:0})));await checkpoint();break;}
                        }
                        throw Error(batch.error);
                    }
                    if(batch.status!=='ready')break;
                    const writeStart=performance.now();
                    await commitHistoryBatch(character,job,index,batch.result,batch.mergeTargets||[],nodes);
                    batch.metrics ||= {};batch.metrics.writeMs=(batch.metrics.writeMs||0)+performance.now()-writeStart;
                    await checkpoint();
                }
                await renderHistoryProgress(character);
            }
            job.status=control.action||'completed';await putHistoryJob(character.id,job);
        } catch(error) {
            job=await getHistoryJob(character.id);
            if(job){job.status=control.action||'failed';job.error=error.message||String(error);await putHistoryJob(character.id,job);}
        } finally {
            // Rebuild evidenced links even after a pause/failure. A later resume retries link maintenance, not model extraction.
            if(job){try{const changed=job.batches.flatMap(b=>b.nodeIds||[]);if(changed.length)await refreshAutomaticLinks(character.id,[...new Set(changed)]);job.linkError='';}catch(error){job.linkError='关联更新失败：'+error.message;}await putHistoryJob(character.id,job);}
            historyRuns.delete(character.id);archiveLocks.delete(character.id);
            await renderHistoryProgress(character);if(character.id===ui.characterId)await render();
        }
        return job;
    }
    async function controlHistoryJob(character, action) {
        const running=historyRuns.get(character.id);
        if(running){if(action==='paused'||action==='cancelled'){running.action=action;showToast('将在当前请求保存后停止，不重复发送');}return;}
        if (action==='resume') return runHistoryJob(character);
        const update=async()=>{const job=await getHistoryJob(character.id);if(job){job.status=action;await putHistoryJob(character.id,job);}await renderHistoryProgress(character);};
        if(global.navigator?.locks)return navigator.locks.request(`mio-memory-archive:${character.id}`,{ifAvailable:true},lock=>{if(!lock)throw Error('任务在其他页面运行，请在该页面暂停');return update();});
        return update();
    }
    async function pickHistoryMessage(entries, title) {
        const resultPromise=showAppFormDialog({title,fields:[{name:'query',label:'搜索文字或消息序号',type:'search'},{name:'message',label:'选择消息（最多显示 60 条匹配结果）',type:'select',options:[]}],confirmText:'选择'});
        const form=document.getElementById('app-form-dialog');
        const query=form?.querySelector('[name=query]'),select=form?.querySelector('[name=message]');
        const fill=()=>{
            const search=(query.value||'').trim().toLocaleLowerCase();
            select.replaceChildren(...entries.filter(m=>!search || String(m.ordinal)===search || m.text.toLocaleLowerCase().includes(search)).slice(0,60).map(m=>new Option(`#${m.ordinal} · ${m.timestamp?new Date(m.timestamp).toLocaleDateString():''} · ${m.text.slice(0,65)}`,m.id)));
        };
        if(query&&select){query.addEventListener('input',fill);fill();}
        return (await resultPromise)?.message;
    }
    async function chooseHistoryRange(character) {
        const previous=await getHistoryJob(character.id);
        if(previous&&!['completed','cancelled'].includes(previous.status)){await renderHistoryProgress(character);document.getElementById('palace-progress-modal').classList.add('visible');return;}
        const chosen=await showAppFormDialog({title:'整理聊天记忆',message:'保留原聊天和已有记忆，整理文字及语音原文。自动整理设置不变。',fields:[{name:'mode',label:'整理范围',type:'select',value:'all',options:[{value:'all',label:'全部历史'},{value:'custom',label:'自选范围'},{value:'recent',label:'最近消息'}]},{name:'concurrency',label:'请求调度',type:'select',value:'1',options:[{value:'1',label:'稳妥 · 逐批整理'},{value:'2',label:'加速 · 最多同时 2 批'}]}],confirmText:'下一步'});
        if(!chosen)return;
        let selection=chosen;
        if(chosen.mode==='recent'){
            const range=await showAppFormDialog({title:'最近消息',fields:[{name:'count',label:'最近多少条可整理消息',type:'number',min:1,value:100,required:true}],confirmText:'下一步'});
            if(!range)return;selection={mode:'recent',count:range.count};
        }
        if(chosen.mode==='custom'){
            const method=await showAppFormDialog({title:'自选范围',fields:[{name:'mode',label:'选择方式',type:'select',options:[{value:'dates',label:'按日期'},{value:'numbers',label:'按消息序号'},{value:'messages',label:'选择起止消息'}]}],confirmText:'下一步'});
            if(!method)return;selection=method;
            if(method.mode==='messages'){
                const entries=historyEntries(character),start=await pickHistoryMessage(entries,'选择起始消息');if(!start)return;
                const end=await pickHistoryMessage(entries.slice(entries.findIndex(m=>m.id===start)),'选择结束消息');if(!end)return;
                selection={mode:'messages',start,end};
            }else{
                const dates=method.mode==='dates';
                const range=await showAppFormDialog({title:dates?'按日期整理':'按消息序号整理',message:dates?'包含起止日期当天的消息。':'序号按完整聊天记录从 1 开始，包含尚未加载到屏幕的消息。',fields:[{name:'start',label:dates?'开始日期':'起始序号',type:dates?'date':'number',min:dates?undefined:1,value:dates?'':1,required:true},{name:'end',label:dates?'结束日期':'结束序号',type:dates?'date':'number',min:dates?undefined:1,value:dates?'':character.history.length,required:true}],confirmText:'下一步'});
                if(!range)return;
                selection={mode:method.mode,start:dates?new Date(range.start+'T00:00:00').getTime():Number(range.start),end:dates?new Date(range.end+'T23:59:59.999').getTime():Number(range.end)};
                if(selection.start>selection.end)throw Error('结束范围不能早于开始范围');
            }
        }
        selection.concurrency=Number(chosen.concurrency)||1;
        const plan=Core.planHistoryArchive(historyEntries(character),selection,featureConfig('memoryProcess',character)||{});
        const confirmed=await showAppConfirmDialog({title:'开始整理？',message:`所选 ${plan.total} 条消息，预计 ${plan.batches.length} 次提取请求。输入与输出约 ${Math.ceil(plan.characters/4+plan.batches.length*500).toLocaleString()}–${Math.ceil(plan.characters+plan.batches.length*3000).toLocaleString()} Token（估算，重试或缩小批次会增加调用）。\n可暂停并在刷新后继续；保持此页面打开可连续完成。${previous?'重新整理仅追加或合并来源，不覆盖已有记忆。':''}`,confirmText:'开始整理',cancelText:'暂不开始'});
        if(confirmed!==true && confirmed!=='confirm')return;
        const create=async()=>createHistoryJob(character,selection);
        if(global.navigator?.locks)await navigator.locks.request(`mio-memory-archive:${character.id}`,{ifAvailable:true},lock=>{if(!lock)throw Error('此角色正在整理，请稍后继续');return create();});
        else await create();
        document.getElementById('palace-progress-modal').classList.add('visible');
        void runHistoryJob(character).catch(error=>showToast(error.message));
    }

    async function persistArchiveState(character, nextState) {
        character.memoryPalaceArchiveState = Core.normalizeArchiveState(nextState);
        if (typeof global.saveCharacter === 'function') await global.saveCharacter(character.id);
    }

    async function runAutoArchive(character, options = {}) {
        if (!character) return { skipped: true, reason: 'missing-character' };
        if (global.navigator?.locks && !options.lockHeld) {
            return global.navigator.locks.request(`mio-memory-archive:${character.id}`, { ifAvailable:true }, async lock => {
                if (!lock) return { skipped:true, reason:'lock' };
                const saved = await dexieDB.characters?.get(character.id);
                if ((saved?.memoryPalaceArchiveState?.lastRunAt || 0) > (character.memoryPalaceArchiveState?.lastRunAt || 0)) character.memoryPalaceArchiveState = saved.memoryPalaceArchiveState;
                return runAutoArchive(character, { ...options, lockHeld:true });
            });
        }
        ensureSettings(character);
        if (!character.memoryPalaceEnabled || (!character.autoArchiveEnabled && !options.force)) return { skipped: true, reason: 'disabled' };
        if (!featureConfig('memoryProcess', character)) return { skipped: true, reason: 'api-unavailable' };
        if (archiveLocks.has(character.id)) return { skipped: true, reason: 'lock' };
        archiveLocks.add(character.id);
        let state = Core.normalizeArchiveState(character.memoryPalaceArchiveState);
        try {
            let pending = state.pendingBatch;
            if (!pending) {
                const messages = (character.history || []).map(originalMessageEntry).filter(Boolean);
                const windowResult = Core.selectArchiveWindow(messages, state, character.memoryPalaceWaterline, { force: options.force === true });
                if (!windowResult.selected.length) return { skipped: true, reason: windowResult.skipReason, pending: windowResult.bufferCount };
                const chunks = [];
                for (let index = 0; index < windowResult.selected.length; index += 120) chunks.push(windowResult.selected.slice(index, index + 120));
                const extracted = [];
                for (const [index,chunk] of chunks.entries()) {
                    options.onProgress?.({completed:index,total:chunks.length});
                    extracted.push(...await extractArchiveChunk(character, chunk));
                    options.onProgress?.({completed:index+1,total:chunks.length});
                }
                if (!extracted.length) {
                    const end = windowResult.selected.at(-1);
                    await persistArchiveState(character, { ...state, watermarkMessageId:end.id, watermarkTimestamp:end.timestamp, processedMessages:state.processedMessages + windowResult.selected.length, lastRunAt:Date.now(), lastSuccessAt:Date.now(), lastError:'', batches:[...state.batches,{id:Core.id('mpb'),at:Date.now(),startMessageId:windowResult.selected[0].id,endMessageId:end.id,processed:windowResult.selected.length,stored:0,extracted:0,duplicates:0}] });
                    return { skipped: true, reason: 'empty', processed: windowResult.selected.length };
                }
                const lastSelected = windowResult.selected[windowResult.selected.length - 1];
                const selectedIds = new Set(windowResult.selected.map(item => item.id));
                pending = {
                    id: Core.id('mpb'),
                    startMessageId: windowResult.selected[0].id,
                    endMessageId: lastSelected.id,
                    startTimestamp: windowResult.selected[0].timestamp,
                    endTimestamp: lastSelected.timestamp,
                    processed: windowResult.selected.length,
                    messageIds: windowResult.selected.map(item => item.id),
                    candidates: extracted.map(candidate => ({
                        ...candidate,
                        sourceMessageIds: candidate.sourceMessageIds.filter(id => selectedIds.has(id)),
                    })),
                };
                await persistArchiveState(character, { ...state, pendingBatch: pending, lastRunAt: Date.now(), lastError: '' });
                state = Core.normalizeArchiveState(character.memoryPalaceArchiveState);
                pending = state.pendingBatch;
            }

            const extracted = pending.candidates;
            const existing = await listNodes(character.id);
            const hashes = new Set(existing.map(node => node.contentHash || Core.memoryFingerprint(node.content)));
            const batchId = pending.id;
            let stored = 0, duplicates = 0;
            const storedNodes = [];
            for (const candidate of extracted) {
                // Manual history runs leave the auto cursor untouched. Reuse their facts when auto later catches up.
                const historyMatch = existing.find(node => node.source?.type === 'history_archive' && !node.archived && node.content === candidate.content && node.subject === candidate.subject && node.layer === candidate.layer && (node.layer !== 'episodes' || node.source.messageIds?.some(id=>candidate.sourceMessageIds.includes(id))));
                if (historyMatch) {
                    await dexieDB.transaction('rw',dexieDB.memoryPalaceNodes,async()=>{
                        const latest=await dexieDB.memoryPalaceNodes.get(historyMatch.id);
                        if(!latest || latest.content!==historyMatch.content)throw Error('记忆已修改，请重试整理');
                        latest.source={...latest.source,messageIds:[...new Set([...(latest.source?.messageIds||[]),...candidate.sourceMessageIds])]};
                        await dexieDB.memoryPalaceNodes.put(latest);
                    });
                    duplicates++; continue;
                }
                const hash = character.memoryPalaceSevenEnabled
                    ? Core.memoryFingerprint([candidate.subject, candidate.layer, candidate.content, candidate.layer === 'episodes' ? candidate.sourceMessageIds.join(',') : ''].join('|'))
                    : Core.memoryFingerprint(candidate.content);
                if (hashes.has(hash)) { duplicates += 1; continue; }
                hashes.add(hash);
                const sourceMessageIds = candidate.sourceMessageIds;
                const sourceIds = sourceMessageIds.length ? sourceMessageIds
                    : [...new Set([pending.startMessageId, pending.endMessageId].filter(Boolean))];
                const result = await saveNode({
                    layer: candidate.layer, subject: candidate.subject, confidence: candidate.confidence, factKey: candidate.factKey,
                    characterId: character.id,
                    content: candidate.content,
                    room: candidate.room,
                    tags: candidate.tags,
                    entities: candidate.entities,
                    importance: candidate.importance,
                    mood: candidate.mood,
                    contentHash: hash,
                    source: {
                        type: 'auto_archive', batchId, messageIds: sourceIds,
                        startMessageId: pending.startMessageId,
                        endMessageId: pending.endMessageId,
                        startTimestamp: pending.startTimestamp,
                        endTimestamp: pending.endTimestamp,
                        characterDate: global.VirtualClock?.dateKey(global.VirtualClock.resolveCharacter(character)) || '',
                    },
                }, { silentEmbeddingError: true, skipLinkRefresh: true });
                stored += 1;
                storedNodes.push(result.node);
            }
            if (storedNodes.length) {
                try { await refreshAutomaticLinks(character.id, storedNodes.map(node => node.id)); }
                catch (error) { console.warn('[MemoryPalace] automatic link creation failed:', error); }
            }
            const now = Date.now();
            const batch = { id: batchId, at: now, startMessageId: pending.startMessageId, endMessageId: pending.endMessageId, processed: pending.processed, extracted: extracted.length, stored, duplicates };
            await persistArchiveState(character, {
                ...state,
                watermarkMessageId: pending.endMessageId,
                watermarkTimestamp: pending.endTimestamp,
                lastRunAt: now,
                lastSuccessAt: now,
                lastError: '',
                processedMessages: state.processedMessages + pending.processed,
                storedMemories: state.storedMemories + stored,
                batches: [...state.batches, batch],
                pendingBatch: null,
            });
            return { skipped: false, processed: pending.processed, extracted: extracted.length, stored, duplicates, batchId };
        } catch (error) {
            console.warn('[MemoryPalace] automatic archive failed without blocking chat:', error);
            state = Core.normalizeArchiveState(character.memoryPalaceArchiveState);
            try { await persistArchiveState(character, { ...state, lastRunAt: Date.now(), lastError: error.message || String(error) }); } catch (_) {}
            return { skipped: false, error: error.message || String(error), stored: 0 };
        } finally {
            archiveLocks.delete(character.id);
        }
    }

    async function checkAndTriggerAutoArchive(character) {
        if (character?.memoryPalaceArchiveState?.lastError && Date.now() - character.memoryPalaceArchiveState.lastRunAt < 300000) return { skipped:true, reason:'retry-delay' };
        const result = await runAutoArchive(character);
        if (result?.error) console.warn('[MemoryPalace] auto archive:', result.error);
        return result;
    }

    function normalizeEmbeddingConfig(config) {
        return config ? { ...config, key: config.key || config.apiKey || '', apiKey: config.apiKey || config.key || '' } : null;
    }

    async function embedTexts(texts, character) {
        const adapter = global.VectorMemoryEmbedding;
        const config = normalizeEmbeddingConfig(featureConfig('embedding', character));
        if (!adapter || !config) throw new Error('未配置独立 Embedding API');
        return withTimeout(adapter.fetchEmbeddings(texts, config), 8000);
    }

    function embeddingProfile(vector, character) {
        const config = normalizeEmbeddingConfig(featureConfig('embedding', character)) || {};
        if (global.VectorMemoryEmbedding?.getEmbeddingProfileKey) {
            return global.VectorMemoryEmbedding.getEmbeddingProfileKey(vector.length, config);
        }
        return `${config.url || config.baseUrl || ''}|${config.model || ''}|${vector.length}`;
    }

    async function listNodes(characterId, room = 'all') {
        if (!dexieDB?.memoryPalaceNodes || !characterId) return [];
        const list = room === 'all'
            ? await dexieDB.memoryPalaceNodes.where('characterId').equals(characterId).toArray()
            : await dexieDB.memoryPalaceNodes.where('[characterId+room]').equals([characterId, room]).toArray();
        return list.map(node => Core.normalizeNode(node, { characterId })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    }

    async function getNode(id) { return dexieDB?.memoryPalaceNodes ? dexieDB.memoryPalaceNodes.get(id) : null; }

    async function listLinks(characterId) {
        if (!dexieDB?.memoryPalaceLinks || !characterId) return [];
        const links = await dexieDB.memoryPalaceLinks.where('characterId').equals(characterId).toArray();
        return links.map(link => Core.normalizeLink(link, { characterId })).filter(link => link.sourceId && link.targetId && link.sourceId !== link.targetId)
            .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    async function linksForNode(characterId, nodeId) {
        return (await listLinks(characterId)).filter(link => link.sourceId === nodeId || link.targetId === nodeId);
    }

    async function listEventBoxes(characterId) {
        if (!dexieDB?.memoryPalaceEventBoxes || !characterId) return [];
        const boxes = await dexieDB.memoryPalaceEventBoxes.where('characterId').equals(characterId).toArray();
        return boxes.map(box => Core.normalizeEventBox(box, { characterId })).sort((left, right) => right.updatedAt - left.updatedAt);
    }

    async function getEventBox(id) {
        if (!id || !dexieDB?.memoryPalaceEventBoxes) return null;
        const box = await dexieDB.memoryPalaceEventBoxes.get(id);
        return box ? Core.normalizeEventBox(box) : null;
    }

    async function createEventBox(characterId, payload = {}) {
        if (!dexieDB?.memoryPalaceEventBoxes) throw new Error('当前数据库不支持事件盒');
        const nodeIds = [...new Set((payload.nodeIds || []).map(item => String(item || '').trim()).filter(Boolean))];
        if (!characterId || !nodeIds.length) throw new Error('事件盒至少需要一条记忆');
        const nodes = (await Promise.all(nodeIds.map(id => getNode(id)))).filter(node => node && node.characterId === characterId);
        if (!nodes.length) throw new Error('未找到可加入事件盒的记忆');
        const occupied = nodes.find(node => node.eventBoxId);
        if (occupied) throw new Error('所选记忆已经属于其他事件盒，请先移除后再加入');
        const box = Core.normalizeEventBox({ id: Core.id('mpe'), characterId, name: payload.name, tags: payload.tags, nodeIds: nodes.map(node => node.id), createdAt: Date.now(), updatedAt: Date.now() }, { characterId });
        await dexieDB.transaction('rw', dexieDB.memoryPalaceEventBoxes, dexieDB.memoryPalaceNodes, async () => {
            await dexieDB.memoryPalaceNodes.bulkPut(nodes.map(node => Core.normalizeNode({ ...node, eventBoxId: box.id }, { characterId })));
            await dexieDB.memoryPalaceEventBoxes.put(box);
        });
        return box;
    }

    async function addNodesToEventBox(boxId, nodeIds) {
        const box = await getEventBox(boxId);
        if (!box) throw new Error('事件盒不存在或已删除');
        if (box.status === 'sealed') throw new Error('已归档事件盒不能添加新记忆');
        const ids = [...new Set((nodeIds || []).map(item => String(item || '').trim()).filter(Boolean))].filter(id => !box.nodeIds.includes(id));
        if (!ids.length) return box;
        const nodes = (await Promise.all(ids.map(id => getNode(id)))).filter(node => node && node.characterId === box.characterId);
        const occupied = nodes.find(node => node.eventBoxId && node.eventBoxId !== box.id);
        if (occupied) throw new Error('所选记忆已经属于其他事件盒，请先移除后再加入');
        if (!nodes.length) throw new Error('未找到可加入事件盒的记忆');
        const updated = Core.normalizeEventBox({ ...box, nodeIds: [...box.nodeIds, ...nodes.map(node => node.id)], updatedAt: Date.now() }, { characterId: box.characterId });
        await dexieDB.transaction('rw', dexieDB.memoryPalaceEventBoxes, dexieDB.memoryPalaceNodes, async () => {
            await dexieDB.memoryPalaceNodes.bulkPut(nodes.map(node => Core.normalizeNode({ ...node, eventBoxId: box.id }, { characterId: box.characterId })));
            await dexieDB.memoryPalaceEventBoxes.put(updated);
        });
        return updated;
    }

    async function removeNodeFromEventBox(boxId, nodeId) {
        const box = await getEventBox(boxId);
        if (!box) return false;
        const node = await getNode(nodeId);
        const remaining = box.nodeIds.filter(id => id !== nodeId);
        await dexieDB.transaction('rw', dexieDB.memoryPalaceEventBoxes, dexieDB.memoryPalaceNodes, async () => {
            if (node && node.eventBoxId === box.id) await dexieDB.memoryPalaceNodes.put(Core.normalizeNode({ ...node, eventBoxId: null }, { characterId: box.characterId }));
            if (remaining.length) await dexieDB.memoryPalaceEventBoxes.put(Core.normalizeEventBox({ ...box, nodeIds: remaining, updatedAt: Date.now() }, { characterId: box.characterId }));
            else await dexieDB.memoryPalaceEventBoxes.delete(box.id);
        });
        return true;
    }

    async function deleteEventBox(boxId) {
        const box = await getEventBox(boxId);
        if (!box) return false;
        const nodes = await listNodes(box.characterId);
        await dexieDB.transaction('rw', dexieDB.memoryPalaceEventBoxes, dexieDB.memoryPalaceNodes, async () => {
            const owned = nodes.filter(node => node.eventBoxId === box.id).map(node => Core.normalizeNode({ ...node, eventBoxId: null }, { characterId: box.characterId }));
            if (owned.length) await dexieDB.memoryPalaceNodes.bulkPut(owned);
            await dexieDB.memoryPalaceEventBoxes.delete(box.id);
        });
        return true;
    }

    function roomPlateKey(characterId, room) { return `${characterId}:${room}`; }

    async function getRoomPlate(characterId, room) {
        if (!dexieDB?.memoryPalaceRoomPlates || !characterId || !Core.ROOM_PLATE_ROOMS.includes(room)) return null;
        const plate = await dexieDB.memoryPalaceRoomPlates.get(roomPlateKey(characterId, room));
        return plate ? Core.normalizeRoomPlate(plate, { characterId }) : null;
    }

    async function listRoomPlates(characterId) {
        if (!dexieDB?.memoryPalaceRoomPlates || !characterId) return [];
        const plates = await dexieDB.memoryPalaceRoomPlates.where('characterId').equals(characterId).toArray();
        return plates.map(plate => Core.normalizeRoomPlate(plate, { characterId }))
            .sort((left, right) => Core.ROOM_PLATE_ROOMS.indexOf(left.room) - Core.ROOM_PLATE_ROOMS.indexOf(right.room));
    }

    async function saveRoomPlate(payload) {
        if (!dexieDB?.memoryPalaceRoomPlates) throw new Error('当前数据库不支持房间铭牌');
        const characterId = String(payload?.characterId || '');
        const room = payload?.room;
        if (!characterId || !Core.ROOM_PLATE_ROOMS.includes(room)) throw new Error('房间铭牌角色或房间无效');
        const plate = Core.normalizeRoomPlate({ ...payload, id: roomPlateKey(characterId, room), characterId, room, updatedAt: Date.now() }, { characterId });
        await dexieDB.memoryPalaceRoomPlates.put(plate);
        return plate;
    }

    async function mutateRoomPlate(characterId, room, change) {
        if (!Core.ROOM_PLATE_ROOMS.includes(room)) throw new Error('不支持的房间铭牌');
        const key = roomPlateKey(characterId, room);
        const run = async () => {
            const current = await getRoomPlate(characterId, room) || Core.normalizeRoomPlate({ id: key, characterId, room, entries: [] }, { characterId });
            const next = change(current);
            if (!next) return null;
            return saveRoomPlate({ ...next, characterId, room, id: key, version: current.version + 1 });
        };
        const queued = (roomPlateWriteQueues.get(key) || Promise.resolve()).then(run, run);
        roomPlateWriteQueues.set(key, queued.catch(() => {}));
        return queued;
    }

    async function updateRoomPlateEntry(characterId, room, entryId, text) {
        const normalizedText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, Core.ROOM_PLATE_ENTRY_HARD_MAX_CHARS);
        if (!normalizedText) throw new Error('铭牌内容不能为空');
        let found = false;
        const result = await mutateRoomPlate(characterId, room, plate => {
            const entries = plate.entries.map(entry => entry.id === entryId ? { ...entry, text: normalizedText, updatedAt: Date.now() } : entry);
            found = entries.some((entry, index) => entry.id === entryId && entry.text === normalizedText && plate.entries[index]?.text !== normalizedText);
            return entries.some(entry => entry.id === entryId) ? { ...plate, entries, updatedAt: Date.now() } : null;
        });
        if (!result && !found) throw new Error('铭牌条目不存在或已被删除');
        return result;
    }

    async function deleteRoomPlateEntry(characterId, room, entryId) {
        let removed = false;
        const result = await mutateRoomPlate(characterId, room, plate => {
            const entries = plate.entries.filter(entry => entry.id !== entryId);
            removed = entries.length !== plate.entries.length;
            return removed ? { ...plate, entries, updatedAt: Date.now() } : null;
        });
        if (!removed) return false;
        return result;
    }

    async function getAnticipation(id) {
        if (!dexieDB?.memoryPalaceAnticipations || !id) return null;
        const record = await dexieDB.memoryPalaceAnticipations.get(String(id));
        return record ? Core.normalizeAnticipation(record) : null;
    }

    async function listAnticipations(characterId, options = {}) {
        if (!dexieDB?.memoryPalaceAnticipations || !characterId) return [];
        const records = await dexieDB.memoryPalaceAnticipations.where('characterId').equals(characterId).toArray();
        const normalized = records.map(record => Core.normalizeAnticipation(record, { characterId }));
        if (options.advance !== false) {
            const now = Number(options.now) || Date.now();
            const advanced = normalized.map(item => Core.advanceAnticipation(item, now));
            const changed = advanced.filter((item, index) => item.status !== normalized[index].status || item.anchoredAt !== normalized[index].anchoredAt);
            if (changed.length) await dexieDB.memoryPalaceAnticipations.bulkPut(changed);
            return advanced.sort((left, right) => right.createdAt - left.createdAt);
        }
        return normalized.sort((left, right) => right.createdAt - left.createdAt);
    }

    async function saveAnticipation(payload) {
        if (!dexieDB?.memoryPalaceAnticipations) throw new Error('当前数据库不支持期盼记录');
        const characterId = String(payload?.characterId || '');
        const content = String(payload?.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!characterId || !content) throw new Error('期盼角色或内容无效');
        const record = Core.normalizeAnticipation({ ...payload, characterId, content, updatedAt: Date.now() }, { characterId });
        await dexieDB.memoryPalaceAnticipations.put(record);
        return record;
    }

    async function createAnticipation(characterId, content) {
        return saveAnticipation({ id: Core.id('mpa'), characterId, content, status: 'active', createdAt: Date.now(), anchoredAt: null, resolvedAt: null });
    }

    async function updateAnticipation(id, changes = {}) {
        const key = String(id || '');
        if (!key) throw new Error('期盼记录 ID 无效');
        const run = async () => {
            const current = await getAnticipation(key);
            if (!current) throw new Error('期盼记录不存在或已被删除');
            const status = Object.prototype.hasOwnProperty.call(Core.ANTICIPATION_STATUSES, changes.status) ? changes.status : current.status;
            const now = Date.now();
            const next = { ...current, ...changes, id: key, characterId: current.characterId, status, updatedAt: now };
            if (status === 'active') { next.anchoredAt = null; next.resolvedAt = null; }
            if (status === 'anchor') { next.anchoredAt = current.anchoredAt || now; next.resolvedAt = null; }
            if (status === 'fulfilled' || status === 'disappointed') { next.resolvedAt = current.resolvedAt || now; }
            return saveAnticipation(next);
        };
        const queued = (anticipationWriteQueues.get(key) || Promise.resolve()).then(run, run);
        anticipationWriteQueues.set(key, queued.catch(() => {}));
        return queued;
    }

    async function deleteAnticipation(id) {
        if (!dexieDB?.memoryPalaceAnticipations || !id) return false;
        const current = await getAnticipation(id);
        if (!current) return false;
        await dexieDB.memoryPalaceAnticipations.delete(String(id));
        return true;
    }

    async function advanceAnticipationLifecycle(characterId, options = {}) {
        return listAnticipations(characterId, { ...options, advance: true });
    }

    async function getDigestReport(id) {
        if (!dexieDB?.memoryPalaceDigestReports || !id) return null;
        const record = await dexieDB.memoryPalaceDigestReports.get(String(id));
        return record ? Core.normalizeDigestReport(record) : null;
    }

    async function listDigestReports(characterId) {
        if (!dexieDB?.memoryPalaceDigestReports || !characterId) return [];
        const records = await dexieDB.memoryPalaceDigestReports.where('characterId').equals(characterId).toArray();
        return records.map(record => Core.normalizeDigestReport(record, { characterId })).sort((left, right) => right.createdAt - left.createdAt);
    }

    async function saveDigestReport(payload = {}) {
        if (!dexieDB?.memoryPalaceDigestReports) throw new Error('当前数据库不支持整理记录');
        const characterId = String(payload.characterId || payload.charId || '');
        if (!characterId) throw new Error('整理记录缺少角色');
        const record = Core.normalizeDigestReport({ ...payload, characterId }, { characterId });
        await dexieDB.memoryPalaceDigestReports.put(record);
        const reports = await listDigestReports(characterId);
        const overflow = reports.slice(Core.DIGEST_REPORT_KEEP);
        if (overflow.length) {
            try { await dexieDB.memoryPalaceDigestReports.bulkDelete(overflow.map(item => item.id)); }
            catch (error) { console.warn('[MemoryPalace] 整理记录保留上限清理失败', error); }
        }
        return record;
    }

    async function deleteDigestReport(id) {
        if (!dexieDB?.memoryPalaceDigestReports || !id) return false;
        const current = await getDigestReport(id);
        if (!current) return false;
        await dexieDB.memoryPalaceDigestReports.delete(String(id));
        return true;
    }

    async function refreshAutomaticLinks(characterId, nodeIds) {
        if (!dexieDB?.memoryPalaceLinks || !characterId || !Array.isArray(nodeIds) || !nodeIds.length) return [];
        const [nodes, links] = await Promise.all([listNodes(characterId), listLinks(characterId)]);
        const owner=(db.characters||[]).find(c=>c.id===characterId);
        const times=new Map((owner?.history||[]).map(m=>[String(m.id),Number(m.timestamp)||0]));
        for(const node of nodes)if(node.source?.type==='history_archive'&&!node.source.startTimestamp){
            const evidence=(node.source.messageIds||[]).map(id=>times.get(String(id))).filter(t=>t>0);
            if(evidence.length)node.source={...node.source,startTimestamp:Math.min(...evidence),endTimestamp:Math.max(...evidence)};
        }
        const changed = new Set(nodeIds);
        const affected = nodes.filter(node => changed.has(node.id));
        if (!affected.length) return [];
        const retained = links.filter(link => link.origin === 'manual' || (!changed.has(link.sourceId) && !changed.has(link.targetId)));
        const automatic = Core.buildAutomaticLinks(affected, nodes.filter(node => !changed.has(node.id)), retained);
        await dexieDB.transaction('rw', dexieDB.memoryPalaceLinks, async () => {
            const stale = links.filter(link => link.origin !== 'manual' && (changed.has(link.sourceId) || changed.has(link.targetId)));
            if (stale.length) await dexieDB.memoryPalaceLinks.bulkDelete(stale.map(link => link.id));
            if (automatic.length) await dexieDB.memoryPalaceLinks.bulkPut(automatic);
        });
        return automatic;
    }

    async function saveLink(payload) {
        const characterId = String(payload?.characterId || ui.characterId || '');
        const link = Core.normalizeLink({ ...payload, characterId, origin: 'manual', updatedAt: Date.now() }, { characterId });
        if (!characterId || !link.sourceId || !link.targetId || link.sourceId === link.targetId) throw new Error('请选择两条不同的记忆');
        const [source, target, links] = await Promise.all([getNode(link.sourceId), getNode(link.targetId), listLinks(characterId)]);
        if (!source || !target || source.characterId !== characterId || target.characterId !== characterId) throw new Error('关联的记忆不存在或不属于当前角色');
        const duplicate = links.find(item => Core.linkKey(item.sourceId, item.targetId, item.type) === Core.linkKey(link.sourceId, link.targetId, link.type));
        if (duplicate) {
            if (duplicate.origin === 'manual') {
                await dexieDB.memoryPalaceLinks.put({ ...duplicate, strength: link.strength, updatedAt: Date.now() });
                return { ...duplicate, strength: link.strength };
            }
            throw new Error('相同类型的自动关联已存在');
        }
        await dexieDB.memoryPalaceLinks.put(link);
        return link;
    }

    async function deleteLink(id) {
        if (!id || !dexieDB?.memoryPalaceLinks) return false;
        await dexieDB.memoryPalaceLinks.delete(id);
        return true;
    }

    async function saveNode(payload, options = {}) {
        const character = (db.characters || []).find(item => item.id === (payload.characterId || ui.characterId));
        if (!character) throw new Error('未找到角色');
        const existing = payload.id ? await getNode(payload.id) : null;
        const contentChanged = !existing || String(existing.content || '').trim() !== String(payload.content || '').trim();
        const node = Core.normalizeNode({ ...existing, ...payload, characterId: character.id, updatedAt: Date.now(), embedded: contentChanged ? false : existing?.embedded, embeddingProfileKey: contentChanged ? '' : existing?.embeddingProfileKey }, { characterId: character.id });
        node.revision = (existing?.revision || 0) + 1;
        if (!node.content) throw new Error('记忆正文不能为空');
        let vectorRecord = null;
        let embeddingError = null;
        try {
            if (options.localOnly) {
                // Explicit local imports must not send their content to an embedding provider.
            } else if (!contentChanged && existing?.embedded) {
                // 只改标签/房间/固定状态时保留原向量，不发 API。
            } else {
            const vector = (await embedTexts([node.content], character))[0];
            if (Array.isArray(vector) && vector.length) {
                node.embedded = true;
                node.embeddingProfileKey = embeddingProfile(vector, character);
                const config = featureConfig('embedding', character) || {};
                vectorRecord = { memoryId: node.id, characterId: character.id, vector, dimensions: vector.length, model: config.model || '', profileKey: node.embeddingProfileKey, updatedAt: Date.now() };
            }
            }
        } catch (error) {
            embeddingError = error;
        }
        await dexieDB.transaction('rw', dexieDB.memoryPalaceNodes, dexieDB.memoryPalaceVectors, async () => {
            await dexieDB.memoryPalaceNodes.put(node);
            if (vectorRecord) await dexieDB.memoryPalaceVectors.put(vectorRecord);
            else if (contentChanged) await dexieDB.memoryPalaceVectors.delete(node.id);
        });
        if (!options.skipLinkRefresh) {
            try { await refreshAutomaticLinks(character.id, [node.id]); }
            catch (error) { console.warn('[MemoryPalace] link refresh failed after saving node:', error); }
        }
        runtime.delete(character.id);
        if (embeddingError && !options.silentEmbeddingError) console.warn('[MemoryPalace] saved with lexical retrieval:', embeddingError);
        return { node, embedded: node.embedded === true, embeddingError };
    }

    async function deleteNode(id) {
        const node = await getNode(id);
        if (!node) return false;
        const tables = [dexieDB.memoryPalaceNodes, dexieDB.memoryPalaceVectors, dexieDB.memoryPalaceLinks, dexieDB.memoryPalaceEventBoxes].filter(Boolean);
        await dexieDB.transaction('rw', ...tables, async () => {
            if (node.eventBoxId && dexieDB.memoryPalaceEventBoxes) {
                const box = await dexieDB.memoryPalaceEventBoxes.get(node.eventBoxId);
                if (box) {
                    const remaining = (Core.normalizeEventBox(box).nodeIds || []).filter(memberId => memberId !== id);
                    if (remaining.length) await dexieDB.memoryPalaceEventBoxes.put(Core.normalizeEventBox({ ...box, nodeIds: remaining, updatedAt: Date.now() }, { characterId: node.characterId }));
                    else await dexieDB.memoryPalaceEventBoxes.delete(box.id);
                }
            }
            await dexieDB.memoryPalaceNodes.delete(id);
            await dexieDB.memoryPalaceVectors.delete(id);
            if (dexieDB.memoryPalaceLinks) {
                const links = await linksForNode(node.characterId, id);
                if (links.length) await dexieDB.memoryPalaceLinks.bulkDelete(links.map(link => link.id));
            }
        });
        runtime.delete(node.characterId);
        return true;
    }

    async function reembed(characterId, ids) {
        const character = (db.characters || []).find(item => item.id === characterId);
        const nodes = (await listNodes(characterId)).filter(node => !ids || ids.includes(node.id));
        if (!nodes.length) return 0;
        const vectors = await embedTexts(nodes.map(node => node.content), character);
        const config = featureConfig('embedding', character) || {};
        const records = [];
        nodes.forEach((node, index) => {
            const vector = vectors[index];
            if (!Array.isArray(vector) || !vector.length) return;
            node.embedded = true; node.embeddingProfileKey = embeddingProfile(vector, character); node.updatedAt = Date.now();
            records.push({ memoryId: node.id, characterId, vector, dimensions: vector.length, model: config.model || '', profileKey: node.embeddingProfileKey, updatedAt: Date.now() });
        });
        await dexieDB.transaction('rw', dexieDB.memoryPalaceNodes, dexieDB.memoryPalaceVectors, async () => {
            if (nodes.length) await dexieDB.memoryPalaceNodes.bulkPut(nodes);
            if (records.length) await dexieDB.memoryPalaceVectors.bulkPut(records);
        });
        runtime.delete(characterId);
        return records.length;
    }

    async function rerank(query, results, character) {
        const config = normalizeEmbeddingConfig(featureConfig('rerank', character));
        if (!config || !results.length) return results;
        try {
            const ranked = await global.VectorMemoryEmbedding.fetchRerank(query, results.map(item => item.node.content), config);
            const mapped = ranked.slice(0, 12).map(item => ({ ...results[item.index], rerankScore: item.score })).filter(item => item.node);
            return mapped.length ? mapped : results;
        } catch (error) {
            console.warn('[MemoryPalace] rerank fallback:', error);
            return results;
        }
    }

    function buildQuery(character, override) {
        if (override) return String(override).slice(0, 4000);
        return (character.history || []).filter(message => !message.isContextDisabled && !message.isThinking).slice(-8).map(message => {
            const raw = global.MessageReference ? global.MessageReference.extractText(message) : (message.content || '');
            const parsed = global.MessageContentParser ? global.MessageContentParser.parse(raw) : { original: raw };
            return `${message.role === 'user' ? (character.myName || '用户') : (character.remarkName || character.name || '角色')}：${parsed.original}`;
        }).join('\n').slice(0, 4000);
    }

    async function search(character, query, options = {}) {
        ensureSettings(character);
        if (!character.memoryPalaceEnabled && !options.force) return [];
        const now = global.VirtualClock ? global.VirtualClock.virtualInstantMs(global.VirtualClock.resolveCharacter(character)) : Date.now();
        const nodes = (await listNodes(character.id)).filter(node => !node.archived && (node.validUntil == null || node.validUntil > now));
        if (!nodes.length) return [];
        let queryVector = null;
        try { queryVector = (await withTimeout(embedTexts([query], character), 8000))[0] || null; }
        catch (error) { console.warn('[MemoryPalace] embedding fallback:', error); }
        const vectorRecords = await dexieDB.memoryPalaceVectors.where('characterId').equals(character.id).toArray();
        const compatible = queryVector ? vectorRecords.filter(record => record.dimensions === queryVector.length) : [];
        if (character.memoryPalaceSevenEnabled && global.MemoryGovernanceCore) {
            const results = await global.MemoryGovernanceCore.recall(nodes, compatible, await listLinks(character.id), query, queryVector, {
                now, dateKey: global.VirtualClock?.dateKey(global.VirtualClock.resolveCharacter(character)),
                activation: character.memoryPalaceActivationEnabled, limit: character.memoryPalaceTopK,
            });
            try { return await withTimeout(rerank(query, results, character), 8000); }
            catch (_) { return results; }
        }
        let results = Core.hybridSearch(nodes, compatible, query, queryVector, { limit: 12, threshold: 0.08 });
        try { results = await withTimeout(rerank(query, results, character), 8000); } catch (_) { /* local recall remains usable */ }
        const topK = Math.max(1, Number(character.memoryPalaceTopK) || 8);
        const seeds = results.slice(0, topK);
        const selected = character.memoryPalaceActivationEnabled
            ? Core.spreadingActivation(seeds, nodes, await listLinks(character.id), {
                maxExpand: character.memoryPalaceActivationMaxExpand,
                style: character.memoryPalaceActivationStyle,
            }).slice(0, topK + Math.max(0, Math.min(Core.ACTIVATION_MAX_EXPAND, Number(character.memoryPalaceActivationMaxExpand) || Core.ACTIVATION_MAX_EXPAND)))
            : seeds;
        if (selected.length) {
            const now = Date.now();
            await dexieDB.memoryPalaceNodes.bulkPut(selected.map(item => ({ ...item.node, lastAccessedAt: now, accessCount: (item.node.accessCount || 0) + 1 })));
        }
        return selected;
    }

    async function prepareContext(character, options = {}) {
        ensureSettings(character);
        if (!character.memoryPalaceEnabled) { runtime.delete(character.id); return ''; }
        const query = buildQuery(character, options.queryText);
        try {
            const results = await search(character, query);
            const block = Core.formatContext(results, character.memoryPalaceTopK);
            runtime.set(character.id, { query, block, ids: results.map(item => item.node.id), preparedAt: Date.now() });
            return block;
        } catch (error) {
            console.warn('[MemoryPalace] context preparation failed:', error);
            runtime.set(character.id, { query, block: '', ids: [], error: error.message, preparedAt: Date.now() });
            return '';
        }
    }

    function getContext(character) {
        ensureSettings(character);
        return character.memoryPalaceEnabled ? (runtime.get(character.id)?.block || '') : '';
    }

    function combineContexts(character, legacyContext) {
        ensureSettings(character);
        return [character.legacyMemoryEnabled !== false ? legacyContext : '', getContext(character)].filter(Boolean).join('\n\n');
    }

    function escapeHtml(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function sourceSummary(node) {
        const source = node?.source || {};
        if (source.type === 'auto_archive') return `自动整理 · ${Array.isArray(source.messageIds) ? source.messageIds.length : 0} 条来源消息`;
        if (source.type === 'history_archive') return `历史整理 · ${Array.isArray(source.messageIds) ? source.messageIds.length : 0} 条来源消息`;
        if (source.type === 'import') return '导入记忆';
        return '手动记忆';
    }

    function currentCharacter() { return (db.characters || []).find(item => item.id === ui.characterId) || null; }

    // Custom rooms store references on the character; semantic room IDs and memory records stay unchanged.
    function isCustomRoom(id) { return typeof id === 'string' && /^custom_[a-zA-Z0-9_-]+$/.test(id); }

    function getRoomLayout(characterId) {
        const character = (db.characters || []).find(item => item.id === characterId);
        const saved = Array.isArray(character?.memoryPalaceRoomLayout) ? character.memoryPalaceRoomLayout : [];
        const ids = [...new Set([...saved.map(room => room?.id), ...Object.keys(Core.ROOMS)])].filter(id => Object.hasOwn(Core.ROOMS, id) || isCustomRoom(id));
        return ids.map(id => {
            const room = saved.find(item => item?.id === id);
            const label = String(room?.label || Core.ROOMS[id]?.label || '自定义房间').trim().slice(0, 24);
            return { id, label: label || Core.ROOMS[id]?.label || '自定义房间', hidden: room?.hidden === true,
                ...(isCustomRoom(id) ? { nodeIds: [...new Set((Array.isArray(room?.nodeIds) ? room.nodeIds : []).filter(id => typeof id === 'string' && id))] } : {}) };
        });
    }

    function validateRoomLayout(rooms) {
        if (!Array.isArray(rooms) || new Set(rooms.map(room => room?.id)).size !== rooms.length || Object.keys(Core.ROOMS).some(id => !rooms.some(room => room?.id === id))
            || rooms.some(room => !(Object.hasOwn(Core.ROOMS, room?.id) || isCustomRoom(room?.id)) || typeof room.label !== 'string' || !room.label.trim() || room.label.trim().length > 24
                || isCustomRoom(room.id) && (!Array.isArray(room.nodeIds) || room.nodeIds.some(id => typeof id !== 'string' || !id)))) throw Error('房间名称需为 1–24 字，基础房间不可删除');
    }

    function saveRoomLayout(characterId, rooms) {
        const draft = Array.isArray(rooms) ? rooms.map(room => room && ({ ...room, ...(Array.isArray(room.nodeIds) ? { nodeIds: room.nodeIds.slice() } : {}) })) : rooms;
        const next = (roomLayoutWriteQueues.get(characterId) || Promise.resolve()).catch(() => {}).then(() => persistRoomLayout(characterId, draft));
        roomLayoutWriteQueues.set(characterId, next);
        return next.finally(() => { if (roomLayoutWriteQueues.get(characterId) === next) roomLayoutWriteQueues.delete(characterId); });
    }

    async function persistRoomLayout(characterId, rooms) {
        const character = (db.characters || []).find(item => item.id === characterId);
        if (!character) throw Error('角色不存在');
        validateRoomLayout(rooms);
        const nodeIds = [...new Set(rooms.flatMap(room => isCustomRoom(room.id) ? room.nodeIds : []))];
        const nodes = nodeIds.length ? await dexieDB.memoryPalaceNodes.bulkGet(nodeIds) : [];
        if (nodes.some(node => node && node.characterId !== characterId)) throw Error('只能整理当前角色的记忆');
        const existingIds = new Set(nodes.filter(Boolean).map(node => node.id));
        if (!(db.characters || []).includes(character)) throw Error('角色已重新载入，请重试房间整理');
        const previous = character.memoryPalaceRoomLayout;
        const draft = rooms.map(room => ({ id: room.id, label: room.label.trim(), hidden: room.hidden === true,
            ...(isCustomRoom(room.id) ? { nodeIds: [...new Set(room.nodeIds)].filter(id => existingIds.has(id)) } : {}) }));
        character.memoryPalaceRoomLayout = draft;
        try { if (await global.saveCharacter(characterId) === false) throw Error('房间设置保存失败，请重试'); }
        catch (error) {
            // A shared saveCharacter queue may commit once before a later pass fails.
            let saved = previous;
            if (typeof dexieDB !== 'undefined' && dexieDB.characters) {
                try { saved = (await dexieDB.characters.get(characterId))?.memoryPalaceRoomLayout; }
                catch (readError) { console.warn('[MemoryPalace] could not reread room settings after failed save:', readError); }
            }
            if (character.memoryPalaceRoomLayout === draft) {
                if (saved === undefined) delete character.memoryPalaceRoomLayout;
                else character.memoryPalaceRoomLayout = saved;
            }
            throw error;
        }
        return getRoomLayout(characterId);
    }

    function renderRoomOptions() {
        const rooms = getRoomLayout(ui.characterId);
        if (ui.room !== 'all' && !rooms.some(room => room.id === ui.room && !room.hidden)) ui.room = 'all';
        const filter = document.getElementById('memory-palace-room-filter');
        if (filter) {
            filter.replaceChildren(new Option('全部房间', 'all'), ...rooms.filter(room => !room.hidden).map(room => new Option((isCustomRoom(room.id) ? '自定义 · ' : '') + room.label, room.id)));
            filter.value = ui.room;
        }
        const editor = document.getElementById('memory-palace-room');
        if (editor) {
            const selected = editor.value;
            editor.replaceChildren(...rooms.filter(room => !isCustomRoom(room.id)).map(room => new Option(room.label + (room.hidden ? '（已收起）' : ''), room.id)));
            editor.value = selected || 'living_room';
        }
    }

    function renderRoomManager() {
        const list = document.getElementById('memory-palace-rooms-list');
        const rooms = getRoomLayout(ui.characterId);
        list.innerHTML = rooms.map((room, index) => `<div class="memory-palace-room-row" data-room-id="${room.id}">
            <div><strong>${escapeHtml(room.label)}</strong><small>${isCustomRoom(room.id) ? '自定义房间' : escapeHtml(Core.ROOMS[room.id].description)}${room.hidden ? ' · 已收起' : ''}</small></div>
            <div class="memory-palace-room-controls">
                <button type="button" data-room-action="rename">改名</button>
                <button type="button" data-room-action="up" aria-label="上移${escapeHtml(room.label)}" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" data-room-action="down" aria-label="下移${escapeHtml(room.label)}" ${index === rooms.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" data-room-action="${isCustomRoom(room.id) ? 'delete' : 'toggle'}">${isCustomRoom(room.id) ? '删除' : room.hidden ? '恢复' : '收起'}</button>
            </div>
        </div>`).join('');
    }

    async function handleRoomLayoutAction(event) {
        const button = event.target.closest('[data-room-action]');
        const character = currentCharacter();
        if (!button || !character) return;
        const list = document.getElementById('memory-palace-rooms-list');
        if (list.getAttribute('aria-busy') === 'true') return;
        list.setAttribute('aria-busy', 'true');
        try {
            const rooms = getRoomLayout(character.id);
            const index = rooms.findIndex(room => room.id === button.closest('[data-room-id]')?.dataset.roomId);
            let room = rooms[index];
            const action = button.dataset.roomAction;
            if (action === 'add' || action === 'rename') {
                const result = await showAppFormDialog({ title: action === 'add' ? '新建自定义房间' : '房间名称', fields: [{ name: 'name', label: '名称（最多 24 字）', value: room?.label || '', required: true, maxLength: 24 }], confirmText: action === 'add' ? '新建' : '保存' });
                if (!result) return;
                if (action === 'add') { room = { id: Core.id('custom'), label: result.name, hidden: false, nodeIds: [] }; rooms.push(room); }
                else room.label = result.name;
            } else if (action === 'delete' && isCustomRoom(room?.id)) {
                if (await showAppConfirmDialog({ title: '删除自定义房间', message: `删除“${room.label}”？其中的记忆会完整保留，仍可在全部房间及其他房间查看。`, confirmText: '删除房间', dismissText: '' }) !== 'confirm') return;
                rooms.splice(index, 1);
            } else if (action === 'toggle' && room && !isCustomRoom(room.id)) {
                if (!room.hidden && await showAppConfirmDialog({ title: '收起房间', message: `收起“${room.label}”？其中的记忆仍可在“全部房间”查看，随时可以恢复房间。`, confirmText: '收起', dismissText: '' }) !== 'confirm') return;
                room.hidden = !room.hidden;
            } else if ((action === 'up' || action === 'down') && room) {
                const target = index + (action === 'up' ? -1 : 1);
                if (target < 0 || target >= rooms.length) return;
                [rooms[index], rooms[target]] = [rooms[target], rooms[index]];
            } else return;
            await saveRoomLayout(character.id, rooms);
            if (ui.characterId === character.id) {
                renderRoomManager(); renderRoomOptions(); await render();
                const focus = list.querySelector(`[data-room-id="${room.id}"] [data-room-action="${action === 'add' ? 'rename' : action}"]`);
                (focus && !focus.disabled ? focus : document.getElementById('memory-palace-rooms-close')).focus();
            }
        } catch (error) { showToast(error.message || '房间设置保存失败'); }
        finally { list.removeAttribute('aria-busy'); }
    }

    async function organizeNodeRooms(node) {
        const rooms = getRoomLayout(node.characterId).filter(room => isCustomRoom(room.id));
        if (!rooms.length) { document.getElementById('memory-palace-rooms-btn').click(); return; }
        const result = await showAppFormDialog({ title: '整理到房间', message: '同一条记忆可放入多个房间。取消勾选只移出房间，记忆会保留。',
            fields: rooms.map(room => ({ name: room.id, label: room.label, type: 'checkbox', value: room.nodeIds.includes(node.id) })), confirmText: '保存' });
        if (!result) return;
        const latest = getRoomLayout(node.characterId);
        latest.forEach(room => {
            if (!isCustomRoom(room.id) || !Object.hasOwn(result, room.id)) return;
            room.nodeIds = room.nodeIds.filter(id => id !== node.id);
            if (result[room.id]) room.nodeIds.push(node.id);
        });
        try { await saveRoomLayout(node.characterId, latest); await render(); showToast('房间已整理'); }
        catch (error) { showToast(error.message || '房间整理失败'); }
    }

    async function render() {
        const container = document.getElementById('memory-palace-list');
        const summary = document.getElementById('memory-palace-summary');
        if (!container) return;
        const character = currentCharacter();
        if (!character) { container.innerHTML = '<div class="memory-palace-empty">未选择角色</div>'; return; }
        const allNodes = await listNodes(character.id);
        const rooms = getRoomLayout(character.id);
        const roomLabels = new Map(rooms.map(room => [room.id, room.label]));
        const customRoom = rooms.find(room => room.id === ui.room && isCustomRoom(room.id));
        let nodes = ui.room === 'all' ? allNodes.slice() : allNodes.filter(node => customRoom ? customRoom.nodeIds.includes(node.id) : node.room === ui.room);
        const layer = document.getElementById('palace-layer-filter')?.value || 'all';
        nodes = nodes.filter(node => layer === 'archived' ? node.archived : !node.archived && (layer === 'all' || node.layer === layer));
        const query = String(document.getElementById('memory-palace-search')?.value || '').trim().toLocaleLowerCase();
        if (query) nodes = nodes.filter(node => `${node.content}\n${node.tags.join(' ')}\n${node.entities.join(' ')}`.toLocaleLowerCase().includes(query));
        if (summary) {
            ensureSettings(character);
            summary.textContent = `${character.remarkName || character.name} · ${character.memoryPalaceEnabled ? '记忆宫殿已启用' : '记忆宫殿未启用'}`;
            const activeCount = allNodes.filter(node => !node.archived).length;
            const archivedCount = allNodes.length - activeCount;
            const activeTarget = document.getElementById('memory-palace-count-active');
            const archivedTarget = document.getElementById('memory-palace-count-archived');
            if (activeTarget) activeTarget.textContent = String(activeCount);
            if (archivedTarget) archivedTarget.textContent = String(archivedCount);
        }
        global.MemoryPalaceMaintenance?.updateStatus(character);
        await renderHistoryProgress(character);
        const filterKey=[character.id,ui.room,layer,query].join('|');if(ui.filterKey!==filterKey){ui.page=0;ui.filterKey=filterKey;}
        nodes.sort((a,b)=>(b.source?.startTimestamp||b.createdAt)-(a.source?.startTimestamp||a.createdAt));
        const pages=Math.max(1,Math.ceil(nodes.length/24));ui.page=Math.min(ui.page,pages-1);
        container.innerHTML = nodes.length ? nodes.slice(ui.page*24,(ui.page+1)*24).map(node => `<article class="memory-palace-card" data-id="${escapeHtml(node.id)}">
            <div class="memory-palace-card-head"><span>${escapeHtml(roomLabels.get(node.room)||node.room)}</span><time>${escapeHtml(new Date(node.source?.startTimestamp||node.createdAt).toLocaleDateString())}</time></div>
            <div class="memory-palace-card-content palace-preview">${escapeHtml(node.content)}</div>
            <div class="memory-palace-tags">${node.tags.slice(0,2).map(tag=>`<span>${escapeHtml(tag)}</span>`).join('')}</div>
            <button class="palace-detail-link" data-action="detail">查看详情 ›</button>
        </article>`).join('') : '<div class="memory-palace-empty">这个范围还没有记忆</div>';
        const pagination=document.getElementById('palace-pages');if(pagination){pagination.innerHTML=`<button class="btn btn-small btn-secondary" data-page="-1" ${ui.page===0?'disabled':''}>上一页</button><span>${ui.page+1}/${pages} · ${nodes.length} 条</span><button class="btn btn-small btn-secondary" data-page="1" ${ui.page===pages-1?'disabled':''}>下一页</button>`;}

    }

    function openEditor(node) {
        renderRoomOptions();
        const editor = document.getElementById('memory-palace-editor-modal');
        const more = editor.querySelector('.memory-palace-editor-more');
        const advanced = editor.querySelector('.memory-palace-editor-advanced');
        advanced.hidden = true;
        more.setAttribute('aria-expanded', 'false');
        more.onclick = () => {
            advanced.hidden = !advanced.hidden;
            more.setAttribute('aria-expanded', String(!advanced.hidden));
        };
        editor.querySelector('.memory-palace-editor-body').scrollTop = 0;
        ui.editingId = node?.id || '';
        document.getElementById('memory-palace-editor-title').textContent = node ? '编辑记忆' : '新增记忆';
        document.getElementById('memory-palace-content').value = node?.content || '';
        document.getElementById('memory-palace-room').value = node?.room || (Object.hasOwn(Core.ROOMS, ui.room) ? ui.room : 'living_room');
        document.getElementById('memory-palace-tags').value = (node?.tags || []).join(', ');
        document.getElementById('memory-palace-entities').value = (node?.entities || []).join(', ');
        document.getElementById('memory-palace-importance').value = node?.importance || 5;
        document.getElementById('memory-palace-mood').value = node?.mood || '';
        document.getElementById('memory-palace-pinned').checked = !!node?.pinned;
        document.getElementById('palace-editor-layer').value = node?.layer || 'episodes';
        document.getElementById('palace-editor-subject').value = node?.subject || '';
        document.getElementById('palace-editor-confidence').value = node?.confidence ?? 1;
        document.getElementById('palace-editor-fact-key').value = node?.factKey || '';
        const zone = global.VirtualClock.resolveCharacter(currentCharacter()).timeZone;
        document.getElementById('palace-editor-expiry').value = node?.validUntil != null ? global.VirtualClock.inputValue(node.validUntil, zone, false) : '';
        document.getElementById('palace-editor-source').textContent = node ? `来源消息：${(node.source?.messageIds || []).join('、') || '无'}；来源记忆：${(node.sourceNodeIds || []).join('、') || '无'}；${node.archiveReason || ''}` : '手动新增';
        document.getElementById('memory-palace-editor-modal').classList.add('visible');
    }

    async function openLinks(node) {
        ui.linksId = node.id;
        const modal = document.getElementById('memory-palace-links-modal');
        if (!modal) return;
        document.getElementById('memory-palace-links-title').textContent = '记忆关联';
        document.getElementById('memory-palace-links-source').textContent = node.content.slice(0, 120);
        const allNodes = await listNodes(node.characterId);
        const target = document.getElementById('memory-palace-link-target');
        target.innerHTML = allNodes.filter(item => item.id !== node.id).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.content.slice(0, 48))}</option>`).join('') || '<option value="">没有其他记忆可关联</option>';
        const links = await linksForNode(node.characterId, node.id);
        const byId = new Map(allNodes.map(item => [item.id, item]));
        const list = document.getElementById('memory-palace-links-list');
        list.innerHTML = links.length ? links.map(link => {
            const other = byId.get(link.sourceId === node.id ? link.targetId : link.sourceId);
            return `<div class="memory-palace-link-row" data-link-id="${escapeHtml(link.id)}"><span>${escapeHtml(Core.LINK_TYPES[link.type] || link.type)} · ${link.origin === 'manual' ? '手动' : '自动'} · ${Math.round(link.strength * 100)}%</span><p>${escapeHtml(other?.content || '关联记忆已不存在')}</p><button type="button" class="btn btn-small btn-danger" data-link-action="delete">删除</button></div>`;
        }).join('') : '<div class="memory-palace-empty">尚无关联</div>';
        modal.classList.add('visible');
    }

    async function openEventBox(node) {
        const modal = document.getElementById('memory-palace-event-box-modal');
        if (!modal || !node) return;
        ui.eventBoxNodeId = node.id;
        const box = node.eventBoxId ? await getEventBox(node.eventBoxId) : null;
        ui.eventBoxId = box?.id || '';
        document.getElementById('memory-palace-event-box-title').textContent = box ? '事件盒管理' : '创建事件盒';
        document.getElementById('memory-palace-event-box-source').textContent = node.content.slice(0, 120);
        document.getElementById('memory-palace-event-box-name').value = box?.name || '';
        document.getElementById('memory-palace-event-box-tags').value = (box?.tags || []).join(', ');
        const allNodes = await listNodes(node.characterId);
        const members = box ? allNodes.filter(item => box.nodeIds.includes(item.id)) : [node];
        const memberIds = new Set(members.map(item => item.id));
        const memberList = document.getElementById('memory-palace-event-box-members');
        memberList.innerHTML = members.length ? members.map(member => `<div class="memory-palace-event-box-member" data-event-box-node-id="${escapeHtml(member.id)}"><span>${escapeHtml(member.content.slice(0, 100))}</span><button type="button" class="btn btn-small btn-danger" data-event-box-action="remove">移除</button></div>`).join('') : '<div class="memory-palace-empty">事件盒暂无成员</div>';
        const target = document.getElementById('memory-palace-event-box-target');
        target.innerHTML = allNodes.filter(item => !memberIds.has(item.id) && (!item.eventBoxId || item.eventBoxId === box?.id)).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.content.slice(0, 60))}</option>`).join('') || '<option value="">没有可加入的记忆</option>';
        document.getElementById('memory-palace-event-box-save').textContent = box ? '加入事件盒' : '创建事件盒';
        document.getElementById('memory-palace-event-box-delete').style.display = box ? '' : 'none';
        modal.classList.add('visible');
    }

    async function renderRoomPlates(characterId) {
        const container = document.getElementById('memory-palace-room-plates-list');
        if (!container) return;
        const plates = await listRoomPlates(characterId);
        const byRoom = new Map(plates.map(plate => [plate.room, plate]));
        container.innerHTML = Core.ROOM_PLATE_ROOMS.map(room => {
            const plate = byRoom.get(room) || Core.normalizeRoomPlate({ characterId, room, entries: [] }, { characterId });
            const title = Core.ROOM_PLATE_TITLES[room] || room;
            const cap = Core.ROOM_PLATE_CAPS[room] || plate.entries.length;
            const entries = plate.entries.map(entry => `<div class="memory-palace-room-plate-entry" data-room-plate-entry-id="${escapeHtml(entry.id)}">
                <div class="memory-palace-room-plate-entry-text">${escapeHtml(entry.text)}</div>
                <div class="memory-palace-room-plate-entry-meta">${entry.tag ? `${escapeHtml(entry.tag)} · ` : ''}${entry.sourceCount || 1} 次印证 · ${new Date(entry.updatedAt || entry.firstLearnedAt || Date.now()).toLocaleDateString('zh-CN')}</div>
                <div class="memory-palace-room-plate-entry-actions"><button type="button" class="btn btn-small btn-secondary" data-room-plate-action="edit">编辑</button><button type="button" class="btn btn-small btn-danger" data-room-plate-action="delete">删除</button></div>
            </div>`).join('');
            return `<section class="memory-palace-room-plate-section" data-room-plate-room="${escapeHtml(room)}">
                <div class="memory-palace-room-plate-header"><strong>${escapeHtml(title)}</strong><span>${plate.entries.length}/${cap}</span></div>
                ${entries || '<div class="memory-palace-empty">暂无铭牌条目</div>'}
            </section>`;
        }).join('');
    }

    async function openRoomPlates(character) {
        const modal = document.getElementById('memory-palace-room-plates-modal');
        if (!modal || !character) return;
        document.getElementById('memory-palace-room-plates-title').textContent = '房间铭牌';
        document.getElementById('memory-palace-room-plates-source').textContent = `${character.remarkName || character.name || '当前角色'} · 仅可手动校正或删除，自动沉淀由后续治理模块负责`;
        await renderRoomPlates(character.id);
        modal.classList.add('visible');
    }

    async function editRoomPlateEntry(row, characterId, room, entryId) {
        const plate = await getRoomPlate(characterId, room);
        const entry = plate?.entries.find(item => item.id === entryId);
        if (!entry) return;
        row.innerHTML = `<textarea class="memory-palace-room-plate-editor" rows="3" maxlength="${Core.ROOM_PLATE_ENTRY_HARD_MAX_CHARS}">${escapeHtml(entry.text)}</textarea>
            <div class="memory-palace-room-plate-entry-actions"><button type="button" class="btn btn-small btn-secondary" data-room-plate-action="cancel">取消</button><button type="button" class="btn btn-small btn-primary" data-room-plate-action="save">保存</button></div>`;
        row.querySelector('textarea')?.focus();
    }

    async function handleRoomPlateAction(event) {
        const button = event.target.closest('[data-room-plate-action]');
        if (!button) return;
        const row = button.closest('[data-room-plate-entry-id]');
        const section = button.closest('[data-room-plate-room]');
        const character = currentCharacter();
        if (!row || !section || !character) return;
        const room = section.dataset.roomPlateRoom;
        const entryId = row.dataset.roomPlateEntryId;
        const action = button.dataset.roomPlateAction;
        try {
            if (action === 'edit') return editRoomPlateEntry(row, character.id, room, entryId);
            if (action === 'cancel') return renderRoomPlates(character.id);
            if (action === 'save') {
                const text = row.querySelector('textarea')?.value || '';
                await updateRoomPlateEntry(character.id, room, entryId, text);
                await renderRoomPlates(character.id);
                showToast('房间铭牌已更新');
                return;
            }
            if (action === 'delete' && (await showAppConfirmDialog({ title: '确认删除', message: '确定删除这条房间铭牌吗？', confirmText: '删除', dismissText: '' }) === 'confirm')) {
                await deleteRoomPlateEntry(character.id, room, entryId);
                await renderRoomPlates(character.id);
                showToast('房间铭牌已删除');
            }
        } catch (error) {
            showToast(error.message || '房间铭牌操作失败');
        }
    }

    async function renderAnticipations(characterId) {
        const container = document.getElementById('memory-palace-anticipations-list');
        if (!container) return;
        const records = await listAnticipations(characterId);
        container.innerHTML = records.length ? records.map(item => `<div class="memory-palace-anticipation-row" data-anticipation-id="${escapeHtml(item.id)}">
            <div class="memory-palace-anticipation-content">${escapeHtml(item.content)}</div>
            <div class="memory-palace-anticipation-meta"><span class="memory-palace-anticipation-status status-${escapeHtml(item.status)}">${escapeHtml(Core.ANTICIPATION_STATUSES[item.status] || item.status)}</span><span>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>${item.anchoredAt ? '<span>已锚定</span>' : ''}</div>
            <div class="memory-palace-room-plate-entry-actions"><button type="button" class="btn btn-small btn-secondary" data-anticipation-action="edit">编辑</button><button type="button" class="btn btn-small btn-danger" data-anticipation-action="delete">删除</button></div>
        </div>`).join('') : '<div class="memory-palace-empty">暂无期盼。它们不会自动进入 AI 上下文。</div>';
    }

    async function openAnticipations(character) {
        const modal = document.getElementById('memory-palace-anticipations-modal');
        if (!modal || !character) return;
        ui.anticipationEditingId = '';
        document.getElementById('memory-palace-anticipations-title').textContent = '窗台期盼';
        document.getElementById('memory-palace-anticipations-source').textContent = `${character.remarkName || character.name || '当前角色'} · active 超过 7 天会变为长期锚点；状态转化暂不自动生成记忆`;
        document.getElementById('memory-palace-anticipation-content').value = '';
        document.getElementById('memory-palace-anticipation-status').value = 'active';
        document.getElementById('memory-palace-anticipation-save').textContent = '新增期盼';
        await renderAnticipations(character.id);
        modal.classList.add('visible');
    }

    async function handleAnticipationAction(event) {
        const button = event.target.closest('[data-anticipation-action]');
        if (!button) return;
        const row = button.closest('[data-anticipation-id]');
        const character = currentCharacter();
        if (!row || !character) return;
        const id = row.dataset.anticipationId;
        const action = button.dataset.anticipationAction;
        try {
            if (action === 'edit') {
                const item = await getAnticipation(id);
                if (!item) return;
                ui.anticipationEditingId = item.id;
                document.getElementById('memory-palace-anticipation-content').value = item.content;
                document.getElementById('memory-palace-anticipation-status').value = item.status;
                document.getElementById('memory-palace-anticipation-save').textContent = '保存修改';
                document.getElementById('memory-palace-anticipation-content').focus();
                return;
            }
            if (action === 'delete' && (await showAppConfirmDialog({ title: '确认删除', message: '确定删除这条窗台期盼吗？删除后不会自动恢复。', confirmText: '删除', dismissText: '' }) === 'confirm')) {
                await deleteAnticipation(id);
                if (ui.anticipationEditingId === id) ui.anticipationEditingId = '';
                await renderAnticipations(character.id);
                showToast('期盼已删除');
            }
        } catch (error) {
            showToast(error.message || '期盼操作失败');
        }
    }

    function renderDigestReportSections(report) {
        const groups = [
            ['检查范围', report.examined],
            ['处理结果', report.outcomes],
            ['铭牌提交', report.plateSubmissions],
        ];
        return groups.filter(([, sections]) => sections.length).map(([label, sections]) => `<section class="memory-palace-digest-report-section">
            <h4 class="memory-palace-digest-report-section-title">${escapeHtml(label)}</h4>
            ${sections.map(section => `<div class="memory-palace-digest-report-item"><strong>${escapeHtml(section.label || '未命名')}</strong>${section.items.length ? `<ul>${section.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>无详细条目</p>'}</div>`).join('')}
        </section>`).join('');
    }

    async function renderDigestReports(characterId) {
        const container = document.getElementById('memory-palace-digest-reports-list');
        if (!container) return;
        const reports = await listDigestReports(characterId);
        container.innerHTML = reports.length ? reports.map(report => {
            const examinedCount = report.examined.reduce((sum, section) => sum + section.items.length, 0);
            const outcomeCount = report.outcomes.reduce((sum, section) => sum + section.items.length, 0);
            const submissionCount = report.plateSubmissions.reduce((sum, section) => sum + section.items.length, 0);
            return `<article class="memory-palace-digest-report-row" data-digest-report-id="${escapeHtml(report.id)}">
                <div class="memory-palace-digest-report-head"><div><strong>${new Date(report.createdAt).toLocaleString('zh-CN')}</strong><span>${escapeHtml(Core.DIGEST_REPORT_TRIGGERS[report.trigger] || report.trigger)}</span></div><button type="button" class="btn btn-small btn-danger" data-digest-report-action="delete">删除</button></div>
                <div class="memory-palace-digest-report-meta">检查 ${examinedCount} 项 · 结果 ${outcomeCount} 项 · 铭牌 ${submissionCount} 项${report.plateCloudPending ? ' · 云端待同步' : ''}</div>
                <div class="memory-palace-digest-report-sections">${renderDigestReportSections(report) || '<p class="memory-palace-empty">本次治理没有结构化条目。</p>'}</div>
                ${report.governance && !report.governance.undone ? '<button class="btn btn-small btn-secondary" data-digest-report-action="undo">撤销本次整理</button>' : ''}
            </article>`;
        }).join('') : '<div class="memory-palace-empty">暂无整理记录。开启夜间整理后，这里会记录处理结果；也可立即整理。</div>';
    }

    async function openDigestReports(character) {
        const modal = document.getElementById('memory-palace-digest-reports-modal');
        if (!modal || !character) return;
        document.getElementById('memory-palace-digest-reports-title').textContent = '整理记录';
        document.getElementById('memory-palace-digest-reports-source').textContent = `${character.remarkName || character.name || '当前角色'} · 仅查看已保存的治理结果，不会自动运行 LLM`;
        await renderDigestReports(character.id);
        modal.classList.add('visible');
    }

    async function handleDigestReportAction(event) {
        const undo = event.target.closest('[data-digest-report-action="undo"]');
        if (undo) {
            try { await global.MemoryPalaceMaintenance.undo(undo.closest('[data-digest-report-id]').dataset.digestReportId); await renderDigestReports(ui.characterId); await render(); showToast('已撤销整理'); }
            catch (error) { showToast(error.message); }
            return;
        }
        const button = event.target.closest('[data-digest-report-action="delete"]');
        const row = button?.closest('[data-digest-report-id]');
        const character = currentCharacter();
        if (!button || !row || !character) return;
        if (!(await showAppConfirmDialog({ title: '确认删除', message: '确定删除这条整理记录吗？不会删除记忆正文。', confirmText: '删除', dismissText: '' }) === 'confirm')) return;
        try {
            await deleteDigestReport(row.dataset.digestReportId);
            await renderDigestReports(character.id);
            showToast('整理记录已删除');
        } catch (error) { showToast(error.message || '删除整理记录失败'); }
    }

    async function exportData() {
        const character = currentCharacter(); if (!character) return;
        const nodes = await listNodes(character.id);
        const vectors = await dexieDB.memoryPalaceVectors.where('characterId').equals(character.id).toArray();
        const links = await listLinks(character.id);
        const eventBoxes = await listEventBoxes(character.id);
        const roomPlates = await listRoomPlates(character.id);
        const anticipations = await listAnticipations(character.id, { advance: false });
        const digestReports = await listDigestReports(character.id);
        const blob = new Blob([JSON.stringify({ format: 'ovo-memory-palace', version: 6, characterId: character.id, nodes, vectors, links, eventBoxes, roomPlates, anticipations, digestReports, roomLayout: getRoomLayout(character.id), customRooms: getRoomLayout(character.id).filter(room => isCustomRoom(room.id)) }, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${character.remarkName || character.name}-记忆宫殿.json`; link.click(); URL.revokeObjectURL(url);
    }

    async function importData(file) {
        const character = currentCharacter(); if (!character || !file) return;
        const data = JSON.parse(await file.text());
        if (data.format !== 'ovo-memory-palace' || !Array.isArray(data.nodes)) throw new Error('不是有效的 Mio 记忆宫殿文件');
        const roomLayout = data.roomLayout;
        if (roomLayout !== undefined) validateRoomLayout(roomLayout);
        const customRooms = roomLayout !== undefined ? roomLayout.filter(room => isCustomRoom(room.id)) : data.customRooms === undefined ? [] : data.customRooms;
        if (!Array.isArray(customRooms) || customRooms.some(room => typeof room?.label !== 'string' || !room.label.trim() || room.label.length > 24 || !Array.isArray(room.nodeIds) || room.nodeIds.some(id => typeof id !== 'string'))) throw Error('自定义房间数据无效');
        const idMap = new Map();
        const eventBoxIdMap = new Map();
        const importedBoxes = Array.isArray(data.eventBoxes) && dexieDB.memoryPalaceEventBoxes
            ? data.eventBoxes.map(box => {
                const oldId = String(box.id || '');
                const id = Core.id('mpe');
                eventBoxIdMap.set(oldId, id);
                return { oldId, source: box, record: Core.normalizeEventBox({ ...box, id, characterId: character.id, nodeIds: [] }, { characterId: character.id }) };
            })
            : [];
        const nodes = data.nodes.map(node => {
            const id = Core.id('mpn'); idMap.set(String(node.id || ''), id);
            return Core.normalizeNode({ ...node, id, characterId: character.id, eventBoxId: eventBoxIdMap.get(String(node.eventBoxId || '')) || null, embedded: false, embeddingProfileKey: '' }, { characterId: character.id });
        });
        const importedNodeIds = new Set(nodes.map(node => node.id));
        const assigned = new Set();
        importedBoxes.forEach(item => {
            const box = item.record;
            const source = item.source;
            const legacyNodeIds = [...(source?.liveMemoryIds || []), ...(source?.archivedMemoryIds || [])];
            const nodeIds = (source?.nodeIds || legacyNodeIds).map(id => idMap.get(String(id))).filter(id => id && importedNodeIds.has(id) && !assigned.has(id));
            box.nodeIds = nodeIds;
            nodeIds.forEach(id => assigned.add(id));
        });
        const importedRoomPlates = Array.isArray(data.roomPlates) && dexieDB.memoryPalaceRoomPlates
            ? data.roomPlates.map(plate => {
                const room = String(plate?.room || '');
                if (!Core.ROOM_PLATE_ROOMS.includes(room)) return null;
                const entries = Array.isArray(plate.entries) ? plate.entries.map(entry => ({ ...entry, id: Core.id('mpp') })) : [];
                return Core.normalizeRoomPlate({ ...plate, id: roomPlateKey(character.id, room), characterId: character.id, room, entries }, { characterId: character.id });
            }).filter(Boolean)
            : [];
        const importedAnticipations = Array.isArray(data.anticipations) && dexieDB.memoryPalaceAnticipations
            ? data.anticipations.map(item => Core.normalizeAnticipation({ ...item, id: Core.id('mpa'), characterId: character.id }, { characterId: character.id })).filter(item => item.content)
            : [];
        const importedDigestReports = Array.isArray(data.digestReports) && dexieDB.memoryPalaceDigestReports
            ? data.digestReports.map(item => Core.normalizeDigestReport({ ...item, governance:null, id: Core.id('mpd'), characterId: character.id }, { characterId: character.id }))
            : [];
        nodes.forEach(node => {
            if (!assigned.has(node.id)) node.eventBoxId = null;
            node.owner = character.id;
            node.sourceNodeIds = node.sourceNodeIds.map(id => idMap.get(id)).filter(Boolean);
            node.representativeId = idMap.get(node.representativeId) || '';
        });
        if (nodes.length) await dexieDB.memoryPalaceNodes.bulkPut(nodes);
        if (importedBoxes.length) await dexieDB.memoryPalaceEventBoxes.bulkPut(importedBoxes.map(item => item.record).filter(box => box.nodeIds.length));
        if (importedRoomPlates.length) await dexieDB.memoryPalaceRoomPlates.bulkPut(importedRoomPlates);
        if (importedAnticipations.length) await dexieDB.memoryPalaceAnticipations.bulkPut(importedAnticipations);
        if (importedDigestReports.length) await dexieDB.memoryPalaceDigestReports.bulkPut(importedDigestReports);
        if (nodes.length && Array.isArray(data.links) && dexieDB.memoryPalaceLinks) {
            const links = data.links.map(link => Core.normalizeLink({ ...link, id: Core.id('mpl'), characterId: character.id, sourceId: idMap.get(String(link.sourceId || '')), targetId: idMap.get(String(link.targetId || '')), updatedAt: Date.now() }, { characterId: character.id }))
                .filter(link => link.sourceId && link.targetId && link.sourceId !== link.targetId);
            if (links.length) await dexieDB.memoryPalaceLinks.bulkPut(links);
        }
        if (roomLayout !== undefined || customRooms.length) {
            const importedRooms = customRooms.map(room => ({ id: Core.id('custom'), label: room.label, hidden: room.hidden === true, nodeIds: room.nodeIds.map(id => idMap.get(id)).filter(Boolean) }));
            const current = getRoomLayout(character.id);
            const restored = roomLayout === undefined ? [...current, ...importedRooms]
                : [...roomLayout.map(room => isCustomRoom(room.id) ? importedRooms[customRooms.indexOf(room)] : room), ...current.filter(room => isCustomRoom(room.id))];
            try { await saveRoomLayout(character.id, restored); }
            catch (error) { throw Error('记忆已导入，但房间布局未保存；请在全部房间重新整理，无需重复导入'); }
        }
        renderRoomOptions();
        runtime.delete(character.id);
        return nodes.length;
    }

    function open(characterId, backTarget = 'chat-settings-screen') {
        ui.characterId = characterId || currentChatId || '';
        ui.room = 'all'; ui.query = '';
        const back = document.querySelector('#memory-palace-screen .back-btn');
        if (back) back.dataset.target = backTarget;
        const searchInput = document.getElementById('memory-palace-search'); if (searchInput) searchInput.value = '';
        renderRoomOptions();
        switchScreen('memory-palace-screen');
        global.MemoryPalaceMaintenance?.loadSettings(currentCharacter());
        void render();
    }

    function setup() {
        document.getElementById('memory-palace-rooms-btn')?.addEventListener('click', () => {
            if (!currentCharacter()) return;
            renderRoomManager();
            document.getElementById('memory-palace-rooms-modal').classList.add('visible');
            document.getElementById('memory-palace-room-create-btn')?.focus();
        });
        const roomModal = document.getElementById('memory-palace-rooms-modal');
        const closeRooms = () => { roomModal.classList.remove('visible'); document.getElementById('memory-palace-rooms-btn')?.focus(); };
        document.getElementById('memory-palace-rooms-close')?.addEventListener('click', closeRooms);
        roomModal?.addEventListener('click', event => { if (event.target === roomModal) closeRooms(); });
        roomModal?.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); closeRooms(); }
            if (event.key === 'Tab') {
                const buttons = [...roomModal.querySelectorAll('button:not(:disabled)')];
                if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
                else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
            }
        });
        roomModal?.addEventListener('click', event => void handleRoomLayoutAction(event));

        document.getElementById('setting-open-memory-palace-btn')?.addEventListener('click', () => open(currentChatId));
        document.getElementById('memory-palace-add-btn')?.addEventListener('click', () => openEditor(null));
        document.getElementById('memory-palace-room-plates-btn')?.addEventListener('click', () => void openRoomPlates(currentCharacter()));
        document.getElementById('memory-palace-room-plates-close')?.addEventListener('click', () => document.getElementById('memory-palace-room-plates-modal')?.classList.remove('visible'));
        document.getElementById('memory-palace-room-plates-list')?.addEventListener('click', event => void handleRoomPlateAction(event));
        document.getElementById('memory-palace-anticipations-btn')?.addEventListener('click', () => void openAnticipations(currentCharacter()));
        document.getElementById('memory-palace-anticipations-close')?.addEventListener('click', () => document.getElementById('memory-palace-anticipations-modal')?.classList.remove('visible'));
        document.getElementById('memory-palace-anticipations-list')?.addEventListener('click', event => void handleAnticipationAction(event));
        document.getElementById('memory-palace-digest-reports-btn')?.addEventListener('click', () => void openDigestReports(currentCharacter()));
        document.getElementById('memory-palace-digest-reports-close')?.addEventListener('click', () => document.getElementById('memory-palace-digest-reports-modal')?.classList.remove('visible'));
        document.getElementById('memory-palace-digest-reports-list')?.addEventListener('click', event => void handleDigestReportAction(event));
        document.getElementById('memory-palace-anticipation-save')?.addEventListener('click', async event => {
            const character = currentCharacter();
            if (!character) return;
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const content = document.getElementById('memory-palace-anticipation-content')?.value || '';
                const status = document.getElementById('memory-palace-anticipation-status')?.value || 'active';
                if (ui.anticipationEditingId) await updateAnticipation(ui.anticipationEditingId, { content, status });
                else await createAnticipation(character.id, content);
                ui.anticipationEditingId = '';
                document.getElementById('memory-palace-anticipation-content').value = '';
                document.getElementById('memory-palace-anticipation-status').value = 'active';
                button.textContent = '新增期盼';
                await renderAnticipations(character.id);
                showToast('期盼已保存');
            } catch (error) { showToast(error.message || '保存期盼失败'); }
            finally { button.disabled = false; }
        });
        document.getElementById('memory-palace-room-filter')?.addEventListener('change', event => { ui.room = event.target.value; void render(); });
        let searchTimer;
        document.getElementById('memory-palace-search')?.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>void render(),180);});
        document.getElementById('memory-palace-api-open-btn')?.addEventListener('click', () => {
            const back = document.querySelector('#api-settings-screen .back-btn');
            if (back) back.dataset.target = 'memory-palace-screen';
            switchScreen('api-settings-screen');
            document.querySelector('#api-settings-screen .api-seg-btn[data-tab="specialized"]')?.click();
            setTimeout(() => document.getElementById('memory-palace-api-section')?.scrollIntoView({ block: 'start' }), 0);
        });
        document.getElementById('memory-palace-export-btn')?.addEventListener('click', () => void exportData());
        document.getElementById('memory-palace-import-btn')?.addEventListener('click', () => document.getElementById('memory-palace-import-input')?.click());
        document.getElementById('memory-palace-import-input')?.addEventListener('change', async event => {
            try { const count = await importData(event.target.files?.[0]); showToast(`已导入 ${count || 0} 条记忆`); await render(); }
            catch (error) { showToast(error.message || '导入失败'); }
            event.target.value = '';
        });
        document.getElementById('memory-palace-reindex-btn')?.addEventListener('click', async () => {
            try { const count = await reembed(ui.characterId); showToast(`已重建 ${count} 条向量`); await render(); }
            catch (error) { showToast(error.message || '重建失败'); }
        });
        document.getElementById('palace-manage-open').onclick=()=>document.getElementById('palace-manage-modal').classList.add('visible');
        document.getElementById('palace-manage-modal').addEventListener('click',event=>{if(['memory-palace-relationship-btn','memory-palace-room-plates-btn','memory-palace-anticipations-btn','memory-palace-digest-reports-btn','memory-palace-api-open-btn'].includes(event.target.closest('button')?.id))document.getElementById('palace-manage-modal').classList.remove('visible');},true);
        document.getElementById('palace-progress-open').onclick=()=>document.getElementById('palace-progress-modal').classList.add('visible');
        document.querySelectorAll('[data-palace-close]').forEach(button=>button.onclick=()=>document.getElementById(button.dataset.palaceClose).classList.remove('visible'));
        document.getElementById('palace-relink-btn').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{const nodes=await listNodes(ui.characterId);const links=await refreshAutomaticLinks(ui.characterId,nodes.map(n=>n.id));showToast(`已核对 ${nodes.length} 条记忆，生成 ${links.length} 条有依据的关联`);}catch(e){showToast(e.message);}finally{button.disabled=false;}};
        document.getElementById('palace-pages').onclick=event=>{const button=event.target.closest('[data-page]');if(button){ui.page+=Number(button.dataset.page);void render().then(()=>document.getElementById('memory-palace-list').scrollIntoView({block:'start'}));}};
        document.getElementById('palace-metrics-open').onclick=async()=>{
            const box=document.getElementById('palace-history-metrics');box.hidden=!box.hidden;if(box.hidden)return;
            const job=await getHistoryJob(ui.characterId);if(!job){box.textContent='暂无任务';return;}
            const success=job.batches.filter(b=>b.status==='success').length;
            box.innerHTML=`<p>成功 ${success}/${job.batches.length} 批 · ${Math.round(success/job.batches.length*100)}%</p>`+job.batches.map((b,i)=>{const m=b.metrics||{};return `<p>第 ${i+1} 批 · ${b.units.filter(u=>u.last).length} 条 · ${escapeHtml(b.status)}<br>请求 ${m.transportRequests||m.requests||b.attempts||0} 次 · 模型 ${((m.apiMs||0)/1000).toFixed(2)}s · 准备 ${Math.round(m.prepareMs||0)}ms · 写入 ${Math.round(m.writeMs||0)}ms<br>${m.usageReported?`Token：输入 ${m.inputTokens} / 输出 ${m.outputTokens}`:`服务未报告用量；输入估算 ${m.estimatedInputTokens||'—'} Token`}</p>`;}).join('');
        };
        document.getElementById('memory-palace-archive-now-btn')?.addEventListener('click', () => {
            const character=currentCharacter();
            if(character)void chooseHistoryRange(character).catch(error=>showToast(error.message));
        });
        document.getElementById('palace-history-actions')?.addEventListener('click', event => {
            const action=event.target.closest('[data-history-action]')?.dataset.historyAction;
            const character=currentCharacter();
            if(action&&character)void controlHistoryJob(character,action==='pause'?'paused':action==='cancel'?'cancelled':action).catch(error=>showToast(error.message));
        });
        const handleMemoryAction=async event => {
            const card = event.target.closest('.memory-palace-card'); const action = event.target.closest('[data-action]')?.dataset.action;
            if (!card || !action) return;
            const node = await getNode(card.dataset.id); if (!node) return;
            if(action==='detail'){
                const links=await linksForNode(node.characterId,node.id);
                document.getElementById('palace-detail-body').innerHTML=`<article class="memory-palace-card" data-id="${escapeHtml(node.id)}"><p class="palace-detail-content">${escapeHtml(node.content)}</p><p class="memory-palace-source">${escapeHtml(sourceSummary(node))} · ${escapeHtml(new Date(node.source?.startTimestamp||node.createdAt).toLocaleString())}</p><p>${escapeHtml(node.entities.join(' · '))}</p><div class="memory-palace-actions">${[['rooms','整理到房间'],['links','关联 '+links.length],['event-box','事件与时间线'],['edit','编辑'],['embed','重嵌入'],...(node.archived?[['restore','恢复并核对']]:[]),['delete','删除']].map(([action,label])=>`<button class="btn btn-small ${action==='delete'?'btn-danger':'btn-secondary'}" data-action="${action}">${label}</button>`).join('')}</div></article>`;
                document.getElementById('palace-detail-modal').classList.add('visible');return;
            }
            document.getElementById('palace-detail-modal').classList.remove('visible');
            if (action === 'restore') { await saveNode({ ...node, archived:false, archiveReason:'', conflictGroup:'', representativeId:'', validUntil:null, pinned:true }); await render(); openEditor(await getNode(node.id)); return; }
            if (action === 'rooms') { await organizeNodeRooms(node); return; }
            if (action === 'links') { await openLinks(node); return; }
            if (action === 'event-box') { await openEventBox(node); return; }
            if (action === 'edit') openEditor(node);
            if (action === 'embed') { try { await reembed(node.characterId, [node.id]); showToast('向量已重建'); await render(); } catch (error) { showToast(error.message || '重建失败'); } }
            if (action === 'delete' && (await showAppConfirmDialog({ title: '确认删除', message: '确定删除这条记忆吗？', confirmText: '删除', dismissText: '' }) === 'confirm')) { await deleteNode(node.id); showToast('已删除'); await render(); }
        };
        document.getElementById('memory-palace-list')?.addEventListener('click',handleMemoryAction);
        document.getElementById('palace-detail-body')?.addEventListener('click',handleMemoryAction);
        document.getElementById('memory-palace-editor-cancel')?.addEventListener('click', () => document.getElementById('memory-palace-editor-modal').classList.remove('visible'));
        document.getElementById('memory-palace-editor-save')?.addEventListener('click', async () => {
            const button = document.getElementById('memory-palace-editor-save'); button.disabled = true;
            try {
                const expiry = document.getElementById('palace-editor-expiry').value;
                const validUntil = expiry ? global.VirtualClock.wallClockToTimestamp(expiry, global.VirtualClock.resolveCharacter(currentCharacter()).timeZone) : null;
                if (expiry && !Number.isFinite(validUntil)) throw Error('有效期格式不正确');
                const result = await saveNode({ id: ui.editingId || undefined, characterId: ui.characterId, content: document.getElementById('memory-palace-content').value, room: document.getElementById('memory-palace-room').value, tags: document.getElementById('memory-palace-tags').value, entities: document.getElementById('memory-palace-entities').value, importance: document.getElementById('memory-palace-importance').value, mood: document.getElementById('memory-palace-mood').value, pinned: document.getElementById('memory-palace-pinned').checked,
                    layer:document.getElementById('palace-editor-layer').value, subject:document.getElementById('palace-editor-subject').value, confidence:document.getElementById('palace-editor-confidence').value, factKey:document.getElementById('palace-editor-fact-key').value, validUntil });
                document.getElementById('memory-palace-editor-modal').classList.remove('visible');
                const rooms = getRoomLayout(result.node.characterId);
                const customRoom = rooms.find(room => room.id === ui.room && isCustomRoom(room.id));
                let roomError = '';
                if (customRoom && !customRoom.nodeIds.includes(result.node.id)) {
                    customRoom.nodeIds.push(result.node.id);
                    try { await saveRoomLayout(result.node.characterId, rooms); }
                    catch (error) { roomError = '记忆已保存，加入房间失败；请在全部房间重新整理'; ui.room = 'all'; renderRoomOptions(); }
                }
                showToast(roomError || (result.embedded ? '记忆已保存并向量化' : '记忆已保存，将使用关键词检索')); await render();
            } catch (error) { showToast(error.message || '保存失败'); }
            finally { button.disabled = false; }
        });
        document.getElementById('memory-palace-links-close')?.addEventListener('click', () => document.getElementById('memory-palace-links-modal').classList.remove('visible'));
        document.getElementById('memory-palace-link-add')?.addEventListener('click', async event => {
            const source = await getNode(ui.linksId);
            const targetId = document.getElementById('memory-palace-link-target')?.value;
            if (!source || !targetId) { showToast('请选择另一条记忆'); return; }
            const button = event.currentTarget;
            button.disabled = true;
            try {
                await saveLink({
                    characterId: source.characterId, sourceId: source.id, targetId,
                    type: document.getElementById('memory-palace-link-type')?.value,
                    strength: document.getElementById('memory-palace-link-strength')?.value,
                });
                await openLinks(source); await render(); showToast('关联已保存');
            } catch (error) { showToast(error.message || '添加关联失败'); }
            finally { button.disabled = false; }
        });
        document.getElementById('memory-palace-links-list')?.addEventListener('click', async event => {
            const button = event.target.closest('[data-link-action="delete"]');
            if (!button) return;
            if (!(await showAppConfirmDialog({ title: '确认删除', message: '确定删除这条关联吗？', confirmText: '删除', dismissText: '' }) === 'confirm')) return;
            await deleteLink(button.closest('[data-link-id]')?.dataset.linkId);
            const source = await getNode(ui.linksId);
            if (source) await openLinks(source);
            await render();
        });
        document.getElementById('memory-palace-event-box-close')?.addEventListener('click', () => document.getElementById('memory-palace-event-box-modal').classList.remove('visible'));
        document.getElementById('memory-palace-event-box-save')?.addEventListener('click', async event => {
            const source = await getNode(ui.eventBoxNodeId);
            if (!source) return;
            const targetId = document.getElementById('memory-palace-event-box-target')?.value;
            const button = event.currentTarget;
            button.disabled = true;
            try {
                if (ui.eventBoxId) {
                    await addNodesToEventBox(ui.eventBoxId, targetId ? [targetId] : []);
                    showToast(targetId ? '已加入事件盒' : '事件盒未修改');
                } else {
                    const box = await createEventBox(source.characterId, {
                        name: document.getElementById('memory-palace-event-box-name')?.value,
                        tags: document.getElementById('memory-palace-event-box-tags')?.value,
                        nodeIds: [source.id],
                    });
                    ui.eventBoxId = box.id;
                    showToast('事件盒已创建');
                }
                const updated = await getNode(source.id);
                if (updated) await openEventBox(updated);
                await render();
            } catch (error) { showToast(error.message || '事件盒操作失败'); }
            finally { button.disabled = false; }
        });
        document.getElementById('memory-palace-event-box-delete')?.addEventListener('click', async () => {
            if (!ui.eventBoxId || !(await showAppConfirmDialog({ title: '确认删除', message: '确定删除事件盒吗？其中的记忆不会被删除。', confirmText: '删除', dismissText: '' }) === 'confirm')) return;
            try {
                await deleteEventBox(ui.eventBoxId);
                document.getElementById('memory-palace-event-box-modal').classList.remove('visible');
                showToast('事件盒已删除');
                await render();
            } catch (error) { showToast(error.message || '删除事件盒失败'); }
        });
        document.getElementById('memory-palace-event-box-members')?.addEventListener('click', async event => {
            const button = event.target.closest('[data-event-box-action="remove"]');
            if (!button || !ui.eventBoxId) return;
            const nodeId = button.closest('[data-event-box-node-id]')?.dataset.eventBoxNodeId;
            if (!nodeId) return;
            try {
                await removeNodeFromEventBox(ui.eventBoxId, nodeId);
                const source = await getNode(ui.eventBoxNodeId);
                if (source) await openEventBox(source); else document.getElementById('memory-palace-event-box-modal').classList.remove('visible');
                await render();
            } catch (error) { showToast(error.message || '移除记忆失败'); }
        });
    }

    global.MemoryPalace = {
        featureConfig, withTimeout, render, getRoomLayout, saveRoomLayout,
        historyEntries, getHistoryJob, historyProgress, createHistoryJob, runHistoryJob, controlHistoryJob,
        ensureSettings, listNodes, getNode, saveNode, deleteNode, reembed, search, prepareContext,
        getContext, combineContexts, buildQuery, open, setup, importData,
        parseExtractionReply, originalMessageEntry, runAutoArchive, checkAndTriggerAutoArchive,
        listLinks, linksForNode, saveLink, deleteLink, refreshAutomaticLinks,
        listEventBoxes, getEventBox, createEventBox, addNodesToEventBox, removeNodeFromEventBox, deleteEventBox,
        listRoomPlates, getRoomPlate, saveRoomPlate, mutateRoomPlate, updateRoomPlateEntry, deleteRoomPlateEntry,
        getAnticipation, listAnticipations, saveAnticipation, createAnticipation, updateAnticipation, deleteAnticipation, advanceAnticipationLifecycle,
        getDigestReport, listDigestReports, saveDigestReport, deleteDigestReport
    };
    global.prepareMemoryPalaceContext = prepareContext;
    global.getMemoryPalaceContextBlock = getContext;
    global.combineMemoryContexts = combineContexts;
    global.setupMemoryPalaceScreen = setup;
})(typeof window !== 'undefined' ? window : globalThis);
