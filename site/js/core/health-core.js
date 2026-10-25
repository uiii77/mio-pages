(function (global) {
    'use strict';
    const dates = () => global.PeriodHealthCore;
    function today(now = new Date()) {
        return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    }
    function steps(date, value, currentDay = today()) {
        if (!dates().validDate(date) || date > currentDay) throw new Error('请选择有效日期，不能记录未来步数');
        if (String(value).trim() === '' || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 1000000) throw new Error('步数须为 0 至 1000000 的整数');
        return {id:`steps:${date}`,kind:'steps',date,value:Number(value),unit:'steps',source:'manual'};
    }
    function week(records, end = today()) {
        return Array.from({length:7},(_,index) => {
            const date = dates().addDays(end,index-6);
            const row = records.find(item => item.kind === 'steps' && item.date === date);
            return {date,value:row && Number.isSafeInteger(row.value) && row.value >= 0 ? row.value : null};
        });
    }
    global.HealthCore = Object.freeze({today,steps,week});
})(window);
