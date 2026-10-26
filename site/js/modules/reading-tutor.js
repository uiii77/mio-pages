(function(global){
    'use strict';
    let dock,panel,controller,owner,observer;
    const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
    function close(){controller?.abort();panel?.remove();panel=null;owner=null;dock?.focus();}
    function setup(){
        const screen=document.getElementById('reading-screen');if(!screen||dock?.isConnected)return;
        dock=node('button','导师');dock.id='reading-tutor-dock';dock.className='reading-soft-action';Object.assign(dock.style,{position:'absolute',right:'16px',bottom:'calc(76px + env(safe-area-inset-bottom,0px))',zIndex:120,borderRadius:'18px',padding:'10px 16px',display:'none'});
        dock.onpointerdown=()=>{void Reading.captureSelection({silent:true,focus:false,preserve:true});};dock.onclick=()=>open().catch(error=>showToast(ReadingTeachingUI.message(error)));screen.append(dock);
        observer=new MutationObserver(()=>{if(!screen.classList.contains('active'))close();});observer.observe(screen,{attributes:true,attributeFilter:['class']});
    }
    function sync(session){setup();if(!dock)return;const current=Reading.current();if(owner&&(owner.characterId!==current.characterId||owner.documentId!==current.documentId||!session.workspace?.tutor?.enabled))close();dock.style.display=session.workspace?.tutor?.enabled?'inline-flex':'none';}
    async function open(){
        const current=Reading.current();if(!current.characterId||!current.documentId)throw Error('请先打开读物');if(panel?.isConnected)return;
        const session=await Reading.getSession(current.characterId,current.documentId);if(!session.workspace?.tutor?.enabled)throw Error('请先在阅读玩法中启用浮动导师');
        owner=current;const screen=document.getElementById('reading-screen');panel=node('section');panel.id='reading-tutor-panel';panel.className='reading-sheet';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','浮动导师');
        Object.assign(panel.style,{position:'absolute',right:'12px',bottom:'calc(76px + env(safe-area-inset-bottom,0px))',width:'min(360px,calc(100% - 24px))',maxHeight:'65dvh',overflowY:'auto',boxSizing:'border-box',padding:'16px',zIndex:140,borderRadius:'18px',boxShadow:'0 8px 32px #0002',background:'var(--mio-surface,#fff)',color:'var(--text-color,#333)'});
        const heading=node('strong','浮动导师 · 当前阅读角色'),status=node('p');status.setAttribute('role','status');const output=node('div');Object.assign(output.style,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',lineHeight:'1.7'});
        const label=node('label','学习问题'),question=node('textarea');question.rows=2;question.maxLength=2000;Object.assign(question.style,{width:'100%',boxSizing:'border-box',font:'inherit',border:'1px solid var(--border-color,#ddd)',borderRadius:'10px',padding:'8px'});label.append(question);
        const scope=node('select');scope.setAttribute('aria-label','导师学习范围');for(const [id,title] of [['auto','选中文字 / 当前页'],['paragraph','当前段落'],['page','当前页'],['selection','当前选区'],['chapter','本章']]){const option=node('option',title);option.value=id;scope.append(option);}scope.value=session.workspace.tutor.scope;
        const ask=node('button','请导师回答');ask.className='reading-soft-action';
        ask.onclick=async()=>{if(controller)return;controller=new AbortController();ask.disabled=true;try{const latest=await Reading.getSession(current.characterId,current.documentId);status.textContent='正在准备授权材料…';const result=await ReadingPlay.run({characterId:current.characterId,documentId:current.documentId,kind:'tutor',idempotencyKey:crypto.randomUUID(),question:question.value,scope:scope.value,style:latest.workspace.tutor.style,anchor:Reading.selectedAnchor(),mode:latest.workspace.mode,unit:latest.workspace.unit,advancePolicy:latest.workspace.advancePolicy,expectedSettingsVersion:latest.workspace.version,expectedPositionVersion:latest.positionVersion},{signal:controller.signal,onProgress:count=>status.textContent='正在处理学习步骤 '+count+'…'});output.textContent=result.content;status.textContent='已保存至学习记录；阅读位置未改变。';}catch(error){status.textContent=controller?.signal.aborted?'已停止，原记录保留。':ReadingTeachingUI.message(error);}finally{controller=null;ask.disabled=false;}};
        const stop=node('button','停止');stop.className='reading-soft-action';stop.onclick=()=>controller?.abort();const hide=node('button','收起');hide.className='reading-soft-action';hide.onclick=close;
        panel.append(heading,node('p','只使用所选范围；关联跑团时仍受角色知识权限限制。'),scope,label,ask,stop,hide,status,output);screen.append(panel);question.focus();panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
    }
    global.ReadingTutor=Object.freeze({setup,sync,open,close});
})(window);
