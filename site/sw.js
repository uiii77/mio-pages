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
const ovoPulls = new Map();
// A migration requires acknowledgements from every live page, including an older uncontrolled page.
self.addEventListener('message',event=>{
    if(event.data?.type!=='MIO_WALLET_PROBE_CLIENTS' || !event.ports?.[0] || !event.source?.url?.startsWith(OVO_SCOPE))return;
    event.waitUntil((async()=>{
        const port=event.ports[0],shell=await readShell();
        if(!shell.manifest.assets.includes('js/modules/wallet-cutover.js')){port.postMessage({ok:false,protocol:0});return;}
        const pages=await self.clients.matchAll({type:'window',includeUncontrolled:true});
        const replies=await Promise.all(pages.map(page=>new Promise(resolve=>{
            const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(null);},5000);
            channel.port1.onmessage=message=>{clearTimeout(timer);channel.port1.close();resolve(message.data);};
            page.postMessage({type:'MIO_WALLET_PROBE'},[channel.port2]);
        })));
        port.postMessage({ok:replies.every(reply=>reply?.protocol===1 && reply.ready),protocol:1,checkedAt:Date.now(),clientCount:pages.length});
    })());
});
let ovoInstalledShell;

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
    event.waitUntil((async () => {
        validateManifest(OVO_SW_MANIFEST);
        const current = await readShell();
        const cached = await (await caches.open(current.name)).match(new URL('index.html', OVO_SCOPE).href);
        if (current.protocol === 2 && current.manifest.version === OVO_SW_MANIFEST.version && cached) {
            ovoInstalledShell = current;
        } else {
            try {
                await downloadShell(OVO_SW_MANIFEST, OVO_CACHE_NAME, Date.now().toString());
                ovoInstalledShell = { name: OVO_CACHE_NAME, manifest: OVO_SW_MANIFEST };
            } catch (error) {
                await caches.delete(OVO_CACHE_NAME);
                throw error;
            }
        }
        // Old pages cannot acknowledge the new protocol. Bootstrap once; keep their shell pinned.
        if (!self.registration.active || !current.protocol) await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const previous = await readShell();
        const shell = ovoInstalledShell || { name: OVO_CACHE_NAME, manifest: OVO_SW_MANIFEST };
        const pages = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const state = await caches.open(OVO_STATE_CACHE);
        const liveKeys = new Set(pages.map(page => new URL(`__ovo_client_${page.id}__`, OVO_SCOPE).href));
        for (const key of await state.keys()) {
            if (key.url.startsWith(new URL('__ovo_client_', OVO_SCOPE).href) && !liveKeys.has(key.url)) await state.delete(key);
        }
        for (const page of pages.filter(page => page.url.startsWith(OVO_SCOPE))) {
            const key = new URL(`__ovo_client_${page.id}__`, OVO_SCOPE).href;
            if (!await state.match(key)) await state.put(key, new Response(JSON.stringify(previous)));
        }
        await writeShell({ ...shell, protocol: 2 });
        await clients.claim();
        const retained = new Set([shell.name, previous.name]);
        for (const page of pages) {
            const pin = await state.match(new URL(`__ovo_client_${page.id}__`, OVO_SCOPE).href);
            if (pin) retained.add((await pin.json()).name);
        }
        // Never delete another repository's caches or an in-progress pull.
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith(OVO_CACHE_PREFIX)
            && !retained.has(name) && !name.includes('-pull-')).map(name => caches.delete(name)));
    })());
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
        let shell = await readShell();
        const state = await caches.open(OVO_STATE_CACHE);
        if (request.mode === 'navigate' && event.resultingClientId) {
            await state.put(new URL(`__ovo_client_${event.resultingClientId}__`, OVO_SCOPE).href, new Response(JSON.stringify(shell)));
        } else if (event.clientId) {
            const pinned = await state.match(new URL(`__ovo_client_${event.clientId}__`, OVO_SCOPE).href);
            if (pinned) shell = await pinned.json();
        }
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
    event.waitUntil((async () => {
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
                try {
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
                    await caches.delete(name);
                    await state.delete(key);
                    throw error;
                } finally {
                    ovoPulls.delete(data.token);
                }
            } else if (data.type === 'OVO_UPDATE_DISCARD') {
                const running = ovoPulls.get(data.token);
                if (running && running.owner === event.source.id) running.controller.abort();
                const staged = await state.match(key);
                if (staged && (await staged.json()).owner === event.source.id) {
                    await caches.delete(name);
                    await state.delete(key);
                }
                port.postMessage({ type: 'done' });
            } else if (data.type === 'OVO_UPDATE_APPLY') {
                const staged = await state.match(key);
                if (!staged) throw new Error('拉取结果已失效，请重新拉取');
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
    })());
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
