(function (global) {
    'use strict';
    const core = () => global.CoC7Core;
    const table = () => global.dexieDB?.trpgCampaigns;
    const uid = () => global.crypto.randomUUID();
    let current = null, selectedCard = '', selectedStory = '', draftSources = [], previewCitations = [], busy = false;
    const root = () => global.document.getElementById('coc7-tools');
    const field = name => root()?.querySelector(`[data-field="${name}"]`);
    const value = name => field(name)?.value ?? '';
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const option = (id, name) => `<option value="${escape(id)}">${escape(name)}</option>`;
    const roles = () => global.db?.characters || [];
    async function list() { return (await table().toArray()).sort((a, b) => b.updatedAt - a.updatedAt); }
    async function get(id) { const row = await table().get(id); if (!row) throw new Error('跑团存档不存在'); return core().campaign(row); }
    async function create(title = '新的跑团') {
        const record = core().campaign({ id: uid(), schemaVersion: 2, state:{}, rulesVersion: core().VERSION, title, cards: [], events: [], revision: 0, updatedAt: Date.now() });
        await table().add(record); return record;
    }
    async function dispatch(id, command, expectedRevision) {
        return global.dexieDB.transaction('rw', table(), async () => {
            const previous = await get(id);
            if (previous.events.some(e => e.id === command.id)) return core().apply(previous,command);
            if (expectedRevision != null && previous.revision !== expectedRevision) throw new Error('存档已在其他窗口更新，请重新载入后操作');
            const next = core().campaign(core().apply(previous, command)); await table().put(next); return next;
        });
    }
    async function exportSave(id) { const campaign=await get(id); return JSON.stringify({ format: 'mio-coc7', version: campaign.events.some(event=>event.kind==='dialogue')?3:2, campaign }, null, 2); }
    async function importSave(source) {
        if (typeof source !== 'string') throw new Error('存档必须为 JSON 文本');
        const parsed = JSON.parse(source);
        if (parsed.format !== 'mio-coc7' || ![1,2,3].includes(parsed.version)) throw new Error('不是受支持的 Mio CoC 存档');
        const record = core().campaign(parsed.campaign); record.id = uid(); record.title = `${record.title.slice(0, 110)}（导入）`; record.updatedAt = Date.now();
        await table().add(record); return record;
    }
    async function remove(id) { await table().delete(id); }
    // No shared context cache: every preview/bridge rechecks the campaign and source permissions.
    async function buildContext(id, context, query = '') {
        const saved = await get(id);
        const ctx = { remote:context?.remote===true,playerId:context?.playerId||'local-user',viewer: context?.viewer, characterId: context?.characterId || '', campaignId: id };
        const visible = core().visibleStory(saved, ctx);
        const items = visible.filter(i => !saved.story.currentSceneId || i.id === saved.story.currentSceneId || !i.sceneId || i.sceneId === saved.story.currentSceneId);
        const citations = [];
        const addSource = async (pack, chunk, pinnedRevision) => {
            if (citations.length >= 5 || citations.some(c => c.chunkId === chunk?.id)) return;
            const packs = await global.TrpgLibrary.list();
            const latest = packs.find(p => p.id === pack?.id);
            if (!latest || !global.TrpgLibraryCore.visible(latest, ctx) || ctx.remote&&!latest.remoteAllowed) return;
            const fresh = await global.TrpgLibrary.getChunk(chunk?.id, ctx);
            if (!fresh || fresh.sourceId !== latest.sourceId) return;
            citations.push({ packId: latest.id, chunkId: fresh.id, title: latest.title, version: latest.version,
                page: fresh.page, fileName: fresh.fileName, lineStart: fresh.lineStart, revision: fresh.revision,
                changed: pinnedRevision != null && pinnedRevision !== fresh.revision, text: fresh.text.slice(0, 700) });
        };
        if (global.TrpgLibrary) {
            const packs = await global.TrpgLibrary.list();
            for (const item of items) for (const ref of item.sources) {
                const pack = packs.find(p => p.id === ref.packId);
                if (!pack || !global.TrpgLibraryCore.visible(pack, ctx)) continue;
                try { await addSource(pack, await global.TrpgLibrary.getChunk(ref.chunkId, ctx), ref.revision); }
                catch (_) { /* Deleted or revoked sources are omitted, never copied from an old preview. */ }
            }
            if (String(query).trim()) for (const row of await global.TrpgLibrary.search(query, ctx)) await addSource(row.pack, row.chunk);
        }
        if ((await get(id)).revision !== saved.revision) throw new Error('跑团已更新，请重新预览');
        const latestPacks = global.TrpgLibrary ? await global.TrpgLibrary.list() : [];
        if (citations.some(c => !latestPacks.some(p => p.id === c.packId && global.TrpgLibraryCore.visible(p, ctx)))) throw new Error('资料权限已变化，请重新预览');
        const header = ctx.viewer === 'kp' ? `KP 资料 · ${saved.title}\n${saved.scene}` : '跑团中当前身份已知的内容';
        const world=saved.schemaVersion===2?global.TrpgStateCore.project(saved.state,ctx):null;
        const sections = [header];let worldChars=0,worldTruncated=false;
        if(world){sections.push('剧情时间：'+JSON.stringify(world.timeline));for(const domain of ['inventory','quests','relationships'])for(const row of world[domain]){const block=domain+'：'+JSON.stringify(row);if(block.length+worldChars>2200){worldTruncated=true;continue;}sections.push(block);worldChars+=block.length;}}
        const includedIds = [];
        let remaining = 6000 - sections.join('\n').length;
        for (const item of items) {
            const block = `\n[${{scene:'场景',npc:'NPC',clue:'线索'}[item.kind]}] ${item.title}\n${item.text}`;
            if (block.length > remaining) continue;
            sections.push(block); remaining -= block.length; includedIds.push(item.id);
        }
        const used = [];
        for (const cite of citations) {
            const block = `\n[依据 ${used.length + 1}] ${cite.title} · ${cite.version} · ${cite.fileName || ''} ${cite.page ? 'PDF 第 '+cite.page+' 页' : '第 '+cite.lineStart+' 行'} · 修订 ${cite.revision}${cite.changed ? '（引用后有修订）' : ''}\n${cite.text}`;
            if (block.length > remaining) continue;
            sections.push(block); remaining -= block.length; used.push(cite);
        }
        return { campaignId: id, revision: saved.revision, viewer: ctx.viewer, characterId: ctx.characterId,
            text: sections.join('\n'), citations: used, itemIds: includedIds, truncated: worldTruncated || includedIds.length < items.length || used.length < citations.length };
    }
    async function archiveContext(id, characterId, query = '') {
        if (!roles().some(r => r.id === characterId)) throw new Error('请选择仍存在的参与角色');
        const preview = await buildContext(id, { viewer: 'player', characterId }, query);
        if (!preview.itemIds.length && !preview.citations.length) throw new Error('该角色目前没有可归档的内容');
        if (!global.MemoryPalace?.saveNode) throw new Error('记忆宫殿尚未加载');
        return global.MemoryPalace.saveNode({ id: `trpg:${id}:${characterId}:${preview.revision}`, characterId,
            content: `【跑团经历，并非现实生活】\n${preview.text}`, room: 'living_room', layer: 'experience', tags: ['trpg', id],
            source: { type: 'trpg', campaignId: id, revision: preview.revision, itemIds: preview.itemIds, citations: preview.citations.map(({text, ...ref}) => ref) }
        }, { localOnly: true, skipLinkRefresh: true });
    }
    async function prepareBroadcast(id, context, query = '') {
        if (context?.viewer !== 'player') throw new Error('播报草稿仅接受玩家可见内容，请先选择公开玩家或参与角色');
        const preview = await buildContext(id, context, query);
        if (!preview.itemIds.length && !preview.citations.length) throw new Error('当前没有可播报内容');
        global.TRPGBroadcast.prepareText(preview.text.slice(0, 4000));
        return preview;
    }
    function cardForm() {
        const previousKey = value('key');
        const card = current?.cards.find(c => c.id === selectedCard);
        field('character').innerHTML = option('', '独立调查员 / NPC') + roles().map(r => option(r.id, r.remarkName || r.realName || r.name || '角色')).join('');
        if (card?.characterId && !roles().some(r => r.id === card.characterId)) field('character').insertAdjacentHTML('beforeend', option(card.characterId, '已删除的角色（保留引用）'));
        field('character').value = card?.characterId || '';
        field('name').value = card?.name || '';
        for (const key of core().ATTRIBUTES) field(key).value = card?.attributes[key] ?? 50;
        field('skills').value = Object.entries(card?.skills || {}).map(([k, v]) => `${k}=${v}`).join('\n');
        for (const key of ['hp', 'mp', 'san']) field(key).value = card?.[key] ?? '';
        field('mythos').value = card?.mythos ?? 0; field('luck').value = card?.luck ?? 50;
        field('derived').textContent = card ? `HP ${card.hp}/${card.hpMax} · MP ${card.mp}/${card.mpMax} · SAN ${card.san}/${card.sanMax} · 体格 ${card.build} · 伤害加值 ${card.damageBonus}` : '填写基础属性；HP、MP、SAN 留空时使用初始值。';
        field('key').innerHTML = [...core().ATTRIBUTES, 'LUCK', 'MYTHOS', ...Object.keys(card?.skills || {})].map(k => option(k, ({ LUCK: '幸运', MYTHOS: '克苏鲁神话' })[k] || k)).join('');
        if ([...field('key').options].some(o => o.value === previousKey)) field('key').value = previousKey;
    }
    const levels = { critical: '大成功', extreme: '极难成功', hard: '困难成功', regular: '普通成功', failure: '失败', fumble: '大失败' };
    function describe(e) {
        if(e.kind==='dialogue')return `${e.name || e.speaker}：${e.content}`;
        if(e.kind==='knowledge')return '知识事件：'+e.operation+' · '+e.cause;
        if(e.kind==='state')return '剧情状态：'+e.domain+' · '+e.cause;
        if (e.kind === 'story') return `场景记录：${e.operation} · ${e.after?.title || e.before?.title || ''}`;
        if (e.kind === 'check' || e.kind === 'sanity') return `${e.key}：${e.roll.result} / ${e.check.target}，${levels[e.check.level]}，${e.check.passed ? '达成难度' : '未达成难度'}${e.kind === 'sanity' ? `；SAN ${e.before} → ${e.after}（损失 ${e.loss.total}）${e.needsKeeperReview ? '；请 KP 处理后续理智状态' : ''}` : ''}`;
        if (e.kind === 'dice') return `${e.roll.expression} = ${e.roll.total}`;
        if (e.kind === 'adjust') return `${e.resource.toUpperCase()} ${e.before} → ${e.after} · ${e.reason || '手动调整'}`;
        return e.kind === 'card' ? `保存角色卡：${e.after.name}` : `保存进度：${e.after.title}`;
    }
    async function render() {
        const records = await list();
        field('campaign').innerHTML = option('', '选择跑团') + records.map(r => option(r.id, r.title)).join('');
        field('campaign').value = current?.id || '';
        field('content').hidden = !current;
        if (!current) return;
        field('title').value = current.title; field('scene').value = current.scene;
        if (!current.cards.some(c => c.id === selectedCard)) selectedCard = current.cards[0]?.id || '';
        field('card').innerHTML = option('', '新增角色卡') + current.cards.map(c => option(c.id, c.name)).join(''); field('card').value = selectedCard;
        cardForm();
        field('events').innerHTML = current.events.slice(-30).reverse().map(e => `<li><span>${escape(current.cards.find(c => c.id === e.cardId)?.name || '')} ${escape(describe(e))}</span><details><summary>查看依据</summary><pre>${escape(JSON.stringify(e, null, 2))}</pre></details></li>`).join('') || '<li>还没有判定记录。</li>';
        field('count').textContent = `显示最近 30 条，共 ${current.events.length} 条；导出保留全部记录。`;
        renderStory();
    }
    async function run(task) {
        if (busy) return;
        busy = true; root().querySelectorAll('button,select').forEach(el => { el.disabled = true; });
        try { await task(); await render(); field('notice').textContent = '已保存到本机'; }
        catch (error) { field('notice').textContent = error?.message || String(error); }
        finally { busy = false; root().querySelectorAll('button,select').forEach(el => { el.disabled = false; }); }
    }
    async function act(action) {
        if (action === 'create') { current = await create(); selectedCard = ''; return; }
        if (!current) throw new Error('请先新建或选择跑团');
        if (action === 'reload') { current = await get(current.id); return; }
        if (action === 'export') {
            const url = URL.createObjectURL(new Blob([await exportSave(current.id)], { type: 'application/json' }));
            const link = global.document.createElement('a'); link.href = url; link.download = `mio-coc7-${current.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
        }
        if (action === 'delete') { if (!global.confirm('删除当前跑团及其角色卡、判定记录？其他跑团和聊天不受影响。')) return; await remove(current.id); current = null; return; }
        const command = { id: uid(), kind: action, cardId: selectedCard, at: Date.now() };
        if (action === 'progress') Object.assign(command, { title: value('title'), scene: value('scene') });
        if (action === 'card') {
            const skills = Object.fromEntries(value('skills').split('\n').filter(s => s.trim()).map(line => {
                const match = /^(.+?)\s*=\s*(\d+)\s*$/.exec(line); if (!match) throw new Error('技能每行填写：侦查=50');
                const key = match[1].trim(); if ([...core().ATTRIBUTES, 'LUCK', 'MYTHOS', 'SAN'].includes(key)) throw new Error('技能名不能与基础属性重复');
                return [key, Number(match[2])];
            }));
            command.card = { id: selectedCard || uid(), characterId: value('character'), name: value('name'), skills,
                attributes: Object.fromEntries(core().ATTRIBUTES.map(k => [k, value(k)])), mythos: value('mythos'), luck: value('luck'),
                ...Object.fromEntries(['hp', 'mp', 'san'].filter(k => value(k) !== '').map(k => [k, value(k)])) };
        }
        if (action === 'check') Object.assign(command, { key: value('key'), difficulty: value('difficulty'), bonus: Number(value('bonus')), penalty: Number(value('penalty')) });
        if (action === 'sanity') Object.assign(command, { lossSuccess: value('lossSuccess'), lossFailure: value('lossFailure') });
        if (action === 'adjust') Object.assign(command, { resource: value('resource'), delta: value('delta'), reason: value('reason') });
        if (action === 'dice') command.expression = value('expression');
        current = await dispatch(current.id, command, current.revision);
        if (action === 'card') selectedCard = command.card.id;
    }
    function renderStory() {
        const items = current.story.items;
        if (!items.some(i => i.id === selectedStory)) selectedStory = '';
        field('story-item').innerHTML = option('', '新增条目') + items.map(i => option(i.id, `${{scene:'场景',npc:'NPC',clue:'线索'}[i.kind]} · ${i.title}`)).join('');
        field('story-item').value = selectedStory;
        const scenes = items.filter(i => i.kind === 'scene');
        field('story-current').innerHTML = option('', '全部场景') + scenes.map(i => option(i.id, i.title)).join('');
        field('story-current').value = current.story.currentSceneId;
        field('story-scene').innerHTML = option('', '不限定场景') + scenes.map(i => option(i.id, i.title)).join('');
        field('story-card').innerHTML = option('', '不关联角色卡') + current.cards.map(c => option(c.id, c.name)).join('');
        const participants = [...new Set(current.cards.map(c => c.characterId).filter(Boolean))];
        field('story-participants').innerHTML = participants.map(id => `<label><input type="checkbox" value="${escape(id)}">${escape(roles().find(r => r.id === id)?.name || '已删除角色')}</label>`).join('') || '<small>先将角色卡关联到角色，才能定向公开。</small>';
        const viewer = value('story-viewer');
        field('story-viewer').innerHTML = option('kp', 'KP 私密预览') + option('public', '公开玩家预览') + participants.filter(id => roles().some(r => r.id === id)).map(id => option(id, roles().find(r => r.id === id).name)).join('');
        if ([...field('story-viewer').options].some(o => o.value === viewer)) field('story-viewer').value = viewer;
        const item = items.find(i => i.id === selectedStory);
        for (const [key, fallback] of [['kind','clue'],['title',''],['text',''],['sceneId',''],['cardId',''],['visibility','kp']]) {
            const target = {kind:'kind',title:'title',text:'text',sceneId:'scene',cardId:'card',visibility:'visibility'}[key];
            field('story-'+target).value = item?.[key] ?? fallback;
        }
        field('story-visibility').disabled=!!item?.audience;
        field('story-participants').querySelectorAll('input').forEach(el => { el.checked = item?.characterIds.includes(el.value) || false; });
        draftSources = (item?.sources || []).map(ref => ({...ref}));
        renderSourceDraft();
        field('story-preview').textContent = '';
        previewCitations = [];
        field('story-citations').replaceChildren();
    }
    function renderSourceDraft() {
        field('story-sources').innerHTML = draftSources.map((s, index) => `<div class="coc-actions"><span>出处 ${index+1} · 修订 ${s.revision}</span><button class="btn btn-secondary" data-story-unlink="${index}">移除引用</button></div>`).join('') || '<small>在下方检索并预览资料后，点击“引用到当前条目”。</small>';
    }
    function storyContext() {
        const viewer = value('story-viewer');
        return { viewer: viewer === 'kp' ? 'kp' : 'player', characterId: ['kp','public'].includes(viewer) ? '' : viewer };
    }
    function setupStory() {
        const panel = global.document.createElement('details');
        panel.className = 'trpg-broadcast-editor';
        panel.innerHTML = `<summary>场景、NPC 与线索</summary>
            <p class="trpg-broadcast-note">KP 工作区。条目默认保密；预览只包含当前身份已知内容。旧场景笔记仅 KP 可见。</p>
            <label class="trpg-broadcast-field">当前场景<select data-field="story-current"></select></label><button class="btn btn-secondary" data-story-action="select">切换场景</button>
            <label class="trpg-broadcast-field">编辑条目<select data-field="story-item"></select></label>
            <div class="coc-grid"><label>类型<select data-field="story-kind"><option value="scene">场景</option><option value="npc">NPC</option><option value="clue">线索</option></select></label><label>关联角色卡<select data-field="story-card"></select></label></div>
            <label class="trpg-broadcast-field">标题<input data-field="story-title" maxlength="120"></label>
            <label class="trpg-broadcast-field">内容<textarea data-field="story-text" maxlength="4000" rows="4"></textarea></label>
            <label class="trpg-broadcast-field">所属场景<select data-field="story-scene"></select></label>
            <label class="trpg-broadcast-field">公开范围<select data-field="story-visibility"><option value="kp">仅 KP</option><option value="public">所有玩家已知</option><option value="participants">指定参与角色</option></select></label>
            <fieldset><legend>参与角色</legend><div data-field="story-participants"></div></fieldset>
            <details><summary>资料出处引用</summary><p class="trpg-broadcast-note">最多五处引用；保存条目后生效。引用不改变原资料权限。</p><div data-field="story-sources"></div></details>
            <div class="coc-actions"><button class="btn btn-primary" data-story-action="save">保存条目与公开范围</button><button class="btn btn-danger" data-story-action="remove">删除条目</button></div>
            <label class="trpg-broadcast-field">上下文预览身份<select data-field="story-viewer"></select></label>
            <label class="trpg-broadcast-field">补充检索关键词<input data-field="story-query" maxlength="200"></label>
            <div class="coc-actions"><button class="btn btn-primary" data-story-action="preview">预览当前已知内容</button><button class="btn btn-secondary" data-story-action="broadcast">填入播报草稿</button><button class="btn btn-secondary" data-story-action="archive">归档到该角色记忆</button></div>
            <p class="trpg-broadcast-note">记忆归档为当前已知内容的独立快照，后续收回公开范围不会自动删除历史记忆，可在记忆宫殿手动删除。仅本地保存，不调用 Embedding。</p>
            <pre data-field="story-preview" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto"></pre><div data-field="story-citations"></div>`;
        const stateButton=document.createElement('button');stateButton.type='button';stateButton.className='btn btn-secondary';stateButton.textContent='打开故事手记';stateButton.onclick=()=>{if(!current)return global.showToast('请先选择跑团');global.TrpgStateUI.open(current.id,()=>run(async()=>{current=await get(current.id);})).catch(error=>global.showToast(error.message));};
        field('content').append(stateButton,panel);
        field('story-item').addEventListener('change', () => { selectedStory = value('story-item'); renderStory(); });
        panel.addEventListener('change', () => { field('story-preview').textContent = ''; field('story-citations').replaceChildren(); previewCitations=[]; });
        panel.addEventListener('click', event => {
            const link = event.target.closest('[data-story-link]');
            const unlink = event.target.closest('[data-story-unlink]');
            if (link || unlink) {
                if (busy) return;
                if (link) {
                    const ref=previewCitations[Number(link.dataset.storyLink)];
                    if (ref && draftSources.length < 5 && !draftSources.some(s=>s.packId===ref.packId&&s.chunkId===ref.chunkId)) draftSources.push({packId:ref.packId,chunkId:ref.chunkId,revision:ref.revision});
                } else draftSources.splice(Number(unlink.dataset.storyUnlink),1);
                renderSourceDraft(); return;
            }
            const action = event.target.closest('[data-story-action]')?.dataset.storyAction;
            if (!action || busy) return;
            const campaignId = current?.id;
            if (!campaignId) return;
            if (['preview','archive','broadcast'].includes(action)) {
                const ctx = storyContext(), query = value('story-query');
                if (action === 'archive' && (!ctx.characterId || !global.confirm('将此角色当前已知内容作为跑团经历保存到记忆宫殿？'))) return;
                busy = true;
                root().querySelectorAll('button,select').forEach(el => { el.disabled = true; });
                field('story-preview').textContent = '正在读取当前权限…';
                field('story-citations').replaceChildren(); previewCitations=[];
                (async () => {
                    try {
                        const preview = await buildContext(campaignId, ctx, query);
                        if (current?.id !== campaignId || JSON.stringify(ctx) !== JSON.stringify(storyContext()) || query !== value('story-query')) return;
                        if (action === 'archive') await archiveContext(campaignId, ctx.characterId, query);
                        if (action === 'broadcast') await prepareBroadcast(campaignId, ctx, query);
                        field('story-preview').textContent = preview.text + (preview.truncated ? '\n（已达到上下文长度限制）' : '');
                        previewCitations=preview.citations;
                        field('story-citations').innerHTML=previewCitations.map((c,index)=>`<div class="coc-actions"><span>${escape(c.title)} · ${escape(c.version)} · ${c.page ? 'PDF 第 '+c.page+' 页' : '第 '+c.lineStart+' 行'}</span><button class="btn btn-secondary" data-story-link="${index}">引用到当前条目</button></div>`).join('');
                        field('notice').textContent = action === 'archive' ? '已归档角色跑团经历' : action === 'broadcast' ? '已填入播报草稿，请检查后加入队列' : '预览完成；未发送给 AI';
                    } catch (error) { field('story-preview').textContent = ''; field('notice').textContent = error.message; }
                    finally { busy = false; root().querySelectorAll('button,select').forEach(el=>{el.disabled=false;}); }
                })();
                return;
            }
            void run(async () => {
                const command = {id:uid(),kind:'story',operation:action,at:Date.now()};
                if (action === 'select') command.sceneId = value('story-current');
                if (action === 'remove') { if (!selectedStory || !global.confirm('删除此条目？已归档记忆不受影响。')) return; command.itemId = selectedStory; }
                if (action === 'save') {
                    const sources = draftSources.map(ref => ({...ref}));
                    command.item = {id:selectedStory || uid(),kind:value('story-kind'),title:value('story-title'),text:value('story-text'),
                        sceneId:value('story-scene'),cardId:value('story-card'),visibility:value('story-visibility'),sources,
                        characterIds:[...field('story-participants').querySelectorAll('input:checked')].map(el => el.value)};
                }
                current = await dispatch(campaignId, command, current.revision);
                if (command.item) selectedStory = command.item.id;
            });
        });
    }
    function setup() {
        if (!root() || root().dataset.ready) return; root().dataset.ready = 'true';
        field('attributes').innerHTML = core().ATTRIBUTES.map(k => `<label>${k}<input data-field="${k}" type="number" min="1" max="99" value="50"></label>`).join('');
        setupStory();
        root().addEventListener('click', event => { const button = event.target.closest('[data-coc-action]'); if (button) void run(() => act(button.dataset.cocAction)); });
        field('campaign').addEventListener('change', () => { const id = value('campaign'); void run(async () => { current = id ? await get(id) : null; selectedCard = ''; }); });
        field('card').addEventListener('change', () => { selectedCard = value('card'); cardForm(); });
        field('import').addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { current = await importSave(await file.text()); selectedCard = ''; }); });
        root().addEventListener('toggle', () => { if (root().open) void run(async () => { if (current) current = await get(current.id); }); });
    }
    async function selectCampaign(id) { current=await get(id);selectedCard='';await render(); }
    global.CoC7 = Object.freeze({ setup, list, get, create, dispatch, exportSave, importSave, remove, buildContext, archiveContext, prepareBroadcast, selectCampaign });
})(window);
