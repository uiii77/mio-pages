(function (global) {
    'use strict';
    const field = name => document.querySelector(`#health-screen [data-health="${name}"]`);
    const table = () => global.dexieDB.healthRecords;
    let ready = false, revision = 0, selection = 0;
    const notify = text => { field('status').textContent = text; };
    const run = action => Promise.resolve().then(action).catch(error => notify(error.message || '健康记录操作失败'));
    async function get(date) { return table().get(`steps:${date}`); }
    async function save(date, value, expectedRevision = 0) {
        const record = global.HealthCore.steps(date,value);
        await global.dexieDB.transaction('rw',table(),async()=>{
            const old = await get(date);
            if ((old?.revision || 0) !== expectedRevision) throw new Error('该日期记录已变化，请重新选择日期后编辑');
            await table().put({...record,revision:expectedRevision+1,createdAt:old?.createdAt || Date.now(),updatedAt:Date.now(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        });
    }
    async function remove(date, expectedRevision) {
        await global.dexieDB.transaction('rw',table(),async()=>{
            const old = await get(date);
            if (!old) return;
            if (old.revision !== expectedRevision) throw new Error('记录已变化，请刷新后再删除');
            await table().delete(old.id);
        });
    }
    async function loadDate() {
        const token = ++selection, date = field('date').value;
        field('save').disabled = true; field('delete').disabled = true;
        const row = await get(date);
        if (token !== selection) return;
        revision = row?.revision || 0;
        field('steps').value = row ? String(row.value) : '';
        field('save').disabled = !date;
        field('delete').disabled = !row;
    }
    async function refresh() {
        const today = global.HealthCore.today();
        field('date').max = today;
        if (!field('date').value) field('date').value = today;
        const rows = await table().where('date').between(global.PeriodHealthCore.addDays(today,-6),today,true,true).toArray();
        const days = global.HealthCore.week(rows,today), current = days.at(-1);
        field('today').textContent = current.value === null ? '今日尚未记录' : `今日 ${current.value.toLocaleString()} 步`;
        const chart = field('week'); chart.replaceChildren();
        const max = Math.max(1,...days.map(day=>day.value || 0));
        for (const day of days) {
            const row=document.createElement('div');row.className='health-day';
            const label=document.createElement('span');label.textContent=day.date.slice(5);
            const meter=document.createElement('meter');meter.min=0;meter.max=max;meter.value=day.value || 0;meter.setAttribute('aria-label',`${day.date} ${day.value === null ? '未记录' : day.value+' 步'}`);
            const amount=document.createElement('span');amount.textContent=day.value === null ? '未记录' : `${day.value} 步`;
            row.append(label,meter,amount);chart.append(row);
        }
        try {
            const period = await global.PeriodHealth.getLocalStatus();
            field('period').textContent = !period.lastStart ? '尚无开始记录；不知道周期也可以从确定的日期开始记' : `最近开始：${period.lastStart}${period.lastEnd ? ` · 结束：${period.lastEnd}` : ' · 结束尚未记录，当前状态未知'}`;
        } catch (_) { field('period').textContent='生理期摘要暂不可用，可打开原页面查看'; }
        await loadDate();
    }
    function setup() {
        if (ready) return; ready=true;
        field('date').onchange=()=>void run(loadDate);
        field('form').onsubmit=event=>{event.preventDefault();const date=field('date').value,value=field('steps').value,expected=revision;void run(async()=>{await save(date,value,expected);await refresh();notify('步数已保存，仅在本机使用');});};
        field('delete').onclick=()=>{const date=field('date').value,expected=revision;if(global.confirm(`删除 ${date} 的步数记录？`))void run(async()=>{await remove(date,expected);await refresh();notify('步数已删除，无法撤销；已有备份可恢复');});};
    }
    global.Health = Object.freeze({setup,refresh:()=>run(refresh),get,save,remove});
})(window);
