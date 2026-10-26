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
        const next=global.FeatureApiSettings.saveRegistryFeature(global.FeatureApiRegistry.readRegistry(db),'emotion','emotion-api',ID);
        await global.FeatureApiSettings.persistRegistry(next);
        $('emotion-api-status').textContent='设置已保存；关闭专属配置时继承主 API';
    }

    function setup() {
        if (!$('emotion-api-save-btn')) return;
        load();
        global.FeatureApiSettings.mount('emotion','emotion-api',ID);
        $('emotion-api-save-btn').addEventListener('click', () => void save().catch(error=>{ $('emotion-api-status').textContent=error.message; }));
    }
    global.setupEmotionApiSettings = setup;
})(typeof window !== 'undefined' ? window : globalThis);
