(function attachLifeContextRuntime(global) {
    'use strict';

    const Core = global.LifeContextCore;
    const runtime = new Map();
    const MAX_CONTEXT_CHARS = 1600;

    function ensureSettings(character) {
        if (!character) return character;
        if (character.lifeContextEnabled === undefined) character.lifeContextEnabled = false;
        if (!Array.isArray(character.lifeContextPackIds)) character.lifeContextPackIds = [];
        if (!Number.isFinite(Number(character.lifeContextMaxChars))) character.lifeContextMaxChars = 1200;
        return character;
    }

    function clockParts(character, realNow = Date.now()) {
        const clock = global.VirtualClock?.resolveCharacter ? global.VirtualClock.resolveCharacter(character) : {};
        const parts = global.VirtualClock?.getParts ? global.VirtualClock.getParts(clock, realNow) : null;
        if (parts) return { ...parts, date: global.VirtualClock.dateKey(clock, realNow) };
        const date = new Date(realNow);
        return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), date: date.toISOString().slice(0, 10), timeZone: '' };
    }

    function currentSlot(schedule, parts) {
        if (!schedule || !global.ScheduleCore?.resolveCurrent) return null;
        return global.ScheduleCore.resolveCurrent(schedule, parts.hour * 60 + parts.minute).current || null;
    }

    function emotionSummary(character) {
        const state = global.EmotionCore?.normalizeState ? global.EmotionCore.normalizeState({
            activeBuffs: character.activeBuffs,
            buffInjection: character.buffInjection,
            innerState: character.emotionInnerState,
            updatedAt: character.emotionUpdatedAt,
            revision: character.emotionRevision,
        }) : null;
        return (state?.activeBuffs || []).slice(0, 3).map(buff => buff.label || buff.name).filter(Boolean).join('、');
    }

    function weatherSummary(character) {
        const snapshot = global.RealtimeContextHub?.getWeatherSnapshot?.(character, 'character');
        const weather = snapshot?.weather || {};
        return [weather.description || weather.condition, weather.temp == null ? '' : `${weather.temp}°C`].filter(Boolean).join('，').slice(0, 100);
    }

    function repetitionLine(summary) {
        const fields = [
            ['food', '饮食'], ['outfit', '服装'], ['activityCategory', '活动类别'],
            ['narrativePattern', '叙事套路'], ['relationshipFunction', '关系功能'],
        ];
        const repeated = [];
        for (const [field, label] of fields) {
            const top = Object.entries(summary?.counts?.[field] || {}).filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1])[0];
            if (top) repeated.push(`${label}“${top[0]}”已出现${top[1]}次`);
        }
        const sequence = Object.entries(summary?.sequenceCounts || {}).find(([, count]) => count > 1);
        if (sequence) repeated.push(`生活序列“${sequence[0]}”已重复${sequence[1]}次`);
        return repeated.length ? `重复提示：${repeated.join('；')}` : '';
    }

    async function prepareContext(character, options = {}) {
        ensureSettings(character);
        if (!character?.lifeContextEnabled || !Core || !global.LifeContextStorage) {
            runtime.delete(character?.id);
            return '';
        }
        try {
            const realNow = Number.isFinite(Number(options.realNow)) ? Number(options.realNow) : Date.now();
            const parts = clockParts(character, realNow);
            const schedule = global.Schedule?.getSchedule ? await global.Schedule.getSchedule(character, realNow) : null;
            const slot = currentSlot(schedule, parts);
            const emotion = emotionSummary(character);
            const weather = weatherSummary(character);
            const event = Core.normalizeLifeEvent({
                id: `live:${character.id}:${parts.date}:${slot?.id || 'context'}`,
                characterId: character.id,
                sceneId: slot?.id || `${character.id}:${parts.date}`,
                status: slot?.status === 'cancelled' ? 'cancelled' : (slot?.status === 'completed' ? 'observed' : 'committed'),
                localDate: parts.date,
                startMinute: slot ? Math.max(0, Number(slot.startTime?.split(':')[0]) * 60 + Number(slot.startTime?.split(':')[1])) : parts.hour * 60 + parts.minute,
                activity: slot?.activity || '',
                activityCategory: slot?.activityCategory || '',
                locationRef: slot?.location || '',
                food: slot?.food || '',
                outfit: slot?.outfit || '',
                scenePurpose: slot?.description || '',
            });
            const packs = await global.LifeContextStorage.listPacks();
            const selectedIds = character.lifeContextPackIds.length
                ? character.lifeContextPackIds.map(String)
                : packs.filter(pack => pack.status === 'active').map(pack => String(pack.id));
            const chunks = selectedIds.length ? await global.LifeContextStorage.listChunks({ packIds: selectedIds }) : [];
            const query = {
                date: parts.date,
                packIds: selectedIds,
                domains: character.lifeContextDomains || [],
                keywords: [slot?.activity, slot?.location, slot?.food, slot?.outfit, ...(character.lifeContextKeywords || [])].filter(Boolean),
                tags: character.lifeContextTags || [],
            };
            const retrieved = global.LifeContextRetrieval?.retrieve
                ? await global.LifeContextRetrieval.retrieve(chunks, query, {
                    character,
                    localOptions: { boostPackIds: selectedIds },
                    candidateLimit: Math.max(8, Math.min(24, Number(character.lifeContextRetrievalCandidates) || 16)),
                })
                : Core.retrieveLifeChunks(chunks, query, { boostPackIds: selectedIds });
            const events = await global.LifeContextStorage.listLifeEvents({ characterId: character.id });
            const repetition = Core.summarizeLifeRepetition(events, { characterId: character.id, sceneId: event.sceneId });
            const cacheKey = Core.createLifeContextCacheKey(event, query, {
                packVersion: packs.filter(pack => selectedIds.includes(String(pack.id))).map(pack => `${pack.id}:${pack.version}:${pack.updatedAt || 0}`).join('|'),
                repetitionRevision: events.reduce((max, item) => Math.max(max, Number(item.updatedAt) || 0), 0),
            });
            const maxChars = Math.max(600, Math.min(MAX_CONTEXT_CHARS, Number(character.lifeContextMaxChars) || 1200));
            const lines = [`<life_context>`, `角色当地时间=${parts.date} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}${parts.timeZone ? ` (${parts.timeZone})` : ''}`];
            if (slot) lines.push(`当前日程=${slot.activity}${slot.location ? ` @ ${slot.location}` : ''}${slot.status ? ` [${slot.status}]` : ''}`);
            if (weather) lines.push(`角色当地天气=${weather}`);
            if (emotion) lines.push(`当前情绪=${emotion}`);
            const compact = Core.formatLifeContext(event, retrieved.results, { maxChars: Math.max(240, maxChars - lines.join('\n').length - 120) });
            if (compact) lines.push(compact);
            const repeat = repetitionLine(repetition);
            if (repeat) lines.push(repeat);
            lines.push('资料仅为时代/地域候选证据；角色设定、已发生事件、日程和用户明确纠正优先。', '</life_context>');
            const block = lines.join('\n').slice(0, maxChars);
            runtime.set(character.id, { block, cacheKey, preparedAt: realNow, date: parts.date });
            return block;
        } catch (error) {
            runtime.delete(character?.id);
            console.warn('[LifeContext] preparation failed without blocking chat:', error);
            return '';
        }
    }

    function getContext(character) {
        ensureSettings(character);
        return character?.lifeContextEnabled ? runtime.get(character.id)?.block || '' : '';
    }

    global.LifeContextRuntime = Object.freeze({ VERSION: 1, ensureSettings, prepareContext, getContext });
    global.prepareLifeContext = prepareContext;
    global.getLifeContextBlock = getContext;
}(typeof window !== 'undefined' ? window : globalThis));
