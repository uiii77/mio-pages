// 独立 AI 功能的配置注册表。
//
// 这里保存的只是“功能 -> 全局配置”的解析规则。角色/群记录只允许保存
// configId、开关和参数覆盖，不保存 API Key；现有聊天节点路由仍由
// RoleApiBindings 负责，未注册的旧功能不会经过本模块。
(function () {
    const VERSION = 1;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const INDEPENDENT_DEFINITIONS = Object.freeze({
        memoryProcess: { label: '记忆处理', kind: 'llm', scope: 'character', fallback: 'none' },
        lifeExpansion: { label: '生活资料整理', kind: 'llm', scope: 'global', fallback: 'none' },
        lifeSource: { label: '生活资料来源核验', kind: 'source', scope: 'global', fallback: 'none' },
        embedding: { label: 'Embedding', kind: 'embedding', scope: 'global', fallback: 'none' },
        rerank: { label: 'Rerank', kind: 'rerank', scope: 'global', fallback: 'none' },
        schedule: { label: '角色日程', kind: 'llm', scope: 'character', fallback: 'none' },
        emotion: { label: '角色情绪', kind: 'llm', scope: 'character', fallback: 'none' },
        exchangeDiary: { label: '交换日记', kind: 'llm', scope: 'global', fallback: 'none' },
        trpg: { label: 'TRPG', kind: 'llm', scope: 'global', fallback: 'none' },
        coupleSpace: { label: '情侣空间', kind: 'llm', scope: 'global', fallback: 'none' },
        collaboration: { label: '协同工作', kind: 'llm', scope: 'character', fallback: 'none' },
        reading: { label: '角色共读', kind: 'llm', scope: 'character', fallback: 'none' },
        watchTogether: { label: '一起看电影', kind: 'llm', scope: 'character', fallback: 'none' },
        stt: { label: '语音转文字', kind: 'stt', scope: 'global', fallback: 'none' }
    });
    const FALLBACK_MODES = new Set(['none', 'main']);
    const SAFE_OVERRIDE_KEYS = new Set([
        'provider', 'protocol', 'model', 'url', 'baseUrl', 'endpoint', 'dimensions', 'topN',
        'temperature', 'stream', 'streamEnabled', 'timeoutMs'
    ]);

    function definitions() {
        const legacy = typeof API_NODE_FEATURES === 'object' && API_NODE_FEATURES
            ? Object.fromEntries(Object.entries(API_NODE_FEATURES).map(([id, label]) => [id, {
                label, kind: 'legacy-node', scope: 'existing', fallback: 'legacy'
            }])) : {};
        return { ...legacy, ...clone(INDEPENDENT_DEFINITIONS) };
    }

    function isIndependent(feature) {
        return Object.prototype.hasOwnProperty.call(INDEPENDENT_DEFINITIONS, feature);
    }

    function normalizeId(value) {
        const id = String(value || '').trim();
        return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) ? id : '';
    }

    function normalizeConfig(value, id, definition) {
        if (!value || typeof value !== 'object') return null;
        const normalized = clone(value);
        normalized.id = normalizeId(id || normalized.id);
        if (!normalized.id) return null;
        normalized.service = normalized.service || definition?.kind || 'llm';
        normalized.enabled = normalized.enabled !== false;
        if (!normalized.url && normalized.baseUrl) normalized.url = normalized.baseUrl;
        if (!normalized.baseUrl && normalized.url) normalized.baseUrl = normalized.url;
        if (!normalized.key && normalized.apiKey) normalized.key = normalized.apiKey;
        if (!normalized.apiKey && normalized.key) normalized.apiKey = normalized.key;
        normalized.name = String(normalized.name || normalized.id).trim() || normalized.id;
        return normalized;
    }

    function normalizeRoute(value, feature) {
        const source = value && typeof value === 'object' ? value : {};
        const result = {
            feature,
            enabled: source.enabled === true,
            configId: normalizeId(source.configId || source.primaryConfigId),
            fallbackMode: FALLBACK_MODES.has(source.fallbackMode) ? source.fallbackMode : 'none'
        };
        if (source.parameterOverrides && typeof source.parameterOverrides === 'object') {
            result.parameterOverrides = clone(source.parameterOverrides);
        }
        return result;
    }

    function normalizeOverrides(value) {
        if (!value || typeof value !== 'object') return undefined;
        const result = {};
        Object.entries(value).forEach(([key, item]) => {
            if (SAFE_OVERRIDE_KEYS.has(key) && item !== undefined) result[key] = clone(item);
        });
        return Object.keys(result).length ? result : undefined;
    }

    function normalizeBinding(value, source = 'character', ownerId = '') {
        if (!value || typeof value !== 'object') return null;
        return {
            enabled: value.enabled !== false,
            configId: normalizeId(value.configId || value.primaryConfigId),
            fallbackMode: FALLBACK_MODES.has(value.fallbackMode) ? value.fallbackMode : 'none',
            parameterOverrides: normalizeOverrides(value.parameterOverrides),
            source, ownerId: ownerId || ''
        };
    }

    function normalizeRegistry(value) {
        const source = value && typeof value === 'object' ? value : {};
        const result = { schemaVersion: VERSION, configs: {}, routes: {} };
        Object.entries(source.configs || {}).forEach(([id, config]) => {
            const normalized = normalizeConfig(config, id, INDEPENDENT_DEFINITIONS[config?.feature]);
            if (normalized) result.configs[normalized.id] = normalized;
        });
        Object.entries(source.routes || {}).forEach(([feature, route]) => {
            if (!isIndependent(feature)) return;
            result.routes[feature] = normalizeRoute(route, feature);
        });
        return result;
    }

    function emptyRegistry() {
        return { schemaVersion: VERSION, configs: {}, routes: {} };
    }

    function readRegistry(state) {
        const source = state?.configs && state?.routes
            ? state
            : state?.apiFeatureRegistry || (typeof db !== 'undefined' ? db.apiFeatureRegistry : null);
        return normalizeRegistry(source);
    }

    function ownerCandidates(context) {
        if (!context) return [];
        if (context.member || context.character || context.chat) {
            const candidates = [];
            if (context.member) candidates.push(context.member);
            const character = context.character || (context.member && typeof db !== 'undefined'
                ? (db.characters || []).find(item => item.id === context.member.originalCharId) : null);
            if (character) candidates.push(character);
            return candidates;
        }
        return [context];
    }

    function pickBinding(context, feature) {
        const candidates = ownerCandidates(context);
        for (const owner of candidates) {
            const source = owner?.featureApiBindings || owner?.apiFeatureBindings;
            const value = source?.[feature];
            if (value && typeof value === 'object') {
                const binding = normalizeBinding(value, owner === candidates[0] && context?.member ? 'member' : 'character', owner.id || '');
                return binding;
            }
        }
        return null;
    }

    function applyOverrides(config, overrides) {
        if (!overrides || typeof overrides !== 'object') return clone(config);
        const result = clone(config);
        Object.entries(overrides).forEach(([key, value]) => {
            if (SAFE_OVERRIDE_KEYS.has(key) && value !== undefined) result[key] = clone(value);
        });
        if (result.url && !result.baseUrl) result.baseUrl = result.url;
        if (result.baseUrl && !result.url) result.url = result.baseUrl;
        return result;
    }

    function unavailable(feature, reason, source = 'none', extra = {}) {
        return { feature, enabled: false, configured: false, source, reason, config: null, ...extra };
    }

    function resolveIndependent(feature, options = {}) {
        const definition = INDEPENDENT_DEFINITIONS[feature];
        if (!definition) return unavailable(feature, 'unknown-feature');
        const registry = normalizeRegistry(options.registry || options.state || (typeof db !== 'undefined' ? db : null));
        const binding = pickBinding(options.context, feature);
        const route = binding || registry.routes[feature] || null;
        if (route && route.enabled === false) return unavailable(feature, 'disabled', binding ? binding.source : 'global');
        if (!route) return unavailable(feature, 'not-configured');
        const config = registry.configs[route.configId];
        if (!config || config.enabled === false) {
            if (route.fallbackMode === 'main' && options.fallbackConfig) {
                return { feature, kind: definition.kind, enabled: true, configured: true, source: 'main-fallback',
                    config: clone(options.fallbackConfig), fallback: true, configId: '' };
            }
            return unavailable(feature, config ? 'config-disabled' : 'config-missing', route.source || 'global', {
                configId: route.configId || ''
            });
        }
        const resolved = applyOverrides(config, route.parameterOverrides);
        return {
            feature, kind: definition.kind, enabled: true, configured: true,
            source: route.source || (binding ? binding.source : 'global'), ownerId: route.ownerId || '',
            configId: config.id, fallback: false, config: resolved
        };
    }

    function resolve(feature, options = {}) {
        if (isIndependent(feature)) return resolveIndependent(feature, options);
        const fallback = options.fallbackConfig;
        let config = null;
        if (typeof getApiConfigForFeature === 'function') {
            config = getApiConfigForFeature(feature, fallback, options.context);
        } else if (fallback) {
            config = clone(fallback);
        }
        return config ? { feature, kind: 'legacy-node', enabled: true, configured: true, source: 'legacy-route', fallback: config === fallback, config } : unavailable(feature, 'legacy-route-unavailable');
    }

    function setRoute(registry, feature, route) {
        const result = normalizeRegistry(registry);
        if (!isIndependent(feature)) return result;
        const normalized = normalizeRoute(route, feature);
        if (!normalized.configId && !normalized.enabled) delete result.routes[feature];
        else result.routes[feature] = normalized;
        return result;
    }

    function upsertConfig(registry, config, id) {
        const result = normalizeRegistry(registry);
        const normalized = normalizeConfig(config, id, INDEPENDENT_DEFINITIONS[config?.feature]);
        if (!normalized) throw new Error('API 配置需要有效的 configId');
        result.configs[normalized.id] = normalized;
        return result;
    }

    function removeConfig(registry, id) {
        const result = normalizeRegistry(registry);
        const configId = normalizeId(id);
        if (!configId) return result;
        delete result.configs[configId];
        Object.keys(result.routes).forEach(feature => {
            if (result.routes[feature].configId === configId) result.routes[feature].enabled = false;
        });
        return result;
    }

    function describe(result) {
        const config = result?.config || {};
        return {
            feature: result?.feature || '', source: result?.source || '', configId: result?.configId || '',
            model: config.model || '', url: config.url || config.baseUrl || '',
            fallback: result?.fallback === true, configured: result?.configured === true,
            reason: result?.reason || ''
        };
    }

    window.FeatureApiRegistry = {
        VERSION, definitions, independentDefinitions: () => clone(INDEPENDENT_DEFINITIONS), isIndependent,
        emptyRegistry, normalizeRegistry, normalizeConfig, normalizeRoute, normalizeBinding, readRegistry,
        resolve, resolveIndependent, setRoute, upsertConfig, removeConfig, describe, clone
    };
})();
