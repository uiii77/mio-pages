// Authorization metadata, never extra money. Identity is supplied by the host UI.
(function(global){
    'use strict';
    const fail=code=>({ok:false,error:{code,retryable:code==='VERSION_CONFLICT'}});
    function forOwner(database,ownerId){
        async function list(){const rows=await database.economyGrants.toArray();return rows.filter(row=>row.ownerId===ownerId||row.granteeOwnerId===ownerId);}
        async function change(input){
            if(!input||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>200||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)return fail('INVALID_REQUEST');
            const captured=JSON.parse(JSON.stringify(input)),journalId=JSON.stringify([ownerId,captured.idempotencyKey]);
            const request={kind:'grant_change',ownerId,idempotencyKey:captured.idempotencyKey,action:captured.action,grantId:captured.grantId,expectedVersion:captured.expectedVersion,...(captured.action==='issue'?{payerAccountId:captured.payerAccountId,granteeOwnerId:captured.granteeOwnerId,limitMinor:captured.limitMinor,periodKind:captured.periodKind,days:captured.days}:captured.action==='limit'?{limitMinor:captured.limitMinor}:{})};
            const fingerprint=JSON.stringify(request);
            try{return await database.transaction('rw',Object.keys(EconomySchema.runtimeTables).map(key=>database[key]),async()=>{
                const previous=await database.economyJournals.get(journalId);if(previous)return previous.requestFingerprint===fingerprint?{ok:true,data:previous.receipt}:fail('IDEMPOTENCY_CONFLICT');
                const state=await database.walletControl.get('state');if(WalletStorage.resolveControl(state,true).mode!=='ledger'||state.quarantinedOwnerIds?.includes(ownerId))return fail('WALLET_FROZEN');
                const old=await database.economyGrants.get(request.grantId),now=Date.now();let grant;
                if(request.action==='issue'){
                    const account=await database.economyAccounts.get(request.payerAccountId);
                    if(old||!account||account.ownerId!==ownerId||account.kind!=='wallet'||account.status!=='active'||!await database.economyAccounts.where('ownerId').equals(request.granteeOwnerId||'').count()||state.quarantinedOwnerIds?.includes(request.granteeOwnerId))return fail('INVALID_GRANT');
                    grant={id:request.grantId,ownerId,payerAccountId:account.id,granteeOwnerId:request.granteeOwnerId,currency:account.currency,status:'pending',limitMinor:request.limitMinor,usedMinor:0,version:0,actions:['pay_order'],legacyTransactions:[],periodHistory:[],period:{kind:request.periodKind,clockBasis:'legacy-local',startAt:now,endAt:EconomyGrantCore.nextPeriodBoundary(now,request.periodKind,request.days),days:request.days}};
                }else{
                    if(!old||old.version!==request.expectedVersion)return fail('VERSION_CONFLICT');
                    if(['revoked','returned','replaced'].includes(old.status))return fail('INVALID_STATE');
                    grant={...old,version:old.version+1};
                    if(ownerId===old.ownerId){
                        if(request.action==='freeze'&&old.status==='active')grant.status='frozen';
                        else if(request.action==='unfreeze'&&old.status==='frozen')grant.status='active';
                        else if(request.action==='revoke')grant.status='revoked';
                        else if(request.action==='limit'&&Number.isSafeInteger(request.limitMinor)&&request.limitMinor>=old.usedMinor)grant.limitMinor=request.limitMinor;
                        else return fail('INVALID_STATE');
                    }else if(ownerId===old.granteeOwnerId){
                        if(request.action==='accept'&&old.status==='pending')grant.status='active';
                        else if(request.action==='return')grant.status='returned';else return fail('INVALID_STATE');
                    }else return fail('FORBIDDEN');
                }
                if(!EconomyGrantCore.valid(grant))return fail('INVALID_GRANT');
                const receipt={journalId,kind:'grant_change',ownerId,grantId:grant.id,action:request.action,before:old||null,after:grant,occurredAt:now};
                await database.economyGrants.put(grant);await database.economyJournals.add({id:journalId,kind:receipt.kind,ownerId,idempotencyKey:request.idempotencyKey,requestFingerprint:fingerprint,orderId:null,occurredAt:now,receipt});
                await database.economyOutbox.add({eventId:journalId,ownerId,type:'grant_change',state:'pending',attempts:0,payload:receipt});return {ok:true,data:receipt};
            });}catch(_){return fail('PERSISTENCE_FAILED');}
        }
        return Object.freeze({list,change});
    }
    async function processMessage(character,message){
        if(message.role!=='assistant'||message.familyCardActionProcessed)return null;
        const content=String(message.content||''),response=content.match(/^\[(.*?)(接收|退还)(.*?)的亲属卡\]$/),management=content.match(/^\[(.*?)(冻结了|解冻了|收回了)亲属卡\]$/),limit=content.match(/^\[(.*?)调整亲属卡额度为[：:]([\d.]+)元?\]$/);
        const match=response||management||limit;if(!match||match[1].trim()!==String(character.realName||'').trim()||await WalletSystem.mode()==='legacy')return null;
        if(response&&response[3].trim()!==String(character.myName||'').trim())return null;
        const actorId=String(character.id),action=response?(response[2]==='接收'?'accept':'return'):management?({'冻结了':'freeze','解冻了':'unfreeze','收回了':'revoke'})[management[2]]:'limit',key='grant-message:'+message.id;
        const prior=await dexieDB.economyJournals.get(JSON.stringify([actorId,key]));
        if(prior){if(prior.kind!=='grant_change'||prior.receipt.action!==action)return {ok:false,error:{code:'IDEMPOTENCY_CONFLICT'}};message.ledgerGrantHandled=true;message.familyCardActionProcessed=true;return {ok:true,data:prior.receipt};}
        const api=forOwner(dexieDB,actorId),grants=(await api.list()).filter(row=>response?row.ownerId==='user'&&row.granteeOwnerId===actorId&&(action==='accept'?row.status==='pending':['pending','active','frozen'].includes(row.status)):row.ownerId===actorId&&row.granteeOwnerId==='user'&&['pending','active','frozen'].includes(row.status));
        if(grants.length!==1)return {ok:false,error:{code:'GRANT_SELECTION_REQUIRED'}};
        const grant=grants[0],result=await api.change({action,grantId:grant.id,expectedVersion:grant.version,idempotencyKey:key,...(limit?{limitMinor:CurrencyCore.amountToMinor(limit[2],grant.currency)}:{})});
        if(result.ok){message.ledgerGrantHandled=true;message.familyCardActionProcessed=true;for(const row of character.history||[])if(row.familyCardId===grant.id)row.familyCardStatus=action==='accept'?'accepted':action==='return'?'returned':row.familyCardStatus;}
        else message.financialActionFailed=result.error.code;
        return result;
    }
    global.WalletGrants=Object.freeze({forOwner,processMessage});
})(window);
