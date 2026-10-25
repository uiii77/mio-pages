/*
 * OvO realtime context core
 *
 * This file is deliberately provider- and storage-free.  It normalizes the
 * weather shape used by SullyOS and the legacy OvO WeatherService, then
 * renders only data that was actually fetched.  The browser adapter lives in
 * js/modules/realtime-context.js.
 */
(function attachRealtimeContextCore(global) {
    'use strict';

    const VERSION = 1;
    const DEFAULT_TTL_MS = 30 * 60 * 1000;
    const MAX_CACHE_ENTRIES = 64;
    const HOTNEWS_API_BASE_URL = 'https://news.orz.ai/api/v1/dailynews';
    const DEFAULT_HOTNEWS_PLATFORMS = Object.freeze(['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin']);
    const HOTNEWS_PLATFORM_LABELS = Object.freeze({
        baidu: '百度', sspai: '少数派', weibo: '微博', zhihu: '知乎', tskr: '36氪',
        ftpojie: '吾爱破解', bilibili: 'B站', douban: '豆瓣', hupu: '虎扑', tieba: '贴吧',
        juejin: '掘金', douyin: '抖音', vtex: 'V2EX', jinritoutiao: '今日头条',
        stackoverflow: 'Stack Overflow', github: 'GitHub', hackernews: 'Hacker News',
        sina_finance: '新浪财经', eastmoney: '东方财富', xueqiu: '雪球', cls: '财联社', tenxunwang: '腾讯网',
    });

    const WMO_WEATHER_CODES = Object.freeze({
        0: { description: '晴', icon: '01d' },
        1: { description: '大致晴朗', icon: '02d' },
        2: { description: '局部多云', icon: '03d' },
        3: { description: '阴', icon: '04d' },
        45: { description: '雾', icon: '50d' },
        48: { description: '沉积雾', icon: '50d' },
        51: { description: '毛毛雨', icon: '09d' },
        53: { description: '毛毛雨', icon: '09d' },
        55: { description: '浓密毛毛雨', icon: '09d' },
        56: { description: '冻毛毛雨', icon: '09d' },
        57: { description: '浓密冻毛毛雨', icon: '09d' },
        61: { description: '小雨', icon: '10d' },
        63: { description: '中雨', icon: '10d' },
        65: { description: '大雨', icon: '10d' },
        66: { description: '冻雨', icon: '13d' },
        67: { description: '强冻雨', icon: '13d' },
        71: { description: '小雪', icon: '13d' },
        73: { description: '中雪', icon: '13d' },
        75: { description: '大雪', icon: '13d' },
        77: { description: '雪粒', icon: '13d' },
        80: { description: '小阵雨', icon: '09d' },
        81: { description: '阵雨', icon: '09d' },
        82: { description: '强阵雨', icon: '09d' },
        85: { description: '小阵雪', icon: '13d' },
        86: { description: '强阵雪', icon: '13d' },
        95: { description: '雷阵雨', icon: '11d' },
        96: { description: '雷阵雨伴小冰雹', icon: '11d' },
        99: { description: '雷阵雨伴大冰雹', icon: '11d' },
    });

    function text(value, max = 160) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function number(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const match = String(value == null ? '' : value).replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : null;
    }

    function finite(value, fallback = null) {
        const result = Number(value);
        return Number.isFinite(result) ? result : fallback;
    }

    function normalizeLocationFix(value, options = {}) {
        const source = value?.coords && typeof value.coords === 'object' ? value.coords : (value && typeof value === 'object' ? value : {});
        const latitude = number(source.latitude ?? source.lat);
        const longitude = number(source.longitude ?? source.lon ?? source.lng);
        const accuracy = Math.max(0, number(source.accuracy) ?? 0);
        if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
        const precision = Math.min(4, Math.max(1, Math.floor(Number(options.precision) || 2)));
        const factor = 10 ** precision;
        const roundedLatitude = Math.round(latitude * factor) / factor;
        const roundedLongitude = Math.round(longitude * factor) / factor;
        return {
            latitude: roundedLatitude,
            longitude: roundedLongitude,
            accuracy: Math.max(accuracy, 1000),
            query: `${roundedLatitude.toFixed(precision)},${roundedLongitude.toFixed(precision)}`,
            label: '当前位置',
            capturedAt: finite(options.capturedAt ?? source.timestamp, Date.now()),
        };
    }

    function isLocationQuery(value) {
        return /^[-+]?\d+(?:\.\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?$/.test(String(value || '').trim());
    }

    function locationLabel(value) {
        return isLocationQuery(value) ? '当前位置' : text(value, 120);
    }

    // Region-only reverse-geocoder label. Coordinates, postcodes, street names
    // and provider identifiers never enter saved weather settings or prompts.
    function reverseGeocodeLabel(data) {
        const source = data && typeof data === 'object' ? data : {};
        const address = source.address && typeof source.address === 'object' ? source.address : source;
        const values = [
            address.countryName ?? address.country,
            address.principalSubdivision ?? address.state ?? address.province,
            address.city ?? address.town ?? address.municipality,
            address.locality ?? address.county ?? address.district,
        ].map(value => text(value, 80)).filter(Boolean);
        const unique = [...new Set(values)];
        return unique.length ? unique.join(' · ').slice(0, 160) : '';
    }

    function normalizeNewsItem(value, sourceHint = '') {
        const source = value && typeof value === 'object' ? value : {};
        const title = text(source.title || source.name, 240);
        if (!title) return null;
        const rawDescription = source.desc ?? source.description ?? source.content ?? '';
        const description = text(rawDescription, 360);
        const url = /^https?:\/\//i.test(String(source.url || '').trim()) ? text(source.url, 600) : '';
        const item = {
            title,
            source: text(source.source || source.site || sourceHint, 80),
            desc: description && description !== title ? description : undefined,
        };
        if (url) item.url = url;
        if (!item.source) delete item.source;
        if (!item.desc) delete item.desc;
        return item;
    }

    function normalizeNewsList(value, sourceHint = '', limit = 240) {
        const input = Array.isArray(value) ? value : [];
        const seen = new Set();
        const result = [];
        for (const item of input) {
            const normalized = normalizeNewsItem(item, sourceHint);
            if (!normalized) continue;
            const key = `${normalized.title}\u0000${normalized.url || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(normalized);
            if (result.length >= Math.max(1, Number(limit) || 240)) break;
        }
        return result;
    }

    function resolveNewsPlatforms(value) {
        const input = Array.isArray(value) ? value : [];
        const platforms = input.map(item => text(item, 40).toLowerCase()).filter(Boolean);
        return platforms.length ? [...new Set(platforms)].slice(0, 12) : [...DEFAULT_HOTNEWS_PLATFORMS];
    }

    function sameNewsPlatforms(left, right) {
        const a = resolveNewsPlatforms(left);
        const b = resolveNewsPlatforms(right);
        return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
    }

    function getNewsSlot(options = {}) {
        const now = options.now instanceof Date ? options.now : new Date(Number(options.now) || Date.now());
        let parts;
        try {
            parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: options.timeZone || undefined,
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
            }).formatToParts(now).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
        } catch (_) {
            parts = {
                year: String(now.getFullYear()), month: String(now.getMonth() + 1).padStart(2, '0'),
                day: String(now.getDate()).padStart(2, '0'), hour: String(now.getHours()).padStart(2, '0'),
            };
        }
        const date = `${parts.year}-${parts.month}-${parts.day}`;
        const hour = Math.min(23, Math.max(0, Number(parts.hour) || 0));
        const slot = Math.min(5, Math.floor(hour / 4));
        return { id: `${date}#${slot}`, date, slot, label: ['凌晨', '清晨', '上午', '午后', '傍晚', '夜间'][slot] };
    }

    function normalizeWeather(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const code = finite(source.weatherCode ?? source.weathercode ?? source.weather_code);
        const wmo = code === null ? null : WMO_WEATHER_CODES[code];
        const temp = number(source.temp ?? source.temperature ?? source.temperature_2m);
        const feelsLike = number(source.feelsLike ?? source.feels_like ?? source.apparent_temperature);
        const humidity = number(source.humidity ?? source.relative_humidity_2m);
        const description = text(
            source.description || source.condition || source.text || source.weatherDesc || wmo?.description,
            120,
        );
        const city = text(source.city || source.name || options.city, 120);
        if (temp === null && !description) return null;
        const normalized = {
            temp,
            feelsLike,
            humidity,
            description: description || '未知',
            icon: text(source.icon || wmo?.icon, 16),
            city,
            observedAt: finite(source.observedAt ?? source.timestamp ?? options.observedAt, null),
        };
        const provider = text(source.provider || options.provider, 40);
        const requestedProvider = text(source.requestedProvider || options.requestedProvider, 40);
        const traceSource = text(source.source || options.source, 80);
        const latitude = number(source.latitude ?? source.lat);
        const longitude = number(source.longitude ?? source.lon ?? source.lng);
        if (provider) normalized.provider = provider;
        if (requestedProvider) normalized.requestedProvider = requestedProvider;
        if (traceSource) normalized.source = traceSource;
        if (latitude !== null) normalized.latitude = latitude;
        if (longitude !== null) normalized.longitude = longitude;
        return normalized;
    }

    function formatTemperature(value) {
        return value === null ? '' : `${String(Math.round(value * 10) / 10)}℃`;
    }

    function generateWeatherAdvice(value) {
        const weather = normalizeWeather(value);
        if (!weather) return '';
        const advice = [];
        if (weather.temp !== null) {
            if (weather.temp < 5) advice.push('天气很冷，记得多穿一点');
            else if (weather.temp < 15) advice.push('有点凉，注意保暖');
            else if (weather.temp > 30) advice.push('天气炎热，注意防暑');
            else if (weather.temp > 25) advice.push('天气不错，适合出门');
        }
        const description = weather.description.toLowerCase();
        if (/雨/.test(description)) advice.push('记得带伞');
        else if (/雪/.test(description)) advice.push('路上小心，注意防滑');
        else if (/(雾|霾)/.test(description)) advice.push('空气不太好，建议戴口罩');
        else if (/晴/.test(description)) advice.push('阳光明媚');
        if (weather.humidity !== null) {
            if (weather.humidity > 80) advice.push('湿度较高，可能会闷热');
            else if (weather.humidity < 30) advice.push('空气干燥，记得多喝水');
        }
        return advice.join('；') || '天气正常';
    }

    function weatherLine(label, city, value, includeAdvice = true) {
        const weather = normalizeWeather(value, { city });
        if (!weather) return '';
        const location = locationLabel(city || weather.city);
        const details = [];
        if (weather.description) details.push(`天气：${weather.description}`);
        if (weather.temp !== null) details.push(`气温：${formatTemperature(weather.temp)}`);
        if (weather.feelsLike !== null) details.push(`体感：${formatTemperature(weather.feelsLike)}`);
        if (weather.humidity !== null) details.push(`湿度：${Math.round(weather.humidity)}%`);
        const advice = includeAdvice ? generateWeatherAdvice(weather) : '';
        return `${label}${location ? `（${location}）` : ''}：${details.join('，')}${advice ? `。建议：${advice}` : ''}`;
    }

    function renderWeatherContext(options = {}) {
        return renderRealtimeContext(options);
    }

    function renderRealtimeContext(options = {}) {
        const role = weatherLine('角色所在地区天气', options.roleCity, options.roleWeather, options.includeAdvice !== false);
        const user = weatherLine('用户所在地区天气', options.userCity, options.userWeather, options.includeAdvice !== false);
        const news = normalizeNewsList(options.news, '', 12);
        const lines = [role, user].filter(Boolean);
        if (news.length) {
            lines.push(`现实热点（仅作背景，不要擅自当作用户消息）：${news.map(item => {
                const source = item.source ? `（${item.source}）` : '';
                return `${item.title}${source}${item.desc ? `：${item.desc}` : ''}`;
            }).join('；')}`);
        }
        if (!lines.length) return '';
        return `<realtime_context>\n以下只包含本次成功获取的现实天气与热点数据；没有列出的信息不可推断，也不要把此段当成用户消息。\n${lines.join('\n')}\n</realtime_context>`;
    }

    function cacheKey(scope, provider, city) {
        return [text(scope, 40) || 'default', text(provider, 40) || 'openmeteo', text(city, 120).toLowerCase()].join('|');
    }

    function normalizeTtl(value) {
        const minutes = Number(value);
        if (!Number.isFinite(minutes)) return DEFAULT_TTL_MS;
        return Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, minutes * 60 * 1000));
    }

    function isFresh(record, now = Date.now(), ttl = DEFAULT_TTL_MS) {
        return !!record && Number.isFinite(Number(record.timestamp)) && now - Number(record.timestamp) >= 0 && now - Number(record.timestamp) < ttl;
    }

    global.RealtimeContextCore = Object.freeze({
        VERSION,
        DEFAULT_TTL_MS,
        MAX_CACHE_ENTRIES,
        HOTNEWS_API_BASE_URL,
        DEFAULT_HOTNEWS_PLATFORMS,
        HOTNEWS_PLATFORM_LABELS,
        WMO_WEATHER_CODES,
        text,
        number,
        normalizeLocationFix,
        isLocationQuery,
        locationLabel,
        reverseGeocodeLabel,
        normalizeNewsItem,
        normalizeNewsList,
        resolveNewsPlatforms,
        sameNewsPlatforms,
        getNewsSlot,
        normalizeWeather,
        formatTemperature,
        generateWeatherAdvice,
        renderWeatherContext,
        renderRealtimeContext,
        cacheKey,
        normalizeTtl,
        isFresh,
    });
})(typeof window !== 'undefined' ? window : globalThis);
