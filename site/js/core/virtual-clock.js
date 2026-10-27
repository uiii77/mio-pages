/*
 * OvO VirtualClock
 *
 * Keeps the real clock used for message ordering/audit separate from the
 * optional role/user-facing virtual clock. A clock is represented by an
 * absolute virtual instant anchored to an absolute real instant, so changing
 * a role's year never changes message timestamps or the user's clock.
 */
(function attachVirtualClock(global) {
    'use strict';

    const LEGACY_TIMEZONE_MAP = {
        '北京/UTC+8': 'Asia/Shanghai',
        '东京/UTC+9': 'Asia/Tokyo',
        '首尔/UTC+9': 'Asia/Seoul',
        '伦敦/UTC+0': 'Europe/London',
        '纽约/UTC-5': 'America/New_York',
        '悉尼/UTC+10': 'Australia/Sydney',
        '巴黎/UTC+1': 'Europe/Paris'
    };

    const DEFAULT_RATE = 1;
    const MIN_RATE = 0.01;
    const MAX_RATE = 100;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const TIMEZONE_DATA_MODE = 'intl-first';
    const TIMEZONE_DATA_SOURCE = 'runtime-icu';

    function finiteNumber(value) {
        if (value == null || typeof value === 'string' && !value.trim()) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function clampRate(value) {
        const rate = finiteNumber(value);
        if (rate === null || rate <= 0) return DEFAULT_RATE;
        return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
    }

    function normalizeTimeZone(value) {
        if (typeof value !== 'string') return '';
        const candidate = value.trim();
        if (!candidate) return '';
        const mapped = LEGACY_TIMEZONE_MAP[candidate] || candidate;
        try {
            // Validate and canonicalize through the runtime's IANA/ICU data.
            // We deliberately do not hand-write historical DST transitions.
            const formatter = new Intl.DateTimeFormat('en-US', { timeZone: mapped });
            return formatter.resolvedOptions().timeZone || mapped;
        } catch (_error) {
            return '';
        }
    }

    function getTimeZoneInfo(value) {
        const requested = typeof value === 'string' ? value.trim() : '';
        const timeZone = normalizeTimeZone(requested);
        if (!timeZone) {
            return {
                requested,
                timeZone: '',
                supported: false,
                source: 'device-fallback',
                historicalPrecision: 'unavailable',
                dataMode: TIMEZONE_DATA_MODE,
            };
        }
        return {
            requested,
            timeZone,
            supported: true,
            source: TIMEZONE_DATA_SOURCE,
            // Intl exposes the rules but not a portable tzdata release number;
            // callers must not present this as a fully bundled historical guarantee.
            historicalPrecision: 'runtime-dependent',
            dataMode: TIMEZONE_DATA_MODE,
        };
    }

    function normalizeConfig(input) {
        const source = input && typeof input === 'object' ? input : {};
        const anchorRealMs = finiteNumber(source.anchorRealMs);
        const anchorVirtualMs = finiteNumber(source.anchorVirtualMs);
        return {
            enabled: source.enabled === true,
            timeZone: normalizeTimeZone(source.timeZone || source.timezone || ''),
            anchorRealMs,
            anchorVirtualMs,
            rate: clampRate(source.rate),
            paused: source.paused === true && anchorRealMs !== null && anchorVirtualMs !== null
        };
    }

    function safeRealNow(realNow) {
        const value = finiteNumber(realNow);
        return value === null ? Date.now() : value;
    }

    function virtualInstantMs(config, realNow) {
        const normalized = normalizeConfig(config);
        const now = safeRealNow(realNow);
        if (!normalized.enabled || normalized.anchorRealMs === null || normalized.anchorVirtualMs === null) {
            return now;
        }
        if (normalized.paused) return normalized.anchorVirtualMs;
        return normalized.anchorVirtualMs + (now - normalized.anchorRealMs) * normalized.rate;
    }

    function parseParts(formatter, instantMs) {
        const parts = formatter.formatToParts(new Date(instantMs));
        const values = {};
        for (const part of parts) {
            if (part.type !== 'literal') values[part.type] = part.value;
        }
        const number = (name, fallback) => {
            const value = Number(values[name]);
            return Number.isFinite(value) ? value : fallback;
        };
        return {
            year: number('year', new Date(instantMs).getFullYear()),
            month: number('month', new Date(instantMs).getMonth() + 1),
            day: number('day', new Date(instantMs).getDate()),
            hour: number('hour', new Date(instantMs).getHours()) % 24,
            minute: number('minute', new Date(instantMs).getMinutes()),
            second: number('second', new Date(instantMs).getSeconds()),
            weekday: values.weekday || ''
        };
    }

    function getParts(config, realNow) {
        const normalized = normalizeConfig(config);
        const instantMs = virtualInstantMs(normalized, realNow);
        const options = {
            timeZone: normalized.timeZone || undefined,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            weekday: 'short',
            hour12: false
        };

        let parsed;
        try {
            parsed = parseParts(new Intl.DateTimeFormat('en-US', options), instantMs);
        } catch (_error) {
            // Invalid/runtime-unsupported timezone data must not make a chat
            // prompt fail. The instant itself remains the same.
            parsed = parseParts(new Intl.DateTimeFormat('en-US', {
                ...options,
                timeZone: undefined
            }), instantMs);
        }
        return {
            ...parsed,
            instantMs,
            timeZone: normalized.timeZone
        };
    }

    function pad(value, length = 2) {
        return String(value).padStart(length, '0');
    }

    function format(config, realNow, options) {
        const parts = getParts(config, realNow);
        const opts = options && typeof options === 'object' ? options : {};
        const date = `${pad(parts.year, 4)}年${pad(parts.month)}月${pad(parts.day)}日`;
        const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
        const seconds = opts.includeSeconds === true ? `:${pad(parts.second)}` : '';
        const weekday = opts.includeWeekday ? ` 星期${({Sun:'日',Mon:'一',Tue:'二',Wed:'三',Thu:'四',Fri:'五',Sat:'六'})[parts.weekday] || parts.weekday}` : '';
        return `${date}${weekday} ${time}${seconds}`;
    }

    function dateKey(config, realNow) {
        const parts = getParts(config, realNow);
        return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
    }

    function isActive(config) {
        const normalized = normalizeConfig(config);
        return normalized.enabled || Boolean(normalized.timeZone);
    }

    function getTimeZone(config) {
        return normalizeConfig(config).timeZone;
    }

    function hasConfiguredTimeline(source) {
        return !!(source && typeof source === 'object' && (
            source.enabled === true ||
            (typeof source.timeZone === 'string' && source.timeZone.trim()) ||
            (typeof source.timezone === 'string' && source.timezone.trim()) ||
            finiteNumber(source.anchorRealMs) !== null ||
            finiteNumber(source.anchorVirtualMs) !== null
        ));
    }

    function reanchor(config, virtualMs, realNow) {
        const normalized = normalizeConfig(config);
        const now = safeRealNow(realNow);
        const nextVirtual = finiteNumber(virtualMs);
        return {
            ...normalized,
            enabled: true,
            anchorRealMs: now,
            anchorVirtualMs: nextVirtual === null ? virtualInstantMs(normalized, now) : nextVirtual,
            paused: false
        };
    }

    function setPaused(config, paused, realNow) {
        const normalized = normalizeConfig(config);
        const now = safeRealNow(realNow);
        if (paused === true) {
            return {
                ...normalized,
                enabled: true,
                anchorRealMs: now,
                anchorVirtualMs: virtualInstantMs(normalized, now),
                paused: true
            };
        }
        if (!normalized.paused) return { ...normalized, paused: false };
        return {
            ...normalized,
            enabled: true,
            anchorRealMs: now,
            anchorVirtualMs: normalized.anchorVirtualMs,
            paused: false
        };
    }

    function resolveCharacter(character) {
        const source = character && character.virtualTimeline;
        if (source && source.enabled === true) return normalizeConfig({...source,timeZone:source.timeZone||character.charTimezone});
        if (character && character.enableDynamicTimezone && character.charTimezone) {
            return normalizeConfig({ timeZone: character.charTimezone });
        }
        return normalizeConfig({});
    }

    function resolveUser(character, globalTimeline) {
        if (globalTimeline && globalTimeline.enabled === true) {
            return normalizeConfig(globalTimeline);
        }
        const source = character && character.userTimeline;
        if (source && source.enabled === true) return normalizeConfig(source);
        if (character && character.myEnableDynamicTimezone && character.myTimezone) {
            return normalizeConfig({ timeZone: character.myTimezone });
        }
        return normalizeConfig({});
    }

    // Real device instant, explicitly separate from the user's optional fictional timeline.
    function resolveUserReal(character, globalTimeline) {
        const configured=typeof character?.myTimezone==='string'?character.myTimezone:globalTimeline?.timeZone;
        return normalizeConfig({timeZone:configured || Intl.DateTimeFormat().resolvedOptions().timeZone});
    }

    function updateTimeline(config, changes, realNow) {
        const previous=normalizeConfig(config),now=safeRealNow(realNow);
        const next={...config,...previous,...changes};
        const explicit=finiteNumber(changes.anchorVirtualMs);
        if (explicit!==null || changes.enabled===true && !previous.enabled || next.rate!==previous.rate || next.paused!==previous.paused) {
            next.anchorVirtualMs=explicit===null?virtualInstantMs(previous,now):explicit;
            next.anchorRealMs=now;
        }
        return next;
    }

    function parseBirthday(value) {
        if (typeof value === 'string') {
            const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
            if (match) {
                return {
                    year: Number(match[1]),
                    month: Number(match[2]),
                    day: Number(match[3])
                };
            }
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate()
        };
    }

    function getAgeInfo(birthday, config, realNow) {
        const birth = parseBirthday(birthday);
        if (!birth) return null;
        const current = getParts(config, realNow);
        let age = current.year - birth.year;
        const beforeBirthday = current.month < birth.month ||
            (current.month === birth.month && current.day < birth.day);
        if (beforeBirthday) age -= 1;
        return {
            birthYear: birth.year,
            birthMonth: birth.month,
            birthDay: birth.day,
            age,
            isBirthday: current.month === birth.month && current.day === birth.day
        };
    }

    function wallClockToTimestamp(value, timeZone) {
        if (typeof value !== 'string' || !value.trim()) return null;
        const match = value.trim().match(/^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
        if (!match) return null;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6] || 0);
        const millisecond = Number((match[7] || '').padEnd(3, '0') || 0);
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
        const calendarCheck = new Date(0);
        calendarCheck.setUTCFullYear(year, month - 1, day);
        calendarCheck.setUTCHours(hour, minute, second, millisecond);
        if (calendarCheck.getUTCFullYear() !== year || calendarCheck.getUTCMonth() !== month - 1 || calendarCheck.getUTCDate() !== day) return null;

        const rawTimeZone = typeof timeZone === 'string' ? timeZone.trim() : '';
        const normalized = normalizeTimeZone(rawTimeZone);
        if (rawTimeZone && !normalized) return null;
        if (!normalized) {
            const local = new Date(0);
            local.setFullYear(year, month - 1, day);
            local.setHours(hour, minute, second, millisecond);
            return local.getFullYear() === year && local.getMonth() === month - 1 && local.getDate() === day && local.getHours() === hour && local.getMinutes() === minute
                ? local.getTime() : null;
        }

        // Interpret the input as a wall-clock value in the chosen IANA zone.
        // Iterating the zone offset converges for normal DST transitions and
        // keeps the stored anchor an absolute instant.
        const wallAsUtc = calendarCheck.getTime();
        let guess = wallAsUtc;
        for (let i = 0; i < 5; i += 1) {
            const parts = parseParts(new Intl.DateTimeFormat('en-US', {
                timeZone: normalized,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
            }), guess);
            const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millisecond);
            const offset = representedAsUtc - guess;
            const next = wallAsUtc - offset;
            if (next === guess) return next;
            guess = next;
        }
        const check=getParts({timeZone:normalized},guess);
        return check.year===year && check.month===month && check.day===day && check.hour===hour && check.minute===minute && check.second===second ? guess : null;
    }

    function inputValue(instantMs, timeZone, includeSeconds = true) {
        const numericInstant = finiteNumber(instantMs);
        if (numericInstant === null) return '';
        const parts = getParts({ timeZone: timeZone || '' }, numericInstant);
        const base = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
        return includeSeconds ? `${base}:${pad(parts.second)}` : base;
    }

    const api = {
        MS_PER_DAY,
        TIMEZONE_DATA_MODE,
        TIMEZONE_DATA_SOURCE,
        normalizeConfig,
        getTimeZoneInfo,
        virtualInstantMs,
        getParts,
        format,
        dateKey,
        isActive,
        getTimeZone,
        hasConfiguredTimeline,
        reanchor,
        setPaused,
        resolveCharacter,
        resolveUser,
        resolveUserReal,
        updateTimeline,
        getAgeInfo,
        wallClockToTimestamp,
        inputValue
    };

    global.VirtualClock = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
