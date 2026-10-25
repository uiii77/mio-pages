// WalletSystem host adapter. Legacy evidence is never overwritten with ledger projections.
(function(global){
    'use strict';
    const projections=new Map();let currentMode=null;
    const failure=code=>({ok:false,error:{code,retryable:code==='VERSION_CONFLICT'},reason:code});
    async function mode(){const state=await dexieDB.walletControl.get('state');currentMode=WalletStorage.resolveControl(state,await dexieDB.economyAccounts.count()>0).mode;return currentMode;}
    async function refresh(ownerId='user'){
        const read=await WalletStorage.forDatabase(dexieDB,db).read(ownerId);if(read.ok){projections.set(ownerId,read.data);currentMode=read.data.mode;if(currentMode==='ledger'){read.data.defaultCurrency=(await dexieDB.walletControl.get('state'))?.preferences?.[ownerId]||'CNY';read.data.grants=await WalletGrants.forOwner(dexieDB,ownerId).list();read.data.catalog=(await CommerceStorage.forOwner(dexieDB,ownerId).offers({limit:12,marketKey:await Catalog.forDatabase(dexieDB).market(ownerId).then(value=>value?CatalogCore.marketKey(value):undefined)})).data||[];}}return read;
    }
    async function command(input){
        if(await mode()==='legacy')return WalletStorage.forDatabase(dexieDB,db).execute(input);
        if(!input||typeof input.ownerId!=='string'||typeof input.idempotencyKey!=='string')return failure('INVALID_REQUEST');
        const ownerId=input.ownerId,id=JSON.stringify([ownerId,input.idempotencyKey]);
        if(input.kind==='preferences'){
            if(!CurrencyCore.isSupported(input.currency)||CurrencyCore.currency(input.currency)!==input.currency)return failure('UNSUPPORTED_CURRENCY');
            return dexieDB.transaction('rw',dexieDB.walletControl,dexieDB.economyAccounts,async()=>{const state=await dexieDB.walletControl.get('state');if(state?.mode!=='ledger')return failure('WALLET_FROZEN');if(!await dexieDB.economyAccounts.where('ownerId').equals(ownerId).count())return failure('INVALID_ACCOUNT');if(state.preferences?.[ownerId]!==input.currency){if(state.version===Number.MAX_SAFE_INTEGER)return failure('VERSION_CONFLICT');await dexieDB.walletControl.put({...state,version:state.version+1,preferences:{...state.preferences,[ownerId]:input.currency}});}if(projections.has(ownerId))projections.get(ownerId).defaultCurrency=input.currency;return {ok:true,data:{currency:input.currency}};});
        }
        const sourceId=input.sourceAccountId||JSON.stringify(['wallet',ownerId,input.sourceCurrency||'CNY']);
        const source=await dexieDB.economyAccounts.get(sourceId),prior=await dexieDB.economyJournals.get(id);
        const api=EconomyStorage.forOwner(dexieDB,ownerId,{requireActivated:true,manage:input.confirmed===true});let result;
        if(input.kind==='set'&&ownerId==='user'&&input.confirmed===true){
            if(!source)return failure('INVALID_ACCOUNT');
            if(prior){if(prior.kind!=='adjustment'||prior.receipt.balanceAfterMinor!==input.amountMinor)return failure('IDEMPOTENCY_CONFLICT');return {ok:true,data:prior.receipt};}
            if(source.balanceMinor===input.amountMinor)return {ok:true,data:{unchanged:true}};
            result=await api.adjustBalance({sourceAccountId:source.id,expectedSourceVersion:source.version,targetBalanceMinor:input.amountMinor,reason:input.remark||'用户调整余额',idempotencyKey:input.idempotencyKey});
        }else if(input.kind==='post'&&ownerId==='user'&&input.direction==='income'&&input.confirmed===true){
            if(!source)return failure('INVALID_ACCOUNT');
            if(prior){if(prior.kind!=='income'||prior.receipt.deltaMinor!==input.amountMinor)return failure('IDEMPOTENCY_CONFLICT');return {ok:true,data:prior.receipt};}
            result=await api.postIncome({sourceAccountId:source.id,expectedSourceVersion:source.version,amountMinor:input.amountMinor,reason:input.remark||'用户存入',idempotencyKey:input.idempotencyKey});
        }else if(input.kind==='exchange'){
            if(!source)return failure('INVALID_ACCOUNT');
            const targetId=JSON.stringify(['wallet',input.targetOwnerId,input.targetCurrency]);
            if(prior){const receipt=prior.receipt;if(prior.kind!=='exchange'||receipt.sourceAccountId!==sourceId||receipt.targetAccountId!==targetId||receipt.amountMinor!==input.amountMinor||receipt.rateSnapshot?.rateScaled!==CurrencyCore.rateToScaled(input.rate)||(JSON.parse(prior.requestFingerprint).reason||'')!==(input.remark||''))return failure('IDEMPOTENCY_CONFLICT');return {ok:true,data:receipt};}
            try{result=await dexieDB.transaction('rw',Object.keys(EconomySchema.runtimeTables).map(key=>dexieDB[key]),async()=>{
                let target=await dexieDB.economyAccounts.get(targetId);
                if(!target){
                    if(!CurrencyCore.isSupported(input.targetCurrency)||CurrencyCore.currency(input.targetCurrency)!==input.targetCurrency)return failure('UNSUPPORTED_CURRENCY');
                    const existing=await dexieDB.economyAccounts.where('ownerId').equals(input.targetOwnerId).toArray();
                    if(!existing.some(row=>row.kind==='wallet'&&row.status==='active'))return failure('INVALID_ACCOUNT');
                    target={id:targetId,ownerId:input.targetOwnerId,ownerType:input.targetOwnerId==='user'?'user':'character',kind:'wallet',currency:input.targetCurrency,balanceMinor:0,reservedMinor:0,status:'active',version:0};
                    await dexieDB.economyAccounts.add(target);
                    const key='currency:'+input.idempotencyKey,journalId=JSON.stringify([ownerId,key]),occurredAt=Date.now(),receipt={journalId,kind:'currency_account_open',ownerId,accountId:targetId,currency:target.currency,occurredAt};
                    await dexieDB.economyJournals.add({id:journalId,kind:receipt.kind,ownerId,idempotencyKey:key,orderId:null,occurredAt,requestFingerprint:JSON.stringify({kind:receipt.kind,ownerId,idempotencyKey:key,accountId:targetId}),receipt});
                    await dexieDB.economyOutbox.add({eventId:journalId,ownerId,type:receipt.kind,state:'pending',attempts:0,payload:receipt});
                }
                const exchanged=await api.exchange({sourceAccountId:source.id,targetAccountId:target.id,expectedSourceVersion:source.version,amountMinor:input.amountMinor,rate:input.rate,reason:input.remark||'',idempotencyKey:input.idempotencyKey});
                if(!exchanged.ok)throw Object.assign(Error(exchanged.error.code),{domainResult:exchanged});return exchanged;
            });}catch(error){result=error.domainResult||failure('PERSISTENCE_FAILED');}
        }else if(['reserve_transfer','accept_transfer','return_transfer','expire_transfer'].includes(input.kind)){
            const method={reserve_transfer:'reserveTransfer',accept_transfer:'acceptTransfer',return_transfer:'returnTransfer',expire_transfer:'expireTransfer'}[input.kind];
            result=await api[method]({...input,sourceAccountId:sourceId,expectedSourceVersion:input.expectedSourceVersion??source?.version});
        }else return failure('ORDER_OR_TRANSFER_REQUIRED');
        if(result.ok){await refresh(ownerId);if(input.targetOwnerId)await refresh(input.targetOwnerId);}else result.reason=result.error.code;
        return result;
    }
    async function fxHistory(ownerId,otherOwnerId){
        const items=[],seen=new Set();let offset=0;const cutoff=Date.now();
        while(items.length<20){
            const rows=await dexieDB.economyPostings.where('[ownerId+occurredAt]').between([ownerId,0],[ownerId,cutoff],true,true).reverse().offset(offset).limit(100).toArray();if(!rows.length)break;offset+=rows.length;
            const journals=await dexieDB.economyJournals.bulkGet([...new Set(rows.map(row=>row.journalId))]);
            for(const journal of journals){if(!journal||journal.kind!=='exchange'||seen.has(journal.id))continue;seen.add(journal.id);const receipt=journal.receipt,[source,target]=await dexieDB.economyAccounts.bulkGet([receipt.sourceAccountId,receipt.targetAccountId]);if(!source||!target||otherOwnerId&&![source.ownerId,target.ownerId].includes(otherOwnerId))continue;const request=JSON.parse(journal.requestFingerprint);items.push({id:journal.id,type:source.ownerId===ownerId?'send':'receive',fromOwnerId:source.ownerId,toOwnerId:target.ownerId,fromCurrency:source.currency,toCurrency:target.currency,sourceAmountMinor:receipt.amountMinor,targetAmountMinor:receipt.targetAmountMinor,createdAt:receipt.occurredAt,remark:request.reason||''});if(items.length===20)break;}
        }
        return items;
    }
    async function install(){
        Object.assign(WalletSystem,{saveCatalogOffer:input=>CommerceStorage.forOwner(dexieDB,'user',{manage:true}).upsertOffer(input),command,fxHistory,read:refresh,chat:ownerId=>WalletChat.forOwner(dexieDB,ownerId),grants:ownerId=>WalletGrants.forOwner(dexieDB,ownerId||'user'),reviewAfterSale:(ownerId,input)=>CommerceStorage.forOwner(dexieDB,ownerId,{manage:true}).reviewAfterSale(input),accounts:async ownerId=>(await refresh(ownerId)).data?.accounts||[],account:async id=>dexieDB.economyAccounts.get(id),commerce:ownerId=>CommerceStorage.forOwner(dexieDB,ownerId||'user'),refresh,history:async(ownerId,offset=0,limit=30)=>{if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return [];return dexieDB.economyPostings.where('[ownerId+occurredAt]').between([ownerId,0],[ownerId,Number.MAX_SAFE_INTEGER],true,true).reverse().offset(offset).limit(limit).toArray();},mode});
        await mode();if(currentMode!=='legacy'){await refresh();void global.CurrencyTransfer?.render();}
    }
    global.WalletLedger=Object.freeze({install,mode,refresh,snapshot:ownerId=>projections.has(ownerId)?structuredClone(projections.get(ownerId)):undefined,cachedMode:()=>currentMode,balance:ownerId=>{const value=projections.get(ownerId);const account=value?.accounts.find(row=>row.currency==='CNY');return value?.mode==='ledger'&&Number.isSafeInteger(account?.balanceMinor)?account.balanceMinor/100:null;}});
})(window);
