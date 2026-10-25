// ElevenLabs 模型能力、Audio Tags 清理与提示词规则。
// 仅生成派生文本和请求参数，不改变 OvO 原始消息或翻译存储格式。
(function attachElevenLabsVoice(global) {
    'use strict';

    const DEFAULT_MODEL = 'eleven_multilingual_v2';
    const MODEL_OPTIONS = [
        { value: 'eleven_v4', label: 'Eleven v4' },
        { value: 'eleven_v4_turbo', label: 'Eleven v4 Turbo' },
        { value: 'eleven_flash_v2_5', label: 'Flash v2.5' },
        { value: 'eleven_v3', label: 'Eleven v3' },
        { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
    ];

    const V3_CUE_ALIASES = {
        laugh: 'laughs', laughing: 'laughs', laughs: 'laughs',
        giggle: 'chuckles', giggles: 'chuckles', chuckle: 'chuckles', chuckling: 'chuckles', chuckles: 'chuckles',
        whisper: 'whispers', whispering: 'whispers', whispers: 'whispers',
        sigh: 'sighs', sighing: 'sighs', sighs: 'sighs', exhale: 'exhales', exhales: 'exhales',
        excited: 'excited', happy: 'excited', playful: 'mischievously', mischievous: 'mischievously', mischievously: 'mischievously',
        curious: 'curious', sarcastic: 'sarcastic', crying: 'crying', sobbing: 'crying',
        snort: 'snorts', snorts: 'snorts', pause: 'pause', 'short pause': 'pause', 'long pause': 'pause', break: 'pause',
        hesitate: 'hesitates', hesitates: 'hesitates', hesitant: 'hesitates', softly: 'softly', soft: 'softly', calm: 'softly', breathy: 'softly',
        angry: 'angry', sad: 'sad', nervous: 'nervously', nervously: 'nervously'
    };

    const V4_GUIDE = `### ElevenLabs v4 语音表演规则

你写的是马上会被角色亲口说出来的台词。保留自然口语、呼吸、句子长短和段落；不要把“她轻声说道”一类叙述混进要朗读的正文。

Eleven v4 / v4 Turbo 支持开放式英文方括号 Audio Tags。根据角色和场景选择情绪、声音质感与演出指令，例如 [whispers]、[laughs]、[curious]、[crying]、[low, gravelly voice] 或 [Warm, conversational tone, faint amusement]。可组合标签，也可写更具体的英文声音描述，不限于示例；只在内容需要时使用。

停顿和节奏优先使用标点、省略号、大小写强调和自然换行。v4 不支持 SSML 或数值语速，不要输出 XML / SSML 标签或 <#秒数#>。`;
    const V3_GUIDE = `### ElevenLabs v3 语音表演规则

你写的是马上会被角色亲口说出来的台词，不是小说旁白。只在情绪真正变化的位置少量使用半角英文方括号 Audio Tags，例如 [laughs]、[chuckles]、[whispers]、[sighs]、[excited]、[curious]、[sarcastic]、[crying]、[hesitates]、[softly]、[pause]。通常一段使用 0–2 个标签，不要自造中文标签。

停顿优先靠逗号、句号、省略号、破折号和自然换行；确实需要明显沉默才用 [pause]。`;
    const STANDARD_GUIDE = `### ElevenLabs 语音表演规则

你写的是马上会被角色亲口说出来的台词，不是小说旁白。当前模型不支持 Audio Tags，不要输出方括号 Audio Tags、圆括号动作词或 SSML；情绪和停顿只靠措辞、语气词、标点和自然换行表达。`;

    function normalizeModel(raw) {
        return String(raw || '').trim() || DEFAULT_MODEL;
    }

    function isV3Model(model) { return normalizeModel(model) === 'eleven_v3'; }
    function isV4Model(model) { return ['eleven_v4', 'eleven_v4_turbo'].includes(normalizeModel(model)); }
    function supportsAudioTags(model) { return isV3Model(model) || isV4Model(model); }
    function normalizeV3Cue(raw) {
        const key = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return V3_CUE_ALIASES[key] || '';
    }
    function isV4AudioDirection(raw) {
        return /[A-Za-z]/.test(String(raw || '')) && !/[：:]/.test(String(raw || ''));
    }
    function clamp(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    }

    function extractVoiceBody(raw) {
        const normalized = String(raw || '').replace(/<([语語])音[^>]*>([\s\S]*?)<\/\s*\1\s*音\s*>/g, '$2');
        const match = normalized.match(/<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
        return match ? match[1] : normalized;
    }

    function stripTerminalTranslation(text) {
        const value = String(text || '').trimEnd();
        if (!value.endsWith('」')) return value;
        const open = value.lastIndexOf('「', value.length - 2);
        if (open < 0) return value;
        const original = value.slice(0, open).trimEnd();
        const translation = value.slice(open + 1, -1).trim();
        return original && translation ? original : value;
    }

    function cleanTextForTts(raw, model, parser) {
        const activeParser = parser || global.MessageContentParser;
        const isV3 = isV3Model(model);
        const isV4 = isV4Model(model);
        let text = activeParser && typeof activeParser.toSpeechText === 'function'
            ? activeParser.toSpeechText(raw)
            : extractVoiceBody(raw);

        text = stripTerminalTranslation(extractVoiceBody(text))
            .replace(/\[\[.*?\]\]/g, '')
            .replace(/%%BILINGUAL%%[\s\S]*/i, '')
            .replace(/<字幕>[\s\S]*?<\/字幕>/g, '')
            .replace(/<\/?[A-Za-z][^>]*>/g, '')
            .replace(/<#\s*[\d.]+\s*#>/g, '')
            .replace(/（[^）]{0,80}）/g, '')
            .replace(/\(([^)]{1,60})\)/g, (_match, inner) => {
                const cue = normalizeV3Cue(inner);
                return (isV3 || isV4) && cue ? `[${cue}]` : '';
            })
            .replace(/\[([^\[\]\r\n]+)\]/g, (match, inner) => {
                if (isV4 && isV4AudioDirection(inner)) return `[${inner.trim()}]`;
                const cue = normalizeV3Cue(inner);
                // v3 兼容 OvO 旧版：无法映射的英文演出标签仍保留，避免升级后截断用户已有标签；中文控制标签继续移除。
                if (!cue) return isV3 && /[A-Za-z]/.test(inner) ? `[${inner.trim()}]` : '';
                return isV3 ? `[${cue}]` : '';
            });

        if (isV4) {
            return text.replace(/\r\n?/g, '\n')
                .replace(/[ \t]+/g, ' ')
                .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
                .replace(/[ \t]*\n[ \t]*/g, '\n')
                .trim();
        }
        return text.replace(/\n{2,}/g, isV3 ? ' [pause] ' : '……')
            .replace(/\n+/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/\s+([，。！？、；：,.!?…])/g, '$1')
            .trim();
    }

    function getVoiceActingGuide(model, customPrompt) {
        const custom = String(customPrompt || '').trim();
        if (custom) return custom;
        if (isV4Model(model)) return V4_GUIDE;
        if (isV3Model(model)) return V3_GUIDE;
        return STANDARD_GUIDE;
    }

    function getVoicePrompt(character, cfg) {
        const roleConfig = character?.ttsConfig || {};
        const custom = roleConfig.elevenVoicePrompt || roleConfig.elevenLabsVoicePrompt
            || cfg?.elevenVoicePrompt || cfg?.elevenLabsVoicePrompt || '';
        return getVoiceActingGuide(cfg?.elevenModel, custom);
    }

    function buildRequestBody(text, cfg, language, speed, roleConfig) {
        const model = normalizeModel(cfg?.elevenModel);
        const role = roleConfig || {};
        const stabilityRaw = clamp(role.elevenStability ?? role.elevenLabsStability ?? cfg?.elevenStability ?? cfg?.elevenLabsStability, 0.5, 0, 1);
        const stability = isV3Model(model)
            ? [0, 0.5, 1].reduce((nearest, candidate) => Math.abs(candidate - stabilityRaw) < Math.abs(nearest - stabilityRaw) ? candidate : nearest, 0.5)
            : stabilityRaw;
        const similarity = clamp(role.elevenSimilarityBoost ?? role.elevenLabsSimilarityBoost ?? cfg?.elevenSimilarityBoost ?? cfg?.elevenLabsSimilarityBoost, 0.8, 0, 1);
        const style = clamp(role.elevenStyle ?? role.elevenLabsStyle ?? cfg?.elevenStyle ?? cfg?.elevenLabsStyle, 0, 0, 1);
        const speakerBoost = !!(role.elevenUseSpeakerBoost ?? role.elevenLabsUseSpeakerBoost ?? cfg?.elevenUseSpeakerBoost ?? cfg?.elevenLabsUseSpeakerBoost);
        const body = {
            text: cleanTextForTts(text, model),
            model_id: model,
            voice_settings: { stability, similarity_boost: similarity }
        };
        // v4/v4 Turbo 官方不接受数字语速、style 或 speaker boost；旧模型保留 OvO 的语速设置。
        if (!isV4Model(model)) {
            body.voice_settings.style = style;
            body.voice_settings.speed = clamp(role.elevenSpeed ?? role.elevenLabsSpeed ?? speed, 1, 0.7, 1.2);
            body.voice_settings.use_speaker_boost = speakerBoost;
        }
        const code = String(language || '').trim().toLowerCase();
        if (/^[a-z]{2}$/.test(code) && model !== 'eleven_multilingual_v2') body.language_code = code;
        return body;
    }

    global.ElevenLabsVoice = {
        DEFAULT_MODEL,
        MODEL_OPTIONS,
        normalizeModel,
        isV3Model,
        isV4Model,
        supportsAudioTags,
        cleanTextForTts,
        getVoiceActingGuide,
        getVoicePrompt,
        buildRequestBody,
    };
})(typeof window !== 'undefined' ? window : globalThis);
