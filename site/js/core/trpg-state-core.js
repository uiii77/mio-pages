(function(global){
    'use strict';
    const clone=value=>JSON.parse(JSON.stringify(value));
    function id(value){if(typeof value!=='string'||!value.trim()||value.length>180||value.trim()!==value)throw Error('剧情引用无效');return value;}
    function text(value,max=4000){if(typeof value!=='string'||value.length>max)throw Error('剧情文本无效或过长');return value;}
    const ids=value=>{if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw Error('知识范围无效');const result=[...new Set(value.map(id))];return result;};
    function audience(value){
        if(!value||value.version!==undefined&&value.version!==1||typeof value.expired!=='boolean')throw Error('知识权限格式无效');
        const shared=(value.shared||[]).map(row=>({from:id(row.from),to:id(row.to),eventId:id(row.eventId)}));
        if(new Set(shared.map(row=>JSON.stringify([row.from,row.to]))).size!==shared.length)throw Error('重复共享关系');
        return {version:1,players:ids(value.players||[]),characters:ids(value.characters||[]),shared,expired:value.expired,eventId:value.eventId?id(value.eventId):''};
    }
    function knownCharacters(permission){
        const acl=audience(permission),known=new Set(acl.characters),edges=new Map();
        for(const row of acl.shared){if(!edges.has(row.from))edges.set(row.from,[]);edges.get(row.from).push(row.to);}
        const pending=[...known];for(let i=0;i<pending.length;i++)for(const target of edges.get(pending[i])||[])if(!known.has(target)){known.add(target);pending.push(target);}
        return known;
    }
    function visible(permission,context){
        if(!context||!['kp','player','character'].includes(context.viewer))return false;
        const acl=audience(permission);
        if(context.viewer==='kp')return !context.characterId;
        if(acl.expired)return false;
        if(context.characterId)return knownCharacters(acl).has(context.characterId);
        return context.viewer==='player'&&acl.players.includes(context.playerId||'local-user');
    }
    function state(value={}){
        const timeline=value.timeline||{turn:0,day:1,phase:'开始'};
        if(!Number.isSafeInteger(timeline.turn)||timeline.turn<0||!Number.isSafeInteger(timeline.day)||timeline.day<1)throw Error('剧情时间无效');
        const inventory=(value.inventory||[]).map(row=>{if(!Number.isSafeInteger(row.quantity)||row.quantity<0)throw Error('物品数量无效');return {id:id(row.id),ownerId:id(row.ownerId),name:text(row.name,200),quantity:row.quantity,notes:text(row.notes||'',2000)};});
        const quests=(value.quests||[]).map(row=>{if(!['open','done','failed'].includes(row.status))throw Error('任务状态无效');return {id:id(row.id),title:text(row.title,200),text:text(row.text||''),status:row.status,audience:audience(row.audience)};});
        const relationships=(value.relationships||[]).map(row=>({id:id(row.id),from:id(row.from),to:id(row.to),text:text(row.text||'',2000),audience:audience(row.audience)}));
        for(const rows of [inventory,quests,relationships])if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('剧情条目 ID 重复');
        return {timeline:{turn:timeline.turn,day:timeline.day,phase:text(timeline.phase,200)},inventory,quests,relationships};
    }
    function fingerprint(command){
        const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(key=>key!=='at').sort().map(key=>[key,stable(value[key])])):value;
        return JSON.stringify(stable(command));
    }
    function apply(campaign,command,event){
        if(typeof command.cause!=='string'||!command.cause.trim()||command.cause.length>1000)throw Error('请填写明确的剧情事件或变更依据');
        campaign.schemaVersion=2;campaign.state=state(campaign.state);event.cause=command.cause;event.requestFingerprint=fingerprint(command);
        if(command.kind==='knowledge'){
            const item=campaign.story.items.find(row=>row.id===command.itemId);if(!item)throw Error('剧情知识条目不存在');
            const participants=new Set(campaign.cards.map(row=>row.characterId).filter(Boolean));
            const original=item.audience||{players:item.visibility==='public'?['local-user']:[],characters:item.visibility==='public'?[...participants]:item.visibility==='participants'?item.characterIds:[],shared:[],expired:false,eventId:''};
            const next=audience(original);event.itemId=item.id;event.operation=command.operation;event.before=clone(original);
            if(command.operation==='grant'){next.players=ids(command.players||[]);next.characters=ids(command.characters||[]);}
            else if(command.operation==='share'){
                const from=id(command.from),to=id(command.to);if(!visible(next,{viewer:'character',characterId:from})||from===to)throw Error('分享者尚未获知该知识');
                next.shared=next.shared.filter(row=>row.from!==from||row.to!==to);next.shared.push({from,to,eventId:event.id});
            }else if(command.operation==='unshare')next.shared=next.shared.filter(row=>row.from!==command.from||row.to!==command.to);
            else if(command.operation==='expire')next.expired=true;
            else if(command.operation==='refresh')next.expired=false;
            else throw Error('未知知识操作');
            if(next.characters.some(owner=>!participants.has(owner))||next.shared.some(row=>!participants.has(row.from)||!participants.has(row.to)))throw Error('知识权限只能指向本团角色');
            next.eventId=event.id;item.audience=audience(next);event.after=clone(item.audience);
        }else{
            const domain=command.domain;if(!['timeline','inventory','quests','relationships'].includes(domain))throw Error('未知剧情状态');
            event.domain=domain;event.operation=command.operation;
            if(domain==='timeline'){
                event.before=clone(campaign.state.timeline);const next=state({...campaign.state,timeline:command.value});if(next.timeline.turn<campaign.state.timeline.turn)throw Error('剧情回合不能静默倒退，请导入独立存档');campaign.state=next;event.after=clone(next.timeline);
            }else{
                const rows=campaign.state[domain],key=id(command.value?.id||command.itemId),index=rows.findIndex(row=>row.id===key);event.before=index<0?null:clone(rows[index]);
                if(command.operation==='remove'){if(index<0)throw Error('条目不存在');rows.splice(index,1);event.after=null;}
                else if(command.operation==='save'){if(index<0)rows.push(clone(command.value));else rows[index]=clone(command.value);campaign.state=state(campaign.state);event.after=clone(campaign.state[domain].find(row=>row.id===key));}
                else throw Error('未知剧情操作');
            }
        }
        return campaign;
    }
    function project(value,context){
        const saved=state(value),kp=context?.viewer==='kp'&&!context.characterId;
        return {timeline:saved.timeline,inventory:saved.inventory.filter(row=>kp||row.ownerId===context?.characterId||!context?.characterId&&row.ownerId==='player:'+(context?.playerId||'local-user')),quests:saved.quests.filter(row=>visible(row.audience,context)).map(({audience,...row})=>row),relationships:saved.relationships.filter(row=>visible(row.audience,context)).map(({audience,...row})=>row)};
    }
    global.TrpgStateCore=Object.freeze({audience,visible,knownCharacters,state,apply,project,fingerprint});
})(typeof window!=='undefined'?window:globalThis);
