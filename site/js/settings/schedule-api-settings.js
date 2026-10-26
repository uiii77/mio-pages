(function attachScheduleApiSettings(global) {
    'use strict';
    const $ = id => document.getElementById(id);
    const ID = 'schedule-default';

    function load() {
        if (!global.FeatureApiRegistry || !$('schedule-api-enabled')) return;
        const registry = global.FeatureApiRegistry.readRegistry(db);
        const route = registry.routes.schedule || {};
        const config = registry.configs[route.configId] || {};
        $('schedule-api-enabled').checked = route.enabled === true;
        $('schedule-api-url').value = config.url || config.baseUrl || '';
        $('schedule-api-key').value = config.key || config.apiKey || '';
        $('schedule-api-model').value = config.model || '';
        $('schedule-api-fallback').checked = route.fallbackMode === 'main';
    }

    async function save() {
        const next=global.FeatureApiSettings.saveRegistryFeature(global.FeatureApiRegistry.readRegistry(db),'schedule','schedule-api',ID);
        await global.FeatureApiSettings.persistRegistry(next);
        $('schedule-api-status').textContent='设置已保存；关闭专属配置时继承主 API';
    }

    function setup() {
        if (!$('schedule-api-save-btn')) return;
        load();
        global.FeatureApiSettings.mount('schedule','schedule-api',ID);
        $('schedule-api-save-btn').addEventListener('click', () => void save().catch(error=>{ $('schedule-api-status').textContent=error.message; }));
    }
    global.setupScheduleApiSettings = setup;
})(typeof window !== 'undefined' ? window : globalThis);
