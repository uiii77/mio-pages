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
        let registry = global.FeatureApiRegistry.readRegistry(db);
        const config = {
            id: ID, name: '角色日程', feature: 'schedule', service: 'llm', provider: 'newapi',
            url: $('schedule-api-url').value.trim(), key: $('schedule-api-key').value.trim(),
            model: $('schedule-api-model').value.trim(), enabled: true,
        };
        if (config.url || config.key || config.model) registry = global.FeatureApiRegistry.upsertConfig(registry, config, ID);
        registry = global.FeatureApiRegistry.setRoute(registry, 'schedule', {
            enabled: $('schedule-api-enabled').checked,
            configId: ID,
            fallbackMode: $('schedule-api-fallback').checked ? 'main' : 'none',
        });
        db.apiFeatureRegistry = registry;
        await saveGlobalSettings(['apiFeatureRegistry']);
        if ($('schedule-api-status')) $('schedule-api-status').textContent = '角色日程 API 设置已保存；未配置时不会调用。';
        global.showToast?.('角色日程 API 设置已保存');
    }

    function setup() {
        if (!$('schedule-api-save-btn')) return;
        load();
        $('schedule-api-save-btn').addEventListener('click', () => void save());
    }
    global.setupScheduleApiSettings = setup;
})(typeof window !== 'undefined' ? window : globalThis);
