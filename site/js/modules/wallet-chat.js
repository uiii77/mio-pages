// Chat references and held funds commit together. Rendering never settles ledger transfers.
(function(global){
    'use strict';
    const fail=code=>({ok:false,error:{code,retryable:false},reason:code});
    const abort=result=>{if(!result.ok)throw Object.assign(Error(result.error.code),{domainResult:result});return result.data;};
    const accountId=owner=>JSON.stringify(['wallet',owner,'CNY']);
    function forOwner(database,ownerId){
        const tables=[...Object.keys(EconomySchema.runtimeTables).map(key=>database[key]),database.characters,database.groups];
        const table=type=>type==='private'?database.characters:type==='group'?database.groups:null;
        async function transaction(task){try{return await database.transaction('rw',tables,task);}catch(error){return error.domainResult||fail('PERSISTENCE_FAILED');}}
        function participants(chat,type){return type==='private'?['user',String(chat.id)]:['user',...(chat.members||[]).map(row=>String(row.id))];}
        async function send(input){
            if(!input||!table(input.chatType)||typeof input.chatId!=='string'||!Array.isArray(input.recipientOwnerIds)||!input.recipientOwnerIds.length||new Set(input.recipientOwnerIds).size!==input.recipientOwnerIds.length||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||typeof input.idempotencyKey!=='string'||input.idempotencyKey.length>100||typeof input.remark!=='string'||input.remark.length>300)return fail('INVALID_REQUEST');
            const request=JSON.parse(JSON.stringify(input));
            return transaction(async()=>{
                const chats=table(request.chatType),chat=await chats.get(request.chatId);if(!chat)return fail('INVALID_CHAT');
                const allowed=participants(chat,request.chatType);if(!allowed.includes(ownerId)||request.recipientOwnerIds.some(id=>!allowed.includes(id)||id===ownerId))return fail('FORBIDDEN');
                const messages=[];
                for(const [index,targetOwnerId] of request.recipientOwnerIds.entries()){
                    const key='chat:'+request.idempotencyKey+':'+index,transferId=JSON.stringify([ownerId,key]);
                    const existing=(chat.history||[]).find(row=>row.economyTransferId===transferId),hold=await database.economyTransfers.get(transferId);
                    if(existing){if(!hold||hold.amountMinor!==request.amountMinor||hold.recipientOwnerId!==targetOwnerId||existing.transferRemark!==request.remark)abort(fail('IDEMPOTENCY_CONFLICT'));messages.push(existing);continue;}
                    if(hold)abort(fail('TRANSFER_REFERENCE_MISSING'));
                    const source=await database.economyAccounts.get(accountId(ownerId));if(!source)abort(fail('INVALID_ACCOUNT'));
                    const timestamp=request.message?.timestamp||Date.now(),expiresAt=timestamp+86400000;
                    const sent=abort(await EconomyStorage.forOwner(database,ownerId,{requireActivated:true}).reserveTransfer({sourceAccountId:source.id,targetAccountId:accountId(targetOwnerId),amountMinor:request.amountMinor,expectedSourceVersion:source.version,expiresAt,idempotencyKey:key}));
                    const amount=String(request.amountMinor/100),sender=ownerId==='user'?(request.chatType==='private'?chat.myName:chat.me?.nickname):(request.chatType==='private'?chat.realName:(chat.members||[]).find(row=>String(row.id)===ownerId)?.realName);
                    const target=targetOwnerId==='user'?(chat.me?.nickname||chat.myName):(chat.members||[]).find(row=>String(row.id)===targetOwnerId)?.realName;
                    const content=request.message?.content || (request.chatType==='private'?`[${sender}给你转账：${amount}元；备注：${request.remark}]`:`[${sender} 向 ${target} 转账：${amount}元；备注：${request.remark}]`);
                    const message={...(request.message||{}),id:request.message?.id||'msg_'+crypto.randomUUID(),role:ownerId==='user'?'user':'assistant',content,parts:request.message?.parts||[{type:'text',text:content}],timestamp,transferStatus:'pending',economyTransferId:sent.transferId,transferRemark:request.remark,transferSenderOwnerId:ownerId,transferRecipientOwnerId:targetOwnerId,...(request.chatType==='group'?{senderId:ownerId==='user'?'user_me':ownerId}:{})};
                    if((chat.history||[]).some(row=>row.id===message.id))abort(fail('MESSAGE_CONFLICT'));
                    chat.history=[...(chat.history||[]),message];messages.push(message);
                }
                await chats.put(chat);return {ok:true,data:{messages}};
            });
        }
        async function settle(input){
            if(!input||!table(input.chatType)||!['received','returned','expired'].includes(input.action))return fail('INVALID_REQUEST');
            return transaction(async()=>{
                const chats=table(input.chatType),chat=await chats.get(input.chatId),message=chat?.history?.find(row=>row.id===input.messageId);
                if(!chat||!participants(chat,input.chatType).includes(ownerId)||!message?.economyTransferId)return fail('LEGACY_TRANSFER_REVIEW_REQUIRED');
                const hold=await database.economyTransfers.get(message.economyTransferId);if(!hold)return fail('INVALID_TRANSFER');
                const kind={received:'accept_transfer',returned:'return_transfer',expired:'expire_transfer'}[input.action],key='chat-settle:'+message.id+':'+input.action,id=JSON.stringify([ownerId,key]),prior=await database.economyJournals.get(id);
                const api=EconomyStorage.forOwner(database,ownerId,{requireActivated:true}),method={received:'acceptTransfer',returned:'returnTransfer',expired:'expireTransfer'}[input.action];
                const receipt=prior?.kind===kind&&prior.receipt.transferId===hold.id?prior.receipt:abort(await api[method]({transferId:hold.id,expectedTransferVersion:hold.version,idempotencyKey:key}));
                message.transferStatus=input.action==='expired'?'returned':input.action;message.transferExpired=input.action==='expired';
                await chats.put(chat);return {ok:true,data:{receipt,message}};
            });
        }
        return Object.freeze({send,settle});
    }
    function sync(chat,result){for(const message of result.data?.messages||[result.data?.message].filter(Boolean)){const old=(chat.history||[]).find(row=>row.id===message.id);if(old)Object.assign(old,message);else{chat.history=chat.history||[];chat.history.push(message);}}}
    async function processMessage(chat,type,message,actorId){
        if(message.transferStatus!=='pending'&&!/^\[.*?(接收|退回).*?的转账\]$/.test(String(message.content||'')))return null;
        if(await WalletSystem.mode()==='legacy')return null;
        const api=forOwner(dexieDB,String(actorId)),action=String(message.content||'').match(/^\[(.*?)(接收|退回)(.*?)的转账\]$/);
        if(action){
            const candidates=(chat.history||[]).filter(row=>row.transferStatus==='pending'&&row.transferRecipientOwnerId===String(actorId)&&row.economyTransferId);
            const names=type==='private'?[chat.myName]:[chat.me?.nickname];
            const actor=type==='private'?chat:(chat.members||[]).find(row=>String(row.id)===String(actorId));
            if(![actor?.realName,actor?.groupNickname].includes(action[1]))return fail('FORBIDDEN');
            const pending=[...candidates].reverse().find(row=>row.transferSenderOwnerId==='user'?names.includes(action[3]):type==='group'&&(chat.members||[]).some(member=>String(member.id)===row.transferSenderOwnerId&&[member.realName,member.groupNickname].includes(action[3])));
            message.ledgerActionHandled=true;
            if(!pending){message.financialActionFailed='TRANSFER_REFERENCE_MISSING';return fail(message.financialActionFailed);}
            const result=await api.settle({chatId:String(chat.id),chatType:type,messageId:pending.id,action:action[2]==='接收'?'received':'returned'});if(result.ok)sync(chat,result);else message.financialActionFailed=result.error.code;return result;
        }
        if(message.transferStatus!=='pending')return null;
        const transfer=String(message.content||'').match(/转账[：:]\s*([\d.,]+)\s*元[；;]备注[：:]([\s\S]*?)\]$/);if(!transfer){message.transferStatus='failed';return fail('INVALID_TRANSFER');}
        let recipient='user';
        if(type==='group'){
            const named=String(message.content).match(/向\s*(.*?)\s*转账[：:]/)?.[1];
            const matches=(chat.members||[]).filter(row=>[row.realName,row.groupNickname].includes(named));
            if(named===chat.me?.nickname)recipient='user';else if(matches.length===1)recipient=String(matches[0].id);else {message.transferStatus='failed';return fail('AMBIGUOUS_RECIPIENT');}
        }
        const result=await api.send({chatId:String(chat.id),chatType:type,recipientOwnerIds:[recipient],amountMinor:CurrencyCore.amountToMinor(transfer[1].replace(',','.'),'CNY'),remark:transfer[2],idempotencyKey:message.id,message});
        if(result.ok)Object.assign(message,result.data.messages[0]);else{message.transferStatus='failed';message.financialActionFailed=result.error.code;}return result;
    }
    global.WalletChat=Object.freeze({forOwner,processMessage,sync});
})(window);
