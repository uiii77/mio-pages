(function attachLifeContextSourceProvider(global) {
    'use strict';

    const DEFAULT_TIMEOUT = 20000;
    const MAX_CARDS = 24;
    const STATUSES = new Set(['unverified', 'verified', 'conflict', 'skipped']);

    function storage() { return global.LifeContextStorage; }
    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }
    function clean(value, max = 1200) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
    function configFrom(value) {
        if (!value || typeof value !== 'object' || value.enabled !== true) return null;
        const config = clone(value);
        config.url = String(config.url || config.baseUrl || '').trim();
        config.key = config.key || config.apiKey || '';
        config.model = String(config.model || '').trim();
        config.allowNetwork = config.allowNetwork === true;
        config.timeoutMs = Math.max(3000, Math.min(30000, Number(config.timeoutMs) || DEFAULT_TIMEOUT));
        return config.url ? config : null;
    }
    function resolveConfig(character, options = {}) {
        const explicit = configFrom(options.config);
        if (explicit) return explicit;
        if (global.FeatureApiRegistry) {
            const resolved = global.FeatureApiRegistry.resolve('lifeSource', { context: character });
            const configured = configFrom(resolved?.configured ? resolved.config : null);
            if (configured) return configured;
        }
        return configFrom(character?.lifeContextSourceConfig);
    }
    function parseResults(value) {
        let source = value;
        if (source && typeof source === 'object' && typeof source.content === 'string') source = source.content;
        if (typeof source === 'string') {
            const text = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            try { source = JSON.parse(text); } catch (_) {
                const start = text.indexOf('{'); const end = text.lastIndexOf('}');
                if (start < 0 || end <= start) return [];
                try { source = JSON.parse(text.slice(start, end + 1)); } catch (__) { return []; }
            }
        }
        const rows = Array.isArray(source) ? source : (Array.isArray(source?.results) ? source.results : (Array.isArray(source?.data?.results) ? source.data.results : []));
        return rows.slice(0, MAX_CARDS).map(item => {
            const row = item && typeof item === 'object' ? item : {};
            const status = String(row.verificationStatus || row.status || '').toLowerCase();
            return {
                cardId: clean(row.cardId || row.id, 160),
                verificationStatus: STATUSES.has(status) ? status : 'unverified',
                citation: clean(row.citation, 1000), sourceUrl: clean(row.sourceUrl || row.url, 800),
                quote: clean(row.quote || row.evidence, 1200), notes: clean(row.notes || row.reason, 1000),
                provider: clean(row.provider, 120), checkedAt: Number(row.checkedAt) || Date.now(),
            };
        }).filter(item => item.cardId);
    }
    function withTimeout(task, milliseconds) {
        let timer;
        return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('life source verification timeout')), milliseconds); })]).finally(() => clearTimeout(timer));
    }
    function requestBody(pack, cards) {
        const manifest = pack?.manifest || pack || {};
        return {
            operation: 'verify-life-candidates',
            scope: { dateRange: manifest.dateRange || {}, regions: manifest.regions || [], cultures: manifest.cultures || [], domains: manifest.domains || [] },
            candidates: cards.map(card => ({ id: card.id, title: card.title, text: card.text, kind: card.kind, dateRange: card.dateRange, regions: card.regions, cultures: card.cultures, domains: card.domains, citation: card.citation, sourceUrl: card.sourceUrl })),
        };
    }

    function sourcePolicy(pack) {
        const policy = pack?.manifest?.sourcePolicy || pack?.sourcePolicy || {};
        return {
            requireHttps: policy.requireHttps !== false,
            allowedHosts: (Array.isArray(policy.allowedHosts) ? policy.allowedHosts : []).map(item => String(item || '').trim().toLowerCase()).filter(Boolean).slice(0, 24),
            cacheTtlMs: Math.max(3600000, Math.min(2592000000, Number(policy.cacheTtlMs) || 86400000)),
        };
    }

    function allowedSourceUrl(value, policy) {
        let url;
        try { url = new URL(String(value || '')); } catch (_) { return false; }
        if (policy.requireHttps && url.protocol !== 'https:') return false;
        if (!['https:', 'http:'].includes(url.protocol)) return false;
        if (!policy.allowedHosts.length) return false;
        const host = url.hostname.toLowerCase();
        return policy.allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed.replace(/^\.+/, '')}`));
    }

    function parseRefresh(value) {
        let source = value;
        if (source && typeof source === 'object' && typeof source.content === 'string') source = source.content;
        if (typeof source === 'string') {
            const text = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            try { source = JSON.parse(text); } catch (_) {
                const start = text.indexOf('{'); const end = text.lastIndexOf('}');
                if (start < 0 || end <= start) return { sources: [], cards: [] };
                try { source = JSON.parse(text.slice(start, end + 1)); } catch (__) { return { sources: [], cards: [] }; }
            }
        }
        const data = source?.data && typeof source.data === 'object' ? source.data : source || {};
        return { sources: Array.isArray(data.sources) ? data.sources.slice(0, 24) : [], cards: Array.isArray(data.cards) ? data.cards.slice(0, 24) : [], subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [] };
    }

    function normalizeRefreshResult(value, pack, subscriptions) {
        const policy = sourcePolicy(pack);
        const parsed = parseRefresh(value);
        const selectedIds = new Set(subscriptions.map(item => String(item.id)));
        const sources = parsed.sources.map((item, index) => {
            const row = item && typeof item === 'object' ? item : {};
            const url = String(row.sourceUrl || row.url || row.uri || '').trim();
            if (!allowedSourceUrl(url, policy)) return null;
            return { ...row, id: row.id || `web:${global.LifeContextCore?.stableHash?.(url) || index}`, uri: url, citation: row.citation || url, sourceUrl: url, subscriptionId: row.subscriptionId && selectedIds.has(String(row.subscriptionId)) ? row.subscriptionId : subscriptions[0]?.id };
        }).filter(Boolean);
        const sourcesByUrl = new Set(sources.map(item => item.uri));
        const cards = parsed.cards.map((item, index) => {
            const row = item && typeof item === 'object' ? item : {};
            const url = String(row.sourceUrl || row.url || '').trim();
            if (!url || !allowedSourceUrl(url, policy) || !sourcesByUrl.has(url)) return null;
            return { ...row, id: row.id || `web-card:${global.LifeContextCore?.stableHash?.(`${url}|${row.text || row.title || index}`) || index}`, sourceUrl: url, citation: row.citation || url, sourceSubscriptionId: row.sourceSubscriptionId || sources.find(source => source.uri === url)?.subscriptionId };
        }).filter(Boolean);
        return { sources, cards, subscriptions: parsed.subscriptions };
    }

    function refreshBody(pack, subscriptions) {
        const manifest = pack?.manifest || pack || {};
        return {
            operation: 'refresh-life-sources',
            scope: { dateRange: manifest.dateRange || {}, regions: manifest.regions || [], cultures: manifest.cultures || [], domains: manifest.domains || [] },
            subscriptions: subscriptions.map(item => ({ id: item.id, url: item.url, title: item.title, etag: item.etag, lastModified: item.lastModified })),
            policy: sourcePolicy(pack),
        };
    }

    async function requestRefresh(config, body, options = {}) {
        if (typeof options.provider === 'function') return withTimeout(() => options.provider({ config: clone(config), body: clone(body) }), config.timeoutMs);
        if (typeof global.fetch !== 'function') throw new Error('life source network provider unavailable');
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
        try {
            const response = await global.fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) }, body: JSON.stringify({ model: config.model, ...body }), ...(controller ? { signal: controller.signal } : {}) });
            if (!response.ok) throw new Error(`life source network provider ${response.status}`);
            return await response.json();
        } finally { if (timer) clearTimeout(timer); }
    }
    async function requestProvider(config, body, options = {}) {
        if (typeof options.provider === 'function') return withTimeout(() => options.provider({ config: clone(config), body: clone(body) }), config.timeoutMs);
        if (typeof global.fetch !== 'function') throw new Error('life source provider unavailable');
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
        try {
            const response = await global.fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) }, body: JSON.stringify(body), ...(controller ? { signal: controller.signal } : {}) });
            if (!response.ok) throw new Error(`life source provider ${response.status}`);
            return await response.json();
        } finally { if (timer) clearTimeout(timer); }
    }
    async function verify(packId, options = {}) {
        const pack = await storage()?.getPack?.(packId);
        if (!pack) return { success: false, error: 'life pack not found' };
        const all = (pack.manifest?.cards || pack.cards || []).filter(Boolean);
        const selected = Array.isArray(options.cardIds) && options.cardIds.length
            ? all.filter(card => options.cardIds.map(String).includes(String(card.id)))
            : all.filter(card => options.includeApproved === true || ['unreviewed', 'source-backed'].includes(card.reviewStatus));
        if (!selected.length) return { success: false, skipped: true, reason: 'no-pending-cards' };
        const config = resolveConfig(options.character, options);
        if (!config) return { success: false, skipped: true, reason: 'not-configured' };
        let raw;
        try { raw = await requestProvider(config, requestBody(pack, selected.slice(0, MAX_CARDS)), options); }
        catch (error) { return { success: false, skipped: true, reason: 'provider-error', error: clean(error?.message || error, 240) }; }
        const results = parseResults(raw);
        if (!results.length) return { success: false, skipped: true, reason: 'empty-response' };
        const saved = await storage().applyCardVerification(packId, results, { provider: config.provider || 'source-provider', checkedAt: Date.now() });
        return { ...saved, results: saved.updated || [], success: saved.success === true };
    }

    async function refresh(packId, options = {}) {
        const pack = await storage()?.getPack?.(packId);
        if (!pack) return { success: false, error: 'life pack not found' };
        const config = resolveConfig(options.character, options);
        if (!config) return { success: false, skipped: true, reason: 'not-configured' };
        if (config.allowNetwork !== true && options.allowNetwork !== true) return { success: false, skipped: true, reason: 'network-disabled' };
        const policy = sourcePolicy(pack);
        if (!policy.allowedHosts.length) return { success: false, skipped: true, reason: 'no-allowlist' };
        const all = (pack.manifest?.sourceSubscriptions || pack.sourceSubscriptions || []).filter(item => item && item.enabled !== false && item.state === 'active' && item.url);
        const requested = Array.isArray(options.subscriptionIds) && options.subscriptionIds.length ? new Set(options.subscriptionIds.map(String)) : null;
        const now = Date.now();
        const selected = all.filter(item => (!requested || requested.has(String(item.id))) && (options.force === true || !item.lastCheckedAt || now - Number(item.lastCheckedAt) >= Math.min(policy.cacheTtlMs, Number(item.intervalMs) || policy.cacheTtlMs)));
        if (!selected.length) return { success: false, skipped: true, reason: 'cache-fresh' };
        if (selected.some(item => !allowedSourceUrl(item.url, policy))) return { success: false, skipped: true, reason: 'subscription-not-allowlisted' };
        let raw;
        try { raw = await requestRefresh(config, refreshBody(pack, selected), options); }
        catch (error) {
            const failed = selected.map(item => ({ ...item, lastCheckedAt: now, lastStatus: 'error', lastError: clean(error?.message || error, 240) }));
            await storage().saveNetworkRefresh(packId, {}, { checkedAt: now, status: 'error', error: failed[0]?.lastError, subscriptions: failed });
            return { success: false, skipped: true, reason: 'provider-error', error: failed[0]?.lastError };
        }
        const parsed = parseRefresh(raw);
        const responseSubscriptions = new Map(parsed.subscriptions.map(item => [String(item?.id || ''), item]));
        const updates = selected.map(item => {
            const response = responseSubscriptions.get(String(item.id)) || {};
            return { ...item, lastCheckedAt: now, lastStatus: 'success', lastError: '', etag: clean(response.etag || item.etag, 240), lastModified: clean(response.lastModified || item.lastModified, 120) };
        });
        const normalized = normalizeRefreshResult(parsed, pack, selected);
        const result = await storage().saveNetworkRefresh(packId, normalized, { checkedAt: now, status: 'success', subscriptions: updates });
        return { ...result, success: result.success === true, acceptedSources: normalized.sources.length, acceptedCards: normalized.cards.length, rejectedByPolicy: (parsed.sources.length - normalized.sources.length) + (parsed.cards.length - normalized.cards.length) };
    }

    global.LifeContextSourceProvider = Object.freeze({ VERSION: 2, resolveConfig, parseResults, requestBody, verify, sourcePolicy, allowedSourceUrl, parseRefresh, refresh });
}(typeof window !== 'undefined' ? window : globalThis));
