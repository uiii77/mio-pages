(function(global){
    'use strict';
    const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
    const uid=()=>crypto.randomUUID();
    const player={viewer:'player',playerId:'local-user'};
    let host,body,title,current=null,tab='story',busy=false,previous,visibleCount=100,controller;
    function button(label,action){const el=node('button',label);el.type='button';el.className='btn btn-secondary';el.onclick=async()=>{if(busy)return;el.disabled=true;try{await action();}catch(error){showToast(error.message||'操作未完成，请重试');}finally{el.disabled=false;}};return el;}
    const roleName=id=>(db.characters||[]).find(row=>String(row.id)===id)?.realName||'调查员';
    const permission=()=>({version:1,players:['local-user'],characters:current.cards.map(card=>card.characterId).filter(Boolean),shared:[],expired:false});
    async function commit(command){current=await CoC7.dispatch(current.id,{id:uid(),at:Date.now(),...command},current.revision);}
    async function saveDialogue(content,speaker='player',name='我') {await commit({kind:'dialogue',content,speaker,name,audience:permission()});}
    async function newCampaign(){
        const answer=await showAppFormDialog({title:'开启一场故事',fields:[{name:'title',label:'团名',required:true},{name:'scene',label:'开场场景',type:'textarea'}]});if(!answer)return;
        if(answer.title.length>120||answer.scene.length>4000)throw Error('团名限 120 字，开场限 4000 字；完整模组请从资料库导入');
        current=await CoC7.create(answer.title);if(answer.scene)await commit({kind:'story',operation:'save',item:{id:uid(),kind:'scene',title:'故事开始',text:answer.scene,visibility:'public'}});tab='story';await render();
    }
    function importButton(){
        const input=node('input');input.type='file';input.accept='.json,.txt,.md';input.hidden=true;
        input.onchange=async()=>{const file=input.files?.[0];input.value='';if(!file)return;try{
            if(file.size>10*1024*1024)throw Error('请选择 10 MB 以内的存档或文字模组');
            const text=await file.text();
            if(/\.json$/i.test(file.name))current=await CoC7.importSave(text);
            else {
                if(text.length>4000)throw Error('开场文字限 4000 字；完整模组请从资料库导入，避免截断正文');
                current=await CoC7.create(file.name.replace(/\.[^.]+$/,''));
                await commit({kind:'story',operation:'save',item:{id:uid(),kind:'scene',title:'模组资料',text,visibility:'kp'}});
                showToast('模组已保存为主持人资料，请按剧情分享玩家已知内容');
            }
            tab='story';await render();
        }catch(error){showToast(error.message);}};
        const wrap=node('div');wrap.append(button('导入模组 / 存档',()=>input.click()),input);return wrap;
    }
    async function tools(kind){
        const id=current?.id;host.hidden=true;TRPGBroadcast.open({returnTarget:'chat-room-screen'});
        const screen=document.getElementById('trpg-broadcast-screen');
        const target=kind==='rules'?document.getElementById('trpg-library'):kind==='cards'?document.getElementById('coc7-tools'):null;
        for(const panel of screen.querySelectorAll('main>details'))panel.open=panel===target;
        for(const panel of screen.querySelector('main').children)panel.hidden=target?panel!==target:panel.tagName==='DETAILS';
        if(target)target.scrollIntoView({block:'start'});
        if(kind==='cards'&&id){await CoC7.selectCampaign(id);}
        screen.querySelector('.back-btn').addEventListener('click',async event=>{
            event.preventDefault();event.stopImmediatePropagation();MioNavigation.back(screen.querySelector('.back-btn').dataset.target);host.hidden=false;
            if(current)current=await CoC7.get(current.id);await render();
        },{capture:true,once:true});
    }
    async function cards(){
        for(const card of current.cards){const row=node('article');row.className='trpg-player-card';row.append(node('h3',card.name),node('p',`HP ${card.hp}/${card.hpMax} · MP ${card.mp}/${card.mpMax} · SAN ${card.san}`));
            row.append(button('进行检定',async()=>{
                const choices=[...Object.keys(card.skills),...CoC7Core.ATTRIBUTES,'LUCK'];
                const answer=await showAppFormDialog({title:card.name+' · 检定',fields:[{name:'key',label:'技能或属性',type:'select',value:choices[0],options:choices.map(value=>({value,label:value}))},{name:'difficulty',label:'难度',type:'select',value:'regular',options:[{value:'regular',label:'普通'},{value:'hard',label:'困难'},{value:'extreme',label:'极难'}]}]});if(!answer)return;
                await commit({kind:'check',cardId:card.id,key:answer.key,difficulty:answer.difficulty,bonus:0,penalty:0});const result=current.events.at(-1);showToast(`${result.roll.result} / ${result.check.target} · ${result.check.passed?'成功':'失败'}`);await render();
            }));body.append(row);
        }
        body.append(button('新增调查员',async()=>{
            const answer=await showAppFormDialog({title:'新增调查员',fields:[{name:'name',label:'姓名',required:true},{name:'characterId',label:'关联角色',type:'select',options:[{value:'',label:'玩家本人'},...(db.characters||[]).map(row=>({value:String(row.id),label:row.realName||row.remarkName}))]}]});if(!answer)return;
            await commit({kind:'card',card:{id:uid(),name:answer.name,characterId:answer.characterId,attributes:{},skills:{侦查:25,聆听:20,图书馆使用:20}}});await render();
        }),button('编辑属性与技能',()=>tools('cards')));
    }
    async function askKeeper(input,roleId=''){
        const campaignId=current.id,revision=current.revision;
        const context=roleId?{viewer:'character',characterId:roleId,remote:true}:{...player,remote:true};
        const snapshot=await CoC7.get(campaignId);
        const material=roleId?{text:CoC7Core.visibleStory(snapshot,context).filter(item=>CoC7Core.visibleStory(snapshot,player).some(shared=>shared.id===item.id)).map(item=>item.title+'\n'+item.text).join('\n').slice(0,6000)}:await CoC7.buildContext(campaignId,context,input);
        if(!current||current.id!==campaignId||current.revision!==revision)throw Error('跑团已变化，请重试');
        const role=(db.characters||[]).find(row=>String(row.id)===roleId);
        const api=FeatureApiRegistry.resolve('trpg',{context:role,registry:db.apiFeatureRegistry});
        if(!api.enabled||!api.configured)throw Error('请先在 API 设置中配置并启用 TRPG 服务');
        const messages=[{role:'system',content:(roleId?`你扮演${roleName(roleId)}。`:'你担任故事引导者。')+'只使用已授权材料。不得泄露、猜测隐藏模组内容，不伪造骰点，不自行修改角色状态或知识权限。'+(tab==='free'?'自由交流，不推进剧情。':'描述当前行动的可见结果，给出下一步选择。')+'\n'+material.text},
            ...current.events.filter(event=>event.kind==='dialogue'&&TrpgStateCore.visible(event.audience,context)&&TrpgStateCore.visible(event.audience,player)).slice(-12).map(event=>({role:event.speaker==='player'?'user':'assistant',content:event.content})),{role:'user',content:input}];
        const config=api.config,endpoint=global.getApiConfigEndpoint?.(config,false)||`${String(config.url||'').replace(/\/$/,'')}/v1/chat/completions`,headers=global.getApiConfigHeaders?.(config)||{'Content-Type':'application/json',Authorization:`Bearer ${config.key||''}`};
        busy=true;controller=new AbortController();const pendingController=controller;
        const status=node('p','正在等待回应…'),cancel=node('button','取消回应');cancel.type='button';cancel.className='btn btn-secondary';cancel.onclick=()=>pendingController.abort();body.append(status,cancel);
        try{const response=await global.fetchAiResponse(config,{model:config.model,messages,max_tokens:700,stream:false},headers,endpoint,false,{signal:pendingController.signal});
            if(pendingController.signal.aborted)throw Error('回应已取消，存档未改变');
            if(!host?.isConnected||!current||current.id!==campaignId||(await CoC7.get(campaignId)).revision!==revision)throw Error('跑团已变化，本次回应未写入');
            const text=typeof response==='string'?response:response?.choices?.[0]?.message?.content||response?.content?.[0]?.text;
            if(!text?.trim()||text.length>4000)throw Error('回应为空或过长，未写入存档');
            await saveDialogue(text,roleId?'character':'kp',roleId?roleName(roleId):'主持人');await render();
        }finally{busy=false;controller=null;status.remove();cancel.remove();}
    }
    async function render(){
        if(!host?.isConnected)return;
        body.replaceChildren();title.textContent=current?.title||'我的跑团';
        if(!current){
            const intro=node('p','和伙伴一起，让故事发生。');intro.className='trpg-play-intro';body.append(intro,button('创建跑团',newCampaign),importButton());
            for(const campaign of await CoC7.list()){const row=button('',async()=>{current=await CoC7.get(campaign.id);tab='story';await render();});row.className='trpg-campaign-card';row.append(node('strong',campaign.title),node('span',`${campaign.cards.length} 位调查员 · ${campaign.events.length} 条记录`));body.append(row);}
            body.append(button('规则与自有资料',()=>tools('rules')),button('可选播报工具',()=>tools('broadcast')));return;
        }
        current=await CoC7.get(current.id);
        const nav=node('nav');nav.className='trpg-play-tabs';for(const [key,label] of [['story','剧情'],['free','闲聊'],['cards','调查员'],['notes','手记'],['settings','主持与存档']]){const el=button(label,async()=>{tab=key;await render();});el.setAttribute('aria-current',key===tab?'page':'false');nav.append(el);}body.append(nav);
        if(tab==='cards'){await cards();return;}
        if(tab==='notes'){
            const visible=CoC7Core.visibleStory(current,player);for(const item of visible){const card=node('article');card.className='trpg-player-card';card.append(node('small',({clue:'线索',npc:'人物',scene:'场景'})[item.kind]),node('h3',item.title),node('p',item.text));body.append(card);}if(!visible.length)body.append(node('p','随着调查推进，发现会记在这里。'));
            const world=TrpgStateCore.project(current.state||{},player);for(const relation of world.relationships){body.append(node('p',`${relation.from} → ${relation.to}：${relation.text}`));}return;
        }
        if(tab==='settings'){
            body.append(button('主持人：线索、NPC 与知情范围',()=>TrpgStateUI.open(current.id,async()=>{current=await CoC7.get(current.id);await render();})),button('记录主持人发言',async()=>{const answer=await showAppFormDialog({title:'主持人发言',fields:[{name:'text',label:'向玩家公开的叙述',type:'textarea',required:true}]});if(answer){await saveDialogue(answer.text,'kp','主持人');tab='story';await render();}}),button('规则与模组资料',()=>tools('rules')),button('可选播报工具',()=>tools('broadcast')),button('导出存档',async()=>{const url=URL.createObjectURL(new Blob([await CoC7.exportSave(current.id)],{type:'application/json'}));const a=node('a');a.href=url;a.download='mio-trpg.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}),importButton());return;
        }
        const log=node('div');log.className='trpg-play-log';
        for(const item of CoC7Core.visibleStory(current,player).filter(row=>row.kind==='scene')){const scene=node('article');scene.className='trpg-scene';scene.append(node('strong',item.title),node('p',item.text));log.append(scene);}
        if(current.events.length>visibleCount)log.append(button('查看更早记录',async()=>{visibleCount+=100;await render();}));
        for(const event of current.events.slice(-visibleCount)){
            if(event.kind==='dialogue'&&TrpgStateCore.visible(event.audience,player)){const bubble=node('article');bubble.className='trpg-dialogue '+event.speaker;bubble.append(node('small',event.name||event.speaker),node('p',event.content));log.append(bubble);}
            if(event.kind==='check'||event.kind==='dice')log.append(node('p',event.kind==='dice'?`掷骰：${event.roll.total}`:`检定：${event.roll.result} / ${event.check.target} · ${event.check.passed?'成功':'失败'}`));
        }
        body.append(log);const compose=node('form');compose.className='trpg-play-compose';const input=node('textarea');input.rows=2;input.maxLength=2000;input.placeholder=tab==='free'?'和伙伴聊聊…':'你准备做什么？';input.setAttribute('aria-label','剧情发言');
        const send=button('发送',async()=>{if(!input.value.trim())return;await saveDialogue(input.value);await render();});compose.onsubmit=event=>{event.preventDefault();send.click();};compose.append(input,send);body.append(compose);
        body.append(button(tab==='free'?'请主持人回应':'请主持人推进',()=>askKeeper(tab==='free'?'回应最近的谈话':'回应玩家最近的行动并给出选择')),
            button('掷骰',async()=>{const answer=await showAppFormDialog({title:'掷骰',fields:[{name:'expression',label:'骰子',value:'1D100',required:true}]});if(answer){await commit({kind:'dice',expression:answer.expression});await render();}}));
        for(const card of current.cards.filter(row=>row.characterId))body.append(button('听听'+card.name,()=>askKeeper('回应玩家最近的行动',card.characterId)));
    }
    async function open(){
        if(host?.isConnected){host.hidden=false;await render();return;}
        previous=document.activeElement;host=node('div');host.className='trpg-play-app';host.setAttribute('role','dialog');host.setAttribute('aria-modal','true');host.setAttribute('aria-label','跑团');const header=node('header');title=node('h2');
        const back=button('‹',async()=>{if(busy)return;if(current){current=null;await render();}else{host.remove();previous?.focus({preventScroll:true});}});back.setAttribute('aria-label','返回');
        header.append(back,title);body=node('main');host.append(header,body);document.body.append(host);
        host.addEventListener('keydown',event=>{
            if(event.key==='Escape'){event.preventDefault();controller?controller.abort():back.click();}
            if(event.key==='Tab'){
                const fields=[...host.querySelectorAll('button,textarea,input,select')].filter(el=>!el.disabled&&el.getClientRects().length);
                if(event.shiftKey&&document.activeElement===fields[0]){event.preventDefault();fields.at(-1)?.focus();}
                else if(!event.shiftKey&&document.activeElement===fields.at(-1)){event.preventDefault();fields[0]?.focus();}
            }
        });await render();back.focus();
    }
    global.TrpgPlayUI=Object.freeze({open});
})(window);
