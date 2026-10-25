/*
 * OvO realtime context adapter
 *
 * The adapter is opt-in per character.  It reuses the existing WeatherService
 * provider settings and leaves the legacy weather prompt untouched when the
 * character has not enabled realtimeContextEnabled.
 */
(function attachRealtimeContext(global) {
    'use strict';

    const Core = global.RealtimeContextCore;
    const CACHE_STORAGE_KEY = 'ovo_realtime_context_cache';
    const NEWS_CACHE_STORAGE_KEY = 'ovo_realtime_news_cache';
    const REVERSE_GEOCODE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

    function safeStorage(storage) {
        return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
            ? storage
            : null;
    }

    function getGlobalWeatherSettings() {
        const settings = global.db && global.db.weatherApiSettings;
        return settings && typeof settings === 'object' ? settings : {};
    }

    class RealtimeContextHub {
        constructor(options = {}) {
            this.weatherService = options.weatherService || global.WeatherService || null;
            this.storage = safeStorage(options.storage || global.localStorage);
            this.now = typeof options.now === 'function' ? options.now : () => Date.now();
            this.cache = {};
            this.newsCache = {};
            this.inflight = new Map();
            this.newsInflight = new Map();
            this.loadCache();
            this.loadNewsCache();
        }

        loadCache() {
            if (!this.storage) return;
            try {
                const saved = this.storage.getItem(CACHE_STORAGE_KEY);
                const parsed = saved ? JSON.parse(saved) : {};
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.cache = parsed;
            } catch (_) {
                this.cache = {};
            }
        }

        saveCache() {
            if (!this.storage) return;
            try {
                const entries = Object.entries(this.cache)
                    .sort(([, left], [, right]) => Number(right?.timestamp || 0) - Number(left?.timestamp || 0))
                    .slice(0, Core.MAX_CACHE_ENTRIES);
                this.cache = Object.fromEntries(entries);
                this.storage.setItem(CACHE_STORAGE_KEY, JSON.stringify(this.cache));
            } catch (_) {
                // Quota/private-mode failures must never block a chat request.
            }
        }

        loadNewsCache() {
            if (!this.storage) return;
            try {
                const saved = this.storage.getItem(NEWS_CACHE_STORAGE_KEY);
                const parsed = saved ? JSON.parse(saved) : {};
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.newsCache = parsed;
            } catch (_) {
                this.newsCache = {};
            }
        }

        saveNewsCache() {
            if (!this.storage) return;
            try {
                const entries = Object.entries(this.newsCache)
                    .sort(([, left], [, right]) => Number(right?.fetchedAt || 0) - Number(left?.fetchedAt || 0))
                    .slice(0, 24);
                this.newsCache = Object.fromEntries(entries);
                this.storage.setItem(NEWS_CACHE_STORAGE_KEY, JSON.stringify(this.newsCache));
            } catch (_) {
                // Quota/private-mode failures must not block ordinary chat.
            }
        }

        isEnabled(character) {
            return !!(character && (
                character.realtimeContextEnabled === true ||
                character.realtimeContext?.enabled === true
            ));
        }

        getTtl(character) {
            const minutes = character?.realtimeContext?.cacheMinutes;
            return Core.normalizeTtl(minutes);
        }

        getNewsSettings(character) {
            const settings = character?.realtimeContext;
            return settings && typeof settings === 'object' ? settings : {};
        }

        getNewsTimeZone(character) {
            try {
                const clock = global.VirtualClock?.resolveCharacter?.(character);
                return clock?.timeZone || character?.charTimezone || character?.timezone || '';
            } catch (_) {
                return character?.charTimezone || character?.timezone || '';
            }
        }

        resolveSource(character, scope) {
            const weatherSettings = character?.weatherSettings || {};
            const globalSettings = getGlobalWeatherSettings();
            if (scope === 'character' && weatherSettings.customApiEnabled) {
                return {
                    provider: weatherSettings.provider || 'openmeteo',
                    apiKey: weatherSettings.apiKey || '',
                };
            }
            return {
                provider: globalSettings.provider || 'openmeteo',
                apiKey: globalSettings.key || '',
            };
        }

        async fetchScopedWeather(scope, city, character) {
            if (!this.weatherService || (typeof this.weatherService.fetchWeather !== 'function' && typeof this.weatherService.fetchWeatherWithTrace !== 'function')) return null;
            const cleanCity = Core.text(city, 120);
            if (!cleanCity) return null;
            const displayCity = Core.locationLabel(cleanCity);
            const source = this.resolveSource(character, scope);
            const key = Core.cacheKey(scope, source.provider, cleanCity);
            const ttl = this.getTtl(character);
            const now = this.now();
            const cached = this.cache[key];
            if (Core.isFresh(cached, now, ttl)) return cached.data;
            if (this.inflight.has(key)) return this.inflight.get(key);

            const request = Promise.resolve()
                // The legacy service has a 24-hour cache.  Force refresh only
                // after this adapter's shorter scoped cache has expired.
                .then(async () => {
                    if (typeof this.weatherService.fetchWeatherWithTrace === 'function') {
                        return this.weatherService.fetchWeatherWithTrace(source.provider, cleanCity, source.apiKey, { forceRefresh: true });
                    }
                    const data = await this.weatherService.fetchWeather(source.provider, cleanCity, source.apiKey, { forceRefresh: true });
                    return { data, provider: source.provider, requestedProvider: source.provider, fallback: false };
                })
                .then(result => {
                    const raw = result?.data ?? result;
                    return {
                        data: Core.normalizeWeather(raw, {
                            city: displayCity,
                            provider: result?.provider || source.provider,
                            requestedProvider: result?.requestedProvider || source.provider,
                            source: 'weather-provider',
                            observedAt: this.now(),
                        }),
                        trace: {
                            scope,
                            city: displayCity,
                            requestedProvider: result?.requestedProvider || source.provider,
                            provider: result?.provider || source.provider,
                            fallback: result?.fallback === true,
                            fetchedAt: this.now(),
                            cacheExpiresAt: this.now() + ttl,
                        },
                    };
                })
                .then(result => {
                    const data = result.data;
                    if (data) {
                        this.cache[key] = { timestamp: result.trace.fetchedAt, data, trace: result.trace };
                        this.saveCache();
                    }
                    return result;
                })
                .catch(error => {
                    // Provider failures are an optional context failure, not a
                    // reason to interrupt ordinary chat generation.
                    console.warn('[RealtimeContext] weather provider failed:', error?.message || error);
                    return null;
                })
                .finally(() => this.inflight.delete(key));
            this.inflight.set(key, request);
            return request.then(result => result?.data || null);
        }

        async captureUserLocation(options = {}) {
            if (global.isSecureContext === false && !['http:', 'https:'].includes(global.location?.protocol)) throw new Error('浏览器只允许在 HTTPS 或本机地址使用定位；也可以直接手动填写城市');
            if (!global.navigator?.geolocation?.getCurrentPosition) throw new Error('当前浏览器不支持定位，请手动填写城市');
            let position;
            try {
                position = await new Promise((resolve, reject) => {
                    global.navigator.geolocation.getCurrentPosition(resolve, reject, {
                        enableHighAccuracy: options.enableHighAccuracy === true,
                        timeout: Math.min(30000, Math.max(3000, Number(options.timeout) || 10000)),
                        maximumAge: Math.max(0, Number(options.maximumAge) || 300000),
                    });
                });
            } catch (error) {
                const code = Number(error?.code);
                if (code === 1) throw new Error('定位权限被拒绝，请在浏览器站点设置中允许，或直接手动填写城市');
                if (code === 2) throw new Error('暂时无法获取设备位置，请检查定位服务，或直接手动填写城市');
                if (code === 3) throw new Error('定位请求超时，请稍后重试，或直接手动填写城市');
                throw new Error(error?.message ? `定位失败：${error.message}；也可以手动填写城市` : '定位失败，请手动填写城市');
            }
            const location = Core.normalizeLocationFix(position, { precision: 2, capturedAt: this.now() });
            if (!location) throw new Error('设备没有返回有效定位，请手动填写城市');
            return location;
        }

        /**
         * Resolve the rounded device snapshot to a region label. This follows
         * SullyOS's BigDataCloud path, but sends only the already rounded
         * coordinates and keeps the response in memory. A failed lookup is a
         * normal fallback: weather can still use the coordinate query.
         */
        async reverseGeocodeLocation(location, options = {}) {
            if (!location || !Core?.isLocationQuery?.(location.query) || typeof global.fetch !== 'function') return null;
            const safeLocation = Core.normalizeLocationFix?.(location, { precision: 2, capturedAt: location.capturedAt }) || null;
            if (!safeLocation) return null;
            const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
            const timeoutMs = Math.min(10000, Math.max(1000, Number(options.timeout) || 5000));
            const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
            try {
                const url = new URL(REVERSE_GEOCODE_URL);
                url.searchParams.set('latitude', String(safeLocation.latitude));
                url.searchParams.set('longitude', String(safeLocation.longitude));
                url.searchParams.set('localityLanguage', String(options.language || 'zh'));
                const response = await global.fetch(url.href, {
                    signal: controller?.signal,
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                if (!response?.ok) return null;
                const data = typeof response.json === 'function' ? await response.json() : null;
                const label = Core.reverseGeocodeLabel?.(data);
                return label ? { ...safeLocation, label, displayName: label, reverseGeocoded: true } : null;
            } catch (_) {
                return null;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        async resolveUserLocationLabel(location, options = {}) {
            const resolved = await this.reverseGeocodeLocation(location, options);
            return resolved || location;
        }

        async fetchHotNews(platforms) {
            if (typeof global.fetch !== 'function' || !Core?.HOTNEWS_API_BASE_URL) return [];
            const list = Core.resolveNewsPlatforms(platforms);
            const responses = await Promise.all(list.map(async platform => {
                try {
                    const response = await global.fetch(`${Core.HOTNEWS_API_BASE_URL}/?platform=${encodeURIComponent(platform)}`, {
                        headers: { Accept: 'application/json' },
                    });
                    if (!response?.ok) return [];
                    const raw = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
                    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
                    return Core.normalizeNewsList(items, Core.HOTNEWS_PLATFORM_LABELS[platform] || platform, 12);
                } catch (_) {
                    return [];
                }
            }));
            const merged = [];
            const limit = Math.max(...responses.map(items => items.length), 0);
            for (let index = 0; index < limit; index += 1) {
                for (const items of responses) if (items[index]) merged.push(items[index]);
            }
            return Core.normalizeNewsList(merged, '', 240);
        }

        /**
         * 无密钥的最终新闻回退。SullyOS 使用同一官方 Hacker News Firebase
         * API 作为热榜失败时的英文兜底；这里只取少量 story，避免把网络失败
         * 变成聊天阻塞，也不把 API 响应中的用户标识写入缓存。
         */
        async fetchBackupNews(options = {}) {
            if (typeof global.fetch !== 'function') return [];
            const limit = Math.min(10, Math.max(3, Number(options.limit) || 6));
            const timeoutMs = Math.min(10000, Math.max(1500, Number(options.timeout) || 5000));
            const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
            const readJson = async url => {
                const response = await global.fetch(url, {
                    signal: controller?.signal,
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                if (!response?.ok) return null;
                if (typeof response.json === 'function') return response.json();
                if (typeof response.text === 'function') return JSON.parse(await response.text());
                return null;
            };
            try {
                const ids = await readJson('https://hacker-news.firebaseio.com/v0/topstories.json');
                if (!Array.isArray(ids) || !ids.length) return [];
                const stories = await Promise.all(ids.slice(0, limit).map(id => readJson(`https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(id)}.json`)));
                return Core.normalizeNewsList(stories.map(story => {
                    if (!story || story.type !== 'story' || !story.title) return null;
                    const desc = String(story.text || '').replace(/<[^>]*>/g, ' ');
                    return { title: story.title, url: story.url, desc, source: 'Hacker News' };
                }).filter(Boolean), 'Hacker News', limit);
            } catch (_) {
                return [];
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        async getSlottedHotNews(character, options = {}) {
            const settings = this.getNewsSettings(character);
            if (settings.newsEnabled !== true) return [];
            const platforms = Core.resolveNewsPlatforms(settings.newsPlatforms);
            const slot = Core.getNewsSlot({ timeZone: this.getNewsTimeZone(character), now: options.now ?? this.now() });
            const key = `${slot.id}|${platforms.join(',')}`;
            const cached = this.newsCache[key];
            if (cached && Array.isArray(cached.items) && Core.sameNewsPlatforms(cached.platforms, platforms)) {
                return Core.normalizeNewsList(cached.items, '', 240);
            }
            if (this.newsInflight.has(key)) return this.newsInflight.get(key);
            const request = Promise.resolve()
                .then(() => this.fetchHotNews(platforms))
                .then(async items => {
                    let normalized = Core.normalizeNewsList(items, '', 240);
                    let source = 'hot-news';
                    if (!normalized.length) {
                        normalized = await this.fetchBackupNews();
                        source = normalized.length ? 'hacker-news-fallback' : '';
                    }
                    if (normalized.length) {
                        this.newsCache[key] = {
                            id: slot.id,
                            date: slot.date,
                            slot: slot.slot,
                            slotLabel: slot.label,
                            platforms,
                            fetchedAt: this.now(),
                            source,
                            fallback: source === 'hacker-news-fallback',
                            items: normalized,
                        };
                        this.saveNewsCache();
                        return normalized;
                    }
                    const fallback = Object.values(this.newsCache)
                        .filter(record => Array.isArray(record?.items) && Core.sameNewsPlatforms(record.platforms, platforms))
                        .sort((left, right) => Number(right.fetchedAt || 0) - Number(left.fetchedAt || 0))[0];
                    return fallback ? Core.normalizeNewsList(fallback.items, '', 240) : [];
                })
                .catch(() => [])
                .finally(() => this.newsInflight.delete(key));
            this.newsInflight.set(key, request);
            return request;
        }

        getWeatherTrace(character, scope = 'character') {
            const settings = character?.weatherSettings || {};
            const enabled = scope === 'character' ? settings.charEnabled : settings.userEnabled;
            const city = scope === 'character' ? settings.charCity : settings.userCity;
            if (!enabled || !city) return null;
            const source = this.resolveSource(character, scope);
            const record = this.cache[Core.cacheKey(scope, source.provider, city)];
            return record?.trace ? { ...record.trace } : null;
        }

        getWeatherSnapshot(character, scope = 'character') {
            const settings = character?.weatherSettings || {};
            const enabled = scope === 'character' ? settings.charEnabled : settings.userEnabled;
            const city = scope === 'character' ? settings.charCity : settings.userCity;
            if (!enabled || !city) return null;
            const source = this.resolveSource(character, scope);
            const record = this.cache[Core.cacheKey(scope, source.provider, city)];
            if (!record?.data || !record.trace) return null;
            return { weather: { ...record.data }, trace: { ...record.trace } };
        }

        /** 主动读取一次角色/用户天气，供日程等后续模块复用同一份带来源快照。 */
        async fetchWeatherSnapshot(character, scope = 'character', options = {}) {
            const settings = character?.weatherSettings || {};
            const enabled = scope === 'character' ? settings.charEnabled : settings.userEnabled;
            const city = scope === 'character' ? settings.charCity : settings.userCity;
            if (!enabled || !city) return null;
            const source = this.resolveSource(character, scope);
            const key = Core.cacheKey(scope, source.provider, city);
            if (options.forceRefresh === true) delete this.cache[key];
            await this.fetchScopedWeather(scope, city, character);
            return this.getWeatherSnapshot(character, scope);
        }

        async getPrompt(character) {
            if (!this.isEnabled(character) || !Core) return '';
            const settings = character.weatherSettings || {};
            const requests = [];
            if (settings.charEnabled && settings.charCity) {
                requests.push(this.fetchScopedWeather('character', settings.charCity, character));
            } else {
                requests.push(Promise.resolve(null));
            }
            if (settings.userEnabled && settings.userCity) {
                requests.push(this.fetchScopedWeather('user', settings.userCity, character));
            } else {
                requests.push(Promise.resolve(null));
            }
            const [roleWeather, userWeather] = await Promise.all(requests);
            const news = await this.getSlottedHotNews(character);
            return Core.renderRealtimeContext({
                roleCity: settings.charCity,
                roleWeather,
                userCity: settings.userCity,
                userWeather,
                news,
            });
        }

        clearCache() {
            this.cache = {};
            this.inflight.clear();
            this.newsCache = {};
            this.newsInflight.clear();
            if (this.storage) {
                try { this.storage.removeItem(CACHE_STORAGE_KEY); } catch (_) { /* optional */ }
                try { this.storage.removeItem(NEWS_CACHE_STORAGE_KEY); } catch (_) { /* optional */ }
            }
        }

        getCacheStats() {
            const entries = Object.values(this.cache);
            return {
                entries: entries.length,
                fresh: entries.filter(entry => Core.isFresh(entry, this.now(), Core.DEFAULT_TTL_MS)).length,
                newsSnapshots: Object.keys(this.newsCache).length,
            };
        }
    }

    global.RealtimeContextHub = new RealtimeContextHub();
    global.RealtimeContextHubClass = RealtimeContextHub;
})(typeof window !== 'undefined' ? window : globalThis);
