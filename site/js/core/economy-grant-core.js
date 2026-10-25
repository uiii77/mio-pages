// Virtual spending authorizations; a grant is never an account or additional money.
(function (global) {
    'use strict';
    const id = v => typeof v === 'string' && v.length > 0 && v.trim() === v;
    const minor = v => Number.isSafeInteger(v) && v >= 0;
    const statuses = ['draft', 'pending', 'active', 'frozen', 'revoked', 'returned', 'replaced'];
    function valid(grant) {
        return !!grant && id(grant.id) && id(grant.ownerId) && id(grant.payerAccountId)
            && (grant.status === 'draft' && grant.granteeOwnerId === null || id(grant.granteeOwnerId))
            && grant.ownerId !== grant.granteeOwnerId && global.CurrencyCore.isSupported(grant.currency)
            && statuses.includes(grant.status) && minor(grant.limitMinor) && minor(grant.usedMinor)
            && grant.usedMinor <= grant.limitMinor && minor(grant.version)
            && Array.isArray(grant.actions) && grant.actions.length === 1 && grant.actions[0] === 'pay_order'
            && ['daily', 'weekly', 'monthly', 'custom'].includes(grant.period?.kind)
            && grant.period.clockBasis === 'legacy-local' && minor(grant.period.startAt)
            && minor(grant.period.endAt) && grant.period.endAt > grant.period.startAt
            && Number.isSafeInteger(grant.period.days) && grant.period.days > 0 && grant.period.days <= 3650
            && Array.isArray(grant.legacyTransactions) && grant.legacyTransactions.every(row => row && id(row.referenceId)
                && minor(row.amountMinor) && (row.occurredAt === null || minor(row.occurredAt)))
            && new Set(grant.legacyTransactions.map(row => row.referenceId)).size === grant.legacyTransactions.length;
    }
    function fromLegacy(card, collection, owners) {
        const fail = code => ({ ok: false, error: { code, retryable: false } });
        if (!card || !id(card.id) || !['familyCards', 'receivedFamilyCards'].includes(collection)) return fail('INVALID_CARD');
        const sent = collection === 'familyCards';
        const ownerId = sent ? 'user' : String(card.fromCharId ?? '');
        const granteeOwnerId = sent ? (card.targetCharId ? String(card.targetCharId) : null) : 'user';
        if (!owners.has(ownerId) || granteeOwnerId !== null && !owners.has(granteeOwnerId)) return fail('INVALID_CARD_OWNER');
        const limit = global.EconomyCore.parseMoney(card.limit, 'CNY'), used = global.EconomyCore.parseMoney(card.usedAmount, 'CNY');
        if (!limit.ok || !used.ok) return fail('INVALID_CARD_LIMIT');
        if (card.transactions != null && !Array.isArray(card.transactions)) return fail('INVALID_CARD_HISTORY');
        const legacyTransactions = [];
        const seen = new Set();
        for (const [index, row] of (card.transactions || []).entries()) {
            const amount = global.EconomyCore.parseMoney(row?.amount, 'CNY');
            if (!row || !amount.ok) return fail('INVALID_CARD_HISTORY');
            const referenceId = String(row.eventId || row.id || `legacy-index:${index}`);
            if (seen.has(referenceId)) return fail('DUPLICATE_CARD_HISTORY');
            seen.add(referenceId);
            legacyTransactions.push({ referenceId, legacyId: row.id == null ? null : String(row.id),
                amountMinor: amount.data.amountMinor, occurredAt: minor(row.time) ? row.time : null });
        }
        const grant = { id: JSON.stringify(['legacy-family-card', collection, card.id]), ownerId,
            payerAccountId: JSON.stringify(['wallet', ownerId, 'CNY']), granteeOwnerId,
            currency: 'CNY', actions: ['pay_order'], limitMinor: limit.data.amountMinor, usedMinor: used.data.amountMinor,
            status: card.status, version: 0, period: { kind: card.refreshPeriod, days: card.refreshPeriod === 'custom' ? card.refreshDays : 30,
                startAt: card.lastRefreshTime, endAt: card.nextRefreshTime, clockBasis: 'legacy-local' },
            legacyCollection: collection, legacyId: card.id, legacyTransactions };
        return valid(grant) ? { ok: true, data: grant } : fail('INVALID_CARD_STATE_OR_PERIOD');
    }
    function authorize(grant, ownerId, accountId, amountMinor, now, expectedVersion) {
        let code;
        if (!valid(grant) || !minor(amountMinor) || amountMinor === 0 || !minor(now)) code = 'INVALID_GRANT';
        else if (grant.granteeOwnerId !== ownerId || grant.payerAccountId !== accountId) code = 'FORBIDDEN';
        else if (grant.version !== expectedVersion) code = 'VERSION_CONFLICT';
        else if (grant.status !== 'active') code = 'GRANT_REVOKED';
        else if (now < grant.period.startAt || now >= grant.period.endAt) code = 'GRANT_PERIOD_EXPIRED';
        else if (amountMinor > grant.limitMinor - grant.usedMinor || grant.version === Number.MAX_SAFE_INTEGER) code = 'GRANT_LIMIT_EXCEEDED';
        return code ? { ok: false, error: { code, retryable: false } }
            : { ok: true, data: { ...grant, usedMinor: grant.usedMinor + amountMinor, version: grant.version + 1 } };
    }
    function nextPeriodBoundary(from,kind,days=30) {
        if(!Number.isInteger(days) || days<=0)days=30;
        if(kind!=='monthly')return from+86400000*(kind==='daily'?1:kind==='weekly'?7:days);
        const date=new Date(from),day=date.getDate();date.setDate(1);date.setMonth(date.getMonth()+1);
        const end=new Date(date.getTime());end.setMonth(end.getMonth()+1);end.setDate(0);
        date.setDate(Math.min(day,end.getDate()));return date.getTime();
    }
    function advance(grant,now) {
        const fail=code=>({ok:false,error:{code,retryable:false}});
        if(!valid(grant) || !minor(now) || now<grant.period.startAt)return fail('INVALID_GRANT');
        if(now<grant.period.endAt)return {ok:true,data:grant};
        if(grant.status!=='active' || grant.version===Number.MAX_SAFE_INTEGER)return fail('GRANT_REVOKED');
        let startAt=grant.period.endAt,endAt=nextPeriodBoundary(startAt,grant.period.kind,grant.period.days);
        if(grant.period.kind!=='monthly') {
            const duration=endAt-startAt,skipped=Math.floor((now-startAt)/duration);
            startAt+=skipped*duration;endAt=startAt+duration;
        }else while(endAt<=now){startAt=endAt;endAt=nextPeriodBoundary(startAt,grant.period.kind,grant.period.days);}
        if(!minor(endAt) || endAt<=now)return fail('INVALID_GRANT');
        const periodHistory=[...(grant.periodHistory || []),{...grant.period,usedMinor:grant.usedMinor}];
        return {ok:true,data:{...grant,usedMinor:0,version:grant.version+1,periodHistory,period:{...grant.period,startAt,endAt}}};
    }
    global.EconomyGrantCore = Object.freeze({ valid, fromLegacy, authorize,nextPeriodBoundary,advance });
})(typeof window !== 'undefined' ? window : globalThis);
