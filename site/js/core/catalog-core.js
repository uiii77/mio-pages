// Facts and virtual offers have separate owners. Provider responses never set trading rules.
(function(global){
    'use strict';
    const fail=code=>({ok:false,error:{code,retryable:false}});
    const text=value=>typeof value==='string'?value.trim().slice(0,500):'';
    const licenses=Object.freeze({openstreetmap:{attribution:'© OpenStreetMap contributors',license:'ODbL-1.0',url:'https://www.openstreetmap.org/copyright'},openfoodfacts:{attribution:'Open Food Facts contributors',license:'ODbL-1.0 / Database Contents License',url:'https://world.openfoodfacts.org/terms-of-use'}});
    function barcode(value){
        if(typeof value!=='string' || !/^(\d{8}|\d{12,14})$/.test(value))return false;
        let sum=0;for(let i=value.length-2,weight=3;i>=0;i--,weight=4-weight)sum+=Number(value[i])*weight;
        return (10-sum%10)%10===Number(value.at(-1));
    }
    function normalize(provider,response,context){
        if(!licenses[provider] || !Number.isSafeInteger(context?.retrievedAt) || context.retrievedAt<0 || !text(context.region))return fail('INVALID_SOURCE');
        const provenance={provider,...licenses[provider],retrievedAt:context.retrievedAt,region:text(context.region)};
        if(provider==='openfoodfacts'){
            const product=response?.product,code=String(product?.code || response?.code || '');
            if(!product)return fail('PRODUCT_NOT_FOUND');
            if(!barcode(code) || !text(product.product_name_zh || product.product_name))return fail('INVALID_PRODUCT');
            return {ok:true,data:[{id:'off:'+code,kind:'product',name:text(product.product_name_zh || product.product_name),barcode:code,brand:text(product.brands),quantity:text(product.quantity),source:{...provenance,url:'https://world.openfoodfacts.org/product/'+code,modifiedAt:Number.isSafeInteger(product.last_modified_t)?product.last_modified_t*1000:null},availability:'unknown',specifications:'source_description_only'}]};
        }
        if(response?.remark)return fail('SOURCE_INCOMPLETE');
        if(!Array.isArray(response?.elements) || response.elements.length>10000)return fail('INVALID_SOURCE');
        const result=new Map();
        for(const row of response.elements){
            if(!['node','way','relation'].includes(row.type) || !Number.isSafeInteger(row.id) || row.id<1 || !text(row.tags?.name))continue;
            const category=({restaurant:'food',fast_food:'food',cafe:'drink',bakery:'dessert',convenience:'convenience',greengrocer:'fresh',florist:'flower'})[row.tags.amenity || row.tags.shop];
            if(!category)continue;
            const lat=row.lat??row.center?.lat,lon=row.lon??row.center?.lon;
            const location=Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lon)&&Math.abs(lon)<=180?{lat,lon,crs:'WGS84'}:null;
            const address=text(row.tags['addr:full']) || [row.tags['addr:street'],row.tags['addr:housenumber']].map(text).filter(Boolean).join(' ');
            const id=`osm:${row.type}:${row.id}`;
            result.set(id,{id,kind:'store',name:text(row.tags.name),category,address,location,operatingStatus:'unverified',source:{...provenance,url:`https://www.openstreetmap.org/${row.type}/${row.id}`,modifiedAt:null}});
        }
        return {ok:true,data:[...result.values()]};
    }
    function validateFacts(rows){
        if(!Array.isArray(rows)||rows.length>10000)return fail('INVALID_SOURCE');
        const ids=new Set();
        for(const row of rows){
            if(!row || !text(row.id) || ids.has(row.id) || !['store','product'].includes(row.kind) || !text(row.name) || !licenses[row.source?.provider] || row.source.license!==licenses[row.source.provider].license || row.source.attribution!==licenses[row.source.provider].attribution || !Number.isSafeInteger(row.source.retrievedAt) || !(/^https:\/\/(?:www\.)?openstreetmap\.org\/(?:node|way|relation)\/\d+$/.test(row.source.url||'')&&row.source.provider==='openstreetmap'||/^https:\/\/world\.openfoodfacts\.org\/product\/\d+$/.test(row.source.url||'')&&row.source.provider==='openfoodfacts') || ['price','stock','delivery','unitMinor'].some(key=>key in row))return fail('INVALID_SOURCE');
            ids.add(row.id);
        }
        return {ok:true,data:rows};
    }
    function page(rows,{query='',region='',kind='',offset=0,limit=30}={}){
        if(!Array.isArray(rows)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return fail('INVALID_QUERY');
        const term=text(query).toLocaleLowerCase();
        const matches=rows.filter(row=>(!region||row.source.region===region)&&(!kind||row.kind===kind)&&(!term||[row.name,row.brand,row.address,row.barcode].some(value=>String(value||'').toLocaleLowerCase().includes(term))));
        return {ok:true,data:{items:matches.slice(offset,offset+limit),total:matches.length,nextOffset:offset+limit<matches.length?offset+limit:null}};
    }
    function market(value){
        const v=value||{};
        if(!['country','city','district','world'].every(k=>typeof v[k]==='string'&&v[k].length<=(k==='world'?1200:100))||!v.country.trim()||!v.city.trim()||!Number.isInteger(v.year)||v.year<1||v.year>9999||!CurrencyCore.isSupported(v.currency))throw Error('INVALID_MARKET');
        const location=v.location==null?null:v.location;
        if(location&&(!Number.isFinite(location.lat)||Math.abs(location.lat)>89.95||!Number.isFinite(location.lon)||Math.abs(location.lon)>179.95))throw Error('INVALID_MARKET');
        return {country:v.country.trim(),city:v.city.trim(),district:v.district.trim(),world:v.world.trim(),year:v.year,currency:v.currency.toUpperCase(),location:location?{lat:location.lat,lon:location.lon}:null};
    }
    const marketKey=value=>JSON.stringify(market(value));
    function generated(text,context,facts,count,category){
        if(typeof text!=='string'||text.length>40000)throw Error('INVALID_GENERATION');
        const body=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi,''));
        if(!Array.isArray(body.items)||body.items.length<1||body.items.length>count)throw Error('INVALID_GENERATION');
        const seen=new Set();
        return body.items.map(item=>{
            if(!item||!['name','store','description','specification','section'].every(k=>typeof item[k]==='string'&&item[k].trim()&&item[k].length<=(k==='description'?1000:180))||!Number.isInteger(item.introducedYear)||item.introducedYear<1||item.introducedYear>context.year||!Number.isInteger(item.stock)||item.stock<1||item.stock>10000||typeof item.price!=='string'||!/^\d{1,8}(?:\.\d{1,2})?$/.test(item.price))throw Error('INVALID_GENERATION');
            const name=item.name.trim(),key=item.store.trim()+'|'+name;if(seen.has(key))throw Error('INVALID_GENERATION');seen.add(key);
            // A conservative guard supplements the prompt; model claims alone cannot verify historical accuracy.
            const eras=[[1990,/智能手机|手机应用|扫码|二维码|外卖平台|smartphone|app store|qr code|usb/iu],[1960,/微波炉|激光|microwave|laser/iu],[1980,/蓝牙|无线耳机|bluetooth|wireless earbuds/iu]];
            if(eras.some(([year,pattern])=>context.year<year&&pattern.test([name,item.store,item.description,item.specification].join(' '))))throw Error('ANACHRONISM');
            const fact=item.factId?facts.find(row=>row.id===item.factId):null;if(item.factId&&!fact)throw Error('INVALID_SOURCE');
            const unitMinor=CurrencyCore.amountToMinor(item.price,context.currency);if(!Number.isSafeInteger(unitMinor)||unitMinor<=0)throw Error('INVALID_GENERATION');
            const result={name:fact?.kind==='product'?fact.name:name,storeId:fact?.kind==='store'?fact.name:item.store.trim(),description:item.description.trim(),specification:item.specification.trim(),menuCategory:item.section.trim(),unitMinor,stock:item.stock,currency:context.currency,category,factId:fact?.id||null,introducedYear:item.introducedYear,simulation:true,origin:'ai',art:['food','drink','cake','bag','headphones','lamp','book','bottle'].includes(item.art)?item.art:(category==='food'?'food':'book')};
            return result;
        });
    }
    global.CatalogCore=Object.freeze({licenses,barcode,normalize,validateFacts,page,market,marketKey,generated});
})(typeof window!=='undefined'?window:globalThis);
