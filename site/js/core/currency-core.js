(function attachCurrencyCore(global) {
    'use strict';
    const SCALE = 6;
    const CURRENCIES = Object.freeze({
        CNY: { code: 'CNY', name: '人民币', symbol: '¥', digits: 2 },
        USD: { code: 'USD', name: '美元', symbol: '$', digits: 2 },
        EUR: { code: 'EUR', name: '欧元', symbol: '€', digits: 2 },
        GBP: { code: 'GBP', name: '英镑', symbol: '£', digits: 2 },
        JPY: { code: 'JPY', name: '日元', symbol: '¥', digits: 0 },
        HKD: { code: 'HKD', name: '港币', symbol: 'HK$', digits: 2 },
        KRW: { code: 'KRW', name: '韩元', symbol: '₩', digits: 0 },
    });
    const text = value => String(value ?? '').trim().toUpperCase();
    const isSupported = value => Object.prototype.hasOwnProperty.call(CURRENCIES, text(value));
    const currency = value => isSupported(value) ? text(value) : 'CNY';
    const meta = value => CURRENCIES[currency(value)];
    const pow10 = digits => 10 ** Math.max(0, Number(digits) || 0);
    function parseDecimal(value, scale = SCALE) {
        if (!Number.isInteger(scale) || scale < 0 || scale > 6) return null;
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const input = String(value).trim();
        if (input.length > 128) return null;
        if (input.includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(input)) return null;
        const raw = input.replace(/,/g, '');
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
        const sign = raw.startsWith('-') ? -1 : 1;
        const unsigned = raw.replace(/^[+-]/, '');
        const [whole, fraction = ''] = unsigned.split('.');
        if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return null;
        const scaled = (BigInt(whole || '0') * BigInt(10 ** scale)) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
        return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) * sign : null;
    }
    function amountToMinor(value, code) {
        const info = meta(code);
        const scaled = parseDecimal(value, info.digits);
        if (scaled == null || scaled < 0) return null;
        return scaled;
    }
    function formatMinor(value, code) {
        const info = meta(code);
        const minor = Number(value);
        if (!Number.isSafeInteger(minor) || minor < 0) return `${info.symbol}0`;
        const major = minor / pow10(info.digits);
        return `${info.symbol}${major.toLocaleString('zh-CN', { minimumFractionDigits: info.digits, maximumFractionDigits: info.digits })}`;
    }
    function rateToScaled(value) {
        const scaled = parseDecimal(value, SCALE);
        return scaled != null && scaled > 0 ? scaled : null;
    }
    function convertMinor(amountMinor, sourceCode, targetCode, rateScaled) {
        const source = meta(sourceCode);
        const target = meta(targetCode);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isSafeInteger(rateScaled) || rateScaled <= 0) return null;
        const numerator = BigInt(amountMinor) * BigInt(rateScaled) * BigInt(pow10(target.digits));
        const denominator = BigInt(pow10(source.digits)) * BigInt(10 ** SCALE);
        const result = (numerator + denominator / 2n) / denominator;
        return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
    }
    function emptyWallet(defaultCurrency = 'CNY') {
        const code = currency(defaultCurrency);
        return { schemaVersion: 1, defaultCurrency: code, accounts: {}, transactions: [] };
    }
    function normalizeWallet(value, legacyBalance = null, defaultCurrency = 'CNY') {
        const source = value && typeof value === 'object' ? value : {};
        const result = emptyWallet(source.defaultCurrency || defaultCurrency);
        Object.entries(source.accounts || {}).forEach(([key, account]) => {
            const code = currency(account?.currency || key);
            const balanceMinor = Number(account?.balanceMinor);
            if (Number.isSafeInteger(balanceMinor) && balanceMinor >= 0) result.accounts[code] = { currency: code, balanceMinor };
        });
        if (!result.accounts.CNY && legacyBalance != null && Number.isFinite(Number(legacyBalance))) {
            result.accounts.CNY = { currency: 'CNY', balanceMinor: Math.max(0, Math.round(Number(legacyBalance) * 100)) };
        }
        result.transactions = Array.isArray(source.transactions) ? source.transactions.map(item => ({
            id: String(item.id || ''), type: item.type === 'receive' ? 'receive' : 'send',
            fromOwnerId: String(item.fromOwnerId || ''), toOwnerId: String(item.toOwnerId || ''),
            fromCurrency: currency(item.fromCurrency), toCurrency: currency(item.toCurrency),
            amountMinor: Number.isSafeInteger(Number(item.amountMinor)) ? Number(item.amountMinor) : 0,
            receivedMinor: Number.isSafeInteger(Number(item.receivedMinor)) ? Number(item.receivedMinor) : 0,
            sourceAmountMinor: Number.isSafeInteger(Number(item.sourceAmountMinor)) ? Number(item.sourceAmountMinor) : Number(item.amountMinor) || 0,
            targetAmountMinor: Number.isSafeInteger(Number(item.targetAmountMinor)) ? Number(item.targetAmountMinor) : Number(item.receivedMinor) || 0,
            rate: String(item.rate || ''), rateScale: Number(item.rateScale) || SCALE,
            remark: String(item.remark || '').slice(0, 300), createdAt: Number(item.createdAt) || Date.now(),
        })) : [];
        result.schemaVersion = 1;
        return result;
    }
    function getBalance(wallet, code) {
        return Number(wallet?.accounts?.[currency(code)]?.balanceMinor) || 0;
    }
    function setBalance(wallet, code, balanceMinor) {
        const normalized = currency(code);
        if (!wallet.accounts) wallet.accounts = {};
        wallet.accounts[normalized] = { currency: normalized, balanceMinor: Math.max(0, Math.trunc(balanceMinor)) };
    }
    function applyTransfer(options = {}) {
        const sourceWallet = options.sourceWallet;
        const targetWallet = options.targetWallet;
        const sourceCurrency = currency(options.sourceCurrency);
        const targetCurrency = currency(options.targetCurrency);
        const sourceAmountMinor = Number(options.sourceAmountMinor);
        const rateScaled = Number(options.rateScaled);
        if (!sourceWallet || !targetWallet || sourceWallet === targetWallet) return { ok: false, reason: '转账账户无效' };
        if (sourceCurrency === targetCurrency) return { ok: false, reason: '请选择不同的源币种和目标币种' };
        if (!Number.isSafeInteger(sourceAmountMinor) || sourceAmountMinor <= 0) return { ok: false, reason: '转账金额无效' };
        if (!Number.isSafeInteger(rateScaled) || rateScaled <= 0) return { ok: false, reason: '汇率无效' };
        const targetAmountMinor = convertMinor(sourceAmountMinor, sourceCurrency, targetCurrency, rateScaled);
        if (!targetAmountMinor || targetAmountMinor <= 0) return { ok: false, reason: '换算后的金额无效' };
        const available = getBalance(sourceWallet, sourceCurrency);
        const targetBalance = getBalance(targetWallet, targetCurrency);
        if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(targetBalance) || targetBalance < 0
            || !Number.isSafeInteger(targetBalance + targetAmountMinor)) return { ok: false, reason: '账户金额超出安全范围' };
        if (available < sourceAmountMinor) return { ok: false, reason: '源账户余额不足' };
        setBalance(sourceWallet, sourceCurrency, available - sourceAmountMinor);
        setBalance(targetWallet, targetCurrency, targetBalance + targetAmountMinor);
        const now = Number(options.createdAt) || Date.now();
        const recordId = String(options.recordId || `fx_${now}_${Math.random().toString(36).slice(2, 8)}`);
        const base = {
            id: recordId, fromOwnerId: String(options.fromOwnerId || ''), toOwnerId: String(options.toOwnerId || ''),
            fromCurrency: sourceCurrency, toCurrency: targetCurrency, sourceAmountMinor, targetAmountMinor,
            amountMinor: sourceAmountMinor, receivedMinor: targetAmountMinor, rate: String(options.rate || ''), rateScale: SCALE,
            remark: String(options.remark || '').trim().slice(0, 300), createdAt: now,
        };
        sourceWallet.transactions = Array.isArray(sourceWallet.transactions) ? sourceWallet.transactions : [];
        targetWallet.transactions = Array.isArray(targetWallet.transactions) ? targetWallet.transactions : [];
        sourceWallet.transactions.unshift({ ...base, type: 'send' });
        targetWallet.transactions.unshift({ ...base, type: 'receive' });
        return { ok: true, recordId, sourceAmountMinor, targetAmountMinor, sourceCurrency, targetCurrency };
    }
    function listCurrencies() { return Object.values(CURRENCIES).map(item => ({ ...item })); }
    global.CurrencyCore = { SCALE, CURRENCIES, isSupported, currency, meta, parseDecimal, amountToMinor, formatMinor, rateToScaled, convertMinor, emptyWallet, normalizeWallet, getBalance, setBalance, applyTransfer, listCurrencies };
})(typeof window !== 'undefined' ? window : globalThis);
