// WalletSystem owns legacy money too. Ordinary chat/settings saves preserve its persisted fields.
(function (global) {
    'use strict';
    const copy = value => value === undefined ? undefined : structuredClone(value);
    const fail = (code, retryable = false) => ({ ok:false, error:{code,retryable}, reason:({INSUFFICIENT_FUNDS:'钱包余额不足',UNKNOWN_BALANCE:'钱包余额待核对',VERSION_CONFLICT:'钱包已更新，请重试',WALLET_FROZEN:'钱包正在核对，暂不能操作',PERSISTENCE_FAILED:'钱包保存失败，本次未扣款'})[code] || code });
    const revision = bank => Number.isSafeInteger(bank?._walletRevision) ? bank._walletRevision : 0;
    const flags = ['transferStatus','payStatus','shopPaymentStatus','shopOrderId','shopPaymentSource','familyCardStatus','receivedFamilyCardStatus','familyCardActionProcessed','economyTransferId','commerceBatchId','commerceOrderIds'];
    const id = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 240;
    const canonicalize=value=>Array.isArray(value)?value.map(canonicalize):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonicalize(value[key])])):value;
    function resolveControl(state,hasAccounts){
        if(!state)return {id:'state',version:0,mode:hasAccounts?'frozen':'legacy',requiresReview:hasAccounts,quarantinedOwnerIds:[]};
        if(!Number.isSafeInteger(state.version) || state.version<0 || !['legacy','frozen','ledger'].includes(state.mode)
            || state.mode==='legacy' && hasAccounts || state.mode==='ledger' && (!state.activationJournalId || state.protocol!==1 || !/^[a-f0-9]{64}$/.test(state.sourceFingerprint || '')))
            return {...state,mode:'frozen',requiresReview:true};
        return state;
    }
    function protectChat(record, disk,preservePending=false) {
        if (!disk) return record;
        const result = {...record};
        if (disk.walletLedger !== undefined) result.walletLedger = copy(disk.walletLedger);
        else delete result.walletLedger;
        const prior = new Map((disk.history || []).map(message => [message.id,message]));
        result.history = (record.history || []).map(message => {
            const saved = prior.get(message.id);
            if (!saved) return message;
            const patch = {};
            for (const key of flags) if (saved[key] !== undefined && (preservePending || saved[key] !== 'pending')) patch[key] = saved[key];
            return Object.keys(patch).length ? {...message,...patch} : message;
        });
        return result;
    }
    async function saveSetting(database, key, value) {
        if (key !== 'piggyBank') return database.globalSettings.put({key,value});
        return database.transaction('rw',database.globalSettings,async()=>{
            const disk = await database.globalSettings.get(key);
            // Nonfinancial display preferences remain ordinary settings.
            const bank = disk ? {...disk.value,familyCardNarrationMode:value.familyCardNarrationMode || disk.value.familyCardNarrationMode} : value;
            return database.globalSettings.put({key,value:bank});
        });
    }
    async function saveChats(database,table,records,preservePending=false,replace=false) {
        const snapshots=records.map(copy),saved=[];
        await database.transaction('rw',table,async()=>{
            for(const record of snapshots){
                const disk=await table.get(record.id);
                if(!replace)global.ChatSaveGuard?.check(table,record,disk);
                let next=[database.characters,database.groups].includes(table) && (!replace || preservePending) ? protectChat(record,disk,preservePending) : record;
                if(global.ChatSaveGuard)next=global.ChatSaveGuard.stamp(next);
                await table.put(next);saved.push(next);
            }
        });
        saved.forEach((row,index)=>global.ChatSaveGuard?.accept(table,records[index],row));
    }
    function mergeBackupCharacters(memoryRows,diskRows) {
        const memory=new Map(memoryRows.map(row=>[row.id,row]));
        const merged=diskRows.map(disk=>{
            const live=memory.get(disk.id);memory.delete(disk.id);
            if(!live)return disk;
            const row=protectChat({...disk,...live},disk,true),ids=new Set(row.history.map(message=>message.id).filter(Boolean));
            for(const message of disk.history || [])if(message.id && !ids.has(message.id))row.history.push(copy(message));
            return row;
        });
        return [...merged,...memory.values()];
    }
    function forDatabase(database, memory) {
        const names = ['globalSettings','characters','walletControl','walletOperations'];
        if(database?.economyAccounts)names.push('economyAccounts');
        const available = () => names.every(name => database?.[name]);
        function synchronize(bank, characters) {
            // Keep object references held by the existing card and chat UI.
            if (!memory.piggyBank) memory.piggyBank = {};
            const merge = (target,source) => {
                for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
                for(const [key,value] of Object.entries(source)) {
                    if(Array.isArray(value) && Array.isArray(target[key])) {
                        const old=new Map(target[key].filter(row=>row?.id).map(row=>[row.id,row]));
                        target[key]=value.map(row=>{const prior=old.get(row?.id);if(prior){merge(prior,row);return prior;}return copy(row);});
                    } else target[key]=copy(value);
                }
            };
            merge(memory.piggyBank,bank);
            for (const record of characters) {
                const live = memory.characters?.find(item=>item.id===record.id);
                if (!live) continue;
                if (record.walletLedger !== undefined) live.walletLedger=copy(record.walletLedger);
                const saved = new Map((record.history || []).map(message=>[message.id,message]));
                for (const message of live.history || []) for (const key of flags) {
                    if (saved.get(message.id)?.[key] !== undefined) message[key]=saved.get(message.id)[key];
                }
            }
        }
        async function execute(input) {
            if (!available()) return fail('PERSISTENCE_FAILED');
            if (!input || !id(input.idempotencyKey) || !id(input.ownerId || 'user') || !['post','set','hide','exchange','preferences','legacyCommit'].includes(input.kind)) return fail('INVALID_REQUEST');
            const request = copy(input);
            const key=JSON.stringify([request.ownerId || 'user',request.idempotencyKey]);
            const canonical={...request};delete canonical.expectedRevision;
            let fingerprint;
            try{fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonicalize(canonical)))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
            catch(_){return fail('INVALID_REQUEST');}
            let committed;
            try {
                const result=await database.transaction('rw',names.map(name=>database[name]),async()=>{
                    const previous=await database.walletOperations.get(key);
                    if(previous) return previous.fingerprint===fingerprint ? {ok:true,data:previous.receipt} : fail('IDEMPOTENCY_CONFLICT');
                    const state=await database.walletControl.get('state');
                    const mode=resolveControl(state,database.economyAccounts && await database.economyAccounts.count()>0);
                    if(mode.mode!=='legacy') return fail(mode.requiresReview?'MIGRATION_REVIEW_REQUIRED':'WALLET_FROZEN');
                    const bank=copy((await database.globalSettings.get('piggyBank'))?.value || memory.piggyBank || {balance:520,transactions:[]});
                    if(request.expectedRevision!=null && revision(bank)!==request.expectedRevision) return fail('VERSION_CONFLICT',true);
                    const characters=[];
                    const getOwner=async owner=>{
                        if(owner==='user') return bank;
                        let character=characters.find(row=>row.id===owner);
                        if(!character){character=await database.characters.get(owner);if(character)characters.push(character);}
                        if(!character) throw Error('INVALID_ACCOUNT');
                        if(!character.walletLedger)character.walletLedger={balance:null,transactions:[]};
                        return character.walletLedger;
                    };
                    let receipt={id:key};
                    if(request.kind==='legacyCommit') {
                        if(request.expectedRevision!==revision(bank)) return fail('VERSION_CONFLICT',true);
                        if(global.CurrencyCore.amountToMinor(String(request.bank?.balance),'CNY')==null)return fail('INVALID_AMOUNT');
                        if((request.characters || []).some(row=>row.walletLedger?.balance!=null && global.CurrencyCore.amountToMinor(String(row.walletLedger.balance),'CNY')==null))return fail('INVALID_AMOUNT');
                        Object.assign(bank,copy(request.bank));
                        for(const draft of request.characters || []) {
                            const saved=await database.characters.get(draft.id);
                            if(!saved) continue;
                            global.ChatSaveGuard?.check(database.characters,draft,saved);
                            saved.walletLedger=copy(draft.walletLedger);
                            const patches=new Map((draft.history || []).map(message=>[message.id,message]));
                            for(const message of saved.history || []) for(const field of flags) {
                                if(patches.get(message.id)?.[field]!==undefined)message[field]=patches.get(message.id)[field];
                            }
                            const ids=new Set((saved.history || []).map(message=>message.id));
                            for(const message of draft.history || []) if((message.isFamilyCardEvent || message.isFamilyCardNarration) && !ids.has(message.id)) {
                                (saved.history ||= []).push(copy(message));
                                if(global.ChatSaveGuard)saved._chatSaveRevision=global.ChatSaveGuard.stamp(saved)._chatSaveRevision;
                            }
                            characters.push(saved);
                        }
                    } else {
                        const owner=await getOwner(request.ownerId || 'user');
                        if(request.kind==='preferences') {
                            if(!global.CurrencyCore.listCurrencies().some(row=>row.code===request.currency))return fail('UNSUPPORTED_CURRENCY');
                            owner.currency=request.currency;
                            if(owner.currencyWallet)owner.currencyWallet.defaultCurrency=request.currency;
                        } else if(request.kind==='exchange') {
                            if(!id(request.targetOwnerId) || request.targetOwnerId===request.ownerId)return fail('INVALID_ACCOUNT');
                            const target=await getOwner(request.targetOwnerId),core=global.CurrencyCore;
                            for(const [wallet,code] of [[owner,request.sourceCurrency],[target,request.targetCurrency]]) {
                                if(!core.listCurrencies().some(item=>item.code===code))return fail('UNSUPPORTED_CURRENCY');
                                if(code==='CNY' && wallet.balance==null)return fail('UNKNOWN_BALANCE');
                                wallet.currencyWallet=core.normalizeWallet(wallet.currencyWallet,wallet.balance);
                                if(wallet.balance!=null)core.setBalance(wallet.currencyWallet,'CNY',core.amountToMinor(String(wallet.balance),'CNY'));
                            }
                            const exchanged=core.applyTransfer({sourceWallet:owner.currencyWallet,targetWallet:target.currencyWallet,sourceCurrency:request.sourceCurrency,targetCurrency:request.targetCurrency,sourceAmountMinor:request.amountMinor,rateScaled:request.rateScaled,rate:request.rate,recordId:request.idempotencyKey,fromOwnerId:request.ownerId,toOwnerId:request.targetOwnerId,remark:request.remark});
                            if(!exchanged.ok)return {ok:false,error:{code:'INVALID_EXCHANGE',retryable:false},reason:exchanged.reason};
                            for(const wallet of [owner,target])if(wallet.currencyWallet.accounts.CNY){wallet.balance=core.getBalance(wallet.currencyWallet,'CNY')/100;wallet.legacyCurrencyBalanceSnapshot=wallet.balance;}
                            receipt={...receipt,...exchanged};
                        } else if(request.kind==='hide') {
                            for(const row of owner.transactions || []) if(request.ids?.includes(row.id))row.hidden=true;
                        } else {
                            const code=request.currency || 'CNY';
                            if(!global.CurrencyCore?.listCurrencies().some(item=>item.code===code))return fail('UNSUPPORTED_CURRENCY');
                            const raw=code==='CNY' ? owner.balance : owner.currencyWallet?.accounts?.[code]?.balanceMinor;
                            if(raw==null || !Number.isFinite(Number(raw))) return fail('UNKNOWN_BALANCE');
                            const balance=code==='CNY' ? global.CurrencyCore.amountToMinor(String(raw),code) : Number(raw);
                            if(!Number.isSafeInteger(balance) || !Number.isSafeInteger(request.amountMinor) || request.amountMinor<0 || request.kind==='post' && (!request.amountMinor || !['income','expense'].includes(request.direction)))return fail('INVALID_AMOUNT');
                            let next=request.kind==='set' ? request.amountMinor : balance+(request.direction==='expense'?-request.amountMinor:request.amountMinor);
                            if(!Number.isSafeInteger(next))return fail('INVALID_AMOUNT');
                            if(next<0)return fail('INSUFFICIENT_FUNDS');
                            const change=next-balance;
                            if(code==='CNY')owner.balance=next/100;
                            if(owner.currencyWallet) {
                                const currencyWallet=copy(owner.currencyWallet);
                                global.CurrencyCore.setBalance(currencyWallet,code,next);owner.currencyWallet=currencyWallet;
                                if(code==='CNY')owner.legacyCurrencyBalanceSnapshot=owner.balance;
                            }
                            const row={id:key,eventId:request.idempotencyKey,type:change<0?'expense':'income',amount:Math.abs(change)/(10**global.CurrencyCore.meta(code).digits),amountMinor:Math.abs(change),currency:code,remark:request.remark || '',source:request.source || '用户',charName:request.charName || '',time:Date.now()};
                            if(change)(owner.transactions ||= []).unshift(row);
                            if(request.targetOwnerId) {
                                if(request.targetOwnerId===request.ownerId || change>=0)return fail('INVALID_ACCOUNT');
                                const target=await getOwner(request.targetOwnerId);
                                const prior=target.balance==null?null:global.CurrencyCore.amountToMinor(String(target.balance),'CNY');
                                if(prior==null)return fail('UNKNOWN_BALANCE');
                                const credited=prior-change;
                                if(!Number.isSafeInteger(credited))return fail('INVALID_AMOUNT');
                                target.balance=credited/100;
                                (target.transactions ||= []).unshift({...row,id:key+':receive',type:'income'});
                            }
                            receipt={...receipt,recordId:row.id,balanceMinor:next};
                        }
                    }
                    bank._walletRevision=revision(bank)+1;
                    await database.globalSettings.put({key:'piggyBank',value:bank});
                    for(const character of characters)await database.characters.put(character);
                    receipt.revision=bank._walletRevision;
                    await database.walletOperations.add({id:key,ownerId:request.ownerId || 'user',fingerprint,receipt});
                    committed={bank,characters};
                    return {ok:true,data:receipt};
                });
                if(committed){
                    synchronize(committed.bank,committed.characters);
                    for(const saved of committed.characters){
                        const draft=request.characters?.find(row=>row.id===saved.id),live=memory.characters?.find(row=>row.id===saved.id);
                        if(draft && live && live._chatSaveRevision===draft._chatSaveRevision)global.ChatSaveGuard?.accept(database.characters,live,saved);
                    }
                }
                else {
                    const bank=(await database.globalSettings.get('piggyBank'))?.value;
                    if(bank)synchronize(bank,await database.characters.toArray());
                }
                return result;
            }catch(error){
                try{
                    const bank=(await database.globalSettings.get('piggyBank'))?.value;
                    const ids=new Set([request.ownerId,request.targetOwnerId,...(request.characters || []).map(row=>row.id)].filter(value=>value && value!=='user'));
                    if(bank)synchronize(bank,(await database.characters.bulkGet([...ids])).filter(Boolean));
                }catch(_){/* A closed/quota-failed database must still report the failed command. */}
                if(error.code==='CHAT_WRITE_CONFLICT')return {...fail('VERSION_CONFLICT'),reason:error.message};
                return fail(error.message==='INVALID_ACCOUNT'?'INVALID_ACCOUNT':'PERSISTENCE_FAILED',true);
            }
        }
        async function read(ownerId='user') {
            if(!id(ownerId) || !available())return fail('INVALID_ACCOUNT');
            const state=await database.walletControl.get('state');
            const mode=resolveControl(state,database.economyAccounts && await database.economyAccounts.count()>0);
            if(state?.activationJournalId || database.economyAccounts && await database.economyAccounts.count()) {
                if(!database.economyAccounts)return fail('MIGRATION_CONFLICT');
                return {ok:true,data:{ownerId,mode:mode.mode,accounts:await database.economyAccounts.where('ownerId').equals(ownerId).toArray()}};
            }
            const owner=ownerId==='user' ? (await database.globalSettings.get('piggyBank'))?.value : (await database.characters.get(ownerId))?.walletLedger;
            if(!owner)return fail('INVALID_ACCOUNT');
            const accounts=copy(owner.currencyWallet?.accounts || {});
            const amount=owner.balance==null?null:global.CurrencyCore.amountToMinor(String(owner.balance),'CNY');
            accounts.CNY={currency:'CNY',balanceMinor:amount,status:amount==null?'pending_initialization':'active'};
            return {ok:true,data:{ownerId,mode:mode.mode,accounts:Object.values(accounts),transactions:copy(owner.transactions || []),currencyTransactions:copy(owner.currencyWallet?.transactions || [])}};
        }
        return Object.freeze({execute,read,protectChat});
    }
    global.WalletStorage=Object.freeze({forDatabase,protectChat,saveSetting,saveChats,mergeBackupCharacters,revision,resolveControl});
})(typeof window!=='undefined'?window:globalThis);
