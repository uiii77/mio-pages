(function attachCoupleSpaceCore(global) {
    'use strict';

    const VERSION = 1;
    const STATUSES = new Set(['none', 'invited', 'active', 'rejected', 'paused', 'ended']);
    const KINDS = new Set(['anniversary', 'note', 'wish', 'milestone']);
    const OWNERS = new Set(['shared', 'user', 'character']);
    const ITEM_STATUSES = new Set(['open', 'done']);
    const LABELS = Object.freeze({
        none: '尚未建立', invited: '等待确认', active: '进行中', rejected: '已拒绝',
        paused: '已暂停', ended: '已解除', anniversary: '纪念日', note: '共同便签',
        wish: '愿望', milestone: '里程碑', open: '进行中', done: '已完成'
    });

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
    const timestamp = value => Number.isFinite(Number(value)) ? Number(value) : 0;

    function validDate(value) {
        const date = String(value || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        const parsed = new Date(`${date}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
    }

    function spaceId(characterId) {
        return `couple-space:${String(characterId || '').trim()}`;
    }

    function normalizeSpace(value, characterId = '') {
        const source = value && typeof value === 'object' ? value : {};
        const resolvedCharacterId = String(source.characterId || characterId || '').trim();
        const status = STATUSES.has(source.status) ? source.status : 'none';
        const now = Date.now();
        return {
            schemaVersion: VERSION,
            id: String(source.id || spaceId(resolvedCharacterId)),
            characterId: resolvedCharacterId,
            status,
            createdAt: timestamp(source.createdAt) || now,
            invitedAt: timestamp(source.invitedAt),
            startedAt: timestamp(source.startedAt),
            pausedAt: timestamp(source.pausedAt),
            endedAt: timestamp(source.endedAt),
            updatedAt: timestamp(source.updatedAt) || now,
            updatedBy: 'user'
        };
    }

    function normalizeItem(value, fallback = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const characterId = String(source.characterId || fallback.characterId || '').trim();
        const kind = KINDS.has(source.kind) ? source.kind : (KINDS.has(fallback.kind) ? fallback.kind : 'note');
        const owner = OWNERS.has(source.owner) ? source.owner : 'shared';
        return {
            schemaVersion: VERSION,
            id: String(source.id || fallback.id || ''),
            characterId,
            spaceId: String(source.spaceId || fallback.spaceId || spaceId(characterId)),
            kind,
            title: text(source.title ?? fallback.title, 120),
            body: text(source.body ?? fallback.body, 4000),
            date: validDate(source.date) ? String(source.date) : (validDate(fallback.date) ? String(fallback.date) : ''),
            owner,
            status: ITEM_STATUSES.has(source.status) ? source.status : 'open',
            createdAt: timestamp(source.createdAt) || Date.now(),
            updatedAt: timestamp(source.updatedAt) || Date.now(),
            updatedBy: 'user'
        };
    }

    function emptyItem(characterId, kind = 'note') {
        return normalizeItem({ id: '', characterId, kind, spaceId: spaceId(characterId), title: '', body: '', date: '', owner: 'shared', status: 'open' });
    }

    function transition(value, action, at = Date.now()) {
        const space = normalizeSpace(value);
        const time = timestamp(at) || Date.now();
        const next = { ...space };
        const current = space.status;
        if (action === 'invite' && ['none', 'rejected', 'ended'].includes(current)) {
            next.status = 'invited'; next.invitedAt = time; next.endedAt = 0;
        } else if (action === 'accept' && current === 'invited') {
            next.status = 'active'; next.startedAt = next.startedAt || time;
        } else if (action === 'reject' && current === 'invited') {
            next.status = 'rejected';
        } else if (action === 'pause' && current === 'active') {
            next.status = 'paused'; next.pausedAt = time;
        } else if (action === 'resume' && current === 'paused') {
            next.status = 'active'; next.pausedAt = 0;
        } else if (action === 'end' && ['invited', 'active', 'paused'].includes(current)) {
            next.status = 'ended'; next.endedAt = time;
        } else {
            return { ok: false, reason: 'invalid-transition', space };
        }
        next.updatedAt = time;
        return { ok: true, reason: '', space: normalizeSpace(next) };
    }

    function canEdit(status) { return status === 'active'; }

    function sortItems(items) {
        return (Array.isArray(items) ? items : []).map(item => normalizeItem(item)).sort((a, b) => {
            const dateA = a.date || '0000-00-00';
            const dateB = b.date || '0000-00-00';
            return dateB.localeCompare(dateA) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
        });
    }

    function createItem(value, id, at = Date.now()) {
        const source = { ...(value || {}), id, createdAt: timestamp(value?.createdAt) || at, updatedAt: at };
        return normalizeItem(source);
    }

    global.CoupleSpaceCore = Object.freeze({
        VERSION, STATUSES: [...STATUSES], KINDS: [...KINDS], OWNERS: [...OWNERS], ITEM_STATUSES: [...ITEM_STATUSES], LABELS,
        validDate, spaceId, normalizeSpace, normalizeItem, emptyItem, transition, canEdit, sortItems, createItem, clone
    });
})(window);
