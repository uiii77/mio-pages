// Local, read-only evidence for the next reply. No API, storage or UI dependency.
(function (global) {
    'use strict';
    const MAX_TURNS = 12, MAX_CHARS = 8000;
    const baseline = '自然接续对话，保留符合人设的习惯表达；避免无意义地重复追问或照搬长句。';
    const hint = '近期已有相近重复。自然回应新内容，少重复追问和长句；保留性格与口头禅，必要或应要求仍可复述，不提此提醒。';
    const hash = value => {
        let result = 2166136261;
        for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
        return (result >>> 0).toString(36);
    };
    function original(message) {
        if (!message || message.isThinking || message.isWithdrawn || message.excludeFromContext || message.isContextDisabled || message.tool_calls || message.tool_call_id || message.type === 'mcp_activity') return '';
        const parsed = global.MessageContentParser?.parse(message.content || '');
        if (!parsed || parsed.kind === 'wrapped' || !parsed.isWrapper && /^\s*[\[<]/.test(parsed.original)) return '';
        let text = parsed.original;
        for (const tag of parsed.audioTags) text = text.split(tag).join('');
        if (message.quote?.content) text = text.replace(global.MessageContentParser.parse(message.quote.content).original, '');
        return text.replace(/“[^”]*”|「[^」]*」|"[^"\n]*"|^>[^\n]*/gm, '').trim();
    }
    const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const pairs = text => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2)));
    const createReceipt = (receipt, message) => ({ ...receipt, replySignature: hash(original(message)) });
    function similar(a, b) {
        if (a === b) return true;
        if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < .8) return false;
        const left = pairs(a), right = pairs(b);
        return 2 * [...left].filter(pair => right.has(pair)).length / (left.size + right.size || 1) >= .86;
    }
    function inspect(history = [], options = {}) {
        const turns = [], byId = new Map();
        let chars = 0, segment = 0, latestUser = '';
        // Bound work even when a history contains many tool/media-only messages.
        for (let i = history.length - 1; i >= 0 && i >= history.length - 240 && chars < MAX_CHARS; i--) {
            const message = history[i];
            if (!message) continue;
            if (message.role === 'user') { segment++; latestUser ||= original(message); continue; }
            if (message.role !== 'assistant' || options.speakerId != null && message.senderId !== options.speakerId) continue;
            if (message.chatArchiveScopeId != null && String(message.chatArchiveScopeId) !== String(options.scope || '')) continue;
            const key = message.replyRequestId || `legacy:${segment}`;
            let turn = turns.find(item => item.key === key);
            if (!turn && turns.length === MAX_TURNS) break;
            const text = original(message).slice(0, MAX_CHARS - chars);
            if (!text) continue;
            chars += text.length;
            if (!turn) { turn = { key, items: [], receipts: [] }; turns.push(turn); }
            const item = { id: message.id, text, signature: hash(text), timestamp: Number(message.timestamp) || 0 };
            turn.items.push(item); byId.set(message.id, item);
            if (message.repetitionHint?.replySignature === item.signature) turn.receipts.push(message.repetitionHint);
        }
        // Explicit requests to repeat are intentional. "Don't repeat" is not such a request.
        if (!/别|不要|不用|停止|don't|do not/i.test(latestUser) && /再说|再问|再讲|再念|再读|复述|重复一|没听清|say.*again|repeat|remind me/i.test(latestUser)) return null;
        const sentences = [];
        turns.forEach((turn, index) => turn.items.forEach(item => {
            for (const text of item.text.match(/[^。！？.!?\n]+[。！？.!?]*/g) || []) {
                const normalized = normalize(text);
                const question = /[?？]/.test(text) || /(?:吗|么|呢)\s*$/.test(text);
                const cjk = /[\u3400-\u9fff]/.test(text);
                const longEnough = cjk ? normalized.length >= (question ? 10 : 16) : normalized.length >= 24 && text.trim().split(/\s+/).length >= 5;
                if (longEnough && sentences.length < 100) sentences.push({ ...item, normalized, question, turn: index });
            }
        }));
        for (const seed of sentences.filter(sentence => sentence.turn < 2)) {
            const matched = sentences.filter(candidate => candidate.question === seed.question && similar(seed.normalized, candidate.normalized)
                && (!seed.timestamp || !candidate.timestamp || Math.abs(seed.timestamp - candidate.timestamp) < 6 * 3600000));
            const distinct = [...new Map(matched.map(item => [item.turn, item])).values()];
            if (distinct.length < (seed.question ? 2 : 3)) continue;
            const evidence = distinct.slice(0, 3).map(item => ({ id: item.id, signature: item.signature }));
            const key = hash((seed.question ? 'q:' : 'phrase:') + distinct.map(item => item.normalized).sort()[0]);
            const recentHint = turns.slice(0, 3).flatMap(turn => turn.receipts).some(receipt =>
                receipt.scope === String(options.scope || '') && receipt.speakerId === (options.speakerId ?? null)
                && receipt.evidence?.every(item => byId.get(item.id)?.signature === item.signature)
                && (receipt.key === key || evidence.some(item => receipt.evidence.some(previous => previous.id === item.id))));
            if (recentHint) continue;
            return { hint, receipt: { key, scope: String(options.scope || ''), speakerId: options.speakerId ?? null, evidence }, kind: seed.question ? 'question' : 'phrase', turns: distinct.length, scannedChars: chars };
        }
        return null;
    }
    global.ChatRepetitionCore = Object.freeze({ inspect, createReceipt, baseline, MAX_TURNS, MAX_CHARS });
})(globalThis);
