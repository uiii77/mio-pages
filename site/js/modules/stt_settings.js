(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const STTSettings = {
        init() {
            if (!window.RecordedAudioService) return;
            this.load();
            byId('stt-mode')?.addEventListener('change', () => this.refreshVisibility());
            byId('save-stt-config-btn')?.addEventListener('click', () => this.save());
        },
        load() {
            const cfg = RecordedAudioService.loadConfig();
            if (byId('stt-mode')) byId('stt-mode').value = cfg.mode || 'auto';
            if (byId('stt-language')) byId('stt-language').value = cfg.language || 'zh-CN';
            if (byId('stt-cloud-enabled')) byId('stt-cloud-enabled').checked = cfg.cloudEnabled === true;
            if (byId('stt-cloud-authorized')) byId('stt-cloud-authorized').checked = cfg.cloudAuthorized === true;
            if (byId('stt-cloud-url')) byId('stt-cloud-url').value = cfg.cloudUrl || '';
            if (byId('stt-cloud-api-key')) byId('stt-cloud-api-key').value = cfg.cloudApiKey || '';
            if (byId('stt-cloud-model')) byId('stt-cloud-model').value = cfg.cloudModel || '';
            this.refreshVisibility();
        },
        refreshVisibility() {
            const mode = byId('stt-mode')?.value || 'auto';
            const wrap = byId('stt-cloud-config-wrap');
            if (wrap) wrap.style.display = mode === 'browser' ? 'none' : 'block';
            const status = byId('stt-browser-status');
            if (status) status.textContent = RecordedAudioService.browserSupported() ? '当前浏览器支持实时识别' : '当前浏览器不支持实时识别；自动模式可回退云端';
        },
        save() {
            try {
                const cfg = {
                    mode: byId('stt-mode')?.value || 'auto',
                    language: byId('stt-language')?.value || 'zh-CN',
                    cloudEnabled: byId('stt-cloud-enabled')?.checked === true,
                    cloudAuthorized: byId('stt-cloud-authorized')?.checked === true,
                    cloudUrl: byId('stt-cloud-url')?.value?.trim() || '',
                    cloudApiKey: byId('stt-cloud-api-key')?.value?.trim() || '',
                    cloudModel: byId('stt-cloud-model')?.value?.trim() || ''
                };
                if (cfg.mode === 'cloud' && !(cfg.cloudEnabled && cfg.cloudAuthorized && cfg.cloudUrl && cfg.cloudApiKey && cfg.cloudModel)) {
                    showToast('仅云端模式需要完整配置并勾选授权'); return false;
                }
                if (cfg.cloudUrl) {
                    const url = new URL(cfg.cloudUrl);
                    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址无效');
                }
                RecordedAudioService.saveConfig(cfg);
                showToast('STT 配置已保存');
                return true;
            } catch (error) {
                showToast('STT 配置保存失败：' + error.message);
                return false;
            }
        }
    };
    window.STTSettings = STTSettings;
    document.addEventListener('DOMContentLoaded', () => STTSettings.init());
})();
