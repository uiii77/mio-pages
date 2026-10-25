(function(global){
    'use strict';
    let dialog;
    const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
    const errors={INVALID_BARCODE:'请填写有效的商品条码。',PRODUCT_NOT_FOUND:'暂未找到这个商品，可以导入你有授权的资料。',SOURCE_RATE_LIMITED:'查询较频繁，请稍后再试。',SOURCE_BUSY:'上一条查询尚未结束。',SOURCE_INCOMPLETE:'来源返回了不完整结果，原资料已保留。',SOURCE_UNAVAILABLE:'来源暂时无法连接，已保存的资料仍可浏览。',INVALID_SOURCE:'资料或来源声明不完整，未导入。'};
    async function open(options={}){
        if(dialog?.isConnected)return;
        const previous=document.activeElement,overlay=node('div');overlay.id='catalog-source-dialog';overlay.className='modal-overlay visible';overlay.style.zIndex='24000';dialog=overlay;
        const panel=node('div');panel.className='modal-window catalog-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','商品与门店资料');overlay.append(panel);
        const source=Catalog.forDatabase(dexieDB),title=node('h3','商品与门店资料'),status=node('p'),list=node('div');status.setAttribute('role','status');let offset=0,query='',kind=options.kind||'',version=0,timer,offersChanged=false;
        function button(label,action){const el=node('button',label);el.className='btn btn-secondary';el.onclick=async()=>{el.disabled=true;try{await action();}catch{status.textContent='操作未完成，已有资料保留。';}finally{el.disabled=false;}};return el;}
        function field(label,value='',type='text'){const wrap=node('label',label),input=node('input');input.type=type;input.value=value;wrap.append(input);return {wrap,input};}
        function result(value){status.textContent=value.ok?'资料已保存，可离线查看。':errors[value.error?.code]||'资料暂不可用，已有内容保留。';return value.ok;}
        const close=button('返回',async()=>{clearTimeout(timer);version++;overlay.remove();if(offersChanged)await options.onOffersChanged?.();previous?.focus();});close.classList.add('catalog-back');panel.append(close,title,node('p','真实资料用于参考；价格、库存和配送由你的虚拟生活单独设定。'));
        const tabs=node('nav');tabs.className='commerce-chips';for(const [id,label] of [['','全部'],['product','商品'],['store','门店']]){const tab=button(label,async()=>{kind=id;await render(true);});tab.dataset.kind=id;tabs.append(tab);}panel.append(tabs);
        const search=field('搜索已保存资料','','search');search.input.placeholder='名称、品牌、条码或地址';search.input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{query=search.input.value.trim();void render(true);},180);};panel.append(search.wrap,status,list);
        const more=button('查看更多',()=>render(false));panel.append(more);
        const add=node('section');add.className='catalog-add';const form=node('div');form.hidden=true;
        add.append(button('查找或导入资料',async()=>{form.hidden=!form.hidden;}),form);panel.append(add);
        const barcode=field('商品条码','','text');barcode.input.inputMode='numeric';barcode.input.placeholder='输入包装上的条码';form.append(node('h4','按条码查商品'),barcode.wrap,button('查询商品',async()=>{if(result(await source.refresh('openfoodfacts',{region:'unknown',barcode:barcode.input.value.trim()}))){kind='product';await render(true);}}));
        form.append(node('h4','查找门店'),button('查询所选地区门店',async()=>{const market=await source.market(options.ownerId||'user');if(!market?.location){status.textContent='请先在购物页选择地区，或通过地点搜索确定位置。';return;}if(market.year!==VirtualClock.getParts({}).year||market.world){status.textContent='历史与虚构世界不使用当代门店资料。';return;}const {lat,lon}=market.location;if(result(await source.refresh('openstreetmap',{region:'market-'+await SharedAssets.digest(CatalogCore.marketKey(market)),bbox:[lat-.02,lon-.02,lat+.02,lon+.02]}))){kind='store';await render(true);}}));
        const sample=button('载入公开商品样本',async()=>{if(result(await source.loadPublicSamples()))await render(true);});form.append(sample);
        const file=node('input');file.type='file';file.accept='.json,application/json';file.hidden=true;file.setAttribute('aria-label','导入资料包');file.onchange=async()=>{const selected=file.files[0];if(!selected)return;try{if(selected.size>8000000){status.textContent='资料包较大，请分批导入。';return;}if(result(await source.importFacts(JSON.parse(await selected.text()).facts)))await render(true);}catch{status.textContent='未能读取资料包，原有资料保留。';}finally{file.value='';}};form.append(button('导入有授权的资料包',async()=>file.click()),file,node('p','来源记录可能过时，不代表当前营业、在售或供应情况。'));
        async function offerEditor(fact,row){
            if(row.querySelector('.catalog-offer-editor'))return;const editor=node('section');editor.className='catalog-offer-editor';
            editor.append(node('h4',fact.kind==='store'?'添加自建菜单':'添加到购物'),node('p',fact.kind==='store'?'门店地址来自公开资料；以下菜品与交易规则由你设定。':'名称与规格参考来源；以下价格与库存仅用于虚拟交易。'));
            const name=field('名称',fact.kind==='product'?fact.name:''),store=field('店铺名称',fact.kind==='store'?fact.name:'我的选物店'),spec=field('规格',fact.quantity||''),price=field('虚拟售价（元）','','number'),stock=field('虚拟库存','1','number');price.input.min='0.01';price.input.step='0.01';stock.input.min='0';stock.input.step='1';const id='catalog-offer:'+crypto.randomUUID();
            editor.append(name.wrap,store.wrap,spec.wrap,price.wrap,stock.wrap,button('保存商品',async()=>{const current=await source.get(fact.id);if(!current){status.textContent='来源已变化，请重新打开资料。';return;}const chosen=await source.market(options.ownerId||'user');const saved=await WalletSystem.saveCatalogOffer({...(chosen?{marketKey:CatalogCore.marketKey(chosen),createdBy:options.ownerId||'user',generationYear:chosen.year}:{}),id,storeId:store.input.value.trim(),category:fact.kind==='store'?'food':'general',name:name.input.value.trim(),specification:spec.input.value.trim(),factId:fact.id,currency:'CNY',unitMinor:CurrencyCore.amountToMinor(price.input.value,'CNY'),stock:Number(stock.input.value),version:0,simulation:true});if(!saved.ok){status.textContent='请填写名称、店铺及有效的售价和库存。';return;}offersChanged=true;status.textContent='已保存，返回'+(fact.kind==='store'?'外卖':'购物')+'即可浏览。';editor.remove();}),button('取消',async()=>editor.remove()));row.append(editor);name.input.focus();
        }
        async function render(clear){
            const request=++version;if(clear)offset=0;const response=await source.query({kind,query,offset,limit:30});if(request!==version||!overlay.isConnected)return;if(!response.ok){result(response);return;}
            if(clear)list.replaceChildren();tabs.querySelectorAll('button').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.kind===kind)));
            for(const fact of response.data.items){const row=node('article');row.className='catalog-fact-card';row.append(node('small',fact.kind==='store'?'门店资料':'商品资料'),node('strong',fact.name),node('p',fact.quantity||fact.address||'来源未提供规格或地址'));
                const link=node('a','查看来源 · '+fact.source.attribution);link.href=fact.source.url;link.target='_blank';link.rel='noopener noreferrer';row.append(link,node('small',fact.source.license+' · 采集于 '+new Date(fact.source.retrievedAt).toLocaleDateString()),button(fact.kind==='store'?'添加自建菜单':'添加到购物',()=>offerEditor(fact,row)));list.append(row);}
            if(clear&&!response.data.total)list.append(node('p','这里还没有资料。可以按条码查询商品，或导入已有资料。'));
            more.hidden=response.data.nextOffset===null;offset=response.data.nextOffset??0;
        }
        document.body.append(overlay);await render(true);close.focus();
        panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close.click();}if(event.key==='Tab'){const items=[...panel.querySelectorAll('button,input,a')].filter(el=>!el.disabled&&el.getClientRects().length);if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}}});
    }
    document.addEventListener('click',event=>{if(event.target.closest('#shop-catalog-source-btn')){document.getElementById('shop-more-actionsheet')?.classList.remove('visible');void open();}});
    global.CatalogUI=Object.freeze({open});
})(window);
