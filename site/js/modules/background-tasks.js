// Transport and device session only. Reminder data remains owned by reminder.js.
(function (global) {
    'use strict';
    let session=null, generation=0, initialized=false, syncing=false;
    const el=id=>document.getElementById(id);
    const message=error=>error?.message || '后台连接失败，请稍后重试';
    function endpoint(value) {
        const url=new URL(value);
        if(url.username || url.password || url.search || url.hash || url.pathname!=='/'
            || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) {
            throw Error('请填写 HTTPS 服务地址，不含路径、账号或参数');
        }
        return url.origin;
    }
    function identity() {return session ? {endpoint:session.endpoint,ownerId:session.ownerId,deviceId:session.deviceId} : null;}
    async function send(current,path,options={}) {
        const response=await fetch(current.endpoint+path,{method:options.method || 'GET',mode:'cors',credentials:'omit',
            cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000),
            headers:{Authorization:`Bearer ${current.token}`,'Content-Type':'application/json'},
            ...(options.body ? {body:JSON.stringify(options.body)} : {})});
        if(!response.ok) {
            if(response.status===401) throw Error('设备凭据无效或已撤销，请重新连接');
            if(response.status===409) throw Error('任务版本冲突，原任务未覆盖');
            if(response.status===429) throw Error('请求过于频繁，请稍后重试');
            throw Error('后台请求失败，已保留本地记录');
        }
        return response.json();
    }
    async function request(path,options) {
        const current=session, version=generation;
        if(!current) throw Error('请先连接后台服务');
        const result=await send(current,path,options);
        if(version!==generation || current!==session) throw Error('连接已改变，结果留待下次同步');
        return result;
    }
    async function connect(url,token) {
        if(!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw Error('请输入有效的设备令牌');
        const version=++generation;session=null;
        const candidate={endpoint:endpoint(url),token};
        const profile=await send(candidate,'/v1/session');
        if(version!==generation) throw Error('连接已取消');
        if(profile.protocolVersion!==1 || !/^[A-Za-z0-9_-]{1,100}$/.test(profile.ownerId)
            || !/^[A-Za-z0-9_-]{1,100}$/.test(profile.deviceId)) throw Error('服务版本或设备信息不兼容');
        session={...candidate,ownerId:profile.ownerId,deviceId:profile.deviceId};
        return identity();
    }
    function disconnect() {generation++;session=null;}
    async function devices() {return request('/v1/devices');}
    async function revoke(id) {
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error('设备信息无效');
        await request(`/v1/devices/${id}/revoke`,{method:'POST'});
        if(session?.deviceId===id) disconnect();
    }
    async function sync() {
        if(syncing || !session || document.hidden || navigator.onLine===false) return;
        syncing=true;
        try {await global.ReminderBackground?.syncAll();}
        finally {syncing=false;}
    }
    function status(text) {if(el('background-service-status')) el('background-service-status').textContent=text;}
    async function renderDevices() {
        const area=el('background-service-devices');if(!area) return;area.replaceChildren();
        if(!session) return;
        const result=await devices();
        for(const item of (Array.isArray(result.devices) ? result.devices.slice(0,100) : [])) {
            const row=document.createElement('div');row.className='background-device-row';
            const label=document.createElement('span');label.textContent=`${item.deviceId}${item.current ? '（当前设备）' : ''}${item.revoked ? ' · 已撤销' : ''}`;
            row.append(label);
            if(!item.revoked) {
                const button=document.createElement('button');button.type='button';button.className='reminder-btn-cancel';button.textContent='撤销';
                button.onclick=()=>void action(async()=>{
                    if(!confirm('撤销此设备，并取消它尚未完成的后台任务？')) return;
                    await revoke(item.deviceId);status('设备已撤销；已完成的结果仍保留');await renderDevices();
                });row.append(button);
            }
            area.append(row);
        }
    }
    async function action(work) {try {await work();} catch(error) {status(message(error));}}
    function open() {
        el('background-service-modal')?.classList.add('visible');
        status(session ? `已连接：${session.deviceId}` : '尚未连接。令牌仅在本次页面会话中使用。');
        void action(renderDevices);
    }
    function init() {
        if(initialized) return;initialized=true;
        ['background-service-open','background-service-settings-open'].forEach(id=>el(id)?.addEventListener('click',open));
        el('background-service-close')?.addEventListener('click',()=>{
            el('background-service-token').value='';el('background-service-modal').classList.remove('visible');
        });
        el('background-service-connect')?.addEventListener('click',()=>void action(async()=>{
            const input=el('background-service-token'), token=input.value.trim();input.value='';
            await connect(el('background-service-url').value.trim(),token);
            status(`已连接：${session.deviceId}。请逐条选择要交给后台的提醒。`);
            await renderDevices();await sync();
        }));
        el('background-service-disconnect')?.addEventListener('click',()=>{
            disconnect();el('background-service-token').value='';el('background-service-devices').replaceChildren();
            status('已退出本次连接；已提交的任务仍在后台执行。');
        });
        el('background-service-sync')?.addEventListener('click',()=>void action(async()=>{
            if(!session) throw Error('请先连接后台服务');await sync();status('已检查任务；各条提醒显示最新同步状态。');
        }));
        document.addEventListener('visibilitychange',()=>void action(sync));
        global.addEventListener('online',()=>void action(sync));
        setInterval(()=>void action(sync),30000);
    }
    global.BackgroundTasks=Object.freeze({identity,connect,disconnect,request,devices,revoke,sync,open,init});
})(window);
