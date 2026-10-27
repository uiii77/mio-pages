// PWA update orchestration. User data stays in its existing IndexedDB/localStorage.
(() => {
    const baseUrl = new URL('../../../', document.currentScript.src).href;
    let lastStatus = '更新只替换应用文件，不清除聊天和设置。';
    let reloadPending = false;

    function renderState() {
        const button = document.getElementById('ovo-file-update-btn');
        const status = document.getElementById('ovo-file-update-status');
        if (button) {
            const label = button.querySelector('span') || button;
            label.textContent = checking ? '正在检查…' : '检查更新';
            button.disabled = checking;
            button.setAttribute('aria-busy', String(checking));
        }
        if (status) status.textContent = lastStatus;
    }

    function report(message) {
        lastStatus = message;
        renderState();
    }

    function busy() {
        if ((typeof isGenerating !== 'undefined' && isGenerating)
            || (typeof loadingBtn !== 'undefined' && loadingBtn)) return true;
        if (document.getElementById('gh-backup-btn')?.style.pointerEvents === 'none') return true;
        if (window.ReplyResilience && typeof db !== 'undefined') {
            return (db.characters || []).some(chat => window.ReplyResilience.hasActive(chat.id, 'private'))
                || (db.groups || []).some(chat => window.ReplyResilience.hasActive(chat.id, 'group'));
        }
        return false;
    }

    let checking = false;
    let lastCheck = 0;
    let deferred = '';
    function connection(task) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('连接更新服务超时，请稍后重试')), 30000);
            task.then(resolve, reject).finally(() => clearTimeout(timer));
        });
    }
    function activeCommit(worker) {
        return new Promise(resolve => {
            if (!worker || !window.MioRelease) { resolve(null); return; }
            const channel = new MessageChannel();
            const finish = value => { clearTimeout(timer); channel.port1.close(); resolve(value); };
            const timer = setTimeout(() => finish(null), 5000);
            channel.port1.onmessage = event => finish(event.data.commit);
            worker.postMessage({ type: 'MIO_UPDATE_STATUS' }, [channel.port2]);
        });
    }
    async function check(manual = false) {
        if (checking || reloadPending || !navigator.serviceWorker || !window.isSecureContext) return;
        if (!manual && (document.visibilityState === 'hidden' || Date.now() - lastCheck < 300000)) return;
        checking = true;
        lastCheck = Date.now();
        try {
            report('正在检查更新…');
            const registration = await connection(navigator.serviceWorker.register(new URL('sw.js', baseUrl).href,
                { scope: baseUrl, updateViaCache: 'none' }));
            await connection(registration.update());
            const worker = registration.installing;
            if (worker) {
                report('正在后台下载并校验新版本…');
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => finish(new Error('下载尚未完成，请稍后检查；当前版本仍可使用')), 180000);
                    const changed = () => {
                        if (worker.state === 'installed' || worker.state === 'activated') finish();
                        else if (worker.state === 'redundant') finish(new Error('新版本下载或校验失败，请稍后重试'));
                    };
                    function finish(error) { clearTimeout(timer); worker.removeEventListener('statechange', changed); error ? reject(error) : resolve(); }
                    worker.addEventListener('statechange', changed);
                    changed();
                });
            }
            const waiting = registration.waiting;
            const installedCommit = waiting ? null : await activeCommit(registration.active);
            const needsReload = installedCommit && installedCommit !== window.MioRelease?.commit;
            if (!waiting && !needsReload) { report('当前已是最新可用版本。'); return; }
            const candidate = waiting || installedCommit;
            if ((!manual && deferred === candidate) || busy()
                || document.getElementById('custom-confirm-modal')?.style.display === 'flex') {
                report('新版本已准备好，可在操作完成后点击「检查更新」。'); return;
            }
            const confirmation = customConfirm('应用文件已下载并校验完成。更新将刷新页面，聊天记录、角色和设置都会保留。', '发现新版本');
            const ok = document.getElementById('custom-confirm-ok-btn');
            const cancel = document.getElementById('custom-confirm-cancel-btn');
            const labels = [ok?.textContent, cancel?.textContent];
            if (ok) ok.textContent = '立即更新';
            if (cancel) cancel.textContent = '稍后';
            let confirmed;
            try { confirmed = await confirmation; }
            finally { if (ok) ok.textContent = labels[0]; if (cancel) cancel.textContent = labels[1]; }
            if (!confirmed) { deferred = candidate; report('新版本已准备好，稍后可检查并更新。'); return; }
            if (busy()) throw new Error('请等待当前回复或备份完成后再更新');
            if (typeof characterSaveQueues !== 'undefined' && typeof groupSaveQueues !== 'undefined') {
                const results = await Promise.all([...characterSaveQueues.values(), ...groupSaveQueues.values()].map(task => task.promise));
                if (results.includes(false)) throw new Error('当前数据尚未保存，已停止更新');
            }
            if (typeof saveData !== 'function' || await saveData() === false || busy()) throw new Error('当前操作尚未保存完成，已停止更新');
            report('正在应用新版本…');
            if (waiting) await new Promise((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('激活尚未完成，请稍后重试')), 30000);
                const changed = () => { if (navigator.serviceWorker.controller === waiting) finish(); };
                function finish(error) { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); error ? reject(error) : resolve(); }
                navigator.serviceWorker.addEventListener('controllerchange', changed);
                waiting.postMessage({ type: 'MIO_UPDATE_ACTIVATE' });
                changed();
            });
            reloadPending = true;
            location.reload();
        } catch (error) {
            report(`${error.message || '暂时无法连接更新服务'}。已保留当前版本和数据，可稍后重试。`);
        } finally { checking = false; renderState(); }
    }
    window.OVOFileUpdate = { baseUrl, run: () => check(true), check, renderState };
    window.addEventListener?.('pageshow', () => check());
    window.addEventListener?.('online', () => check());
    document.addEventListener?.('visibilitychange', () => check());
})();
