(function (global) {
    'use strict';
    const Core = global.MemoryPalaceCore;
    const LAYERS = { episodes: '经历', facts: '事实', states: '近况', relations: '关系', knowledge: '知识', cognition: '认知', intentions: '愿望与约定' };
    const semanticKey = node => [node.owner || node.characterId, node.subject || 'unspecified', node.layer, Core.memoryFingerprint(node.content), node.layer === 'episodes' ? (node.source?.startTimestamp || node.createdAt) : ''].join('|');
    const active = (node, now) => !node.archived && (node.validUntil == null || node.validUntil > now);

    async function recall(nodes, vectors, links, query, vector, options = {}) {
        const now = options.now ?? Date.now(), limit = options.limit || 8;
        const pool = nodes.filter(n => active(n, now));
        const lexical = Core.bm25(pool, query);
        const queryLower = query.toLocaleLowerCase();
        const vectorMap = new Map(vectors.map(v => [v.memoryId, v.vector]));
        const rank = (score, channel) => pool.map(node => ({ node, score: score(node), channel })).filter(r => r.score > 0).sort((a,b) => b.score-a.score).slice(0, 24);
        const explicitDate = query.match(/\b(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
        const date = explicitDate ? `${explicitDate[1]}-${explicitDate[2].padStart(2,'0')}-${explicitDate[3].padStart(2,'0')}` : options.dateKey || '';
        const seeds = rank(n => Math.max(lexical.get(n.id) || 0, vector ? Core.cosine(vectorMap.get(n.id),vector) : 0), 'seed').slice(0,limit);
        const base = await Promise.all([
            Promise.resolve(rank(n => vector ? Math.max(0, Core.cosine(vectorMap.get(n.id), vector)) : 0, 'vector')),
            Promise.resolve(rank(n => n.entities.some(e => queryLower.includes(e.toLocaleLowerCase())) ? 1 : 0, 'entity')),
            Promise.resolve(rank(n => lexical.get(n.id) || 0, 'keyword')),
            Promise.resolve(rank(n => date && (n.source?.characterDate === date || n.content.includes(date)) ? 1 : 0, 'date')),
            Promise.resolve(rank(n => n.pinned ? 1 : 0, 'pinned')),
            Promise.resolve(rank(n => n.layer === 'states' ? n.confidence ?? 1 : 0, 'state')),
            Promise.resolve().then(() => options.activation ? Core.spreadingActivation(seeds, pool, links, {maxExpand:3}).filter(r=>r.activation).map(r=>({...r,channel:'graph'})) : []),
        ]);
        const merged = new Map();
        base.forEach(list => list.forEach((r, index) => {
            const old = merged.get(r.node.id) || { ...r, score: 0, channels: [] };
            old.score += 1 / (20 + index) + (r.node.pinned ? 0.02 : 0);
            old.channels.push(r.channel); merged.set(r.node.id, old);
        }));
        const seen = new Set();
        return [...merged.values()].sort((a,b) => b.score-a.score || b.node.updatedAt-a.node.updatedAt).filter(r => {
            const key = semanticKey(r.node); if (seen.has(key)) return false; seen.add(key); return true;
        }).slice(0, limit);
    }

    function plan(nodes, now) {
        const changes = new Map(), duplicates = new Map(), conflicts = new Map();
        const change = (node, values) => changes.set(node.id, { before: node, after: { ...node, ...values, revision: (node.revision || 0) + 1, updatedAt: Date.now() } });
        // Fixed memories remain user-controlled. Never delete originals during maintenance.
        const ordered = [...nodes].filter(n => !n.archived).sort((a,b) => Number(b.pinned)-Number(a.pinned) || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
        for (const node of ordered) {
            if (!node.pinned && node.validUntil != null && node.validUntil <= now) {
                change(node, { archived: true, archiveReason: '期限已结束' }); continue;
            }
            const key = semanticKey(node), representative = duplicates.get(key);
            if (representative && !node.pinned) {
                const latest = changes.get(representative.id)?.after || representative;
                change(representative, { sourceNodeIds: [...new Set([...(latest.sourceNodeIds || []), node.id, ...(node.sourceNodeIds || [])])] });
                change(node, { archived: true, archiveReason: '重复记忆', representativeId: representative.id }); continue;
            }
            duplicates.set(key, node);
            if (node.factKey && node.subject !== 'unspecified' && ['facts', 'states', 'relations'].includes(node.layer)) {
                const conflict = [node.owner, node.subject, node.layer, node.factKey].join('|');
                const previous = conflicts.get(conflict);
                if (previous && previous.content !== node.content && !node.pinned) {
                    change(node, { archived: true, archiveReason: '同一事项有较新记录，待核对', conflictGroup: conflict, representativeId: previous.id });
                } else conflicts.set(conflict, node);
            }
        }
        return [...changes.values()];
    }
    global.MemoryGovernanceCore = { LAYERS, semanticKey, active, recall, plan };
})(typeof window !== 'undefined' ? window : globalThis);
