// Local teaching artifacts. Slide creation/editing/playback never calls an external service.
(function(global){
    'use strict';
    const fail=code=>Object.assign(Error(code),{code});
    function forSession(characterId,documentId){
        const sessionId=ReadingCore.makeSessionId(characterId,documentId);
        async function get(id){const row=await dexieDB.readingActivities.get(id);if(!row||row.sessionId!==sessionId||!['lecture','slides','tutor'].includes(row.kind))throw fail('ARTIFACT_MISSING');return ReadingPlayCore.activity(row);}
        async function createDeck(source,data){
            const key=crypto.randomUUID(),request={...source.request,kind:'slides',idempotencyKey:key,question:'本地创建或复制演示'},now=Date.now();
            const row=ReadingPlayCore.activity({id:JSON.stringify([sessionId,key]),schemaVersion:1,sessionId,characterId,documentId,documentVersion:source.documentVersion,kind:'slides',source:source.source||'ai',status:'complete',version:0,createdAt:now,updatedAt:now,content:'',title:data.title,data,request,fingerprint:await SharedAssets.digest(JSON.stringify(request)),settings:source.settings,sourcePositionVersion:source.sourcePositionVersion,sourceIndex:source.sourceIndex,scope:source.scope,sourceRef:source.sourceRef,leaseToken:null,leaseUntil:0});
            await dexieDB.readingActivities.add(row);return row;
        }
        async function makeSlides(lectureId){
            const lecture=await get(lectureId);if(lecture.kind!=='lecture'||lecture.status!=='complete')throw fail('LECTURE_REQUIRED');
            return createDeck(lecture,ReadingTeachingCore.fromLecture(lecture.title,lecture.content,{activityId:lecture.id,scope:lecture.scope}));
        }
        async function claimEditor(id,token){
            return dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await get(id);if(row.kind!=='slides'||row.status!=='complete')throw fail('DECK_REQUIRED');if(row.editorLease&&row.editorLease.token!==token&&row.editorLease.until>Date.now())throw fail('EDITOR_BUSY');const next={...row,editorLease:{token,until:Date.now()+300000}};await dexieDB.readingActivities.put(next);return next;});
        }
        function owns(row,token,expectedVersion){if(row.editorLease?.token!==token)throw fail('EDITOR_CHANGED');if(row.version!==expectedVersion)throw fail('VERSION_CONFLICT');}
        async function saveDraft(id,token,expectedVersion,data){
            const draft=ReadingTeachingCore.validateDraft({baseVersion:expectedVersion,data});
            return dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await get(id);owns(row,token,expectedVersion);await dexieDB.readingActivities.put({...row,editDraft:draft,editorLease:{token,until:Date.now()+300000}});});
        }
        async function saveDeck(id,token,expectedVersion,data){
            const deck=ReadingTeachingCore.deck(data);
            return dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await get(id);owns(row,token,expectedVersion);if(row.version===Number.MAX_SAFE_INTEGER)throw fail('VERSION_CONFLICT');const oldSlide=row.data.slides[row.data.currentIndex].id,position=deck.slides.findIndex(slide=>slide.id===oldSlide);const next=ReadingPlayCore.activity({...row,data:{...deck,currentIndex:position>=0?position:Math.min(row.data.currentIndex,deck.slides.length-1)},title:deck.title,version:row.version+1,updatedAt:Date.now(),editDraft:null,editorLease:{token,until:Date.now()+300000}});await dexieDB.readingActivities.put(next);return next;});
        }
        async function releaseEditor(id,token){return dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await get(id);if(row.editorLease?.token===token)await dexieDB.readingActivities.put({...row,editorLease:null});});}
        async function navigate(id,index){return dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await get(id);if(row.kind!=='slides'||!Number.isSafeInteger(index)||index<0||index>=row.data.slides.length)throw fail('INVALID_SLIDE');const next={...row,data:{...row.data,currentIndex:index}};await dexieDB.readingActivities.put(next);return next;});}
        async function saveLecture(id,expectedVersion,content){
            if(typeof content!=='string'||!content.trim()||content.length>50000)throw fail('INVALID_LECTURE');
            return dexieDB.transaction('rw',dexieDB.readingActivities,async()=>{const row=await get(id);if(row.kind!=='lecture'||row.version!==expectedVersion||row.version===Number.MAX_SAFE_INTEGER)throw fail('VERSION_CONFLICT');const next={...row,content,generatedContent:row.generatedContent??row.content,edited:true,version:row.version+1,updatedAt:Date.now()};await dexieDB.readingActivities.put(next);return next;});
        }
        async function list({offset=0,limit=30}={}){return ReadingPlay.list(characterId,documentId,{offset,limit,kinds:['lecture','slides','tutor']});}
        return Object.freeze({get,makeSlides,copyDeck:async(id,data)=>createDeck(await get(id),ReadingTeachingCore.deck(data)),claimEditor,saveDraft,saveDeck,releaseEditor,navigate,saveLecture,list});
    }
    global.ReadingTeaching=Object.freeze({forSession});
})(window);
