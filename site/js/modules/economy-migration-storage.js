// Internal migration/reconciliation adapter. The application loads it for explicit reconciliation only; never exposed to the LLM or auto-run.
(function (global) {
    'use strict';
    const fail = (code, retryable = false) => ({ ok: false, error: { code, retryable } });
    function forDatabase(database) {
        const keys = global.EconomySchema.keys;
        const sourceTables=[database.characters,database.globalSettings,...(database.groups?[database.groups]:[])];
        const controlTables=database.walletControl?[database.walletControl]:[];
        if (!database?.characters || !database.globalSettings || keys.some(key => !database[key])) throw new TypeError('Invalid migration database');
        async function readPlan(partial = false) {
            const bank = await database.globalSettings.get('piggyBank');
            const characters = (await database.characters.toArray()).map(row => ({ id: row.id, walletLedger: row.walletLedger, history: (row.history || []).filter(message => message.transferStatus) }));
            const groups=database.groups?(await database.groups.toArray()).map(row=>({id:row.id,members:(row.members || []).map(member=>({id:member.id})),history:(row.history || []).filter(message=>message.transferStatus)})):[];
            return global.EconomyMigrationCore[partial ? 'preparePartialOpening' : 'prepareOpening']({ piggyBank: bank?.value, characters,groups });
        }
        async function preview() {
            try { return await database.transaction('r', sourceTables, () => readPlan()); }
            catch (_) { return fail('PERSISTENCE_FAILED', true); }
        }
        async function commitOpening(input, partial = false) {
            const expectedFingerprint = input?.expectedFingerprint;
            if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) return fail('INVALID_REQUEST');
            try {
                return await database.transaction('rw', [...sourceTables,...controlTables, ...keys.map(key => database[key])], async () => {
                    // Read durable legacy values again under the same lock as all new writes.
                    const plan = await readPlan(partial);
                    if (!plan.ok) return plan;
                    if (plan.data.sourceFingerprint !== expectedFingerprint) return fail('SOURCE_CHANGED', true);
                    const prior = await database.economyJournals.get(global.EconomyMigrationCore.journalId);
                    if (prior) return prior.kind === 'legacy_opening' && prior.requestFingerprint === expectedFingerprint
                        ? { ok: true, data: prior.receipt } : fail('MIGRATION_CONFLICT');
                    for (const key of keys) if (await database[key].count()) return fail('TARGET_NOT_EMPTY');
                    const result = global.EconomyMigrationCore.openingRecords(plan.data, Date.now());
                    await database.economyAccounts.bulkAdd(result.accounts);
                    if (result.postings.length) await database.economyPostings.bulkAdd(result.postings);
                    if (result.grants.length) await database.economyGrants.bulkAdd(result.grants);
                    // The last write is the durable migration marker. Failure rolls back all opening entries.
                    if (partial) Object.assign(result.journal, { reconciliation: { checklist: plan.data.checklist, sourceSnapshot: plan.data.sourceSnapshot } });
                    await database.economyJournals.add(result.journal);
                    return { ok: true, data: result.receipt };
                });
            } catch (_) { return fail('PERSISTENCE_FAILED', true); }
        }
        async function confirmRecovery(input) {
            if (!input || typeof input.ownerId !== 'string' || !input.ownerId || !Array.isArray(input.balances)
                || !input.balances.length || input.confirmed !== true || typeof input.reason !== 'string' || !input.reason.trim()) return fail('INVALID_REQUEST');
            const request = JSON.parse(JSON.stringify(input));
            try {
                return await database.transaction('rw', [...sourceTables,...controlTables, ...keys.map(key => database[key])], async () => {
                    const original = await database.economyJournals.get(global.EconomyMigrationCore.journalId);
                    if (!original?.reconciliation || original.requestFingerprint !== request.expectedFingerprint) return fail('MIGRATION_CONFLICT');
                    if (!original.reconciliation.checklist.some(row => row.ownerId === request.ownerId || row.relatedOwnerId === request.ownerId)) return fail('FORBIDDEN');
                    const state=database.walletControl?await database.walletControl.get('state'):null;
                    const activation=state?.activationJournalId?await database.economyJournals.get(state.activationJournalId):null;
                    // After cutover the sealed source is authoritative; unrelated new chat must not invalidate recovery.
                    if(activation?.kind!=='ledger_activation' || activation.receipt.openingJournalId!==original.id || activation.receipt.sourceFingerprint!==state.sourceFingerprint){
                        const current=await readPlan(true);
                        if(!current.ok || current.data.sourceFingerprint!==original.requestFingerprint)return fail('SOURCE_CHANGED',true);
                    }
                    const sourceOwners = ['user', ...original.reconciliation.sourceSnapshot.characters.map(row => String(row.id))];
                    if (!sourceOwners.includes(request.ownerId)) return fail('FORBIDDEN');
                    const recoveryId = `legacy-recovery:${request.ownerId}`;
                    const recoveryJournalId = JSON.stringify(['system:migration', recoveryId]);
                    const entries = request.balances.map(row => ({ ownerId: request.ownerId, ownerType: request.ownerId === 'user' ? 'user' : 'character',
                        currency: row.currency, amountMinor: row.amountMinor, accountId: JSON.stringify(['wallet', request.ownerId, row.currency]),
                        openingAccountId: JSON.stringify(['opening', request.ownerId, row.currency]) }));
                    const sourceFingerprint = JSON.stringify({ migrationVersion: 1, entries, grants: [], recoveryId,
                        confirmation: { reason: request.reason, originalFingerprint: original.requestFingerprint } });
                    const prior = await database.economyJournals.get(recoveryJournalId);
                    if (prior) return prior.requestFingerprint === sourceFingerprint ? { ok: true, data: prior.receipt } : fail('MIGRATION_CONFLICT');
                    for (const entry of entries) if (await database.economyAccounts.get(entry.accountId)) return fail('TARGET_NOT_EMPTY');
                    const records = global.EconomyMigrationCore.openingRecords({ entries, grants: [], sourceFingerprint }, Date.now());
                    await database.economyAccounts.bulkAdd(records.accounts);
                    if (records.postings.length) await database.economyPostings.bulkAdd(records.postings);
                    await database.economyJournals.add(records.journal);
                    return { ok: true, data: records.receipt };
                });
            } catch (_) { return fail('PERSISTENCE_FAILED', true); }
        }
        return Object.freeze({ preview, commitOpening, confirmRecovery,
            getReconciliation: () => database.transaction('r', database.economyJournals, async () => {
                const original = await database.economyJournals.get(global.EconomyMigrationCore.journalId);
                if (!original?.reconciliation) return { ok: true, data: null };
                const resolutions = (await database.economyJournals.toArray()).filter(row => row.idempotencyKey?.startsWith('legacy-recovery:'));
                return { ok: true, data: { ...original.reconciliation, resolutions: resolutions.map(row => row.receipt) } };
            }), previewPartial: () => database.transaction('r', sourceTables, () => readPlan(true)), commitPartial: input => commitOpening(input, true) });
    }
    global.EconomyMigrationStorage = Object.freeze({ forDatabase });
})(typeof window !== 'undefined' ? window : globalThis);
