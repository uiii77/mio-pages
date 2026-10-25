(function attachLifeContextRetrieval(global) {
    'use strict';

    const Core = global.LifeContextCore;
    const adapters = Object.create(null);
    const DEFAULT_TIMEOUT = 8000;
    const MAX_CANDIDATES = 16;
    const MAX_TEXT_CHARS = 1000;

    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function normalizeConfig(value) {
        if (!value || typeof value !== 'object' || value.enabled !== true) return null;
        const config = clone(value);
        config.url = String(config.url || config.baseUrl || '').trim();
        config.baseUrl = config.baseUrl || config.url;
        config.key = config.key || config.apiKey || '';
        config.model = String(config.model || '').trim();
        config.timeoutMs = Math.max(1000, Math.min(30000, Number(config.timeoutMs) || DEFAULT_TIMEOUT));
        return config;
    }

    function resolveConfig(kind, character, options = {}) {
        const explicit = normalizeConfig(options[`${kind}Config`]);
        if (explicit) return explicit;
        const feature = kind === 'embedding' ? 'embedding' : 'rerank';
        if (global.FeatureApiRegistry) {
            const result = global.FeatureApiRegistry.resolve(feature, { context: character });
            if (result?.configured && result.config) {
                const config = normalizeConfig(result.config);
                if (config) return config;
            }
        }
        return normalizeConfig(character?.[`lifeContext${kind[0].toUpperCase()}${kind.slice(1)}Config`]);
    }

    function getAdapter(kind, options = {}) {
        if (typeof options[`${kind}Adapter`] === 'function') return options[`${kind}Adapter`];
        if (typeof adapters[kind] === 'function') return adapters[kind];
        if (kind === 'embedding' && typeof global.VectorMemoryEmbedding?.fetchEmbeddings === 'function') {
            return global.VectorMemoryEmbedding.fetchEmbeddings;
        }
        return null;
    }

    async function applyRerank(config, query, results, options) {
        const adapter = getAdapter('rerank', options);
        return adapter ? adapter(query, results, config) : requestRerank(config, query, results);
    }

    function queryText(query = {}) {
        if (typeof query === 'string') return query.slice(0, MAX_TEXT_CHARS);
        return [query.queryText, query.date, ...(query.domains || []), ...(query.regions || []), ...(query.keywords || []), ...(query.tags || [])]
            .filter(Boolean).join(' ').slice(0, MAX_TEXT_CHARS);
    }

    function withTimeout(task, milliseconds) {
        let timer;
        return Promise.race([
            Promise.resolve().then(task),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('life-context retrieval timeout')), milliseconds); }),
        ]).finally(() => clearTimeout(timer));
    }

    function cosine(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
        let dot = 0; let normLeft = 0; let normRight = 0;
        left.forEach((value, index) => {
            const a = Number(value) || 0; const b = Number(right[index]) || 0;
            dot += a * b; normLeft += a * a; normRight += b * b;
        });
        return normLeft && normRight ? dot / (Math.sqrt(normLeft) * Math.sqrt(normRight)) : 0;
    }

    function lexicalRankScore(index, count) {
        return count <= 1 ? 1 : 1 - (index / count);
    }

    function mergeEmbeddingResults(base, vectors) {
        const queryVector = vectors[0];
        if (!Array.isArray(queryVector) || !queryVector.length) throw new Error('empty query embedding');
        const count = base.results.length;
        const scored = base.results.map((item, index) => {
            const semantic = Array.isArray(vectors[index + 1]) ? (cosine(queryVector, vectors[index + 1]) + 1) / 2 : 0;
            const lexical = lexicalRankScore(index, count);
            return { ...item, lexicalScore: item.score, semanticScore: semantic, score: semantic * 0.65 + lexical * 0.35 };
        });
        scored.sort((a, b) => b.score - a.score || String(a.chunk?.id || '').localeCompare(String(b.chunk?.id || '')));
        return scored;
    }

    async function requestRerank(config, query, results) {
        if (!config?.url || !config.model || !results.length || typeof global.fetch !== 'function') throw new Error('rerank config unavailable');
        const base = config.url.replace(/\/$/, '');
        const endpoint = /\/rerank$/i.test(base) ? base : `${base}/rerank`;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
        try {
            const response = await global.fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
                body: JSON.stringify({ model: config.model, query: queryText(query), documents: results.map(item => item.chunk?.text || ''), top_n: results.length }),
                ...(controller ? { signal: controller.signal } : {}),
            });
            if (!response.ok) throw new Error(`Rerank API ${response.status}`);
            const data = await response.json();
            const ranked = Array.isArray(data?.results) ? data.results : (Array.isArray(data?.data) ? data.data : []);
            const mapped = ranked.map(item => {
                const index = Number(item?.index ?? item?.document_index);
                return Number.isInteger(index) && results[index]
                    ? { ...results[index], rerankScore: Number(item.relevance_score ?? item.score) || 0 }
                    : null;
            }).filter(Boolean);
            const used = new Set(mapped.map(item => item.chunk?.id));
            return mapped.concat(results.filter(item => !used.has(item.chunk?.id)));
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function retrieve(chunks, query, options = {}) {
        const candidateLimit = Math.max(1, Math.min(MAX_CANDIDATES, Number(options.candidateLimit) || MAX_CANDIDATES));
        const base = Core.retrieveLifeChunks(chunks, query, { ...(options.localOptions || {}), limit: candidateLimit });
        const result = { ...base, mode: 'lexical', enhancement: { embedding: 'disabled', rerank: 'disabled' } };
        if (!base.results.length) return result;

        const embeddingConfig = resolveConfig('embedding', options.character, options);
        const embeddingAdapter = getAdapter('embedding', options);
        if (embeddingConfig && embeddingAdapter && options.enableEmbedding !== false) {
            try {
                const texts = [queryText(query), ...base.results.map(item => String(item.chunk?.text || '').slice(0, MAX_TEXT_CHARS))];
                const vectors = await withTimeout(() => embeddingAdapter(texts, embeddingConfig), embeddingConfig.timeoutMs);
                if (!Array.isArray(vectors) || vectors.length < texts.length) throw new Error('embedding response length mismatch');
                result.results = mergeEmbeddingResults(base, vectors);
                result.mode = 'hybrid';
                result.enhancement.embedding = 'applied';
            } catch (error) {
                result.enhancement.embedding = 'fallback';
                result.enhancement.embeddingError = String(error?.message || error).slice(0, 160);
            }
        }

        const rerankConfig = resolveConfig('rerank', options.character, options);
        if (rerankConfig && options.enableRerank !== false) {
            try {
                result.results = await applyRerank(rerankConfig, query, result.results, options);
                result.mode = result.mode === 'hybrid' ? 'hybrid-rerank' : 'rerank';
                result.enhancement.rerank = 'applied';
            } catch (error) {
                result.enhancement.rerank = 'fallback';
                result.enhancement.rerankError = String(error?.message || error).slice(0, 160);
            }
        }
        return result;
    }

    function registerAdapter(kind, adapter) {
        if (!['embedding', 'rerank'].includes(kind)) throw new Error('unsupported life-context retrieval adapter');
        if (adapter != null && typeof adapter !== 'function') throw new TypeError('adapter must be a function');
        if (adapter) adapters[kind] = adapter; else delete adapters[kind];
    }

    global.LifeContextRetrieval = Object.freeze({ VERSION: 1, normalizeConfig, resolveConfig, retrieve, registerAdapter, cosine });
}(typeof window !== 'undefined' ? window : globalThis));
