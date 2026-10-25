// 角色情绪纯领域层：解析评估结果、规范化 Buff，并生成最小上下文。
(function attachEmotionCore(global) {
    'use strict';

    const VERSION = 1;
    const MAX_BUFFS = 8;
    const INTENSITIES = Object.freeze({ 1: '低', 2: '中', 3: '高' });

    function text(value, max = 1200) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }
    function clampIntensity(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 3 ? 3 : Number.isFinite(n) && n <= 1 ? 1 : 2;
    }
    function normalizeBuff(value, index = 0) {
        const source = value && typeof value === 'object' ? value : {};
        const label = text(source.label || source.name || source.id, 80);
        if (!label) return null;
        const name = text(source.name || source.id || `emotion_${index}`, 80) || `emotion_${index}`;
        const result = {
            id: text(source.id || `${name}_${index}`, 80) || `${name}_${index}`,
            name,
            label,
            intensity: clampIntensity(source.intensity),
        };
        ['emoji', 'color', 'description'].forEach(key => {
            const valueText = text(source[key], key === 'description' ? 300 : 24);
            if (valueText) result[key] = valueText;
        });
        return result;
    }
    function normalizeBuffs(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.map(normalizeBuff).filter(Boolean).filter(buff => {
            const key = `${buff.name}|${buff.label}`.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, MAX_BUFFS);
    }
    function normalizeState(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        return {
            activeBuffs: normalizeBuffs(source.activeBuffs || source.buffs),
            buffInjection: text(source.buffInjection || source.injection, 4000),
            innerState: text(source.innerState, 1200),
            updatedAt: Math.max(0, Number(source.updatedAt) || Number(options.now) || 0),
            lastEvaluatedAt: Math.max(0, Number(source.lastEvaluatedAt) || 0),
            revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
        };
    }
    function balancedObject(raw) {
        const source = String(raw || '').trim();
        const start = source.indexOf('{');
        if (start < 0) return '';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < source.length; i += 1) {
            const ch = source[i];
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') depth += 1;
            else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
        }
        return source.slice(start);
    }
    function parseResult(value) {
        let raw = typeof value === 'string' ? value : value?.choices?.[0]?.message?.content || value?.content || '';
        if (Array.isArray(raw)) raw = raw.map(item => typeof item === 'string' ? item : item?.text || '').join('');
        const source = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const candidates = [source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''), balancedObject(source)];
        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                const parsed = JSON.parse(candidate);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
                const changed = parsed.changed === true || String(parsed.changed).toLowerCase() === 'true';
                return {
                    changed,
                    buffs: Array.isArray(parsed.buffs) ? normalizeBuffs(parsed.buffs) : undefined,
                    injection: text(parsed.injection, 4000),
                    innerState: parsed.innerState === undefined ? undefined : text(parsed.innerState, 1200),
                };
            } catch (_) { /* 评估失败由调用层记录，不影响主聊天 */ }
        }
        return null;
    }
    function formatContext(state) {
        const normalized = normalizeState(state);
        const buffLines = normalized.activeBuffs.map(buff => {
            const dots = '●'.repeat(buff.intensity) + '○'.repeat(3 - buff.intensity);
            return `- ${buff.emoji || ''}${buff.label}（强度 ${dots}，${INTENSITIES[buff.intensity]}）${buff.description ? `：${buff.description}` : ''}`;
        });
        if (!buffLines.length && !normalized.buffInjection) return '';
        return `<emotion_state>\n当前情绪底色：\n${buffLines.join('\n') || '- 暂无明确情绪 Buff'}${normalized.buffInjection ? `\n情绪影响：${normalized.buffInjection}` : ''}\n请让情绪自然影响措辞和行为，但不要直接提及“Buff”或评估过程。\n</emotion_state>`;
    }
    global.EmotionCore = Object.freeze({ VERSION, MAX_BUFFS, INTENSITIES, normalizeBuff, normalizeBuffs, normalizeState, parseResult, formatContext });
})(typeof window !== 'undefined' ? window : globalThis);
