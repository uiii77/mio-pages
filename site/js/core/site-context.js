// A new public site has its own storage namespace. Existing local installations stay unchanged.
(function(global){
    'use strict';
    const release=global.MioRelease;
    if(!release?.publicSite)return;
    if(!/^\/[a-z0-9-]+\/$/.test(release.basePath)||!location.pathname.startsWith(release.basePath))throw Error('Mio site path does not match its release');
    const prefix='mio-site:'+release.basePath+':';
    for(const name of ['localStorage','sessionStorage']){
        const native=global[name];
        const keys=()=>Array.from({length:native.length},(_,i)=>native.key(i)).filter(key=>key?.startsWith(prefix)).map(key=>key.slice(prefix.length));
        const methods={getItem:key=>native.getItem(prefix+String(key)),setItem:(key,value)=>native.setItem(prefix+String(key),String(value)),removeItem:key=>native.removeItem(prefix+String(key)),clear:()=>keys().forEach(key=>native.removeItem(prefix+key)),key:index=>keys()[Number(index)]??null};
        const storage=new Proxy({}, {
            get:(_,key)=>key==='length'?keys().length:key in methods?methods[key]:typeof key==='string'?methods.getItem(key):undefined,
            set:(_,key,value)=>{methods.setItem(key,value);return true;},
            deleteProperty:(_,key)=>{methods.removeItem(key);return true;},
            ownKeys:keys,
            getOwnPropertyDescriptor:(_,key)=>keys().includes(key)?{configurable:true,enumerable:true,writable:true,value:methods.getItem(key)}:undefined
        });
        Object.defineProperty(global,name,{configurable:true,value:storage});
    }
    global.MioSiteContext=Object.freeze({databaseName:'章鱼喷墨机DB_ee:'+release.basePath});
    document.documentElement.dataset.mioRelease=release.commit;
})(window);
