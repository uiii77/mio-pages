// Pure previews only. The future WalletSystem transaction must authorize and re-read before committing.
(function attachEconomyCore(global) {
    'use strict';
    const core = () => global.CurrencyCore;
    const fail = code => ({ ok: false, error: { code, retryable: false } });
    const ok = data => ({ ok: true, data });
    const id = value => typeof value === 'string' && value.trim().length > 0;
    const minor = value => Number.isSafeInteger(value) && value >= 0;
    const systemKinds = new Set(['merchant', 'income', 'opening', 'exchange']);

    function parseMoney(value, currency) {
        if (!core().isSupported(currency)) return fail('UNSUPPORTED_CURRENCY');
        const amountMinor = core().amountToMinor(value, currency);
        return amountMinor === null ? fail('INVALID_AMOUNT') : ok({ currency: core().currency(currency), amountMinor });
    }

    function quoteExchange(amountMinor, sourceCurrency, targetCurrency, rate) {
        if (!core().isSupported(sourceCurrency) || !core().isSupported(targetCurrency)) return fail('UNSUPPORTED_CURRENCY');
        const from = core().currency(sourceCurrency), to = core().currency(targetCurrency);
        const rateScaled = core().rateToScaled(rate);
        if (!minor(amountMinor) || amountMinor === 0 || rateScaled === null) return fail('INVALID_AMOUNT');
        if (from === to) return fail('INVALID_CURRENCY_PAIR');
        const targetAmountMinor = core().convertMinor(amountMinor, from, to, rateScaled);
        if (!minor(targetAmountMinor) || targetAmountMinor === 0) return fail('INVALID_AMOUNT');
        return ok({ sourceCurrency: from, targetCurrency: to, sourceAmountMinor: amountMinor,
            targetAmountMinor, rateScaled, scale: core().SCALE, rounding: 'half_up' });
    }

    // Does not authorize, persist, reserve funds, or claim idempotency. Returns new account projections.
    function previewJournal(accounts, postings) {
        if (!Array.isArray(accounts) || !Array.isArray(postings) || postings.length < 2) return fail('INVALID_JOURNAL');
        const byId = new Map(), deltas = new Map(), sums = new Map();
        for (const account of accounts) {
            if (!account || !id(account.id) || !id(account.ownerId) || byId.has(account.id)
                || !['user', 'character', 'system'].includes(account.ownerType)
                || !core().isSupported(account.currency) || account.currency!==core().currency(account.currency)) return fail('INVALID_ACCOUNT');
            const system = account.ownerType === 'system' && systemKinds.has(account.kind);
            if ((!system && account.kind !== 'wallet') || (account.ownerType === 'system' && !system)
                || !Number.isSafeInteger(account.balanceMinor) || (!system && account.balanceMinor < 0)
                || !minor(account.reservedMinor) || (system && account.reservedMinor !== 0)
                || (!system && account.reservedMinor > account.balanceMinor)
                || !minor(account.version)) return fail('INVALID_ACCOUNT');
            byId.set(account.id, account);
        }
        for (const posting of postings) {
            const account = posting && byId.get(posting.accountId);
            if (!account || account.status !== 'active') return fail('INVALID_ACCOUNT');
            if (posting.ownerId !== account.ownerId) return fail('OWNER_MISMATCH');
            if (posting.currency !== account.currency) return fail('CURRENCY_MISMATCH');
            if (!Number.isSafeInteger(posting.deltaMinor) || posting.deltaMinor === 0) return fail('INVALID_AMOUNT');
            const delta = BigInt(posting.deltaMinor);
            deltas.set(account.id, (deltas.get(account.id) || 0n) + delta);
            sums.set(account.currency, (sums.get(account.currency) || 0n) + delta);
        }
        if ([...sums.values()].some(sum => sum !== 0n)) return fail('UNBALANCED_JOURNAL');
        if (![...deltas.values()].some(delta => delta !== 0n)) return fail('EMPTY_JOURNAL');
        const updated = [];
        for (const [accountId, delta] of deltas) {
            const account = byId.get(accountId);
            const balance = BigInt(account.balanceMinor) + delta;
            if (balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < -BigInt(Number.MAX_SAFE_INTEGER)
                || account.version === Number.MAX_SAFE_INTEGER) return fail('AMOUNT_OVERFLOW');
            if (account.ownerType !== 'system' && balance < BigInt(account.reservedMinor)) return fail('INSUFFICIENT_FUNDS');
            updated.push({ ...account, balanceMinor: Number(balance), version: account.version + 1 });
        }
        return ok({ accounts: updated, postings: postings.map(p => ({ accountId: p.accountId,
            ownerId: p.ownerId, currency: p.currency, deltaMinor: p.deltaMinor })) });
    }

    // Cumulative proportional allocation: the final refund absorbs any rounding remainder.
    function allocateRefund(originalOrderMinor, originalPaidMinor, refundedOrderMinor, nextOrderMinor) {
        if (![originalOrderMinor, originalPaidMinor, refundedOrderMinor, nextOrderMinor].every(minor)
            || !originalOrderMinor || !originalPaidMinor || !nextOrderMinor
            || BigInt(refundedOrderMinor) + BigInt(nextOrderMinor) > BigInt(originalOrderMinor)) return fail('INVALID_AMOUNT');
        const total = BigInt(originalOrderMinor), paid = BigInt(originalPaidMinor);
        const before = BigInt(refundedOrderMinor), after = before + BigInt(nextOrderMinor);
        return ok({ refundPaidMinor: Number(after * paid / total - before * paid / total),
            cumulativePaidMinor: Number(after * paid / total) });
    }
    global.EconomyCore = Object.freeze({ parseMoney, quoteExchange, previewJournal, allocateRefund });
})(typeof window !== 'undefined' ? window : globalThis);
