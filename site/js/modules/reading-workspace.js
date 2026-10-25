(function(global){
    'use strict';
    const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
    async function open(){
        const current=Reading.current();if(!current.characterId||!current.documentId){showToast('请先打开一个角色的读物');return;}
        if(document.getElementById('reading-workspace-dialog'))return;
        const previous=document.activeElement,overlay=node('div');overlay.className='modal-overlay visible';overlay.id='reading-workspace-dialog';
        const panel=node('div');panel.className='modal-window';Object.assign(panel.style,{width:'min(500px,calc(100vw - 24px))',maxHeight:'85dvh',overflowY:'auto',boxSizing:'border-box'});panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','阅读玩法与知识');overlay.append(panel);
        const status=node('p');status.setAttribute('role','status');let teaching=null;
        const closeWorkspace=()=>{controller?.abort();teaching?.dispose();overlay.remove();previous?.focus();};
        function button(title,task){const el=node('button',title);el.className='btn btn-secondary';el.onclick=async()=>{el.disabled=true;try{await task();}catch(error){status.textContent=({REQUEST_BUSY:'当前已有请求，请等待或取消。',READING_CHANGED:'阅读位置或玩法已变化，请重新发起请求。',REQUEST_CANCELLED:'请求已取消，位置未推进。',CAMPAIGN_REQUIRED:'请先关联此角色参与的跑团。',IDEMPOTENCY_CONFLICT:'原请求内容已变化，请重新发起。'})[error.code]||error.message;}finally{el.disabled=false;}};return el;}
        panel.append(node('h3','阅读玩法与知识'),node('p','选择与你一起阅读的角色和故事。'));
        const select=node('select');select.setAttribute('aria-label','关联跑团');select.style.maxWidth='100%';
        const session=await Reading.getSession(current.characterId,current.documentId),campaigns=(await CoC7.list()).filter(row=>row.cards.some(card=>card.characterId===current.characterId));
        for(const campaign of campaigns){const option=node('option',campaign.title);option.value=campaign.id;select.append(option);}select.value=session.trpgCampaignId||campaigns[0]?.id||'';
        panel.append(select,button('关联所选跑团',async()=>{await Reading.bindCampaign(current.characterId,current.documentId,select.value);status.textContent='已关联，可以继续阅读。';}),button('打开故事手记',async()=>{const id=select.value;if(!id)throw Error('请先选择跑团');closeWorkspace();await TrpgStateUI.open(id);}),button('创建此角色的独立跑团',async()=>{let campaign=await CoC7.create('阅读跑团');campaign=await CoC7.dispatch(campaign.id,{id:crypto.randomUUID(),kind:'card',card:{id:crypto.randomUUID(),characterId:current.characterId,name:(db.characters||[]).find(row=>String(row.id)===current.characterId)?.realName||'调查员'}},campaign.revision);await Reading.bindCampaign(current.characterId,current.documentId,campaign.id);closeWorkspace();await open();}));
        const play=node('section');play.dataset.readingPlay='true';play.append(node('h4','玩法与推进'));
        function choose(label,values,value){const wrap=node('label',label);wrap.className='trpg-broadcast-field';const field=node('select');for(const [id,title] of values){const option=node('option',title);option.value=id;field.append(option);}field.value=value;wrap.append(field);play.append(wrap);return field;}
        const settings=ReadingPlayCore.settings(session.workspace),mode=choose('当前玩法',[['reading','共同阅读'],['trpg','TRPG 角色回应'],['free-chat','自由聊天（不自动推进）']],settings.mode),policy=choose('推进时机',[['manual','手动推进'],['after_reply','角色回应成功后推进']],settings.advancePolicy),unit=choose('推进范围',[['paragraph','逐段'],['chapter','逐章']],settings.unit);
        let currentSettings=settings,controller=null,historyOffset=0;
        const questionLabel=node('label','本次问题 / 玩家行动');questionLabel.className='trpg-broadcast-field';const question=node('textarea');question.rows=3;question.maxLength=2000;questionLabel.append(question);play.append(questionLabel);
        const history=node('div');history.setAttribute('aria-live','polite');
        async function saveSettings(){if(mode.value!==currentSettings.mode||policy.value!==currentSettings.advancePolicy||unit.value!==currentSettings.unit)currentSettings=await Reading.configureWorkspace(current.characterId,current.documentId,{mode:mode.value,advancePolicy:policy.value,unit:unit.value},currentSettings.version);}
        async function renderHistory(clear=true){
            if(clear){history.replaceChildren();historyOffset=0;}const rows=await ReadingPlay.list(current.characterId,current.documentId,{offset:historyOffset,limit:30,kinds:['interaction','advance']});
            for(const row of rows){const article=node('article');article.style.padding='12px 0';article.append(node('p',({pending:'请求中',complete:'已完成',failed:'失败，未推进',cancelled:'已取消，未推进',interrupted:'中断，待人工重试'}[row.status]||row.status)+' · '+new Date(row.createdAt).toLocaleString()),node('p',row.request?.question||''));const text=node('p',row.content||(row.kind==='advance'?'已保存推进结果':''));text.style.whiteSpace='pre-wrap';text.style.overflowWrap='anywhere';article.append(text);
                if(['failed','interrupted','cancelled'].includes(row.status)&&row.request)article.append(button('重试原请求',async()=>{if(controller)throw Error('当前已有请求，请完成或取消后继续');controller=new AbortController();try{await ReadingPlay.retry(row.id,{signal:controller.signal});await Reading.refresh();await renderHistory();}finally{controller=null;}}));
                if(row.status==='pending')article.append(button('取消此请求',async()=>{await ReadingPlay.cancel(row.id);await renderHistory();}));history.append(article);}
            if(rows.length===30){const more=button('加载更早记录',async()=>{more.remove();historyOffset+=30;await renderHistory(false);});history.append(more);}
        }
        async function request(kind,count=1){
            if(controller)throw Error('当前已有请求，请完成或取消后继续');controller=new AbortController();
            try{await saveSettings();for(let step=0;step<count;step++){
                if(controller.signal.aborted||step>0&&document.visibilityState!=='visible')break;
                const latest=await Reading.getSession(current.characterId,current.documentId);status.textContent='正在处理第 '+(step+1)+' 次请求…';
                const result=await ReadingPlay.run({characterId:current.characterId,documentId:current.documentId,idempotencyKey:crypto.randomUUID(),kind,question:step? '继续回应当前获准内容。':question.value,mode:currentSettings.mode,unit:currentSettings.unit,advancePolicy:currentSettings.advancePolicy,expectedSettingsVersion:currentSettings.version,expectedPositionVersion:latest.positionVersion},{signal:controller.signal});
                await Reading.refresh();await renderHistory();status.textContent=result.moved?'回应已保存，阅读位置已推进。':result.atEnd?'已到范围末尾，结果已保存。':'结果已保存，阅读位置保持不变。';if(result.atEnd||!result.moved)break;
            }}finally{controller=null;await renderHistory();}
        }
        const respond=button('角色回应',()=>request('interaction')),advance=button('手动推进阅读位置',()=>request('advance')),continuous=button('连续回应并推进（最多 3 次）',()=>request('interaction',3));
        const updateButtons=()=>{const free=mode.value==='free-chat';advance.disabled=free;continuous.disabled=free||policy.value==='manual';policy.disabled=free;respond.textContent=free?'自由回应':'角色回应';};mode.onchange=updateButtons;policy.onchange=updateButtons;updateButtons();
        const actions=node('div');actions.className='reading-play-actions';respond.className='btn btn-primary';actions.append(respond,advance);
        const extra=node('div');extra.className='reading-play-extra';extra.hidden=true;extra.append(continuous,button('停止当前请求',()=>{controller?.abort();status.textContent='已停止，阅读进度已保留。';}));
        const settingsActions=node('div');settingsActions.className='reading-play-settings-actions';settingsActions.append(button('保存玩法',async()=>{await saveSettings();status.textContent='玩法已保存。';}),button('更多推进选项',async()=>{extra.hidden=!extra.hidden;}));
        play.append(settingsActions,actions,extra,history);
        const story=node('section');while(panel.children.length>1)story.append(panel.children[1]);panel.append(story,play);teaching=ReadingTeachingUI.attach(panel,current,status,closeWorkspace);const nav=node('nav');nav.className='reading-workspace-tabs';const learning=panel.querySelector('[data-reading-teaching]');for(const [label,section] of [['故事',story],['推进',play],['学习',learning]]){const tab=button(label,async()=>{for(const target of [story,play,learning])target.hidden=target!==section;for(const item of nav.children)item.setAttribute('aria-current',item===tab?'page':'false');});tab.setAttribute('aria-current',label==='推进'?'page':'false');nav.append(tab);}panel.children[0].after(nav);story.hidden=true;learning.hidden=true;panel.append(status,button('完成',closeWorkspace));document.body.append(overlay);await renderHistory();

        panel.addEventListener('keydown',event=>{if(event.key==='Escape'){closeWorkspace();}if(event.key==='Tab'){const fields=[...panel.querySelectorAll('button,select,input,textarea')].filter(el=>!el.disabled&&el.getClientRects().length);if(event.shiftKey&&document.activeElement===fields[0]){event.preventDefault();fields.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===fields.at(-1)){event.preventDefault();fields[0].focus();}}});
        nav.querySelector('button')?.focus();
    }
    function setup(){const parent=document.querySelector('[data-reading-sheet-overlay="more"] .reading-sheet');if(!parent||parent.querySelector('[data-reading-workspace]'))return;const button=node('button','阅读玩法与知识');button.className='reading-soft-action';button.dataset.readingWorkspace='true';button.onclick=()=>open().catch(error=>showToast(error.message));parent.append(button);}
    global.ReadingWorkspace=Object.freeze({setup,open});
})(window);
