// Internal order refund execution; caller identity comes from the trusted host.
(function (global) {
    'use strict';
    const fail = (code,retryable=false) => ({ok:false,error:{code,retryable}});
    function forOwner(db, ownerId,capabilities={}) {
        if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('Invalid refund owner');
        async function refund(input) {
            if (!input || typeof input.orderId !== 'string' || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()
                || !Number.isSafeInteger(input.expectedOrderVersion) || input.expectedOrderVersion < 0 || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return fail('INVALID_REQUEST');
            const request = { kind:'order_refund',ownerId,orderId:input.orderId,idempotencyKey:input.idempotencyKey,
                expectedOrderVersion:input.expectedOrderVersion,amountMinor:input.amountMinor };
            const fingerprint = JSON.stringify(request), journalId = JSON.stringify([ownerId,request.idempotencyKey]);
            try {
                return await db.transaction('rw',Object.keys(global.EconomySchema.runtimeTables || global.EconomySchema.tables).map(key=>db[key]),async()=>{
                    const prior = await db.economyJournals.get(journalId);
                    if (prior) return prior.requestFingerprint===fingerprint?{ok:true,data:prior.receipt}:fail('IDEMPOTENCY_CONFLICT');
                    const state=db.walletControl?await db.walletControl.get('state'):null;
                    if(state?.mode==='frozen' || capabilities.requireActivated===true && global.WalletStorage?.resolveControl(state,true).mode!=='ledger')return fail('WALLET_FROZEN');
                    const order = await db.commerceOrders.get(request.orderId);
                    if (!order || ![order.buyerOwnerId,order.payerOwnerId].includes(ownerId)) return fail('FORBIDDEN');
                    if (order.version!==request.expectedOrderVersion || order.version===Number.MAX_SAFE_INTEGER) return fail('VERSION_CONFLICT',true);
                    const occurredAt=Date.now(), allowed=global.CommerceCore.refund(order,ownerId,request.amountMinor,occurredAt);
                    if (!allowed.ok) return allowed;
                    const payment=await db.economyJournals.get(order.paymentJournalId);
                    if (!payment || payment.kind!=='order_payment' || payment.orderId!==order.id || payment.receipt.amountMinor!==order.totalMinor) return fail('INVALID_PAYMENT');
                    const refunds=(await db.economyJournals.where('orderId').equals(order.id).toArray()).filter(row=>row.kind==='order_refund');
                    if (refunds.reduce((sum,row)=>sum+BigInt(row.receipt.amountMinor),0n)!==BigInt(order.refundedMinor ?? 0)) return fail('REFUND_HISTORY_CONFLICT');
                    const source=await db.economyAccounts.get(payment.receipt.targetAccountId), target=await db.economyAccounts.get(payment.receipt.sourceAccountId);
                    if (!source || source.kind!=='merchant' || source.ownerType!=='system' || !target || target.kind!=='wallet'
                        || target.ownerId!==order.payerOwnerId || source.currency!==order.currency || target.currency!==order.currency
                        || !['active','frozen'].includes(target.status)) return fail('INVALID_ACCOUNT');
                    const preview=global.EconomyCore.previewJournal([source,{...target,status:'active'}],[source,target].map((account,index)=>({
                        accountId:account.id,ownerId:account.ownerId,currency:account.currency,deltaMinor:index?request.amountMinor:-request.amountMinor})));
                    if (!preview.ok) return preview;
                    if (payment.receipt.grantId) {
                        const grant=await db.economyGrants.get(payment.receipt.grantId);
                        if (!grant || grant.payerAccountId!==target.id) return fail('INVALID_GRANT');
                        if (grant.period.startAt===payment.receipt.grantPeriodStartAt) {
                            if (grant.usedMinor<request.amountMinor || grant.version===Number.MAX_SAFE_INTEGER) return fail('INVALID_GRANT');
                            await db.economyGrants.put({...grant,usedMinor:grant.usedMinor-request.amountMinor,version:grant.version+1});
                        }
                    }
                    await db.economyAccounts.bulkPut(preview.data.accounts.map(row=>row.id===target.id?{...row,status:target.status}:row));
                    await db.economyPostings.bulkAdd(preview.data.postings.map((row,index)=>({...row,id:JSON.stringify([journalId,index]),journalId,occurredAt})));
                    const receipt={journalId,kind:'order_refund',orderId:order.id,originalJournalId:payment.id,sourceAccountId:source.id,
                        targetAccountId:target.id,currency:order.currency,amountMinor:request.amountMinor,occurredAt};
                    await db.commerceOrders.put({...order,...allowed.data,version:order.version+1});
                    await db.economyJournals.add({id:journalId,ownerId,idempotencyKey:request.idempotencyKey,kind:'order_refund',orderId:order.id,
                        occurredAt,requestFingerprint:fingerprint,receipt});
                    await db.economyOutbox.add({eventId:journalId,ownerId,type:'order_refunded',state:'pending',attempts:0,payload:receipt});
                    return {ok:true,data:receipt};
                });
            } catch (_) { return fail('PERSISTENCE_FAILED',true); }
        }
        return Object.freeze({refund});
    }
    global.EconomyRefundStorage=Object.freeze({forOwner});
})(typeof window!=='undefined'?window:globalThis);
