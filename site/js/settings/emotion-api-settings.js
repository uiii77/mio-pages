(function attachEmotionApiSettings(global) {
    'use strict';
    const $ = id => document.getElementById(id);
    const ID = 'emotion-default';

    function load() {
        if (!global.FeatureApiRegistry || !$('emotion-api-enabled')) return;
        const registry = global.FeatureApiRegistry.readRegistry(global.db);
        const route = registry.routes.emotion || {};
        const config = registry.configs[route.configId] || {};
        $('emotion-api-enabled').checked = route.enabled === true;
        $('emotion-api-url').value = config.url || config.baseUrl || '';
        $('emotion-api-key').value = config.key || config.apiKey || '';
        $('emotion-api-model').value = config.model || '';
        $('emotion-api-fallback').checked = route.fallbackMode === 'main';
    }

    async function save() {
        let registry = global.FeatureApiRegistry.readRegistry(global.db);
        const config = {
            id: ID, name: '角色情绪', feature: 'emotion', service: 'llm', provider: 'newapi',
            url: $('emotion-api-url').value.trim(), key: $('emotion-api-key').value.trim(),
            model: $('emotion-api-model').value.trim(), enabled: true,
        };
        if (config.url || config.key || config.model) registry = global.FeatureApiRegistry.upsertConfig(registry, config, ID);
        registry = global.FeatureApiRegistry.setRoute(registry, 'emotion', {
            enabled: $('emotion-api-enabled').checked,
            configId: ID,
            fallbackMode: $('emotion-api-fallback').checked ? 'main' : 'none',
        });
        global.db.apiFeatureRegistry = registry;
        await global.saveGlobalSettings(['apiFeatureRegistry']);
        if ($('emotion-api-status')) $('emotion-api-status').textContent = '角色情绪 API 设置已保存；未配置时不会调用。';
        global.showToast?.('角色情绪 API 设置已保存');
    }

    function setup() {
        if (!$('emotion-api-save-btn')) return;
        load();
        $('emotion-api-save-btn').addEventListener('click', () => void save());
    }
    global.setupEmotionApiSettings = setup;
})(typeof window !== 'undefined' ? window : globalThis);
