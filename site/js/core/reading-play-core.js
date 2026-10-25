(function(global){
    'use strict';
    const modes=global.ReadingCore.PLAY_MODES;
    const minor=value=>Number.isSafeInteger(value)&&value>=0;
    const settings=value=>global.ReadingCore.normalizeWorkspace(value);
    function advanceTarget(document,session,unit){
        if(!['paragraph','chapter'].includes(unit)||!minor(session.segmentIndex)||session.segmentIndex>=document.segmentCount)throw Error('推进范围无效');
        let index=session.segmentIndex+1;
        if(unit==='chapter'){const chapter=(document.chapters||[]).find(row=>session.segmentIndex>=row.startIndex&&session.segmentIndex<row.endIndex);if(!chapter)throw Error('当前读物没有可用章节，请按段推进');index=chapter.endIndex;}
        const atEnd=index>=document.segmentCount;return {index:atEnd?session.segmentIndex:index,moved:!atEnd,atEnd};
    }
    function shouldAdvance(value){const saved=settings(value);return saved.mode!=='free-chat'&&saved.advancePolicy==='after_reply';}
    function activity(value,{restoring=false}={}){
        const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
        if(!value||value.schemaVersion!==1||!text(value.id,1000)||!text(value.characterId,160)||!text(value.documentId,220)||value.sessionId!==global.ReadingCore.makeSessionId(value.characterId,value.documentId)
            ||!['interaction','advance','tutor','lecture','slides'].includes(value.kind)||!['pending','complete','failed','cancelled','interrupted'].includes(value.status)||!minor(value.version)||!minor(value.createdAt)||!minor(value.updatedAt)||typeof value.content!=='string'||value.content.length>50000)throw Error('阅读活动记录无效');
        if(['interaction','advance','tutor','lecture','slides'].includes(value.kind)){
            if(!value.request||!text(value.request.idempotencyKey,100)||value.id!==JSON.stringify([value.sessionId,value.request.idempotencyKey])||!modes.includes(value.request.mode)||typeof value.request.question!=='string'||value.request.question.length>2000||!minor(value.sourcePositionVersion)||!minor(value.sourceIndex)||!text(value.documentVersion,220)||typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint))throw Error('阅读推进依据无效');
            settings(value.settings);
            if(value.status==='pending'&&(!text(value.leaseToken,100)||!minor(value.leaseUntil)))throw Error('阅读请求状态无效');
        }
        const next=JSON.parse(JSON.stringify(value));
        if(next.kind==='slides'){if(!global.ReadingTeachingCore)throw Error('演示组件未加载');next.data=global.ReadingTeachingCore.deck(next.data);if(next.editDraft)next.editDraft=global.ReadingTeachingCore.validateDraft(next.editDraft);}
        if(restoring&&next.editorLease)next.editorLease=null;
        if(restoring&&next.status==='pending'){next.status='interrupted';next.sourceStatus='pending';next.error='RESTORED_PENDING';next.leaseToken=null;next.leaseUntil=0;}
        return next;
    }
    function messages(mode,input){
        if(!modes.includes(mode))throw Error('未知阅读玩法');
        const system=[`你是“${String(input.roleName||'角色').slice(0,120)}”。`,String(input.persona||'').slice(0,4000),
            '只能依据本次提供的授权材料与同范围对话。不要透露模组剧透、猜测未获知的秘密或把推测说成事实。不得伪造骰点，不自行改变 HP、物品、知识权限或已保存剧情。',
            mode==='trpg'?'以当前角色身份回应玩家行动，描述可感知的信息、意图及待确认选择；KP 的状态变更必须由用户另行确认。':mode==='free-chat'?'这是自由聊天，本次不推进阅读位置或剧情。':'这是共同阅读，请回应当前段落，避免补写后文。',
            '纯文本回应，不要思考过程、代码或控制指令，最多 600 字。'].filter(Boolean).join('\n');
        const history=(input.history||[]).slice(-8).flatMap(row=>[{role:'user',content:String(row.question||'继续').slice(0,1200)},{role:'assistant',content:String(row.content||'').slice(0,2000)}]);
        return [{role:'system',content:system},{role:'user',content:'本次授权材料：\n'+String(input.sourceText||'').slice(0,6000)},...history,{role:'user',content:String(input.question||'请继续回应当前内容。').slice(0,2000)}];
    }
    global.ReadingPlayCore=Object.freeze({settings,advanceTarget,shouldAdvance,activity,messages});
})(typeof window!=='undefined'?window:globalThis);
