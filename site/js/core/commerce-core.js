// Pure checkout, fulfilment and refund rules. No timers, storage or inferred real transactions.
(function (global) {
    'use strict';
    const minor = value => Number.isSafeInteger(value) && value >= 0;
    const fail = code => ({ ok:false, error:{code,retryable:false} });
    function totals(lines, fees = {}) {
        if (!Array.isArray(lines) || !lines.length) return fail('EMPTY_CART');
        let subtotal = 0n;
        for (const line of lines) {
            if (!line || typeof line.skuId !== 'string' || !minor(line.unitMinor) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) return fail('INVALID_LINE');
            subtotal += BigInt(line.unitMinor) * BigInt(line.quantity);
        }
        const { deliveryMinor=0, packagingMinor=0, discountMinor=0 } = fees;
        if (![deliveryMinor,packagingMinor,discountMinor].every(minor)) return fail('INVALID_AMOUNT');
        const total = subtotal + BigInt(deliveryMinor) + BigInt(packagingMinor) - BigInt(discountMinor);
        if (subtotal > BigInt(Number.MAX_SAFE_INTEGER) || total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return fail('INVALID_AMOUNT');
        return {ok:true,data:{subtotalMinor:Number(subtotal),deliveryMinor,packagingMinor,discountMinor,totalMinor:Number(total)}};
    }
    function deliverySchedule(paidAt, rules) {
        if (!minor(paidAt) || !rules || typeof rules.version !== 'string') return fail('INVALID_DELIVERY_RULES');
        const result = { ruleVersion:rules.version, clockBasis:'real', paidAt };
        let time = BigInt(paidAt);
        for (const [field, duration] of [['acceptedAt',rules.acceptMs],['readyAt',rules.prepareMs],['pickupAt',rules.pickupMs],['deliveredAt',rules.travelMs]]) {
            if (!minor(duration) || duration > 7*86400000) return fail('INVALID_DELIVERY_RULES');
            time += BigInt(duration);
            if (time > BigInt(Number.MAX_SAFE_INTEGER)) return fail('INVALID_DELIVERY_RULES');
            result[field] = Number(time);
        }
        return {ok:true,data:result};
    }
    function deliveryState(schedule, now, confirmedStage = 0) {
        const fields = ['paidAt','acceptedAt','readyAt','pickupAt','deliveredAt'];
        if (!schedule || !minor(now) || !Number.isInteger(confirmedStage) || confirmedStage < 0 || confirmedStage > 4
            || fields.some((key,index) => !minor(schedule[key]) || index && schedule[key] < schedule[fields[index-1]])) return fail('INVALID_DELIVERY_STATE');
        let stage = confirmedStage;
        for (let index=0;index<fields.length;index++) if (now >= schedule[fields[index]]) stage = Math.max(stage,index);
        return {ok:true,data:{stage,status:['paid','accepted','ready','picked_up','delivered'][stage],nextAt:stage<4?schedule[fields[stage+1]]:null}};
    }
    function refund(order, actorOwnerId, amountMinor, now) {
        if (!order || ![order.buyerOwnerId,order.payerOwnerId].includes(actorOwnerId)) return fail('FORBIDDEN');
        if (!['paid','partially_refunded'].includes(order.paymentState) || !minor(order.totalMinor)
            || !minor(order.refundedMinor ?? 0) || !minor(amountMinor) || amountMinor === 0
            || amountMinor > order.totalMinor - (order.refundedMinor ?? 0)) return fail('INVALID_REFUND');
        // Immutable policy boundary is captured at checkout. Missing policies never authorize a refund.
        if (!minor(now) || !minor(order.refundUntilAt) || now > order.refundUntilAt) return fail('REFUND_NOT_ALLOWED');
        return {ok:true,data:{refundedMinor:(order.refundedMinor ?? 0)+amountMinor,
            paymentState:(order.refundedMinor ?? 0)+amountMinor===order.totalMinor?'refunded':'partially_refunded'}};
    }
    function allocate(totalMinor,weights){
        if(!minor(totalMinor)||!Array.isArray(weights)||!weights.length||weights.some(value=>!minor(value)))return fail('INVALID_AMOUNT');
        const sum=weights.reduce((a,b)=>a+BigInt(b),0n);if(!sum)return fail('INVALID_AMOUNT');
        const total=BigInt(totalMinor),parts=weights.map((weight,index)=>({index,value:total*BigInt(weight)/sum,remainder:total*BigInt(weight)%sum}));
        let remaining=total-parts.reduce((a,b)=>a+b.value,0n);
        for(const part of [...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1)){if(!remaining)break;part.value++;remaining--;}
        return {ok:true,data:parts.map(part=>Number(part.value))};
    }
    function refundLines(order,selections,includeFees=false){
        if(!order || !Array.isArray(order.lines)||!Array.isArray(selections)||!selections.length||new Set(selections.map(row=>row.skuId)).size!==selections.length)return fail('INVALID_REFUND');
        const lines=order.lines.map(row=>({...row}));let amount=0n;
        for(const selected of selections){
            const line=lines.find(row=>row.skuId===selected.skuId);
            if(!line || !Number.isSafeInteger(selected.quantity)||selected.quantity<1||!minor(line.refundedQuantity??0)||(line.refundedQuantity??0)+selected.quantity>line.quantity||!minor(line.paidMinor))return fail('INVALID_REFUND');
            const previous=line.refundedQuantity??0,next=previous+selected.quantity;
            amount+=BigInt(line.paidMinor)*BigInt(next)/BigInt(line.quantity)-BigInt(line.paidMinor)*BigInt(previous)/BigInt(line.quantity);
            line.refundedQuantity=next;
        }
        const all=lines.every(row=>row.refundedQuantity===row.quantity);
        if(all&&includeFees)amount+=BigInt(order.deliveryMinor+order.packagingMinor-(order.refundedFeesMinor??0));
        if(amount<1n||amount>BigInt(Number.MAX_SAFE_INTEGER))return fail('INVALID_REFUND');
        return {ok:true,data:{amountMinor:Number(amount),lines,all,refundedFeesMinor:all&&includeFees?order.deliveryMinor+order.packagingMinor:order.refundedFeesMinor??0}};
    }
    global.CommerceCore = Object.freeze({totals,deliverySchedule,deliveryState,refund,allocate,refundLines});
})(typeof window !== 'undefined' ? window : globalThis);
