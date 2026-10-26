(function(global){
    'use strict';
    const localJobs=new Map();
    const core=()=>global.ReadingPlayCore;
    const sessionId=input=>ReadingCore.makeSessionId(input.characterId,input.documentId);
    const failure=code=>Object.assign(Error(code),{code});
    async function run(input,options={}){
        if(!input||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>100||typeof input.question!=='string'||input.question.length>2000||!['interaction','advance','tutor','lecture'].includes(input.kind)||!ReadingCore.PLAY_MODES.includes(input.mode)||!['paragraph','chapter'].includes(input.unit)||!['manual','after_reply'].includes(input.advancePolicy)||!Number.isSafeInteger(input.expectedSettingsVersion)||!Number.isSafeInteger(input.expectedPositionVersion))throw failure('INVALID_REQUEST');
        const request={characterId:String(input.characterId),documentId:String(input.documentId),idempotencyKey:input.idempotencyKey,kind:input.kind,question:input.question,mode:input.mode,unit:input.unit,advancePolicy:input.advancePolicy,expectedSettingsVersion:input.expectedSettingsVersion,expectedPositionVersion:input.expectedPositionVersion};
        if(['tutor','lecture'].includes(request.kind)){if(!['auto','page','paragraph','selection','chapter'].includes(input.scope)||!['dialogue','socratic','structured'].includes(input.style))throw failure('INVALID_REQUEST');request.scope=input.scope;request.style=input.style;request.anchor=input.anchor?JSON.parse(JSON.stringify(input.anchor)):null;}
        const id=JSON.stringify([sessionId(request),request.idempotencyKey]),fingerprint=await SharedAssets.digest(JSON.stringify(request)),leaseToken=crypto.randomUUID(),controller=new AbortController();
        const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
        if(localJobs.has(id))throw failure('REQUEST_BUSY');
        localJobs.set(id,controller);
        let record;
        try{
            const document=await Reading.getDocument(request.documentId),session=await Reading.getSession(request.characterId,request.documentId);
            if(!document||!session)throw failure('DOCUMENT_MISSING');
            const assertSnapshot=async()=>{
                if(signal.aborted)throw failure('REQUEST_CANCELLED');
                const view=Reading.current();if(view.characterId!==request.characterId||view.documentId!==request.documentId)throw failure('READING_CHANGED');
                const current=await Reading.getSession(request.characterId,request.documentId),settings=core().settings(current?.workspace);
                if(!current||current.positionVersion!==request.expectedPositionVersion||settings.version!==request.expectedSettingsVersion||settings.mode!==request.mode||settings.unit!==request.unit||settings.advancePolicy!==request.advancePolicy)throw failure('READING_CHANGED');
                const latestDocument=await Reading.getDocument(request.documentId);if(latestDocument?.versionId!==document.versionId)throw failure('DOCUMENT_CHANGED');
            };
            record=await dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{
                const previous=await dexieDB.readingActivities.get(id);
                if(previous?.fingerprint!==undefined&&previous.fingerprint!==fingerprint)throw failure('IDEMPOTENCY_CONFLICT');
                if(previous?.status==='complete')return previous;
                if(previous?.status==='pending'&&previous.leaseUntil>Date.now())throw failure('REQUEST_BUSY');
                const pending=await dexieDB.readingActivities.where('[sessionId+status]').equals([session.id,'pending']).toArray();
                if(pending.some(row=>row.id!==id&&row.status==='pending'&&row.leaseUntil>Date.now()))throw failure('REQUEST_BUSY');
                const now=Date.now();for(const row of pending)if(row.id!==id&&row.leaseUntil<=now)await dexieDB.readingActivities.put({...row,status:'interrupted',error:'EXPIRED_REQUEST',leaseToken:null,leaseUntil:0});
                const next=core().activity({id,schemaVersion:1,sessionId:session.id,characterId:request.characterId,documentId:request.documentId,documentVersion:document.versionId,kind:request.kind,status:'pending',version:(previous?.version||0)+1,createdAt:previous?.createdAt||now,updatedAt:now,request,fingerprint,settings:core().settings(session.workspace),sourcePositionVersion:session.positionVersion,sourceIndex:session.segmentIndex,content:'',leaseToken,leaseUntil:now+300000,attempts:(previous?.attempts||0)+1});
                await dexieDB.readingActivities.put(next);return next;
            });
            if(record.status==='complete')return record;
            await assertSnapshot();
            if(request.mode==='trpg'&&!session.trpgCampaignId)throw failure('CAMPAIGN_REQUIRED');
            let result={content:'',scope:'',context:null,guard:assertSnapshot};
            if(request.kind==='advance'&&request.mode==='trpg'){const saved=await CoC7.get(session.trpgCampaignId);CoC7Core.visibleStory(saved,{viewer:'player',characterId:request.characterId});result.context={campaignId:saved.id,revision:saved.revision};}
            if(request.kind==='interaction'){
                const chunk=await Reading.getChunk(document.id,session.segmentIndex);
                result=await Reading.requestInteraction(request.mode,{document,session,chunk,question:request.question},{signal,guard:assertSnapshot,history:async scope=>(await dexieDB.readingActivities.where('[sessionId+createdAt]').between([session.id,0],[session.id,Number.MAX_SAFE_INTEGER],true,true).reverse().limit(40).toArray()).filter(row=>row.status==='complete'&&row.kind==='interaction'&&row.scope===scope&&row.sourceIndex===session.segmentIndex&&row.settings.mode===request.mode).slice(0,8).reverse().map(row=>({question:row.request.question,content:row.content}))});
            }
            if(['tutor','lecture'].includes(request.kind)){
                const details={document,session,chunk:await Reading.getChunk(document.id,session.segmentIndex)},context=await Reading.prepareTeachingContext(request.scope,details,request.anchor);
                const heartbeat=async()=>{await assertSnapshot();await dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const pending=await dexieDB.readingActivities.get(id);if(pending?.status!=='pending'||pending.leaseToken!==leaseToken)throw failure('REQUEST_CANCELLED');await dexieDB.readingActivities.put({...pending,leaseUntil:Date.now()+300000});});};
                result=await Reading.requestStudyAi(request.kind,{...context,question:request.question,style:request.style},details,options.onProgress,{signal,guard:heartbeat,history:async scope=>request.kind==='tutor'?(await dexieDB.readingActivities.where('[sessionId+createdAt]').between([session.id,0],[session.id,Number.MAX_SAFE_INTEGER],true,true).reverse().limit(40).toArray()).filter(row=>row.status==='complete'&&row.kind==='tutor'&&row.scope===scope).slice(0,6).reverse().map(row=>({question:row.request.question,content:row.content})):[]});
                result.sourceRef={documentId:document.id,versionId:document.versionId,scope:context.scope,startIndex:context.startIndex,endIndex:context.endIndex,anchorHash:context.anchor?.quoteHash||null,restricted:!!result.context};
            }
            const transactionTables=['readingActivities','readingSessions','readingDocuments','readingDocumentChunks','globalSettings','trpgCampaigns','trpgPacks','trpgSources','trpgChunks'].map(key=>dexieDB[key]);
            return await dexieDB.transaction('rw',transactionTables,async()=>{
                const pending=await dexieDB.readingActivities.get(id);if(pending?.status!=='pending'||pending.leaseToken!==leaseToken)throw failure('REQUEST_CANCELLED');
                await result.guard();
                const current=await Reading.getSession(request.characterId,document.id),advance=request.mode!=='free-chat'&&(request.kind==='advance'||request.kind==='interaction'&&core().shouldAdvance(record.settings)),target=advance?core().advanceTarget(document,current,request.unit):{index:current.segmentIndex,moved:false,atEnd:false};
                const persisted=await dexieDB.readingSessions.get(current.id)||current;
                if(target.moved){const chunk=await Reading.getChunk(document.id,target.index),next=ReadingCore.normalizeSession({...current,segmentIndex:target.index,segmentOffset:0,anchor:null,positionVersion:current.positionVersion+1},document,chunk);await dexieDB.readingSessions.put({...persisted,...next});}
                let campaignRevision=result.context?.revision??null;
                if(request.mode==='trpg'&&advance&&result.context){
                    const saved=await CoC7.get(result.context.campaignId),timeline=TrpgStateCore.state(saved.state).timeline;
                    if(saved.revision!==result.context.revision)throw failure('READING_CHANGED');
                    const updated=await CoC7.dispatch(saved.id,{id:'reading:'+pending.fingerprint,kind:'state',domain:'timeline',operation:'save',value:{...timeline,turn:timeline.turn+1},cause:'玩家明确推进阅读剧情：'+request.question.slice(0,500)},saved.revision);campaignRevision=updated.revision;
                }
                const complete=core().activity({...pending,status:'complete',content:result.content,title:document.title.slice(0,200)+(request.kind==='lecture'?' · 讲课':request.kind==='tutor'?' · 导师问答':''),sourceRef:result.sourceRef||null,requestCount:result.requestCount||0,scope:result.scope,contextRevision:campaignRevision,resultIndex:target.index,atEnd:target.atEnd,moved:target.moved,updatedAt:Date.now(),completedAt:Date.now(),leaseToken:null,leaseUntil:0});
                await dexieDB.readingActivities.put(complete);return complete;
            });
        }catch(error){
            if(record?.status==='pending')await dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const current=await dexieDB.readingActivities.get(id);if(current?.status==='pending'&&current.leaseToken===leaseToken)await dexieDB.readingActivities.put({...current,status:signal.aborted?'cancelled':'failed',error:error.code||'REQUEST_FAILED',updatedAt:Date.now(),leaseToken:null,leaseUntil:0});});
            throw error;
        }finally{localJobs.delete(id);}
    }
    async function cancel(id){localJobs.get(id)?.abort();await dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await dexieDB.readingActivities.get(id);if(row?.status==='pending')await dexieDB.readingActivities.put({...row,status:'cancelled',updatedAt:Date.now(),leaseToken:null,leaseUntil:0});});}
    async function list(characterId,documentId,{offset=0,limit=30,kinds=null}={}){
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw failure('INVALID_QUERY');
        const id=ReadingCore.makeSessionId(characterId,documentId);return dexieDB.readingActivities.where('[sessionId+createdAt]').between([id,0],[id,Number.MAX_SAFE_INTEGER],true,true).reverse().and(row=>!kinds||kinds.includes(row.kind)).offset(offset).limit(limit).toArray();
    }
    global.ReadingPlay=Object.freeze({run,cancel,list,retry:(id,options)=>dexieDB.readingActivities.get(id).then(row=>{if(!row?.request)throw failure('REQUEST_MISSING');return run(row.request,options);})});
})(window);
