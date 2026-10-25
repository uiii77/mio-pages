(function (g) {
    'use strict';
    const VERSION = 1;
    const bundled = [
        ['COC7th快速开始规则-新版.pdf','基础规则','新版','db62fc0255cfa39a949b55f185c5af2d1f2d43f99a46e7db47eac9414e325f62'],
        ['COC7th守秘人规则书2002c.pdf','基础规则','2002c','f6113754ea095de0a60b6fb593f38df0041e0573858c28f41204a1edd039f707'],
        ['调查员手册1.21.pdf','扩展规则','1.21','817a4c48d11f5ef5635a949bdfbe5bc0463f4b64805d7dda0449b479eaeac62e'],
        ['克苏鲁的唤守秘人卡组.zip','参考卡','1','948588714eb8216e25f3b5ccc245fa4810bd5d38211f3f65c69d5da1395eb382'],
        ['克苏鲁神话魔法大典1.1.pdf','扩展规则','1.1','8b03a8c25bdda5df08f737c6b0dcec100db7275111b9159fd04dbddcb133968f'],
        ['克苏鲁时空穿梭1.0.pdf','时代背景','1.0','b4cae8a4c600d8e489a986e128b85d4c73d4e0660ab9c10d83941fb31268d303'],
        ['网团用电子卡.zip','角色卡附件','1','733cdc2505ef759a3f6e2c5b0fb042073b7e040e1d9345796c8ef5a55af904f4'],
    ].map(([name,category,version,hash])=>Object.freeze({name,category,version,hash,url:`assets/trpg-packs/${name}`}));
    function tokens(value) {
        const text = String(value || '').normalize('NFKC').toLowerCase();
        const out = new Set(text.match(/[a-z0-9_]+/g) || []);
        for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
            for(const char of run) out.add(char);
            if (run.length === 1) out.add(run);
            else for (let i=0;i<run.length-1;i++) out.add(run.slice(i,i+2));
        }
        return [...out].slice(0,3000);
    }
    function index(chunk) { return {...chunk, keys:tokens(chunk.text).map(t=>`${chunk.sourceId}|${t}`), indexVersion:VERSION}; }
    function chunks(sourceId, pages) {
        const out=[];
        for (const page of pages) {
            const lines=String(page.text || '').replace(/\r\n?/g,'\n').split('\n');
            let body='', start=1, heading='';
            function flush(end) {
                if (body.trim()) out.push(index({id:`${sourceId}:${out.length}`,sourceId,ordinal:out.length,text:body.trim(),page:page.page || null,fileName:page.fileName || '',heading,lineStart:start,lineEnd:end,revision:0}));
                body=''; start=end+1;
            }
            for(let n=0;n<lines.length;n++) {
                const line=lines[n];
                if (/^#{1,6}\s/.test(line)) { flush(n); heading=line.replace(/^#+\s*/, '').slice(0,200); }
                if (body.length+line.length>1200) flush(n);
                // Long OCR lines are bounded; source line and page remain available.
                for(let pos=0;pos<Math.max(1,line.length);pos+=1200) {
                    if(body.length+line.slice(pos,pos+1200).length>1400) flush(n+1);
                    if(!body) start=n+1;
                    body+=line.slice(pos,pos+1200)+'\n';
                }
            }
            flush(lines.length);
        }
        return out;
    }
    function visible(pack, context) {
        if (!pack.enabled || !context || !['kp','player','character'].includes(context.viewer)) return false;
        if (pack.campaignId && pack.campaignId !== context.campaignId) return false;
        if(context.viewer==='kp'&&context.characterId)return false;
        if(pack.audience)return g.TrpgStateCore.visible(pack.audience,context);
        if(context.viewer==='kp') return true;
        return pack.visibility==='public' || (pack.visibility==='participants' && !!context.characterId && (pack.characterIds || []).includes(context.characterId));
    }
    function pack(value) {
        if (!value || typeof value.id!=='string' || typeof value.sourceId!=='string' || !value.id || !value.sourceId) throw new Error('资料包格式无效');
        return {id:value.id,sourceId:value.sourceId,title:String(value.title || '资料').slice(0,200),version:String(value.version || '1').slice(0,40),category:String(value.category || '其他').slice(0,50),
            enabled:value.enabled===true,remoteAllowed:value.remoteAllowed===true,priority:Math.max(-100,Math.min(100,Number(value.priority)||0)),visibility:['public','participants'].includes(value.visibility)?value.visibility:'kp',
            ...(value.audience?{audience:g.TrpgStateCore.audience(value.audience)}:{}),
            campaignId:String(value.campaignId || '').slice(0,180), characterIds:Array.isArray(value.characterIds)?[...new Set(value.characterIds.filter(x=>typeof x==='string'))]:[],updatedAt:Number(value.updatedAt)||Date.now()};
    }
    g.TrpgLibraryCore=Object.freeze({VERSION,bundled:Object.freeze(bundled),tokens,index,chunks,visible,pack});
})(typeof window!=='undefined'?window:globalThis);
