// Explicit migration orchestration. Startup only registers the compatibility responder.
(function(global){
    'use strict';
    const fail=(code,retryable=false)=>({ok:false,error:{code,retryable}});
    const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(value=>value.toString(16).padStart(2,'0')).join('');
    async function probeClients(databaseName){
        const worker=global.navigator?.serviceWorker?.controller;
        if(!worker)return fail('CLIENT_UPDATE_REQUIRED');
        return new Promise(resolve=>{
            const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(fail('CLIENT_UPDATE_REQUIRED'));},7000);
            channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};
            worker.postMessage({type:'MIO_WALLET_PROBE_CLIENTS',databaseName,protocol:1},[channel.port2]);
        });
    }
    function setupClient(){
        global.navigator?.serviceWorker?.addEventListener('message',event=>{
            if(event.data?.type!=='MIO_WALLET_PROBE' || !event.ports?.[0])return;
            event.ports[0].postMessage({protocol:1,databaseName:global.dexieDB?.name,ready:typeof global.WalletSystem?.command==='function' && typeof global.WalletStorage?.resolveControl==='function' && !!global.dexieDB?.isOpen()});
        });
    }
    function forDatabase(database,options={}){
        const probe=options.probeClients || probeClients;
        const tables=[database.characters,database.globalSettings,...(database.groups?[database.groups]:[]),...global.EconomySchema.backupKeys.map(key=>database[key])];
        const migration=()=>global.EconomyMigrationStorage.forDatabase(database);
        async function status(){
            return database.transaction('r',database.walletControl,database.economyAccounts,async()=>{
                const stored=await database.walletControl.get('state'),hasAccounts=await database.economyAccounts.count()>0;
                return global.WalletStorage.resolveControl(stored,hasAccounts);
            });
        }
        async function plan(){
            const value=await migration().previewPartial();
            if(!value.ok)return value;
            return {ok:true,data:{...value.data,sourceDigest:await digest(value.data.sourceFingerprint)}};
        }
        async function preview(){
            const current=await status();
            if(current.activationJournalId)return fail('ALREADY_ACTIVATED');
            const value=await plan();
            if(!value.ok)return value;
            const {sourceFingerprint,sourceDigest,...data}=value.data;
            return {ok:true,data:{...data,sourceFingerprint:sourceDigest}};
        }
        async function freeze(input){
            const mode=await status();if(mode.requiresReview)return fail('LEGACY_LEDGER_REVIEW_REQUIRED');
            const captured=await plan();if(!captured.ok)return captured;
            if(input?.expectedFingerprint!==captured.data.sourceDigest)return fail('SOURCE_CHANGED',true);
            const proof=await probe(database.name);
            if(!proof?.ok || proof.protocol!==1)return fail('CLIENT_UPDATE_REQUIRED');
            const token=crypto.randomUUID();
            return database.transaction('rw',tables,async()=>{
                const current=await database.walletControl.get('state');
                if(current?.activationJournalId)return fail('ALREADY_ACTIVATED');
                const latest=await migration().previewPartial();
                if(!latest.ok)return latest;
                if(latest.data.sourceFingerprint!==captured.data.sourceFingerprint)return fail('SOURCE_CHANGED',true);
                const state={id:'state',mode:'frozen',version:(current?.version || 0)+1,protocol:1,sourceFingerprint:captured.data.sourceDigest,freezeToken:token,quarantinedOwnerIds:[]};
                await database.walletControl.put(state);
                return {ok:true,data:{freezeToken:token,sourceFingerprint:state.sourceFingerprint}};
            });
        }
        async function activate(input){
            if(input?.confirmed!==true || typeof input.freezeToken!=='string')return fail('CONFIRMATION_REQUIRED');
            const journalId=JSON.stringify(['system:wallet',input.freezeToken]);
            const current=await database.walletControl.get('state');
            if(current?.activationJournalId===journalId && current.sourceFingerprint===input.expectedFingerprint){
                const prior=await database.economyJournals.get(journalId);return prior?{ok:true,data:prior.receipt}:fail('MIGRATION_CONFLICT');
            }
            const captured=await plan();if(!captured.ok)return captured;
            if(captured.data.sourceDigest!==input.expectedFingerprint)return fail('SOURCE_CHANGED',true);
            const proof=await probe(database.name);if(!proof?.ok || proof.protocol!==1)return fail('CLIENT_UPDATE_REQUIRED');
            try{return await database.transaction('rw',tables,async()=>{
                const state=await database.walletControl.get('state');
                if(state?.mode!=='frozen' || state.freezeToken!==input.freezeToken || state.sourceFingerprint!==input.expectedFingerprint)return fail('MIGRATION_CONFLICT');
                const result=await migration().commitPartial({expectedFingerprint:captured.data.sourceFingerprint});
                if(!result.ok)throw Object.assign(Error(result.error.code),{domainResult:result});
                const occurredAt=Date.now(),ownerId='system:wallet';
                const receipt={journalId,kind:'ledger_activation',ownerId,protocol:1,sourceFingerprint:input.expectedFingerprint,openingJournalId:global.EconomyMigrationCore.journalId,occurredAt};
                const request={kind:receipt.kind,ownerId,protocol:1,idempotencyKey:input.freezeToken,sourceFingerprint:input.expectedFingerprint};
                await database.economyJournals.add({id:journalId,kind:receipt.kind,ownerId,idempotencyKey:input.freezeToken,orderId:null,requestFingerprint:JSON.stringify(request),occurredAt,receipt});
                const quarantine=new Set(captured.data.checklist.flatMap(row=>[row.ownerId,row.relatedOwnerId]).filter(Boolean));
                await database.walletControl.put({id:'state',mode:'ledger',version:state.version+1,protocol:1,sourceFingerprint:input.expectedFingerprint,activationJournalId:journalId,quarantinedOwnerIds:[...quarantine]});
                const snapshot=Object.fromEntries(await Promise.all(global.EconomySchema.backupKeys.map(async key=>[key,await database[key].toArray()])));
                if(typeof global.validateEconomyBackupSnapshot!=='function')throw Error('Ledger validator not loaded');
                try{global.validateEconomyBackupSnapshot(snapshot);}catch(_){throw Object.assign(Error('LEDGER_INTEGRITY_FAILED'),{domainResult:fail('LEDGER_INTEGRITY_FAILED')});}
                return {ok:true,data:receipt};
            });}catch(error){return error.domainResult || fail('PERSISTENCE_FAILED',true);}
        }
        async function abort(){
            return database.transaction('rw',tables,async()=>{
                const state=await database.walletControl.get('state');
                if(state?.activationJournalId || await database.economyAccounts.count())return fail('RECONCILIATION_REQUIRED');
                await database.walletControl.put({id:'state',mode:'legacy',version:(state?.version || 0)+1,protocol:1,quarantinedOwnerIds:[]});
                return {ok:true,data:{mode:'legacy'}};
            });
        }
        async function confirmRecovery(input){
            try{return await database.transaction('rw',tables,async()=>{
                const state=await database.walletControl.get('state'),opening=await database.economyJournals.get(global.EconomyMigrationCore.journalId);
                if(!state?.activationJournalId || !opening?.reconciliation || ![state.sourceFingerprint,opening.requestFingerprint].includes(input?.expectedFingerprint))return fail('MIGRATION_CONFLICT');
                if(!Number.isSafeInteger(state.version+1))return fail('VERSION_CONFLICT');
                const recoveryId=JSON.stringify([JSON.parse(global.EconomyMigrationCore.journalId)[0],`legacy-recovery:${input.ownerId}`]);
                const prior=await database.economyJournals.get(recoveryId);
                const result=await migration().confirmRecovery({...input,expectedFingerprint:opening.requestFingerprint});
                if(!result.ok)return result;
                if(prior)return {...result,data:{...result.data,quarantinedOwnerIds:state.quarantinedOwnerIds || [],requiresGrantReview:true}};
                const evidence=opening.reconciliation.sourceSnapshot,owners=new Set(['user',...evidence.characters.map(row=>String(row.id))]);
                const graph=new Map([...owners].map(owner=>[owner,new Set()]));
                const link=(a,b)=>{if(graph.has(a)&&graph.has(b)){graph.get(a).add(b);graph.get(b).add(a);}};
                for(const row of opening.reconciliation.checklist)if(row.relatedOwnerId)link(row.ownerId,row.relatedOwnerId);
                for(const wallet of [evidence.piggyBank,...evidence.characters.map(row=>row.walletLedger)])for(const row of wallet?.currencyWallet?.transactions || [])link(String(row.fromOwnerId),String(row.toOwnerId));
                for(const card of evidence.piggyBank?.familyCards || [])link('user',String(card.targetCharId));
                for(const card of evidence.piggyBank?.receivedFamilyCards || [])link('user',String(card.fromCharId));
                for(const group of evidence.groups || [])if((group.history || []).some(row=>['pending','unreceived'].includes(row.transferStatus)))for(const member of group.members || [])link('user',String(member.id));
                const resolutions=new Set();
                for(const journal of await database.economyJournals.toArray())if(journal.idempotencyKey?.startsWith('legacy-recovery:'))resolutions.add(journal.idempotencyKey.slice('legacy-recovery:'.length));
                const blocked=new Set(state.quarantinedOwnerIds || []),remaining=[],visited=new Set();
                for(const owner of blocked){
                    if(visited.has(owner))continue;
                    const component=new Set([owner]),queue=[owner];
                    for(let cursor=0;cursor<queue.length;cursor++)for(const related of graph.get(queue[cursor]) || [])if(!component.has(related)){component.add(related);queue.push(related);}
                    for(const id of component)visited.add(id);
                    if([...component].some(id=>blocked.has(id)&&!resolutions.has(id)))for(const id of component)if(blocked.has(id))remaining.push(id);
                }
                await database.walletControl.put({...state,version:state.version+1,quarantinedOwnerIds:remaining});
                return {...result,data:{...result.data,quarantinedOwnerIds:remaining,requiresGrantReview:true}};
            });}catch(_){return fail('PERSISTENCE_FAILED',true);}
        }
        return Object.freeze({status,preview,freeze,activate,abort,confirmRecovery});
    }
    global.WalletCutover=Object.freeze({forDatabase,setupClient,probeClients,protocol:1});
})(typeof window!=='undefined'?window:globalThis);
