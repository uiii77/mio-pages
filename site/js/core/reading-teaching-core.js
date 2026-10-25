(function(global){
    'use strict';
    function text(value,max,label){if(typeof value!=='string'||value.length>max)throw Error(label+'无效或过长');return value;}
    function deck(value){
        if(!value||value.schemaVersion!==1||!Array.isArray(value.slides)||!value.slides.length||value.slides.length>200)throw Error('演示文稿须包含 1–200 页');
        const slides=value.slides.map(row=>{if(!row||typeof row.id!=='string'||!row.id||row.id.length>100)throw Error('幻灯片引用无效');return {id:row.id,title:text(row.title,200,'标题'),body:text(row.body,12000,'正文'),notes:text(row.notes||'',12000,'讲者备注')};});
        if(new Set(slides.map(row=>row.id)).size!==slides.length)throw Error('幻灯片 ID 重复');
        if(!Number.isSafeInteger(value.currentIndex)||value.currentIndex<0||value.currentIndex>=slides.length)throw Error('演示位置无效');
        if(value.sourceActivityId!=null&&(typeof value.sourceActivityId!=='string'||value.sourceActivityId.length>1000)||value.sourceScope!=null&&(typeof value.sourceScope!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceScope)))throw Error('演示来源引用无效');
        const result={schemaVersion:1,title:text(value.title,240,'演示标题'),slides,currentIndex:value.currentIndex,sourceActivityId:value.sourceActivityId||null,sourceScope:value.sourceScope||null};
        if(JSON.stringify(result).length>2000000)throw Error('演示内容过大，请分成多份保存');
        return result;
    }
    function fromLecture(title,content,source={}){
        text(content,50000,'讲课内容');if(!content.trim())throw Error('讲课内容为空');const slides=[];let start=0;
        while(start<content.length){
            let end=Math.min(content.length,start+800);
            if(end<content.length){const split=Math.max(content.lastIndexOf('\n',end),content.lastIndexOf(' ',end));if(split>start+500)end=split+1;}
            if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1])&&/[\uDC00-\uDFFF]/.test(content[end]))end++;
            const body=content.slice(start,end),heading=body.split('\n').find(line=>line.trim())||'';
            slides.push({id:'slide-'+slides.length,title:heading.replace(/^#+\s*/,'').trim().slice(0,80)||'第 '+(slides.length+1)+' 部分',body,notes:''});start=end;
        }
        return deck({schemaVersion:1,title,slides,currentIndex:0,sourceActivityId:source.activityId||null,sourceScope:source.scope||null});
    }
    function validateDraft(value){if(!value||!Number.isSafeInteger(value.baseVersion)||value.baseVersion<0)throw Error('演示草稿版本无效');return {baseVersion:value.baseVersion,data:deck(value.data)};}
    global.ReadingTeachingCore=Object.freeze({deck,fromLecture,validateDraft});
})(typeof window!=='undefined'?window:globalThis);
