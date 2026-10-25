// Internal WalletSystem adapter. Not loaded by the application until legacy writers are migrated.
(function attachEconomyStorage(global) {
    'use strict';
    const schema = global.EconomySchema.runtimeTables || global.EconomySchema.tables;
    const fail = (code, retryable = false) => ({ ok: false, error: { code, retryable } });
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
    const validReference=value=>typeof value==='string' && value.length>0 && value.length<=4096 && value.trim()===value;
    const version = value => Number.isSafeInteger(value) && value >= 0;
    const wallet = account => account && account.kind === 'wallet' && ['user', 'character'].includes(account.ownerType);

    // ownerId is supplied by trusted host code, never taken from an LLM or payment form.
    // This slice permits spending one's own account only; grants/autonomous policy come later.
    function forOwner(database, ownerId, capabilities={}) {
        if (!validId(ownerId) || !database || typeof database.transaction !== 'function'
            || Object.keys(schema).some(name => !database[name])) throw new TypeError('Invalid economy store binding');
        const db = database;
        const canManage=capabilities.manage===true;
        const requireActivated=capabilities.requireActivated===true;
        async function execute(kind, input) {
            if (!input || !validId(input.idempotencyKey) || !validId(input.sourceAccountId)
                || !version(input.expectedSourceVersion)) return fail('INVALID_REQUEST');
            // Copy only supported primitive fields before the first await. No caller mutation races.
            const request = { kind, ownerId, sourceAccountId: input.sourceAccountId,
                expectedSourceVersion: input.expectedSourceVersion, idempotencyKey: input.idempotencyKey };
            if (kind === 'transfer') {
                if (!validId(input.targetAccountId) || input.targetAccountId === input.sourceAccountId
                    || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return fail('INVALID_REQUEST');
                Object.assign(request, { targetAccountId: input.targetAccountId, amountMinor: input.amountMinor });
            } else {
                if (!validId(input.orderId) || !version(input.expectedOrderVersion)) return fail('INVALID_REQUEST');
                Object.assign(request, { orderId: input.orderId, expectedOrderVersion: input.expectedOrderVersion });
                if (input.grantId != null) {
                    if (!validId(input.grantId) || !version(input.expectedGrantVersion)) return fail('INVALID_REQUEST');
                    Object.assign(request, { grantId: input.grantId, expectedGrantVersion: input.expectedGrantVersion });
                }
            }
            // Exact canonical supported-field serialization, not a lossy/noncryptographic hash.
            const requestFingerprint = JSON.stringify(request);
            const journalId = JSON.stringify([ownerId, request.idempotencyKey]);
            try {
                return await db.transaction('rw', Object.keys(schema).map(name => db[name]), async () => {
                    const prior = await db.economyJournals.get(journalId);
                    if (prior) return prior.requestFingerprint === requestFingerprint
                        ? { ok: true, data: prior.receipt } : fail('IDEMPOTENCY_CONFLICT');
                    const state=db.walletControl?await db.walletControl.get('state'):null;
                    if(state?.mode==='frozen' || requireActivated && global.WalletStorage?.resolveControl(state,true).mode!=='ledger')return fail('WALLET_FROZEN');
                    if(state?.quarantinedOwnerIds?.includes(ownerId))return fail('ACCOUNT_ISOLATED');
                    const source = await db.economyAccounts.get(request.sourceAccountId);
                    if (!wallet(source) || source.ownerId !== ownerId && !request.grantId) return fail('FORBIDDEN');
                    if (source.version !== request.expectedSourceVersion) return fail('VERSION_CONFLICT', true);
                    let target, order = null, amountMinor, grantUpdate = null;
                    if (kind === 'transfer') {
                        target = await db.economyAccounts.get(request.targetAccountId);
                        if (!wallet(target)) return fail('INVALID_ACCOUNT');
                        amountMinor = request.amountMinor;
                    } else {
                        order = await db.commerceOrders.get(request.orderId);
                        if (!order || order.payerOwnerId !== source.ownerId || request.grantId && order.buyerOwnerId !== ownerId) return fail('FORBIDDEN');
                        if (order.version !== request.expectedOrderVersion) return fail('VERSION_CONFLICT', true);
                        if (order.status !== 'pending_payment' || order.paymentState !== 'unpaid' || order.paymentJournalId) return fail('INVALID_STATE');
                        if (order.currency !== source.currency) return fail('CURRENCY_MISMATCH');
                        if (!Number.isSafeInteger(order.totalMinor) || order.totalMinor <= 0
                            || order.version === Number.MAX_SAFE_INTEGER) return fail('INVALID_AMOUNT');
                        target = await db.economyAccounts.get(order.merchantAccountId);
                        if (!target || target.ownerType !== 'system' || target.kind !== 'merchant') return fail('INVALID_ACCOUNT');
                        amountMinor = order.totalMinor;
                        if (request.grantId) {
                            const grant = await db.economyGrants.get(request.grantId);
                            if (!grant || grant.ownerId !== source.ownerId || grant.currency !== source.currency) return fail('INVALID_GRANT');
                            if(grant.version!==request.expectedGrantVersion)return fail('VERSION_CONFLICT',true);
                            const advanced=global.EconomyGrantCore.advance(grant,Date.now());
                            if(!advanced.ok)return advanced;
                            const authorized = global.EconomyGrantCore.authorize(advanced.data, ownerId, source.id, amountMinor, Date.now(), advanced.data.version);
                            if (!authorized.ok) return authorized;
                            grantUpdate = authorized.data;
                        }
                    }
                    if (source.currency !== target.currency) return fail('CURRENCY_MISMATCH');
                    if([source.ownerId,target.ownerId].some(id=>state?.quarantinedOwnerIds?.includes(id)))return fail('ACCOUNT_ISOLATED');
                    const postings = [source, target].map((account, index) => ({ accountId: account.id,
                        ownerId: account.ownerId, currency: account.currency, deltaMinor: index ? amountMinor : -amountMinor }));
                    const preview = global.EconomyCore.previewJournal([source, target], postings);
                    if (!preview.ok) return preview;
                    const occurredAt = Date.now();
                    const receipt = { journalId, kind, sourceAccountId: source.id, targetAccountId: target.id,
                        amountMinor, currency: source.currency, occurredAt, orderId: order ? order.id : null };
                    if (grantUpdate) Object.assign(receipt, { grantId: grantUpdate.id, grantPeriodStartAt: grantUpdate.period.startAt });
                    await db.economyAccounts.bulkPut(preview.data.accounts);
                    if (grantUpdate) await db.economyGrants.put(grantUpdate);
                    await db.economyPostings.bulkAdd(preview.data.postings.map((posting, index) => ({ ...posting,
                        id: JSON.stringify([journalId, index]), journalId, occurredAt })));
                    if (order) await db.commerceOrders.put({ ...order, version: order.version + 1,
                        status: 'confirmed', paymentState: 'paid', paidAt: occurredAt,
                        paymentJournalId: journalId, paymentAccountId: source.id });
                    await db.economyJournals.add({ id: journalId, ownerId, idempotencyKey: request.idempotencyKey,
                        requestFingerprint, kind, orderId: receipt.orderId, occurredAt, receipt });
                    await db.economyOutbox.add({ eventId: journalId,ownerId, type: kind === 'transfer' ? 'transfer_posted' : 'order_paid',
                        state: 'pending', attempts: 0, payload: receipt });
                    return { ok: true, data: receipt };
                });
            } catch (_) {
                // Catch only outside the transaction: never swallow a failed write and commit a partial payment.
                return fail('PERSISTENCE_FAILED', true);
            }
        }
        async function operation(kind,input) {
            if(!input || !validId(input.idempotencyKey))return fail('INVALID_REQUEST');
            if(['exchange','reserve_transfer','income','adjustment'].includes(kind) && (!validId(input.sourceAccountId) || !version(input.expectedSourceVersion)))return fail('INVALID_REQUEST');
            if(['exchange','reserve_transfer'].includes(kind) && !validId(input.targetAccountId))return fail('INVALID_REQUEST');
            if(['accept_transfer','return_transfer','expire_transfer'].includes(kind) && (!validReference(input.transferId) || !version(input.expectedTransferVersion)))return fail('INVALID_REQUEST');
            const allowed=['sourceAccountId','targetAccountId','amountMinor','rate','expectedSourceVersion','transferId','expiresAt','expectedTransferVersion','targetBalanceMinor','reason','originalJournalId','grantId','expectedGrantVersion'];
            const request={kind,ownerId,idempotencyKey:input.idempotencyKey};
            for(const field of allowed)if(input[field]!==undefined)request[field]=input[field];
            if(Object.values(request).some(value=>value!==null && !['string','number'].includes(typeof value)))return fail('INVALID_REQUEST');
            const requestFingerprint=JSON.stringify(request),journalId=JSON.stringify([ownerId,request.idempotencyKey]);
            try{return await db.transaction('rw',Object.keys(schema).map(name=>db[name]),async()=>{
                const prior=await db.economyJournals.get(journalId);
                if(prior)return prior.requestFingerprint===requestFingerprint?{ok:true,data:prior.receipt}:fail('IDEMPOTENCY_CONFLICT');
                const state=await db.walletControl.get('state');
                if(state?.mode==='frozen' || requireActivated && global.WalletStorage?.resolveControl(state,true).mode!=='ledger')return fail('WALLET_FROZEN');
                if(state?.quarantinedOwnerIds?.includes(ownerId))return fail('ACCOUNT_ISOLATED');
                let now=Date.now();let updates=[],postings=[],transfer=null,grant=null,original=null;
                let receipt={journalId,kind,ownerId,occurredAt:now};
                const positive=value=>Number.isSafeInteger(value)&&value>0;
                const system=async(currency,accountKind)=>{
                    const key=JSON.stringify(['system',accountKind,currency]),saved=await db.economyAccounts.get(key);
                    if(saved && (saved.ownerType!=='system' || saved.currency!==currency || saved.kind!==accountKind))throw Error('INVALID_ACCOUNT');
                    return saved || {id:key,ownerId:`system:${accountKind}:${currency}`,ownerType:'system',kind:accountKind,currency,status:'active',balanceMinor:0,reservedMinor:0,version:0};
                };
                const project=(accounts,entries)=>{
                    const preview=global.EconomyCore.previewJournal(accounts,entries);
                    if(preview.ok){updates=preview.data.accounts;postings=preview.data.postings;}return preview;
                };
                const posting=(account,amount)=>({accountId:account.id,ownerId:account.ownerId,currency:account.currency,deltaMinor:amount});
                if(kind==='exchange' || kind==='reserve_transfer' || kind==='income' || kind==='adjustment') {
                    const source=await db.economyAccounts.get(request.sourceAccountId);
                    if(!wallet(source) || source.ownerId!==ownerId || source.status!=='active')return fail('FORBIDDEN');
                    if(!version(request.expectedSourceVersion) || source.version!==request.expectedSourceVersion)return fail('VERSION_CONFLICT',true);
                    if(kind==='exchange' || kind==='reserve_transfer') {
                        const target=await db.economyAccounts.get(request.targetAccountId);
                        if(!wallet(target) || target.id===source.id || target.status!=='active' || !positive(request.amountMinor))return fail('INVALID_ACCOUNT');
                        if(state?.quarantinedOwnerIds?.includes(target.ownerId))return fail('ACCOUNT_ISOLATED');
                        if(kind==='exchange') {
                            const quote=global.EconomyCore.quoteExchange(request.amountMinor,source.currency,target.currency,request.rate);
                            if(!quote.ok)return quote;
                            const from=await system(source.currency,'exchange'),to=await system(target.currency,'exchange');
                            const result=project([source,target,from,to],[posting(source,-request.amountMinor),posting(from,request.amountMinor),posting(to,-quote.data.targetAmountMinor),posting(target,quote.data.targetAmountMinor)]);
                            if(!result.ok)return result;
                            receipt={...receipt,sourceAccountId:source.id,targetAccountId:target.id,rateSnapshot:quote.data,amountMinor:request.amountMinor,targetAmountMinor:quote.data.targetAmountMinor};
                        }else{
                            if(source.currency!==target.currency)return fail('CURRENCY_MISMATCH');
                            if(!version(source.balanceMinor) || !version(source.reservedMinor) || source.reservedMinor>source.balanceMinor || !version(source.version))return fail('INVALID_ACCOUNT');
                            if(!version(request.expiresAt) || request.expiresAt<=now)return fail('INVALID_EXPIRY');
                            if(source.balanceMinor-source.reservedMinor<request.amountMinor)return fail('INSUFFICIENT_FUNDS');
                            if(source.version===Number.MAX_SAFE_INTEGER)return fail('AMOUNT_OVERFLOW');
                            updates=[{...source,reservedMinor:source.reservedMinor+request.amountMinor,version:source.version+1}];
                            transfer={id:journalId,sourceAccountId:source.id,targetAccountId:target.id,senderOwnerId:source.ownerId,recipientOwnerId:target.ownerId,currency:source.currency,amountMinor:request.amountMinor,state:'pending',version:0,createdAt:now,expiresAt:request.expiresAt};
                            receipt={...receipt,transferId:transfer.id,sourceAccountId:source.id,targetAccountId:target.id,currency:source.currency,amountMinor:request.amountMinor};
                        }
                    }else{
                        if(!canManage || typeof request.reason!=='string' || !request.reason.trim())return fail('FORBIDDEN');
                        const delta=kind==='income'?request.amountMinor:request.targetBalanceMinor-source.balanceMinor;
                        if(!Number.isSafeInteger(delta) || delta===0 || kind==='income' && delta<0 || kind==='adjustment' && !version(request.targetBalanceMinor))return fail('INVALID_AMOUNT');
                        const counterparty=await system(source.currency,'income');
                        const result=project([source,counterparty],[posting(source,delta),posting(counterparty,-delta)]);if(!result.ok)return result;
                        receipt={...receipt,accountId:source.id,currency:source.currency,deltaMinor:delta,reason:request.reason,balanceBeforeMinor:source.balanceMinor,balanceAfterMinor:updates.find(row=>row.id===source.id).balanceMinor};
                    }
                }else if(['accept_transfer','return_transfer','expire_transfer'].includes(kind)) {
                    transfer=await db.economyTransfers.get(request.transferId);
                    if(!transfer || ![transfer.senderOwnerId,transfer.recipientOwnerId].includes(ownerId))return fail('FORBIDDEN');
                    if(transfer.state!=='pending' || !version(transfer.version) || transfer.version===Number.MAX_SAFE_INTEGER || !version(transfer.expiresAt))return fail('INVALID_STATE');
                    if([transfer.senderOwnerId,transfer.recipientOwnerId].some(id=>state?.quarantinedOwnerIds?.includes(id)))return fail('ACCOUNT_ISOLATED');
                    now=Math.max(now,transfer.createdAt);
                    if(transfer.version!==request.expectedTransferVersion)return fail('VERSION_CONFLICT',true);
                    if(kind==='accept_transfer' && ownerId!==transfer.recipientOwnerId || kind==='expire_transfer' && now<transfer.expiresAt)return fail('FORBIDDEN');
                    if(kind==='accept_transfer' && now>=transfer.expiresAt)return fail('TRANSFER_EXPIRED');
                    const source=await db.economyAccounts.get(transfer.sourceAccountId),target=await db.economyAccounts.get(transfer.targetAccountId);
                    if(!wallet(source) || !wallet(target) || !positive(transfer.amountMinor) || !version(source.balanceMinor) || !version(source.reservedMinor) || !version(source.version) || source.reservedMinor>source.balanceMinor || source.ownerId!==transfer.senderOwnerId || target.ownerId!==transfer.recipientOwnerId || source.currency!==transfer.currency || target.currency!==transfer.currency || source.reservedMinor<transfer.amountMinor || source.version===Number.MAX_SAFE_INTEGER)return fail('INVALID_ACCOUNT');
                    const released={...source,reservedMinor:source.reservedMinor-transfer.amountMinor};
                    if(kind==='accept_transfer'){
                        const result=project([released,target],[posting(source,-transfer.amountMinor),posting(target,transfer.amountMinor)]);if(!result.ok)return result;
                    }else updates=[{...released,version:source.version+1}];
                    transfer={...transfer,state:kind==='accept_transfer'?'accepted':kind==='return_transfer'?'returned':'expired',version:transfer.version+1,settledAt:now,settlementJournalId:journalId};
                    receipt={...receipt,transferId:transfer.id,sourceAccountId:source.id,targetAccountId:target.id,currency:transfer.currency,amountMinor:transfer.amountMinor,state:transfer.state};
                }else if(kind==='reversal') {
                    if(!canManage || typeof request.reason!=='string' || !request.reason.trim())return fail('FORBIDDEN');
                    original=await db.economyJournals.get(request.originalJournalId);
                    if(!original || original.ownerId!==ownerId || !['income','adjustment'].includes(original.kind))return fail('FORBIDDEN');
                    if(original.reversalJournalId)return fail('ALREADY_REVERSED');
                    const old=await db.economyPostings.where('journalId').equals(original.id).toArray();
                    const accounts=await db.economyAccounts.bulkGet(old.map(row=>row.accountId));
                    const result=project(accounts,old.map(row=>posting(accounts.find(account=>account.id===row.accountId),-row.deltaMinor)));if(!result.ok)return result;
                    original={...original,reversalJournalId:journalId};receipt={...receipt,originalJournalId:original.id,reason:request.reason,accountId:original.receipt.accountId,currency:original.receipt.currency,deltaMinor:-original.receipt.deltaMinor,balanceBeforeMinor:accounts.find(row=>row.id===original.receipt.accountId).balanceMinor,balanceAfterMinor:updates.find(row=>row.id===original.receipt.accountId).balanceMinor};
                }else if(kind==='grant_renewal') {
                    grant=await db.economyGrants.get(request.grantId);
                    if(!grant || ![grant.ownerId,grant.granteeOwnerId].includes(ownerId))return fail('FORBIDDEN');
                    if(grant.version!==request.expectedGrantVersion)return fail('VERSION_CONFLICT',true);
                    const result=global.EconomyGrantCore.advance(grant,now);if(!result.ok)return result;
                    if(result.data===grant)return fail('PERIOD_NOT_EXPIRED');
                    grant=result.data;receipt={...receipt,grantId:grant.id,periodStartAt:grant.period.startAt};
                }else return fail('INVALID_REQUEST');
                receipt.occurredAt=now;
                if(updates.length)await db.economyAccounts.bulkPut(updates);
                if(postings.length)await db.economyPostings.bulkAdd(postings.map((row,index)=>({...row,id:JSON.stringify([journalId,index]),journalId,occurredAt:now})));
                if(transfer)await db.economyTransfers.put(transfer);
                if(grant)await db.economyGrants.put(grant);
                if(original)await db.economyJournals.put(original);
                await db.economyJournals.add({id:journalId,kind,ownerId,idempotencyKey:request.idempotencyKey,requestFingerprint,orderId:null,occurredAt:now,receipt});
                await db.economyOutbox.add({eventId:journalId,ownerId,type:kind,state:'pending',attempts:0,payload:receipt});
                return {ok:true,data:receipt};
            });}catch(_){return fail('PERSISTENCE_FAILED',true);}
        }
        async function drainOutbox(deliver) {
            if(typeof deliver!=='function')throw TypeError('An idempotent notification consumer is required');
            let delivered=0,failed=0;
            for(const item of await db.economyOutbox.where('[ownerId+state]').equals([ownerId,'pending']).limit(100).toArray()) {
                const token=crypto.randomUUID();
                const claimed=await db.transaction('rw',db.economyOutbox,db.economyJournals,async()=>{
                    const event=await db.economyOutbox.get(item.eventId),journal=await db.economyJournals.get(item.eventId);
                    if(!event || event.state!=='pending' || journal?.ownerId!==ownerId || event.leaseUntil>Date.now() && event.leaseUntil<=Date.now()+30000)return null;
                    const next={...event,leaseToken:token,leaseUntil:Date.now()+30000,attempts:event.attempts+1};await db.economyOutbox.put(next);return next;
                });
                if(!claimed)continue;
                let succeeded=false;
                try{succeeded=await deliver(structuredClone(claimed))===true;}catch(_){}
                await db.transaction('rw',db.economyOutbox,async()=>{
                    const event=await db.economyOutbox.get(item.eventId);if(event?.leaseToken!==token)return;
                    const failures=succeeded?0:(event.consecutiveFailures || 0)+1;
                    await db.economyOutbox.put({...event,state:succeeded?'sent':failures>=3?'failed':'pending',consecutiveFailures:failures,leaseToken:null,leaseUntil:0});
                });
                if(succeeded)delivered++;else failed++;
            }
            return {delivered,failed};
        }
        async function retryOutbox(eventId) {
            return db.transaction('rw',db.economyOutbox,db.economyJournals,async()=>{
                const journal=await db.economyJournals.get(eventId),event=await db.economyOutbox.get(eventId);
                if(journal?.ownerId!==ownerId || !event)return fail('FORBIDDEN');
                if(event.state==='failed')await db.economyOutbox.put({...event,state:'pending',consecutiveFailures:0,leaseUntil:0,leaseToken:null});
                return {ok:true,data:{eventId}};
            });
        }
        return Object.freeze({transfer:input=>execute('transfer',input),payOrder:input=>execute('order_payment',input),
            exchange:input=>operation('exchange',input),reserveTransfer:input=>operation('reserve_transfer',input),acceptTransfer:input=>operation('accept_transfer',input),
            returnTransfer:input=>operation('return_transfer',input),expireTransfer:input=>operation('expire_transfer',input),
            postIncome:input=>operation('income',input),adjustBalance:input=>operation('adjustment',input),reverseAdjustment:input=>operation('reversal',input),
            renewGrant:input=>operation('grant_renewal',input),drainOutbox,retryOutbox});
    }
    global.EconomyStorage = Object.freeze({ schema, forOwner });
})(typeof window !== 'undefined' ? window : globalThis);
