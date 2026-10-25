(function(g){
    'use strict';
    const C=()=>g.TrpgLibraryCore, table=name=>g.dexieDB[name], pause=()=>new Promise(r=>setTimeout(r,0));
    const MAX=50*1024*1024;
    let controller=null;
    const root=()=>document.getElementById('trpg-library');
    const field=name=>root()?.querySelector(`[data-lib="${name}"]`);
    const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const cancelled=signal=>{if(signal?.aborted) throw new Error('已取消导入');};
    const list=()=>table('trpgPacks').toArray();
    function dataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);});}
    async function parse(file,options){
        if(!/\.zip$/i.test(file.name)) {
            const result=await g.ReadingParsers.parse(file,{...options,preservePages:true});
            return {pages:result.metadata.pages || [{text:result.text}], attachments:[]};
        }
        const zip=await g.JSZip.loadAsync(await file.arrayBuffer());
        const entries=Object.values(zip.files).filter(e=>!e.dir);
        if(entries.length>32) throw new Error('压缩包最多 32 个文件');
        let total=0; const pages=[],attachments=[];
        for(const entry of entries){
            cancelled(options.signal);
            if(entry.name.split(/[\\/]/).includes('..')) throw new Error('压缩包路径无效');
            const size=entry._data?.uncompressedSize;
            if(!Number.isFinite(size) || size<0 || (total+=size)>MAX) throw new Error('解压内容超过 50 MB');
            if(!/\.(pdf|txt|md|markdown)$/i.test(entry.name)){attachments.push(entry.name);continue;}
            const bytes=await entry.async('uint8array');
            if(bytes.byteLength!==size) throw new Error('压缩包大小异常');
            const result=await g.ReadingParsers.parse(new File([bytes],entry.name),{...options,preservePages:true});
            pages.push(...(result.metadata.pages || [{text:result.text}]).map(p=>({...p,fileName:entry.name})));
        }
        return {pages,attachments};
    }
    async function importFile(file,options={}){
        if(!file || file.size>MAX || !/\.(pdf|txt|md|markdown|zip)$/i.test(file.name)) throw new Error('请选择 50 MB 以内的 PDF、TXT、Markdown 或 ZIP');
        cancelled(options.signal);
        const hash=await g.SharedAssets.digest(await file.arrayBuffer());
        if(options.hash && options.hash!==hash) throw new Error('内置资料校验失败，请重新下载');
        let source=await table('trpgSources').get(hash);
        const version=String(options.version || '1').slice(0,40);
        const id=`${hash}:${version}`;
        const existing=await table('trpgPacks').get(id);
        if(source && existing) return {pack:existing,cached:true};
        let rows=[];
        if(!source){
            const estimate=await navigator.storage?.estimate?.();
            if(estimate?.quota && estimate.quota-estimate.usage<file.size*5+8*1024*1024) throw new Error('本地空间不足，请清理后导入');
            const parsed=await parse(file,options);
            if(parsed.pages.reduce((n,p)=>n+p.text.length,0)>5*1024*1024) throw new Error('提取文本超过 500 万字符，请拆分');
            rows=C().chunks(hash,parsed.pages);
            if(rows.length>12000) throw new Error('分块超过 12000，请拆分资料');
            source={id:hash,fileName:file.name,size:file.size,mime:file.type,original:await dataUrl(file),parserVersion:g.ReadingParsers.VERSION,indexVersion:C().VERSION,chunkCount:rows.length,attachments:parsed.attachments,createdAt:Date.now()};
        }
        cancelled(options.signal);
        const pack=C().pack({id,sourceId:hash,title:file.name,category:options.category || '其他',version,visibility:'kp',enabled:false});
        await g.dexieDB.transaction('rw',[table('trpgSources'),table('trpgChunks'),table('trpgPacks'),table('sharedAssets')],async()=>{
            if(!await table('trpgSources').get(hash)){
                await table('trpgSources').put(source);
                for(let i=0;i<rows.length;i+=100){cancelled(options.signal);await table('trpgChunks').bulkPut(rows.slice(i,i+100));}
            }
            await table('trpgPacks').put(pack);
            const asset=await g.SharedAssets.registerExternal({id:`trpg-source:${hash}`,type:'document',name:file.name,contentHash:hash,size:file.size,externalStore:'trpgSources',externalKey:hash});
            await g.SharedAssets.attach(asset.id,{id:`trpg-pack:${id}`,ownerType:'trpg-pack',ownerId:id,role:'source'});
        });
        return {pack,cached:!!existing};
    }
    async function install(index,options={}){
        if(g.MioRelease?.publicSite)throw new Error('请导入你拥有使用权限的本地资料');
        const item=C().bundled[index];if(!item) throw new Error('资料不存在');
        const existing=await table('trpgPacks').get(`${item.hash}:${item.version}`);
        if(existing && await table('trpgSources').get(item.hash)) return {pack:existing,cached:true};
        const response=await fetch(encodeURI(item.url),{signal:options.signal});
        if(!response.ok) throw new Error('资料下载失败；可使用本地导入');
        return importFile(new File([await response.blob()],item.name),{...options,...item});
    }
    async function update(id,patch){
        return g.dexieDB.transaction('rw',table('trpgPacks'),async()=>{
            const old=await table('trpgPacks').get(id);if(!old)throw new Error('资料包已删除');
            const next=C().pack({...old,...patch,id:old.id,sourceId:old.sourceId,version:old.version,updatedAt:Date.now()});
            await table('trpgPacks').put(next);return next;
        });
    }
    async function remove(id){
        await g.dexieDB.transaction('rw',[table('trpgPacks'),table('trpgSources'),table('trpgChunks'),table('sharedAssets')],async()=>{
            const pack=await table('trpgPacks').get(id);if(!pack)return;
            await table('trpgPacks').delete(id);
            await g.SharedAssets.detach(`trpg-source:${pack.sourceId}`,`trpg-pack:${id}`);
            const asset=await g.SharedAssets.get(`trpg-source:${pack.sourceId}`);
            if(!await table('trpgPacks').where('sourceId').equals(pack.sourceId).count() && !asset?.refCount){
                await table('trpgSources').delete(pack.sourceId);
                await table('trpgChunks').where('sourceId').equals(pack.sourceId).delete();
                await table('sharedAssets').delete(`trpg-source:${pack.sourceId}`);
            }
        });
    }
    async function allowed(context){return (await list()).filter(p=>C().visible(p,context));}
    const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
    function remoteConfig(feature){
        const resolved=g.FeatureApiRegistry?.resolve(feature,{registry:g.db?.apiFeatureRegistry});
        if(!resolved?.configured || !resolved.config?.url || !resolved.config?.model)throw new Error(`请先配置独立 ${feature==='embedding'?'Embedding':'Rerank'} API`);
        return {...resolved.config,key:resolved.config.key || resolved.config.apiKey || ''};
    }
    const configKey=config=>JSON.stringify([config.provider||'newapi',config.url,config.model,config.dimensions||null]);
    function validVector(vector){return Array.isArray(vector)&&vector.length>0&&vector.length<=8192&&vector.every(Number.isFinite)&&vector.some(n=>n!==0);}
    async function guardPack(id,context){
        const pack=await table('trpgPacks').get(id);
        if(!pack || !pack.remoteAllowed || !C().visible(pack,context))throw new Error('资料未启用、未授权外发或当前身份不可见');
        return pack;
    }
    async function buildVectors(packId,context,options={}){
        if(context?.viewer!=='kp')throw new Error('仅 KP 可构建资料索引');
        const pack=await guardPack(packId,context),config=remoteConfig('embedding');
        const profile=await digest(configKey(config));
        let built=0,cached=0,dimensions=Number(config.dimensions)||0;
        const limit=200;
        const control={signal:options.signal,beforeRequest:async()=>{
            cancelled(options.signal);await guardPack(packId,context);
            if(configKey(remoteConfig('embedding'))!==configKey(config))throw new Error('Embedding 配置已更改，请重新开始');
        }};
        const count=await table('trpgChunks').where('sourceId').equals(pack.sourceId).count();
        for(let offset=0;offset<count && built<limit;offset+=64){
            cancelled(options.signal);
            const rows=await table('trpgChunks').where('sourceId').equals(pack.sourceId).offset(offset).limit(64).toArray();
            for(const row of rows){
                if(built>=limit)break;
                const hash=await digest(row.text),cache=row.embedding;
                if(cache?.profile===profile&&cache.hash===hash&&validVector(cache.vector)&&cache.dimensions===cache.vector.length&&(!dimensions||cache.dimensions===dimensions)){dimensions=cache.dimensions;cached++;continue;}
                await control.beforeRequest();
                const vectors=await g.VectorMemoryEmbedding.fetchEmbeddings([row.text],config,control);
                const vector=vectors[0];
                if(!validVector(vector)||vectors.length!==1||(dimensions&&dimensions!==vector.length))throw new Error('Embedding 维度或响应无效');
                dimensions=vector.length;
                await control.beforeRequest();
                await g.dexieDB.transaction('rw',table('trpgChunks'),async()=>{
                    const latest=await table('trpgChunks').get(row.id);
                    if(!latest||latest.text!==row.text||latest.revision!==row.revision)throw new Error('资料已修改，请重新构建');
                    await table('trpgChunks').update(row.id,{embedding:{profile,hash,dimensions,vector}});
                });
                built++;options.onProgress?.({built,cached,total:count});await pause();
            }
        }
        return {built,cached,total:count,remaining:Math.max(0,count-built-cached)};
    }
    async function clearVectors(packId){
        const pack=await table('trpgPacks').get(packId);if(!pack)return;
        await table('trpgChunks').where('sourceId').equals(pack.sourceId).modify(row=>{delete row.embedding;});
    }
    async function search(query,context,options={}){
        const local=await lexicalSearch(query,context);
        if(!options.embedding&&!options.rerank)return local;
        const scoped={...context};
        let result=local;
        try {
            cancelled(options.signal);
            const packs=(await allowed(scoped)).filter(p=>p.remoteAllowed);
            if(!packs.length)throw new Error('当前没有可见且已授权外发的资料，使用本地检索');
            const guard=async()=>{cancelled(options.signal);for(const p of packs)await guardPack(p.id,scoped);};
            if(options.embedding){
                const config=remoteConfig('embedding'),profile=await digest(configKey(config));
                const guardEmbedding=async()=>{await guard();if(configKey(remoteConfig('embedding'))!==configKey(config))throw new Error('Embedding 配置已更改');};
                // Query text is sent only after finding a matching cached index.
                let vector=null;const candidates=[];const seenSources=new Set();
                for(const pack of packs){
                    if(seenSources.has(pack.sourceId))continue;seenSources.add(pack.sourceId);
                    const count=await table('trpgChunks').where('sourceId').equals(pack.sourceId).count();
                    for(let offset=0;offset<count;offset+=64){
                        await guard();
                        for(const chunk of await table('trpgChunks').where('sourceId').equals(pack.sourceId).offset(offset).limit(64).toArray()){
                            const cache=chunk.embedding;
                            if(cache?.profile===profile&&validVector(cache.vector)&&cache.dimensions===cache.vector.length&&(!config.dimensions||Number(config.dimensions)===cache.dimensions)&&cache.hash===await digest(chunk.text)){
                                if(!vector){await guardEmbedding();[vector]=await g.VectorMemoryEmbedding.fetchEmbeddings([String(query).slice(0,200)],config,{signal:options.signal,beforeRequest:guardEmbedding});if(!validVector(vector))throw new Error('查询向量无效');}
                                if(cache.dimensions!==vector.length)continue;
                                candidates.push({pack,chunk,score:g.VectorMemoryEmbedding.cosineSimilarity(vector,cache.vector)});
                                candidates.sort((a,b)=>b.score-a.score);if(candidates.length>24)candidates.pop();
                            }
                        }
                        await pause();
                    }
                }
                if(candidates.length){
                    const semantic=candidates.filter(r=>Number.isFinite(r.score)).sort((a,b)=>b.score-a.score).slice(0,24);
                    if(!semantic.length)throw new Error('查询维度与索引不一致，请重新构建');
                    const merged=new Map();
                    [local,semantic].forEach(list=>list.forEach((row,index)=>{const existing=merged.get(row.chunk.id);merged.set(row.chunk.id,{...row,score:(existing?.score||0)+1/(60+index)});}));
                    result=[...merged.values()].sort((a,b)=>b.score-a.score).slice(0,24);
                }else options.onFallback?.('没有匹配的向量索引，请先构建；使用本地检索');
            }
            if(options.rerank){
                const config=remoteConfig('rerank');
                const remote=result.filter(row=>packs.some(p=>p.id===row.pack.id)).slice(0,24);
                if(remote.length){
                    const beforeRequest=async()=>{await guard();if(configKey(remoteConfig('rerank'))!==configKey(config))throw new Error('Rerank 配置已更改');};
                    await beforeRequest();
                    const ranked=await g.VectorMemoryEmbedding.fetchRerank(String(query).slice(0,200),remote.map(r=>r.chunk.text.slice(0,1400)),config,{signal:options.signal,beforeRequest});
                    if(!ranked.length)throw new Error('Rerank 未返回有效结果');
                    const order=[...ranked.map(r=>remote[r.index]),...remote.filter((_,i)=>!ranked.some(r=>r.index===i))];
                    let index=0;const ids=new Set(remote.map(r=>r.chunk.id));
                    result=result.map(row=>ids.has(row.chunk.id)?order[index++]:row);
                }
            }
            await guard();
            // Re-read content after external work so a revoked/edited/deleted row cannot survive a stale response.
            const fresh=[];
            for(const row of result){const pack=await table('trpgPacks').get(row.pack.id),chunk=await table('trpgChunks').get(row.chunk.id);if(pack&&chunk&&C().visible(pack,scoped)&&chunk.revision===row.chunk.revision&&chunk.text===row.chunk.text)fresh.push({...row,pack,chunk});}
            return fresh.slice(0,8);
        }catch(error){
            if(options.signal?.aborted)throw error;
            options.onFallback?.('增强检索不可用，已返回本地结果');
            return lexicalSearch(query,scoped);
        }
    }
    async function lexicalSearch(query,context){
        query=String(query || '').slice(0,200);
        const allWords=C().tokens(query);
        const words=(allWords.some(w=>w.length>1)?allWords.filter(w=>w.length>1):allWords).slice(0,20);if(!words.length)return [];
        const packs=await allowed(context), sources=[...new Set(packs.map(p=>p.sourceId))];
        const found=[];
        for(const sourceId of sources){
            const records=await table('trpgChunks').where('keys').anyOf(words.map(w=>`${sourceId}|${w}`)).distinct().limit(300).toArray();
            const pack=packs.filter(p=>p.sourceId===sourceId).sort((a,b)=>b.priority-a.priority)[0];
            for(const chunk of records){
                if(chunk.sourceId!==sourceId)continue;
                const matches=words.filter(w=>chunk.keys.includes(`${sourceId}|${w}`)).length;
                if(matches) found.push({pack,chunk,score:matches/words.length+(chunk.text.toLowerCase().includes(query.toLowerCase())?1:0)+pack.priority/1000});
            }
            await pause();
        }
        return found.sort((a,b)=>b.score-a.score || a.chunk.ordinal-b.chunk.ordinal).slice(0,8);
    }
    async function getChunk(id,context){
        const packs=await allowed(context); const sourceId=id.split(':')[0];
        if(!packs.some(p=>p.sourceId===sourceId)) throw new Error('无权查看此片段');
        return table('trpgChunks').get(id);
    }
    async function rebuild(packId){
        const pack=await table('trpgPacks').get(packId);if(!pack)throw new Error('资料包不存在');
        await g.dexieDB.transaction('rw',[table('trpgChunks'),table('trpgSources')],async()=>{
            await table('trpgChunks').where('sourceId').equals(pack.sourceId).modify(row=>{Object.assign(row,C().index(row));});
            await table('trpgSources').update(pack.sourceId,{indexVersion:C().VERSION});
        });
    }
    async function correct(id,text,expectedRevision,context){
        if(context?.viewer!=='kp' || !await getChunk(id,context))throw new Error('仅 KP 可纠错已启用资料');
        if(typeof text!=='string' || !text.trim() || text.length>4000)throw new Error('纠错正文须为 1–4000 字符');
        await g.dexieDB.transaction('rw',table('trpgChunks'),async()=>{
            const old=await table('trpgChunks').get(id);if(!old || old.revision!==expectedRevision)throw new Error('片段已更新，请重新检索');
            const revisions=[...(old.revisions || []),{text:old.text,at:Date.now()}];
            if(revisions.length>50)throw new Error('此片段已达 50 次修订，请导入新资料版本');
            await table('trpgChunks').put(C().index({...old,text,originalText:old.originalText??old.text,revisions,revision:old.revision+1}));
        });
    }
    async function download(packId,context){
        const pack=(await allowed(context)).find(p=>p.id===packId);if(!pack)throw new Error('请先启用资料并确认查看身份');
        const source=await table('trpgSources').get(pack.sourceId);if(!source?.original)throw new Error('原文件缺失');
        if(!/^data:[^,]*;base64,[a-z0-9+/=\r\n]*$/i.test(source.original))throw new Error('原文件格式无效');
        const link=document.createElement('a');link.href=source.original;link.download=source.fileName;link.click();
    }
    function context(){return {viewer:field('viewer').value==='kp'?'kp':'player',characterId:field('viewer').value,campaignId:field('campaign').value};}
    async function render(){
        field('results').replaceChildren();
        const packs=await list();
        const campaigns=await g.CoC7.list();
        const roles=g.db?.characters || [];
        field('bundled').innerHTML=g.MioRelease?.publicSite?'<p>可导入你拥有使用权限的本地资料，已导入内容继续保留。</p>':C().bundled.map((b,i)=>`<div class="lib-row"><span>${escape(b.name)}</span><button class="btn btn-secondary" data-install="${i}">${packs.some(p=>p.sourceId===b.hash)?'已载入':'载入资料'}</button></div>`).join('');
        field('packs').innerHTML=packs.map(p=>`<details data-pack="${escape(p.id)}"><summary>${escape(p.title)} · ${escape(p.version)}${p.enabled?' · 已启用':' · 停用'}</summary><label><input type="checkbox" data-pack-field="enabled" ${p.enabled?'checked':''}> 启用</label><label>类别<input data-pack-field="category" value="${escape(p.category)}" maxlength="50"></label><label>优先级<input data-pack-field="priority" type="number" min="-100" max="100" value="${p.priority}"></label><label>可见范围<select data-pack-field="visibility">${[['kp','仅 KP'],['public','玩家已知'],['participants','指定角色']].map(([v,t])=>`<option value="${v}" ${v===p.visibility?'selected':''}>${t}</option>`).join('')}</select></label><fieldset><legend>指定角色</legend>${roles.map(c=>`<label class="lib-check"><input type="checkbox" data-character="${escape(c.id)}" ${p.characterIds.includes(c.id)?'checked':''}>${escape(c.remarkName || c.realName || c.name || c.id)}</label>`).join('') || '<small>尚未创建角色</small>'}</fieldset><label>限定跑团<select data-pack-field="campaignId"><option value="">不限跑团</option>${campaigns.map(c=>`<option value="${escape(c.id)}" ${c.id===p.campaignId?'selected':''}>${escape(c.title)}</option>`).join('')}${p.campaignId&&!campaigns.some(c=>c.id===p.campaignId)?`<option value="${escape(p.campaignId)}" selected>已删除的跑团（保持隔离）</option>`:''}</select></label><div class="coc-actions"><button class="btn btn-primary" data-save-pack>保存设置</button><button class="btn btn-secondary" data-download>下载原文件</button><button class="btn btn-danger" data-remove-pack>移除本地资料</button></div></details>`).join('') || '<p>尚未载入资料。</p>';
        field('packs').querySelectorAll('.coc-actions').forEach(actions=>{
            const holder=actions.closest('[data-pack]'),pack=packs.find(p=>p.id===holder.dataset.pack);
            holder.insertAdjacentHTML('beforeend',`<label class="lib-check"><input type="checkbox" data-pack-field="remoteAllowed" ${pack.remoteAllowed?'checked':''}>允许本资料发送给已配置的 Embedding / Rerank 服务</label><small>默认关闭。仅构建或勾选增强检索时外发；修改后先保存设置。</small>`);
            for(const [key,label] of [['reindex','重建本地索引'],['vectors','构建 / 继续向量索引'],['clearVectors','清除向量缓存']]){const button=document.createElement('button');button.className='btn btn-secondary';button.dataset[key]='';button.textContent=label;actions.append(button);}
        });
        const viewer=field('viewer').value;
        field('viewer').innerHTML='<option value="kp">KP 视角</option><option value="player">公开玩家视角</option>'+(g.db?.characters || []).map(c=>`<option value="${escape(c.id)}">${escape(c.remarkName || c.realName || c.name || c.id)}</option>`).join('');
        if([...field('viewer').options].some(o=>o.value===viewer))field('viewer').value=viewer;
        const campaign=field('campaign').value;
        field('campaign').innerHTML='<option value="">不限跑团</option>'+(await g.CoC7.list()).map(c=>`<option value="${escape(c.id)}">${escape(c.title)}</option>`).join('');field('campaign').value=campaign;
    }
    async function task(fn){
        if(controller)return;
        controller=new AbortController();field('notice').textContent='处理中…';
        try{const message=await fn({signal:controller.signal,onProgress:p=>{field('notice').textContent=`提取文本 ${Math.round(p*100)}%`;}});field('notice').textContent=typeof message==='string'?message:'操作完成';}
        catch(e){field('notice').textContent=e.message || String(e);}
        finally{controller=null;}
    }
    async function showResults(){
        let warning='';const ctx=context(), query=field('query').value;
        const rows=await search(query,ctx,{embedding:field('embedding').checked,rerank:field('rerank').checked,signal:controller?.signal,onFallback:text=>{warning=text;}});
        // The view may change while IndexedDB is working.
        if(JSON.stringify(ctx)!==JSON.stringify(context())||query!==field('query').value)return;
        field('results').innerHTML=rows.map(({pack,chunk})=>`<article><strong>${escape(pack.title)} · ${escape(pack.version)}</strong><small>${escape(chunk.fileName)} ${chunk.page?`PDF 第 ${chunk.page} 页`:`第 ${chunk.lineStart}–${chunk.lineEnd} 行`} ${escape(chunk.heading)} · 修订 ${chunk.revision}</small><pre>${escape(chunk.text)}</pre>${ctx.viewer==='kp'?`<details><summary>手动纠错</summary><textarea data-correct-text rows="5" maxlength="4000">${escape(chunk.text)}</textarea><button class="btn btn-secondary" data-correct="${escape(chunk.id)}" data-revision="${chunk.revision}">保存修订</button></details>`:''}</article>`).join('') || '<p>当前可见且已启用的资料中没有找到内容。</p>';
        return warning || (field('embedding').checked||field('rerank').checked?'增强检索完成；外发范围限于已授权且当前可见的资料':'本地检索完成，未调用 API');
    }
    function setup(){
        if(!root() || root().dataset.ready)return;root().dataset.ready='true';
        const enhanced=document.createElement('details');
        enhanced.innerHTML='<summary>可选增强检索</summary><p class="trpg-broadcast-note">使用全局独立 Embedding / Rerank 配置。勾选后会发送查询及已授权片段，可能产生服务费用；默认离线检索。</p><label class="lib-check"><input type="checkbox" data-lib="embedding">语义检索（先构建向量索引）</label><label class="lib-check"><input type="checkbox" data-lib="rerank">Rerank 重排</label>';
        field('results').before(enhanced);
        for(const name of ['viewer','campaign','embedding','rerank'])field(name).addEventListener('change',()=>{controller?.abort();field('results').replaceChildren();});
        root().addEventListener('toggle',()=>{if(root().open)void task(render);});
        field('viewer').addEventListener('change',()=>{field('results').replaceChildren();field('management').hidden=field('viewer').value!=='kp';});field('campaign').addEventListener('change',()=>field('results').replaceChildren());
        field('import').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';if(file)void task(async opts=>{await importFile(file,{...opts,version:field('version').value});await render();});});
        root().addEventListener('click',e=>{
            const button=e.target.closest('button');if(!button)return;
            if(button.hasAttribute('data-cancel')){controller?.abort();return;}
            void task(async opts=>{
                if(button.hasAttribute('data-install')){await install(Number(button.dataset.install),opts);await render();}
                else if(button.hasAttribute('data-search'))return showResults();
                else if(button.hasAttribute('data-correct')){await correct(button.dataset.correct,button.parentElement.querySelector('textarea').value,Number(button.dataset.revision),context());await showResults();}
                else {
                    const holder=button.closest('[data-pack]');if(!holder)return;const id=holder.dataset.pack;
                    if(button.hasAttribute('data-save-pack')){const patch={};holder.querySelectorAll('[data-pack-field]').forEach(el=>{patch[el.dataset.packField]=el.type==='checkbox'?el.checked:el.value;});patch.characterIds=[...holder.querySelectorAll('[data-character]:checked')].map(el=>el.dataset.character);await update(id,patch);await render();}
                    else if(button.hasAttribute('data-remove-pack')){if(confirm('移除此资料包及无其他版本引用的本地源文件和索引？内置文件仍可重新载入。')){await remove(id);await render();}}
                    else if(button.hasAttribute('data-download'))await download(id,context());
                    else if(button.hasAttribute('data-reindex')){await rebuild(id);await render();}
                    else if(button.hasAttribute('data-vectors')){
                        if(!confirm('向已配置的 Embedding 服务发送此资料的未缓存片段？本次最多处理 200 段，可取消并稍后继续。'))return '已取消';
                        const progress=await buildVectors(id,context(),{signal:opts.signal,onProgress:p=>{field('notice').textContent=`本轮已构建 ${p.built} 段，缓存命中 ${p.cached} 段 / 共 ${p.total} 段`;}});
                        return `构建 ${progress.built} 段，复用 ${progress.cached} 段；剩余 ${progress.remaining} 段可继续`;
                    }
                    else if(button.hasAttribute('data-clear-vectors')){await clearVectors(id);return '已清除本地向量缓存，原文和全文索引保留';}
                }
            });
        });
    }
    g.TrpgLibrary=Object.freeze({setup,list,importFile,install,update,remove,search,getChunk,correct,rebuild,download,buildVectors,clearVectors});
})(window);
