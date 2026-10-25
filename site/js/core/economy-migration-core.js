// Read-only preflight of an explicit {piggyBank, characters} snapshot; never normalize or repair inputs.
(function attachEconomyMigrationCore(global) {
    'use strict';
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    function scan(snapshot) {
        if (!object(snapshot) || !Array.isArray(snapshot.characters) || !own(snapshot, 'piggyBank')) {
            return { ok: false, error: { code: 'INVALID_SNAPSHOT', retryable: false } };
        }
        const findings = [], owners = [], grants = [], seen = new Set(['user']), transfers = new Map(), wallets = new Map();
        const issue = (code, path, ownerId, severity = 'blocking') => findings.push({ code, path, ownerId, severity });
        function inspect(ownerId, wallet, path) {
            const result = { ownerId, path, balances: [], historyCounts: {} };
            owners.push(result);
            if (wallet == null) { issue('UNKNOWN_BALANCE', path, ownerId); return; }
            if (!object(wallet)) { issue('INVALID_WALLET', path, ownerId); return; }
            wallets.set(ownerId, wallet);
            if (own(wallet, 'balance') && wallet.balance == null) issue('UNKNOWN_BALANCE', `${path}.balance`, ownerId);
            let legacy = null;
            if (wallet.balance != null) {
                const parsed = global.EconomyCore.parseMoney(wallet.balance, 'CNY');
                if (!parsed.ok) issue('INVALID_LEGACY_BALANCE', `${path}.balance`, ownerId);
                else legacy = parsed.data.amountMinor;
            }
            const currencyWallet = wallet.currencyWallet;
            if (currencyWallet != null && !object(currencyWallet)) issue('INVALID_WALLET', `${path}.currencyWallet`, ownerId);
            const accounts = object(currencyWallet) ? currencyWallet.accounts : undefined;
            if (accounts != null && !object(accounts)) issue('INVALID_ACCOUNTS', `${path}.currencyWallet.accounts`, ownerId);
            const currencies = new Set();
            if (object(accounts)) for (const [key, account] of Object.entries(accounts)) {
                const accountPath = `${path}.currencyWallet.accounts.${key}`;
                if (!object(account) || !global.CurrencyCore.isSupported(key)
                    || (account.currency != null && (!global.CurrencyCore.isSupported(account.currency)
                        || global.CurrencyCore.currency(account.currency) !== global.CurrencyCore.currency(key)))) {
                    issue('INVALID_CURRENCY_ACCOUNT', accountPath, ownerId); continue;
                }
                const currency = global.CurrencyCore.currency(key);
                if (currencies.has(currency)) issue('DUPLICATE_CURRENCY_ACCOUNT', accountPath, ownerId);
                currencies.add(currency);
                if (!Number.isSafeInteger(account.balanceMinor) || account.balanceMinor < 0) {
                    issue('INVALID_ACCOUNT_BALANCE', accountPath, ownerId); continue;
                }
                const entry = { currency, legacyMinor: currency === 'CNY' ? legacy : null,
                    accountMinor: account.balanceMinor, status: 'candidate' };
                if (currency === 'CNY' && legacy !== null && legacy !== account.balanceMinor) {
                    entry.status = 'conflict'; issue('BALANCE_CONFLICT', accountPath, ownerId);
                }
                result.balances.push(entry);
            }
            if (!currencies.has('CNY') && legacy !== null) result.balances.push({ currency: 'CNY', legacyMinor: legacy, accountMinor: null, status: 'candidate' });
            if (!result.balances.length) issue('UNKNOWN_BALANCE', path, ownerId);
            const collections = [['transactions', wallet.transactions], ['currencyWallet.transactions', object(currencyWallet) ? currencyWallet.transactions : undefined]];
            for (const [name, rows] of collections) {
                if (rows == null) continue;
                if (!Array.isArray(rows)) { issue('INVALID_HISTORY', `${path}.${name}`, ownerId); continue; }
                result.historyCounts[name] = rows.length;
                if (rows.length >= 500) issue('HISTORY_MAY_BE_TRUNCATED', `${path}.${name}`, ownerId, 'warning');
                const ids = new Set();
                rows.forEach((row, index) => {
                    if (!object(row)) { issue('INVALID_HISTORY_ROW', `${path}.${name}[${index}]`, ownerId); return; }
                    const stableId = row.eventId || row.id;
                    if (!stableId) issue('MISSING_HISTORY_ID', `${path}.${name}[${index}]`, ownerId, 'warning');
                    else if (ids.has(String(stableId))) issue('DUPLICATE_HISTORY_ID', `${path}.${name}[${index}]`, ownerId);
                    else ids.add(String(stableId));
                    if (name === 'currencyWallet.transactions' && stableId) {
                        const key = String(stableId);
                        if (!transfers.has(key)) transfers.set(key, []);
                        transfers.get(key).push({ ownerId, row, path: `${path}.${name}[${index}]` });
                    }
                });
            }
        }
        inspect('user', snapshot.piggyBank, 'piggyBank');
        snapshot.characters.forEach((character, index) => {
            const path = `characters[${index}]`;
            if (!object(character) || !['string', 'number'].includes(typeof character.id)
                || (typeof character.id === 'number' && !Number.isSafeInteger(character.id)) || !String(character.id).trim()
                || String(character.id).length > 100 || String(character.id).trim() !== String(character.id)
                || String(character.id).startsWith('system:')) {
                issue('INVALID_OWNER_ID', path, null); return;
            }
            const ownerId = String(character.id);
            if (seen.has(ownerId)) { issue('DUPLICATE_OWNER_ID', path, ownerId); return; }
            seen.add(ownerId);
            inspect(ownerId, character.walletLedger, `${path}.walletLedger`);
        });
        for (const rows of transfers.values()) {
            for (const { row, path, ownerId } of rows) {
                if (!['send', 'receive'].includes(row.type) || !seen.has(String(row.fromOwnerId)) || !seen.has(String(row.toOwnerId))
                    || String(row.fromOwnerId) === String(row.toOwnerId)
                    || ownerId !== String(row.type === 'send' ? row.fromOwnerId : row.toOwnerId)
                    || !global.CurrencyCore.isSupported(row.fromCurrency) || !global.CurrencyCore.isSupported(row.toCurrency)
                    || !Number.isSafeInteger(row.sourceAmountMinor) || row.sourceAmountMinor <= 0
                    || !Number.isSafeInteger(row.targetAmountMinor) || row.targetAmountMinor <= 0) issue('INVALID_TRANSFER_REFERENCE', path, ownerId);
            }
            if (rows.length === 1) issue('UNPAIRED_TRANSFER_HISTORY', rows[0].path, rows[0].ownerId, 'warning');
            else {
                const fields = ['fromOwnerId', 'toOwnerId', 'fromCurrency', 'toCurrency', 'sourceAmountMinor', 'targetAmountMinor', 'rate', 'rateScale', 'createdAt'];
                if (rows.length !== 2 || rows[0].row.type === rows[1].row.type
                    || fields.some(key => rows[0].row[key] !== rows[1].row[key])) issue('TRANSFER_HISTORY_CONFLICT', rows[0].path, rows[0].ownerId);
            }
        }
        const bank = object(snapshot.piggyBank) ? snapshot.piggyBank : {};
        const cardIds = new Set();
        for (const key of ['familyCards', 'receivedFamilyCards']) {
            if (bank[key] == null) continue;
            if (!Array.isArray(bank[key])) { issue('INVALID_CARDS', `piggyBank.${key}`, 'user'); continue; }
            bank[key].forEach((card, index) => {
                const path = `piggyBank.${key}[${index}]`;
                if (!object(card) || !card.id || cardIds.has(String(card.id))) { issue('INVALID_CARD_ID', path, 'user'); return; }
                cardIds.add(String(card.id));
                const ownerId = String(key === 'familyCards' ? card.targetCharId : card.fromCharId);
                if ((!seen.has(ownerId) || ownerId === 'user') && card.status !== 'draft') issue('INVALID_CARD_OWNER', path, ownerId);
                const limit = global.EconomyCore.parseMoney(card.limit, 'CNY'), used = global.EconomyCore.parseMoney(card.usedAmount, 'CNY');
                if (!limit.ok || !used.ok || used.data.amountMinor > limit.data.amountMinor) issue('INVALID_CARD_LIMIT', path, ownerId);
                const mapped = global.EconomyGrantCore.fromLegacy(card, key, seen);
                if (!mapped.ok) issue(mapped.error.code, path, ownerId);
                else if (!owners.find(owner => owner.ownerId === mapped.data.ownerId)?.balances.some(b => b.currency === 'CNY')) issue('MISSING_GRANT_PAYER_ACCOUNT', path, ownerId);
                else grants.push(mapped.data);
            });
        }
        if (bank.orders != null) {
            if (!Array.isArray(bank.orders)) issue('INVALID_ORDERS', 'piggyBank.orders', 'user');
            else {
                const ids = new Set();
                bank.orders.forEach((order, index) => {
                    const path = `piggyBank.orders[${index}]`;
                    if (!object(order) || !order.id || ids.has(String(order.id))) { issue('INVALID_ORDER_ID', path, 'user'); return; }
                    ids.add(String(order.id));
                    if (order.buyerType === 'character' && !seen.has(String(order.buyerId))) issue('INVALID_ORDER_BUYER', path, String(order.buyerId));
                    const amount = global.EconomyCore.parseMoney(order.amount, 'CNY');
                    if (!amount.ok) issue('INVALID_ORDER_AMOUNT', path, 'user');
                    if (order.buyerType === 'character' && order.paymentSource === 'character_wallet') {
                        const rows = wallets.get(String(order.buyerId))?.transactions;
                        const linked = Array.isArray(rows) ? rows.filter(row => row?.eventId === order.id || row?.id === `cwt_${order.id}`) : [];
                        if (!linked.length) issue('UNPAIRED_ORDER_HISTORY', path, String(order.buyerId), 'warning');
                        else if (linked.length !== 1 || !amount.ok || !global.EconomyCore.parseMoney(linked[0].amount, 'CNY').ok
                            || global.EconomyCore.parseMoney(linked[0].amount, 'CNY').data.amountMinor !== amount.data.amountMinor) issue('ORDER_HISTORY_CONFLICT', path, String(order.buyerId));
                    }
                });
                if (bank.orders.length) issue('LEGACY_ORDERS_RETAINED', 'piggyBank.orders', 'user', 'warning');
            }
        }
        return { ok: true, data: { schemaVersion: 3, readOnly: true, migrationReady: false,
            scope: 'opening-balances-and-legacy-references', owners, grants, findings,
            blockingCount: findings.filter(f => f.severity === 'blocking').length } };
    }
    const migrationOwner = 'system:migration', migrationKey = 'legacy-opening-v1';
    const journalId = JSON.stringify([migrationOwner, migrationKey]);
    function prepareOpening(snapshot) {
        const report = scan(snapshot);
        if (!report.ok) return report;
        if (report.data.blockingCount) return { ok: false, error: { code: 'MIGRATION_BLOCKED', retryable: false }, report: report.data };
        const entries = report.data.owners.flatMap(owner => owner.balances.map(balance => ({
            ownerId: owner.ownerId, ownerType: owner.ownerId === 'user' ? 'user' : 'character', currency: balance.currency,
            amountMinor: balance.accountMinor ?? balance.legacyMinor,
            accountId: JSON.stringify(['wallet', owner.ownerId, balance.currency]),
            openingAccountId: JSON.stringify(['opening', owner.ownerId, balance.currency])
        }))).sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
        // Exact supported evidence, not a hash. No remarks, chat content, names or credentials.
        const grants = report.data.grants;
        const sourceFingerprint = JSON.stringify({ migrationVersion: 1, entries, grants, report: report.data });
        return { ok: true, data: { entries, grants, sourceFingerprint, report: report.data } };
    }
    function preparePartialOpening(snapshot) {
        const scanned = scan(snapshot);
        if (!scanned.ok) return scanned;
        const report = scanned.data;
        // Ambiguous identity cannot be isolated without guessing which account owns the data.
        if (report.findings.some(f => f.severity === 'blocking' && (!f.ownerId || ['DUPLICATE_OWNER_ID', 'INVALID_OWNER_ID'].includes(f.code))))
            return { ok: false, error: { code: 'MIGRATION_IDENTITY_CONFLICT', retryable: false }, report };
        const blocked = new Set(report.findings.filter(f => f.severity === 'blocking').map(f => f.ownerId));
        const checklist = report.findings.filter(f => f.severity === 'blocking').map(f => ({ ...f, status: 'unresolved' }));
        // Pending monetary messages require reconciliation; never infer their original debit.
        for (const character of snapshot.characters) {
            for (const message of character.history || []) {
                if ((message.transferStatus === 'pending' || message.transferStatus === 'unreceived') && (message.type === 'transfer' || message.isTransfer || message.transferStatus)) {
                    blocked.add('user'); blocked.add(String(character.id));
                    checklist.push({ code: 'PENDING_TRANSFER_REVIEW', ownerId: String(character.id), relatedOwnerId: 'user', messageId: message.id ?? null, status: 'unresolved' });
                }
            }
        }
        for(const group of snapshot.groups || []){
            const pending=(group.history || []).filter(message=>['pending','unreceived'].includes(message.transferStatus));
            if(!pending.length)continue;
            const owners=['user',...(group.members || []).map(member=>String(member.id)).filter(id=>report.owners.some(owner=>owner.ownerId===id))];
            for(const ownerId of new Set(owners)){
                blocked.add(ownerId);
                for(const message of pending)checklist.push({code:'GROUP_PENDING_TRANSFER_REVIEW',ownerId,groupId:group.id,messageId:message.id ?? null,status:'unresolved'});
            }
        }
        // Cross-owner references are one reconciliation unit.
        let changed = true;
        while (changed) {
            changed = false;
            const transferRows = [snapshot.piggyBank, ...snapshot.characters.map(row => row.walletLedger)]
                .flatMap(wallet => Array.isArray(wallet?.currencyWallet?.transactions) ? wallet.currencyWallet.transactions : []);
            for (const row of transferRows) if (blocked.has(String(row.fromOwnerId)) || blocked.has(String(row.toOwnerId))) {
                for (const owner of [row.fromOwnerId, row.toOwnerId].map(String)) if (report.owners.some(o => o.ownerId === owner) && !blocked.has(owner)) {
                    blocked.add(owner); changed = true;
                    checklist.push({ code: 'RELATED_TRANSFER_REVIEW', ownerId: owner, transferId: row.id ?? null, status: 'unresolved' });
                }
            }
            const relations=[...report.grants,...(snapshot.piggyBank?.familyCards || []).map(card=>({id:card?.id,ownerId:'user',granteeOwnerId:String(card?.targetCharId || '')})),
                ...(snapshot.piggyBank?.receivedFamilyCards || []).map(card=>({id:card?.id,ownerId:String(card?.fromCharId || ''),granteeOwnerId:'user'}))];
            for (const grant of relations) if (blocked.has(grant.ownerId) || blocked.has(grant.granteeOwnerId)) {
                for (const owner of [grant.ownerId, grant.granteeOwnerId]) if (owner && !blocked.has(owner)) {
                    if(report.owners.some(row=>row.ownerId===owner)){blocked.add(owner);changed=true;checklist.push({code:'RELATED_GRANT_REVIEW',ownerId:owner,grantId:grant.id,status:'unresolved'});}
                }
            }
        }
        const filtered = { piggyBank: snapshot.piggyBank, characters: snapshot.characters };
        if(Array.isArray(snapshot.groups))filtered.groups=snapshot.groups;
        const entries = report.owners.filter(owner => !blocked.has(owner.ownerId)).flatMap(owner => owner.balances.map(balance => ({
            ownerId: owner.ownerId, ownerType: owner.ownerId === 'user' ? 'user' : 'character', currency: balance.currency,
            amountMinor: balance.accountMinor ?? balance.legacyMinor,
            accountId: JSON.stringify(['wallet', owner.ownerId, balance.currency]),
            openingAccountId: JSON.stringify(['opening', owner.ownerId, balance.currency])
        }))).sort((a,b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
        const grants = report.grants.filter(g => !blocked.has(g.ownerId) && !blocked.has(g.granteeOwnerId));
        if (!entries.length) return { ok: false, error: { code: 'MIGRATION_BLOCKED', retryable: false }, report, checklist };
        const sourceSnapshot = JSON.parse(JSON.stringify(filtered));
        const sourceFingerprint = JSON.stringify({ migrationVersion: 1, entries, grants, report, checklist, sourceSnapshot });
        return { ok: true, data: { entries, grants, report, checklist, sourceSnapshot, sourceFingerprint } };
    }
    function openingRecords(plan, occurredAt) {
        if (!plan || !Array.isArray(plan.entries) || !plan.entries.length || !Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new TypeError('Invalid opening plan');
        const evidence = JSON.parse(plan.sourceFingerprint);
        if (evidence.migrationVersion !== 1 || JSON.stringify(evidence.entries) !== JSON.stringify(plan.entries)) throw new TypeError('Opening evidence mismatch');
        const grants = plan.grants || [];
        if (!Array.isArray(grants) || JSON.stringify(evidence.grants || []) !== JSON.stringify(grants)) throw new TypeError('Grant evidence mismatch');
        const recordJournalId = evidence.recoveryId ? JSON.stringify([migrationOwner, evidence.recoveryId]) : journalId;
        const accounts = [], postings = [], seen = new Set();
        for (const entry of plan.entries) {
            if (!entry || typeof entry.ownerId !== 'string' || !entry.ownerId.trim() || entry.ownerId.startsWith('system:')
                || entry.ownerType !== (entry.ownerId === 'user' ? 'user' : 'character') || !global.CurrencyCore.isSupported(entry.currency)
                || !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor < 0 || seen.has(entry.accountId)
                || entry.accountId !== JSON.stringify(['wallet', entry.ownerId, entry.currency])
                || entry.openingAccountId !== JSON.stringify(['opening', entry.ownerId, entry.currency])) throw new TypeError('Invalid opening entry');
            seen.add(entry.accountId);
            const target = { id: entry.accountId, ownerId: entry.ownerId, ownerType: entry.ownerType, currency: entry.currency,
                balanceMinor: 0, reservedMinor: 0, version: 0, kind: 'wallet', status: 'active' };
            const source = { ...target, id: entry.openingAccountId, ownerId: 'system:opening', ownerType: 'system', kind: 'opening' };
            if (entry.amountMinor === 0) { accounts.push(source, target); continue; }
            const result = global.EconomyCore.previewJournal([source, target], [source, target].map((account, index) => ({
                accountId: account.id, ownerId: account.ownerId, currency: account.currency, deltaMinor: index ? entry.amountMinor : -entry.amountMinor
            })));
            if (!result.ok) throw new TypeError('Invalid opening journal');
            accounts.push(...result.data.accounts);
            for (const posting of result.data.postings) postings.push({ ...posting, id: JSON.stringify([recordJournalId, postings.length]), journalId: recordJournalId, occurredAt });
        }
        const receipt = { journalId: recordJournalId, kind: 'legacy_opening', migrationVersion: 1, entries: plan.entries, occurredAt };
        if (grants.length) receipt.grants = grants;
        const grantIds = new Set();
        for (const grant of grants) {
            if (!global.EconomyGrantCore.valid(grant) || grantIds.has(grant.id)
                || !accounts.some(a => a.id === grant.payerAccountId && a.ownerId === grant.ownerId && a.kind === 'wallet')) throw new TypeError('Invalid opening grant');
            grantIds.add(grant.id);
        }
        const journal = { id: recordJournalId, ownerId: migrationOwner, idempotencyKey: evidence.recoveryId || migrationKey, kind: 'legacy_opening',
            orderId: null, occurredAt, requestFingerprint: plan.sourceFingerprint, receipt };
        return { accounts, postings, grants, journal, receipt };
    }
    function validateOpening(journal, postings, accounts, grants = new Map()) {
        try {
            const evidence = JSON.parse(journal.requestFingerprint);
            if (evidence.sourceSnapshot && (JSON.stringify(journal.reconciliation?.sourceSnapshot) !== JSON.stringify(evidence.sourceSnapshot)
                || JSON.stringify(journal.reconciliation?.checklist) !== JSON.stringify(evidence.checklist))) return false;
            const expected = openingRecords({ entries: journal.receipt.entries, grants: journal.receipt.grants, sourceFingerprint: journal.requestFingerprint }, journal.occurredAt);
            if (Object.keys(expected.journal).some(key => key !== 'receipt' && journal[key] !== expected.journal[key])
                || Object.keys(expected.receipt).some(key => !['entries', 'grants'].includes(key) && journal.receipt[key] !== expected.receipt[key])) return false;
            if (expected.grants.some(row => ['id', 'ownerId', 'payerAccountId', 'granteeOwnerId', 'currency', 'legacyCollection', 'legacyId'].some(key => grants.get(row.id)?.[key] !== row[key])
                || JSON.stringify(grants.get(row.id)?.legacyTransactions) !== JSON.stringify(row.legacyTransactions))) return false;
            const actual = new Map(postings.map(row => [row.id, row]));
            if (actual.size !== expected.postings.length || postings.length !== expected.postings.length) return false;
            if (expected.postings.some(row => Object.keys(row).some(key => actual.get(row.id)?.[key] !== row[key]))) return false;
            // Balances/versions can legitimately change after opening; identity and denomination cannot.
            return expected.accounts.every(row => ['id', 'ownerId', 'ownerType', 'currency', 'kind'].every(key => accounts.get(row.id)?.[key] === row[key]));
        } catch (_) { return false; }
    }
    global.EconomyMigrationCore = Object.freeze({ scan, prepareOpening, preparePartialOpening, openingRecords, validateOpening, journalId });
})(typeof window !== 'undefined' ? window : globalThis);
