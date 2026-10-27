// Shared microphone recording and STT service for chat and calls.
(function (global) {
    'use strict';

    const STORAGE_KEY = 'ovo_stt_config';
    const DEFAULTS = {
        mode: 'auto',
        language: 'zh-CN',
        cloudEnabled: false,
        cloudAuthorized: false,
        cloudUrl: '',
        cloudApiKey: '',
        cloudModel: '',
        maxDurationSeconds: 120
    };
    let config = { ...DEFAULTS };
    let currentPlayback = null;

    function loadConfig() {
        try { config = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; } catch (_) { config = { ...DEFAULTS }; }
        return { ...config };
    }

    function saveConfig(next) {
        const mode = ['auto', 'browser', 'cloud'].includes(next?.mode) ? next.mode : 'auto';
        config = { ...config, ...next, mode };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        return true;
    }

    function browserSupported() {
        return !!(global.SpeechRecognition || global.webkitSpeechRecognition);
    }

    function cloudConfigured(cfg = config) {
        return !!(cfg.cloudEnabled && cfg.cloudAuthorized && cfg.cloudUrl && cfg.cloudApiKey && cfg.cloudModel);
    }

    function friendlyError(raw) {
        const value = String(raw || '');
        if (/not-allowed|denied|permission/i.test(value)) return '麦克风权限被拒绝，请在系统设置中允许访问';
        if (/no-speech/i.test(value)) return '没有识别到语音';
        if (/network/i.test(value)) return '浏览器语音识别服务无法连接';
        if (/aborted/i.test(value)) return '';
        return value || '语音识别失败';
    }

    function pickMimeType() {
        const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
        return candidates.find(type => global.MediaRecorder?.isTypeSupported?.(type)) || '';
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('录音读取失败'));
            reader.readAsDataURL(blob);
        });
    }

    function startBrowserRecognition(language, callbacks, state) {
        const Ctor = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!Ctor) throw new Error('当前浏览器不支持实时语音识别');
        const recognition = new Ctor();
        recognition.lang = language || 'zh-CN';
        recognition.interimResults = true;
        recognition.continuous = true;
        recognition.maxAlternatives = 1;
        let finalText = '';
        recognition.onresult = event => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) finalText += result[0].transcript;
                else interim += result[0].transcript;
            }
            state.browserText = (finalText + interim).trim();
            callbacks.onPartial?.(state.browserText);
        };
        recognition.onerror = event => {
            state.browserError = friendlyError(event?.error);
            callbacks.onBrowserError?.(state.browserError);
        };
        recognition.onend = () => { state.browserEnded = true; };
        recognition.start();
        return recognition;
    }

    async function transcribeCloud(blob, overrides = {}, signal) {
        const cfg = { ...config, ...overrides };
        if (!cloudConfigured(cfg)) throw new Error('云端 STT 未配置或未授权');
        const endpoint = new URL(cfg.cloudUrl);
        if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('云端 STT API 地址无效');
        const extension = /mp4/i.test(blob.type) ? 'm4a' : /ogg/i.test(blob.type) ? 'ogg' : 'webm';
        const body = new FormData();
        body.append('file', blob, `recording.${extension}`);
        body.append('model', cfg.cloudModel);
        if (cfg.language) body.append('language', cfg.language);
        const release = await global.ChatRequestGate?.acquire(cfg, signal);
        try {
        const response = await fetch(endpoint.href, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.cloudApiKey}` },
            body, signal
        });
        if (!response.ok) {
            let detail = '';
            try { detail = (await response.json())?.error?.message || ''; } catch (_) {}
            throw new Error(`云端 STT 请求失败 (${response.status})${detail ? `：${detail.slice(0, 160)}` : ''}`);
        }
        const data = await response.json();
        const text = String(data?.text ?? data?.transcript ?? data?.data?.text ?? '').trim();
        if (!text) throw new Error('云端 STT 未返回转写文本');
        return text;
        } finally { release?.(); }
    }

    async function start(options = {}) {
        const controller = new AbortController();
        if (!navigator.mediaDevices?.getUserMedia || !global.MediaRecorder) throw new Error('当前环境不支持麦克风录音，请使用 HTTPS 浏览器');
        const cfg = { ...config, ...(options.config || {}) };
        const mode = ['auto', 'browser', 'cloud'].includes(cfg.mode) ? cfg.mode : 'auto';
        if (mode === 'browser' && !browserSupported()) throw new Error('当前浏览器不支持实时语音识别');
        if (mode === 'cloud' && !cloudConfigured(cfg)) throw new Error('请先配置并授权云端 STT');

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks = [];
        const state = { browserText: '', browserError: '', browserEnded: false };
        let recognition = null;
        let stopped = false;
        const startedAt = Date.now();
        recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
        const recorderDone = new Promise((resolve, reject) => {
            recorder.onstop = resolve;
            recorder.onerror = event => reject(event.error || new Error('录音失败'));
        });
        recorder.start(500);
        if (mode !== 'cloud') {
            try { recognition = startBrowserRecognition(cfg.language, options, state); }
            catch (error) {
                state.browserError = error.message;
                options.onBrowserError?.(error.message);
                if (mode === 'browser') { stream.getTracks().forEach(track => track.stop()); throw error; }
            }
        }
        options.onState?.('recording');
        const limitTimer = setTimeout(() => { void session.stop(); }, Math.max(5, Number(cfg.maxDurationSeconds) || 120) * 1000);

        const session = {
            stop: async () => {
                if (stopped) return session.result;
                stopped = true;
                clearTimeout(limitTimer);
                try { recognition?.stop(); } catch (_) {}
                if (recorder.state !== 'inactive') recorder.stop();
                await recorderDone;
                stream.getTracks().forEach(track => track.stop());
                await new Promise(resolve => setTimeout(resolve, 80));
                const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
                if (!blob.size) throw new Error('没有录到有效音频');
                if (blob.size > 25 * 1024 * 1024) throw new Error('录音超过 25MB 限制');
                let transcriptOriginal = state.browserText.trim();
                let sttSource = transcriptOriginal ? 'browser' : '';
                const shouldUseCloud = mode === 'cloud' || (mode === 'auto' && (!transcriptOriginal || state.browserError));
                if (shouldUseCloud && cloudConfigured(cfg)) {
                    options.onState?.('transcribing-cloud');
                    transcriptOriginal = await transcribeCloud(blob, cfg, controller.signal);
                    sttSource = 'cloud';
                } else if (mode === 'cloud') {
                    throw new Error('云端 STT 未配置或未授权');
                }
                if (controller.signal.aborted) throw new DOMException('录音已取消', 'AbortError');
                session.result = {
                    blob,
                    dataUrl: await blobToDataUrl(blob),
                    durationMs: Math.max(0, Date.now() - startedAt),
                    transcriptOriginal,
                    translation: '',
                    language: cfg.language || 'zh-CN',
                    sttSource,
                    sttError: transcriptOriginal ? '' : state.browserError || '未获得转写文本'
                };
                options.onState?.('ready');
                return session.result;
            },
            cancel: () => {
                controller.abort();
                stopped = true;
                clearTimeout(limitTimer);
                try { recognition?.abort?.(); } catch (_) {}
                try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
                stream.getTracks().forEach(track => track.stop());
                options.onState?.('cancelled');
            },
            result: null
        };
        return session;
    }

    async function saveAsset(recording, metadata = {}) {
        if (!global.dexieDB?.recordedAudioAssets) throw new Error('录音存储尚未初始化');
        const id = metadata.id || `recorded_audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const record = {
            id,
            dataUrl: recording.dataUrl,
            mimeType: recording.blob?.type || metadata.mimeType || 'audio/webm',
            size: recording.blob?.size || metadata.size || 0,
            durationMs: recording.durationMs || 0,
            createdAt: Date.now(),
            chatId: metadata.chatId || '',
            messageId: metadata.messageId || '',
            refCount: 1
        };
        await global.dexieDB.recordedAudioAssets.put(record);
        if (global.SharedAssets?.registerExternal) {
            try {
                const shared = await global.SharedAssets.registerExternal({
                    id: metadata.sharedAssetId,
                    type: 'audio', name: metadata.name || `录音-${id}`, mimeType: record.mimeType,
                    size: record.size, externalStore: 'recordedAudioAssets', externalKey: id,
                    contentHash: await global.SharedAssets.digest(record.dataUrl || id),
                    metadata: { chatId: record.chatId, messageId: record.messageId, durationMs: record.durationMs },
                });
                await global.SharedAssets.attach(shared.id, { ownerType: 'recordedAudioAsset', ownerId: id, role: 'payload' });
                if (record.sharedAssetId !== shared.id) await global.dexieDB.recordedAudioAssets.put({ ...record, sharedAssetId: shared.id });
            } catch (error) {
                console.warn('[RecordedAudio] shared asset registration skipped:', error);
            }
        }
        return id;
    }

    async function getAsset(id) { return id && global.dexieDB?.recordedAudioAssets ? global.dexieDB.recordedAudioAssets.get(id) : null; }

    async function deleteAsset(id) {
        if (!id || !global.dexieDB?.recordedAudioAssets) return false;
        const asset = await getAsset(id);
        if (!asset) return false;
        await global.dexieDB.recordedAudioAssets.delete(id);
        try {
            if (asset.sharedAssetId) await global.SharedAssets?.detach?.(asset.sharedAssetId, `recordedAudioAsset:${id}:payload`);
            else await global.SharedAssets?.detachOwner?.('recordedAudioAsset', id, 'payload');
        } catch (error) {
            console.warn('[RecordedAudio] shared asset detach skipped:', error);
        }
        return true;
    }

    async function play(id) {
        const asset = await getAsset(id);
        if (!asset?.dataUrl) throw new Error('录音文件不存在');
        if (currentPlayback) { currentPlayback.pause(); currentPlayback = null; }
        const audio = new Audio(asset.dataUrl);
        currentPlayback = audio;
        audio.onended = () => { if (currentPlayback === audio) currentPlayback = null; };
        await audio.play();
        return true;
    }

    async function download(id) {
        const asset = await getAsset(id);
        if (!asset?.dataUrl) throw new Error('录音文件不存在');
        const a = document.createElement('a');
        a.href = asset.dataUrl;
        a.download = `录音_${new Date(asset.createdAt || Date.now()).toISOString().replace(/[:.]/g, '-')}.${/mp4/i.test(asset.mimeType) ? 'm4a' : /ogg/i.test(asset.mimeType) ? 'ogg' : 'webm'}`;
        document.body.appendChild(a); a.click(); a.remove();
    }

    loadConfig();
    global.RecordedAudioService = { get config() { return config; }, loadConfig, saveConfig, browserSupported, cloudConfigured, start, transcribeCloud, saveAsset, getAsset, deleteAsset, play, download, friendlyError };
})(globalThis);
