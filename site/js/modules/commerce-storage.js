// Virtual checkout owns catalog offers/cart/fulfilment; WalletSystem's ledger owns every payment.
(function(global){
    'use strict';
    const fail=(code,retryable=false)=>({ok:false,error:{code,retryable}});
    const validId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200;
    const minor=value=>Number.isSafeInteger(value)&&value>=0;
    const copy=value=>JSON.parse(JSON.stringify(value));
    const abort=result=>{if(!result.ok)throw Object.assign(Error(result.error.code),{domainResult:result});return result.data;};
    const policies=Object.freeze({food:{version:'food-v1',windowMs:86400000,requiresReturn:false,restock:false},general:{version:'general-v1',windowMs:7*86400000,requiresReturn:true,restock:true}});
    const delivery=Object.freeze({version:'simulation-v1',acceptMs:60000,prepareMs:600000,pickupMs:120000,travelMs:900000});
    function validOffer(offer){
        return !!offer&&validId(offer.id)&&validId(offer.storeId)&&typeof offer.name==='string'&&offer.name.trim().length>0&&offer.name.length<=200
            && ['food','general'].includes(offer.category)&&global.CurrencyCore.isSupported(offer.currency)&&minor(offer.unitMinor)&&offer.unitMinor>0&&minor(offer.stock)&&offer.stock<=1000000000
            &&minor(offer.version)&&offer.simulation===true&&typeof offer.specification==='string'&&offer.specification.length<=500
            &&(offer.factId===null||validId(offer.factId));
    }
    function validProfile(row){
        const policy=row?.consumption;
        return !!row&&validId(row.id)&&minor(row.version)&&Array.isArray(row.addresses)&&row.addresses.length<=20&&new Set(row.addresses.map(item=>item.id)).size===row.addresses.length
            &&row.addresses.every(item=>validId(item.id)&&typeof item.label==='string'&&item.label.length<=100&&typeof item.address==='string'&&item.address.trim().length>0&&item.address.length<=500)
            &&!!policy&&typeof policy.enabled==='boolean'&&CurrencyCore.isSupported(policy.currency)&&minor(policy.budgetMinor)&&minor(policy.periodMs)&&policy.periodMs>=3600000&&policy.periodMs<=365*86400000&&minor(policy.minimumIntervalMs);
    }
    function validQuoteChild(child){
        if(!child||!validId(child.storeId)||!policies[child.category]||!Array.isArray(child.lines)||!child.lines.length||new Set(child.lines.map(row=>row.skuId)).size!==child.lines.length)return false;
        const totals=CommerceCore.totals(child.lines,child);
        return totals.ok&&Object.keys(totals.data).every(key=>totals.data[key]===child[key])&&Object.keys(policies[child.category]).every(key=>child.policy?.[key]===policies[child.category][key])&&Object.keys(delivery).every(key=>child.deliveryRule?.[key]===delivery[key])
            &&child.lines.every(row=>minor(row.offerVersion)&&minor(row.paidMinor)&&row.refundedQuantity===0)&&child.lines.reduce((sum,row)=>sum+BigInt(row.paidMinor),0n)===BigInt(child.subtotalMinor-child.discountMinor);
    }
    function forOwner(db,ownerId,capabilities={}){
        if(!validId(ownerId)||!db?.transaction)throw TypeError('Invalid commerce binding');
        const keys=[...Object.keys(EconomySchema.runtimeTables),...Object.keys(EconomySchema.commerceTables)];
        const tables=[...keys.map(key=>db[key]),db.globalSettings];
        async function transaction(task){try{return await db.transaction('rw',tables,task);}catch(error){return error.domainResult || fail('PERSISTENCE_FAILED',true);}}
        async function active(){const state=await db.walletControl.get('state');if(global.WalletStorage.resolveControl(state,true).mode!=='ledger')return fail('WALLET_FROZEN');if(state.quarantinedOwnerIds?.includes(ownerId))return fail('ACCOUNT_ISOLATED');return {ok:true};}
        async function operation(kind,input,task){
            if(!validId(input?.idempotencyKey))return fail('INVALID_REQUEST');
            const request=copy(input),id=JSON.stringify([ownerId,kind,request.idempotencyKey]),fingerprint=JSON.stringify(request);
            return transaction(async()=>{
                const old=await db.commerceOperations.get(id);if(old)return old.fingerprint===fingerprint?{ok:true,data:old.receipt}:fail('IDEMPOTENCY_CONFLICT');
                abort(await active());const receipt=await task(request,id);
                await db.commerceOperations.add({id,ownerId,kind,fingerprint,receipt});return {ok:true,data:receipt};
            });
        }
        async function upsertOffer(input){
            if(!capabilities.manage)return fail('FORBIDDEN');
            const offer=copy(input);if(!validOffer(offer))return fail('INVALID_OFFER');
            return transaction(async()=>{const prior=await db.commerceOffers.get(offer.id);if(prior&&(prior.version!==offer.version||prior.version===Number.MAX_SAFE_INTEGER))return fail('VERSION_CONFLICT',true);const saved={...offer,version:prior?prior.version+1:0};await db.commerceOffers.put(saved);return {ok:true,data:saved};});
        }
        async function cart(){return (await db.commerceCarts.get(ownerId))||{id:ownerId,ownerId,version:0,lines:[]};}
        async function setCart(input){
            if(!input||!minor(input.expectedVersion)||input.expectedVersion===Number.MAX_SAFE_INTEGER||!Array.isArray(input.lines)||input.lines.length>100||new Set(input.lines.map(row=>row.offerId)).size!==input.lines.length
                ||input.lines.some(row=>!validId(row.offerId)||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>999))return fail('INVALID_CART');
            const lines=input.lines.map(row=>({offerId:row.offerId,quantity:row.quantity})),expected=input.expectedVersion;
            return transaction(async()=>{const prior=await cart();if(prior.version!==expected)return fail('VERSION_CONFLICT',true);const saved={id:ownerId,ownerId,version:prior.version+1,lines};await db.commerceCarts.put(saved);return {ok:true,data:saved};});
        }
        async function profile(){return (await db.commerceProfiles.get(ownerId))||{id:ownerId,version:0,addresses:[],consumption:{enabled:false,currency:'CNY',budgetMinor:0,periodMs:86400000,minimumIntervalMs:3600000}};}
        async function saveProfile(input){
            if(!input||!validProfile({id:ownerId,version:input.expectedVersion,addresses:input.addresses,consumption:input.consumption})||input.expectedVersion===Number.MAX_SAFE_INTEGER)return fail('INVALID_PROFILE');
            const captured=copy(input),policy=captured.consumption;
            return transaction(async()=>{const prior=await profile();if(prior.version!==captured.expectedVersion)return fail('VERSION_CONFLICT',true);const saved={id:ownerId,version:prior.version+1,addresses:captured.addresses.map(row=>({id:row.id,label:row.label,address:row.address})),consumption:policy};await db.commerceProfiles.put(saved);return {ok:true,data:saved};});
        }
        async function quote(input={}){
            const request=copy(input);
            return transaction(async()=>{
                abort(await active());const current=request.lines?{version:null,lines:request.lines}:await cart();if(!Array.isArray(current.lines)||current.lines.length>100||new Set(current.lines.map(row=>row.offerId)).size!==current.lines.length||current.lines.some(row=>!validId(row.offerId)||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>999))return fail('INVALID_CART');if(!current.lines.length)return fail('EMPTY_CART');
                if(request.offerIds!==undefined){
                    if(request.lines||!Array.isArray(request.offerIds)||!request.offerIds.length||request.offerIds.length>100||new Set(request.offerIds).size!==request.offerIds.length||request.offerIds.some(id=>!validId(id)||!current.lines.some(row=>row.offerId===id)))return fail('INVALID_CART');
                    current.lines=current.lines.filter(row=>request.offerIds.includes(row.offerId));
                }
                if(request.category){if(!['food','general'].includes(request.category))return fail('INVALID_QUERY');const all=await db.commerceOffers.bulkGet(current.lines.map(row=>row.offerId));if(request.offerIds&&all.some(row=>row?.category!==request.category))return fail('INVALID_CART');current.lines=current.lines.filter((row,index)=>all[index]?.category===request.category);if(!current.lines.length)return fail('EMPTY_CART');}
                const offers=await db.commerceOffers.bulkGet(current.lines.map(row=>row.offerId));const groups=new Map();
                for(let i=0;i<offers.length;i++){
                    const offer=offers[i],selected=current.lines[i];if(!validOffer(offer)||offer.archived||offer.stock<selected.quantity)return fail('OUT_OF_STOCK');
                    if(offer.marketKey&&offer.createdBy!==ownerId)return fail('FORBIDDEN');
                    const groupKey=JSON.stringify([offer.storeId,offer.category,offer.currency]);
                    if(!groups.has(groupKey))groups.set(groupKey,{storeId:offer.storeId,category:offer.category,currency:offer.currency,lines:[]});
                    groups.get(groupKey).lines.push({skuId:offer.id,name:offer.name,specification:offer.specification,factId:offer.factId,unitMinor:offer.unitMinor,offerVersion:offer.version,quantity:selected.quantity,refundedQuantity:0});
                }
                const selectedMarket=(await db.globalSettings.get('mioCatalogFactsV1'))?.value?.markets?.[ownerId],selectedMarketKey=selectedMarket?CatalogCore.marketKey(selectedMarket):null;
                if(offers.some(row=>row.marketKey&&row.marketKey!==selectedMarketKey))return fail('MARKET_MISMATCH');
                if(new Set(offers.map(row=>row.marketKey||'legacy')).size>1)return fail('MARKET_MISMATCH');
                if(new Set([...groups.values()].map(row=>row.currency)).size!==1)return fail('CURRENCY_MISMATCH');
                const ownProfile=await profile(),address=ownProfile.addresses.find(row=>row.id===request.addressId);
                if(!address)return fail('ADDRESS_REQUIRED');
                const recipient=request.recipientOwnerId??ownerId;if(!validId(recipient)||!await db.economyAccounts.where('ownerId').equals(recipient).count())return fail('INVALID_RECIPIENT');
                let total=0n;const children=[];
                for(const group of groups.values()){
                    const pricing=abort(CommerceCore.totals(group.lines,{deliveryMinor:offers.every(o=>o.generationYear&&o.generationYear<1980)?0:group.category==='food'?300:600,packagingMinor:offers.every(o=>o.generationYear&&o.generationYear<1980)?0:group.category==='food'?100:0}));
                    const allocations=abort(CommerceCore.allocate(pricing.subtotalMinor-pricing.discountMinor,group.lines.map(row=>row.unitMinor*row.quantity)));
                    group.lines.forEach((row,index)=>row.paidMinor=allocations[index]);total+=BigInt(pricing.totalMinor);
                    children.push({...group,...pricing,policy:copy(policies[group.category]),deliveryRule:copy(delivery)});
                }
                if(total>BigInt(Number.MAX_SAFE_INTEGER))return fail('INVALID_AMOUNT');
                const value={id:crypto.randomUUID(),kind:'quote',ownerId,marketKey:selectedMarketKey,cartVersion:current.version,sourceMessageFingerprint:request.sourceMessageFingerprint||null,recipientOwnerId:recipient,address:copy(address),currency:children[0].currency,totalMinor:Number(total),children,createdAt:Date.now(),expiresAt:Date.now()+300000,simulation:true};
                await db.commerceOperations.add(value);return {ok:true,data:value};
            });
        }
        async function checkout(input){
            if(!validId(input?.quoteId)||!validId(input.sourceAccountId)||!minor(input.expectedSourceVersion))return fail('INVALID_REQUEST');
            return operation('checkout',input,async(request,operationId)=>{
                const quote=await db.commerceOperations.get(request.quoteId);
                const currentMarket=(await db.globalSettings.get('mioCatalogFactsV1'))?.value?.markets?.[ownerId];if((quote?.marketKey||null)!==(currentMarket?CatalogCore.marketKey(currentMarket):null))abort(fail('MARKET_MISMATCH'));
                if(!quote||quote.kind!=='quote'||quote.ownerId!==ownerId||quote.usedBy||Date.now()>=quote.expiresAt)abort(fail('QUOTE_EXPIRED'));
                if(!Array.isArray(quote.children)||quote.children.some(child=>!validQuoteChild(child)||child.currency!==quote.currency)||quote.children.reduce((sum,row)=>sum+BigInt(row.totalMinor),0n)!==BigInt(quote.totalMinor))abort(fail('INVALID_QUOTE'));
                const current=await cart();if(quote.cartVersion!==null&&current.version!==quote.cartVersion)abort(fail('CART_CHANGED',true));
                let source=await db.economyAccounts.get(request.sourceAccountId);
                if(!source||source.currency!==quote.currency||source.ownerId!==ownerId&&!request.grantId)abort(fail('FORBIDDEN'));
                if(source.version!==request.expectedSourceVersion)abort(fail('VERSION_CONFLICT',true));
                if(ownerId!=='user'){
                    const policy=(await profile()).consumption,now=Date.now(),periodStart=now-now%policy.periodMs;
                    if(!policy.enabled)abort(fail('CONSUMPTION_DISABLED'));if(policy.currency!==quote.currency)abort(fail('CURRENCY_MISMATCH'));
                    const previous=await db.commerceBatches.where('[ownerId+createdAt]').between([ownerId,0],[ownerId,Number.MAX_SAFE_INTEGER],true,true).toArray();
                    const last=previous.reduce((max,row)=>Math.max(max,row.createdAt),0),spent=previous.filter(row=>row.createdAt>=periodStart&&row.currency===quote.currency).reduce((sum,row)=>sum+BigInt(row.totalMinor),0n);
                    if(now-last<policy.minimumIntervalMs||spent+BigInt(quote.totalMinor)>BigInt(policy.budgetMinor))abort(fail('CONSUMPTION_LIMIT'));
                }
                const batchId=crypto.randomUUID(),createdAt=Date.now(),orderIds=[];
                // Older clients must reject a commerce backup rather than silently discard its tables.
                const markerId=JSON.stringify(['system:commerce','activation-v1']);
                if(!await db.economyJournals.get(markerId)){
                    const markerOwner='system:commerce',idempotencyKey='activation-v1',receipt={journalId:markerId,kind:'commerce_activation',ownerId:markerOwner,protocol:1,occurredAt:createdAt};
                    await db.economyJournals.add({id:markerId,ownerId:markerOwner,idempotencyKey,kind:receipt.kind,orderId:null,occurredAt:createdAt,requestFingerprint:JSON.stringify({kind:receipt.kind,ownerId:markerOwner,idempotencyKey,protocol:1}),receipt});
                }
                for(const [index,child] of quote.children.entries()){
                    for(const line of child.lines){const offer=await db.commerceOffers.get(line.skuId);if(!offer||offer.version!==line.offerVersion||offer.unitMinor!==line.unitMinor||offer.storeId!==child.storeId||offer.currency!==child.currency||offer.category!==child.category||offer.stock<line.quantity||offer.version===Number.MAX_SAFE_INTEGER)abort(fail('QUOTE_CHANGED',true));await db.commerceOffers.put({...offer,stock:offer.stock-line.quantity,version:offer.version+1});}
                    const merchantAccountId=JSON.stringify(['merchant',child.storeId,child.currency]);
                    if(!await db.economyAccounts.get(merchantAccountId))await db.economyAccounts.add({id:merchantAccountId,ownerId:'system:merchant',ownerType:'system',kind:'merchant',currency:child.currency,balanceMinor:0,reservedMinor:0,status:'active',version:0});
                    const id=crypto.randomUUID(),order={id,batchId,storeId:child.storeId,buyerOwnerId:ownerId,payerOwnerId:source.ownerId,recipientOwnerId:quote.recipientOwnerId,merchantAccountId,...copy(child),address:quote.address,simulation:true,version:0,status:'pending_payment',paymentState:'unpaid',createdAt,refundedMinor:0,refundedFeesMinor:0,refundUntilAt:createdAt+child.policy.windowMs,fulfilmentStage:0};
                    await db.commerceOrders.add(order);const grant=request.grantId?await db.economyGrants.get(request.grantId):null;
                    abort(await global.EconomyStorage.forOwner(db,ownerId,{requireActivated:true}).payOrder({idempotencyKey:'checkout:'+batchId+':'+index,sourceAccountId:source.id,expectedSourceVersion:source.version,orderId:id,expectedOrderVersion:0,...(request.grantId?{grantId:request.grantId,expectedGrantVersion:grant?.version}:{})}));
                    const paid=await db.commerceOrders.get(id);await db.commerceOrders.put({...paid,deliverySchedule:abort(CommerceCore.deliverySchedule(createdAt,child.deliveryRule))});
                    source=await db.economyAccounts.get(source.id);orderIds.push(id);
                }
                const batch={id:batchId,ownerId,payerOwnerId:source.ownerId,currency:quote.currency,totalMinor:quote.totalMinor,orderIds,createdAt,quoteId:quote.id,operationId,simulation:true};
                await db.commerceBatches.add(batch);await db.commerceOperations.put({...quote,usedBy:batchId});if(quote.cartVersion!==null)await db.commerceCarts.put({...current,version:current.version+1,lines:current.lines.filter(row=>!quote.children.some(child=>child.lines.some(line=>line.skuId===row.offerId)))});return batch;
            });
        }
        async function refreshDelivery(orderId){
            return transaction(async()=>{const order=await db.commerceOrders.get(orderId);if(!order||![order.buyerOwnerId,order.payerOwnerId,order.recipientOwnerId].includes(ownerId))return fail('FORBIDDEN');if(order.paymentState==='refunded'||order.status==='cancelled')return {ok:true,data:order};
                const state=CommerceCore.deliveryState(order.deliverySchedule,Date.now(),order.fulfilmentStage??0);if(!state.ok)return state;
                const saved={...order,status:state.data.status,fulfilmentStage:state.data.stage,version:order.version+(state.data.status!==order.status?1:0)};if(saved.status!==order.status)await db.commerceOrders.put(saved);return {ok:true,data:saved};});
        }
        async function settleAfterSale(row,order,operationId){
            const quantities=abort(CommerceCore.refundLines(order,row.selections,row.includeFees));
            abort(await global.EconomyRefundStorage.forOwner(db,ownerId,{requireActivated:true}).refund({orderId:order.id,expectedOrderVersion:order.version,amountMinor:quantities.amountMinor,idempotencyKey:'after-sale:'+row.id}));
            const paid=await db.commerceOrders.get(order.id);
            await db.commerceOrders.put({...paid,lines:quantities.lines,refundedFeesMinor:quantities.refundedFeesMinor,status:quantities.all&&row.includeFees?'cancelled':paid.status});
            if(row.includeFees||order.policy.restock)for(const selected of row.selections){const offer=await db.commerceOffers.get(selected.skuId);if(offer)await db.commerceOffers.put({...offer,stock:offer.stock+selected.quantity,version:offer.version+1});}
            const saved={...row,state:'refunded',amountMinor:quantities.amountMinor,settledAt:Date.now(),settlementOperationId:operationId};await db.commerceAfterSales.put(saved);return saved;
        }
        async function requestAfterSale(input){
            if(!validId(input?.orderId)||!minor(input.expectedOrderVersion)||!Array.isArray(input.selections)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)return fail('INVALID_REQUEST');
            return operation('after_sale',input,async(request,operationId)=>{
                const order=await db.commerceOrders.get(request.orderId);if(!order||![order.buyerOwnerId,order.payerOwnerId].includes(ownerId))abort(fail('FORBIDDEN'));
                if(order.version!==request.expectedOrderVersion)abort(fail('VERSION_CONFLICT',true));
                if((await db.commerceAfterSales.where('orderId').equals(order.id).toArray()).some(row=>['pending_review','awaiting_return'].includes(row.state)))abort(fail('AFTER_SALE_PENDING'));
                const current=abort(CommerceCore.deliveryState(order.deliverySchedule,Date.now(),order.fulfilmentStage??0)),includeFees=current.stage===0;
                const allowed=abort(CommerceCore.refundLines(order,request.selections,includeFees));
                const row={id:crypto.randomUUID(),orderId:order.id,ownerId,payerOwnerId:order.payerOwnerId,currency:order.currency,selections:request.selections,reason:request.reason,amountMinor:allowed.amountMinor,includeFees,createdAt:Date.now(),state:includeFees?'requested':current.stage===4&&order.policy.requiresReturn?'awaiting_return':'pending_review',version:0};
                if(Date.now()>order.refundUntilAt)row.state='pending_review';
                await db.commerceAfterSales.add(row);
                return row.state==='requested'?settleAfterSale(row,order,operationId):row;
            });
        }
        async function confirmReturn(input){
            if(!validId(input?.afterSaleId)||input.confirmed!==true)return fail('RETURN_CONFIRMATION_REQUIRED');
            return operation('return_received',input,async(request,id)=>{const row=await db.commerceAfterSales.get(request.afterSaleId),order=row&&await db.commerceOrders.get(row.orderId);if(!row||!order||row.ownerId!==ownerId||row.state!=='awaiting_return')abort(fail('INVALID_STATE'));return settleAfterSale(row,order,id);});
        }
        async function reviewAfterSale(input){
            if(!capabilities.manage||!validId(input?.afterSaleId)||typeof input.approved!=='boolean'||typeof input.reason!=='string'||!input.reason.trim())return fail('FORBIDDEN');
            return operation('review_after_sale',input,async(request,id)=>{const row=await db.commerceAfterSales.get(request.afterSaleId),order=row&&await db.commerceOrders.get(row.orderId);if(!row||!order||row.ownerId!==ownerId||row.state!=='pending_review')abort(fail('INVALID_STATE'));const reviewed={...row,reviewReason:request.reason,reviewedAt:Date.now(),state:request.approved?'requested':'rejected'};if(request.approved)return settleAfterSale(reviewed,order,id);await db.commerceAfterSales.put(reviewed);return reviewed;});
        }
        async function list(table,offset=0,limit=30,category){
            if(!minor(offset)||!Number.isSafeInteger(limit)||limit<1||limit>100)return fail('INVALID_QUERY');
            if(table!=='commerceOrders')return {ok:true,data:await db.commerceAfterSales.where('ownerId').equals(ownerId).offset(offset).limit(limit).toArray()};
            const groups=await Promise.all(['payerOwnerId','buyerOwnerId','recipientOwnerId'].map(field=>db.commerceOrders.where('['+field+'+createdAt]').between([ownerId,0],[ownerId,Number.MAX_SAFE_INTEGER],true,true).reverse().filter(row=>!category||row.category===category).limit(offset+limit).toArray()));
            const unique=[...new Map(groups.flat().map(row=>[row.id,row])).values()].sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
            return {ok:true,data:unique.slice(offset,offset+limit)};
        }
        function catalogQuery({category,search='',storeId,menuCategory,marketKey,available=false}={}){
            const query=category?db.commerceOffers.where('category').equals(category):db.commerceOffers.orderBy(':id');
            return query.filter(row=>!row.archived&&(!row.marketKey||row.createdBy===ownerId)&&(marketKey===undefined?!row.marketKey:row.marketKey===marketKey)&&(!storeId||row.storeId===storeId)&&(!menuCategory||row.menuCategory===menuCategory)&&(!available||row.stock>0)&&(!search||[row.name,row.storeId,row.specification].some(value=>String(value).toLowerCase().includes(String(search).toLowerCase()))));
        }
        async function offers(options={}){
            const {offset=0,limit=30}=options;if(!minor(offset)||!Number.isSafeInteger(limit)||limit<1||limit>100)return fail('INVALID_QUERY');
            return {ok:true,data:await catalogQuery(options).offset(offset).limit(limit).toArray()};
        }
        async function stores(options={}){
            const {offset=0,limit=30}=options;if(!minor(offset)||!Number.isSafeInteger(limit)||limit<1||limit>100)return fail('INVALID_QUERY');
            // Page stores, not their SKUs. Keep only a small preview for each store.
            const groups=new Map();
            await catalogQuery(options).each(offer=>{
                if(!groups.has(offer.storeId))groups.set(offer.storeId,{storeId:offer.storeId,cover:offer,names:[],hasFacts:false,hasAI:false,count:0});
                const group=groups.get(offer.storeId);group.count++;group.hasFacts ||= !!offer.factId;group.hasAI ||= offer.origin==='ai';if(group.names.length<3)group.names.push(offer.name);
            });
            return {ok:true,data:[...groups.values()].sort((a,b)=>a.storeId.localeCompare(b.storeId)).slice(offset,offset+limit)};
        }
        async function categories(options={}){
            const names=new Set();await catalogQuery({...options,menuCategory:undefined}).each(row=>{if(row.menuCategory)names.add(row.menuCategory);});
            return {ok:true,data:[...names].sort((a,b)=>a.localeCompare(b))};
        }
        return Object.freeze({receipt:async key=>{const row=await db.commerceOperations.get(JSON.stringify([ownerId,'checkout',key]));if(!row)return null;return {batch:row.receipt,quote:await db.commerceOperations.get(row.receipt.quoteId)};},offer:id=>db.commerceOffers.get(id),upsertOffer,cart,setCart,profile,saveProfile,quote,checkout,refreshDelivery,requestAfterSale,confirmReturn,reviewAfterSale,orders:(offset,limit,category)=>list('commerceOrders',offset,limit,category),afterSales:(offset,limit)=>list('commerceAfterSales',offset,limit),offers,stores,categories});
    }
    function validateBackup(snapshot,invalid){
        const map=key=>new Map((snapshot[key]||[]).map(row=>[row.id,row]));
        const batches=map('commerceBatches'),orders=map('commerceOrders'),operations=map('commerceOperations'),journals=map('economyJournals');
        if(batches.size){const marker=journals.get(JSON.stringify(['system:commerce','activation-v1']));if(marker?.kind!=='commerce_activation')invalid();}
        for(const offer of snapshot.commerceOffers||[])if(!validOffer(offer))invalid();
        for(const profile of snapshot.commerceProfiles||[])if(!validProfile(profile))invalid();
        for(const cart of snapshot.commerceCarts||[])if(cart.id!==cart.ownerId||!minor(cart.version)||!Array.isArray(cart.lines)||cart.lines.length>100||new Set(cart.lines.map(row=>row.offerId)).size!==cart.lines.length||cart.lines.some(row=>!validId(row.offerId)||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>999))invalid();
        for(const operation of operations.values()){
            if(!validId(operation.ownerId))invalid();
            if(operation.kind==='quote'){
                if(operation.simulation!==true||!minor(operation.createdAt)||!minor(operation.expiresAt)||operation.expiresAt<=operation.createdAt||operation.cartVersion!==null&&!minor(operation.cartVersion)||!Array.isArray(operation.children)||!operation.children.length||operation.children.some(child=>!validQuoteChild(child)||child.currency!==operation.currency)||operation.children.reduce((sum,row)=>sum+BigInt(row.totalMinor),0n)!==BigInt(operation.totalMinor)||operation.usedBy&&!batches.has(operation.usedBy))invalid();
            }else{
                let request;try{request=JSON.parse(operation.fingerprint);}catch(_){invalid();}
                if(!['checkout','after_sale','return_received','review_after_sale'].includes(operation.kind)||operation.id!==JSON.stringify([operation.ownerId,operation.kind,request.idempotencyKey])||!operation.receipt)invalid();
                if(operation.kind==='checkout'&&!batches.has(operation.receipt.id))invalid();
            }
        }
        for(const batch of batches.values()){
            if(!validId(batch.ownerId)||!validId(batch.payerOwnerId)||!minor(batch.createdAt)||batch.simulation!==true||!minor(batch.totalMinor)||!batch.totalMinor||!Array.isArray(batch.orderIds)||!batch.orderIds.length||new Set(batch.orderIds).size!==batch.orderIds.length||operations.get(batch.quoteId)?.usedBy!==batch.id||operations.get(batch.operationId)?.receipt.id!==batch.id)invalid();
            let total=0n;
            for(const id of batch.orderIds){const order=orders.get(id);if(!order||order.batchId!==batch.id||order.buyerOwnerId!==batch.ownerId||order.payerOwnerId!==batch.payerOwnerId||order.currency!==batch.currency)invalid();total+=BigInt(order.totalMinor);}
            if(total!==BigInt(batch.totalMinor))invalid();
        }
        const refunds=new Map(),quantities=new Map();
        for(const row of snapshot.commerceAfterSales||[]){
            const order=orders.get(row.orderId);if(!order||!order.batchId||![order.buyerOwnerId,order.payerOwnerId].includes(row.ownerId)||row.payerOwnerId!==order.payerOwnerId||row.currency!==order.currency||!['pending_review','awaiting_return','refunded','rejected'].includes(row.state)||!minor(row.amountMinor)||!row.amountMinor||!Array.isArray(row.selections)||!row.selections.length||new Set(row.selections.map(line=>line.skuId)).size!==row.selections.length)invalid();
            for(const line of row.selections)if(!order.lines.some(item=>item.skuId===line.skuId)||!Number.isSafeInteger(line.quantity)||line.quantity<1)invalid();
            if(row.state==='refunded'){
                const journal=journals.get(JSON.stringify([row.ownerId,'after-sale:'+row.id]));if(!journal||journal.kind!=='order_refund'||journal.orderId!==order.id||journal.receipt.amountMinor!==row.amountMinor||!operations.has(row.settlementOperationId))invalid();
                refunds.set(order.id,(refunds.get(order.id)||0n)+BigInt(row.amountMinor));
                for(const line of row.selections){const key=JSON.stringify([order.id,line.skuId]);quantities.set(key,(quantities.get(key)||0)+line.quantity);}
            }
        }
        for(const order of orders.values())if(order.batchId){
            if(!batches.get(order.batchId)?.orderIds.includes(order.id)||!policies[order.category]||order.policy?.version!==policies[order.category].version||order.simulation!==true||!Array.isArray(order.lines)||!order.lines.length||new Set(order.lines.map(row=>row.skuId)).size!==order.lines.length)invalid();
            const totals=CommerceCore.totals(order.lines,order);if(!totals.ok||Object.keys(totals.data).some(key=>order[key]!==totals.data[key]))invalid();
            let paid=0n;
            for(const line of order.lines){if(!minor(line.paidMinor)||!minor(line.refundedQuantity)||line.refundedQuantity>line.quantity||line.refundedQuantity!==(quantities.get(JSON.stringify([order.id,line.skuId]))||0))invalid();paid+=BigInt(line.paidMinor);}
            if(paid!==BigInt(order.subtotalMinor-order.discountMinor)||(refunds.get(order.id)||0n)!==BigInt(order.refundedMinor))invalid();
            if(!CommerceCore.deliveryState(order.deliverySchedule,Date.now(),order.fulfilmentStage).ok||order.deliverySchedule.ruleVersion!==order.deliveryRule?.version)invalid();
        }
    }
    global.CommerceStorage=Object.freeze({forOwner,validOffer,policies,delivery,validateBackup});
})(typeof window!=='undefined'?window:globalThis);
