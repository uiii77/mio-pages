// Wallet state, idempotency, holds and ledger records form one full-backup unit.
function economyBackupKeys(){return EconomySchema.backupKeys || EconomySchema.keys;}
async function readEconomyBackupSnapshot(staging = false) {
    const keys = economyBackupKeys();
    const tables = keys.map(key => dexieDB[staging ? EconomySchema.stagingName(key) : key]);
    return dexieDB.transaction('r', tables, async () => Object.fromEntries(
        await Promise.all(keys.map(async (key, index) => [key, await tables[index].toArray()]))));
}

async function readFinancialBackupUnit(){
    const memoryCharacters=JSON.parse(JSON.stringify(db.characters || [])),memoryBank=JSON.parse(JSON.stringify(db.piggyBank ?? null));
    return dexieDB.transaction('r',[dexieDB.characters,dexieDB.globalSettings,...economyBackupKeys().map(key=>dexieDB[key])],async()=>{
        const economy=await readEconomyBackupSnapshot();
        const characters=await dexieDB.characters.toArray(),bank=await dexieDB.globalSettings.get('piggyBank');
        if(economy.walletOperations?.length && !window.WalletStorage)throw Error('钱包组件未就绪，请刷新后重新导出');
        return {economy,bank:bank?.value ?? memoryBank,characters:window.WalletStorage ? window.WalletStorage.mergeBackupCharacters(memoryCharacters,characters) : memoryCharacters};
    });
}

function validateEconomyBackupKeys(keys, isPartial) {
    const included = economyBackupKeys().filter(key => keys.includes(key));
    if (included.length && isPartial) throw new Error('账务数据只能通过完整备份恢复，不能分类合并');
    if (included.length && EconomySchema.keys.filter(key => key !== 'economyGrants').some(key => !included.includes(key))) throw new Error('账务备份不完整：账户、流水、分录、事件和订单必须一起恢复');
}

function validateAdditionalEconomyJournal(journal,postings,maps,invalid,postingsByJournal){
    const kinds=['currency_account_open','grant_change','commerce_activation','ledger_activation','exchange','income','adjustment','reversal','reserve_transfer','accept_transfer','return_transfer','expire_transfer','grant_renewal'];
    if(!kinds.includes(journal.kind))return false;
    const minor=value=>Number.isSafeInteger(value)&&value>=0,receipt=journal.receipt;
    let request;try{request=JSON.parse(journal.requestFingerprint);}catch(_){invalid();}
    if(!request || request.kind!==journal.kind || request.ownerId!==journal.ownerId || request.idempotencyKey!==journal.idempotencyKey
        || journal.id!==JSON.stringify([journal.ownerId,journal.idempotencyKey]) || journal.orderId!==null
        || !receipt || receipt.journalId!==journal.id || receipt.kind!==journal.kind || receipt.ownerId!==journal.ownerId
        || !minor(journal.occurredAt) || receipt.occurredAt!==journal.occurredAt || !['ledger_activation','commerce_activation'].includes(journal.kind) && !maps.economyOutbox.has(journal.id))invalid();
    const accounts=maps.economyAccounts;
    const exact=(accountId,delta)=>postings.some(row=>row.accountId===accountId && row.deltaMinor===delta && row.occurredAt===journal.occurredAt);
    if(journal.kind==='currency_account_open'){
        const account=accounts.get(receipt.accountId);if(postings.length||!account||account.kind!=='wallet'||account.currency!==receipt.currency||request.accountId!==account.id)invalid();
    }else if(journal.kind==='grant_change'){
        if(postings.length || !EconomyGrantCore.valid(receipt.after) || receipt.after.id!==receipt.grantId || !maps.economyGrants.has(receipt.grantId) || ![receipt.after.ownerId,receipt.after.granteeOwnerId].includes(journal.ownerId) || receipt.action!==request.action || request.grantId!==receipt.grantId || receipt.before && (!EconomyGrantCore.valid(receipt.before)||receipt.before.id!==receipt.grantId||receipt.after.version!==receipt.before.version+1))invalid();
    }else if(journal.kind==='commerce_activation'){
        if(postings.length || journal.ownerId!=='system:commerce' || request.protocol!==1 || receipt.protocol!==1 || maps.economyOutbox.has(journal.id))invalid();
    }else if(journal.kind==='ledger_activation'){
        if(postings.length || journal.ownerId!=='system:wallet' || request.protocol!==1 || receipt.protocol!==1
            || typeof request.sourceFingerprint!=='string' || !request.sourceFingerprint || receipt.sourceFingerprint!==request.sourceFingerprint
            || maps.economyOutbox.has(journal.id))invalid();
    }else if(journal.kind==='exchange'){
        const source=accounts.get(receipt.sourceAccountId),target=accounts.get(receipt.targetAccountId);
        if(!source || !target || source.ownerId!==journal.ownerId || source.kind!=='wallet' || target.kind!=='wallet'
            || request.sourceAccountId!==source.id || request.targetAccountId!==target.id || !minor(request.expectedSourceVersion))invalid();
        const quote=EconomyCore.quoteExchange(request.amountMinor,source.currency,target.currency,request.rate);
        if(!quote.ok || !receipt.rateSnapshot || Object.keys(quote.data).some(key=>receipt.rateSnapshot[key]!==quote.data[key])
            || receipt.amountMinor!==request.amountMinor || receipt.targetAmountMinor!==quote.data.targetAmountMinor
            || postings.length!==4 || !exact(source.id,-receipt.amountMinor) || !exact(target.id,receipt.targetAmountMinor))invalid();
        for(const [currency,amount] of [[source.currency,receipt.amountMinor],[target.currency,-receipt.targetAmountMinor]]){
            if(!postings.some(row=>{const account=accounts.get(row.accountId);return account?.ownerType==='system' && account.kind==='exchange' && account.currency===currency && row.deltaMinor===amount;}))invalid();
        }
    }else if(['income','adjustment','reversal'].includes(journal.kind)){
        const account=accounts.get(receipt.accountId);
        if(!account || account.kind!=='wallet' || account.ownerId!==journal.ownerId || receipt.currency!==account.currency
            || !Number.isSafeInteger(receipt.deltaMinor) || receipt.deltaMinor===0 || typeof receipt.reason!=='string' || !receipt.reason.trim() || receipt.reason!==request.reason)invalid();
        if(journal.kind==='reversal'){
            const original=maps.economyJournals.get(request.originalJournalId);
            if(!original || !['income','adjustment'].includes(original.kind) || original.ownerId!==journal.ownerId || original.reversalJournalId!==journal.id
                || receipt.originalJournalId!==original.id || receipt.accountId!==original.receipt.accountId || receipt.deltaMinor!==-original.receipt.deltaMinor)invalid();
            const old=postingsByJournal.get(original.id)||[];
            if(postings.length!==old.length || old.some(row=>!exact(row.accountId,-row.deltaMinor)))invalid();
        }else{
            if(request.sourceAccountId!==account.id || !minor(request.expectedSourceVersion) || postings.length!==2 || !exact(account.id,receipt.deltaMinor)
                || !postings.some(row=>{const peer=accounts.get(row.accountId);return peer?.ownerType==='system' && peer.kind==='income' && peer.currency===account.currency && row.deltaMinor===-receipt.deltaMinor;}))invalid();
            if(journal.kind==='income' && (request.amountMinor!==receipt.deltaMinor || receipt.deltaMinor<=0))invalid();
            if(journal.kind==='adjustment' && !minor(request.targetBalanceMinor))invalid();
        }
    }else if(journal.kind==='grant_renewal'){
        const grant=maps.economyGrants.get(request.grantId);
        if(!grant || ![grant.ownerId,grant.granteeOwnerId].includes(journal.ownerId) || receipt.grantId!==grant.id || !minor(request.expectedGrantVersion)
            || !minor(receipt.periodStartAt) || receipt.periodStartAt>grant.period.startAt || postings.length)invalid();
    }else{
        const transfer=maps.economyTransfers.get(receipt.transferId);
        if(!transfer || receipt.sourceAccountId!==transfer.sourceAccountId || receipt.targetAccountId!==transfer.targetAccountId
            || receipt.currency!==transfer.currency || receipt.amountMinor!==transfer.amountMinor)invalid();
        if(journal.kind==='reserve_transfer'){
            if(journal.id!==transfer.id || journal.ownerId!==transfer.senderOwnerId || transfer.createdAt!==journal.occurredAt
                || request.sourceAccountId!==transfer.sourceAccountId || request.targetAccountId!==transfer.targetAccountId
                || request.amountMinor!==transfer.amountMinor || request.expiresAt!==transfer.expiresAt || !minor(request.expectedSourceVersion) || postings.length)invalid();
        }else{
            const expected=journal.kind==='accept_transfer'?'accepted':journal.kind==='return_transfer'?'returned':'expired';
            if(transfer.state!==expected || transfer.settlementJournalId!==journal.id || receipt.state!==expected || request.transferId!==transfer.id
                || request.expectedTransferVersion!==0 || ![transfer.senderOwnerId,transfer.recipientOwnerId].includes(journal.ownerId))invalid();
            if(expected==='accepted'){
                if(journal.ownerId!==transfer.recipientOwnerId || journal.occurredAt>=transfer.expiresAt || postings.length!==2
                    || !exact(transfer.sourceAccountId,-transfer.amountMinor) || !exact(transfer.targetAccountId,transfer.amountMinor))invalid();
            }else if(postings.length || expected==='expired' && journal.occurredAt<transfer.expiresAt)invalid();
        }
    }
    return true;
}

function validateWalletBackupMetadata(snapshot,maps,invalid){
    const minor=value=>Number.isSafeInteger(value)&&value>=0;
    const state=maps.walletControl?.get('state');
    for(const control of maps.walletControl?.values() || [])if(control.id!=='state' || !['legacy','frozen','ledger'].includes(control.mode) || !minor(control.version)
        || control.quarantinedOwnerIds!==undefined && (!Array.isArray(control.quarantinedOwnerIds) || control.quarantinedOwnerIds.some(id=>typeof id!=='string') || new Set(control.quarantinedOwnerIds).size!==control.quarantinedOwnerIds.length))invalid();
    if(state && (EconomySchema.walletBackupKeys || economyBackupKeys()).some(key=>!Array.isArray(snapshot[key])))invalid();
    for(const operation of maps.walletOperations?.values() || []){
        let identity;try{identity=JSON.parse(operation.id);}catch(_){invalid();}
        if(!Array.isArray(identity) || identity.length!==2 || identity[0]!==operation.ownerId || typeof identity[1]!=='string'
            || !/^[a-f0-9]{64}$/.test(operation.fingerprint) || operation.receipt?.id!==operation.id || !minor(operation.receipt.revision) || !operation.receipt.revision)invalid();
        if(snapshot.piggyBank && (!minor(snapshot.piggyBank._walletRevision) || operation.receipt.revision>snapshot.piggyBank._walletRevision))invalid();
    }
    if(state?.preferences&&(typeof state.preferences!=='object'||Array.isArray(state.preferences)||Object.values(state.preferences).some(code=>!CurrencyCore.isSupported(code))))invalid();
    const reservations=new Map();
    for(const transfer of maps.economyTransfers?.values() || []){
        const source=maps.economyAccounts.get(transfer.sourceAccountId),target=maps.economyAccounts.get(transfer.targetAccountId),reserve=maps.economyJournals.get(transfer.id);
        if(!source || !target || source.kind!=='wallet' || target.kind!=='wallet' || source.id===target.id
            || source.ownerId!==transfer.senderOwnerId || target.ownerId!==transfer.recipientOwnerId || source.currency!==transfer.currency || target.currency!==transfer.currency
            || !minor(transfer.amountMinor) || !transfer.amountMinor || !minor(transfer.createdAt) || !minor(transfer.expiresAt) || transfer.expiresAt<=transfer.createdAt
            || !reserve || reserve.kind!=='reserve_transfer' || !['pending','accepted','returned','expired'].includes(transfer.state))invalid();
        if(transfer.state==='pending'){
            if(transfer.version!==0 || transfer.settlementJournalId || transfer.settledAt)invalid();
            reservations.set(source.id,(reservations.get(source.id) || 0n)+BigInt(transfer.amountMinor));
        }else if(transfer.version!==1 || !minor(transfer.settledAt) || transfer.settledAt<transfer.createdAt || !maps.economyJournals.has(transfer.settlementJournalId))invalid();
    }
    if(state?.mode==='ledger' || state?.activationJournalId){
        const activation=maps.economyJournals.get(state.activationJournalId);
        if(!activation || activation.kind!=='ledger_activation' || activation.receipt.sourceFingerprint!==state.sourceFingerprint || state.mode==='legacy')invalid();
        const opening=maps.economyJournals.get(activation.receipt.openingJournalId);
        if(!opening || opening.kind!=='legacy_opening' || typeof CryptoJS==='undefined' || CryptoJS.SHA256(opening.requestFingerprint).toString()!==state.sourceFingerprint)invalid();
        const balances=new Map();
        for(const row of maps.economyPostings.values())balances.set(row.accountId,(balances.get(row.accountId) || 0n)+BigInt(row.deltaMinor));
        for(const account of maps.economyAccounts.values())if(BigInt(account.balanceMinor)!==(balances.get(account.id) || 0n)
            || BigInt(account.reservedMinor)!==(reservations.get(account.id) || 0n))invalid();
    }else if(maps.economyTransfers.size){
        for(const account of maps.economyAccounts.values())if(BigInt(account.reservedMinor)!==(reservations.get(account.id) || 0n))invalid();
    }
}

// Validate persisted references before any live table is cleared. No repair or balance recalculation.
function validateEconomyBackupSnapshot(snapshot) {
    const invalid = () => { throw new Error('账务备份校验失败：金额、交易或订单引用不完整'); };
    const id = value => typeof value === 'string' && value.trim().length > 0;
    const minor = value => Number.isSafeInteger(value) && value >= 0;
    const maps = {};
    for (const key of economyBackupKeys()) {
        const optional=!EconomySchema.keys.includes(key) || key==='economyGrants';
        const rows = optional && snapshot[key] === undefined ? [] : snapshot[key];
        if (!Array.isArray(rows)) invalid();
        const field = key === 'economyOutbox' ? 'eventId' : 'id';
        maps[key] = new Map();
        for (const row of rows) {
            if (!row || !id(row[field]) || maps[key].has(row[field])) invalid();
            maps[key].set(row[field], row);
        }
    }
    const accounts = maps.economyAccounts, journals = maps.economyJournals, orders = maps.commerceOrders;
    for (const grant of maps.economyGrants.values()) {
        const payer = accounts.get(grant.payerAccountId);
        if (!EconomyGrantCore.valid(grant) || !payer || payer.kind !== 'wallet' || payer.ownerId !== grant.ownerId || payer.currency !== grant.currency) invalid();
    }
    for (const account of accounts.values()) {
        const system = account.ownerType === 'system';
        if (!id(account.ownerId) || !CurrencyCore.isSupported(account.currency) || account.currency!==CurrencyCore.currency(account.currency)
            || !['user', 'character', 'system'].includes(account.ownerType)
            || (system ? !['merchant', 'income', 'opening', 'exchange'].includes(account.kind) : account.kind !== 'wallet')
            || !['active', 'frozen', 'closed'].includes(account.status)
            || !Number.isSafeInteger(account.balanceMinor) || (!system && account.balanceMinor < 0)
            || !minor(account.reservedMinor) || (system ? account.reservedMinor !== 0 : account.reservedMinor > account.balanceMinor)
            || !minor(account.version)) invalid();
    }
    const postingsByJournal = new Map();
    for (const posting of maps.economyPostings.values()) {
        const account = accounts.get(posting.accountId);
        if (!account || !journals.has(posting.journalId) || posting.ownerId !== account.ownerId
            || posting.currency !== account.currency || !Number.isSafeInteger(posting.deltaMinor)
            || posting.deltaMinor === 0 || !minor(posting.occurredAt)) invalid();
        if (!postingsByJournal.has(posting.journalId)) postingsByJournal.set(posting.journalId, []);
        postingsByJournal.get(posting.journalId).push(posting);
    }
    for (const journal of journals.values()) {
        const receipt = journal.receipt, postings = postingsByJournal.get(journal.id) || [];
        if(validateAdditionalEconomyJournal(journal,postings,maps,invalid,postingsByJournal))continue;
        if (journal.kind === 'legacy_opening') {
            if (!EconomyMigrationCore.validateOpening(journal, postings, accounts, maps.economyGrants) || maps.economyOutbox.has(journal.id)) invalid();
            continue;
        }
        if (journal.kind === 'order_refund') {
            const original = journals.get(receipt?.originalJournalId), order = orders.get(journal.orderId);
            let request; try { request = JSON.parse(journal.requestFingerprint); } catch (_) { invalid(); }
            if (!original || original.kind !== 'order_payment' || !order || original.orderId !== order.id
                || ![order.buyerOwnerId, order.payerOwnerId].includes(journal.ownerId)
                || journal.id !== JSON.stringify([journal.ownerId,journal.idempotencyKey])
                || !receipt || receipt.journalId !== journal.id || receipt.kind !== journal.kind || receipt.orderId !== order.id
                || receipt.sourceAccountId !== original.receipt.targetAccountId || receipt.targetAccountId !== original.receipt.sourceAccountId
                || receipt.currency !== original.receipt.currency || !minor(receipt.amountMinor) || !receipt.amountMinor
                || receipt.occurredAt !== journal.occurredAt || !minor(journal.occurredAt) || postings.length !== 2
                || !postings.some(p=>p.accountId===receipt.sourceAccountId && p.deltaMinor===-receipt.amountMinor)
                || !postings.some(p=>p.accountId===receipt.targetAccountId && p.deltaMinor===receipt.amountMinor)
                || !request || request.kind !== journal.kind || request.ownerId !== journal.ownerId || request.orderId !== order.id
                || request.idempotencyKey !== journal.idempotencyKey || request.amountMinor !== receipt.amountMinor
                || !minor(request.expectedOrderVersion) || !maps.economyOutbox.has(journal.id)) invalid();
            continue;
        }
        if (!id(journal.ownerId) || !id(journal.idempotencyKey)
            || journal.id !== JSON.stringify([journal.ownerId, journal.idempotencyKey])
            || !['transfer', 'order_payment'].includes(journal.kind) || !id(journal.requestFingerprint)
            || !receipt || receipt.journalId !== journal.id || receipt.kind !== journal.kind
            || receipt.orderId !== journal.orderId || receipt.occurredAt !== journal.occurredAt
            || !minor(journal.occurredAt) || !minor(receipt.amountMinor) || receipt.amountMinor === 0
            || postings.length !== 2) invalid();
        const source = accounts.get(receipt.sourceAccountId), target = accounts.get(receipt.targetAccountId);
        if (!source || !target || source.id === target.id || !receipt.grantId && source.ownerId !== journal.ownerId
            || source.currency !== receipt.currency || target.currency !== receipt.currency) invalid();
        if (receipt.grantId) {
            const grant = maps.economyGrants.get(receipt.grantId);
            if (journal.kind !== 'order_payment' || !grant || grant.payerAccountId !== source.id
                || grant.granteeOwnerId !== journal.ownerId || orders.get(journal.orderId)?.buyerOwnerId !== journal.ownerId
                || !minor(receipt.grantPeriodStartAt)) invalid();
        }
        for (const [account, delta] of [[source, -receipt.amountMinor], [target, receipt.amountMinor]]) {
            if (!postings.some(p => p.accountId === account.id && p.deltaMinor === delta && p.occurredAt === journal.occurredAt)) invalid();
        }
        if (journal.kind === 'transfer' ? journal.orderId !== null : !orders.has(journal.orderId)) invalid();
        let request;
        try { request = JSON.parse(journal.requestFingerprint); } catch (_) { invalid(); }
        if (!request || request.kind !== journal.kind || request.ownerId !== journal.ownerId
            || request.idempotencyKey !== journal.idempotencyKey || request.sourceAccountId !== receipt.sourceAccountId
            || !minor(request.expectedSourceVersion)) invalid();
        if (journal.kind === 'transfer') {
            if (request.targetAccountId !== receipt.targetAccountId || request.amountMinor !== receipt.amountMinor
                || source.kind !== 'wallet' || target.kind !== 'wallet') invalid();
        } else if (request.orderId !== journal.orderId || !minor(request.expectedOrderVersion)
            || orders.get(journal.orderId).paymentJournalId !== journal.id) invalid();
        if (receipt.grantId && (request.grantId !== receipt.grantId || !minor(request.expectedGrantVersion))) invalid();
        if (!maps.economyOutbox.has(journal.id)) invalid();
    }
    for (const order of orders.values()) {
        const merchant = accounts.get(order.merchantAccountId);
        if (!id(order.payerOwnerId) || !minor(order.version) || !minor(order.totalMinor) || order.totalMinor === 0
            || !merchant || merchant.ownerType !== 'system' || merchant.kind !== 'merchant' || merchant.currency !== order.currency) invalid();
        if (order.paymentState === 'unpaid') {
            if (order.status !== 'pending_payment' || order.paymentJournalId) invalid();
        } else if (['paid','partially_refunded','refunded'].includes(order.paymentState)) {
            const journal = journals.get(order.paymentJournalId);
            if (!journal || journal.kind !== 'order_payment' || journal.orderId !== order.id
                || accounts.get(journal.receipt.sourceAccountId)?.ownerId !== order.payerOwnerId || journal.receipt.amountMinor !== order.totalMinor
                || journal.receipt.currency !== order.currency || journal.receipt.sourceAccountId !== order.paymentAccountId
                || journal.receipt.targetAccountId !== order.merchantAccountId || journal.occurredAt !== order.paidAt
                || !(order.batchId?['confirmed','paid','accepted','ready','picked_up','delivered','cancelled']:['confirmed']).includes(order.status)) invalid();
        } else invalid();
    }
    const refundJournalsByOrder=new Map();
    for(const journal of journals.values())if(journal.kind==='order_refund'){if(!refundJournalsByOrder.has(journal.orderId))refundJournalsByOrder.set(journal.orderId,[]);refundJournalsByOrder.get(journal.orderId).push(journal);}
    for (const order of orders.values()) {
        const refunds = (refundJournalsByOrder.get(order.id)||[]).filter(j=>j.kind==='order_refund' && j.orderId===order.id);
        const total = refunds.reduce((sum,j)=>sum+BigInt(j.receipt.amountMinor),0n);
        if (total !== BigInt(order.refundedMinor ?? 0) || total > BigInt(order.totalMinor)
            || (order.paymentState === 'refunded' && total !== BigInt(order.totalMinor))
            || (order.paymentState === 'partially_refunded' && (total===0n || total===BigInt(order.totalMinor)))
            || (order.paymentState === 'paid' && total!==0n)) invalid();
    }
    for (const event of maps.economyOutbox.values()) {
        const journal = journals.get(event.eventId);
        const type=journal?.kind==='transfer'?'transfer_posted':journal?.kind==='order_refund'?'order_refunded':journal?.kind==='order_payment'?'order_paid':journal?.kind;
        if (!journal || !['pending', 'sent', 'failed'].includes(event.state) || !minor(event.attempts)
            || event.type!==type || event.ownerId!==undefined && event.ownerId!==journal.ownerId
            || !event.payload || Object.keys(journal.receipt).some(key => JSON.stringify(event.payload[key]) !== JSON.stringify(journal.receipt[key]))) invalid();
    }
    validateWalletBackupMetadata(snapshot,maps,invalid);
    if([...journals.values()].some(row=>row.kind==='commerce_activation') && (Object.keys(EconomySchema.commerceTables || {}).some(key=>!Array.isArray(snapshot[key])) || !snapshot.commerceBatches?.length))invalid();
    if(Object.keys(EconomySchema.commerceTables || {}).some(key=>snapshot[key]?.length)){if(!window.CommerceStorage?.validateBackup)invalid();window.CommerceStorage.validateBackup(snapshot,invalid);}
}

async function createFullBackupData() {
    const backupData = JSON.parse(JSON.stringify(db));
    for(const key of ['mioCatalogFactsV1','mioTrpgReadingLinksV1']){const owned=await dexieDB?.globalSettings.get(key);if(owned)backupData[key]=owned.value;}
    const keys = window.globalSettingKeysForBackup || [];
    keys.forEach(k => {
        if (db[k] !== undefined && backupData[k] === undefined) {
            try { backupData[k] = JSON.parse(JSON.stringify(db[k])); } catch (e) { backupData[k] = db[k]; }
        }
    });
    if (dexieDB?.naiVibeAssets) {
        backupData.naiVibeAssets = await dexieDB.naiVibeAssets.toArray();
        backupData.naiVibeEncodings = await dexieDB.naiVibeEncodings.toArray();
        backupData.naiVibeGroups = await dexieDB.naiVibeGroups.toArray();
    }
    if (dexieDB?.recordedAudioAssets) backupData.recordedAudioAssets = await dexieDB.recordedAudioAssets.toArray();
    if (dexieDB?.memoryPalaceNodes) {
        backupData.memoryPalaceNodes = await dexieDB.memoryPalaceNodes.toArray();
        backupData.memoryPalaceVectors = await dexieDB.memoryPalaceVectors.toArray();
        if (dexieDB.memoryPalaceLinks) backupData.memoryPalaceLinks = await dexieDB.memoryPalaceLinks.toArray();
        if (dexieDB.memoryPalaceEventBoxes) backupData.memoryPalaceEventBoxes = await dexieDB.memoryPalaceEventBoxes.toArray();
        if (dexieDB.memoryPalaceRoomPlates) backupData.memoryPalaceRoomPlates = await dexieDB.memoryPalaceRoomPlates.toArray();
        if (dexieDB.memoryPalaceAnticipations) backupData.memoryPalaceAnticipations = await dexieDB.memoryPalaceAnticipations.toArray();
        if (dexieDB.memoryPalaceDigestReports) backupData.memoryPalaceDigestReports = await dexieDB.memoryPalaceDigestReports.toArray();
        if (dexieDB.relationshipMemoryProfiles) backupData.relationshipMemoryProfiles = await dexieDB.relationshipMemoryProfiles.toArray();
    }
    if (dexieDB?.dailySchedules) backupData.dailySchedules = await dexieDB.dailySchedules.toArray();
    if (dexieDB?.scheduleActivityLedger) backupData.scheduleActivityLedger = await dexieDB.scheduleActivityLedger.toArray();
    if (dexieDB?.lifePacks) backupData.lifePacks = await dexieDB.lifePacks.toArray();
    if (dexieDB?.lifeSources) backupData.lifeSources = await dexieDB.lifeSources.toArray();
    if (dexieDB?.lifeChunks) backupData.lifeChunks = await dexieDB.lifeChunks.toArray();
    if (dexieDB?.lifeEvents) backupData.lifeEvents = await dexieDB.lifeEvents.toArray();
    if (dexieDB?.sharedAssets) backupData.sharedAssets = await dexieDB.sharedAssets.toArray();
    if (dexieDB?.readingDocuments) backupData.readingDocuments = await dexieDB.readingDocuments.toArray();
    if (dexieDB?.readingDocumentChunks) backupData.readingDocumentChunks = await dexieDB.readingDocumentChunks.toArray();
    if (dexieDB?.readingSessions) backupData.readingSessions = await dexieDB.readingSessions.toArray();
    if (dexieDB?.readingLibraryEntries) backupData.readingLibraryEntries = await dexieDB.readingLibraryEntries.toArray();
    if (dexieDB?.readingAnnotations) backupData.readingAnnotations = await dexieDB.readingAnnotations.toArray();
    if (dexieDB?.readingActivities) backupData.readingActivities = await dexieDB.readingActivities.toArray();
    if (dexieDB?.readingResources) backupData.readingResources = await dexieDB.readingResources.toArray();
    if (dexieDB?.collaborationSessions) backupData.collaborationSessions = await dexieDB.collaborationSessions.toArray();
    if (dexieDB?.collaborationMessages) backupData.collaborationMessages = await dexieDB.collaborationMessages.toArray();
    if (dexieDB?.sharedDocuments) backupData.sharedDocuments = await dexieDB.sharedDocuments.toArray();
    if (dexieDB?.sharedDocumentBlocks) backupData.sharedDocumentBlocks = await dexieDB.sharedDocumentBlocks.toArray();
    if (dexieDB?.sharedDocumentRevisions) backupData.sharedDocumentRevisions = await dexieDB.sharedDocumentRevisions.toArray();
    if (dexieDB?.sharedDocumentComments) backupData.sharedDocumentComments = await dexieDB.sharedDocumentComments.toArray();
    if (dexieDB?.sharedDocumentSuggestions) backupData.sharedDocumentSuggestions = await dexieDB.sharedDocumentSuggestions.toArray();
    if (dexieDB?.watchTogetherSessions) backupData.watchTogetherSessions = await dexieDB.watchTogetherSessions.toArray();
    if (dexieDB?.exchangeDiaryEntries) backupData.exchangeDiaryEntries = await dexieDB.exchangeDiaryEntries.toArray();
    if (dexieDB?.periodRecords) backupData.periodRecords = await dexieDB.periodRecords.toArray();
    if (dexieDB?.coupleSpaces) backupData.coupleSpaces = await dexieDB.coupleSpaces.toArray();
    if (dexieDB?.coupleSpaceItems) backupData.coupleSpaceItems = await dexieDB.coupleSpaceItems.toArray();
    if (dexieDB?.trpgCampaigns) backupData.trpgCampaigns = await dexieDB.trpgCampaigns.toArray();
    for (const key of ['trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents']) if (dexieDB?.[key]) backupData[key] = await dexieDB[key].toArray();
    const financial=await readFinancialBackupUnit();
    Object.assign(backupData,financial.economy);
    backupData.characters=financial.characters;
    if(financial.bank!==null)backupData.piggyBank=financial.bank;
    backupData._exportVersion = '3.0';
    backupData._exportTimestamp = Date.now();
    return backupData;
}

// 小剧场相关的所有 db 键（用于分类导出/导入）
const THEATER_DB_KEYS = [
    'theaterScenarios', 'theaterPromptPresets',
    'theaterHtmlScenarios', 'theaterHtmlPromptPresets',
    'theaterMode', 'theaterApiSettings', 'theaterFontSize', 'theaterFontPreset'
];

// 分类导出：只包含选中的表
async function createPartialBackupData(selectedKeys) {
    validateEconomyBackupKeys(selectedKeys, true);
    const keys = window.globalSettingKeysForBackup || [];
    const result = { _exportVersion: '3.0_partial', _exportTimestamp: Date.now(), _exportTables: selectedKeys };
    for (const key of selectedKeys) {
        if (economyBackupKeys().includes(key)) continue;
        if (key === 'globalSettings') {
            result.globalSettings = {};
            keys.forEach(k => { result.globalSettings[k] = db[k] !== undefined ? JSON.parse(JSON.stringify(db[k])) : undefined; });
            economyBackupKeys().forEach(k => { delete result.globalSettings[k]; });
            for(const key of ['mioCatalogFactsV1','mioTrpgReadingLinksV1']){const owned=await dexieDB?.globalSettings.get(key);if(owned)result.globalSettings[key]=owned.value;}
            if (dexieDB?.naiVibeAssets) {
                result.globalSettings.naiVibeAssets = await dexieDB.naiVibeAssets.toArray();
                result.globalSettings.naiVibeEncodings = await dexieDB.naiVibeEncodings.toArray();
                result.globalSettings.naiVibeGroups = await dexieDB.naiVibeGroups.toArray();
            }
            if (dexieDB?.recordedAudioAssets) result.globalSettings.recordedAudioAssets = await dexieDB.recordedAudioAssets.toArray();
            if (dexieDB?.memoryPalaceNodes) {
                result.globalSettings.memoryPalaceNodes = await dexieDB.memoryPalaceNodes.toArray();
                result.globalSettings.memoryPalaceVectors = await dexieDB.memoryPalaceVectors.toArray();
                if (dexieDB.memoryPalaceLinks) result.globalSettings.memoryPalaceLinks = await dexieDB.memoryPalaceLinks.toArray();
                if (dexieDB.memoryPalaceEventBoxes) result.globalSettings.memoryPalaceEventBoxes = await dexieDB.memoryPalaceEventBoxes.toArray();
                if (dexieDB.memoryPalaceRoomPlates) result.globalSettings.memoryPalaceRoomPlates = await dexieDB.memoryPalaceRoomPlates.toArray();
                if (dexieDB.memoryPalaceAnticipations) result.globalSettings.memoryPalaceAnticipations = await dexieDB.memoryPalaceAnticipations.toArray();
                if (dexieDB.memoryPalaceDigestReports) result.globalSettings.memoryPalaceDigestReports = await dexieDB.memoryPalaceDigestReports.toArray();
                if (dexieDB.relationshipMemoryProfiles) result.globalSettings.relationshipMemoryProfiles = await dexieDB.relationshipMemoryProfiles.toArray();
            }
            if (dexieDB?.dailySchedules) result.globalSettings.dailySchedules = await dexieDB.dailySchedules.toArray();
            if (dexieDB?.scheduleActivityLedger) result.globalSettings.scheduleActivityLedger = await dexieDB.scheduleActivityLedger.toArray();
            if (dexieDB?.lifePacks) result.globalSettings.lifePacks = await dexieDB.lifePacks.toArray();
            if (dexieDB?.lifeSources) result.globalSettings.lifeSources = await dexieDB.lifeSources.toArray();
            if (dexieDB?.lifeChunks) result.globalSettings.lifeChunks = await dexieDB.lifeChunks.toArray();
            if (dexieDB?.lifeEvents) result.globalSettings.lifeEvents = await dexieDB.lifeEvents.toArray();
            if (dexieDB?.sharedAssets) result.globalSettings.sharedAssets = await dexieDB.sharedAssets.toArray();
            if (dexieDB?.readingDocuments) result.globalSettings.readingDocuments = await dexieDB.readingDocuments.toArray();
            if (dexieDB?.readingDocumentChunks) result.globalSettings.readingDocumentChunks = await dexieDB.readingDocumentChunks.toArray();
            if (dexieDB?.readingSessions) result.globalSettings.readingSessions = await dexieDB.readingSessions.toArray();
            if (dexieDB?.readingLibraryEntries) result.globalSettings.readingLibraryEntries = await dexieDB.readingLibraryEntries.toArray();
            if (dexieDB?.readingAnnotations) result.globalSettings.readingAnnotations = await dexieDB.readingAnnotations.toArray();
            if (dexieDB?.readingActivities) result.globalSettings.readingActivities = await dexieDB.readingActivities.toArray();
            if (dexieDB?.readingResources) result.globalSettings.readingResources = await dexieDB.readingResources.toArray();
            if (dexieDB?.collaborationSessions) result.globalSettings.collaborationSessions = await dexieDB.collaborationSessions.toArray();
            if (dexieDB?.collaborationMessages) result.globalSettings.collaborationMessages = await dexieDB.collaborationMessages.toArray();
            if (dexieDB?.sharedDocuments) result.globalSettings.sharedDocuments = await dexieDB.sharedDocuments.toArray();
            if (dexieDB?.sharedDocumentBlocks) result.globalSettings.sharedDocumentBlocks = await dexieDB.sharedDocumentBlocks.toArray();
            if (dexieDB?.sharedDocumentRevisions) result.globalSettings.sharedDocumentRevisions = await dexieDB.sharedDocumentRevisions.toArray();
            if (dexieDB?.sharedDocumentComments) result.globalSettings.sharedDocumentComments = await dexieDB.sharedDocumentComments.toArray();
            if (dexieDB?.sharedDocumentSuggestions) result.globalSettings.sharedDocumentSuggestions = await dexieDB.sharedDocumentSuggestions.toArray();
            if (dexieDB?.watchTogetherSessions) result.globalSettings.watchTogetherSessions = await dexieDB.watchTogetherSessions.toArray();
            if (dexieDB?.exchangeDiaryEntries) result.globalSettings.exchangeDiaryEntries = await dexieDB.exchangeDiaryEntries.toArray();
            if (dexieDB?.periodRecords) result.globalSettings.periodRecords = await dexieDB.periodRecords.toArray();
            if (dexieDB?.coupleSpaces) result.globalSettings.coupleSpaces = await dexieDB.coupleSpaces.toArray();
            if (dexieDB?.coupleSpaceItems) result.globalSettings.coupleSpaceItems = await dexieDB.coupleSpaceItems.toArray();
            if (dexieDB?.trpgCampaigns) result.globalSettings.trpgCampaigns = await dexieDB.trpgCampaigns.toArray();
            for (const key of ['trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents']) if (dexieDB?.[key]) result.globalSettings[key] = await dexieDB[key].toArray();
        } else if (key === 'theaterData') {
            result.theaterData = {};
            THEATER_DB_KEYS.forEach(k => { result.theaterData[k] = db[k] !== undefined ? JSON.parse(JSON.stringify(db[k])) : undefined; });
        } else if (db[key] !== undefined) {
            result[key] = JSON.parse(JSON.stringify(db[key]));
        }
    }
    return result;
}

// 大数据备份采用逐记录 NDJSON + gzip。旧 .ee 仍由原导入逻辑读取。
// 记录保持足够小，避免同时创建完整 db 副本、完整 JSON 字符串和压缩输入。
const OVO_STREAM_BACKUP_FORMAT = 'ovo-stream-backup';
const OVO_STREAM_BACKUP_FORMAT_REVISION = 1;
const OVO_STREAM_HISTORY_BATCH_BYTES = 512 * 1024;
const OVO_STREAM_HISTORY_BATCH_COUNT = 50;

function getBackupDataKeys(selectedKeys) {
    if (Array.isArray(selectedKeys)) validateEconomyBackupKeys(selectedKeys, true);
    const allGlobalKeys = window.globalSettingKeysForBackup || [];
    const keys = new Set();
    if(!Array.isArray(selectedKeys)||selectedKeys.includes('globalSettings'))['mioCatalogFactsV1','mioTrpgReadingLinksV1'].forEach(key=>keys.add(key));

    if (!Array.isArray(selectedKeys)) {
        Object.keys(db || {}).forEach(key => keys.add(key));
        allGlobalKeys.forEach(key => {
            if (db[key] !== undefined) keys.add(key);
        });
        ['naiVibeAssets', 'naiVibeEncodings', 'naiVibeGroups', 'recordedAudioAssets', 'memoryPalaceNodes', 'memoryPalaceVectors', 'memoryPalaceLinks', 'memoryPalaceEventBoxes', 'memoryPalaceRoomPlates', 'memoryPalaceAnticipations', 'memoryPalaceDigestReports', 'relationshipMemoryProfiles', 'dailySchedules', 'scheduleActivityLedger', 'lifePacks', 'lifeSources', 'lifeChunks', 'lifeEvents', 'sharedAssets', 'readingDocuments', 'readingDocumentChunks', 'readingSessions', 'readingLibraryEntries', 'readingAnnotations', 'readingActivities', 'readingResources', 'collaborationSessions', 'collaborationMessages', 'sharedDocuments', 'sharedDocumentBlocks', 'sharedDocumentRevisions', 'sharedDocumentComments', 'sharedDocumentSuggestions', 'watchTogetherSessions', 'exchangeDiaryEntries', 'periodRecords', 'coupleSpaces', 'coupleSpaceItems', 'trpgCampaigns', 'trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents'].forEach(key => keys.add(key));
    } else {
        selectedKeys.forEach(key => {
            if (key === 'globalSettings') {
                allGlobalKeys.forEach(settingKey => {
                    if (db[settingKey] !== undefined) keys.add(settingKey);
                });
                ['naiVibeAssets', 'naiVibeEncodings', 'naiVibeGroups', 'recordedAudioAssets', 'memoryPalaceNodes', 'memoryPalaceVectors', 'memoryPalaceLinks', 'memoryPalaceEventBoxes', 'memoryPalaceRoomPlates', 'memoryPalaceAnticipations', 'memoryPalaceDigestReports', 'relationshipMemoryProfiles', 'dailySchedules', 'scheduleActivityLedger', 'lifePacks', 'lifeSources', 'lifeChunks', 'lifeEvents', 'sharedAssets', 'readingDocuments', 'readingDocumentChunks', 'readingSessions', 'readingLibraryEntries', 'readingAnnotations', 'readingActivities', 'readingResources', 'collaborationSessions', 'collaborationMessages', 'sharedDocuments', 'sharedDocumentBlocks', 'sharedDocumentRevisions', 'sharedDocumentComments', 'sharedDocumentSuggestions', 'watchTogetherSessions', 'exchangeDiaryEntries', 'periodRecords', 'coupleSpaces', 'coupleSpaceItems', 'trpgCampaigns', 'trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents'].forEach(vibeKey => keys.add(vibeKey));
            } else if (key === 'theaterData') {
                THEATER_DB_KEYS.forEach(theaterKey => {
                    if (db[theaterKey] !== undefined) keys.add(theaterKey);
                });
            } else if (db[key] !== undefined) {
                keys.add(key);
            }
        });
    }

    if (!Array.isArray(selectedKeys)) economyBackupKeys().forEach(key => keys.add(key));
    return Array.from(keys).filter(key => !key.startsWith('_export')
        && (!Array.isArray(selectedKeys) || !economyBackupKeys().includes(key)));
}

function estimateBackupValueBytes(value, limit = OVO_STREAM_HISTORY_BATCH_BYTES) {
    if (value == null) return 4;
    if (typeof value === 'string') return Math.min(limit, value.length * 2 + 2);
    if (typeof value !== 'object') return 16;

    let total = 2;
    const stack = [value];
    const seen = new Set();
    while (stack.length && total < limit) {
        const current = stack.pop();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        const values = Array.isArray(current) ? current : Object.values(current);
        for (const item of values) {
            if (typeof item === 'string') total += item.length * 2 + 2;
            else if (item && typeof item === 'object') stack.push(item);
            else total += 16;
            if (total >= limit) break;
        }
    }
    return Math.min(total, limit);
}

async function* createBackupRecordStream(options = {}) {
    const selectedKeys = Array.isArray(options.selectedKeys) ? options.selectedKeys : null;
    const dataKeys = getBackupDataKeys(selectedKeys);
    // Capture all five tables in one read transaction before yielding to gzip/worker tasks.
    const financial=selectedKeys?null:await readFinancialBackupUnit();
    const economySnapshot=financial?.economy || {};
    let recordCount = 0;
    let processedItems = 0;
    let processedMessages = 0;

    const makeRecord = (record) => {
        recordCount++;
        return record;
    };

    yield makeRecord({
        type: 'header',
        format: OVO_STREAM_BACKUP_FORMAT,
        formatRevision: OVO_STREAM_BACKUP_FORMAT_REVISION,
        exportVersion: selectedKeys ? '3.0_partial' : '3.0',
        exportTimestamp: Date.now(),
        partial: !!selectedKeys,
        exportTables: selectedKeys || null,
        dataKeys
    });

    for (const key of dataKeys) {
        if (economyBackupKeys().includes(key)) {
            yield makeRecord({ type: 'array-start', key });
            for (const value of economySnapshot[key]) yield makeRecord({ type: 'array-item', key, value });
            yield makeRecord({ type: 'array-end', key });
            continue;
        }
        const value = ['mioCatalogFactsV1','mioTrpgReadingLinksV1'].includes(key) ? (await dexieDB?.globalSettings.get(key))?.value : !selectedKeys && key==='characters' ? financial.characters : !selectedKeys && key==='piggyBank' && financial.bank!==null ? financial.bank : (/^naiVibe(?:Assets|Encodings|Groups)$/.test(key) || ['recordedAudioAssets', 'memoryPalaceNodes', 'memoryPalaceVectors', 'memoryPalaceLinks', 'memoryPalaceEventBoxes', 'memoryPalaceRoomPlates', 'memoryPalaceAnticipations', 'memoryPalaceDigestReports', 'relationshipMemoryProfiles', 'dailySchedules', 'scheduleActivityLedger', 'lifePacks', 'lifeSources', 'lifeChunks', 'lifeEvents', 'sharedAssets', 'readingDocuments', 'readingDocumentChunks', 'readingSessions', 'readingLibraryEntries', 'readingAnnotations', 'readingActivities', 'readingResources', 'collaborationSessions', 'collaborationMessages', 'sharedDocuments', 'sharedDocumentBlocks', 'sharedDocumentRevisions', 'sharedDocumentComments', 'sharedDocumentSuggestions', 'watchTogetherSessions', 'exchangeDiaryEntries', 'periodRecords', 'coupleSpaces', 'coupleSpaceItems', 'trpgCampaigns', 'trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents'].includes(key)) && dexieDB?.[key]
            ? await dexieDB[key].toArray()
            : db[key];
        if (value === undefined) continue;

        if ((key === 'characters' || key === 'groups') && Array.isArray(value)) {
            yield makeRecord({ type: 'array-start', key });
            for (let chatIndex = 0; chatIndex < value.length; chatIndex++) {
                const chat = value[chatIndex];
                const metadata = {};
                Object.keys(chat || {}).forEach(property => {
                    if (property !== 'history') metadata[property] = chat[property];
                });
                yield makeRecord({ type: 'chat-start', key, chatIndex, value: metadata });

                const history = Array.isArray(chat && chat.history) ? chat.history : [];
                let batch = [];
                let batchBytes = 0;
                for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
                    const message = history[messageIndex];
                    const estimatedBytes = estimateBackupValueBytes(message);
                    if (batch.length && (batch.length >= OVO_STREAM_HISTORY_BATCH_COUNT || batchBytes + estimatedBytes > OVO_STREAM_HISTORY_BATCH_BYTES)) {
                        yield makeRecord({ type: 'chat-history', key, chatIndex, value: batch });
                        processedMessages += batch.length;
                        batch = [];
                        batchBytes = 0;
                    }
                    batch.push(message);
                    batchBytes += estimatedBytes;
                }
                if (batch.length) {
                    yield makeRecord({ type: 'chat-history', key, chatIndex, value: batch });
                    processedMessages += batch.length;
                }
                yield makeRecord({ type: 'chat-end', key, chatIndex });
                processedItems++;
                if (typeof options.onProgress === 'function') {
                    options.onProgress({ key, processedItems, processedMessages, recordCount });
                }
                await yieldBackupTask();
            }
            yield makeRecord({ type: 'array-end', key });
        } else if (Array.isArray(value)) {
            yield makeRecord({ type: 'array-start', key });
            for (let index = 0; index < value.length; index++) {
                yield makeRecord({ type: 'array-item', key, index, value: value[index] });
                processedItems++;
                if (processedItems % 25 === 0) {
                    if (typeof options.onProgress === 'function') {
                        options.onProgress({ key, processedItems, processedMessages, recordCount });
                    }
                    await yieldBackupTask();
                }
            }
            yield makeRecord({ type: 'array-end', key });
        } else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
            yield makeRecord({ type: 'object-start', key });
            let propertyIndex = 0;
            for (const [property, propertyValue] of Object.entries(value)) {
                yield makeRecord({ type: 'object-entry', key, property, value: propertyValue });
                propertyIndex++;
                processedItems++;
                if (propertyIndex % 25 === 0) await yieldBackupTask();
            }
            yield makeRecord({ type: 'object-end', key });
        } else {
            yield makeRecord({ type: 'value', key, value });
            processedItems++;
        }
    }

    yield {
        type: 'footer',
        recordCount,
        processedItems,
        processedMessages,
        completed: true
    };
}

function yieldBackupTask() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createBackupCompressionWorker() {
    if (typeof Worker === 'undefined' || typeof CompressionStream === 'undefined') return null;
    const source = `
        let writer = null;
        let readerTask = null;
        let chunks = [];
        const encoder = new TextEncoder();
        self.onmessage = async (event) => {
            const message = event.data || {};
            try {
                if (message.type === 'start') {
                    const compression = new CompressionStream('gzip');
                    writer = compression.writable.getWriter();
                    chunks = [];
                    readerTask = (async () => {
                        const reader = compression.readable.getReader();
                        while (true) {
                            const result = await reader.read();
                            if (result.done) break;
                            chunks.push(result.value);
                        }
                    })();
                    self.postMessage({ type: 'ready' });
                } else if (message.type === 'record') {
                    await writer.write(encoder.encode(JSON.stringify(message.record) + '\\n'));
                    self.postMessage({ type: 'ack' });
                } else if (message.type === 'finish') {
                    await writer.close();
                    await readerTask;
                    const blob = new Blob(chunks, { type: 'application/octet-stream' });
                    chunks = [];
                    self.postMessage({ type: 'done', blob });
                } else if (message.type === 'abort') {
                    if (writer) await writer.abort(new Error('Backup cancelled'));
                    chunks = [];
                    self.close();
                }
            } catch (error) {
                self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
            }
        };
    `;
    const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
        const worker = new Worker(workerUrl);
        worker.__ovoWorkerUrl = workerUrl;
        return worker;
    } catch (error) {
        URL.revokeObjectURL(workerUrl);
        console.warn('备份 Worker 不可用，使用分块主线程兼容模式:', error);
        return null;
    }
}

function waitForBackupWorker(worker, expectedType, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        const onMessage = event => {
            const message = event.data || {};
            if (message.type === 'error') {
                cleanup();
                reject(new Error(message.message || '备份后台任务失败'));
            } else if (message.type === expectedType) {
                cleanup();
                resolve(message);
            }
        };
        const onError = event => {
            cleanup();
            reject(event.error || new Error(event.message || '备份后台任务失败'));
        };
        const onAbort = () => {
            cleanup();
            reject(new DOMException('Backup cancelled', 'AbortError'));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function compressBackupRecordsOnMainThread(recordStream, signal) {
    const encoder = new TextEncoder();
    const iterator = recordStream[Symbol.asyncIterator]();
    const readable = new ReadableStream({
        async pull(controller) {
            if (signal && signal.aborted) {
                controller.error(new DOMException('Backup cancelled', 'AbortError'));
                return;
            }
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(encoder.encode(JSON.stringify(result.value) + '\n'));
        },
        async cancel() {
            if (iterator.return) await iterator.return();
        }
    });
    return new Response(readable.pipeThrough(new CompressionStream('gzip'))).blob();
}

async function createCompressedBackupBlob(options = {}) {
    const signal = options.signal;
    const worker = createBackupCompressionWorker();
    if (!worker) return compressBackupRecordsOnMainThread(createBackupRecordStream(options), signal);

    try {
        worker.postMessage({ type: 'start' });
        await waitForBackupWorker(worker, 'ready', signal);
        for await (const record of createBackupRecordStream(options)) {
            if (signal && signal.aborted) throw new DOMException('Backup cancelled', 'AbortError');
            worker.postMessage({ type: 'record', record });
            await waitForBackupWorker(worker, 'ack', signal);
        }
        worker.postMessage({ type: 'finish' });
        const result = await waitForBackupWorker(worker, 'done', signal);
        return result.blob;
    } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        console.warn('备份 Worker 执行失败，使用分块主线程兼容模式:', error);
        return compressBackupRecordsOnMainThread(createBackupRecordStream(options), signal);
    } finally {
        worker.terminate();
        if (worker.__ovoWorkerUrl) URL.revokeObjectURL(worker.__ovoWorkerUrl);
    }
}

async function* readGzipBackupLines(file) {
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.trim()) yield line;
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
}

async function inspectBackupArchive(file) {
    try {
        const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let prefix = '';
        while (prefix.length < 65536) {
            const result = await reader.read();
            if (result.done) break;
            prefix += decoder.decode(result.value, { stream: true });
            const newlineIndex = prefix.indexOf('\n');
            if (newlineIndex !== -1) {
                const firstRecord = JSON.parse(prefix.slice(0, newlineIndex));
                await reader.cancel();
                if (firstRecord && firstRecord.type === 'header' && firstRecord.format === OVO_STREAM_BACKUP_FORMAT) {
                    return { stream: true, header: firstRecord };
                }
                return { stream: false, header: null };
            }
        }
        await reader.cancel();
        // 旧格式是单个完整 JSON，通常没有换行；无需在探测阶段把它完整读入内存。
        return { stream: false, header: null };
    } catch (error) {
        if (error instanceof SyntaxError) return { stream: false, header: null };
        throw error;
    }
}

async function validateStreamBackup(file, onProgress) {
    let header = null;
    let footer = null;
    let parsedRecordCount = 0;
    let uncompressedBytes = 0;
    for await (const line of readGzipBackupLines(file)) {
        uncompressedBytes += line.length * 2 + 2;
        const record = JSON.parse(line);
        if (!header) {
            if (record.type !== 'header' || record.format !== OVO_STREAM_BACKUP_FORMAT) {
                throw new Error('不是有效的大数据备份文件');
            }
            header = record;
        } else if (record.type === 'footer') {
            footer = record;
        } else {
            parsedRecordCount++;
            if (parsedRecordCount % 200 === 0 && typeof onProgress === 'function') {
                onProgress(`正在校验备份... ${parsedRecordCount} 条`);
                await yieldBackupTask();
            }
        }
    }
    if (!footer || !footer.completed) throw new Error('备份文件不完整，缺少完成标记');
    if (footer.recordCount !== parsedRecordCount + 1) throw new Error('备份文件记录数量校验失败');
    return { header, footer, uncompressedBytes };
}

async function ensureImportStorageCapacity(validation, isPartial) {
    if (isPartial || !navigator.storage || !navigator.storage.estimate) return;
    try {
        const estimate = await navigator.storage.estimate();
        if (!Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return;
        const available = estimate.quota - estimate.usage;
        const required = Math.ceil(validation.uncompressedBytes * 1.15);
        if (available < required) {
            throw new Error(`存储空间不足：安全导入约需 ${formatBytes(required)} 可用空间，当前约剩余 ${formatBytes(Math.max(0, available))}`);
        }
    } catch (error) {
        if (error && error.message && error.message.startsWith('存储空间不足')) throw error;
    }
}

function getDexieTableForBackupKey(key, staging = false) {
    if (!dexieDB) return null;
    if (economyBackupKeys().includes(key)) return dexieDB[staging ? EconomySchema.stagingName(key) : key];
    if (key === 'characters') return staging ? dexieDB.importCharacters : dexieDB.characters;
    if (key === 'groups') return staging ? dexieDB.importGroups : dexieDB.groups;
    if (key === 'worldBooks') return staging ? dexieDB.importWorldBooks : dexieDB.worldBooks;
    if (key === 'myStickers') return staging ? dexieDB.importMyStickers : dexieDB.myStickers;
    if (key === 'archives' && dexieDB.archives) return staging ? dexieDB.importArchives : dexieDB.archives;
    if (key === 'naiVibeAssets' && dexieDB.naiVibeAssets) return staging ? dexieDB.importNaiVibeAssets : dexieDB.naiVibeAssets;
    if (key === 'naiVibeEncodings' && dexieDB.naiVibeEncodings) return staging ? dexieDB.importNaiVibeEncodings : dexieDB.naiVibeEncodings;
    if (key === 'naiVibeGroups' && dexieDB.naiVibeGroups) return staging ? dexieDB.importNaiVibeGroups : dexieDB.naiVibeGroups;
    if (key === 'recordedAudioAssets' && dexieDB.recordedAudioAssets) return staging ? dexieDB.importRecordedAudioAssets : dexieDB.recordedAudioAssets;
    if (key === 'memoryPalaceNodes' && dexieDB.memoryPalaceNodes) return staging ? dexieDB.importMemoryPalaceNodes : dexieDB.memoryPalaceNodes;
    if (key === 'memoryPalaceVectors' && dexieDB.memoryPalaceVectors) return staging ? dexieDB.importMemoryPalaceVectors : dexieDB.memoryPalaceVectors;
    if (key === 'memoryPalaceLinks' && dexieDB.memoryPalaceLinks) return staging ? dexieDB.importMemoryPalaceLinks : dexieDB.memoryPalaceLinks;
    if (key === 'memoryPalaceEventBoxes' && dexieDB.memoryPalaceEventBoxes) return staging ? dexieDB.importMemoryPalaceEventBoxes : dexieDB.memoryPalaceEventBoxes;
    if (key === 'memoryPalaceRoomPlates' && dexieDB.memoryPalaceRoomPlates) return staging ? dexieDB.importMemoryPalaceRoomPlates : dexieDB.memoryPalaceRoomPlates;
    if (key === 'memoryPalaceAnticipations' && dexieDB.memoryPalaceAnticipations) return staging ? dexieDB.importMemoryPalaceAnticipations : dexieDB.memoryPalaceAnticipations;
    if (key === 'memoryPalaceDigestReports' && dexieDB.memoryPalaceDigestReports) return staging ? dexieDB.importMemoryPalaceDigestReports : dexieDB.memoryPalaceDigestReports;
    if (key === 'relationshipMemoryProfiles' && dexieDB.relationshipMemoryProfiles) return staging ? dexieDB.importRelationshipMemoryProfiles : dexieDB.relationshipMemoryProfiles;
    if (key === 'dailySchedules' && dexieDB.dailySchedules) return staging ? dexieDB.importDailySchedules : dexieDB.dailySchedules;
    if (key === 'scheduleActivityLedger' && dexieDB.scheduleActivityLedger) return staging ? dexieDB.importScheduleActivityLedger : dexieDB.scheduleActivityLedger;
    if (key === 'lifePacks' && dexieDB.lifePacks) return staging ? dexieDB.importLifePacks : dexieDB.lifePacks;
    if (key === 'lifeSources' && dexieDB.lifeSources) return staging ? dexieDB.importLifeSources : dexieDB.lifeSources;
    if (key === 'lifeChunks' && dexieDB.lifeChunks) return staging ? dexieDB.importLifeChunks : dexieDB.lifeChunks;
    if (key === 'lifeEvents' && dexieDB.lifeEvents) return staging ? dexieDB.importLifeEvents : dexieDB.lifeEvents;
    if (key === 'sharedAssets' && dexieDB.sharedAssets) return staging ? dexieDB.importSharedAssets : dexieDB.sharedAssets;
    if (key === 'readingDocuments' && dexieDB.readingDocuments) return staging ? dexieDB.importReadingDocuments : dexieDB.readingDocuments;
    if (key === 'readingDocumentChunks' && dexieDB.readingDocumentChunks) return staging ? dexieDB.importReadingDocumentChunks : dexieDB.readingDocumentChunks;
    if (key === 'readingSessions' && dexieDB.readingSessions) return staging ? dexieDB.importReadingSessions : dexieDB.readingSessions;
    if (key === 'readingLibraryEntries' && dexieDB.readingLibraryEntries) return staging ? dexieDB.importReadingLibraryEntries : dexieDB.readingLibraryEntries;
    if(key==='readingActivities'&&dexieDB.readingActivities)return staging?dexieDB.importReadingActivities:dexieDB.readingActivities;
    if (key === 'readingAnnotations' && dexieDB.readingAnnotations) return staging ? dexieDB.importReadingAnnotations : dexieDB.readingAnnotations;
    if (key === 'readingResources' && dexieDB.readingResources) return staging ? dexieDB.importReadingResources : dexieDB.readingResources;
    if (key === 'collaborationSessions' && dexieDB.collaborationSessions) return staging ? dexieDB.importCollaborationSessions : dexieDB.collaborationSessions;
    if (key === 'collaborationMessages' && dexieDB.collaborationMessages) return staging ? dexieDB.importCollaborationMessages : dexieDB.collaborationMessages;
    if (key === 'sharedDocuments' && dexieDB.sharedDocuments) return staging ? dexieDB.importSharedDocuments : dexieDB.sharedDocuments;
    if (key === 'sharedDocumentBlocks' && dexieDB.sharedDocumentBlocks) return staging ? dexieDB.importSharedDocumentBlocks : dexieDB.sharedDocumentBlocks;
    if (key === 'sharedDocumentRevisions' && dexieDB.sharedDocumentRevisions) return staging ? dexieDB.importSharedDocumentRevisions : dexieDB.sharedDocumentRevisions;
    if (key === 'sharedDocumentComments' && dexieDB.sharedDocumentComments) return staging ? dexieDB.importSharedDocumentComments : dexieDB.sharedDocumentComments;
    if (key === 'sharedDocumentSuggestions' && dexieDB.sharedDocumentSuggestions) return staging ? dexieDB.importSharedDocumentSuggestions : dexieDB.sharedDocumentSuggestions;
    if (key === 'watchTogetherSessions' && dexieDB.watchTogetherSessions) return staging ? dexieDB.importWatchTogetherSessions : dexieDB.watchTogetherSessions;
    if (key === 'exchangeDiaryEntries' && dexieDB.exchangeDiaryEntries) return staging ? dexieDB.importExchangeDiaryEntries : dexieDB.exchangeDiaryEntries;
    if (key === 'periodRecords' && dexieDB.periodRecords) return staging ? dexieDB.importPeriodRecords : dexieDB.periodRecords;
    if (key === 'coupleSpaces' && dexieDB.coupleSpaces) return staging ? dexieDB.importCoupleSpaces : dexieDB.coupleSpaces;
    if (key === 'coupleSpaceItems' && dexieDB.coupleSpaceItems) return staging ? dexieDB.importCoupleSpaceItems : dexieDB.coupleSpaceItems;
    if (key === 'trpgCampaigns' && dexieDB.trpgCampaigns) return staging ? dexieDB.importTrpgCampaigns : dexieDB.trpgCampaigns;
    if (['trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents'].includes(key)) return dexieDB[staging ? `import${key[0].toUpperCase()}${key.slice(1)}` : key];
    return null;
}

function getImportStagingTables() {
    return [
        dexieDB.importCharacters,
        dexieDB.importGroups,
        dexieDB.importWorldBooks,
        dexieDB.importMyStickers,
        dexieDB.importArchives,
        dexieDB.importGlobalSettings,
        dexieDB.importNaiVibeAssets,
        dexieDB.importNaiVibeEncodings,
        dexieDB.importNaiVibeGroups,
        dexieDB.importRecordedAudioAssets,
        dexieDB.importMemoryPalaceNodes,
        dexieDB.importMemoryPalaceVectors,
        dexieDB.importMemoryPalaceLinks,
        dexieDB.importMemoryPalaceEventBoxes,
        dexieDB.importMemoryPalaceRoomPlates,
        dexieDB.importMemoryPalaceAnticipations,
        dexieDB.importMemoryPalaceDigestReports,
        dexieDB.importRelationshipMemoryProfiles,
        dexieDB.importDailySchedules,
        dexieDB.importScheduleActivityLedger,
        dexieDB.importLifePacks,
        dexieDB.importLifeSources,
        dexieDB.importLifeChunks,
        dexieDB.importLifeEvents,
        dexieDB.importSharedAssets,
        dexieDB.importReadingDocuments,
        dexieDB.importReadingDocumentChunks,
        dexieDB.importReadingSessions,
        dexieDB.importReadingLibraryEntries,
        dexieDB.importReadingAnnotations,
        dexieDB.importReadingActivities,
        dexieDB.importReadingResources,
        dexieDB.importCollaborationSessions,
        dexieDB.importCollaborationMessages,
        dexieDB.importSharedDocuments,
        dexieDB.importSharedDocumentBlocks,
        dexieDB.importSharedDocumentRevisions,
        dexieDB.importSharedDocumentComments,
        dexieDB.importSharedDocumentSuggestions,
        dexieDB.importWatchTogetherSessions,
        dexieDB.importExchangeDiaryEntries,
        dexieDB.importPeriodRecords,
        dexieDB.importCoupleSpaces,
        dexieDB.importCoupleSpaceItems,
        dexieDB.importTrpgCampaigns,
        dexieDB.importTrpgPacks, dexieDB.importTrpgSources, dexieDB.importTrpgChunks, dexieDB.importMusicLibrary, dexieDB.importHealthRecords,
        dexieDB.importTimetableSnapshots, dexieDB.importTimetableAdjustments, dexieDB.importTimetableSyncStates, dexieDB.importTimetableChanges, dexieDB.importPersonalEvents,
        ...economyBackupKeys().map(key => dexieDB[EconomySchema.stagingName(key)])
    ].filter(Boolean);
}

async function clearImportStaging() {
    await Promise.all(getImportStagingTables().map(table => table.clear()));
}

async function copyDexieTableRecords(source, target,writeBatch=null) {
    // Dexie.each does not await an async callback; a rejected put could be lost.
    // Await bounded batches inside the caller's transaction so any write failure aborts the restore.
    let lastKey;
    for (;;) {
        const collection = lastKey === undefined ? source.orderBy(':id') : source.where(':id').above(lastKey);
        const records = await collection.limit(100).toArray();
        if (!records.length) break;
        if(writeBatch)await writeBatch(records);else await target.bulkPut(records);
        lastKey = Dexie.getByKeyPath(records[records.length - 1], source.schema.primKey.keyPath);
        if (records.length < 100) break;
    }
}

// Validate against persisted records: import callers may already release in-memory arrays.
async function assertReminderImportSafe(isPartial) {
    const incoming=await dexieDB.importCharacters.toArray();
    const replacements=new Set(incoming.map(char=>char.id));
    const existing=await dexieDB.characters.toArray();
    if(dexieDB.reminderExecutions) for(const entry of await dexieDB.reminderExecutions.toArray()) {
        if(isPartial && !replacements.has(entry.characterId)) continue;
        if(entry.backgroundTask && !['succeeded','cancelled','expired','failed'].includes(entry.backgroundTask.status)) {
            throw Error('恢复已暂停：执行账本仍有后台提醒，请连接原后台账号核对后重试');
        }
    }
    for(const char of existing) {
        if(isPartial && !replacements.has(char.id)) continue;
        for(const reminder of char.reminders || []) {
            const task=reminder.backgroundTask;
            if(!task || ['succeeded','cancelled','expired','failed'].includes(task.status)) continue;
            throw Error('恢复已暂停：现有角色仍有后台提醒，请连接原后台账号，取消并确认任务后再恢复备份');
        }
    }
}

async function commitImportStaging(isPartial,providedKeys=null) {
    const commit=()=>commitImportStagingLocked(isPartial,providedKeys);
    return navigator.locks ? navigator.locks.request('mio-reminder-execution',commit) : commit();
}

async function validateReadingImportStaging(isPartial) {
    const documents = await dexieDB.importReadingDocuments.toArray();
    const chunks = await dexieDB.importReadingDocumentChunks.toArray();
    const required = new Set();
    for (const document of documents) {
        if (document.sourceAssetId) required.add(document.sourceAssetId);
        for (const resource of document.resources || []) if (resource.assetId) required.add(resource.assetId);
    }
    for (const chunk of chunks) if (chunk.imageAssetId) required.add(chunk.imageAssetId);
    for (const id of required) {
        const resource = await dexieDB.importReadingResources.get(id)
            || (isPartial ? await dexieDB.readingResources.get(id) : null);
        if (!resource || typeof resource.data !== 'string' || !resource.data.length) {
            throw Error('阅读备份缺少原包或图片资源，已保留当前数据，请使用完整备份重试');
        }
    }
}

async function commitImportStagingLocked(isPartial,providedKeys=null) {
    await assertReminderImportSafe(isPartial);
    const coreTables = [
        dexieDB.characters,
        dexieDB.groups,
        dexieDB.worldBooks,
        dexieDB.myStickers,
        dexieDB.globalSettings,
        dexieDB.archives,
        dexieDB.naiVibeAssets,
        dexieDB.naiVibeEncodings,
        dexieDB.naiVibeGroups,
        dexieDB.recordedAudioAssets,
        dexieDB.memoryPalaceNodes,
        dexieDB.memoryPalaceVectors,
        dexieDB.memoryPalaceLinks,
        dexieDB.memoryPalaceEventBoxes,
        dexieDB.memoryPalaceRoomPlates,
        dexieDB.memoryPalaceAnticipations,
        dexieDB.memoryPalaceDigestReports,
        dexieDB.relationshipMemoryProfiles,
        dexieDB.dailySchedules,
        dexieDB.scheduleActivityLedger,
        dexieDB.lifePacks,
        dexieDB.lifeSources,
        dexieDB.lifeChunks,
        dexieDB.lifeEvents,
        dexieDB.sharedAssets,
        dexieDB.readingDocuments,
        dexieDB.readingDocumentChunks,
        dexieDB.readingSessions,
        dexieDB.readingLibraryEntries,
        dexieDB.readingAnnotations,
        dexieDB.readingActivities,
        dexieDB.readingResources,
        dexieDB.collaborationSessions,
        dexieDB.collaborationMessages,
        dexieDB.sharedDocuments,
        dexieDB.sharedDocumentBlocks,
        dexieDB.sharedDocumentRevisions,
        dexieDB.sharedDocumentComments,
        dexieDB.sharedDocumentSuggestions,
        dexieDB.watchTogetherSessions,
        dexieDB.exchangeDiaryEntries,
        dexieDB.periodRecords,
        dexieDB.coupleSpaces,
        dexieDB.coupleSpaceItems,
        dexieDB.trpgCampaigns,
        dexieDB.trpgPacks, dexieDB.trpgSources, dexieDB.trpgChunks, dexieDB.musicLibrary, dexieDB.healthRecords,
        dexieDB.timetableSnapshots, dexieDB.timetableAdjustments, dexieDB.timetableSyncStates, dexieDB.timetableChanges, dexieDB.personalEvents,
        ...economyBackupKeys().map(key => dexieDB[key])
    ].filter(Boolean);
    const stagingTables = getImportStagingTables();
    await dexieDB.transaction('rw', [...coreTables, ...stagingTables], async () => {
        const economySnapshot = await readEconomyBackupSnapshot(true);
        const bank=(await dexieDB.importGlobalSettings.get('piggyBank'))?.value;
        if(bank)economySnapshot.piggyBank=bank;
        if (isPartial && economyBackupKeys().some(key => economySnapshot[key].length)) throw new Error('账务数据不能分类合并');
        validateEconomyBackupSnapshot(economySnapshot);
        const readingLinks=await dexieDB.importGlobalSettings.get('mioTrpgReadingLinksV1');
        if(readingLinks){if(!window.ReadingCore?.normalizeTrpgLinks)throw Error('阅读知识保护组件未加载');window.ReadingCore.normalizeTrpgLinks(readingLinks.value);if(isPartial){const existingLinks=await dexieDB.globalSettings.get('mioTrpgReadingLinksV1');if(existingLinks&&JSON.stringify(existingLinks.value)!==JSON.stringify(readingLinks.value))throw Error('阅读知识关联只能通过完整备份恢复，不能分类覆盖');}}
        const currentControl=await dexieDB.walletControl.get('state');
        const incomingControl=economySnapshot.walletControl.find(row=>row.id==='state');
        if(!isPartial && (currentControl?.mode==='ledger' || currentControl?.activationJournalId)
            && (!incomingControl?.activationJournalId || !providedKeys || (EconomySchema.walletBackupKeys || economyBackupKeys()).some(key=>!providedKeys.includes(key))))throw Error('当前钱包已启用新账本；缺少完整切换状态的旧备份只能在隔离库核对，不能覆盖当前资金');
        if(!isPartial && dexieDB.commerceBatches && await dexieDB.commerceBatches.count() && Object.keys(EconomySchema.commerceTables).some(key=>!providedKeys?.includes(key)))throw Error('备份缺少消费批次及售后记录，不能覆盖当前交易');
        if(isPartial && currentControl?.activationJournalId && !window.WalletStorage)throw Error('钱包保护组件未就绪，请刷新后恢复');
        await validateReadingImportStaging(isPartial);
        if (!isPartial) await Promise.all(coreTables.map(table => table.clear()));
        await copyDexieTableRecords(dexieDB.importCharacters, dexieDB.characters,window.WalletStorage ? rows=>window.WalletStorage.saveChats(dexieDB,dexieDB.characters,rows,isPartial,true) : null);
        await copyDexieTableRecords(dexieDB.importGroups, dexieDB.groups,window.WalletStorage ? rows=>window.WalletStorage.saveChats(dexieDB,dexieDB.groups,rows,isPartial,true) : null);
        await copyDexieTableRecords(dexieDB.importWorldBooks, dexieDB.worldBooks);
        await copyDexieTableRecords(dexieDB.importMyStickers, dexieDB.myStickers);
        if (dexieDB.archives && dexieDB.importArchives) {
            await copyDexieTableRecords(dexieDB.importArchives, dexieDB.archives);
        }
        await copyDexieTableRecords(dexieDB.importNaiVibeAssets, dexieDB.naiVibeAssets);
        await copyDexieTableRecords(dexieDB.importNaiVibeEncodings, dexieDB.naiVibeEncodings);
        await copyDexieTableRecords(dexieDB.importNaiVibeGroups, dexieDB.naiVibeGroups);
        await copyDexieTableRecords(dexieDB.importRecordedAudioAssets, dexieDB.recordedAudioAssets);
        await copyDexieTableRecords(dexieDB.importMemoryPalaceNodes, dexieDB.memoryPalaceNodes);
        await copyDexieTableRecords(dexieDB.importMemoryPalaceVectors, dexieDB.memoryPalaceVectors);
        if (dexieDB.importMemoryPalaceLinks && dexieDB.memoryPalaceLinks) await copyDexieTableRecords(dexieDB.importMemoryPalaceLinks, dexieDB.memoryPalaceLinks);
        if (dexieDB.importMemoryPalaceEventBoxes && dexieDB.memoryPalaceEventBoxes) await copyDexieTableRecords(dexieDB.importMemoryPalaceEventBoxes, dexieDB.memoryPalaceEventBoxes);
        if (dexieDB.importMemoryPalaceRoomPlates && dexieDB.memoryPalaceRoomPlates) await copyDexieTableRecords(dexieDB.importMemoryPalaceRoomPlates, dexieDB.memoryPalaceRoomPlates);
        if (dexieDB.importMemoryPalaceAnticipations && dexieDB.memoryPalaceAnticipations) await copyDexieTableRecords(dexieDB.importMemoryPalaceAnticipations, dexieDB.memoryPalaceAnticipations);
        if (dexieDB.importMemoryPalaceDigestReports && dexieDB.memoryPalaceDigestReports) await copyDexieTableRecords(dexieDB.importMemoryPalaceDigestReports, dexieDB.memoryPalaceDigestReports);
        if (dexieDB.importRelationshipMemoryProfiles && dexieDB.relationshipMemoryProfiles) await copyDexieTableRecords(dexieDB.importRelationshipMemoryProfiles, dexieDB.relationshipMemoryProfiles);
        if (dexieDB.importDailySchedules && dexieDB.dailySchedules) await copyDexieTableRecords(dexieDB.importDailySchedules, dexieDB.dailySchedules);
        if (dexieDB.importScheduleActivityLedger && dexieDB.scheduleActivityLedger) await copyDexieTableRecords(dexieDB.importScheduleActivityLedger, dexieDB.scheduleActivityLedger);
        if (dexieDB.importLifePacks && dexieDB.lifePacks) await copyDexieTableRecords(dexieDB.importLifePacks, dexieDB.lifePacks);
        if (dexieDB.importLifeSources && dexieDB.lifeSources) await copyDexieTableRecords(dexieDB.importLifeSources, dexieDB.lifeSources);
        if (dexieDB.importLifeChunks && dexieDB.lifeChunks) await copyDexieTableRecords(dexieDB.importLifeChunks, dexieDB.lifeChunks);
        if (dexieDB.importLifeEvents && dexieDB.lifeEvents) await copyDexieTableRecords(dexieDB.importLifeEvents, dexieDB.lifeEvents);
        if (dexieDB.importSharedAssets && dexieDB.sharedAssets) await copyDexieTableRecords(dexieDB.importSharedAssets, dexieDB.sharedAssets);
        if (dexieDB.importReadingDocuments && dexieDB.readingDocuments) await copyDexieTableRecords(dexieDB.importReadingDocuments, dexieDB.readingDocuments);
        if (dexieDB.importReadingDocumentChunks && dexieDB.readingDocumentChunks) await copyDexieTableRecords(dexieDB.importReadingDocumentChunks, dexieDB.readingDocumentChunks);
        if (dexieDB.importReadingSessions && dexieDB.readingSessions) await copyDexieTableRecords(dexieDB.importReadingSessions, dexieDB.readingSessions);
        if (dexieDB.importReadingLibraryEntries && dexieDB.readingLibraryEntries) await copyDexieTableRecords(dexieDB.importReadingLibraryEntries, dexieDB.readingLibraryEntries);
        if (dexieDB.importReadingAnnotations && dexieDB.readingAnnotations) await copyDexieTableRecords(dexieDB.importReadingAnnotations, dexieDB.readingAnnotations);
        if (dexieDB.importReadingActivities && dexieDB.readingActivities) await copyDexieTableRecords(dexieDB.importReadingActivities, dexieDB.readingActivities);
        if (dexieDB.importReadingResources && dexieDB.readingResources) await copyDexieTableRecords(dexieDB.importReadingResources, dexieDB.readingResources);
        if (dexieDB.importCollaborationSessions && dexieDB.collaborationSessions) await copyDexieTableRecords(dexieDB.importCollaborationSessions, dexieDB.collaborationSessions);
        if (dexieDB.importCollaborationMessages && dexieDB.collaborationMessages) await copyDexieTableRecords(dexieDB.importCollaborationMessages, dexieDB.collaborationMessages);
        if (dexieDB.importSharedDocuments && dexieDB.sharedDocuments) await copyDexieTableRecords(dexieDB.importSharedDocuments, dexieDB.sharedDocuments);
        if (dexieDB.importSharedDocumentBlocks && dexieDB.sharedDocumentBlocks) await copyDexieTableRecords(dexieDB.importSharedDocumentBlocks, dexieDB.sharedDocumentBlocks);
        if (dexieDB.importSharedDocumentRevisions && dexieDB.sharedDocumentRevisions) await copyDexieTableRecords(dexieDB.importSharedDocumentRevisions, dexieDB.sharedDocumentRevisions);
        if (dexieDB.importSharedDocumentComments && dexieDB.sharedDocumentComments) await copyDexieTableRecords(dexieDB.importSharedDocumentComments, dexieDB.sharedDocumentComments);
        if (dexieDB.importSharedDocumentSuggestions && dexieDB.sharedDocumentSuggestions) await copyDexieTableRecords(dexieDB.importSharedDocumentSuggestions, dexieDB.sharedDocumentSuggestions);
        if (dexieDB.importWatchTogetherSessions && dexieDB.watchTogetherSessions) await copyDexieTableRecords(dexieDB.importWatchTogetherSessions, dexieDB.watchTogetherSessions);
        if (dexieDB.importExchangeDiaryEntries && dexieDB.exchangeDiaryEntries) await copyDexieTableRecords(dexieDB.importExchangeDiaryEntries, dexieDB.exchangeDiaryEntries);
        if (dexieDB.importPeriodRecords && dexieDB.periodRecords) await copyDexieTableRecords(dexieDB.importPeriodRecords, dexieDB.periodRecords);
        if (dexieDB.importCoupleSpaces && dexieDB.coupleSpaces) await copyDexieTableRecords(dexieDB.importCoupleSpaces, dexieDB.coupleSpaces);
        if (dexieDB.importCoupleSpaceItems && dexieDB.coupleSpaceItems) await copyDexieTableRecords(dexieDB.importCoupleSpaceItems, dexieDB.coupleSpaceItems);
        if (dexieDB.importTrpgCampaigns && dexieDB.trpgCampaigns) await copyDexieTableRecords(dexieDB.importTrpgCampaigns, dexieDB.trpgCampaigns);
        for (const key of ['trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents']) await copyDexieTableRecords(dexieDB[`import${key[0].toUpperCase()}${key.slice(1)}`], dexieDB[key]);
        await copyDexieTableRecords(dexieDB.importGlobalSettings, dexieDB.globalSettings,isPartial && window.WalletStorage ? rows=>Promise.all(rows.map(row=>window.WalletStorage.saveSetting(dexieDB,row.key,row.value))) : null);
        if (!isPartial) {
            for (const key of economyBackupKeys()) await copyDexieTableRecords(dexieDB[EconomySchema.stagingName(key)], dexieDB[key]);
        }
        await Promise.all(stagingTables.map(table => table.clear()));
    });
}

async function importStreamBackupData(file, options = {}) {
    const startTime = Date.now();
    const validation = await validateStreamBackup(file, options.onProgress);
    const isPartial = !!validation.header.partial;
    if (options.requirePartial && !isPartial) {
        return { success: false, error: '请选择由「分类导出」生成的文件（.ee）' };
    }
    if (!options.requirePartial && isPartial) {
        return { success: false, error: '这是分类导出文件，请使用「分类导入」' };
    }
    await ensureImportStorageCapacity(validation, isPartial);

    try {
        validateEconomyBackupKeys(validation.header.dataKeys || [], isPartial);
        if (typeof options.onProgress === 'function') options.onProgress('正在准备安全写入...');
        await clearImportStaging();

        let currentChat = null;
        let currentChatKey = null;
        const pendingCollections = new Map();
        const tableBuffers = new Map();
        const economyArrays = new Map();
        let importedRecords = 0;

        const saveSetting = async (key, value) => {
            await dexieDB.importGlobalSettings.put({ key, value });
        };

        const flushTableBuffer = async (key) => {
            const buffer = tableBuffers.get(key);
            if (!buffer || !buffer.length) return;
            const table = getDexieTableForBackupKey(key, true);
            if (!table) return;
            if (economyBackupKeys().includes(key)) await table.bulkAdd(buffer);
            else await table.bulkPut(key==='readingActivities'?buffer.map(row=>window.ReadingPlayCore.activity(row,{restoring:true})):key === 'trpgCampaigns' ? buffer.map(row => window.CoC7Core.campaign(row)) : buffer);
            buffer.length = 0;
        };

        for await (const line of readGzipBackupLines(file)) {
            const record = JSON.parse(line);
            if (record.type === 'header' || record.type === 'footer') continue;

            if (economyBackupKeys().includes(record.key)) {
                if (isPartial || !(validation.header.dataKeys || []).includes(record.key)) throw new Error('账务备份分类或清单不匹配');
                const state = economyArrays.get(record.key);
                if (record.type === 'array-start' && !state) economyArrays.set(record.key, 'open');
                else if (record.type === 'array-end' && state === 'open') economyArrays.set(record.key, 'closed');
                else if (record.type !== 'array-item' || state !== 'open') throw new Error('账务备份数组格式不完整');
            }

            if (record.type === 'chat-start') {
                currentChatKey = record.key;
                currentChat = record.value || {};
                currentChat.history = [];
            } else if (record.type === 'chat-history') {
                if (!currentChat || currentChatKey !== record.key) throw new Error('聊天记录分块顺序异常');
                currentChat.history.push(...(record.value || []));
            } else if (record.type === 'chat-end') {
                if (!currentChat || currentChatKey !== record.key) throw new Error('聊天记录结束标记异常');
                if (!currentChat.theme) currentChat.theme = 'white_pink';
                const table = getDexieTableForBackupKey(currentChatKey, true);
                if (!table) throw new Error(`找不到数据表: ${currentChatKey}`);
                await table.put(currentChat);
                currentChat = null;
                currentChatKey = null;
            } else if (record.type === 'array-start') {
                if (!getDexieTableForBackupKey(record.key, true)) pendingCollections.set(record.key, []);
            } else if (record.type === 'array-item') {
                const table = getDexieTableForBackupKey(record.key, true);
                if (table) {
                    if (!tableBuffers.has(record.key)) tableBuffers.set(record.key, []);
                    const buffer = tableBuffers.get(record.key);
                    buffer.push(record.value);
                    if (buffer.length >= 50) await flushTableBuffer(record.key);
                } else {
                    if (!pendingCollections.has(record.key)) pendingCollections.set(record.key, []);
                    pendingCollections.get(record.key).push(record.value);
                }
            } else if (record.type === 'array-end') {
                await flushTableBuffer(record.key);
                if (pendingCollections.has(record.key)) {
                    await saveSetting(record.key, pendingCollections.get(record.key));
                    pendingCollections.delete(record.key);
                }
            } else if (record.type === 'object-start') {
                pendingCollections.set(record.key, {});
            } else if (record.type === 'object-entry') {
                if (!pendingCollections.has(record.key)) pendingCollections.set(record.key, {});
                pendingCollections.get(record.key)[record.property] = record.value;
            } else if (record.type === 'object-end') {
                await saveSetting(record.key, pendingCollections.get(record.key) || {});
                pendingCollections.delete(record.key);
            } else if (record.type === 'value') {
                await saveSetting(record.key, record.value);
            }

            importedRecords++;
            if (importedRecords % 100 === 0) {
                if (typeof options.onProgress === 'function') options.onProgress(`正在写入... ${importedRecords} 条`);
                await yieldBackupTask();
            }
        }

        if (currentChat) throw new Error('聊天记录未完整写入');
        for (const key of economyBackupKeys()) {
            if ((validation.header.dataKeys || []).includes(key) && economyArrays.get(key) !== 'closed') throw new Error('账务备份缺少完整数据表');
        }
        for (const key of tableBuffers.keys()) await flushTableBuffer(key);
        if (!isPartial) {
            // 正式提交前释放旧的大数组；事务失败时会从正式库重新加载。
            db.characters = [];
            db.groups = [];
            db.worldBooks = [];
            db.myStickers = [];
            db.archives = [];
        }
        if (typeof options.onProgress === 'function') options.onProgress('正在提交已校验的数据...');
        await commitImportStaging(isPartial,validation.header.dataKeys);
        return {
            success: true,
            message: `${isPartial ? '分类导入' : '导入'}完成 (耗时${Date.now() - startTime}ms)`,
            header: validation.header
        };
    } catch (error) {
        console.error('流式导入失败:', error);
        try {
            await clearImportStaging();
            if (!isPartial && typeof loadData === 'function') await loadData();
        } catch (restoreError) {
            console.error('恢复当前数据视图失败:', restoreError);
        }
        return { success: false, error: error.message, duration: Date.now() - startTime };
    }
}

window.createCompressedBackupBlob = createCompressedBackupBlob;
window.inspectBackupArchive = inspectBackupArchive;
window.importStreamBackupData = importStreamBackupData;

async function stageBackupObject(data, isPartial) {
    validateEconomyBackupKeys(Object.keys(data), isPartial);
    if (economyBackupKeys().some(key => Object.hasOwn(data, key))) validateEconomyBackupSnapshot(data);
    await clearImportStaging();
    const tableKeys = new Set(['characters', 'groups', 'worldBooks', 'myStickers', 'archives', 'naiVibeAssets', 'naiVibeEncodings', 'naiVibeGroups', 'recordedAudioAssets', 'memoryPalaceNodes', 'memoryPalaceVectors', 'memoryPalaceLinks', 'memoryPalaceEventBoxes', 'memoryPalaceRoomPlates', 'memoryPalaceAnticipations', 'memoryPalaceDigestReports', 'relationshipMemoryProfiles', 'dailySchedules', 'scheduleActivityLedger', 'lifePacks', 'lifeSources', 'lifeChunks', 'lifeEvents', 'sharedAssets', 'readingDocuments', 'readingDocumentChunks', 'readingSessions', 'readingLibraryEntries', 'readingAnnotations', 'readingActivities', 'readingResources', 'collaborationSessions', 'collaborationMessages', 'sharedDocuments', 'sharedDocumentBlocks', 'sharedDocumentRevisions', 'sharedDocumentComments', 'sharedDocumentSuggestions', 'watchTogetherSessions', 'exchangeDiaryEntries', 'periodRecords', 'coupleSpaces', 'coupleSpaceItems', 'trpgCampaigns', 'trpgPacks', 'trpgSources', 'trpgChunks', 'musicLibrary', 'healthRecords', 'timetableSnapshots', 'timetableAdjustments', 'timetableSyncStates', 'timetableChanges', 'personalEvents']);
    economyBackupKeys().forEach(key => tableKeys.add(key));
    try {
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('_export') || key === '__chunks__' || value === undefined) continue;
            if (tableKeys.has(key)) {
                if (!Array.isArray(value)) continue;
                const table = getDexieTableForBackupKey(key, true);
                if (!table) continue;
                for (let index = 0; index < value.length; index += 25) {
                    const batch = value.slice(index, index + 25);
                    if (key === 'characters' || key === 'groups') {
                        batch.forEach(chat => {
                            if (!chat.theme) chat.theme = 'white_pink';
                        });
                    }
                    await table.bulkPut(key==='readingActivities'?batch.map(row=>window.ReadingPlayCore.activity(row,{restoring:true})):key === 'trpgCampaigns' ? batch.map(row => window.CoC7Core.campaign(row)) : batch);
                    await yieldBackupTask();
                }
            } else {
                await dexieDB.importGlobalSettings.put({ key, value });
            }
        }
        if (!isPartial) {
            db.characters = [];
            db.groups = [];
            db.worldBooks = [];
            db.myStickers = [];
            db.archives = [];
        }
        await commitImportStaging(isPartial,Object.keys(data));
    } catch (error) {
        await clearImportStaging();
        if (!isPartial && typeof loadData === 'function') await loadData();
        throw error;
    }
}

// 分类导入：只合并文件里包含的表，不覆盖其他数据
async function importPartialBackupData(data) {
    const startTime = Date.now();
    const tables = data._exportTables || [];
    if (tables.length === 0) return { success: false, error: '文件中没有可导入的分类' };
    try {
        const partialData = {};
        for (const key of tables) {
            if (key === 'globalSettings' && data.globalSettings) {
                Object.assign(partialData, data.globalSettings);
            } else if (key === 'theaterData' && data.theaterData) {
                Object.assign(partialData, data.theaterData);
            } else if (data[key] !== undefined) {
                partialData[key] = data[key];
            }
        }
        showToast('正在写入...');
        await stageBackupObject(partialData, true);
        const duration = Date.now() - startTime;
        return { success: true, message: `分类导入完成 (耗时${duration}ms)` };
    } catch (error) {
        console.error('分类导入失败:', error);
        return { success: false, error: error.message };
    }
}

// 导入备份数据
async function importBackupData(data) {
    const startTime = Date.now();
    try {
        let convertedData = data;

        if (data._exportVersion !== '3.0') {
            showToast('检测到旧版备份文件，正在转换格式...');
            
            const reassembleHistory = (chat, backupData) => {
                if (!chat.history || !Array.isArray(chat.history) || chat.history.length === 0) {
                    return [];
                }
                if (typeof chat.history[0] === 'object' && chat.history[0] !== null) {
                    return chat.history;
                }
                if (backupData.__chunks__ && typeof chat.history[0] === 'string') {
                    let fullHistory = [];
                    chat.history.forEach(key => {
                        if (backupData.__chunks__[key]) {
                            try {
                                const chunk = JSON.parse(backupData.__chunks__[key]);
                                fullHistory = fullHistory.concat(chunk);
                            } catch (e) {
                                console.error(`Failed to parse history chunk ${key}`, e);
                            }
                        }
                    });
                    return fullHistory;
                }
                return []; 
            };

            const newData = { ...data };

            if (newData.characters) {
                newData.characters = newData.characters.map(char => ({
                    ...char,
                    history: reassembleHistory(char, data)
                }));
            }
            if (newData.groups) {
                newData.groups = newData.groups.map(group => ({
                    ...group,
                    history: reassembleHistory(group, data)
                }));
            }
            
            convertedData = newData;
        }

        // 从备份恢复所有键（不限于当前 db 的键），避免漏掉主题预设、屏幕预设等。
        // 使用独立对象补全缺省值，不在文件校验和暂存成功前覆盖当前内存数据。
        const metaKeys = ['_exportVersion', '_exportTimestamp', '_exportTables'];
        const restoredData = {};
        Object.keys(convertedData).forEach(key => {
            if (metaKeys.includes(key)) return;
            if (convertedData[key] !== undefined) {
                restoredData[key] = convertedData[key];
            }
        });

        // 补全角色/群聊缺失字段（如主题等），避免旧版备份或残缺数据导致预设丢失
        (restoredData.characters || []).forEach(c => {
            if (c.theme === undefined || c.theme === null || c.theme === '') c.theme = 'white_pink';
        });
        (restoredData.groups || []).forEach(g => {
            if (g.theme === undefined || g.theme === null || g.theme === '') g.theme = 'white_pink';
        });

        if (!Array.isArray(restoredData.pomodoroRecords)) restoredData.pomodoroRecords = [];
        if (!restoredData.pomodoroActiveSession) restoredData.pomodoroActiveSession = null;
        if (!restoredData.pomodoroTasks) restoredData.pomodoroTasks = [];
        if (!restoredData.pomodoroSettings) restoredData.pomodoroSettings = { boundCharId: null, userPersona: '', focusBackground: '', taskCardBackground: '', encouragementMinutes: 25, pokeLimit: 5, globalWorldBookIds: [] };
        if (!restoredData.insWidgetSettings) restoredData.insWidgetSettings = { avatar1: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg', bubble1: 'love u.', avatar2: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg', bubble2: 'miss u.' };
        if (!restoredData.homeWidgetSettings) restoredData.homeWidgetSettings = JSON.parse(JSON.stringify(defaultWidgetSettings));
        if (!Array.isArray(restoredData.themePresets)) restoredData.themePresets = [];
        if (!restoredData.themeSettings || typeof restoredData.themeSettings !== 'object') restoredData.themeSettings = { global: {}, wallpapers: {}, bottomNav: {}, chatScreen: {} };
        if (!Array.isArray(restoredData.iconPresets)) restoredData.iconPresets = [];
        if (!Array.isArray(restoredData.homeWidgetPresets)) restoredData.homeWidgetPresets = [];
        if (!Array.isArray(restoredData.widgetWallpaperPresets)) restoredData.widgetWallpaperPresets = [];

        showToast('正在写入新数据...');
        await stageBackupObject(restoredData, false);

        const duration = Date.now() - startTime;
        const message = `导入完成 (耗时${duration}ms)`;
        
        return { success: true, message: message };

    } catch (error) {
        console.error('导入数据失败:', error);
        return {
            success: false,
            error: error.message,
            duration: Date.now() - startTime
        };
    }
}

// GitHub Manager
