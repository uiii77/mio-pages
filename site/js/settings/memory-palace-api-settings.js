(function attachMemoryPalaceApiSettings(global) {
    'use strict';
    const $ = id => document.getElementById(id);
    const IDS = { memoryProcess: 'memory-process-default', rerank: 'memory-rerank-default', lifeExpansion: 'life-expansion-default', lifeSource: 'life-source-default' };

    function loadFeature(feature, prefix) {
        const registry = global.FeatureApiRegistry?.readRegistry(db) || { configs: {}, routes: {} };
        const route = registry.routes[feature] || {};
        const config = registry.configs[route.configId] || {};
        $(`${prefix}-enabled`).checked = route.enabled === true;
        $(`${prefix}-url`).value = config.url || config.baseUrl || '';
        $(`${prefix}-key`).value = config.key || config.apiKey || '';
        $(`${prefix}-model`).value = config.model || '';
        if (feature === 'lifeSource' && $(`${prefix}-network`)) $(`${prefix}-network`).checked = config.allowNetwork === true;
        if (feature === 'memoryProcess') $('memory-process-api-fallback').checked = route.fallbackMode === 'main';
    }

    function saveFeature(registry, feature, prefix) {
        if (['memoryProcess','lifeExpansion','rerank'].includes(feature)) return global.FeatureApiSettings.saveRegistryFeature(registry,feature,prefix,IDS[feature]);
        const enabled = $(`${prefix}-enabled`).checked;
        const config = { id: IDS[feature], name: feature === 'rerank' ? '记忆 Rerank' : (feature === 'lifeExpansion' ? '生活资料整理' : (feature === 'lifeSource' ? '生活资料来源核验' : '记忆处理')), feature, service: feature === 'rerank' ? 'rerank' : (feature === 'lifeSource' ? 'source' : 'llm'), provider: 'newapi', url: $(`${prefix}-url`).value.trim(), key: $(`${prefix}-key`).value.trim(), model: $(`${prefix}-model`).value.trim(), enabled: true };
        if (feature === 'lifeSource') config.allowNetwork = $(`${prefix}-network`)?.checked === true;
        if (config.url || config.key || config.model) registry = global.FeatureApiRegistry.upsertConfig(registry, config, config.id);
        registry = global.FeatureApiRegistry.setRoute(registry, feature, { enabled, configId: config.id, fallbackMode: feature === 'memoryProcess' && $('memory-process-api-fallback').checked ? 'main' : 'none' });
        return registry;
    }

    function setup() {
        if (!$('memory-palace-api-save-btn') || !global.FeatureApiRegistry) return;
        loadFeature('memoryProcess', 'memory-process-api');
        loadFeature('rerank', 'memory-rerank-api');
        loadFeature('lifeExpansion', 'life-expansion-api');
        loadFeature('lifeSource', 'life-source-api');
        global.FeatureApiSettings.mount('memoryProcess','memory-process-api',IDS.memoryProcess);
        global.FeatureApiSettings.mount('lifeExpansion','life-expansion-api',IDS.lifeExpansion);
        global.FeatureApiSettings.mount('rerank','memory-rerank-api',IDS.rerank);
        $('memory-palace-api-save-btn').addEventListener('click', async () => {
            try {
            let registry = global.FeatureApiRegistry.readRegistry(db);
            registry = saveFeature(registry, 'memoryProcess', 'memory-process-api');
            registry = saveFeature(registry, 'rerank', 'memory-rerank-api');
            registry = saveFeature(registry, 'lifeExpansion', 'life-expansion-api');
            registry = saveFeature(registry, 'lifeSource', 'life-source-api');
            await global.FeatureApiSettings.persistRegistry(registry);
            $('memory-palace-api-status').textContent = '记忆处理、Rerank、资料整理与来源核验路由已保存';
            showToast('记忆 API 设置已保存');
            } catch(error) {$('memory-palace-api-status').textContent=error.message;showToast(error.message);}
        });
    }
    global.setupMemoryPalaceApiSettings = setup;
})(typeof window !== 'undefined' ? window : globalThis);
