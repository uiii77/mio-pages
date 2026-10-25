// OvO 消息内容解析层：保存格式保持不变，只为 UI、TTS 和 AI 请求生成派生内容。
(function attachMessageContentParser(global) {
    'use strict';

    const WRAPPER_LABEL_PATTERN = /(?:的)?(?:语音|声音|消息)|回复/;

    function asText(value) {
        return value == null ? '' : String(value);
    }

    // 找到最外层 OvO 消息格式中的分隔符。方括号标签不会被当成外层结束符。
    function findWrapper(value) {
        const raw = asText(value);
        const end = raw.trimEnd().length - 1;
        if (!raw.startsWith('[') || end <= 1 || raw[end] !== ']') return null;

        let depth = 0;
        let separatorIndex = -1;
        for (let index = 1; index < end; index += 1) {
            const character = raw[index];
            if (character === '[') {
                depth += 1;
                continue;
            }
            if (character === ']') {
                depth = Math.max(0, depth - 1);
                continue;
            }
            if (depth === 0 && (character === ':' || character === '：')) {
                separatorIndex = index;
                break;
            }
        }
        if (separatorIndex < 0) return null;

        const label = raw.slice(1, separatorIndex).trim();
        if (!WRAPPER_LABEL_PATTERN.test(label)) return null;

        const kind = /语音|声音/.test(label)
            ? 'voice'
            : (/回复/.test(label) ? 'reply' : (/消息/.test(label) ? 'message' : 'wrapped'));
        return {
            raw,
            label,
            kind,
            separator: raw[separatorIndex],
            separatorIndex,
            bodyStart: separatorIndex + 1,
            bodyEnd: end,
            suffixStart: end,
        };
    }

    // OvO 包装内末尾的「译文」是格式约定，名字、数字及假名同样有效。
    // 不根据字符语言猜测字段用途；未包装文本及非末尾引文不在此拆分。
    function isLikelyTranslationPair(original, translation) {
        const source = asText(original).trim();
        const target = asText(translation).trim();
        return !!source && !!target;
    }

    function findTerminalTranslation(body) {
        const value = asText(body);
        const trimmed = value.trimEnd();
        if (!trimmed.endsWith('」')) return null;

        const closeIndex = trimmed.length - 1;
        const openIndex = trimmed.lastIndexOf('「', closeIndex - 1);
        if (openIndex < 0) return null;

        const original = trimmed.slice(0, openIndex).trimEnd();
        const translation = trimmed.slice(openIndex + 1, closeIndex).trim();
        if (!isLikelyTranslationPair(original, translation)) return null;

        return {
            original,
            translation,
            translationStart: openIndex,
        };
    }

    function collectAudioTags(value) {
        const raw = asText(value);
        const tags = [];
        let start = -1;
        let depth = 0;

        for (let index = 0; index < raw.length; index += 1) {
            const character = raw[index];
            if (character === '[') {
                if (depth === 0) start = index;
                depth += 1;
            } else if (character === ']' && depth > 0) {
                depth -= 1;
                if (depth === 0 && start >= 0) {
                    tags.push(raw.slice(start, index + 1));
                    start = -1;
                }
            }
        }
        return tags;
    }

    function parse(value) {
        const raw = asText(value);
        let wrapper = findWrapper(raw);
        let outsideTranslation = null;
        // 兼容部分旧回复把译文写在 OvO 外层方括号之后：
        // [角色的消息：Hello]「你好」。保存内容保持原样，派生解析仍能识别原文和译文。
        if (!wrapper) {
            const trimmed = raw.trim();
            const outside = trimmed.match(/^([\s\S]*\])\s*「([^「」]+)」$/);
            if (outside) {
                wrapper = findWrapper(outside[1]);
                if (wrapper) {
                    const candidate = outside[2].trim();
                    const wrappedBody = outside[1].slice(wrapper.bodyStart, wrapper.bodyEnd).trim();
                    if (isLikelyTranslationPair(wrappedBody, candidate)) outsideTranslation = candidate;
                }
            }
        }
        const body = wrapper ? raw.slice(wrapper.bodyStart, wrapper.bodyEnd).trim() : raw.trim();
        const translation = wrapper ? findTerminalTranslation(body) : null;
        const original = translation ? translation.original : body;

        return {
            raw,
            kind: wrapper ? wrapper.kind : 'text',
            isWrapper: !!wrapper,
            isBilingual: !!(translation || outsideTranslation),
            label: wrapper ? wrapper.label : '',
            separator: wrapper ? wrapper.separator : '',
            original,
            translation: translation ? translation.translation : (outsideTranslation || ''),
            audioTags: collectAudioTags(original),
            wrapper,
        };
    }

    function toSpeechText(value) {
        const parsed = value && typeof value === 'object' && 'raw' in value ? value : parse(value);
        return parsed.original.trim();
    }

    function toModelText(value) {
        const parsed = value && typeof value === 'object' && 'raw' in value ? value : parse(value);
        if (!parsed.isWrapper || !parsed.wrapper) return parsed.original.trim();

        // 保留原有外层标签，去掉仅供用户阅读的翻译；不回写原消息。
        const wrapper = parsed.wrapper;
        return `${wrapper.raw.slice(0, wrapper.bodyStart)}${parsed.original}${wrapper.raw.slice(wrapper.bodyEnd)}`;
    }

    function derivedFields(value) {
        const parsed = value && typeof value === 'object' && 'raw' in value ? value : parse(value);
        if (!parsed.isWrapper) return {};
        const result = {};
        if (parsed.translation) result.translation = parsed.translation;
        if (parsed.kind === 'voice') {
            result.transcriptOriginal = parsed.original;
            if (parsed.translation) result.transcriptTranslation = parsed.translation;
        }
        return result;
    }

    function cloneValue(value) {
        if (Array.isArray(value)) return value.map(cloneValue);
        if (!value || typeof value !== 'object') return value;
        if (value instanceof Date) return new Date(value.getTime());
        const result = {};
        Object.keys(value).forEach(key => { result[key] = cloneValue(value[key]); });
        return result;
    }

    function sanitizeMessageForModel(message) {
        const clone = cloneValue(message);
        if (!clone || typeof clone !== 'object') return clone;

        if (typeof clone.content === 'string') clone.content = toModelText(clone.content);
        if (typeof clone.originalContent === 'string') clone.originalContent = toModelText(clone.originalContent);
        if (clone.quote && typeof clone.quote.content === 'string') {
            clone.quote.content = toModelText(clone.quote.content);
        }
        if (clone.quote && typeof clone.quote === 'object') {
            delete clone.quote.translation;
            delete clone.quote.transcriptTranslation;
        }
        if (Array.isArray(clone.parts)) {
            clone.parts.forEach(part => {
                if (part && part.type === 'text' && typeof part.text === 'string') {
                    part.text = toModelText(part.text);
                }
                if (part && typeof part === 'object') {
                    delete part.translation;
                    delete part.transcriptTranslation;
                }
            });
        }
        // 独立翻译字段只供用户界面、搜索和播放使用，不进入任何模型上下文副本。
        delete clone.translation;
        delete clone.transcriptTranslation;
        return clone;
    }

    // Music suggestions are a reserved, standalone trailing directive, never a
    // bracket nested in speech, a translation, or ElevenLabs audio tags.
    function extractMusicSuggestion(value) {
        const raw = typeof value === 'string' ? value : '';
        const match = raw.match(/(?:^|\r?\n)\[mio_music_suggest:([A-Za-z0-9-]{16,64}):([1-9]\d*)\]\s*$/);
        if (!match || !raw.slice(0, match.index).trim() || raw.slice(0, match.index).includes('[mio_music_suggest:')) return {cleaned:raw,suggestion:null};
        return {cleaned:raw.slice(0, match.index).trimEnd(),suggestion:{ticket:match[1],choice:Number(match[2])}};
    }
    const api = {
        extractMusicSuggestion,
        parse,
        isLikelyTranslationPair,
        collectAudioTags,
        toSpeechText,
        toModelText,
        derivedFields,
        sanitizeMessageForModel,
    };

    global.MessageContentParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
