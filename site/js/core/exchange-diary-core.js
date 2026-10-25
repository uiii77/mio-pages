(function attachExchangeDiaryCore(global) {
    'use strict';
    const VERSION = 1;
    const MAX_TEXT = 12000;
    const text = value => String(value ?? '').trim();
    const clip = value => text(value).slice(0, MAX_TEXT);
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : '';
    const entryId = (characterId, date) => `exchange-diary:${encodeURIComponent(text(characterId))}:${validDate(date) || 'undated'}`;
    const id = value => text(value) || `exchange-diary:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const status = value => ['draft', 'waiting', 'replied', 'failed'].includes(value) ? value : 'draft';
    const archiveStatus = value => ['none', 'archived', 'failed'].includes(value) ? value : 'none';

    function emptyEntry(characterId, date, now = Date.now()) {
        const character = text(characterId);
        const day = validDate(date) || '1970-01-01';
        return normalizeEntry({ id: entryId(character, day), characterId: character, date: day, createdAt: now, updatedAt: now });
    }

    function normalizeEntry(value = {}, defaults = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const characterId = text(source.characterId || defaults.characterId);
        const date = validDate(source.date || defaults.date) || '1970-01-01';
        const now = Number(defaults.now) || Date.now();
        return {
            schemaVersion: VERSION,
            id: id(source.id || entryId(characterId, date)),
            type: 'exchange_diary',
            characterId,
            date,
            userText: clip(source.userText),
            characterText: clip(source.characterText),
            status: status(source.status),
            lastError: clip(source.lastError).slice(0, 500),
            archiveStatus: archiveStatus(source.archiveStatus),
            archiveNodeId: text(source.archiveNodeId),
            createdAt: Number(source.createdAt) || now,
            updatedAt: Number(source.updatedAt) || now,
            userUpdatedAt: Number(source.userUpdatedAt) || 0,
            characterUpdatedAt: Number(source.characterUpdatedAt) || 0,
        };
    }

    function cleanResponseText(raw) {
        let value = typeof raw === 'string' ? raw : raw?.choices?.[0]?.message?.content || raw?.content?.[0]?.text || raw?.text || '';
        return text(value).replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }

    function parseReply(raw) {
        const cleaned = cleanResponseText(raw);
        if (!cleaned) throw new Error('交换日记 API 未返回有效内容');
        try {
            const parsed = JSON.parse(cleaned);
            const candidate = parsed && typeof parsed.reply === 'object' ? parsed.reply : parsed;
            const value = candidate?.text ?? candidate?.content ?? candidate?.reply;
            if (typeof value === 'string' && value.trim()) return clip(value);
        } catch (_) {
            const match = cleaned.match(/"(?:text|content|reply)"\s*:\s*"((?:\\.|[^"\\])*)"/s);
            if (match) {
                try { return clip(JSON.parse(`"${match[1]}"`)); } catch (_) { return clip(match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')); }
            }
        }
        if (/^\s*[\[{]/.test(cleaned)) throw new Error('交换日记 API 返回格式不正确');
        return clip(cleaned);
    }

    function buildAiMessages(details = {}) {
        const roleName = text(details.roleName) || '角色';
        const date = validDate(details.date) || '今天';
        const recent = clip(details.recentContext).slice(0, 6000) || '暂无近期聊天记录';
        const userText = clip(details.userText);
        const system = `你正在和用户进行“交换日记”。你是${roleName}，请以角色身份写一封只属于今天（${date}）的回复日记。\n角色设定：${clip(details.persona).slice(0, 3000)}\n\n要求：回应用户日记中的具体内容，同时分享至少一件独立于用户、用户未必知道的角色近况或想法；保持自然、具体，不要声称看过未提供的事情；不要输出系统说明、标题或 Markdown 代码围栏。只返回 JSON：{"text":"日记正文"}。`;
        const user = `用户的日记：\n${userText}\n\n近期聊天（仅作背景，不要逐字复述）：\n${recent}`;
        return [{ role: 'system', content: system }, { role: 'user', content: user }];
    }

    function buildArchiveContent(entry, roleName = '角色') {
        const user = clip(entry?.userText);
        const character = clip(entry?.characterText);
        return [`交换日记 · ${validDate(entry?.date) || '未标日期'}`, user ? `用户：${user}` : '', character ? `${text(roleName) || '角色'}：${character}` : ''].filter(Boolean).join('\n\n');
    }

    global.ExchangeDiaryCore = { VERSION, MAX_TEXT, entryId, emptyEntry, normalizeEntry, parseReply, buildAiMessages, buildArchiveContent };
})(typeof window !== 'undefined' ? window : globalThis);
