// Explicit source loading only; no location, wallet, address or chat data is sent to providers.
(function(global){
    'use strict';
    const fail=(code,retryable=false)=>({ok:false,error:{code,retryable}});
    const providers=new Map();
    const assetRoot=new URL('../../',document.currentScript.src);
    const regionValid=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value);
    function register(id,load){
        if(!/^[a-z][a-z0-9-]{1,50}$/.test(id)||typeof load!=='function'||providers.has(id))throw new TypeError('Invalid catalog provider');
        providers.set(id,load);
    }
    async function json(url,options={}){
        const response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
        if(!response.ok)throw Error('SOURCE_UNAVAILABLE');
        const body=await response.text();if(body.length>8000000)throw Error('SOURCE_TOO_LARGE');
        return JSON.parse(body.replace(/^\uFEFF/,''));
    }
    // Fixed public endpoints. An imported package needs no network access.
    register('openfoodfacts',async request=>{
        if(request.query!==undefined){
            if(typeof request.query!=='string'||request.query.length>150)return fail('INVALID_QUERY');
            const fields='code,product_name,product_name_zh,brands,quantity,last_modified_t';
            const url=request.query?'https://world.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&json=1&page_size=6&fields='+fields+'&search_terms='+encodeURIComponent(request.query):'https://world.openfoodfacts.org/api/v2/search?page_size=6&fields='+fields;
            const response=await json(url,{signal:request.signal});if(!Array.isArray(response.products))return fail('INVALID_SOURCE');
            const facts=response.products.slice(0,6).flatMap(product=>{const normalized=CatalogCore.normalize('openfoodfacts',{product},{region:'unknown',retrievedAt:Date.now()});return normalized.ok?normalized.data:[];});return {ok:true,data:facts};
        }
        if(!CatalogCore.barcode(request.barcode))return fail('INVALID_BARCODE');
        const response=await json('https://world.openfoodfacts.org/api/v3.6/product/'+request.barcode+'?fields=code,product_name,product_name_zh,brands,quantity,last_modified_t');
        return CatalogCore.normalize('openfoodfacts',response,{region:'unknown',retrievedAt:Date.now()});
    });
    register('openstreetmap',async request=>{
        const bbox=request.bbox;
        if(!Array.isArray(bbox)||bbox.length!==4||bbox.some(value=>!Number.isFinite(value))||bbox[0]<-90||bbox[2]>90||bbox[1]<-180||bbox[3]>180||bbox[0]>=bbox[2]||bbox[1]>=bbox[3]||bbox[2]-bbox[0]>.1||bbox[3]-bbox[1]>.1)return fail('INVALID_REGION');
        const query=`[out:json][timeout:15];(nwr[amenity~"^(restaurant|cafe|fast_food)$"](${bbox.join(',')});nwr[shop~"^(convenience|bakery|florist|greengrocer)$"](${bbox.join(',')}););out center tags 120;`;
        return CatalogCore.normalize('openstreetmap',await json('https://overpass.private.coffee/api/interpreter?data='+encodeURIComponent(query),{signal:request.signal}),{region:request.region,retrievedAt:Date.now()});
    });
    function forDatabase(database){
        const key='mioCatalogFactsV1';let inFlight=false;
        async function read(){return (await database.globalSettings.get(key))?.value || {version:1,facts:[],updatedAt:0};}
        async function importFacts(facts){
            const valid=CatalogCore.validateFacts(facts);if(!valid.ok)return valid;
            const snapshot=JSON.parse(JSON.stringify(facts));
            return database.transaction('rw',database.globalSettings,async()=>{
                const prior=await read();if(prior.version!==1)return fail('UNSUPPORTED_CATALOG');
                const map=new Map(prior.facts.map(row=>[row.id,row]));
                for(const row of snapshot){const old=map.get(row.id);if(!old||row.source.retrievedAt>=old.source.retrievedAt)map.set(row.id,row);}
                if(map.size>10000)return fail('CATALOG_LIMIT');
                await database.globalSettings.put({key,value:{...prior,version:1,facts:[...map.values()],updatedAt:Date.now()}});
                return {ok:true,data:{imported:snapshot.length,total:map.size}};
            });
        }
        async function refresh(provider,input){
            if(!providers.has(provider)||!regionValid(input?.region))return fail('INVALID_SOURCE');
            if(inFlight)return fail('SOURCE_BUSY',true);
            inFlight=true;
            const captured={...JSON.parse(JSON.stringify(input)),signal:input.signal};
            try{
                const requestKey=JSON.stringify([provider,captured.region,captured.barcode??null,captured.bbox??null]);
                if(requestKey.length>1000)return fail('INVALID_SOURCE');
                const allowed=await database.transaction('rw',database.globalSettings,async()=>{
                    const rateKey='mioCatalogRate:'+provider,prior=await database.globalSettings.get(rateKey),now=Date.now();
                    if(prior && now-prior.value<(provider==='openfoodfacts'?6000:30000))return false;
                    await database.globalSettings.put({key:rateKey,value:now});return true;
                });
                if(!allowed)return fail('SOURCE_RATE_LIMITED',true);
                const result=await providers.get(provider)(captured);return result.ok?importFacts(result.data):result;
            }
            catch(_){return fail('SOURCE_UNAVAILABLE',true);}finally{inFlight=false;}
        }
        async function loadSample(){
            try{const pack=await json(new URL('data/catalog/off-sample.json',assetRoot));const result=CatalogCore.normalize(pack.provider,pack.response,pack);return result.ok?importFacts(result.data):result;}
            catch(_){return fail('SOURCE_UNAVAILABLE',true);}
        }
        async function searchPlaces(query,signal){
            const term=String(query||'').trim();if(term.length<2||term.length>150)throw Error('INVALID_REGION');
            const cached=(await read()).places?.[term];if(cached)return cached;
            await database.transaction('rw',database.globalSettings,async()=>{const state=await read();if(Date.now()-(state.placeRequestAt||0)<1500)throw Error('SOURCE_RATE_LIMITED');await database.globalSettings.put({key,value:{...state,placeRequestAt:Date.now()}});});
            const rows=await json('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&q='+encodeURIComponent(term),{signal,referrer:location.origin+'/Mio/',referrerPolicy:'unsafe-url'});
            if(!Array.isArray(rows))throw Error('SOURCE_UNAVAILABLE');
            const results=rows.map(row=>({label:String(row.display_name||'').slice(0,300),country:String(row.address?.country||''),city:String(row.address?.city||row.address?.town||row.address?.village||row.address?.state||row.name||''),district:String(row.address?.suburb||row.address?.city_district||''),location:{lat:Number(row.lat),lon:Number(row.lon)}})).filter(row=>row.country&&row.city&&Number.isFinite(row.location.lat)&&Math.abs(row.location.lat)<89.95&&Number.isFinite(row.location.lon)&&Math.abs(row.location.lon)<179.95);
            await database.transaction('rw',database.globalSettings,async()=>{const state=await read(),places={...state.places,[term]:results};const keys=Object.keys(places);if(keys.length>100)delete places[keys[0]];await database.globalSettings.put({key,value:{...state,places}});});return results;
        }
        async function market(owner){return (await read()).markets?.[owner]||null;}
        async function saveMarket(owner,value){
            const checked=CatalogCore.market(value);
            return database.transaction('rw',database.globalSettings,async()=>{const state=await read();if(state.version!==1)throw Error('UNSUPPORTED_CATALOG');await database.globalSettings.put({key,value:{...state,markets:{...state.markets,[owner]:checked}}});return checked;});
        }
        async function claimGeneration(owner,request,maxTokens,force=false,available=true){
            return database.transaction('rw',database.globalSettings,async()=>{
                const state=await read(),now=Date.now(),jobs={...state.jobs};if(state.version!==1)throw Error('UNSUPPORTED_CATALOG');
                if(!force&&jobs[request]?.status==='complete')return {cached:true,ids:jobs[request].ids};
                if(!available)throw Error('API_UNAVAILABLE');
                if(Object.values(jobs).some(j=>j.owner===owner&&j.status==='pending'&&j.until>now))throw Error('GENERATION_BUSY');
                const budget={...state.budget},today=Math.floor(now/86400000),prior=budget[owner]?.day===today?budget[owner]:{day:today,tokens:0};
                if(prior.tokens+maxTokens>12000)throw Error('TOKEN_LIMIT');budget[owner]={day:today,tokens:prior.tokens+maxTokens};
                const token=crypto.randomUUID();jobs[request]={owner,status:'pending',token,until:now+90000};
                const entries=Object.entries(jobs);while(entries.length>200){const i=entries.findIndex(([id,j])=>id!==request&&(j.status!=='pending'||j.until<=now));if(i<0)throw Error('GENERATION_BUSY');delete jobs[entries.splice(i,1)[0][0]];}
                await database.globalSettings.put({key,value:{...state,jobs,budget}});return {token};
            });
        }
        async function finishGeneration(request,token,offers,signal){
            return database.transaction('rw',database.globalSettings,database.commerceOffers,async()=>{
                const state=await read(),job=state.jobs?.[request];if(!job||job.token!==token||job.status!=='pending'||signal?.aborted)throw Error('GENERATION_CANCELLED');
                if(offers&&offers.some(offer=>offer.marketKey!==CatalogCore.marketKey(state.markets?.[job.owner])))throw Error('MARKET_CHANGED');
                if(offers){for(const offer of offers){if(!CommerceStorage.validOffer(offer))throw Error('INVALID_GENERATION');const prior=await database.commerceOffers.get(offer.id);if(prior&&(prior.version!==offer.version||prior.origin!=='ai'||prior.createdBy!==job.owner))throw Error('VERSION_CONFLICT');await database.commerceOffers.put({...offer,version:prior?prior.version+1:0});}}
                await database.globalSettings.put({key,value:{...state,jobs:{...state.jobs,[request]:{...job,status:offers?'complete':'failed',until:0,ids:offers?.map(o=>o.id)||[]}}}});
            });
        }
        async function editGenerated(owner,id,changes,expectedVersion){
            return database.transaction('rw',database.commerceOffers,async()=>{const old=await database.commerceOffers.get(id);if(!old||old.origin!=='ai'||old.createdBy!==owner)throw Error('FORBIDDEN');if(old.version!==expectedVersion)throw Error('VERSION_CONFLICT');
                const next={...old,...Object.fromEntries(['name','description','specification','unitMinor','stock','archived'].filter(k=>k in changes).map(k=>[k,changes[k]])),version:old.version+1,edited:true};
                if(next.archived)next.stock=0;if(!CommerceStorage.validOffer(next)||typeof next.description!=='string'||next.description.length>1000)throw Error('INVALID_GENERATION');await database.commerceOffers.put(next);return next;});
        }
        return Object.freeze({searchPlaces,market,saveMarket,claimGeneration,finishGeneration,editGenerated,get:async id=>(await read()).facts.find(row=>row.id===id)||null,refresh,importFacts,loadSample,loadPublicSamples:async()=>{try{const pack=await json(new URL('data/catalog/public-samples.json',assetRoot));return importFacts(pack.facts);}catch{return fail('SOURCE_UNAVAILABLE',true);}},query:async options=>CatalogCore.page((await read()).facts,options),status:async()=>{const data=await read();return {count:data.facts.length,updatedAt:data.updatedAt,providers:[...providers.keys()],coverage:'unmeasured'};}});
    }
    global.Catalog=Object.freeze({register,forDatabase});
})(typeof window!=='undefined'?window:globalThis);
