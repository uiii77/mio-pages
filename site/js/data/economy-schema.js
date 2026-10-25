// Shared persistence contract. Loading this file enables no transactions or legacy migration.
(function (global) {
    'use strict';
    const tables = Object.freeze({
        economyAccounts: 'id, ownerId, [ownerId+currency]',
        economyJournals: 'id, &[ownerId+idempotencyKey], orderId',
        economyPostings: 'id, journalId, accountId, [ownerId+occurredAt]',
        economyOutbox: 'eventId, state',
        commerceOrders: 'id, [payerOwnerId+createdAt]',
        economyGrants: 'id, ownerId, payerAccountId, granteeOwnerId'
    });
    const keys = Object.freeze(Object.keys(tables));
    const stagingName = key => `import${key[0].toUpperCase()}${key.slice(1)}`;
    const staging = Object.freeze(Object.fromEntries(keys.map(key => [stagingName(key), tables[key]])));
    const runtimeTables=Object.freeze({...tables,commerceOrders:'id,[payerOwnerId+createdAt],[buyerOwnerId+createdAt],[recipientOwnerId+createdAt]',economyOutbox:'eventId,state,ownerId,[ownerId+state]',walletControl:'&id',walletOperations:'&id,ownerId',economyTransfers:'&id,sourceAccountId,targetAccountId,state'});
    const walletBackupKeys=Object.freeze(Object.keys(runtimeTables));
    const commerceTables=Object.freeze({commerceOffers:'&id,storeId,category',commerceCarts:'&id,ownerId',commerceBatches:'&id,[ownerId+createdAt]',commerceAfterSales:'&id,orderId,ownerId,state',commerceOperations:'&id,ownerId',commerceProfiles:'&id'});
    const backupKeys=Object.freeze([...walletBackupKeys,...Object.keys(commerceTables)]);
    global.EconomySchema = Object.freeze({ tables, keys, staging, stagingName,runtimeTables,backupKeys,walletBackupKeys,commerceTables });
})(typeof window !== 'undefined' ? window : globalThis);
