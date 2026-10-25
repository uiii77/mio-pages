(function attachLifeContextCore(global) {
    'use strict';

    // Phase 5E-1: a storage- and provider-neutral contract for shared life
    // material, local retrieval and continuity checks.  Importers, Dexie
    // persistence and model/network adapters are deliberately separate.
    const VERSION = 1;
    const PACK_SCHEMA_VERSION = '1.0';
    const MAX = Object.freeze({
        id: 160, name: 160, text: 6000, list: 32, tags: 48, keywords: 32,
        sources: 48, domains: 16, events: 120, evidence: 24, contextChars: 2400,
        rawText: 500000,
    });
    const PACK_STATUSES = Object.freeze(['draft', 'active', 'archived']);
    const REVIEW_STATUSES = Object.freeze(['unreviewed', 'source-backed', 'approved', 'rejected']);
    const VERIFICATION_STATUSES = Object.freeze(['unverified', 'verified', 'conflict', 'skipped']);
    const SOURCE_STATES = Object.freeze(['active', 'withdrawn']);
    const SUBSCRIPTION_STATES = Object.freeze(['active', 'paused', 'withdrawn']);
    const SOURCE_KINDS = Object.freeze(['book', 'article', 'archive', 'web', 'import', 'document']);
    const EVENT_STATUSES = Object.freeze(['planned', 'committed', 'observed', 'cancelled']);
    const EVENT_TRANSITIONS = Object.freeze({
        planned: Object.freeze(['committed', 'observed', 'cancelled']),
        committed: Object.freeze(['observed', 'cancelled']),
        observed: Object.freeze([]),
        cancelled: Object.freeze([]),
    });

    function cleanText(value, max = MAX.text) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function cleanId(value, fallback = '') {
        return cleanText(value, MAX.id).replace(/[^\w.:/@-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
    }

    function list(value, max = MAX.list) {
        const values = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
        return [...new Set(values.map(item => cleanText(item, 120)).filter(Boolean))].slice(0, max);
    }

    function normalizePackCards(value, packId) {
        return (Array.isArray(value) ? value : []).slice(0, 64).map((card, index) => {
            const source = card && typeof card === 'object' ? card : {};
            return {
                id: cleanId(source.id, `card:${packId || 'pack'}:${index}`),
                packId: cleanId(source.packId || packId),
                title: cleanText(source.title || source.name, MAX.name),
                kind: cleanText(source.kind || 'fact', 48),
                text: cleanText(source.text || source.content, 1800),
                tags: list(source.tags, MAX.tags),
                sourceIds: list(source.sourceIds || source.sourceId, MAX.evidence),
                dateRange: dateRange(source.dateRange || { from: source.dateFrom, to: source.dateTo }),
                regions: list(source.regions),
                cultures: list(source.cultures),
                domains: list(source.domains, MAX.domains),
                confidence: number(source.confidence, null, 0, 1),
                generatedBy: cleanText(source.generatedBy, 80),
                citation: cleanText(source.citation, 1000),
                sourceUrl: cleanText(source.sourceUrl || source.url, 800),
                needsSource: source.needsSource === true,
                verificationStatus: enumValue(source.verificationStatus, VERIFICATION_STATUSES, 'unverified'),
                verificationProvider: cleanText(source.verificationProvider, 120),
                verificationCheckedAt: number(source.verificationCheckedAt, null, 0),
                verificationNotes: cleanText(source.verificationNotes, 1000),
                verificationQuote: cleanText(source.verificationQuote, 1200),
                sourceState: enumValue(source.sourceState, SOURCE_STATES, 'active'),
                sourceSubscriptionId: cleanId(source.sourceSubscriptionId || source.subscriptionId),
                sourceWithdrawnAt: number(source.sourceWithdrawnAt, null, 0),
                sourceWithdrawReason: cleanText(source.sourceWithdrawReason, 400),
                createdAt: number(source.createdAt, null, 0),
                updatedAt: number(source.updatedAt, null, 0),
                revision: number(source.revision, 0, 0, 1000000),
                reviewStatus: enumValue(source.reviewStatus, REVIEW_STATUSES, 'unreviewed'),
            };
        }).filter(card => card.text || card.title);
    }

    function enumValue(value, values, fallback) {
        return values.includes(value) ? value : fallback;
    }

    function number(value, fallback = null, min = 0, max = Number.MAX_SAFE_INTEGER) {
        if (value === null || value === '' || value === undefined || !Number.isFinite(Number(value))) return fallback;
        return Math.min(max, Math.max(min, Number(value)));
    }

    function dateParts(value) {
        const match = String(value || '').trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
        if (!match) return null;
        const year = Number(match[1]);
        const month = Number(match[2] || 1);
        const day = Number(match[3] || 1);
        if (month > 12 || day > 31) return null;
        const precision = match[3] ? 'day' : (match[2] ? 'month' : 'year');
        const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        let end = start;
        if (precision === 'year') end = `${year}-12-31`;
        if (precision === 'month') end = `${year}-${String(month).padStart(2, '0')}-31`;
        return { value: `${year}${precision === 'year' ? '' : `-${String(month).padStart(2, '0')}`}${precision === 'day' ? `-${String(day).padStart(2, '0')}` : ''}`, start, end, precision };
    }

    function normalizeDate(value) {
        return dateParts(value)?.value || '';
    }

    function dateRange(value) {
        const source = value && typeof value === 'object' ? value : {};
        const from = dateParts(source.from || source.start || value);
        const to = dateParts(source.to || source.end || value);
        if (!from && !to) return { from: '', to: '' };
        return { from: from?.value || to.value, to: to?.value || from.value };
    }

    function sanitizeLifeSourceText(value, options = {}) {
        let text = String(value == null ? '' : value).replace(/\u0000/g, '');
        if (options.stripHtml === true) {
            text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
                .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
        }
        return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX.rawText);
    }

    function rangeOverlaps(range, target) {
        const left = dateRange(range);
        const right = dateRange(target);
        if (!left.from && !left.to) return true;
        if (!right.from && !right.to) return true;
        const leftStart = dateParts(left.from)?.start || left.from;
        const leftEnd = dateParts(left.to)?.end || left.to;
        const rightStart = dateParts(right.from)?.start || right.from;
        const rightEnd = dateParts(right.to)?.end || right.to;
        return leftStart <= rightEnd && rightStart <= leftEnd;
    }

    function normalizeSource(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const fileName = cleanText(source.fileName || source.name, 240);
        const mimeType = cleanText(source.mimeType || source.type, 120);
        const stripHtml = /html|xml/i.test(mimeType) || /\.(?:html?|xml)$/i.test(fileName);
        const rawText = sanitizeLifeSourceText(source.rawText || source.content || source.text, { stripHtml });
        return {
            id: cleanId(source.id, `source:${Date.now()}`),
            packId: cleanId(source.packId || options.packId),
            kind: enumValue(source.kind, SOURCE_KINDS, 'document'),
            title: cleanText(source.title, MAX.name),
            fileName,
            mimeType,
            rawText,
            dateRange: dateRange(source.dateRange || { from: source.dateFrom, to: source.dateTo }),
            regions: list(source.regions),
            cultures: list(source.cultures),
            socialContexts: list(source.socialContexts || source.contexts),
            domains: list(source.domains, MAX.domains),
            uri: cleanText(source.uri, 800),
            license: cleanText(source.license, 240),
            rightsStatus: cleanText(source.rightsStatus, 80),
            checksum: cleanText(source.checksum, 160),
            citation: cleanText(source.citation, 1000),
            sourceState: enumValue(source.sourceState, SOURCE_STATES, 'active'),
            subscriptionId: cleanId(source.subscriptionId || source.sourceSubscriptionId),
            sourceWithdrawnAt: number(source.sourceWithdrawnAt, null, 0),
            sourceWithdrawReason: cleanText(source.sourceWithdrawReason, 400),
            reviewStatus: enumValue(source.reviewStatus, REVIEW_STATUSES, 'unreviewed'),
            updatedAt: number(source.updatedAt, null, 0),
        };
    }

    function normalizeLifePackManifest(value) {
        const source = value && typeof value === 'object' ? value : {};
        const date = dateRange(source.dateRange || { from: source.dateFrom, to: source.dateTo });
        const policy = source.sourcePolicy && typeof source.sourcePolicy === 'object' ? source.sourcePolicy : {};
        const subscriptions = Array.isArray(source.sourceSubscriptions) ? source.sourceSubscriptions : [];
        return {
            id: cleanId(source.id),
            schemaVersion: cleanText(source.schemaVersion || PACK_SCHEMA_VERSION, 20),
            name: cleanText(source.name || source.title, MAX.name),
            version: cleanText(source.version || '1.0.0', 40),
            language: cleanText(source.language || 'und', 32),
            dateRange: date,
            regions: list(source.regions),
            cultures: list(source.cultures),
            socialContexts: list(source.socialContexts || source.contexts),
            domains: list(source.domains, MAX.domains),
            license: cleanText(source.license, 240),
            rights: source.rights && typeof source.rights === 'object' ? {
                holder: cleanText(source.rights.holder, 160),
                license: cleanText(source.rights.license || source.license, 240),
                attribution: cleanText(source.rights.attribution, 400),
                redistribution: cleanText(source.rights.redistribution, 240),
            } : { holder: '', license: cleanText(source.license, 240), attribution: '', redistribution: '' },
            sources: (Array.isArray(source.sources) ? source.sources : []).map(item => normalizeSource(item, { packId: source.id })).slice(0, MAX.sources),
            cards: normalizePackCards(source.cards, source.id),
            sourcePolicy: {
                requireHttps: policy.requireHttps !== false,
                allowedHosts: list(policy.allowedHosts, 24).map(item => item.toLowerCase()),
                cacheTtlMs: number(policy.cacheTtlMs, 86400000, 3600000, 2592000000),
            },
            sourceSubscriptions: subscriptions.slice(0, 24).map((item, index) => {
                const sub = item && typeof item === 'object' ? item : {};
                return {
                    id: cleanId(sub.id, `subscription:${source.id || 'pack'}:${index}`),
                    title: cleanText(sub.title || sub.name, 160),
                    url: cleanText(sub.url || sub.uri, 800),
                    enabled: sub.enabled !== false,
                    state: enumValue(sub.state, SUBSCRIPTION_STATES, 'active'),
                    intervalMs: number(sub.intervalMs, 86400000, 3600000, 2592000000),
                    lastCheckedAt: number(sub.lastCheckedAt, null, 0),
                    etag: cleanText(sub.etag, 240),
                    lastModified: cleanText(sub.lastModified, 120),
                    lastStatus: cleanText(sub.lastStatus, 80),
                    lastError: cleanText(sub.lastError, 240),
                    updatedAt: number(sub.updatedAt, null, 0),
                };
            }),
            taxonomy: list(source.taxonomy, MAX.domains),
            tests: list(source.tests, MAX.evidence),
            status: enumValue(source.status, PACK_STATUSES, 'draft'),
            createdAt: number(source.createdAt, null, 0),
            updatedAt: number(source.updatedAt, null, 0),
        };
    }

    function validateLifePackManifest(value) {
        const manifest = normalizeLifePackManifest(value);
        const errors = [];
        const warnings = [];
        if (!manifest.id) errors.push('manifest.id is required');
        if (!manifest.name) errors.push('manifest.name is required');
        if (!manifest.version) errors.push('manifest.version is required');
        if (manifest.dateRange.from && manifest.dateRange.to && dateParts(manifest.dateRange.from).start > dateParts(manifest.dateRange.to).end) errors.push('manifest.dateRange is reversed');
        if (!manifest.regions.length && !manifest.cultures.length) warnings.push('pack has no region or culture scope');
        if (!manifest.sources.length) warnings.push('pack has no source metadata');
        return { valid: errors.length === 0, errors, warnings, manifest };
    }

    function normalizeLifeChunk(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const range = dateRange(source.dateRange || { from: source.dateFrom, to: source.dateTo });
        return {
            id: cleanId(source.id, `chunk:${Date.now()}`),
            packId: cleanId(source.packId || options.packId),
            sourceId: cleanId(source.sourceId || options.sourceId),
            text: cleanText(source.text || source.content),
            dateRange: range,
            regions: list(source.regions),
            cultures: list(source.cultures),
            socialContexts: list(source.socialContexts || source.contexts),
            domains: list(source.domains, MAX.domains),
            tags: list(source.tags, MAX.tags),
            entities: list(source.entities, MAX.tags),
            sourceState: enumValue(source.sourceState, SOURCE_STATES, 'active'),
            sourceWithdrawnAt: number(source.sourceWithdrawnAt, null, 0),
            sourceWithdrawReason: cleanText(source.sourceWithdrawReason, 400),
            sourceStart: number(source.sourceStart, null, 0),
            sourceEnd: number(source.sourceEnd, null, 0),
            contentHash: cleanText(source.contentHash, 160),
            reviewStatus: enumValue(source.reviewStatus, REVIEW_STATUSES, 'unreviewed'),
            createdAt: number(source.createdAt, null, 0),
            updatedAt: number(source.updatedAt, null, 0),
            revision: number(source.revision, 0, 0, 1000000),
        };
    }

    function chunkLifeSourceText(sourceValue, options = {}) {
        const source = sourceValue && typeof sourceValue === 'object' ? normalizeSource(sourceValue, options) : normalizeSource({ rawText: sourceValue }, options);
        const text = source.rawText;
        if (!text) return [];
        const maxChars = Math.max(240, Math.min(3600, Number(options.maxChars) || 900));
        const overlap = Math.max(0, Math.min(Math.floor(maxChars / 3), Number(options.overlap) || 90));
        const chunks = [];
        let cursor = 0;
        while (cursor < text.length && chunks.length < 20000) {
            let end = Math.min(text.length, cursor + maxChars);
            if (end < text.length) {
                const boundary = text.slice(cursor + Math.floor(maxChars * 0.55), end).search(/[\n。！？!?；;.!?]/g);
                if (boundary >= 0) end = cursor + Math.floor(maxChars * 0.55) + boundary + 1;
            }
            const raw = text.slice(cursor, end);
            const leading = raw.search(/\S/);
            const trailing = raw.search(/\s*$/);
            const start = cursor + Math.max(0, leading);
            const finish = cursor + Math.max(start - cursor, trailing < 0 ? raw.length : trailing);
            const content = text.slice(start, finish).trim();
            if (content) {
                const now = Date.now();
                chunks.push(normalizeLifeChunk({
                    id: `${source.id}:${stableHash(`${source.id}:${start}:${content}`).slice(5)}`,
                    packId: source.packId || options.packId,
                    sourceId: source.id,
                    text: content,
                    dateRange: source.dateRange,
                    regions: source.regions,
                    cultures: source.cultures,
                    socialContexts: source.socialContexts,
                    domains: source.domains,
                    tags: options.tags || [],
                    sourceStart: start,
                    sourceEnd: finish,
                    contentHash: stableHash(content),
                    reviewStatus: options.reviewStatus || 'unreviewed',
                    createdAt: now,
                    updatedAt: now,
                }));
            }
            if (end >= text.length) break;
            const next = Math.max(cursor + 1, end - overlap);
            cursor = next;
        }
        return chunks;
    }

    function normalizeLifeEvent(value, options = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const status = enumValue(source.status, EVENT_STATUSES, 'planned');
        const startMinute = number(source.startMinute ?? source.start, 0, 0, 1439);
        const endMinute = number(source.endMinute ?? source.end, startMinute, 0, 1439);
        return {
            id: cleanId(source.id, `life-event:${Date.now()}`),
            characterId: cleanId(source.characterId || options.characterId),
            sceneId: cleanId(source.sceneId || options.sceneId),
            status,
            localDate: normalizeDate(source.localDate || source.date),
            startMinute,
            endMinute: Math.max(startMinute, endMinute),
            locationRef: cleanText(source.locationRef || source.location, 160),
            activity: cleanText(source.activity, 180),
            activityCategory: cleanText(source.activityCategory || source.category, 100),
            food: cleanText(source.food, 160),
            outfit: cleanText(source.outfit, 160),
            scenePurpose: cleanText(source.scenePurpose, 160),
            narrativePattern: cleanText(source.narrativePattern, 120),
            relationshipFunction: cleanText(source.relationshipFunction, 120),
            evidenceIds: list(source.evidenceIds, MAX.evidence),
            sourceIds: list(source.sourceIds, MAX.evidence),
            createdAt: number(source.createdAt, null, 0),
            updatedAt: number(source.updatedAt, null, 0),
            revision: number(source.revision, 0, 0, 1000000),
        };
    }

    function transitionLifeEvent(value, nextStatus, patch = {}) {
        const event = normalizeLifeEvent(value);
        if (!EVENT_STATUSES.includes(nextStatus)) return { ok: false, reason: 'invalid-status', event };
        if (nextStatus !== event.status && !EVENT_TRANSITIONS[event.status].includes(nextStatus)) return { ok: false, reason: 'invalid-transition', event };
        const next = normalizeLifeEvent({ ...event, ...patch, status: nextStatus, revision: event.revision + (nextStatus === event.status ? 0 : 1), updatedAt: Date.now() });
        return { ok: true, event: next };
    }

    function tokens(value) {
        const text = String(value || '').normalize('NFKC').toLowerCase();
        const found = new Set(text.match(/[a-z0-9]+|[\u3400-\u9fff\u3040-\u30ff]/g) || []);
        const cjk = [...text].filter(char => /[\u3400-\u9fff\u3040-\u30ff]/.test(char));
        for (let index = 0; index < cjk.length - 1; index += 1) found.add(cjk[index] + cjk[index + 1]);
        return [...found];
    }

    function normalizeLifeQuery(value) {
        const source = value && typeof value === 'object' ? value : {};
        return {
            date: normalizeDate(source.date),
            regions: list(source.regions || source.region),
            cultures: list(source.cultures || source.culture),
            socialContexts: list(source.socialContexts || source.socialContext),
            domains: list(source.domains, MAX.domains),
            keywords: list(source.keywords, MAX.keywords),
            tags: list(source.tags, MAX.tags),
            packIds: list(source.packIds || source.packId),
            includeUnreviewed: source.includeUnreviewed === true,
            limit: Math.min(50, Math.max(1, Math.floor(number(source.limit, 8, 1, 50)))),
        };
    }

    function overlaps(values, wanted) {
        if (!wanted.length) return true;
        const normalized = new Set(values.map(item => String(item).toLowerCase()));
        return wanted.some(item => normalized.has(String(item).toLowerCase()));
    }

    function isLifeChunkEligible(value, queryValue = {}) {
        const chunk = normalizeLifeChunk(value);
        const query = normalizeLifeQuery(queryValue);
        if (chunk.reviewStatus === 'rejected' || chunk.sourceState === 'withdrawn') return false;
        if (!query.includeUnreviewed && chunk.reviewStatus === 'unreviewed') return false;
        if (query.date && !rangeOverlaps(chunk.dateRange, query.date)) return false;
        if (query.packIds.length && !query.packIds.includes(chunk.packId)) return false;
        if (!overlaps(chunk.regions, query.regions) || !overlaps(chunk.cultures, query.cultures) || !overlaps(chunk.socialContexts, query.socialContexts)) return false;
        if (query.domains.length && !overlaps(chunk.domains, query.domains)) return false;
        if (query.tags.length && !overlaps(chunk.tags, query.tags)) return false;
        return true;
    }

    function retrieveLifeChunks(values, queryValue = {}, options = {}) {
        const query = normalizeLifeQuery(queryValue);
        const requestedTokens = tokens([...query.keywords, ...query.tags].join(' '));
        const rows = (Array.isArray(values) ? values : []).map(item => normalizeLifeChunk(item)).filter(chunk => isLifeChunkEligible(chunk, query));
        const scored = rows.map(chunk => {
            const haystack = tokens([chunk.text, ...chunk.tags, ...chunk.entities].join(' '));
            const matchedTokens = requestedTokens.filter(token => haystack.includes(token));
            let score = matchedTokens.length * 4;
            if (query.date && rangeOverlaps(chunk.dateRange, query.date)) score += 2;
            if (overlaps(chunk.domains, query.domains)) score += query.domains.length ? 2 : 0;
            if (chunk.reviewStatus === 'approved') score += 1;
            if (options.boostPackIds?.includes(chunk.packId)) score += 1;
            return { chunk, score, matchedTokens };
        });
        scored.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
        return { results: scored.slice(0, query.limit), eligibleCount: scored.length, query };
    }

    function canonical(value) {
        return cleanText(value, 160).normalize('NFKC').toLowerCase();
    }

    function eventFingerprint(value) {
        const event = normalizeLifeEvent(value);
        return {
            activity: canonical(event.activity),
            activityCategory: canonical(event.activityCategory),
            food: canonical(event.food),
            outfit: canonical(event.outfit),
            narrativePattern: canonical(event.narrativePattern),
            relationshipFunction: canonical(event.relationshipFunction),
        };
    }

    function summarizeLifeRepetition(values, options = {}) {
        const events = (Array.isArray(values) ? values : []).map(event => normalizeLifeEvent(event))
            .filter(event => !options.characterId || event.characterId === options.characterId)
            .filter(event => !options.sceneId || event.sceneId !== options.sceneId)
            .filter(event => options.includeCancelled === true || event.status !== 'cancelled')
            .slice(-Math.max(1, Math.min(MAX.events, Number(options.limit) || MAX.events)));
        const counts = {};
        for (const field of ['activity', 'activityCategory', 'food', 'outfit', 'narrativePattern', 'relationshipFunction']) {
            counts[field] = {};
            events.forEach(event => { const key = canonical(event[field]); if (key) counts[field][key] = (counts[field][key] || 0) + 1; });
        }
        const sequence = events.map(event => ({ date: event.localDate, activityCategory: event.activityCategory, activity: event.activity, narrativePattern: event.narrativePattern })).filter(item => item.activityCategory || item.activity || item.narrativePattern);
        const sequenceCounts = {};
        for (let index = 1; index < sequence.length; index += 1) {
            const key = [sequence[index - 1].activityCategory || canonical(sequence[index - 1].activity), sequence[index].activityCategory || canonical(sequence[index].activity)].filter(Boolean).join(' > ');
            if (key) sequenceCounts[key] = (sequenceCounts[key] || 0) + 1;
        }
        return { events, counts, sequence, sequenceCounts, recent: events.slice(-10), generatedAt: Date.now() };
    }

    function summarizeNarrativePatterns(values, options = {}) {
        const repetition = summarizeLifeRepetition(values, options);
        const fields = ['narrativePattern', 'relationshipFunction', 'activityCategory'];
        const patterns = fields.flatMap(field => Object.entries(repetition.counts[field] || {})
            .map(([value, count]) => ({ field, value, count, repeated: count > 1 })));
        patterns.sort((left, right) => right.count - left.count || `${left.field}:${left.value}`.localeCompare(`${right.field}:${right.value}`));
        return { patterns: patterns.slice(0, Math.max(1, Math.min(48, Number(options.limit) || 24))), generatedAt: repetition.generatedAt, eventCount: repetition.events.length };
    }

    function inferLifeCardKind(chunk) {
        const domains = new Set((chunk.domains || []).map(value => String(value).toLowerCase()));
        if ([...domains].some(value => /food|diet|meal|drink/.test(value))) return 'food';
        if ([...domains].some(value => /cloth|dress|outfit|fashion/.test(value))) return 'clothing';
        if ([...domains].some(value => /activity|leisure|work|ritual/.test(value))) return 'activity';
        return 'fact';
    }

    function extractLifeCards(values, options = {}) {
        const maxCards = Math.max(1, Math.min(64, Number(options.maxCards) || 64));
        const accepted = new Set(options.includeUnreviewed === true ? ['unreviewed', 'source-backed', 'approved'] : ['source-backed', 'approved']);
        const seen = new Set();
        const cards = [];
        (Array.isArray(values) ? values : []).map(item => normalizeLifeChunk(item)).forEach(chunk => {
            if (!chunk.text || !accepted.has(chunk.reviewStatus)) return;
            const key = chunk.contentHash || stableHash(chunk.text);
            if (seen.has(key)) return;
            seen.add(key);
            const title = chunk.text.split(/[。！？!?；;\n]/)[0].trim().slice(0, 120) || `${inferLifeCardKind(chunk)} 资料卡`;
            cards.push({
                id: cleanId(`${chunk.packId || 'pack'}:card:${key}`), packId: chunk.packId, title,
                kind: inferLifeCardKind(chunk), text: chunk.text.slice(0, 1800), tags: chunk.tags,
                sourceIds: [...new Set([chunk.sourceId, ...chunk.entities].filter(Boolean))].slice(0, MAX.evidence),
                dateRange: chunk.dateRange, regions: chunk.regions, cultures: chunk.cultures, domains: chunk.domains,
                confidence: chunk.reviewStatus === 'approved' ? 1 : 0.75, generatedBy: 'local-extract-v1',
                createdAt: Date.now(), updatedAt: Date.now(), revision: 0, reviewStatus: 'unreviewed',
            });
        });
        return cards.slice(0, maxCards);
    }

    function stableHash(value) {
        const text = String(value || '').normalize('NFKC');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
        return `life_${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function createLifeContextCacheKey(eventValue, queryValue = {}, options = {}) {
        const event = normalizeLifeEvent(eventValue);
        const query = normalizeLifeQuery(queryValue);
        return stableHash(JSON.stringify({
            event: { characterId: event.characterId, sceneId: event.sceneId, localDate: event.localDate, status: event.status, revision: event.revision },
            query, repetitionRevision: options.repetitionRevision || 0, packVersion: options.packVersion || '',
        }));
    }

    function formatLifeContext(eventValue, evidence = [], options = {}) {
        const event = normalizeLifeEvent(eventValue);
        const maxChars = Math.max(240, Math.min(MAX.contextChars, Number(options.maxChars) || 1200));
        const lines = [];
        if (event.localDate || event.locationRef) lines.push(`[life-context] ${event.localDate || 'date-unknown'}${event.locationRef ? ` @ ${event.locationRef}` : ''}`);
        const details = [['activity', event.activity], ['category', event.activityCategory], ['food', event.food], ['outfit', event.outfit], ['purpose', event.scenePurpose]].filter(([, value]) => value);
        if (details.length) lines.push(details.map(([key, value]) => `${key}=${value}`).join('; '));
        const rows = Array.isArray(evidence) ? evidence : [];
        for (const item of rows.slice(0, 4)) {
            const chunk = item.chunk ? normalizeLifeChunk(item.chunk) : normalizeLifeChunk(item);
            if (!chunk.text) continue;
            const line = `[evidence:${chunk.id}] ${chunk.text}`;
            if ([...lines, line].join('\n').length > maxChars) break;
            lines.push(line);
        }
        return lines.join('\n').slice(0, maxChars);
    }

    global.LifeContextCore = Object.freeze({
        VERSION,
        PACK_SCHEMA_VERSION,
        PACK_STATUSES,
        REVIEW_STATUSES,
        VERIFICATION_STATUSES,
        SOURCE_STATES,
        SUBSCRIPTION_STATES,
        SOURCE_KINDS,
        EVENT_STATUSES,
        normalizeSource,
        normalizePackCards,
        sanitizeLifeSourceText,
        normalizeLifePackManifest,
        validateLifePackManifest,
        normalizeLifeChunk,
        chunkLifeSourceText,
        normalizeLifeEvent,
        transitionLifeEvent,
        normalizeLifeQuery,
        isLifeChunkEligible,
        rangeOverlaps,
        retrieveLifeChunks,
        eventFingerprint,
        summarizeLifeRepetition,
        summarizeNarrativePatterns,
        extractLifeCards,
        stableHash,
        createLifeContextCacheKey,
        formatLifeContext,
        rangeOverlaps,
    });
}(window));
