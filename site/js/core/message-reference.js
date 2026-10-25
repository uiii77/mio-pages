// 收藏、搜索与聊天定位共用的消息引用层。旧收藏只在读取时适配，不回写迁移。
(function attachMessageReference(global) {
    'use strict';

    const TYPE_LABELS = {
        text: '文字',
        'user-audio': '用户录音',
        'ai-voice': '角色语音',
        image: '图片',
        video: '视频',
        file: '文件',
        transfer: '转账',
        sticker: '表情包',
        location: '位置',
        system: '系统消息',
    };

    function asText(value) {
        return value == null ? '' : String(value);
    }

    function parser() {
        return global.MessageContentParser || null;
    }

    function extractText(message) {
        if (!message || typeof message !== 'object') return '';
        if (typeof message.content === 'string') return message.content;
        const textPart = Array.isArray(message.parts) && message.parts.find(part => part && part.type === 'text');
        return textPart ? asText(textPart.text) : '';
    }

    function parseContent(value) {
        const api = parser();
        if (api && typeof api.parse === 'function') return api.parse(asText(value));
        const raw = asText(value).trim();
        return { raw, kind: 'text', original: raw, translation: '', isBilingual: false };
    }

    function classify(message) {
        const content = extractText(message);
        const parts = Array.isArray(message && message.parts) ? message.parts : [];
        if (message && (message.messageType === 'recorded-audio' || message.audioAssetId)) {
            return message.role === 'assistant' ? 'ai-voice' : 'user-audio';
        }
        if (parts.some(part => part && part.type === 'video')) return 'video';
        if (parts.some(part => part && part.type === 'image')) return 'image';
        if (parts.some(part => part && (part.type === 'file' || part.type === 'document'))) return 'file';
        if (/\[(?:[^\]]*?)(?:转账|给你转账|向.+?转账)[：:]/.test(content)) return 'transfer';
        if (/\[(?:[^\]]*?)(?:表情包|发送的表情包)[：:]/.test(content)) return 'sticker';
        if (/\[(?:[^\]]*?)(?:照片\/视频|视频)[：:]/.test(content)) return 'video';
        if (/\[(?:[^\]]*?)(?:图片|照片)[：:]/.test(content)) return 'image';
        if (/\[(?:[^\]]*?)(?:文件|文档)[：:]/.test(content)) return 'file';
        if (/\[(?:[^\]]*?)(?:位置|定位)[：:]/.test(content)) return 'location';
        const parsed = parseContent(content);
        if (parsed.kind === 'voice' || /\[(?:[^\]]*?)的(?:语音|声音)[：:]/.test(content)) {
            return message && message.role === 'user' ? 'user-audio' : 'ai-voice';
        }
        if (message && (message.role === 'system' || message.isSystemMessage)) return 'system';
        return 'text';
    }

    function getSenderName(chatType, chat, message) {
        if (!message) return '未知';
        if (message.role === 'user') {
            return chatType === 'private'
                ? (chat && chat.myName || '我')
                : (chat && chat.me && chat.me.nickname || '我');
        }
        if (chatType === 'private') return chat && (chat.remarkName || chat.name) || '对方';
        const member = chat && Array.isArray(chat.members)
            ? chat.members.find(entry => entry.id === message.senderId)
            : null;
        return member && (member.groupNickname || member.name) || '成员';
    }

    function compactMedia(message) {
        const media = {};
        if (message && message.audioAssetId) media.audioAssetId = message.audioAssetId;
        if (message && message.duration != null) media.duration = message.duration;
        if (message && message.fileName) media.fileName = message.fileName;
        const parts = Array.isArray(message && message.parts) ? message.parts : [];
        const references = parts.filter(part => part && part.type !== 'text').map(part => ({
            type: part.type,
            name: part.name || part.fileName || '',
            url: typeof part.url === 'string' && !part.url.startsWith('data:') ? part.url : '',
        }));
        if (references.length) media.parts = references;
        return media;
    }

    function createSnapshot(chatType, chat, message) {
        const content = extractText(message);
        const parsed = parseContent(content);
        return {
            messageId: message.id,
            role: message.role || '',
            senderId: message.senderId || null,
            senderName: getSenderName(chatType, chat, message),
            type: classify(message),
            content,
            original: message.transcriptOriginal || parsed.original || content,
            translation: message.translation || parsed.translation || '',
            timestamp: message.timestamp || Date.now(),
            media: compactMedia(message),
            activityTrace: global.ActivityTraceCore?.normalize
                ? global.ActivityTraceCore.normalize(message.activityTrace)
                : null,
        };
    }

    function normalizeFavorite(favorite) {
        if (!favorite || typeof favorite !== 'object') return [];
        if (Array.isArray(favorite.items) && favorite.items.length) {
            return favorite.items.map(item => ({
                messageId: item.messageId || favorite.messageId || null,
                role: item.role || '',
                senderId: item.senderId || null,
                senderName: item.senderName || item.sender || favorite.sender || '未知',
                type: item.type || classify(item),
                content: asText(item.content),
                original: asText(item.original || parseContent(item.content).original),
                translation: asText(item.translation || parseContent(item.content).translation),
                timestamp: item.timestamp || favorite.timestamp || favorite.favoriteTime || Date.now(),
                media: item.media && typeof item.media === 'object' ? item.media : {},
                activityTrace: global.ActivityTraceCore?.normalize
                    ? global.ActivityTraceCore.normalize(item.activityTrace)
                    : null,
            }));
        }
        const parsed = parseContent(favorite.content);
        return [{
            messageId: favorite.messageId || null,
            role: favorite.role || '',
            senderId: favorite.senderId || null,
            senderName: favorite.sender || '未知',
            type: favorite.type || classify(favorite),
            content: asText(favorite.content),
            original: parsed.original || asText(favorite.content),
            translation: parsed.translation || '',
            timestamp: favorite.timestamp || favorite.favoriteTime || Date.now(),
            media: favorite.audioAssetId ? { audioAssetId: favorite.audioAssetId } : {},
            activityTrace: global.ActivityTraceCore?.normalize
                ? global.ActivityTraceCore.normalize(favorite.activityTrace)
                : null,
        }];
    }

    function favoriteModelText(favorite) {
        return normalizeFavorite(favorite).map(item => {
            const raw = item.content || item.original;
            const api = parser();
            const originalOnly = api && typeof api.toModelText === 'function'
                ? api.toModelText(raw)
                : item.original;
            const cleaned = parseContent(originalOnly).original || item.original;
            return item.senderName ? `${item.senderName}：${cleaned}` : cleaned;
        }).filter(Boolean).join('\n');
    }

    function getChat(dbValue, chatType, chatId) {
        const source = dbValue || global.db || {};
        const list = chatType === 'private' ? source.characters : source.groups;
        return Array.isArray(list) ? list.find(entry => entry.id === chatId) : null;
    }

    function resolve(chatType, chatId, messageId, dbValue) {
        const chat = getChat(dbValue, chatType, chatId);
        const message = chat && Array.isArray(chat.history)
            ? chat.history.find(entry => entry.id === messageId)
            : null;
        return message ? { chat, message } : null;
    }

    function locate(chatType, chatId, messageId, dbValue) {
        if (!resolve(chatType, chatId, messageId, dbValue)) return false;
        global._pendingMessageLocation = { chatType, chatId, messageId };
        if (typeof global.openChatRoom === 'function') global.openChatRoom(chatId, chatType);
        return true;
    }

    function dayBounds(dateValue, endOfDay) {
        if (!dateValue) return null;
        const date = new Date(`${dateValue}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
        return Number.isFinite(date.getTime()) ? date.getTime() : null;
    }

    function fuzzyIncludes(haystack, needle) {
        let cursor = 0;
        for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
            if (haystack[index] === needle[cursor]) cursor += 1;
        }
        return cursor === needle.length;
    }

    function matches(message, filters) {
        const options = filters || {};
        const timestamp = Number(message && message.timestamp) || 0;
        const from = dayBounds(options.dateFrom, false);
        const to = dayBounds(options.dateTo, true);
        if (from != null && timestamp < from) return false;
        if (to != null && timestamp > to) return false;
        if (options.sender === 'user' && message.role !== 'user') return false;
        if (options.sender === 'assistant' && message.role === 'user') return false;
        const type = classify(message);
        if (options.type && options.type !== 'all' && type !== options.type) return false;
        const keyword = asText(options.keyword).trim().toLocaleLowerCase();
        if (!keyword) return true;
        const parsed = parseContent(extractText(message));
        const searchable = [
            message && message.transcriptOriginal,
            message && message.translation,
            parsed.original,
            parsed.translation,
            extractText(message),
        ].filter(Boolean).join('\n').toLocaleLowerCase();
        return searchable.includes(keyword) || (keyword.length >= 3 && fuzzyIncludes(searchable, keyword));
    }

    global.MessageReference = {
        TYPE_LABELS,
        classify,
        createSnapshot,
        normalizeFavorite,
        favoriteModelText,
        getSenderName,
        getChat,
        resolve,
        locate,
        matches,
        parseContent,
        extractText,
    };
})(typeof window !== 'undefined' ? window : globalThis);
