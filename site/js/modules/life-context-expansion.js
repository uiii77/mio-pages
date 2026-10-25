(function attachLifeContextExpansion(global) {
    'use strict';

    const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
    const MAX_CANDIDATES = 24;
    const MAX_EVIDENCE = 6;
    const MAX_EVIDENCE_CHARS = 720;

    function core() { return global.LifeContextCore; }
    function storage() { return global.LifeContextStorage; }
    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }
    function clean(value, max = 1800) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
    function list(value, max = 16) {
        const values = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
        return [...new Set(values.map(item => clean(item, 120)).filter(Boolean))].slice(0, max);
    }
    function configFrom(value) {
        if (!value || typeof value !== 'object' || value.enabled !== true) return null;
        const config = clone(value);
        config.url = String(config.url || config.baseUrl || '').trim();
        config.baseUrl = config.baseUrl || config.url;
        config.key = config.key || config.apiKey || '';
        config.model = String(config.model || '').trim();
        config.timeoutMs = Math.max(5000, Math.min(30000, Number(config.timeoutMs) || 30000));
        return config.url && config.model ? config : null;
    }

    function resolveConfig(character, options = {}) {
        const explicit = configFrom(options.config);
        if (explicit) return explicit;
        if (global.FeatureApiRegistry) {
            const resolved = global.FeatureApiRegistry.resolve('lifeExpansion', { context: character });
            const configured = configFrom(resolved?.configured ? resolved.config : null);
            if (configured) return configured;
        }
        return configFrom(character?.lifeContextExpansionConfig);
    }

    function normalizeQuery(pack, value = {}) {
        const manifest = pack?.manifest || pack || {};
        const query = value && typeof value === 'object' ? value : {};
        return {
            date: query.date || manifest.dateRange?.from || '',
            regions: list(query.regions?.length ? query.regions : manifest.regions),
            cultures: list(query.cultures?.length ? query.cultures : manifest.cultures),
            domains: list(query.domains?.length ? query.domains : manifest.domains, 16),
            keywords: list(query.keywords, 24),
            tags: list(query.tags, 24),
            includeUnreviewed: false,
        };
    }

    function analyzeGaps(chunks, queryValue = {}) {
        const query = queryValue && typeof queryValue === 'object' ? queryValue : {};
        const normalized = core().normalizeLifeQuery({ ...query, includeUnreviewed: false, limit: 50 });
        const all = Array.isArray(chunks) ? chunks : [];
        const eligible = all.filter(item => core().isLifeChunkEligible(item, normalized));
        const retrieved = core().retrieveLifeChunks(all, normalized, { limit: 50 });
        const matching = retrieved.results || [];
        const missingDimensions = [];
        if (normalized.date && !eligible.some(item => core().rangeOverlaps(item.dateRange, normalized.date))) missingDimensions.push('date');
        if (normalized.regions.length && !eligible.some(item => (item.regions || []).some(value => normalized.regions.some(wanted => String(value).toLowerCase() === String(wanted).toLowerCase())))) missingDimensions.push('region');
        if (normalized.cultures.length && !eligible.some(item => (item.cultures || []).some(value => normalized.cultures.some(wanted => String(value).toLowerCase() === String(wanted).toLowerCase())))) missingDimensions.push('culture');
        if (normalized.domains.length && !eligible.some(item => (item.domains || []).some(value => normalized.domains.some(wanted => String(value).toLowerCase() === String(wanted).toLowerCase())))) missingDimensions.push('domain');
        const reasons = [];
        if (!eligible.length) reasons.push('no-approved-evidence');
        if (eligible.length && normalized.keywords.length && !matching.length) reasons.push('no-keyword-evidence');
        if (missingDimensions.length) reasons.push('missing-scope-dimension');
        const gapKey = core().stableHash(JSON.stringify({ date: normalized.date, regions: normalized.regions, cultures: normalized.cultures, domains: normalized.domains, keywords: normalized.keywords, missingDimensions }));
        return {
            gapKey, query: normalized, eligibleCount: eligible.length, matchingCount: matching.length,
            missingDimensions, reasons, hasGap: reasons.length > 0,
            evidence: eligible.slice(0, MAX_EVIDENCE).map(item => core().normalizeLifeChunk(item)),
        };
    }

    function parseCandidates(value) {
        let source = value;
        if (source && typeof source === 'object' && typeof source.content === 'string') source = source.content;
        if (typeof source === 'string') {
            const text = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            try { source = JSON.parse(text); } catch (_) {
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start < 0 || end <= start) return [];
                try { source = JSON.parse(text.slice(start, end + 1)); } catch (__) { return []; }
            }
        }
        const rows = Array.isArray(source) ? source : (Array.isArray(source?.candidates) ? source.candidates : (Array.isArray(source?.data?.candidates) ? source.data.candidates : []));
        return rows.slice(0, MAX_CANDIDATES).map(item => {
            const row = item && typeof item === 'object' ? item : {};
            return {
                title: clean(row.title || row.name, 160), text: clean(row.text || row.content, 1800), kind: clean(row.kind || 'fact', 48),
                tags: list(row.tags, 24), sourceIds: list(row.sourceIds || row.sourceId, 12),
                dateRange: row.dateRange && typeof row.dateRange === 'object' ? { from: clean(row.dateRange.from, 20), to: clean(row.dateRange.to, 20) } : { from: '', to: '' },
                regions: list(row.regions), cultures: list(row.cultures), domains: list(row.domains, 16),
                citation: clean(row.citation, 1000), sourceUrl: clean(row.sourceUrl || row.url, 800), needsSource: row.needsSource !== false,
            };
        }).filter(item => item.text || item.title);
    }

    function buildPrompt(pack, gaps) {
        const manifest = pack?.manifest || pack || {};
        const scope = [gaps.query.date && `日期 ${gaps.query.date}`, ...gaps.query.regions.map(item => `地区 ${item}`), ...gaps.query.cultures.map(item => `文化 ${item}`), ...gaps.query.domains.map(item => `领域 ${item}`), ...gaps.query.keywords.map(item => `主题 ${item}`)].filter(Boolean).join('；');
        const evidence = (gaps.evidence || []).map((item, index) => `[${index + 1}] ${clean(item.text, MAX_EVIDENCE_CHARS)}`).join('\n');
        return `你是 Mio 的生活资料整理助手。仅为资料缺口生成“待审核候选”，不能把推测写成确定事实。资料包：${clean(manifest.name || manifest.id, 160)}。目标范围：${scope || '未限定'}。缺口：${gaps.reasons.join(', ') || '补充同范围资料'}。以下是本地已有的已核对/有来源片段，只能据此理解范围，不能伪造出处：\n${evidence || '（没有可用证据，请明确标记需要来源）'}\n请只返回 JSON：{"candidates":[{"title":"","text":"","kind":"food|clothing|activity|fact","tags":[],"citation":"","sourceUrl":"","dateRange":{"from":"","to":""},"regions":[],"cultures":[],"domains":[],"needsSource":true}]}。每条候选都必须保守、短小；没有可靠依据时 needsSource 必须为 true，citation/sourceUrl 留空。`;
    }

    function withTimeout(task, milliseconds) {
        let timer;
        return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('life expansion timeout')), milliseconds); })]).finally(() => clearTimeout(timer));
    }

    async function requestCandidates(config, prompt, options = {}) {
        if (typeof options.provider === 'function') return withTimeout(() => options.provider({ config: clone(config), prompt }), config.timeoutMs);
        if (typeof global.fetchAiResponse !== 'function') throw new Error('life expansion API unavailable');
        const endpoint = global.getApiConfigEndpoint ? global.getApiConfigEndpoint(config, false) : `${config.url.replace(/\/$/, '')}/v1/chat/completions`;
        const headers = global.getApiConfigHeaders ? global.getApiConfigHeaders(config) : { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) };
        return withTimeout(() => global.fetchAiResponse(config, { model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, stream: false }, headers, endpoint, false), config.timeoutMs);
    }

    async function expand(packId, query = {}, options = {}) {
        const pack = await storage()?.getPack?.(packId);
        if (!pack) return { success: false, error: 'life pack not found' };
        const gaps = analyzeGaps(pack.chunks || [], normalizeQuery(pack, query));
        if (!gaps.hasGap) return { success: false, skipped: true, reason: 'covered', gaps };
        const state = pack.manifest?.lifeExpansionState || pack.lifeExpansionState || {};
        const cooldownMs = Math.max(0, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS);
        if (options.force !== true && Number(state.lastRequestedAt) > 0 && Date.now() - Number(state.lastRequestedAt) < cooldownMs) return { success: false, skipped: true, reason: 'cooldown', gaps, retryAt: Number(state.lastRequestedAt) + cooldownMs };
        const config = resolveConfig(options.character, options);
        if (!config) return { success: false, skipped: true, reason: 'not-configured', gaps };
        let raw;
        try {
            raw = await requestCandidates(config, buildPrompt(pack, gaps), options);
        } catch (error) {
            return { success: false, skipped: true, reason: 'api-error', error: clean(error?.message || error, 240), gaps };
        }
        const candidates = parseCandidates(raw);
        if (!candidates.length) return { success: false, skipped: true, reason: 'empty-response', gaps };
        const saved = await storage().saveExpansionCandidates(packId, candidates, { gapKey: gaps.gapKey, requestedAt: Date.now() });
        return { ...saved, success: saved.success === true, gaps, candidates: saved.added || [] };
    }

    global.LifeContextExpansion = Object.freeze({ VERSION: 1, analyzeGaps, parseCandidates, resolveConfig, buildPrompt, expand });
}(typeof window !== 'undefined' ? window : globalThis));
