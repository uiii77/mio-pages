// All inputs are decoded backups with category wrappers expanded. No storage or UI calls.
(function (global) {
    'use strict';
    const versionsKey = 'mioBackupMergeVersionsV1';
    const chats = new Set(['characters', 'groups']);
    const worldBookBindings = new Set(['worldBookIds', 'offlineWorldBookIds', 'journalWorldBookIds', 'charTheaterWorldBookIds', 'styleWorldBookIds']);
    const contentLists = new Set(['theaterScenarios', 'theaterHtmlScenarios', 'pomodoroRecords', 'pomodoroTasks',
        'favorites', 'chatFolders', 'userTimeline', 'novelAiStudioWorks', 'forumPosts', 'forumMessages', 'forumFriendRequests',
        'forumAltAccounts', 'forumKnowledge', 'forumSocialEdges', 'forumStoryThreads', 'forumEvents', 'forumNotifications', 'forumDrafts']);
    const protectedChatFields = new Set(['walletLedger', 'reminders']);
    const moneyFields = ['transferStatus', 'payStatus', 'shopPaymentStatus', 'shopOrderId', 'shopPaymentSource', 'familyCardStatus',
        'receivedFamilyCardStatus', 'familyCardActionProcessed', 'economyTransferId', 'commerceBatchId', 'commerceOrderIds'];
    const record = value => !!value && Object.prototype.toString.call(value) === '[object Object]';
    const validId = id => (typeof id === 'string' && !!id.trim()) || (typeof id === 'number' && Number.isFinite(id));
    const set = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
    const isMoney = message => moneyFields.some(field => Object.hasOwn(message, field)) || message.isTransfer || message.type === 'transfer';
    function contentId(key, row) {
        if (validId(row?.id)) return row.id;
        if (key.endsWith('Presets')) return row?.name;
        if (key === 'forumStoryThreads') return row?.key;
    }
    function membersById(members) {
        if (!Array.isArray(members) || !members.every(member => record(member) && validId(member.id))) return null;
        const map = new Map(members.map(member => [member.id, member]));
        return map.size === members.length ? map : null;
    }

    // Type tags distinguish record content from binary buffers, scalar keys and array ordering.
    function signature(value) {
        function normalized(item) {
            if (item === undefined) return ['undefined'];
            if (item === null || typeof item !== 'object') return item;
            if (Array.isArray(item)) return ['array', item.map(normalized)];
            if (record(item)) return ['object', Object.keys(item).sort().map(key => [key, normalized(item[key])])];
            if (item instanceof Date) return ['date', item.toISOString()];
            if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
                const bytes = item instanceof ArrayBuffer ? new Uint8Array(item) : new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
                return [item.constructor.name, Array.from(bytes)];
            }
            throw new TypeError('含有无法安全比较的数据类型');
        }
        return JSON.stringify(normalized(value));
    }
    const equal = (a, b) => a === b || signature(a) === signature(b);
    function messageTime(message) {
        const raw = message.timestamp;
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.trim()) {
            const number = Number(raw);
            if (Number.isFinite(number)) return number;
            const parsed = Date.parse(raw);
            if (Number.isFinite(parsed)) return parsed;
        }
        return Infinity;
    }

    function messageHash(text) {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        return (hash >>> 0).toString(36);
    }

    function mergeHistory(slices, collision) {
        const names = new Map(), used = new Map(), alternatives = new Map(), anonymous = new Map(), output = [];
        for (const { messages } of slices) for (const message of messages) {
            if (validId(message.id)) names.set(message.id, message);
        }
        for (const { messages, source } of slices) {
            const counts = new Map();
            for (const message of messages) {
                const { id, ...payload } = message;
                if (!validId(id)) {
                    const mark = signature(message), count = (counts.get(mark) || 0) + 1;
                    counts.set(mark, count);
                    if (count <= (anonymous.get(mark) || 0)) continue;
                    anonymous.set(mark, count);
                    output.push(message);
                    continue;
                }
                if (!used.has(id)) {
                    used.set(id, message);
                    output.push(message);
                    continue;
                }
                const earlier = used.get(id);
                if (equal(earlier, message)) continue;
                collision(id, source, isMoney(earlier) || isMoney(message));
                const mark = signature(payload);
                let byPayload = alternatives.get(id);
                if (!byPayload) { byPayload = new Map(); alternatives.set(id, byPayload); }
                if (byPayload.has(mark)) continue;
                // The deterministic name recognizes a previously merged copy. Verify content even on a hash collision.
                const base = String(id) + '~mio-merge-' + messageHash(mark);
                let name = base, suffix = 1;
                while (used.has(name) || names.has(name)) {
                    const existing = used.get(name) || names.get(name);
                    if (equal(existing, { ...message, id: name })) break;
                    name = base + '-' + ++suffix;
                }
                byPayload.set(mark, name);
                if (!used.has(name)) {
                    const copy = { ...message, id: name };
                    used.set(name, copy);
                    output.push(copy);
                }
            }
        }
        // Modern ECMAScript sort is stable. Equal or missing timestamps keep source and history order.
        return output.sort((left, right) => messageTime(left) - messageTime(right));
    }

    function checkMessageReferences(data, ambiguousMessages, source = '当前数据') {
        if (!ambiguousMessages.length) return null;
        const byId = new Map(), owners = new Map();
        for (const item of ambiguousMessages) {
            const id = String(item.id);
            if (!byId.has(id)) byId.set(id, []);
            byId.get(id).push(item);
            owners.set((item.key === 'groups' ? 'group' : 'private') + ':' + item.chatId + ':' + id, item);
        }
        let conflict = null;
        function visit(value, field, key, chatId) {
            if (conflict) return;
            if (Array.isArray(value)) {
                for (const item of value) visit(item, field, key, chatId);
            } else if (record(value)) {
                const owner = value.chatId ?? value.characterId ?? chatId;
                if (value.ownerType === 'message' && owners.has(value.ownerId)) {
                    const item = owners.get(value.ownerId);
                    conflict = { source, key, reason: '消息 ID 冲突，附件所有者引用无法区分', id: item.id, field: 'ownerId' };
                }
                for (const [name, child] of Object.entries(value)) visit(child, name, key, owner);
            } else if (validId(value) && /(?:(?:message|msg|history)(?:id|ids)|replyto|quotedid)$/i.test(field)) {
                const match = (byId.get(String(value)) || []).some(item => chatId == null || String(item.chatId) === String(chatId));
                if (match) conflict = { source, key, reason: '消息 ID 冲突，已有引用无法区分', id: value, field };
            }
        }
        for (const [key, value] of Object.entries(data)) {
            if (key === versionsKey) continue;
            if (chats.has(key) && Array.isArray(value)) {
                for (const chat of value) visit(chat, '', key, chat.id);
            } else visit(value, '', key, null);
            if (conflict) break;
        }
        return conflict;
    }

    function mergeBackupSources(sources, { tableKeys = {}, protectedKeys = [] } = {}) {
        const data = {}, variants = [], conflicts = [], versionIds = new Set(), conflictIds = new Set();
        const tables = new Map(), chatHistories = new Map(), ambiguous = new Map();
        const protectedSet = new Set(protectedKeys);
        const financialTables = [...protectedSet].filter(key => Object.hasOwn(tableKeys, key));
        const indexedLists = new Map();
        const failed = () => ({ ok: false, data: null, variants: [], conflicts });
        function reject(source, key, reason, id, field) {
            const item = { source, key, reason };
            if (id !== undefined) item.id = id;
            if (field !== undefined) item.field = field;
            const identity = signature(item);
            if (!conflictIds.has(identity)) { conflictIds.add(identity); conflicts.push(item); }
        }
        function version(source, key, value, id, field) {
            const row = { key, value };
            if (id !== undefined) row.id = id;
            if (field !== undefined) row.field = field;
            const identity = signature(row);
            if (!versionIds.has(identity)) { versionIds.add(identity); variants.push({ ...row, source }); }
        }
        function mergeChat(key, id, row, target, label) {
            const identity = signature([key, id]);
            if (!chatHistories.has(identity)) chatHistories.set(identity, { key, id, target, slices: [] });
            if (Object.hasOwn(row, 'history')) {
                if (!Array.isArray(row.history) || row.history.some(message => !record(message))) {
                    reject(label, key, '聊天记录格式不完整', id, 'history');
                } else chatHistories.get(identity).slices.push({ source: label, messages: row.history });
            }
            for (const [field, value] of Object.entries(row)) {
                if (field === 'history' || field === '_chatSaveRevision') continue;
                if (!Object.hasOwn(target, field)) set(target, field, value);
                else if (key === 'groups' && field === 'members') {
                    const existing = membersById(target.members), incoming = membersById(value);
                    if (!existing || !incoming) {
                        if (!equal(target.members, value)) version(label, key, value, id, field);
                        continue;
                    }
                    let differing = false;
                    for (const [memberId, member] of incoming) {
                        if (!existing.has(memberId)) existing.set(memberId, member);
                        else if (!equal(existing.get(memberId), member)) differing = true;
                    }
                    if (differing) version(label, key, value, id, field);
                    target.members = [...existing.values()];
                } else if (worldBookBindings.has(field) && Array.isArray(target[field]) && Array.isArray(value)
                    && target[field].every(validId) && value.every(validId)) {
                    set(target, field, [...new Set([...target[field], ...value])]);
                } else if (!equal(target[field], value)) {
                    if (protectedChatFields.has(field)) reject(label, key, '钱包或提醒状态不一致', id, field);
                    else version(label, key, value, id, field);
                }
            }
        }
        function mergeTable(key, rows, primaryKey, label) {
            if (!Array.isArray(rows)) { reject(label, key, '应为数据表记录列表'); return; }
            if (!tables.has(key)) tables.set(key, new Map());
            const entries = tables.get(key);
            for (const row of rows) {
                const id = primaryKey ? row?.[primaryKey] : contentId(key, row);
                if (!record(row) || !validId(id)) { reject(label, key, '记录缺少有效主键', undefined, primaryKey); continue; }
                if (chats.has(key)) {
                    if (!entries.has(id)) entries.set(id, {});
                    mergeChat(key, id, row, entries.get(id), label);
                } else if (!entries.has(id)) entries.set(id, row);
                else if (!equal(entries.get(id), row)) {
                    if (protectedSet.has(key)) reject(label, key, '账务记录不一致', id);
                    else version(label, key, row, id);
                }
            }
        }
        // Never form a new ledger by combining independent bundles, even when their row IDs are disjoint.
        function financeIdentity(source) {
            return signature(financialTables.map(key => {
                const rows = source[key] || [];
                const signatures = rows.map(row => signature(row)).sort();
                return [key, signatures];
            }));
        }
        if (!Array.isArray(sources) || sources.length < 2) {
            reject('', '', '合并至少需要两个数据来源');
            return failed();
        }
        let context = '', currentKey = '', financial;
        try {
            // Some legacy settings (e.g. presets) have different shapes. Use a keyed list only when
            // every source has recognizable row identities; otherwise retain the whole alternate value.
            for (const source of sources) for (const [key, value] of Object.entries(source?.data || {})) {
                if (contentLists.has(key) || key.endsWith('Presets')) {
                    const usable = Array.isArray(value) && value.every(row => record(row) && validId(contentId(key, row)));
                    indexedLists.set(key, indexedLists.get(key) !== false && usable);
                }
            }
            for (const [index, source] of sources.entries()) {
                context = source?.label || ('来源 ' + (index + 1));
                if (!record(source?.data)) { reject(context, '', '备份内容格式错误'); continue; }
                const input = source.data;
                if (financialTables.some(key => Array.isArray(input[key]) && input[key].length)) {
                    const bundle = financeIdentity(input);
                    if (financial !== undefined && financial !== bundle) reject(context, 'economy', '账务记录属于不同快照，无法合并');
                    else financial = bundle;
                }
                for (const [key, value] of Object.entries(input)) {
                    currentKey = key;
                    if (key === versionsKey) {
                        if (!Array.isArray(value)) { reject(context, key, '历史版本格式无效'); continue; }
                        for (const prior of value) {
                            if (!record(prior) || typeof prior.key !== 'string' || !Object.hasOwn(prior, 'value')) {
                                reject(context, key, '历史版本格式无效');
                            } else version(prior.source || context, prior.key, prior.value, prior.id, prior.field);
                        }
                    } else if (Object.hasOwn(tableKeys, key)) mergeTable(key, value, tableKeys[key], context);
                    else if (indexedLists.get(key)) mergeTable(key, value, null, context);
                    else if (!Object.hasOwn(data, key)) set(data, key, value);
                    else if (!equal(data[key], value)) {
                        if (protectedSet.has(key)) reject(context, key, '资金或受保护设置不一致');
                        else version(context, key, value);
                    }
                }
            }
            if (conflicts.length) return failed();
            for (const { key, id: chatId, target, slices } of chatHistories.values()) {
                currentKey = key;
                target.history = mergeHistory(slices, (id, source, money) => {
                    if (money) reject(source, key, '涉及资金的消息状态不一致', chatId, 'history');
                    ambiguous.set(signature([key, chatId, id]), { key, chatId, id });
                });
            }
            const ambiguousMessages = [...ambiguous.values()];
            for (const { data: input, label } of sources) {
                const issue = checkMessageReferences(input, ambiguousMessages, label);
                if (issue) conflicts.push(issue);
            }
            if (conflicts.length) return failed();
            for (const [key, entries] of tables) set(data, key, [...entries.values()]);
            if (variants.length) set(data, versionsKey, variants);
            const result = structuredClone(data);
            return { ok: true, data: result, variants: result[versionsKey] || [], conflicts, ambiguousMessages };
        } catch (error) {
            if (!(error instanceof TypeError || error.name === 'DataCloneError')) throw error;
            reject(context, currentKey, '包含无法安全解析、比较或复制的记录');
            return failed();
        }
    }

    global.BackupMerge = Object.freeze({ mergeBackupSources, checkMessageReferences, isFinancialMessage: isMoney });
})(typeof window !== 'undefined' ? window : globalThis);
