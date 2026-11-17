// Service Worker - 应用壳离线恢复与系统推送通知
try {
    // A new import URL also reaches users whose older page still uses the default HTTP cache policy.
    importScripts('./sw-assets.js?ovo-manifest=pwa-update-2');
} catch (error) {
    console.warn('Service worker asset manifest unavailable:', error);
}

const OVO_SW_MANIFEST = self.__OVO_SW_MANIFEST || { version: 'fallback', assets: ['index.html', 'manifest.json'] };
// CacheStorage is shared by all sites on an origin, including /OVO/, /xinOVO/ and /TUT/.
const OVO_SCOPE = self.registration.scope;
const OVO_CACHE_PREFIX = `ovo-app-shell-${encodeURIComponent(OVO_SCOPE)}-`;
const OVO_CACHE_NAME = `${OVO_CACHE_PREFIX}${OVO_SW_MANIFEST.version}`;
const OVO_STATE_CACHE = `ovo-app-state-${encodeURIComponent(OVO_SCOPE)}`;
const OVO_ACTIVE_KEY = new URL('__ovo_active_shell__', OVO_SCOPE).href;
const OVO_INSTALL_KEY = new URL('__ovo_installed_' + OVO_SW_MANIFEST.version + '__', OVO_SCOPE).href;
const OVO_CLIENT_PREFIX = new URL('__ovo_client_', OVO_SCOPE).href;
const OVO_PULL_PREFIX = new URL('__ovo_pull_', OVO_SCOPE).href;
const ovoPulls = new Map();
// A migration requires acknowledgements from every live page, including an older uncontrolled page.
self.addEventListener('message',event=>{
    if(event.data?.type!=='MIO_WALLET_PROBE_CLIENTS' || !event.ports?.[0] || !event.source?.url?.startsWith(OVO_SCOPE))return;
    event.waitUntil((async()=>{
        const port=event.ports[0],shell=await readShell();
        if(!shell.manifest.assets.includes('js/modules/wallet-cutover.js')){port.postMessage({ok:false,protocol:0});return;}
        // Other Mio deployments can share the origin but own different storage and clients.
        const pages=(await self.clients.matchAll({type:'window',includeUncontrolled:true}))
            .filter(page=>page.url.startsWith(OVO_SCOPE));
        const replies=await Promise.all(pages.map(page=>new Promise(resolve=>{
            const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(null);},5000);
            channel.port1.onmessage=message=>{clearTimeout(timer);channel.port1.close();resolve(message.data);};
            page.postMessage({type:'MIO_WALLET_PROBE'},[channel.port2]);
        })));
        port.postMessage({ok:replies.every(reply=>reply?.protocol===1 && reply.ready),protocol:1,checkedAt:Date.now(),clientCount:pages.length});
    })());
});
let ovoInstalledShell;

// The installing, waiting and active workers share caches even after their JS globals expire.
function withShellLock(run, { shared = false, cleanup = false } = {}) {
    const locks = self.navigator?.locks;
    if (!locks?.request) return cleanup ? Promise.resolve() : run();
    return locks.request('mio-shell:' + OVO_SCOPE, {
        mode: shared ? 'shared' : 'exclusive', ifAvailable: cleanup
    }, lock => lock ? run() : undefined);
}

async function cleanupShells() {
    await withShellLock(async () => {
        const registration = self.registration;
        const unstable = () => registration.installing || registration.waiting ||
            registration.active?.state !== 'activated';
        if (unstable()) return;
        const state = await caches.open(OVO_STATE_CACHE);
        const active = await state.match(OVO_ACTIVE_KEY);
        if (!active) return;
        const pages = (await clients.matchAll({ type: 'window', includeUncontrolled: true }))
            .filter(page => page.url.startsWith(OVO_SCOPE));
        const live = new Set(pages.map(page => page.id));
        const current = await active.json();
        if (!current?.name?.startsWith(OVO_CACHE_PREFIX)) return;
        const retained = new Set([current.name]);
        for (const id of live) {
            const pin = await state.match(OVO_CLIENT_PREFIX + id + '__');
            // A page that hasn't finished navigation or the first installation may still lack a pin.
            if (!pin) return;
            const name = (await pin.json()).name;
            if (!name?.startsWith(OVO_CACHE_PREFIX)) return;
            retained.add(name);
        }
        const stale = [];
        for (const key of await state.keys()) {
            if (key.url.startsWith(OVO_CLIENT_PREFIX)) {
                if (!live.has(key.url.slice(OVO_CLIENT_PREFIX.length, -2))) stale.push(key);
            } else if (key.url.startsWith(OVO_PULL_PREFIX)) {
                const prepared = await (await state.match(key)).json();
                if (!prepared.name?.startsWith(OVO_CACHE_PREFIX) || typeof prepared.owner !== 'string' ||
                    !prepared.previous?.startsWith(OVO_CACHE_PREFIX)) return;
                if (live.has(prepared.owner) && prepared.previous === current.name) retained.add(prepared.name);
                else stale.push(key);
            } else if (key.url.startsWith(new URL('__ovo_installed_', OVO_SCOPE).href)) {
                // No installing, waiting or activating worker owns this leftover descriptor.
                stale.push(key);
            }
        }
        for (const name of await caches.keys()) {
            if (unstable()) return;
            if (name.startsWith(OVO_CACHE_PREFIX) && !retained.has(name)) await caches.delete(name);
        }
        for (const key of stale) {
            if (unstable()) return;
            await state.delete(key);
        }
    }, { cleanup: true });
}

function tryCleanupShells() {
    return cleanupShells().catch(error => console.warn('Old app cache cleanup deferred:', error));
}

async function readShell() {
    const response = await (await caches.open(OVO_STATE_CACHE)).match(OVO_ACTIVE_KEY);
    return response ? response.json() : { name: OVO_CACHE_NAME, manifest: OVO_SW_MANIFEST };
}

async function writeShell(shell) {
    await (await caches.open(OVO_STATE_CACHE)).put(OVO_ACTIVE_KEY, new Response(JSON.stringify(shell)));
}

function validateManifest(manifest) {
    if (!manifest || !/^[a-f0-9]{16}$/.test(manifest.version) || !Array.isArray(manifest.assets)
        || !manifest.assets.includes('index.html') || !manifest.integrity
        || new Set(manifest.assets).size !== manifest.assets.length) {
        throw new Error('更新文件清单不完整，请等待网站发布完成后重试');
    }
    for (const asset of manifest.assets) {
        const url = new URL(asset, OVO_SCOPE);
        if (typeof asset !== 'string' || url.origin !== self.location.origin
            || !url.href.startsWith(OVO_SCOPE) || url.search || url.hash
            || !/^[a-f0-9]{64}$/.test(manifest.integrity[asset] || '')) {
            throw new Error('更新文件清单无效');
        }
    }
    return manifest;
}

async function verifyResponse(response, asset, manifest) {
    if (!response || !response.ok) throw new Error(`下载失败：${asset}`);
    const expected = manifest.integrity && manifest.integrity[asset];
    if (expected) {
        const content = (await response.clone().text()).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== expected) throw new Error(`文件尚未同步完成：${asset}，请稍后重试`);
    }
    return response;
}

async function fetchFresh(asset, nonce, signal) {
    const url = new URL(asset, OVO_SCOPE);
    url.searchParams.set('ovo-update', nonce);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal) {
        if (signal.aborted) cancel();
        signal.addEventListener('abort', cancel, { once: true });
    }
    const timer = setTimeout(cancel, 30000);
    try {
        // A fetch inside the worker bypasses its own cache-first fetch handler.
        const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error(`下载失败：${asset}`);
        // Keep the timeout/cancellation attached until the entire body has arrived.
        return new Response(await response.arrayBuffer(), {
            status: response.status, statusText: response.statusText, headers: response.headers
        });
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
    }
}

async function downloadShell(manifest, name, nonce, signal, progress = () => {}) {
    const cache = await caches.open(name);
    const previous = await readShell();
    const source = previous.name !== name && previous.name.startsWith(OVO_CACHE_PREFIX)
        ? await caches.open(previous.name) : null;
    const assets = manifest.assets;
    // Carry over cached dictionaries, but never download unused dictionaries during an update.
    const total = assets.filter(asset => !asset.startsWith('js/vendor/tokenizer/')).length;
    let next = 0;
    let completed = 0;
    let failure;
    progress({ completed, total });
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
        while (!failure && next < assets.length) {
            const asset = assets[next++];
            try {
                if (signal && signal.aborted) throw new Error('已取消拉取');
                const key = new URL(asset, OVO_SCOPE).href;
                const lazy = asset.startsWith('js/vendor/tokenizer/');
                const expected = manifest.integrity[asset];
                const previousHash = previous.manifest?.integrity?.[asset];
                let response;
                if (source && expected && (!previousHash || previousHash === expected)) {
                    try {
                        // A matching manifest hash is not enough: verify the cached body too.
                        response = await verifyResponse(await source.match(key), asset, manifest);
                    } catch (_) { /* Missing or damaged cache entries fall back to a fresh download. */ }
                }
                if (!response && lazy) continue;
                if (!response) response = await verifyResponse(await fetchFresh(asset, nonce, signal), asset, manifest);
                if (signal && signal.aborted) throw new Error('已取消拉取');
                await cache.put(key, response);
                if (!lazy) progress({ completed: ++completed, total });
            } catch (error) {
                failure = error;
            }
        }
    }));
    if (failure) throw failure;
}

self.addEventListener('install', (event) => {
    console.log('Service worker installing...');
    event.waitUntil(withShellLock(async () => {
        validateManifest(OVO_SW_MANIFEST);
        const current = await readShell();
        const existing = await caches.keys();
        const cached = existing.includes(current.name) &&
            await (await caches.open(current.name)).match(new URL('index.html', OVO_SCOPE).href);
        if (current.protocol === 2 && current.manifest.version === OVO_SW_MANIFEST.version && cached) {
            ovoInstalledShell = current;
        } else {
            // A rollback may target a cache that still serves an open page.
            const name = existing.includes(OVO_CACHE_NAME)
                ? OVO_CACHE_NAME + '-install-' + crypto.randomUUID() : OVO_CACHE_NAME;
            try {
                await downloadShell(OVO_SW_MANIFEST, name, Date.now().toString());
                ovoInstalledShell = { name, manifest: OVO_SW_MANIFEST };
            } catch (error) {
                await caches.delete(name);
                throw error;
            }
        }
        await (await caches.open(OVO_STATE_CACHE)).put(OVO_INSTALL_KEY, new Response(JSON.stringify(ovoInstalledShell)));
        // Old pages cannot acknowledge the new protocol. Bootstrap once; keep their shell pinned.
        if (!self.registration.active || !current.protocol) await self.skipWaiting();
    }, { shared: true }));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(withShellLock(async () => {
        const previous = await readShell();
        const state = await caches.open(OVO_STATE_CACHE);
        const installed = await state.match(OVO_INSTALL_KEY);
        const shell = ovoInstalledShell || (installed && await installed.json()) || { name: OVO_CACHE_NAME, manifest: OVO_SW_MANIFEST };
        const pages = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const page of pages.filter(page => page.url.startsWith(OVO_SCOPE))) {
            const key = new URL(`__ovo_client_${page.id}__`, OVO_SCOPE).href;
            if (!await state.match(key)) await state.put(key, new Response(JSON.stringify(previous)));
        }
        await writeShell({ ...shell, protocol: 2 });
        await state.delete(OVO_INSTALL_KEY);
        await clients.claim();
    }).then(tryCleanupShells));
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || !url.href.startsWith(OVO_SCOPE)) return;

    // Only handle app files; API requests, uploads and remote resources keep their existing behavior.
    const relative = url.href.startsWith(OVO_SCOPE) ? url.pathname.slice(new URL(OVO_SCOPE).pathname.length) : '';
    if (relative === 'release.json' || relative === 'sw-assets.js') {
        event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
        return;
    }
    if (request.mode !== 'navigate' && !OVO_SW_MANIFEST.assets.includes(relative) && !/\.(?:js|css|json|png|svg)$/.test(relative)) return;
    event.respondWith((async () => {
        const state = await caches.open(OVO_STATE_CACHE);
        let shell;
        if (request.mode === 'navigate' && event.resultingClientId) {
            shell = await withShellLock(async () => {
                const current = await readShell();
                await state.put(OVO_CLIENT_PREFIX + event.resultingClientId + '__', new Response(JSON.stringify(current)));
                return current;
            }, { shared: true });
        } else if (event.clientId) {
            const pinned = await state.match(new URL(`__ovo_client_${event.clientId}__`, OVO_SCOPE).href);
            if (pinned) shell = await pinned.json();
        }
        if (!shell) shell = await readShell();
        const cache = await caches.open(shell.name);
        const asset = request.mode === 'navigate' ? 'index.html' : relative;
        if (!shell.manifest.assets.includes(asset)) return fetch(request);
        const key = new URL(asset, OVO_SCOPE).href;
        const cached = await cache.match(key);
        if (request.mode !== 'navigate' && cached) return cached;
        try {
            // Keep online navigation, but never mix a new HTML entry with an older shell.
            const response = await verifyResponse(await fetch(request), asset, shell.manifest);
            await cache.put(key, response.clone());
            return response;
        } catch (_) {
            return cached || Response.error();
        }
    })());
});

// A staged pull becomes active only after the page has saved its data.
self.addEventListener('message', event => {
    if (event.data?.type === 'MIO_CLEAN_OLD_SHELLS' && event.source?.url?.startsWith(OVO_SCOPE)) {
        event.waitUntil(tryCleanupShells());
    }
    if (event.data?.type === 'MIO_UPDATE_STATUS' && event.source?.url?.startsWith(OVO_SCOPE) && event.ports?.[0]) {
        event.waitUntil((async () => {
            const shell = await readShell();
            const release = await (await caches.open(shell.name)).match(new URL('release.json', OVO_SCOPE).href);
            event.ports[0].postMessage({ commit: release ? (await release.json()).commit : null });
        })());
    }
    if (event.data?.type === 'MIO_UPDATE_ACTIVATE' && event.source?.url?.startsWith(OVO_SCOPE)) {
        event.waitUntil(self.skipWaiting());
    }
});
self.addEventListener('message', event => {
    const data = event.data;
    const port = event.ports && event.ports[0];
    if (!data || !String(data.type).startsWith('OVO_UPDATE_') || !port) return;
    if (!event.source || !event.source.url || !event.source.url.startsWith(OVO_SCOPE)) return;
    event.waitUntil(withShellLock(async () => {
        try {
            if (data.type === 'OVO_UPDATE_PING') {
                port.postMessage({ type: 'done', protocol: 1 });
                return;
            }
            if (!/^[a-z0-9-]{1,80}$/.test(data.token || '')) throw new Error('更新请求无效');
            const name = `${OVO_CACHE_PREFIX}pull-${data.token}`;
            const key = new URL(`__ovo_pull_${data.token}__`, OVO_SCOPE).href;
            const state = await caches.open(OVO_STATE_CACHE);
            if (data.type === 'OVO_UPDATE_PREPARE') {
                if (ovoPulls.size) throw new Error('另一个页面正在拉取，请稍后重试');
                const controller = new AbortController();
                ovoPulls.set(data.token, { controller, owner: event.source.id });
                let ownsTarget = false;
                try {
                    if ((await caches.keys()).includes(name) || await state.match(key)) {
                        port.postMessage({ type: 'error', message: '本次拉取已存在，请重新拉取' });
                        return;
                    }
                    ownsTarget = true;
                    const response = await fetchFresh('sw-assets.js', data.token, controller.signal);
                    if (!response.ok) throw new Error('无法获取最新文件清单，请检查网络');
                    const match = (await response.text()).match(/^\s*self\.__OVO_SW_MANIFEST\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
                    const manifest = validateManifest(match && JSON.parse(match[1]));
                    const previous = await readShell();
                    await downloadShell(manifest, name, data.token, controller.signal,
                        progress => port.postMessage({ type: 'progress', ...progress }));
                    if (controller.signal.aborted) throw new Error('已取消拉取');
                    await state.put(key, new Response(JSON.stringify({ name, manifest, previous: previous.name, owner: event.source.id })));
                    if (controller.signal.aborted) throw new Error('已取消拉取');
                    port.postMessage({ type: 'done', version: manifest.version });
                } catch (error) {
                    if (ownsTarget) {
                        await caches.delete(name);
                        await state.delete(key);
                    }
                    throw error;
                } finally {
                    ovoPulls.delete(data.token);
                }
            } else if (data.type === 'OVO_UPDATE_DISCARD') {
                const running = ovoPulls.get(data.token);
                if (running && running.owner === event.source.id) running.controller.abort();
                const staged = await state.match(key);
                if (staged && (await staged.json()).owner === event.source.id) {
                    await state.delete(key);
                }
                port.postMessage({ type: 'done' });
            } else if (data.type === 'OVO_UPDATE_APPLY') {
                const staged = await state.match(key);
                if (!staged) throw new Error('拉取结果已失效或其他页面已更新，请重新拉取');
                const prepared = await staged.json();
                const previous = await readShell();
                if (prepared.owner !== event.source.id || prepared.previous !== previous.name) {
                    throw new Error('其他页面已更新，请重新拉取');
                }
                if (!(await (await caches.open(name)).match(new URL('index.html', OVO_SCOPE).href))) {
                    throw new Error('更新缓存已被清理，请重新拉取');
                }
                await writeShell({ name, manifest: prepared.manifest, protocol: 2 });
                // The commit has succeeded; cleanup failure must not report the update as failed.
                await Promise.allSettled([state.delete(key)]);
                port.postMessage({ type: 'done', version: prepared.manifest.version });
            }
        } catch (error) {
            port.postMessage({ type: 'error', message: error.message || '拉取失败，请检查网络后重试' });
        }
    }, { shared: data.type !== 'OVO_UPDATE_APPLY' }).then(() => {
        if (data.type === 'OVO_UPDATE_APPLY' || data.type === 'OVO_UPDATE_DISCARD') return tryCleanupShells();
    }));
});

// 接收来自页面的消息，直接显示系统通知（无需服务器，应用在前/后台时使用）
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, body, icon, badge, tag } = event.data.payload;
        event.waitUntil(
            self.registration.showNotification(title, {
                body: body || '',
                icon: icon || undefined,
                badge: badge || undefined,
                tag: tag || 'ovo-message',
                renotify: true,
                vibrate: [200, 100, 200],
            })
        );
    }
});

// 接收服务器 Web Push（用户配置了自定义推送服务器时由服务器推送过来）
self.addEventListener('push', (event) => {
    if (!event.data) return;
    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = { title: 'OVO', body: event.data.text() };
    }
    event.waitUntil(
        self.registration.showNotification(data.title || 'OVO', {
            body: data.body || '',
            icon: data.icon || undefined,
            badge: data.badge || undefined,
            tag: 'ovo-push',
            renotify: true,
            vibrate: [200, 100, 200],
        })
    );
});

// 点击通知后将应用窗口聚焦到前台
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('./');
        })
    );
});
