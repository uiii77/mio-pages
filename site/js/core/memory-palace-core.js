// 记忆宫殿纯领域层：七房间、节点规范化、BM25/向量融合与上下文格式化。
(function attachMemoryPalaceCore(global) {
    'use strict';

    const ROOMS = Object.freeze({
        living_room: { label: '客厅', description: '日常闲聊、近期互动' },
        bedroom: { label: '卧室', description: '亲密情感、深层羁绊' },
        study: { label: '书房', description: '工作学习、技能成长' },
        user_room: { label: '用户房间', description: '用户个人信息、习惯' },
        self_room: { label: '自我房间', description: '角色自我认同、演变' },
        attic: { label: '阁楼', description: '未消化的困惑、潜意识' },
        windowsill: { label: '窗台', description: '期盼、目标、憧憬' },
    });

    const ROOM_WEIGHTS = Object.freeze({
        living_room: [0.50, 0.30, 0.20],
        bedroom: [0.60, 0.10, 0.30],
        attic: [0.70, 0.00, 0.30],
        study: [0.55, 0.15, 0.30],
        user_room: [0.55, 0.15, 0.30],
        self_room: [0.55, 0.15, 0.30],
        windowsill: [0.55, 0.15, 0.30],
    });

    const AUTO_ARCHIVE_PRESETS = Object.freeze({
        online: Object.freeze({ preset: 'online', hotZoneSize: 200, bufferThreshold: 100 }),
        balanced: Object.freeze({ preset: 'balanced', hotZoneSize: 100, bufferThreshold: 50 }),
        offline: Object.freeze({ preset: 'offline', hotZoneSize: 50, bufferThreshold: 20 }),
    });
    const AUTO_ARCHIVE_PROCESS_RATIO = 0.85;
    const LINK_TYPES = Object.freeze({
        temporal: '时间关联', emotional: '情绪关联', causal: '因果关联', person: '人物关联', metaphor: '隐喻关联',
    });
    const EVENT_BOX_STATUSES = Object.freeze({ open: '进行中', sealed: '已归档' });
    const ROOM_PLATE_ROOMS = Object.freeze(['user_room', 'self_room', 'bedroom', 'study']);
    const ROOM_PLATE_TITLES = Object.freeze({ user_room: 'TA 的事', self_room: '我是谁', bedroom: '我们之间', study: '我的领域' });
    const ROOM_PLATE_CAPS = Object.freeze({ user_room: 12, self_room: 10, bedroom: 10, study: 8 });
    const ROOM_PLATE_ENTRY_HARD_MAX_CHARS = 90;
    const ANTICIPATION_STATUSES = Object.freeze({ active: '进行中', anchor: '长期锚点', fulfilled: '已实现', disappointed: '已落空' });
    const ANTICIPATION_ANCHOR_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
    const DIGEST_REPORT_TRIGGERS = Object.freeze({ auto: '自动', manual: '手动' });
    const DIGEST_REPORT_KEEP = 30;
    const ACTIVATION_DECAY = 0.3;
    const ACTIVATION_MAX_EXPAND = 3;
    const ACTIVATION_PERSONALITY_WEIGHTS = Object.freeze({
        emotional: Object.freeze({ emotional: 1, person: 0.6, metaphor: 0.5, temporal: 0.3, causal: 0.2 }),
        narrative: Object.freeze({ temporal: 1, person: 0.8, causal: 0.4, emotional: 0.3, metaphor: 0.2 }),
        imagery: Object.freeze({ metaphor: 1, emotional: 0.5, temporal: 0.3, person: 0.3, causal: 0.2 }),
        analytical: Object.freeze({ causal: 1, temporal: 0.4, person: 0.3, emotional: 0.2, metaphor: 0.2 }),
    });

    function id(prefix = 'mp') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function normalizeStringList(value) {
        const input = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
        return [...new Set(input.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 30);
    }

    function memoryFingerprint(value) {
        const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
        let hash = 2166136261;
        for (let index = 0; index < normalized.length; index += 1) {
            hash ^= normalized.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function resolveWaterline(value) {
        const preset = value?.preset;
        if (AUTO_ARCHIVE_PRESETS[preset]) return { ...AUTO_ARCHIVE_PRESETS[preset] };
        if (preset === 'custom') {
            return {
                preset: 'custom',
                hotZoneSize: Math.min(500, Math.max(20, Math.floor(Number(value.hotZoneSize) || 200))),
                bufferThreshold: Math.min(200, Math.max(10, Math.floor(Number(value.bufferThreshold) || 100))),
            };
        }
        return { ...AUTO_ARCHIVE_PRESETS.online };
    }

    function normalizeArchiveState(value) {
        const source = value && typeof value === 'object' ? value : {};
        const pendingSource = source.pendingBatch && typeof source.pendingBatch === 'object' ? source.pendingBatch : null;
        const pendingBatch = pendingSource && Array.isArray(pendingSource.candidates) ? {
            id: String(pendingSource.id || ''),
            startMessageId: String(pendingSource.startMessageId || ''),
            endMessageId: String(pendingSource.endMessageId || ''),
            startTimestamp: Math.max(0, Number(pendingSource.startTimestamp) || 0),
            endTimestamp: Math.max(0, Number(pendingSource.endTimestamp) || 0),
            processed: Math.max(0, Math.floor(Number(pendingSource.processed) || 0)),
            messageIds: [...new Set((Array.isArray(pendingSource.messageIds) ? pendingSource.messageIds : []).map(item => String(item || '').trim()).filter(Boolean))].slice(0, 500),
            candidates: pendingSource.candidates.map(item => ({
                ...normalizeNode(item),
                content: String(item?.content || '').trim().slice(0, 2000),
                room: Object.prototype.hasOwnProperty.call(ROOMS, item?.room) ? item.room : 'living_room',
                tags: normalizeStringList(item?.tags),
                entities: normalizeStringList(item?.entities),
                importance: Math.min(10, Math.max(1, Number(item?.importance) || 5)),
                mood: String(item?.mood || '').trim().slice(0, 40),
                sourceMessageIds: normalizeStringList(item?.sourceMessageIds),
            })).filter(item => item.content),
        } : null;
        return {
            watermarkMessageId: String(source.watermarkMessageId || ''),
            watermarkTimestamp: Math.max(0, Number(source.watermarkTimestamp) || 0),
            lastRunAt: Math.max(0, Number(source.lastRunAt) || 0),
            lastSuccessAt: Math.max(0, Number(source.lastSuccessAt) || 0),
            lastError: String(source.lastError || '').slice(0, 500),
            processedMessages: Math.max(0, Math.floor(Number(source.processedMessages) || 0)),
            storedMemories: Math.max(0, Math.floor(Number(source.storedMemories) || 0)),
            batches: Array.isArray(source.batches) ? source.batches.slice(-10) : [],
            pendingBatch,
        };
    }

    function selectArchiveWindow(messages, stateValue, waterlineValue, options = {}) {
        const ordered = Array.isArray(messages) ? messages.filter(item => item && item.id != null) : [];
        const state = normalizeArchiveState(stateValue);
        const waterline = resolveWaterline(waterlineValue);
        const hotZoneStart = Math.max(0, ordered.length - waterline.hotZoneSize);
        const candidates = ordered.slice(0, hotZoneStart);
        let cursor = -1;
        if (state.watermarkMessageId) cursor = candidates.findIndex(item => String(item.id) === state.watermarkMessageId);
        let buffer;
        if (cursor >= 0) buffer = candidates.slice(cursor + 1);
        else if (state.watermarkTimestamp > 0) buffer = candidates.filter(item => Number(item.timestamp) > state.watermarkTimestamp);
        else buffer = candidates;
        const minimum = options.force === true ? 1 : waterline.bufferThreshold;
        if (buffer.length < minimum) {
            return { selected: [], bufferCount: buffer.length, hotZoneCount: ordered.length - candidates.length, skipReason: candidates.length ? 'threshold' : 'hot_zone', waterline };
        }
        const count = options.force === true ? buffer.length : Math.max(1, Math.ceil(buffer.length * AUTO_ARCHIVE_PROCESS_RATIO));
        return { selected: buffer.slice(0, Math.min(count, 120)), bufferCount: buffer.length, hotZoneCount: ordered.length - candidates.length, skipReason: '', waterline };
    }

    // A manual job snapshots IDs and text fingerprints, never copies or rewrites chat history.
    function planHistoryArchive(messages, selection = {}, config = {}) {
        const all = Array.isArray(messages) ? messages : [];
        let selected = all;
        if (selection.mode === 'recent') selected = all.slice(-Math.max(1, Number(selection.count) || 100));
        if (selection.mode === 'numbers') selected = all.filter(m => m.ordinal >= Number(selection.start) && m.ordinal <= Number(selection.end));
        if (selection.mode === 'dates') selected = all.filter(m => m.timestamp >= Number(selection.start) && m.timestamp <= Number(selection.end));
        if (selection.mode === 'messages') {
            const start = all.findIndex(m => m.id === selection.start), end = all.findIndex(m => m.id === selection.end);
            if (start < 0 || end < start) throw Error('请按聊天顺序选择有效的起止消息');
            selected = all.slice(start, end + 1);
        }
        if (!selected.length) throw Error('此范围没有可整理的文字或语音原文');
        const seen = new Set();
        for (const m of selected) {
            if (!m.id || seen.has(m.id)) throw Error('所选记录含缺失或重复的消息 ID，请先核对记录；不会改写原消息');
            seen.add(m.id);
        }
        // Unknown context sizes use a conservative 8K budget; reserve room for instructions and output.
        const context = Math.max(2048, Number(config.contextWindow || config.contextLength) || 8192);
        // Reserve instructions, candidate memories and structured output; large contexts must not create huge extraction calls.
        const budget = Math.max(512, Math.min(6000, Math.floor(context * 0.45) - 1200));
        const batches = []; let units = [], used = 0, characters = 0;
        const flush = () => { if (units.length) batches.push({ units, status: 'pending', attempts: 0 }); units = []; used = 0; };
        for (const message of selected) {
            const hash = memoryFingerprint(message.text); characters += message.text.length;
            for (let start = 0; start < message.text.length;) {
                if (units.length >= 200 || budget - used < 256) flush();
                const end = Math.min(message.text.length, start + budget - used - 128);
                units.push({ id: message.id, hash, start, end, last: end === message.text.length });
                used += end - start + 128; start = end;
            }
        }
        flush();
        return { total: selected.length, batches, characters, budget };
    }

    function linkKey(leftId, rightId, type) {
        const [sourceId, targetId] = String(leftId) < String(rightId) ? [String(leftId), String(rightId)] : [String(rightId), String(leftId)];
        return `${sourceId}|${targetId}|${type}`;
    }

    function normalizeLink(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const type = Object.prototype.hasOwnProperty.call(LINK_TYPES, source.type) ? source.type : 'temporal';
        const sourceId = String(source.sourceId || '');
        const targetId = String(source.targetId || '');
        return {
            id: String(source.id || id('mpl')),
            characterId: String(source.characterId || options.characterId || ''),
            sourceId,
            targetId,
            type,
            strength: Math.min(1, Math.max(0.05, Number(source.strength) || 0.3)),
            origin: source.origin === 'manual' ? 'manual' : 'automatic',
            createdAt: Math.max(0, Number(source.createdAt) || options.now || Date.now()),
            updatedAt: Math.max(0, Number(source.updatedAt) || options.now || Date.now()),
        };
    }

    function normalizeEventBox(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const memberIds = Array.isArray(source.nodeIds)
            ? source.nodeIds
            : [...(Array.isArray(source.liveMemoryIds) ? source.liveMemoryIds : []), ...(Array.isArray(source.archivedMemoryIds) ? source.archivedMemoryIds : [])];
        const now = options.now || Date.now();
        return {
            id: String(source.id || id('mpe')),
            characterId: String(source.characterId || source.charId || options.characterId || ''),
            name: String(source.name || '未命名事件').trim().slice(0, 120) || '未命名事件',
            tags: normalizeStringList(source.tags).slice(0, 20),
            nodeIds: [...new Set(memberIds.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 200),
            summaryNodeId: source.summaryNodeId ? String(source.summaryNodeId) : null,
            status: source.status === 'sealed' || source.sealed === true ? 'sealed' : 'open',
            createdAt: Math.max(0, Number(source.createdAt) || now),
            updatedAt: Math.max(0, Number(source.updatedAt) || now),
        };
    }

    function normalizeRoomPlateEntry(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const now = options.now || Date.now();
        return {
            id: String(source.id || id('mpp')),
            text: String(source.text || '').replace(/\s+/g, ' ').trim().slice(0, ROOM_PLATE_ENTRY_HARD_MAX_CHARS),
            firstLearnedAt: Math.max(0, Number(source.firstLearnedAt) || now),
            updatedAt: Math.max(0, Number(source.updatedAt) || now),
            sourceCount: Math.max(1, Math.floor(Number(source.sourceCount) || 1)),
            tag: String(source.tag || '').trim().slice(0, 20),
        };
    }

    function normalizeRoomPlate(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const characterId = String(source.characterId || source.charId || options.characterId || '');
        const room = ROOM_PLATE_ROOMS.includes(source.room) ? source.room : 'user_room';
        const entries = Array.isArray(source.entries)
            ? source.entries.map(item => normalizeRoomPlateEntry(item, options)).filter(item => item.text).slice(0, ROOM_PLATE_CAPS[room])
            : [];
        return {
            id: String(source.id || `${characterId}:${room}`),
            characterId,
            room,
            entries,
            updatedAt: Math.max(0, Number(source.updatedAt) || options.now || Date.now()),
            version: Math.max(0, Math.floor(Number(source.version) || 0)),
        };
    }

    function normalizeAnticipation(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const now = Math.max(0, Number(options.now) || Date.now());
        const status = Object.prototype.hasOwnProperty.call(ANTICIPATION_STATUSES, source.status) ? source.status : 'active';
        const createdAt = Math.max(0, Number(source.createdAt) || now);
        return {
            id: String(source.id || id('mpa')),
            characterId: String(source.characterId || source.charId || options.characterId || ''),
            content: String(source.content || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            status,
            createdAt,
            anchoredAt: source.anchoredAt == null ? null : Math.max(0, Number(source.anchoredAt) || now),
            resolvedAt: source.resolvedAt == null ? null : Math.max(0, Number(source.resolvedAt) || now),
            updatedAt: Math.max(0, Number(source.updatedAt) || createdAt),
        };
    }

    function advanceAnticipation(value, now = Date.now()) {
        const anticipation = normalizeAnticipation(value, { now });
        if (anticipation.status === 'active' && Math.max(0, Number(now) || 0) - anticipation.createdAt >= ANTICIPATION_ANCHOR_AFTER_MS) {
            anticipation.status = 'anchor';
            anticipation.anchoredAt = Math.max(0, Number(now) || Date.now());
            anticipation.updatedAt = anticipation.anchoredAt;
        }
        return anticipation;
    }

    function normalizeDigestReportSection(value) {
        const source = value && typeof value === 'object' ? value : {};
        const label = String(source.label || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const items = Array.isArray(source.items)
            ? [...new Set(source.items.map(item => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 240)).filter(Boolean))].slice(0, 50)
            : [];
        return { label, items };
    }

    function normalizeDigestReport(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const characterId = String(source.characterId || source.charId || options.characterId || '');
        const now = Math.max(0, Number(options.now) || Date.now());
        const createdAt = Math.max(0, Number(source.createdAt) || now);
        const trigger = Object.prototype.hasOwnProperty.call(DIGEST_REPORT_TRIGGERS, source.trigger) ? source.trigger : 'manual';
        const sections = value => Array.isArray(value) ? value.map(normalizeDigestReportSection).filter(section => section.label || section.items.length).slice(0, 30) : [];
        const plateUpdated = Array.isArray(source.plateUpdated)
            ? [...new Set(source.plateUpdated.map(room => String(room || '').trim()).filter(room => ROOM_PLATE_ROOMS.includes(room)))].slice(0, ROOM_PLATE_ROOMS.length)
            : [];
        return {
            id: String(source.id || id('mpd')),
            characterId,
            createdAt,
            trigger,
            examined: sections(source.examined),
            outcomes: sections(source.outcomes),
            plateSubmissions: sections(source.plateSubmissions),
            plateUpdated,
            plateCloudPending: source.plateCloudPending === true,
            governance: source.governance && typeof source.governance === 'object' ? source.governance : null,
        };
    }

    function spreadingActivation(seeds, nodes, links, options = {}) {
        const sourceSeeds = Array.isArray(seeds) ? seeds.filter(item => item?.node?.id) : [];
        if (!sourceSeeds.length) return [];
        const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map(node => [String(node.id), node]));
        const seedIds = new Set(sourceSeeds.map(item => String(item.node.id)));
        const style = Object.prototype.hasOwnProperty.call(ACTIVATION_PERSONALITY_WEIGHTS, options.style) ? options.style : 'emotional';
        const weights = ACTIVATION_PERSONALITY_WEIGHTS[style];
        const maxExpand = Math.max(0, Math.min(ACTIVATION_MAX_EXPAND, Math.floor(Number(options.maxExpand) || ACTIVATION_MAX_EXPAND)));
        const decay = Math.max(0, Math.min(1, Number(options.decay) || ACTIVATION_DECAY));
        if (!maxExpand) return [...sourceSeeds];
        const activated = new Map();
        for (const seed of sourceSeeds) {
            const seedScore = Math.max(0, Number(seed.score ?? seed.finalScore) || 0);
            for (const link of Array.isArray(links) ? links : []) {
                const sourceId = String(link.sourceId || '');
                const targetId = String(link.targetId || '');
                if (sourceId !== String(seed.node.id) && targetId !== String(seed.node.id)) continue;
                const neighborId = sourceId === String(seed.node.id) ? targetId : sourceId;
                if (!neighborId || seedIds.has(neighborId)) continue;
                const node = nodeMap.get(neighborId);
                if (!node || node.archived) continue;
                const typeWeight = Number(weights[link.type]) || 0.2;
                const activationScore = seedScore * Math.max(0, Math.min(1, Number(link.strength) || 0)) * typeWeight * decay;
                if (activationScore > (activated.get(neighborId)?.score || 0)) activated.set(neighborId, { node, score: activationScore });
            }
        }
        const expanded = [...activated.values()].sort((left, right) => right.score - left.score).slice(0, maxExpand)
            .map(item => ({ node: item.node, score: item.score, similarity: 0, lexical: 0, activation: true }));
        return [...sourceSeeds, ...expanded];
    }

    function nodeEventTimestamp(node) {
        const source = node?.source || {};
        return Math.max(0, Number(source.endTimestamp) || Number(source.startTimestamp) || Number(node?.createdAt) || 0);
    }

    function sharedEntities(left, right) {
        const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
        const generic = new Set(['我', '你', '他', '她', '它', '用户', '角色', '对方', 'ta', 'user', 'assistant']);
        const leftSet = new Set((left?.entities || []).map(normalize).filter(entity => entity && !generic.has(entity)));
        return (right?.entities || []).map(normalize).filter(entity => entity && !generic.has(entity) && leftSet.has(entity));
    }

    function buildAutomaticLinks(newNodes, existingNodes, existingLinks = []) {
        const linkLimit = 20;
        const fresh = Array.isArray(newNodes) ? newNodes : [];
        const old = Array.isArray(existingNodes) ? existingNodes : [];
        const known = new Set((existingLinks || []).map(link => linkKey(link.sourceId, link.targetId, link.type)));
        const degrees = new Map();
        (existingLinks || []).filter(link => link.origin !== 'manual').forEach(link => {
            degrees.set(String(link.sourceId), (degrees.get(String(link.sourceId)) || 0) + 1);
            degrees.set(String(link.targetId), (degrees.get(String(link.targetId)) || 0) + 1);
        });
        const results = [];
        const add = (left, right, type, strength) => {
            if (!left?.id || !right?.id || left.id === right.id || left.characterId !== right.characterId) return;
            if ((degrees.get(String(left.id)) || 0) >= linkLimit || (degrees.get(String(right.id)) || 0) >= linkLimit) return;
            const key = linkKey(left.id, right.id, type);
            if (known.has(key)) return;
            known.add(key);
            const [sourceId, targetId] = String(left.id) < String(right.id) ? [left.id, right.id] : [right.id, left.id];
            results.push(normalizeLink({ characterId: left.characterId, sourceId, targetId, type, strength, origin: 'automatic' }));
            degrees.set(String(left.id), (degrees.get(String(left.id)) || 0) + 1);
            degrees.set(String(right.id), (degrees.get(String(right.id)) || 0) + 1);
        };
        fresh.forEach((node, index) => {
            [...old, ...fresh.slice(index + 1)].map(other => {
                const sameBatch = node?.source?.type === 'auto_archive' && node.source.batchId && node.source.batchId === other?.source?.batchId;
                const distance = Math.abs(nodeEventTimestamp(node) - nodeEventTimestamp(other));
                const entities = sharedEntities(node, other);
                const sameEventBox = node.eventBoxId && node.eventBoxId === other?.eventBoxId;
                return { other, sameBatch, distance, entities, sameEventBox };
            }).sort((left, right) => Number(right.sameEventBox) - Number(left.sameEventBox)
                || Number(right.sameBatch) - Number(left.sameBatch)
                || left.distance - right.distance
                || right.entities.length - left.entities.length).forEach(({ other, sameBatch, distance, entities, sameEventBox }) => {
                const bothArchived = node?.source?.type === 'auto_archive' && other?.source?.type === 'auto_archive';
                if (sameEventBox) add(node, other, 'temporal', 0.7);
                else if (sameBatch || (bothArchived && distance < 24 * 60 * 60 * 1000)) add(node, other, 'temporal', sameBatch ? 0.5 : 0.3);
                const historyEvidence = [node,other].every(n=>n?.source?.type==='history_archive' && n.source.startTimestamp>0);
                if (!sameEventBox && historyEvidence && distance < 24*60*60*1000 && entities.length) add(node,other,'temporal',0.3);
                if (entities.length) add(node, other, 'person', 0.6);
            });
        });
        return results;
    }

    function normalizeNode(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const now = options.now || Date.now();
        const room = Object.prototype.hasOwnProperty.call(ROOMS, source.room) ? source.room : 'living_room';
        return {
            id: String(source.id || id('mpn')),
            characterId: String(source.characterId || options.characterId || ''),
            content: String(source.content || '').trim(),
            room,
            layer: ['episodes', 'facts', 'states', 'relations', 'knowledge', 'cognition', 'intentions'].includes(source.layer) ? source.layer : ({ user_room: 'facts', study: 'knowledge', self_room: 'cognition', windowsill: 'intentions' }[room] || 'episodes'),
            owner: String(source.owner || source.characterId || options.characterId || ''),
            subject: String(source.subject || 'unspecified').slice(0, 160),
            confidence: source.confidence == null ? 1 : Math.min(1, Math.max(0, Number(source.confidence) || 0)),
            validUntil: Number.isFinite(Number(source.validUntil)) && source.validUntil != null ? Number(source.validUntil) : null,
            factKey: String(source.factKey || '').slice(0, 160),
            conflictGroup: String(source.conflictGroup || '').slice(0, 200),
            archived: source.archived === true,
            archiveReason: String(source.archiveReason || ''),
            representativeId: String(source.representativeId || ''),
            sourceNodeIds: normalizeStringList(source.sourceNodeIds),
            revision: Math.max(0, Number(source.revision) || 0),
            tags: normalizeStringList(source.tags),
            entities: normalizeStringList(source.entities),
            importance: Math.min(10, Math.max(1, Number(source.importance) || 5)),
            mood: String(source.mood || '').trim().slice(0, 40),
            pinned: source.pinned === true,
            embedded: source.embedded === true,
            embeddingProfileKey: String(source.embeddingProfileKey || ''),
            contentHash: String(source.contentHash || memoryFingerprint(source.content || '')),
            source: source.source && typeof source.source === 'object' ? { ...source.source } : { type: 'manual' },
            eventBoxId: source.eventBoxId ? String(source.eventBoxId) : null,
            createdAt: Number(source.createdAt) || now,
            updatedAt: Number(source.updatedAt) || now,
            lastAccessedAt: Number(source.lastAccessedAt) || now,
            accessCount: Math.max(0, Number(source.accessCount) || 0),
        };
    }

    function tokenize(value) {
        const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase();
        const tokens = [];
        const words = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
        words.forEach(word => {
            tokens.push(word);
            if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 1) {
                for (let index = 0; index < word.length - 1; index += 1) tokens.push(word.slice(index, index + 2));
            }
        });
        return tokens;
    }

    function bm25(nodes, query) {
        const queryTokens = [...new Set(tokenize(query))];
        if (!queryTokens.length || !nodes.length) return new Map();
        const documents = nodes.map(node => tokenize(`${node.content}\n${node.tags.join(' ')}\n${node.entities.join(' ')}`));
        const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, documents.length);
        const scores = new Map();
        queryTokens.forEach(token => {
            const documentFrequency = documents.filter(tokens => tokens.includes(token)).length;
            const inverseFrequency = Math.log(1 + (nodes.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
            documents.forEach((tokens, index) => {
                const frequency = tokens.filter(item => item === token).length;
                if (!frequency) return;
                const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * tokens.length / Math.max(1, averageLength));
                scores.set(nodes[index].id, (scores.get(nodes[index].id) || 0) + inverseFrequency * frequency * 2.2 / denominator);
            });
        });
        const maximum = Math.max(0, ...scores.values());
        if (maximum > 0) scores.forEach((score, key) => scores.set(key, score / maximum));
        return scores;
    }

    function cosine(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
        let dot = 0, normLeft = 0, normRight = 0;
        for (let index = 0; index < left.length; index += 1) {
            const a = Number(left[index]) || 0;
            const b = Number(right[index]) || 0;
            dot += a * b; normLeft += a * a; normRight += b * b;
        }
        return normLeft && normRight ? dot / Math.sqrt(normLeft * normRight) : 0;
    }

    function hybridSearch(nodes, vectors, query, queryVector, options = {}) {
        const now = options.now || Date.now();
        const lexicalScores = bm25(nodes, query);
        const vectorMap = new Map((vectors || []).map(item => [item.memoryId, item]));
        return nodes.map(node => {
            const vectorRecord = vectorMap.get(node.id);
            const similarity = vectorRecord && queryVector ? Math.max(0, cosine(queryVector, vectorRecord.vector)) : 0;
            const lexical = lexicalScores.get(node.id) || 0;
            const relevance = queryVector ? similarity * 0.85 + lexical * 0.15 : lexical;
            const ageDays = Math.max(0, (now - node.updatedAt) / 86400000);
            const recency = Math.exp(-ageDays / 90);
            const importance = node.importance / 10;
            const [relevanceWeight, recencyWeight, importanceWeight] = ROOM_WEIGHTS[node.room] || ROOM_WEIGHTS.living_room;
            const score = relevance * relevanceWeight + recency * recencyWeight + importance * importanceWeight + (node.pinned ? 0.35 : 0);
            return { node, score, similarity, lexical };
        }).filter(item => item.node.pinned || item.score >= (options.threshold ?? 0.08))
            .sort((left, right) => right.score - left.score || right.node.updatedAt - left.node.updatedAt)
            .slice(0, options.limit || 12);
    }

    function formatContext(results, limit = 8) {
        const selected = (results || []).slice(0, limit);
        if (!selected.length) return '';
        const lines = selected.map(item => {
            const node = item.node || item;
            const room = ROOMS[node.room] || ROOMS.living_room;
            const date = new Date(node.createdAt).toLocaleDateString('zh-CN');
            return `**[${room.label} · ${room.description}]** (${date}，重要性 ${node.importance}${node.pinned ? '，已固定' : ''})\n${node.content}`;
        });
        return `【记忆宫殿】\n以下是与当前对话相关的长期记忆。它们是背景约束，不要无关地复述，也不要补写未记录的事实。\n\n${lines.join('\n\n')}`.slice(0, 6000);
    }

    global.MemoryPalaceCore = {
        ROOMS, ROOM_WEIGHTS, AUTO_ARCHIVE_PRESETS, AUTO_ARCHIVE_PROCESS_RATIO, LINK_TYPES, EVENT_BOX_STATUSES,
        ROOM_PLATE_ROOMS, ROOM_PLATE_TITLES, ROOM_PLATE_CAPS, ROOM_PLATE_ENTRY_HARD_MAX_CHARS,
        ANTICIPATION_STATUSES, ANTICIPATION_ANCHOR_AFTER_MS,
        DIGEST_REPORT_TRIGGERS, DIGEST_REPORT_KEEP,
        ACTIVATION_DECAY, ACTIVATION_MAX_EXPAND, ACTIVATION_PERSONALITY_WEIGHTS,
        id, normalizeNode, normalizeEventBox, normalizeRoomPlateEntry, normalizeRoomPlate, normalizeAnticipation, advanceAnticipation, normalizeDigestReportSection, normalizeDigestReport, normalizeStringList, normalizeArchiveState, resolveWaterline,
        selectArchiveWindow, planHistoryArchive, memoryFingerprint, linkKey, normalizeLink, buildAutomaticLinks, spreadingActivation,
        tokenize, bm25, cosine, hybridSearch, formatContext
    };
})(typeof window !== 'undefined' ? window : globalThis);
