(function(global) {
    'use strict';
    const $=id=>document.getElementById(id);
    const editors=new Map();
    const modelPickers=new Map(), modelNames=new Map();
    const registry=()=>global.FeatureApiRegistry;
    const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;};
    const providers=[['newapi','OpenAI 兼容 / 自定义'],['deepseek','DeepSeek'],['claude','Claude'],['gemini','Gemini'],['openai-noauth','本地免密接口']];
    const row=(label,control)=>{const el=node('div',null,'kkt-item');el.append(node('div',label,'kkt-item-label'));const box=node('div',null,'kkt-item-control');box.append(control);el.append(box);return el;};
    const button=(label,action)=>{const el=node('button',label,'btn btn-small btn-secondary');el.type='button';el.onclick=async()=>{try{await action();}catch(error){showToast(error.message||'操作未完成');}};return el;};
    function modelUrl(config) {
        const url=new URL(config.url||config.baseUrl);
        if(!['http:','https:'].includes(url.protocol))throw Error('请填写有效的 API 地址');
        if((typeof BLOCKED_API_DOMAINS==='undefined'?[]:BLOCKED_API_DOMAINS).some(domain=>url.href.includes(domain)))throw Error('此服务地址不可使用');
        url.search='';url.hash='';
        let pathname=url.pathname.replace(/\/+$/,'').replace(/\/(?:chat\/completions|messages|responses|embeddings|rerank|models)(?:\/.*)?$/,'');
        const gemini=config.provider==='gemini'||config.protocol==='gemini';
        if(gemini)pathname=pathname.replace(/\/v1(?:beta)?$/,'')+'/v1beta/models';
        else pathname=pathname+(/\/v\d+(?:beta)?$/.test(pathname)?'':'/v1')+'/models';
        url.pathname=pathname;
        if(gemini&&config.key)url.searchParams.set('key',typeof getRandomValue==='function'?getRandomValue(config.key):config.key);
        return url;
    }
    async function fetchModels(config,{signal,kind='llm'}={}) {
        const provider=config.provider||config.protocol||'newapi',key=config.key||config.apiKey||'';
        if(!key&&!['openai-noauth','ollama'].includes(provider)&&!['none','custom'].includes(config.authMode))throw Error('请填写密钥，或选择本地免密接口');
        const headers={...(provider==='claude'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:provider==='gemini'||!key||['none','custom'].includes(config.authMode)?{}:{Authorization:'Bearer '+(typeof getRandomValue==='function'?getRandomValue(key):key)}),...(config.customHeaders||{})};
        const timeout=new AbortController(),cancel=()=>timeout.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
        const timer=setTimeout(cancel,20000);
        try {
            const response=await fetch(modelUrl({...config,key}),{headers,signal:timeout.signal});
            if(!response.ok)throw Error('模型拉取失败（HTTP '+response.status+'），请核对服务地址、权限及网络');
            const data=await response.json();
            const rows=data.data||data.models;
            if(!Array.isArray(rows))throw Error('服务未返回可识别的模型列表');
            for(const item of rows)if(item&&typeof item==='object'){const id=String(item.id||item.name||item.model||'').replace(/^models\//,'');modelNames.set(id,item.display_name||item.displayName||item.name||id);}
            const models=[...new Set(rows.filter(item=>provider!=='gemini'||!item.supportedGenerationMethods||item.supportedGenerationMethods.includes(kind==='embedding'?'embedContent':'generateContent')).map(item=>typeof item==='string'?item:item.id||item.name||item.model).filter(Boolean).map(id=>String(id).replace(/^models\//,'')))];
            if(!models.length)throw Error('服务没有返回可用模型，已保留原选择');
            return models;
        } catch(error) { if(error.name==='AbortError')throw Error('模型拉取已取消或超时，已保留原选择');throw error; }
        finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    }
    function setModel(select,value) {if(value&&!Array.from(select.options).some(o=>o.value===value))select.add(new Option(value,value));select.value=value||'';modelPickers.get(select)?.refresh();}
    function labelOverride(enabled,text) {
        const title=enabled.closest('.kkt-item')?.querySelector('.kkt-item-label');if(title){title.textContent=text;return;}
        const label=enabled.closest('label');if(!label)return;
        const caption=Array.from(label.childNodes).find(n=>n.nodeType===3&&n.textContent.trim());
        if(caption)caption.textContent=' '+text;
        else {const span=label.querySelector('span:not(.kkt-slider)');if(span)span.textContent=text;else label.append(document.createTextNode(' '+text));}
    }
    function presetOptions(select) {
        const current=select.value;select.replaceChildren(new Option('选择共享预设',''));
        for(const preset of registry().listPresets(db))select.add(new Option(preset.name,preset.ref));
        select.value=current;
    }
    async function persistPresets(store,rows) {
        const before=db[store];db[store]=rows;
        try{if(await saveGlobalSettings([store])===false)throw Error('预设保存失败');}
        catch(error){db[store]=before;throw error;}
        global.populateApiSelect?.();for(const editor of editors.values())presetOptions(editor.presets);
    }
    async function savePreset(config) {
        const answer=await showAppFormDialog({title:'保存 API 预设',fields:[{name:'name',label:'名称',required:true}]});if(!answer)return;
        if(!registry().ready(config))throw Error('请先填写地址、密钥和模型');
        const rows=structuredClone(db.apiPresets||[]);rows.push({id:crypto.randomUUID(),name:answer.name.trim(),data:{...config,apiUrl:config.url,apiKey:config.key}});await persistPresets('apiPresets',rows);
    }
    async function importPresets(file) {
        if(!file)return;if(file.size>2*1024*1024)throw Error('预设文件不能超过 2 MB');
        const rows=JSON.parse(await file.text());if(!Array.isArray(rows)||rows.length>200)throw Error('预设格式不正确');
        const next=structuredClone(db.apiPresets||[]);
        for(const p of rows){
            if(!p?.name||!p.data||typeof p.data!=='object'||Array.isArray(p.data)||typeof p.name!=='string'||p.name.length>200)throw Error('预设缺少有效名称或配置');
            const d=p.data;if(!['newapi','deepseek','claude','gemini','openai-noauth'].includes(d.provider||'newapi'))throw Error('仅支持聊天 API 预设');
            if(d.service&&d.service!=='llm')throw Error('此预设不属于聊天接口，请在对应服务中导入');
            for(const key of ['apiUrl','url','apiKey','key','model'])if(d[key]!=null&&typeof d[key]!=='string')throw Error('预设字段必须为文字');
            if(!next.some(old=>old.name===p.name&&JSON.stringify(old.data)===JSON.stringify(d)))next.push({id:crypto.randomUUID(),name:p.name,data:structuredClone(d)});
        }
        await persistPresets('apiPresets',next);
    }
    function chooseImport() {
        const input=node('input');input.type='file';input.accept='.json';
        input.onchange=async()=>{try{await importPresets(input.files?.[0]);showToast('预设已合并，原配置保留');}catch(error){showToast(error.message);}};input.click();
    }
    function exportPresets() {
        const data=registry().listPresets(db).map(p=>({name:p.name,data:{...p.config,apiUrl:p.config.url,apiKey:p.config.key}}));
        const link=document.createElement('a'),blob=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));link.href=blob;link.download='mio-api-presets.json';link.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);
    }
    async function managePresets() {
        const choices=registry().listPresets(db);if(!choices.length){showToast('还没有保存预设');return;}
        const answer=await showAppFormDialog({title:'管理 API 预设',fields:[{name:'ref',label:'预设',type:'select',value:choices[0].ref,options:choices.map(p=>({value:p.ref,label:p.name}))},{name:'action',label:'操作',type:'select',value:'rename',options:[{value:'rename',label:'重命名'},{value:'delete',label:'删除'}]},{name:'name',label:'新名称（重命名时填写）'}]});if(!answer)return;
        const selected=choices.find(p=>p.ref===answer.ref);if(!selected)return;
        const rows=structuredClone(db[selected.store]||[]),index=rows.findIndex(p=>selected.store+':'+(p.id||p.name)===selected.ref);
        if(index<0)return;
        if(answer.action==='delete') {if(await showAppConfirmDialog({title:'删除预设',message:'删除“'+selected.name+'”？使用它的功能会恢复继承。',confirmText:'删除'})!=='confirm')return;rows.splice(index,1);}
        else {if(!answer.name.trim())throw Error('请填写新名称');rows[index].id ||= rows[index].name;rows[index].name=answer.name.trim();}
        await persistPresets(selected.store,rows);
    }
    function bindEditor(prefix,{feature,legacyKey,enabled,host}) {
        if(editors.has(prefix))return editors.get(prefix);
        const url=$(prefix+'-url'),key=$(prefix+'-key'),oldModel=$(prefix+'-model');if(!url||!key||!oldModel)return null;
        const kind=registry().independentDefinitions()[feature]?.kind||'llm';
        const model=oldModel.tagName==='SELECT'?oldModel:node('select');
        if(model!==oldModel){model.id=oldModel.id;setModel(model,oldModel.value);oldModel.replaceWith(model);}
        let provider=$(prefix+'-provider');
        if(!provider){provider=node('select');provider.id=prefix+'-provider';for(const [value,label] of providers)provider.add(new Option(label,value));}
        const parent=host||url.closest('.api-section-card')||url.closest('.kkt-group')||url.closest('label')?.parentElement||url.parentElement;
        const advanced=node('section',null,'mio-api-advanced');advanced.hidden=true;
        const current=node('span',null,'mio-api-source');
        const expand=button('高级设置',()=>{advanced.hidden=!advanced.hidden;expand.setAttribute('aria-expanded',String(!advanced.hidden));});expand.setAttribute('aria-expanded','false');
        const stateRow=row('',current);stateRow.classList.add('mio-api-state');stateRow.querySelector('.kkt-item-label').append(current);stateRow.querySelector('.kkt-item-control').append(expand);
        const enabledRow=enabled?.closest('.kkt-item')||enabled?.closest('label')||null;
        (enabledRow||url.closest('.kkt-item')||parent.firstChild).after(stateRow,advanced);
        const move=el=>{if(!el)return;let holder=el.closest('.kkt-item')||el.closest('label');if(!holder)holder=row(el===url?'API 地址':el===key?'密钥':el===model?'模型':'服务商',el);if(!advanced.contains(holder))advanced.append(holder);};
        if(provider.isConnected)move(provider);else advanced.append(row('服务商',provider));move(url);move(key);move(model);
        const fetchButton=button('拉取模型',async()=>{
            if(editor.controller){editor.controller.abort();return;}
            const snapshot=JSON.stringify(read());editor.controller=new AbortController();fetchButton.textContent='取消拉取';status.textContent='正在拉取模型…';
            try{const models=await fetchModels(read(),{signal:editor.controller.signal});if(snapshot!==JSON.stringify(read())){status.textContent='配置已变化，请重新拉取';return;}editor.models=models;renderModels();status.textContent='已拉取 '+models.length+' 个模型';}
            catch(error){status.textContent=error.message;}
            finally{editor.controller=null;fetchButton.textContent='拉取';}
        });fetchButton.textContent='拉取';searchModels(model);modelPickers.get(model).trigger.after(fetchButton);
        const presets=node('select');presets.setAttribute('aria-label','共享 API 预设');presetOptions(presets);
        const toolbar=node('div',null,'api-sub-presets-strip mio-api-presets');toolbar.append(presets,
            button('应用',()=>{const preset=registry().presetConfig(presets.value,db);if(!preset)throw Error('请选择预设');fill(preset);editor.presetRef=presets.value;if(enabled)enabled.checked=true;status.textContent='预设已应用，保存后生效';}),
            button('另存',async()=>{await savePreset(read());status.textContent='预设操作已完成';}),
            button('更多',presetMore));
        const status=node('p',null,'api-field-tip');status.setAttribute('role','status');status.setAttribute('aria-live','polite');advanced.append(toolbar,status);
        if(kind!=='llm') {toolbar.hidden=true;for(const option of Array.from(provider.options))if(!['newapi','openai-noauth'].includes(option.value))option.remove();}
        const fallback=$(prefix+'-fallback');if(fallback)fallback.closest('.kkt-item').hidden=true;
        let models=Array.from(model.options).map(o=>o.value).filter(Boolean);
        let savedConfig={};
        function read(){return {...savedConfig,provider:provider.value||'newapi',authMode:provider.value==='openai-noauth'?'none':savedConfig.provider==='openai-noauth'&&provider.value!=='openai-noauth'?'bearer':savedConfig.authMode,url:url.value.trim(),baseUrl:url.value.trim(),key:key.value.trim(),apiKey:key.value.trim(),model:model.value,service:kind,...($(prefix+'-stream')?{streamEnabled:$(prefix+'-stream').checked}: {})};}
        function fill(config){savedConfig=structuredClone(config);const value=config.provider||'newapi';if(!Array.from(provider.options).some(o=>o.value===value))provider.add(new Option(value,value));provider.value=value;url.value=config.url||config.baseUrl||config.apiUrl||'';key.value=config.key||config.apiKey||'';setModel(model,config.model||'');models=Array.from(model.options).map(o=>o.value).filter(Boolean);}
        function renderModels(){const selected=model.value,list=editor.models||models;model.replaceChildren();for(const value of [...new Set([selected,...list])].filter(Boolean))model.add(new Option(modelNames.get(value)||value,value));setModel(model,selected);}

        const editor={prefix,feature,legacyKey,enabled,model,provider,presets,status,current,advanced,read,fill,presetRef:'',refresh:()=>{const result=feature?registry().resolve(feature,{context:editor.owner}):null;current.textContent=feature?registry().sourceLabel(result):enabled?.checked?'功能专属配置':'继承主 API';}};
        for(const el of [provider,url,key,model])el.addEventListener('change',()=>{editor.presetRef='';editor.controller?.abort();if(el===provider)savedConfig.apiProtocol=apiProviderToGenerationProtocol(provider.value);});
        enabled?.addEventListener('change',()=>{current.textContent=enabled.checked?'专属设置保存后生效':'继承主 API';});
        editors.set(prefix,editor);return editor;
    }
    function mount(feature,prefix,configId) {
        const enabled=$(prefix+'-enabled');const editor=bindEditor(prefix,{feature,enabled});if(!editor)return;
        const route=registry().readRegistry(db).routes[feature]||{},config=registry().presetConfig(route.presetRef,db)||registry().readRegistry(db).configs[route.configId]||{};
        editor.fill(config);enabled.checked=route.enabled===true;editor.presetRef=route.presetRef||'';editor.presets.value=editor.presetRef;
        const description=$(prefix+'-section')?.querySelector('.api-card-desc');if(description&&['schedule','emotion'].includes(feature))description.textContent='功能开启后默认继承主 API，需要时可选择预设或单独覆盖。';
        if(['schedule','emotion'].includes(feature)&&$(prefix+'-status'))$(prefix+'-status').textContent='关闭专属配置会恢复继承，原配置保留。';
        labelOverride(enabled,'使用专属 '+registry().independentDefinitions()[feature].label+' API');
        editor.saveRegistry=current=>{
            const previous=current.routes[feature]||{};
            if(enabled.checked&&!editor.presetRef){const config={...current.configs[previous.configId||configId],...editor.read(),id:previous.configId||configId,feature,enabled:true};if(config.url||config.key||config.model)current=registry().upsertConfig(current,config,config.id);}
            return registry().setRoute(current,feature,{...previous,enabled:enabled.checked,configId:previous.configId||configId,presetRef:editor.presetRef,fallbackMode:registry().independentDefinitions()[feature].kind==='llm'?'main':'none'});
        };editor.refresh();return editor;
    }
    function mountLegacy(prefix,dbKey) {
        const apiPrefix=prefix+'-api',url=$(apiPrefix+'-url');if(!url)return;
        const host=url.closest('.api-section-card')||url.closest('.kkt-group');const enabled=node('input');enabled.type='checkbox';enabled.checked=db[dbKey]?.enabled!==false&&registry().ready(db[dbKey]);
        const toggle=node('label',null,'kkt-switch');toggle.append(enabled,node('span',null,'kkt-slider'));host.querySelector('.api-card-header')?.after(row('使用专属 API',toggle));
        $(prefix+'-fetch-models-btn')?.setAttribute('hidden','');$(apiPrefix+'-presets-control')?.setAttribute('hidden','');
        const editor=bindEditor(apiPrefix,{legacyKey:dbKey,enabled,host});editor.fill(db[dbKey]||{});
        $(apiPrefix+'-save-btn').onclick=async()=>{const before=db[dbKey];const config=editor.read();db[dbKey]=enabled.checked?{...before,...config,enabled:true}:{...before,enabled:false};if(await saveGlobalSettings([dbKey])===false){db[dbKey]=before;editor.status.textContent='保存失败，原设置已保留';return;}editor.refresh();editor.status.textContent='设置已保存';};editor.refresh();return editor;
    }
    function saveRegistryFeature(current,feature,prefix,configId) {return (editors.get(prefix)||mount(feature,prefix,configId))?.saveRegistry(current)||current;}
    async function persistRegistry(next) {
        const before=db.apiFeatureRegistry;db.apiFeatureRegistry=next;
        try{if(await saveGlobalSettings(['apiFeatureRegistry'])===false)throw Error('API 设置未保存');}
        catch(error){db.apiFeatureRegistry=before;throw error;}
        for(const editor of editors.values())editor.refresh();
    }
    function mountRole(feature,prefix,owner) {
        if(!owner)return;
        const editor=bindEditor(prefix,{feature,enabled:$(prefix+'-enabled')});if(!editor)return;
        editor.owner=owner;
        labelOverride(editor.enabled,'使用角色专属 API');
        const binding=owner.featureApiBindings?.[feature]||owner.apiFeatureBindings?.[feature]||{};
        editor.fill(registry().presetConfig(binding.presetRef,db)||registry().readRegistry(db).configs[binding.configId]||{});
        editor.presetRef=binding.presetRef||'';editor.presets.value=editor.presetRef;editor.enabled.checked=binding.enabled===true;editor.refresh();return editor;
    }
    async function saveRole(feature,prefix,owner,configId) {
        const editor=editors.get(prefix)||mountRole(feature,prefix,owner);if(!editor||editor.owner!==owner)throw Error('角色已切换，请重新打开设置');
        const before=structuredClone(owner.featureApiBindings||{}),previous=before[feature]||{},id=configId;
        const beforeRegistry=db.apiFeatureRegistry;
        let next=registry().readRegistry(db);
        if(editor.enabled.checked&&!editor.presetRef){const config={...next.configs[previous.configId||id],...editor.read(),feature,enabled:true,id};if(config.url||config.key||config.model)next=registry().upsertConfig(next,config,id);}
        await persistRegistry(next);
        owner.featureApiBindings={...before,[feature]:{...previous,enabled:editor.enabled.checked,configId:id,presetRef:editor.presetRef,fallbackMode:'main'}};
        try{if(await saveCharacter(owner.id)===false)throw Error('角色 API 设置未保存');}catch(error){owner.featureApiBindings=before;if(db.apiFeatureRegistry===next)await persistRegistry(beforeRegistry);throw error;}
        editor.refresh();editor.status.textContent='设置已保存';
    }
    async function presetMore() {
        const choice=await showAppFormDialog({title:'预设操作',fields:[{name:'action',label:'操作',type:'select',options:[{value:'manage',label:'管理预设'},{value:'import',label:'导入预设'},{value:'export',label:'导出预设'}]}],confirmText:'继续'});
        if(choice?.action==='manage')return managePresets();if(choice?.action==='import')return chooseImport();if(choice?.action==='export')return exportPresets();
    }
    function searchModels(select) {
        if(!select||modelPickers.has(select))return;
        select.hidden=true;
        const trigger=button('选择模型',()=>{if(select.id==='api-node-model-results')setModel(select,$('api-node-model').value);return openModelPicker(select);});trigger.className='mio-model-trigger';trigger.setAttribute('aria-haspopup','dialog');
        select.after(trigger);
        const refresh=()=>{const text=select.id==='api-node-model-results'?$('api-node-model').value||'选择模型':select.selectedOptions[0]?.textContent||select.value||'选择模型';if(trigger.textContent!==text)trigger.textContent=text;trigger.disabled=select.disabled;};
        select.addEventListener('change',refresh);modelPickers.set(select,{trigger,refresh});refresh();
    }
    async function openModelPicker(select) {
        const promise=showAppFormDialog({title:'选择模型',fields:[{name:'query',label:'搜索名称或 ID',type:'search',placeholder:'输入部分关键词'},{name:'manual',label:'模型 ID',value:select.value,maxLength:512}],confirmText:'完成'});
        const overlay=$('app-form-dialog');if(!overlay)return;overlay.classList.add('mio-model-dialog');
        const form=overlay.querySelector('form'),query=form.querySelector('[name=query]'),manual=form.querySelector('[name=manual]');
        const list=node('div',null,'mio-model-results');list.setAttribute('role','listbox');list.setAttribute('aria-label','模型');
        const manualRow=manual.closest('label');manualRow.hidden=true;
        const fallback=button('手动指定模型',()=>{manualRow.hidden=!manualRow.hidden;if(!manualRow.hidden)manual.focus();});fallback.className='mio-model-manual';
        manualRow.before(list,fallback);
        const render=()=>{
            const filter=query.value.trim().toLocaleLowerCase();
            const options=Array.from(select.options).filter(o=>o.value&&(`${o.value} ${o.textContent} ${modelNames.get(o.value)||''}`).toLocaleLowerCase().includes(filter));
            list.replaceChildren();
            if(!options.length){list.append(node('p','没有匹配的模型','api-field-tip'));return;}
            for(const option of options){const item=button(modelNames.get(option.value)||option.textContent,()=>{setModel(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));form.querySelector('.app-confirm-dialog-actions button[type=button]').click();});item.className='mio-model-option';item.setAttribute('role','option');item.setAttribute('aria-selected',String(select.value===option.value));if(item.textContent!==option.value)item.append(node('small',option.value));list.append(item);}
        };
        // The underlying select is never filtered, so searching cannot change the saved model.
        query.oninput=render;render();
        const observer=new MutationObserver(render);observer.observe(select,{childList:true,subtree:true});
        const result=await promise;observer.disconnect();
        if(result&&!manualRow.hidden&&result.manual.trim()){setModel(select,result.manual.trim());select.dispatchEvent(new Event('change',{bubbles:true}));}
        modelPickers.get(select)?.refresh();
    }
    document.addEventListener('DOMContentLoaded',()=>{
        const nodeModel=$('api-node-model'),nodeResults=$('api-node-model-results');
        if(nodeModel&&nodeResults){
            nodeModel.hidden=true;nodeModel.type='hidden';nodeModel.after(nodeResults);
            nodeModel.form?.addEventListener('submit',event=>{if(!nodeModel.value.trim()){event.preventDefault();event.stopImmediatePropagation();showToast('请先选择模型');modelPickers.get(nodeResults)?.trigger.click();}},true);
        }
        let scheduled=false;
        const refreshPickers=()=>{scheduled=false;document.querySelectorAll('select[id*="model"]').forEach(searchModels);for(const picker of modelPickers.values())picker.refresh();};
        const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(refreshPickers);}});
        observer.observe(document.body,{childList:true,subtree:true});document.addEventListener('change',refreshPickers);refreshPickers();
        for(const strip of document.querySelectorAll('[id$="presets-control"]')){
            const low=Array.from(strip.querySelectorAll('button')).filter(b=>/管理|导入|导出/.test(b.textContent));
            if(!low.length)continue;low.forEach(b=>b.hidden=true);
            strip.append(button('更多',async()=>{const choice=await showAppFormDialog({title:'预设操作',fields:[{name:'action',label:'操作',type:'select',options:low.map((b,i)=>({value:String(i),label:b.textContent.trim()}))}],confirmText:'继续'});if(choice)low[Number(choice.action)]?.click();}));
        }
    });
    function refresh(){for(const editor of editors.values())editor.refresh();}
    global.FeatureApiSettings={mount,mountLegacy,mountRole,saveRole,saveRegistryFeature,persistRegistry,fetchModels,modelUrl,editors,managePresets,savePreset,importPresets,chooseImport,exportPresets,searchModels,openModelPicker,refresh};
})(window);
