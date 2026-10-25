(function(global){
    'use strict';
    const fail=reason=>({ok:false,reason});
    async function execute(character,message,{items,isSelfPurchase,familyCardPay,singleLimit}){
        const api=WalletSystem.commerce(String(character.id)),key='character:'+message.id,fingerprint=CryptoJS.SHA256(String(message.content)).toString();
        const prior=await api.receipt(key);if(prior)return prior.quote?.sourceMessageFingerprint===fingerprint?{ok:true,duplicate:true,orderId:prior.batch.orderIds[0],paymentSource:'ledger'}:fail('IDEMPOTENCY_CONFLICT');
        const selections=items.split(/[；;]/).filter(Boolean).map(part=>part.trim().match(/^sku:([^*\s]+)\*(\d{1,3})$/));
        if(!selections.length||selections.some(row=>!row))return fail('请使用已提供的商品 ID 和数量；不接受模型自定商品或价格');
        const profile=await api.profile();if(!profile.addresses.length)return fail('请先在购物与外卖中保存模拟配送地址');
        const quoted=await api.quote({lines:selections.map(row=>({offerId:row[1],quantity:Number(row[2])})),addressId:profile.addresses[0].id,recipientOwnerId:isSelfPurchase?String(character.id):'user',sourceMessageFingerprint:fingerprint});
        if(!quoted.ok)return fail(quoted.error.code);const quote=quoted.data;
        if(singleLimit>0&&quote.totalMinor>CurrencyCore.amountToMinor(String(singleLimit),quote.currency))return fail('超过角色单笔消费上限（含配送及包装费）');
        let account,grant;
        if(familyCardPay){const candidates=(await WalletSystem.grants(String(character.id)).list()).filter(row=>row.ownerId==='user'&&row.granteeOwnerId===String(character.id)&&row.status==='active'&&row.currency===quote.currency);if(candidates.length!==1)return fail('请明确选择一张已接受且有效的亲属卡');grant=candidates[0];account=await WalletSystem.account(grant.payerAccountId);}
        else account=(await WalletSystem.accounts(String(character.id))).find(row=>row.currency===quote.currency&&row.status==='active');
        if(!account)return fail('付款账户不可用');
        const result=await api.checkout({quoteId:quote.id,sourceAccountId:account.id,expectedSourceVersion:account.version,idempotencyKey:key,...(grant?{grantId:grant.id}:{})});
        if(!result.ok)return fail(result.error.code);
        message.commerceBatchId=result.data.id;message.commerceOrderIds=result.data.orderIds;message.shopOrderId=result.data.orderIds[0];message.shopPaymentStatus='paid';message.shopPaymentSource=familyCardPay?'ledger_grant':'ledger';
        await WalletSystem.refresh(String(character.id));return {ok:true,orderId:message.shopOrderId,paymentSource:message.shopPaymentSource};
    }
    global.WalletShopping=Object.freeze({execute});
})(window);
