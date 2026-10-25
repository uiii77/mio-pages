(function(global){
    'use strict';
    const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
    const money=(minor,currency)=>CurrencyCore.formatMinor(minor,currency);
    const messages={MARKET_MISMATCH:'购物车包含不同地区或年代的商品，请分开结算。',CURRENCY_MISMATCH:'购物车包含不同币种，请分开结算。',WALLET_FROZEN:'新支付暂未启用，你仍可浏览和收藏到购物车。',ACCOUNT_ISOLATED:'账户待核对，当前不能交易。',ADDRESS_REQUIRED:'请先添加收货地址。',INSUFFICIENT_FUNDS:'可用余额不足。',QUOTE_CHANGED:'商品报价已变化，请重新结算。',CART_CHANGED:'购物车已变化，请重新结算。',VERSION_CONFLICT:'记录已更新，请刷新重试。',CONSUMPTION_DISABLED:'角色尚未授权消费。',CONSUMPTION_LIMIT:'已达到角色消费预算或频率限制。',AFTER_SALE_PENDING:'该子订单已有售后正在处理。'};
    let overlay;
    function button(title,action,primary=false){const el=node('button',title);el.className='btn '+(primary?'btn-primary':'btn-secondary');el.onclick=async()=>{el.disabled=true;try{await action();}catch(_){showToast('操作未完成，已保存记录保留，请刷新重试');}finally{el.disabled=false;}};return el;}
    function input(label,value='',type='text'){const wrap=node('label',label),field=node('input');field.type=type;field.value=value;Object.assign(wrap.style,{display:'block',margin:'12px 0'});Object.assign(field.style,{display:'block',width:'100%',boxSizing:'border-box',borderRadius:'10px',padding:'10px',font:'inherit',color:'inherit',background:'var(--input-bg,#f8f8f8)',border:'1px solid var(--border-color,#ddd)',marginTop:'6px'});wrap.append(field);return {wrap,field};}
    function requireSuccess(result){if(!result.ok){showToast(messages[result.error?.code]||'操作未完成，请检查填写内容后重试');return null;}return result.data;}
    const ownerName=id=>id==='user'?'我':(db.characters||[]).find(row=>String(row.id)===id)?.realName||'角色';
    const icons={food:'◒',general:'◇',cart:'▢',orders:'≡',me:'○'};
    function currencyPicker(value,onChange){
        const section=node('section');section.className='commerce-currency-picker';
        const search=input('搜索货币（名称、代码或符号）','','search'),list=node('div'),empty=node('small','没有匹配的结算货币');
        list.className='commerce-chips';empty.hidden=true;empty.setAttribute('role','status');
        for(const item of CurrencyCore.listCurrencies()){
            const pick=button(item.name+' · '+item.code+' · '+item.symbol,()=>{value=item.code;list.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.currency===value)));onChange(value);});
            pick.dataset.currency=item.code;pick.setAttribute('aria-pressed',String(item.code===value));list.append(pick);
        }
        search.field.oninput=()=>{const query=search.field.value.trim().toLowerCase();for(const pick of list.children)pick.hidden=!pick.textContent.toLowerCase().includes(query);empty.hidden=[...list.children].some(pick=>!pick.hidden);};
        section.append(search.wrap,list,empty);return section;
    }
    async function open(ownerId='user',channel='general',initialPage){
        if(overlay?.isConnected){CatalogMarket.cancel(overlay.dataset.owner);overlay.remove();}
        channel=channel==='food'?'food':'general';
        const previousFocus=document.activeElement,key='mio-commerce-view:'+ownerId+':'+channel;
        let saved={};try{saved=JSON.parse(sessionStorage.getItem(key)||'{}');}catch{}
        let page=initialPage||saved.page||'browse',offset=0,storeId=saved.storeId||'',productId=saved.productId||'',query=saved.query||'',orderId='',busy=false;
        if(!['browse','store','detail','cart','orders','me','wallet','grants','profile','after_sales','region'].includes(page))page='browse';
        const trail=[];
        overlay=node('div');overlay.className='commerce-app';overlay.id='commerce-dialog';overlay.dataset.channel=channel;overlay.dataset.owner=ownerId;
        const panel=node('div');panel.className='commerce-shell';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',channel==='food'?'外卖':'购物');overlay.append(panel);
        const api=global.WalletSystem.commerce(ownerId),header=node('header'),title=node('h1'),subtitle=node('small');header.className='commerce-header';
        const back=button('‹',()=>goBack());back.className='commerce-back';back.setAttribute('aria-label','返回');const heading=node('div');heading.append(title,subtitle);const locationButton=button('地区',()=>navigate('region'));locationButton.className='commerce-location';header.append(back,heading,locationButton);
        const status=node('p');status.className='commerce-status';status.setAttribute('role','status');const content=node('main');content.className='commerce-content';content.tabIndex=-1;
        const tabs=node('nav');tabs.className='commerce-nav';tabs.setAttribute('aria-label','底部导航');
        for(const [id,label,icon] of [['browse',channel==='food'?'点餐':'逛逛',icons[channel]],['cart','购物车',icons.cart],['orders','订单',icons.orders],['me','我的',icons.me]]){
            const tab=button('',()=>navigate(id));tab.dataset.page=id;const glyph=node('span',icon);glyph.setAttribute('aria-hidden','true');tab.append(glyph,node('span',label));tabs.append(tab);
        }
        function remember(){try{sessionStorage.setItem(key,JSON.stringify({page,storeId,productId,query,scroll:content.scrollTop}));}catch{}}
        function close(){CatalogMarket.cancel(ownerId);remember();overlay.remove();previousFocus?.focus({preventScroll:true});if(document.getElementById('peek-wallet-screen')?.classList.contains('active'))void renderPeekWallet(null);if(document.getElementById('piggy-bank-screen')?.classList.contains('active'))void WalletSystem.refresh('user').then(()=>renderPiggyBankScreen()).catch(()=>showToast('余额暂时无法刷新，请重新打开钱包'));}
        async function goBack(){if(busy)return;if(trail.length){const old=trail.pop();Object.assign(view,old);await render();content.scrollTop=old.scroll;}else if(page!=='browse'){page='browse';await render();}else close();}
        const view={};Object.defineProperties(view,{page:{get:()=>page,set:v=>page=v,enumerable:true},storeId:{get:()=>storeId,set:v=>storeId=v,enumerable:true},productId:{get:()=>productId,set:v=>productId=v,enumerable:true},query:{get:()=>query,set:v=>query=v,enumerable:true}});
        async function navigate(next){if(busy)return;busy=true;try{trail.push({...view,scroll:content.scrollTop});page=next;offset=0;orderId='';await render();content.scrollTop=0;content.focus({preventScroll:true});}finally{busy=false;}}
        content.addEventListener('scroll',remember,{passive:true});
        panel.append(header,status,content,tabs);document.body.append(overlay);
        panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();goBack();return;}if(event.key==='Tab'){const focusable=[...panel.querySelectorAll('button,input,select,textarea,a')].filter(el=>!el.disabled&&el.getClientRects().length);const index=focusable.indexOf(document.activeElement);if(event.shiftKey&&index<=0){event.preventDefault();focusable.at(-1)?.focus();}else if(!event.shiftKey&&index===focusable.length-1){event.preventDefault();focusable[0]?.focus();}}});
        function empty(text){const el=node('div');el.className='commerce-empty';el.append(node('span',icons[channel]),node('p',text));content.append(el);}
        function art(offer){const el=node('div');el.className='commerce-art';el.setAttribute('aria-hidden','true');const shapes={food:'<path d="M8 26h32c0 14-6 18-16 18S8 40 8 26Z"/><path d="M15 18c-4-5 4-5 0-10M25 18c-4-5 4-5 0-10M35 18c-4-5 4-5 0-10"/>',drink:'<path d="M12 14h25l-3 29H15Z M10 14h29 M28 14l3-9h8"/>',cake:'<path d="M10 24h30v18H10Z M10 24l20-12 10 12 M10 33h30"/><circle cx="28" cy="10" r="3"/>',bag:'<path d="M10 18h28l3 26H7Z M17 18v-6a7 7 0 0 1 14 0v6"/>',headphones:'<path d="M9 31V22a15 15 0 0 1 30 0v9 M9 27h7v15H9Z M32 27h7v15h-7Z"/>',lamp:'<path d="m17 9-7 19h28L31 9Z M24 28v15 M15 44h18"/>',book:'<path d="M12 7h26v37H12a5 5 0 0 1-5-5V12a5 5 0 0 1 5-5Z M12 7v37 M18 16h13 M18 22h10"/>',bottle:'<path d="M18 5h12v7H18Z M17 13h14l5 9v22H12V22Z M12 27h24"/>'};const name=offer.name||'',type=offer.art&&shapes[offer.art]?offer.art:/咖啡|拿铁|茶|饮/.test(name)?'drink':/糕|甜/.test(name)?'cake':/包/.test(name)?'bag':/耳机/.test(name)?'headphones':/灯/.test(name)?'lamp':/霜|护理/.test(name)?'bottle':offer.category==='food'?'food':'book';el.innerHTML='<svg viewBox="0 0 48 50" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'+shapes[type]+'</svg>';return el;}
        async function add(offer,delta=1){const current=await api.cart(),lines=current.lines.map(row=>({...row})),line=lines.find(row=>row.offerId===offer.id);if(line)line.quantity+=delta;else lines.push({offerId:offer.id,quantity:delta});if(requireSuccess(await api.setCart({expectedVersion:current.version,lines:lines.filter(row=>row.quantity>0)})))showToast(delta>0?'已加入购物车':'已更新数量');}
        function product(offer,grid=false){const card=node('article');card.className='commerce-product'+(grid?' is-grid':'');const info=button('',async()=>{productId=offer.id;await navigate('detail');});info.className='commerce-product-info';info.append(art(offer),node('strong',offer.name),node('small',offer.specification),node('small',offer.origin==='ai'?(offer.factId?'来源参考 · AI 补充':'AI 创作 · 示意插画'):offer.factId?'来源参考 · 虚拟交易':'虚拟商品'),node('b',money(offer.unitMinor,offer.currency)));info.setAttribute('aria-label','查看 '+offer.name);const plus=button('+',()=>add(offer));plus.className='commerce-add';plus.setAttribute('aria-label','加入购物车 '+offer.name);plus.disabled=offer.stock<=0;card.append(info,plus);return card;}
        async function catalog(clear){
            const market=await Catalog.forDatabase(dexieDB).market(ownerId),marketKey=market?CatalogCore.marketKey(market):undefined;
            if(page==='detail'){
                const offer=await api.offer(productId);if(!offer||offer.archived||offer.category!==channel){empty('这件商品暂时找不到了');return;}
                const hero=node('section');hero.className='commerce-detail';hero.append(art(offer),node('small',offer.storeId),node('h2',offer.name),node('p',offer.specification),node('p',offer.description||''),node('strong',money(offer.unitMinor,offer.currency)),node('p',offer.origin==='ai'?'AI 创作 · 价格、库存及配送为模拟设定':offer.factId?'参考资料商品 · 虚拟交易':'虚拟商品'),button('加入购物车',()=>add(offer),true));if(offer.factId){const fact=await Catalog.forDatabase(dexieDB).get(offer.factId);if(fact){const link=node('a','资料来源 · '+fact.source.attribution);link.href=fact.source.url;link.target='_blank';link.rel='noopener noreferrer';hero.append(link,node('p',fact.source.license+' · '+new Date(fact.source.retrievedAt).toLocaleDateString()));}}if(offer.origin==='ai'&&offer.createdBy===ownerId){hero.append(button('编辑商品',()=>editOffer(offer)),button('重新生成',()=>generateItems(1,offer.id)),button('删除商品',async()=>{if(await showAppConfirmDialog({title:'删除商品',message:'删除此商品？已有订单会保留。',confirmText:'删除',dismissText:''})!=='confirm')return;await Catalog.forDatabase(dexieDB).editGenerated(ownerId,offer.id,{archived:true},offer.version);await navigate('browse');}));}content.append(hero);return;
            }
            if(clear){
                const intro=node('section');intro.className='commerce-intro';intro.append(node('small',channel==='food'?'GOOD FOOD, GOOD DAY':'LITTLE THINGS, BIG JOY'),node('h2',page==='store'?storeId:channel==='food'?'今天，想吃点什么？':'把喜欢带回生活'));
                const form=node('form'),search=node('input');form.className='commerce-search';search.type='search';search.placeholder=channel==='food'?'搜索店铺或菜品':'搜索你喜欢的商品';search.value=query;search.setAttribute('aria-label',search.placeholder);const submit=node('button','搜索');submit.type='submit';form.append(search,submit);form.onsubmit=async event=>{event.preventDefault();query=search.value.trim();offset=0;await render();};intro.append(form);const discovery=node('div');discovery.className='commerce-discovery';const amount=node('div');amount.className='commerce-chips';for(const count of [4,12]){const chip=button(count+' 件',async()=>{generationCount=count;await render();});chip.setAttribute('aria-pressed',String(generationCount===count));amount.append(chip);}const create=button(query?'寻找「'+query+'」':'让店铺上新',()=>generateItems(generationCount),true);create.disabled=generating;const cancel=button('取消生成',async()=>CatalogMarket.cancel(ownerId));cancel.hidden=!generating;const renew=button('换一批',()=>generateItems(generationCount,null,true));renew.disabled=generating;discovery.append(amount,create,renew,cancel,node('small',generating?'正在准备，原有商品仍可浏览…':'优先使用缓存与公开资料，缺少内容时由 AI 创作'));intro.append(discovery);content.append(intro);
                if(channel==='general'||channel==='food'&&page==='store'){const filters=node('div');filters.className='commerce-chips commerce-categories';const menu=requireSuccess(await api.categories({category:channel,marketKey,storeId:page==='store'?storeId:undefined}))||[];for(const name of [channel==='food'?'全部菜单':'全部分类',...menu]){const chip=button(name,async()=>{menuCategory=['全部菜单','全部分类'].includes(name)?'':name;offset=0;await render();});chip.setAttribute('aria-pressed',String(name===(menuCategory||(channel==='food'?'全部菜单':'全部分类'))));filters.append(chip);}content.append(filters);}
            }
            const rows=requireSuccess(await (channel==='food'&&page==='browse'?api.stores:api.offers)({category:channel,marketKey,offset,limit:30,search:query,storeId:page==='store'?storeId:undefined,menuCategory:menuCategory||undefined,available}));if(!rows)return;
            if(!rows.length&&clear){empty(query?'没有找到，试试其他关键词':'选好地区，让这里的店铺开始营业吧');return;}
            const list=node('div');list.className=channel==='general'?'commerce-grid':'commerce-menu';
            if(channel==='food'&&page==='browse'){
                for(const group of rows){const name=group.storeId;const card=button('',async()=>{storeId=name;query='';available=false;menuCategory='';await navigate('store');});card.className='commerce-store';card.dataset.storeId=name;const body=node('div');body.append(node('strong',name),node('small',group.hasFacts?'来源参考 · 模拟菜单':group.hasAI?'AI 虚构店铺 · 模拟菜单':'自建店铺 · 模拟菜单'),node('small',group.names.join(' · ')),node('span',group.count+' 道商品 · 查看菜单 ›'));card.append(art(group.cover),body);list.append(card);}
            }else for(const offer of rows)list.append(product(offer,channel==='general'));
            content.append(list);if(rows.length===30){const more=button('查看更多',async()=>{offset+=30;await render(false);more.remove();});content.append(more);}
        }
        let available=false,menuCategory='',generationCount=4,generating=false;
        const generationErrors={API_UNAVAILABLE:'请先在设置中配置聊天 API，或为角色绑定商城模型。',INVALID_MARKET:'先选择国家、城市、年代与货币，再开始逛街。',GENERATION_BUSY:'已有一项生成任务正在进行。',GENERATION_CANCELLED:'已取消，原有商品保留。',TOKEN_LIMIT:'今日生成额度已用完，已有商品仍可购买。',INVALID_GENERATION:'生成内容未通过校验，原有商品保留，请稍后重试。',ANACHRONISM:'发现不符合年代的商品，本批未保存。',NO_NEW_ITEMS:'这次没有新的商品，已有目录保留。',MARKET_CHANGED:'地区已改变，本次结果未保存。',INVALID_SOURCE:'来源引用未通过校验，本批未保存。'};
        async function generateItems(count,replaceId,refresh=false){
            if(generating)return;const market=await Catalog.forDatabase(dexieDB).market(ownerId);if(!market){await navigate('region');return;}
            generating=true;const originPage=page;await render();
            try{const result=await CatalogMarket.generate(ownerId,channel,{count,query,replaceId,refresh});showToast(result.cached?'已读取保存的商品，无需再次生成':'新商品已准备好');}
            catch(error){showToast(generationErrors[error.message]||'暂时无法生成，已有商品保留，可稍后重试。');}
            finally{generating=false;if(panel.isConnected&&page===originPage)await render();}
        }
        async function editOffer(offer){
            content.replaceChildren();const name=input('商品名称',offer.name),description=input('描述',offer.description||''),spec=input('规格',offer.specification),price=input('模拟售价（'+offer.currency+'）',String(offer.unitMinor/10**CurrencyCore.meta(offer.currency).digits),'number'),stock=input('库存',offer.stock,'number');
            content.append(name.wrap,description.wrap,spec.wrap,price.wrap,stock.wrap,button('保存修改',async()=>{await Catalog.forDatabase(dexieDB).editGenerated(ownerId,offer.id,{name:name.field.value,description:description.field.value,specification:spec.field.value,unitMinor:CurrencyCore.amountToMinor(price.field.value,offer.currency),stock:Number(stock.field.value)},offer.version);await render();},true),button('取消',()=>render()));
        }
        async function regionEditor(){
            const source=Catalog.forDatabase(dexieDB),value=await CatalogMarket.context(ownerId);let coordinates=value.location;
            const search=input('搜索国家、城市或地区','','search'),results=node('div');results.className='commerce-place-results';
            const country=input('国家或国度',value.country),city=input('城市或聚落',value.city),district=input('地区（可选）',value.district),year=input('年代',value.year,'number'),world=input('世界观（可选）',value.world);
            for(const field of [country,city,district])field.field.oninput=()=>{coordinates=null;};
            let currency=value.currency;const currencies=currencyPicker(currency,code=>{currency=code;});
            const extra=node('section');extra.className='commerce-region-extra';extra.id='commerce-region-extra';extra.hidden=!value.district&&!value.world;extra.append(district.wrap,world.wrap);
            const expand=button('地区与世界观（可选）',()=>{extra.hidden=!extra.hidden;expand.setAttribute('aria-expanded',String(!extra.hidden));});expand.setAttribute('aria-expanded',String(!extra.hidden));expand.setAttribute('aria-controls',extra.id);
            year.field.min='1';year.field.max='9999';year.field.step='1';
            search.field.placeholder='如：杭州 中国、Paris France';
            content.append(node('p',ownerId==='user'?'为你的生活选择地点与年代。':'这里仅设置当前角色的购物世界，不跟随你的所在地。'),search.wrap,button('搜索地点',async()=>{try{results.replaceChildren(node('p','正在查找…'));const rows=await source.searchPlaces(search.field.value);results.replaceChildren();for(const row of rows)results.append(button(row.label,async()=>{country.field.value=row.country;city.field.value=row.city;district.field.value=row.district;coordinates=row.location;results.replaceChildren(node('p','已选：'+row.label));}));if(!rows.length)results.append(node('p','没有找到，可在下方手动填写。'));}catch{results.replaceChildren(node('p','地点服务暂不可用，可手动填写。'));}}),results,node('small','地点搜索 © OpenStreetMap contributors · ODbL'),country.wrap,city.wrap,year.wrap,expand,extra,node('h2','结算货币'),currencies,node('small','按已保存的结算币种使用；首次设置读取钱包默认币种。其他历史或虚构货币可写入世界观，不自动换汇。'),button('保存并去逛逛',async()=>{try{CatalogMarket.cancel(ownerId);await source.saveMarket(ownerId,{country:country.field.value,city:city.field.value,district:district.field.value,year:Number(year.field.value),world:world.field.value,currency,location:coordinates});query='';storeId='';menuCategory='';page='browse';trail.length=0;await render();}catch{showToast('请完整填写国家、城市、有效年代与货币。');}},true));
        }

        async function checkoutGroup(group,addressId,recipientOwnerId){
            const quote=requireSuccess(await api.quote({addressId,recipientOwnerId,category:channel,offerIds:group.items.map(({line})=>line.offerId)}));if(!quote)return;
            content.replaceChildren(node('h4','确认订单'),node('p','合计 '+money(quote.totalMinor,quote.currency)+' · '+quote.children.length+' 家店铺 · 请在五分钟内付款'),node('p','送至：'+quote.address.label+' · '+quote.address.address));
            for(const child of quote.children)content.append(node('p',child.storeId+'：'+money(child.totalMinor,child.currency)+'（配送 '+money(child.deliveryMinor,child.currency)+'，包装 '+money(child.packagingMinor,child.currency)+'）'));
            const accounts=await WalletSystem.accounts(ownerId),select=node('select');select.setAttribute('aria-label','付款账户');
            for(const row of accounts.filter(row=>row.currency===quote.currency&&row.status==='active')){const option=node('option',ownerName(row.ownerId)+' · '+money(row.balanceMinor-row.reservedMinor,row.currency));option.value=row.id;select.append(option);}
            const grants=(await WalletSystem.grants(ownerId).list()).filter(row=>row.granteeOwnerId===ownerId&&row.status==='active'&&row.currency===quote.currency);
            for(const grant of grants){const option=node('option','亲属卡 · '+ownerName(grant.ownerId)+' · 上限 '+money(grant.limitMinor,grant.currency));option.value='grant:'+grant.id;select.append(option);}content.append(select);
            const key=crypto.randomUUID();content.append(button('确认支付',async()=>{const grant=grants.find(row=>'grant:'+row.id===select.value),account=await WalletSystem.account(grant?grant.payerAccountId:select.value);if(!account){showToast('请选择可用的同币种账户');return;}const result=requireSuccess(await api.checkout({quoteId:quote.id,sourceAccountId:account.id,expectedSourceVersion:account.version,idempotencyKey:key,...(grant?{grantId:grant.id}:{})}));if(result){page='orders';offset=0;await render();}},true),button('返回购物车',()=>render()));
        }

        async function render(clear=true){
            if(clear)content.replaceChildren();
            const labels={browse:channel==='food'?'外卖':'购物',store:storeId,detail:'商品详情',cart:'购物车',orders:'我的订单',me:'我的',wallet:'钱包',grants:'亲属卡',profile:'地址与消费设置',after_sales:'售后进度',region:'地区与世界'};
            title.textContent=labels[page]||labels.browse;subtitle.textContent=ownerId==='user'?'Mio · 虚拟生活':(db.characters||[]).find(row=>String(row.id)===ownerId)?.realName||'角色';
            tabs.querySelectorAll('button').forEach(el=>el.setAttribute('aria-current',el.dataset.page===page?'page':'false'));
            const currentMarket=await Catalog.forDatabase(dexieDB).market(ownerId);locationButton.textContent=currentMarket?currentMarket.city+' · '+currentMarket.year:'选择地区';
            content.dataset.page=page;remember();
            const wallet=await WalletSystem.read(ownerId);status.textContent='';if(generating&&page==='detail')status.append(node('span','正在重新生成…'),button('取消生成',async()=>CatalogMarket.cancel(ownerId)));
            if(page==='region'){await regionEditor();return;}
            if(['browse','store','detail'].includes(page)){await catalog(clear);return;}
            if(page==='me'){
                const account=wallet.data?.accounts?.find(row=>row.currency===(currentMarket?.currency||wallet.data?.defaultCurrency||'CNY')),hero=node('section');hero.className='commerce-account';hero.append(node('small','我的钱包'),node('strong',account?money(account.balanceMinor-(account.reservedMinor||0),account.currency):'—'),node('span',wallet.data?.mode==='ledger'?'可用余额与明细':'保留原钱包使用方式'));content.append(hero);
                const sources=button('资料与来源（高级）',()=>CatalogUI.open({ownerId,kind:channel==='food'?'store':'product'}));sources.className='commerce-sources commerce-settings-row';content.append(sources);
                for(const [id,label,desc] of [['region','地区与世界','地点、年代与结算货币'],['wallet','钱包','余额与收支'],['grants','亲属卡','额度与用款授权'],['profile','地址与消费设置','收货地址与角色消费'],['after_sales','售后进度','退款与退货']]){const row=button('',()=>navigate(id));row.className='commerce-settings-row';row.append(node('strong',label),node('small',desc),node('span','›'));content.append(row);}return;
            }
            if(page==='wallet'){
                if(!wallet.ok){empty('钱包暂时无法读取，请重新打开');return;}
                if(clear){
                    const balances=node('section');balances.className='commerce-wallet-balances';
                    for(const account of wallet.data.accounts||[]){const card=node('article');card.className='commerce-wallet-balance';const meta=CurrencyCore.meta(account.currency),valid=Number.isSafeInteger(account.balanceMinor);card.append(node('small',meta.name+' · '+meta.code),node('strong',valid?money(account.balanceMinor,account.currency):'待核对'),node('small',valid?'可用 '+money(account.balanceMinor-(account.reservedMinor||0),account.currency)+' · 预留 '+money(account.reservedMinor||0,account.currency):'尚无已确认余额'));balances.append(card);}
                    content.append(balances,node('h2','收支明细'));
                }
                if(wallet.data?.mode==='legacy'){const visible=(wallet.data.transactions||[]).filter(row=>!row.hidden);for(const row of visible.slice(offset,offset+30))content.append(node('p',(row.remark||'收支')+' · 人民币 '+(row.type==='expense'?'-':'+')+money(Math.round(row.amount*100),'CNY')));if(!visible.length)empty('暂无收支记录');if(visible.length>offset+30){const more=button('加载更多',async()=>{more.remove();offset+=30;await render(false);});content.append(more);}return;}
                const rows=await WalletSystem.history(ownerId,offset,30);for(const row of rows)content.append(node('p',new Date(row.occurredAt).toLocaleString()+' · '+CurrencyCore.meta(row.currency).name+' '+(row.deltaMinor<0?'-':'+')+money(Math.abs(row.deltaMinor),row.currency)));
                if(!rows.length&&clear)empty('暂无收支记录');
                if(rows.length===30){const more=button('加载更多',async()=>{more.remove();offset+=30;await render(false);});content.append(more);}
            }else if(page==='cart'){
                const cart=await api.cart(),offers=await Promise.all(cart.lines.map(line=>api.offer(line.offerId))),groups=new Map();
                for(let i=0;i<cart.lines.length;i++){
                    const offer=offers[i],line=cart.lines[i];if(offer&&offer.category!==channel)continue;
                    const groupKey=JSON.stringify([offer?.marketKey||null,offer?.currency||null]);
                    if(!groups.has(groupKey))groups.set(groupKey,{marketKey:offer?.marketKey||null,currency:offer?.currency,items:[]});
                    groups.get(groupKey).items.push({offer,line});
                }
                if(!groups.size){empty('购物车为空，去逛逛吧。');return;}
                const profile=await api.profile(),address=node('select'),recipient=node('select');
                address.setAttribute('aria-label','配送地址');recipient.setAttribute('aria-label','收件人');
                for(const row of profile.addresses){const option=node('option',row.label+' · '+row.address);option.value=row.id;address.append(option);}
                for(const entry of [{id:'user',name:'我'},...(db.characters||[]).map(row=>({id:String(row.id),name:row.realName||row.name||'角色'}))]){const option=node('option',entry.name);option.value=entry.id;recipient.append(option);}recipient.value=ownerId;
                if(profile.addresses.length)content.append(node('p','收件人'),recipient,node('p','收货地址'),address);
                else content.append(button('添加收货地址',()=>navigate('profile'),true));
                if(groups.size>1)content.append(node('p','不同地区和币种分别结算，其他商品会留在购物车。'));
                for(const group of groups.values()){
                    let market=null;try{if(group.marketKey)market=CatalogCore.market(JSON.parse(group.marketKey));}catch{}
                    const section=node('section');section.className='commerce-cart-group';section.dataset.currency=group.currency||'';
                    section.append(node('h3',(market?market.city+' · '+market.year:'默认目录')+' · '+(group.currency||'已下架')));
                    if(market?.world)section.append(node('small',market.world));
                    for(const {offer,line} of group.items){
                        const row=node('article');row.className='commerce-cart-item';row.append(node('strong',(offer?.name||'商品已下架')+' × '+line.quantity));
                        if(offer){row.append(art(offer),node('span',money(offer.unitMinor*line.quantity,offer.currency)));const quantity=node('div');quantity.className='commerce-stepper';for(const [label,delta] of [['−',-1],['+',1]]){const control=button(label,async()=>{await add(offer,delta);await render();});control.setAttribute('aria-label',(delta<0?'减少':'增加')+offer.name);control.disabled=delta>0&&(offer.archived||line.quantity>=offer.stock);quantity.append(control);if(delta<0)quantity.append(node('span',String(line.quantity)));}row.append(quantity);}
                        row.append(button('移除',async()=>{const latest=await api.cart();if(requireSuccess(await api.setCart({expectedVersion:latest.version,lines:latest.lines.filter(item=>item.offerId!==line.offerId)})))await render();}));section.append(row);
                    }
                    const isCurrent=!group.marketKey||currentMarket&&CatalogCore.marketKey(currentMarket)===group.marketKey;
                    if(!isCurrent){section.append(node('p','这些商品保留在原来的地区。'));if(market)section.append(button('切换到 '+market.city+' · '+market.year,async()=>{CatalogMarket.cancel(ownerId);await Catalog.forDatabase(dexieDB).saveMarket(ownerId,market);await render();}));}
                    else {const pay=button('去结算',()=>checkoutGroup(group,address.value,recipient.value),true);pay.disabled=!profile.addresses.length||group.items.some(({offer,line})=>!offer||offer.archived||offer.stock<line.quantity);section.append(pay);}
                    content.append(section);
                }
            }else if(page==='orders'){
                const orders=requireSuccess(await api.orders(offset,30,channel));if(!orders)return;
                for(let order of orders){if(orderId&&order.id!==orderId)continue;const refreshed=await api.refreshDelivery(order.id);if(refreshed.ok)order=refreshed.data;const section=node('section');section.style.padding='14px 0';const statuses={confirmed:'已付款',paid:'已付款',accepted:'店铺已接单',ready:'已备货',picked_up:'配送中',delivered:'已送达',cancelled:'已取消'};section.append(node('strong',order.storeId||'历史订单'),node('p',(statuses[order.status]||order.status)+' · '+money(order.totalMinor,order.currency)+' · 已退款 '+money(order.refundedMinor||0,order.currency)));
                    if(!orderId){section.append(node('p',(order.lines||[]).map(row=>row.name+' × '+row.quantity).join('、')),button('查看订单',async()=>{orderId=order.id;await render();}));content.append(section);continue;}section.append(button('返回订单列表',async()=>{orderId='';await render();}));const progress=node('ol');progress.className='commerce-delivery';for(const [i,label] of ['已付款','已接单','备货中','配送中','已送达'].entries()){const step=node('li',label);step.dataset.complete=String(i<=(order.fulfilmentStage||0));progress.append(step);}section.append(progress,node('p',order.address?order.address.label+' · '+order.address.address:''));for(const line of order.lines||[])section.append(node('p',line.name+' × '+line.quantity+' · '+money(line.paidMinor,order.currency)));if(order.batchId){const form=node('div');form.hidden=true;form.className='commerce-after-sale-form';const openForm=button('申请售后',async()=>{form.hidden=!form.hidden;if(!form.hidden)form.querySelector('input')?.focus();});section.append(openForm,form);const selected=[];for(const line of order.lines){const remaining=line.quantity-line.refundedQuantity,q=input(line.name+' · 剩余可申请 '+remaining,0,'number');q.field.min='0';q.field.max=String(remaining);selected.push({line,field:q.field});form.append(q.wrap);}const reason=input('售后原因');form.append(reason.wrap,button('申请取消 / 退款 / 退货',async()=>{const result=requireSuccess(await api.requestAfterSale({orderId:order.id,expectedOrderVersion:order.version,selections:selected.filter(row=>Number(row.field.value)>0).map(row=>({skuId:row.line.skuId,quantity:Number(row.field.value)})),reason:reason.field.value,idempotencyKey:crypto.randomUUID()}));if(result){showToast(result.state==='refunded'?'已原路退款':result.state==='awaiting_return'?'请完成模拟退货确认':'已提交审核，尚未退款');await render();}}));}
                    content.append(section);
                }
                if(!orders.length&&clear)content.append(node('p','暂无订单。'));
                if(orders.length===30){const more=button('加载更多',async()=>{more.remove();offset+=30;await render(false);});content.append(more);}
            }else if(page==='after_sales'){
                const sales=requireSuccess(await api.afterSales(offset,30));if(!sales)return;
                for(const row of sales){const section=node('section');section.style.padding='12px 0';section.append(node('p','售后：'+({pending_review:'待审核',awaiting_return:'待模拟退货',refunded:'已原路退款',rejected:'审核未通过'}[row.state]||row.state)+' · '+money(row.amountMinor,row.currency)),node('p',row.reason));
                    if(row.state==='awaiting_return')section.append(button('确认模拟退货已收回',async()=>{if(requireSuccess(await api.confirmReturn({afterSaleId:row.id,confirmed:true,idempotencyKey:crypto.randomUUID()})))await render();}));
                    if(row.state==='pending_review'){const reason=input('模拟店铺审核依据');section.append(reason.wrap);for(const approved of [true,false])section.append(button(approved?'模拟店铺：同意原路退款':'模拟店铺：拒绝售后',async()=>{if(requireSuccess(await WalletSystem.reviewAfterSale(ownerId,{afterSaleId:row.id,approved,reason:reason.field.value,idempotencyKey:crypto.randomUUID()})))await render();}));}
                    content.append(section);
                }
                if(!sales.length&&clear)content.append(node('p','暂无售后记录。'));
                if(sales.length===30){const more=button('加载更多',async()=>{more.remove();offset+=30;await render(false);});content.append(more);}
            }else if(page==='grants'){
                const grants=WalletSystem.grants(ownerId),rows=await grants.list();
                for(const grant of rows.slice(offset,offset+30)){const section=node('section');section.style.padding='12px 0';section.append(node('p',ownerName(grant.ownerId)+' → '+ownerName(grant.granteeOwnerId)+' · '+({pending:'待接受',active:'使用中',frozen:'已冻结',revoked:'已撤销',returned:'已退还'}[grant.status]||'已停用')),node('p','本周期已用 '+money(grant.usedMinor,grant.currency)+' / '+money(grant.limitMinor,grant.currency)));
                    const actions=grant.ownerId===ownerId?[['freeze','冻结'],['unfreeze','解冻'],['revoke','撤销']]:[['accept','接受'],['return','退还']];
                    for(const [action,label] of actions.filter(([action])=>({freeze:['active'],unfreeze:['frozen'],revoke:['pending','active','frozen'],accept:['pending'],return:['pending','active','frozen']}[action]||[]).includes(grant.status)))section.append(button(label,async()=>{if(requireSuccess(await grants.change({action,grantId:grant.id,expectedVersion:grant.version,idempotencyKey:crypto.randomUUID()})))await render();}));
                    if(grant.ownerId===ownerId&&['pending','active','frozen'].includes(grant.status)){const limit=input('调整额度',String(grant.limitMinor/10**CurrencyCore.meta(grant.currency).digits));section.append(limit.wrap,button('保存额度',async()=>{if(requireSuccess(await grants.change({action:'limit',grantId:grant.id,expectedVersion:grant.version,limitMinor:CurrencyCore.amountToMinor(limit.field.value,grant.currency),idempotencyKey:crypto.randomUUID()})))await render();}));}content.append(section);
                }
                if(rows.length>offset+30){const more=button('加载更多',async()=>{more.remove();offset+=30;await render(false);});content.append(more);}
                if(clear){content.append(node('h4','发出新授权'),node('p','亲属卡用于购物付款，不支持转账或提现。'));
                    const target=node('select');target.setAttribute('aria-label','授权接收账户');for(const entry of [{id:'user',name:'我'},...(db.characters||[]).map(row=>({id:String(row.id),name:row.realName||row.name||'角色'}))].filter(row=>row.id!==ownerId)){const option=node('option',entry.name);option.value=entry.id;target.append(option);}
                    const accounts=await WalletSystem.accounts(ownerId),payer=node('select');payer.setAttribute('aria-label','授权付款账户');for(const account of accounts.filter(row=>row.status==='active')){const option=node('option',account.currency);option.value=account.id;payer.append(option);}
                    const limit=input('额度（所选币种）','100'),days=input('自定义周期天数','30','number');content.append(target,payer,limit.wrap,days.wrap,button('发出待接受授权',async()=>{const account=accounts.find(row=>row.id===payer.value);if(!account){showToast('请选择可用账户');return;}if(requireSuccess(await grants.change({action:'issue',grantId:crypto.randomUUID(),expectedVersion:0,payerAccountId:account.id,granteeOwnerId:target.value,limitMinor:CurrencyCore.amountToMinor(limit.field.value,account.currency),periodKind:'custom',days:Number(days.field.value),idempotencyKey:crypto.randomUUID()})))await render();}));}
            }else{
                const profile=await api.profile(),label=input('地址名称'),address=input('收货地址');let editingId=null;for(const saved of profile.addresses){const section=node('section');section.append(node('p',saved.label+' · '+saved.address),button('编辑地址',()=>{editingId=saved.id;label.field.value=saved.label;address.field.value=saved.address;label.field.focus();}),button('删除地址',async()=>{if(requireSuccess(await api.saveProfile({expectedVersion:profile.version,addresses:profile.addresses.filter(row=>row.id!==saved.id),consumption:profile.consumption})))await render();}));content.append(section);}content.append(node('p','已有地址：'+profile.addresses.map(row=>row.label+' · '+row.address).join('；')),label.wrap,address.wrap,button('保存地址',async()=>{if(requireSuccess(await api.saveProfile({expectedVersion:profile.version,addresses:[...profile.addresses.filter(row=>row.id!==editingId),{id:editingId||crypto.randomUUID(),label:label.field.value,address:address.field.value}],consumption:profile.consumption})))await render();}));
                if(ownerId!=='user'){let policyCurrency=profile.consumption.currency;const policyPicker=currencyPicker(policyCurrency,code=>{if(code===policyCurrency)return;policyCurrency=code;budget.field.value='0';budget.wrap.firstChild.textContent='每周期预算（'+policyCurrency+'）';});const enabled=node('input');enabled.type='checkbox';enabled.checked=profile.consumption.enabled;const wrap=node('label','允许角色自主消费');wrap.prepend(enabled);const budget=input('每周期预算（'+profile.consumption.currency+'）',String(profile.consumption.budgetMinor/10**CurrencyCore.meta(profile.consumption.currency).digits)),hours=input('周期小时',profile.consumption.periodMs/3600000,'number'),interval=input('最小消费间隔（分钟）',profile.consumption.minimumIntervalMs/60000,'number');content.append(wrap,policyPicker,budget.wrap,hours.wrap,interval.wrap,button('保存角色授权',async()=>{const amount=CurrencyCore.amountToMinor(budget.field.value,policyCurrency);if(requireSuccess(await api.saveProfile({expectedVersion:profile.version,addresses:profile.addresses,consumption:{...profile.consumption,enabled:enabled.checked,currency:policyCurrency,budgetMinor:amount,periodMs:Number(hours.field.value)*3600000,minimumIntervalMs:Number(interval.field.value)*60000}})))await render();}));}
            }
        }
        await render();content.scrollTop=saved.scroll||0;back.focus();
    }
    function init(){
        const sheet=document.querySelector('#shop-more-actionsheet .action-sheet');
        if(sheet&&!sheet.querySelector('[data-commerce-open]'))for(const [channel,label] of [['food','外卖'],['general','购物']]){const entry=node('button',label);entry.className='action-sheet-button';entry.dataset.commerceOpen='user';entry.dataset.commerceChannel=channel;sheet.prepend(entry);}
        const header=document.querySelector('#shop-screen .shop-tabs');if(header&&!document.getElementById('commerce-launchers')){const row=node('div');row.id='commerce-launchers';row.className='commerce-launchers';for(const [channel,label] of [['food','外卖'],['general','购物']]){const entry=button(icons[channel]+'  '+label,()=>open('user',channel));row.append(entry);}header.before(row);}
    }
    document.addEventListener('click',event=>{const target=event.target.closest('[data-commerce-open]');if(target){document.getElementById('shop-more-actionsheet')?.classList.remove('visible');open(target.dataset.commerceOpen||'user',target.dataset.commerceChannel||'general',target.dataset.commercePage).catch(()=>showToast('暂时无法打开，请稍后重试'));}});
    global.CommerceUI=Object.freeze({init,open});
})(window);
