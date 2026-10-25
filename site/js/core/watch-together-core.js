(function attachWatchTogetherCore(global) {
    'use strict';
    const MAX_CUES = 20000;
    const text = value => String(value ?? '').replace(/^\uFEFF/, '');
    const id = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    function timeMs(value) {
        const match = text(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/);
        if (!match) return NaN;
        return ((Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000) + Number(match[4].padEnd(3, '0'));
    }
    function cleanCueText(value) {
        return text(value).replace(/\{\\[^}]+\}/g, '').replace(/<[^>]+>/g, '').replace(/\\N/g, '\n').trim();
    }
    function parseSrtVtt(raw) {
        const cues = [];
        text(raw).replace(/\r/g, '').split(/\n{2,}/).forEach(block => {
            const lines = block.split('\n').filter(Boolean);
            const timingIndex = lines.findIndex(line => line.includes('-->'));
            if (timingIndex < 0) return;
            const parts = lines[timingIndex].split('-->');
            const startMs = timeMs(parts[0]);
            const endMs = timeMs((parts[1] || '').trim().split(/\s+/)[0]);
            const cueText = cleanCueText(lines.slice(timingIndex + 1).join('\n'));
            if (Number.isFinite(startMs) && endMs > startMs && cueText && cues.length < MAX_CUES) cues.push({ startMs, endMs, text: cueText });
        });
        return cues;
    }
    function parseAss(raw) {
        const cues = [];
        text(raw).replace(/\r/g, '').split('\n').forEach(line => {
            if (!/^Dialogue\s*:/i.test(line) || cues.length >= MAX_CUES) return;
            const fields = line.replace(/^Dialogue\s*:\s*/i, '').split(',');
            if (fields.length < 10) return;
            const startMs = timeMs(fields[1]);
            const endMs = timeMs(fields[2]);
            const cueText = cleanCueText(fields.slice(9).join(','));
            if (Number.isFinite(startMs) && endMs > startMs && cueText) cues.push({ startMs, endMs, text: cueText });
        });
        return cues;
    }
    function parseSubtitles(raw, name = '') {
        const format = /\.ass$/i.test(name) || /^\s*\[Script Info\]/im.test(raw) ? 'ass' : (/\.vtt$/i.test(name) || /^WEBVTT/im.test(raw) ? 'vtt' : 'srt');
        const cues = (format === 'ass' ? parseAss(raw) : parseSrtVtt(raw)).sort((a, b) => a.startMs - b.startMs);
        if (!cues.length) throw new Error('没有识别到有效字幕，请选择 SRT、VTT 或 ASS 文件');
        return { format, cues };
    }
    function activeCues(cues, mediaMs, offsetMs = 0) {
        const target = Math.max(0, Number(mediaMs) + Number(offsetMs || 0));
        return (Array.isArray(cues) ? cues : []).filter(cue => cue.startMs <= target && cue.endMs >= target).map(cue => cue.text);
    }
    function normalizeSession(value = {}) {
        const now = Date.now();
        return {
            id: text(value.id).trim() || id('watch'), characterId: text(value.characterId).trim(), title: text(value.title).trim() || '未命名影片',
            videoName: text(value.videoName).trim(), videoType: text(value.videoType).trim(), videoSize: Math.max(0, Number(value.videoSize) || 0),
            duration: Math.max(0, Number(value.duration) || 0), position: Math.max(0, Number(value.position) || 0),
            subtitleName: text(value.subtitleName).trim(), subtitleFormat: text(value.subtitleFormat).trim(), subtitleOffsetMs: Number(value.subtitleOffsetMs) || 0,
            cues: (Array.isArray(value.cues) ? value.cues : []).slice(0, MAX_CUES).map(cue => ({ startMs: Math.max(0, Number(cue.startMs) || 0), endMs: Math.max(0, Number(cue.endMs) || 0), text: cleanCueText(cue.text) })).filter(cue => cue.endMs > cue.startMs && cue.text),
            messages: (Array.isArray(value.messages) ? value.messages : []).slice(-100).map(item => ({ id: text(item.id) || id('watchmsg'), role: item.role === 'character' ? 'character' : 'user', text: text(item.text).slice(0, 4000), mediaTime: Math.max(0, Number(item.mediaTime) || 0), createdAt: Number(item.createdAt) || now })),
            createdAt: Number(value.createdAt) || now, updatedAt: Number(value.updatedAt) || now,
        };
    }
    function buildAiMessages(details = {}) {
        const subtitle = text(details.subtitle).trim() || '当前无字幕';
        const userText = text(details.userText).trim() || '请根据当前画面和字幕，以角色身份自然回应。';
        const system = `你正在和用户一起看本地影片。你是${text(details.roleName) || '角色'}。只回应当前时刻，不声称看过未提供的内容。回复简洁自然，不输出系统标签。\n角色设定：${text(details.persona).slice(0, 3000)}`;
        return [{ role: 'system', content: system }, { role: 'user', content: `影片：${text(details.title)}\n时间：${formatTime(details.mediaTime)}\n当前字幕：${subtitle}\n用户：${userText}` }];
    }
    function formatTime(seconds) { const value = Math.max(0, Number(seconds) || 0); const h = Math.floor(value / 3600); const m = Math.floor(value % 3600 / 60); const s = Math.floor(value % 60); return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`; }
    global.WatchTogetherCore = { MAX_CUES, timeMs, parseSubtitles, activeCues, normalizeSession, buildAiMessages, formatTime };
})(typeof window !== 'undefined' ? window : globalThis);
