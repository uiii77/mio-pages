(function (global) {
    'use strict';
    const VERSION = 'coc7-basic-1';
    const ATTRIBUTES = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];
    function integer(value, min, max, label = '数值') {
        if (value === '' || value == null || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label}须为 ${min}–${max} 的整数`);
        return Number(value);
    }
    function text(value, max = 120) { return String(value ?? '').trim().slice(0, max); }
    function die(sides) {
        integer(sides, 2, 1000, '骰面');
        const limit = Math.floor(4294967296 / sides) * sides;
        const bytes = new Uint32Array(1);
        do { global.crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
        return bytes[0] % sides + 1;
    }
    // Bounded grammar; never evaluate user expressions as JavaScript.
    function expression(value) {
        const source = text(value, 81).replace(/\s/g, '').toUpperCase();
        if (!source || source.length > 80 || !/^(?:\d*D\d+|\d+)(?:[+-](?:\d*D\d+|\d+))*$/.test(source)) throw new Error('骰式示例：1D6、2D6+1 或 0');
        let count = 0;
        const terms = source.match(/[+-]?(?:\d*D\d+|\d+)/g).map(term => {
            const sign = term[0] === '-' ? -1 : 1;
            const body = term.replace(/^[+-]/, '');
            if (!body.includes('D')) return { sign, constant: integer(body, 0, 10000) };
            const [n, d] = body.split('D');
            const dice = integer(n || 1, 1, 100, '骰数'); count += dice;
            return { sign, dice, sides: integer(d, 2, 1000, '骰面') };
        });
        if (count > 100 || terms.length > 20) throw new Error('一次最多 100 枚骰、20 项');
        return { source, terms };
    }
    function roll(value, draw = die, maximum = false) {
        const parsed = expression(value);
        let total = 0;
        const terms = parsed.terms.map(term => {
            const values = term.dice ? Array.from({ length: term.dice }, () => maximum ? (term.sign > 0 ? term.sides : 1) : integer(draw(term.sides), 1, term.sides, '骰点')) : [];
            total += term.sign * (term.constant ?? values.reduce((a, b) => a + b, 0));
            return { ...term, values };
        });
        return { expression: parsed.source, terms, total, maximum };
    }
    function percentile(bonus = 0, penalty = 0, draw = die) {
        const net = integer(bonus, 0, 2, '奖励骰') - integer(penalty, 0, 2, '惩罚骰');
        const units = integer(draw(10), 1, 10, '个位骰') - 1;
        const tens = Array.from({ length: Math.abs(net) + 1 }, () => integer(draw(10), 1, 10, '十位骰') - 1);
        const candidates = tens.map(t => t * 10 + units || 100);
        return { units, tens, candidates, bonus, penalty, result: net > 0 ? Math.min(...candidates) : Math.max(...candidates) };
    }
    function check(skill, result, difficulty = 'regular') {
        skill = integer(skill, 0, 999, '技能'); result = integer(result, 1, 100, '骰点');
        const thresholds = { regular: skill, hard: Math.floor(skill / 2), extreme: Math.floor(skill / 5) };
        if (!Object.hasOwn(thresholds, difficulty)) throw new Error('未知难度');
        const target = thresholds[difficulty];
        // Fumble uses the required roll, including the selected difficulty (Keeper Rulebook p.90).
        const level = result === 100 || (target < 50 && result >= 96) ? 'fumble'
            : result === 1 ? 'critical' : result <= thresholds.extreme ? 'extreme'
                : result <= thresholds.hard ? 'hard' : result <= skill ? 'regular' : 'failure';
        return { skill, result, difficulty, target, thresholds, level, passed: level === 'critical' || (level !== 'fumble' && result <= target), rulesVersion: VERSION };
    }
    function card(value = {}) {
        const attributes = Object.fromEntries(ATTRIBUTES.map(key => [key, integer(value.attributes?.[key] ?? 50, 1, 99, key)]));
        const mythos = integer(value.mythos ?? 0, 0, 99, '克苏鲁神话');
        const hpMax = Math.floor((attributes.CON + attributes.SIZ) / 10), mpMax = Math.floor(attributes.POW / 5), sanMax = 99 - mythos;
        const sum = attributes.STR + attributes.SIZ;
        const build = sum <= 64 ? -2 : sum <= 84 ? -1 : sum <= 124 ? 0 : sum <= 164 ? 1 : 2;
        const skills = Object.fromEntries(Object.entries(value.skills || {}).slice(0, 100).map(([name, score]) => {
            const key = text(name, 60); if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('技能名称无效');
            return [key, integer(score, 0, 999, key)];
        }));
        return { id: text(value.id, 180), characterId: text(value.characterId, 180), name: text(value.name) || '调查员', attributes, skills, mythos,
            luck: integer(value.luck ?? 50, 0, 99, '幸运'), hpMax, mpMax, sanMax, build,
            damageBonus: ['-2', '-1', '0', '1D4', '1D6'][build + 2],
            hp: integer(value.hp ?? hpMax, 0, hpMax, 'HP'), mp: integer(value.mp ?? mpMax, 0, mpMax, 'MP'), san: integer(value.san ?? Math.min(attributes.POW, sanMax), 0, sanMax, 'SAN') };
    }
    function storyItem(value) {
        if (!value || !text(value.id, 180) || !['scene', 'npc', 'clue'].includes(value.kind)) throw new Error('场景/NPC/线索格式无效');
        const visibility = value.visibility ?? 'kp';
        if (!['kp', 'public', 'participants'].includes(visibility)) throw new Error('公开范围无效');
        return { id: text(value.id, 180), kind: value.kind, title: text(value.title) || '未命名条目', text: text(value.text, 4000),
            sceneId: text(value.sceneId, 180), cardId: text(value.cardId, 180), visibility,
            characterIds: [...new Set((Array.isArray(value.characterIds) ? value.characterIds : []).map(v => text(v, 180)).filter(Boolean))],
            ...(value.audience?{audience:global.TrpgStateCore.audience(value.audience)}:{}),
            sources: (Array.isArray(value.sources) ? value.sources : []).slice(0, 5).map(s => ({ packId: text(s.packId, 180), chunkId: text(s.chunkId, 240), revision: integer(s.revision ?? 0, 0, Number.MAX_SAFE_INTEGER) })) };
    }
    function story(value = {}) {
        if (!Array.isArray(value.items ?? [])) throw new Error('场景/NPC/线索列表格式无效');
        const items = (value.items || []).map(storyItem);
        if (new Set(items.map(i => i.id)).size !== items.length) throw new Error('条目 ID 重复');
        const sceneIds = new Set(items.filter(i => i.kind === 'scene').map(i => i.id));
        const currentSceneId = text(value.currentSceneId, 180);
        if (currentSceneId && !sceneIds.has(currentSceneId)) throw new Error('当前场景不存在');
        for (const item of items) if (item.sceneId && !sceneIds.has(item.sceneId)) throw new Error('关联场景不存在');
        return { currentSceneId, items };
    }
    function visibleStory(source, context) {
        const saved = campaign(source);
        if (!context || !['kp', 'player','character'].includes(context.viewer)) throw new Error('请选择查看身份');
        if (context.characterId && !saved.cards.some(c => c.characterId === context.characterId)) throw new Error('该角色未参与当前跑团');
        if(context.viewer==='kp'&&context.characterId)throw Error('角色请求不能使用 KP 身份');
        return saved.story.items.filter(item => item.audience?global.TrpgStateCore.visible(item.audience,context):context.viewer === 'kp' || item.visibility === 'public' ||
            (item.visibility === 'participants' && !!context.characterId && item.characterIds.includes(context.characterId)));
    }
    function campaign(value) {
        if (!value || ![1,2].includes(value.schemaVersion) || value.rulesVersion !== VERSION) throw new Error('存档版本不兼容，请保留原文件');
        if (!text(value.id, 180) || !Array.isArray(value.cards) || !Array.isArray(value.events)) throw new Error('存档结构无效');
        const cards = value.cards.map(card);
        if (cards.some(c => !c.id) || new Set(cards.map(c => c.id)).size !== cards.length) throw new Error('角色卡 ID 无效');
        const events = value.events.map(e => {
            if (!e || !text(e.id, 180) || e.rulesVersion !== VERSION || !['card', 'check', 'sanity', 'adjust', 'dice', 'progress', 'story','knowledge','state','dialogue'].includes(e.kind)) throw new Error('事件记录无效');
            if (e.kind === 'dialogue') {
                if (!['player','kp','character'].includes(e.speaker) || typeof e.content !== 'string' || !e.content.trim() || e.content.length > 4000) throw new Error('剧情对话格式无效');
                global.TrpgStateCore.audience(e.audience);
            }
            if (['knowledge','state'].includes(e.kind)&&(!e.cause||!e.requestFingerprint))throw Error('剧情事件依据缺失');
            if (e.kind === 'story' && !e.operation) throw new Error('公开记录无效');
            if (['check', 'sanity'].includes(e.kind)) {
                integer(e.roll?.result, 1, 100, '历史骰点');
                if (!e.check || !['critical', 'extreme', 'hard', 'regular', 'failure', 'fumble'].includes(e.check.level) || typeof e.check.passed !== 'boolean') throw new Error('判定记录无效');
                integer(e.check.target, 0, 999, '检定目标');
            }
            if (e.kind === 'sanity') integer(e.loss?.total, 0, 1000000, '理智损失');
            if (e.kind === 'card' && (!e.after || !card(e.after).id)) throw new Error('角色卡记录无效');
            if (e.kind === 'progress' && (!e.after || typeof e.after.title !== 'string')) throw new Error('进度记录无效');
            if (e.kind === 'dice' && (!e.roll || !Number.isInteger(e.roll.total))) throw new Error('掷骰记录无效');
            if (e.kind === 'adjust' && !['hp', 'mp', 'san'].includes(e.resource)) throw new Error('状态记录无效');
            return JSON.parse(JSON.stringify(e));
        });
        if (new Set(events.map(e => e.id)).size !== events.length) throw new Error('事件 ID 重复');
        return { id: text(value.id, 180), schemaVersion: value.schemaVersion, rulesVersion: VERSION, ...(value.schemaVersion===2?{state:global.TrpgStateCore.state(value.state)}:{}), title: text(value.title) || '新的跑团', scene: text(value.scene, 2000), cards, events, story: story(value.story),
            revision: integer(value.revision ?? 0, 0, Number.MAX_SAFE_INTEGER), updatedAt: Number(value.updatedAt) || 0 };
    }
    function apply(source, command, draw = die) {
        const next = campaign(source), id = text(command.id, 180);
        if (!id) throw new Error('事件 ID 不能为空');
        const previous=next.events.find(e=>e.id===id);if(previous){if(['knowledge','state'].includes(command.kind)&&previous.requestFingerprint!==global.TrpgStateCore.fingerprint(command))throw Error('同一事件 ID 的内容冲突');return next;}
        const event = { id, kind: command.kind, rulesVersion: VERSION, cardId: command.cardId || '', at: command.at ?? Date.now() };
        if (command.kind === 'dialogue') {
            if (!['player','kp','character'].includes(command.speaker) || typeof command.content !== 'string' || !command.content.trim() || command.content.length > 4000) throw new Error('请输入不超过 4000 字的剧情对话');
            Object.assign(event,{speaker:command.speaker,name:text(command.name),content:command.content.trim(),audience:global.TrpgStateCore.audience(command.audience)});
        } else if (['knowledge','state'].includes(command.kind)) {
            global.TrpgStateCore.apply(next,command,event);
        } else if (command.kind === 'card') {
            const item = card(command.card); if (!item.id) throw new Error('角色卡 ID 不能为空');
            const index = next.cards.findIndex(c => c.id === item.id);
            event.before = index < 0 ? null : next.cards[index]; event.after = item;
            if (index < 0) next.cards.push(item); else next.cards[index] = item;
        } else if (command.kind === 'story') {
            event.operation = command.operation;
            if (command.operation === 'save') {
                const previousItem=next.story.items.find(row=>row.id===command.item?.id);
                const item = storyItem({...command.item,...(previousItem?.audience?{audience:previousItem.audience}:{})});
                if (item.cardId && !next.cards.some(c => c.id === item.cardId)) throw new Error('关联角色卡不存在');
                if (item.characterIds.some(id => !next.cards.some(c => c.characterId === id))) throw new Error('只能向本团参与角色公开');
                const index = next.story.items.findIndex(i => i.id === item.id);
                event.before = index < 0 ? null : next.story.items[index]; event.after = item;
                if (index < 0) next.story.items.push(item); else next.story.items[index] = item;
            } else if (command.operation === 'remove') {
                const item = next.story.items.find(i => i.id === command.itemId);
                if (!item) throw new Error('条目不存在');
                if (next.story.items.some(i => i.sceneId === item.id)) throw new Error('请先解除此场景下的条目关联');
                event.before = item;
                next.story.items = next.story.items.filter(i => i.id !== item.id);
                if (next.story.currentSceneId === item.id) next.story.currentSceneId = '';
            } else if (command.operation === 'select') {
                event.before = next.story.currentSceneId;
                next.story.currentSceneId = text(command.sceneId, 180); event.after = next.story.currentSceneId;
            } else throw new Error('未知场景操作');
            next.story = story(next.story);
        } else if (command.kind === 'progress') {
            event.before = { title: next.title, scene: next.scene };
            next.title = text(command.title) || next.title; next.scene = text(command.scene, 2000);
            event.after = { title: next.title, scene: next.scene };
        } else if (command.kind === 'dice') event.roll = roll(command.expression, draw);
        else {
            const item = next.cards.find(c => c.id === command.cardId); if (!item) throw new Error('请先保存并选择角色卡');
            if (command.kind === 'adjust') {
                if (!['hp', 'mp', 'san'].includes(command.resource)) throw new Error('未知状态');
                event.resource = command.resource; event.before = item[command.resource];
                event.delta = integer(command.delta, -999, 999, '变化量'); event.reason = text(command.reason, 300);
                item[command.resource] = Math.max(0, Math.min(item[`${command.resource}Max`], event.before + event.delta)); event.after = item[command.resource];
            } else if (command.kind === 'check' || command.kind === 'sanity') {
                const sanity = command.kind === 'sanity';
                const skill = sanity ? item.san : command.key === 'LUCK' ? item.luck : command.key === 'MYTHOS' ? item.mythos : item.attributes[command.key] ?? item.skills[command.key];
                if (skill == null) throw new Error('角色卡没有这项技能');
                if (sanity) { expression(command.lossSuccess); expression(command.lossFailure); }
                event.key = sanity ? 'SAN' : command.key;
                event.roll = percentile(sanity ? 0 : command.bonus ?? 0, sanity ? 0 : command.penalty ?? 0, draw);
                event.check = check(skill, event.roll.result, sanity ? 'regular' : command.difficulty || 'regular');
                if (sanity) {
                    // SAN is a direct roll-under check; at SAN 0 a roll of 1 does not recover sanity.
                    event.check.passed = skill > 0 && event.roll.result <= skill && event.roll.result !== 100;
                    if (!event.check.passed && event.check.level === 'critical') event.check.level = 'failure';
                    event.before = item.san;
                    event.loss = roll(event.check.passed ? command.lossSuccess : command.lossFailure, draw, event.check.level === 'fumble');
                    if (event.loss.total < 0) throw new Error('理智损失不能为负数');
                    item.san = Math.max(0, item.san - event.loss.total); event.after = item.san;
                    event.needsKeeperReview = event.loss.total >= 5 || item.san === 0;
                }
            } else throw new Error('未知操作');
        }
        next.events.push(event); next.revision++; next.updatedAt = event.at;
        return next;
    }
    global.CoC7Core = Object.freeze({ VERSION, ATTRIBUTES, integer, die, expression, roll, percentile, check, card, campaign, apply, storyItem, visibleStory });
})(typeof window !== 'undefined' ? window : globalThis);
