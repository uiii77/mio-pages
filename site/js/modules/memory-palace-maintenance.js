(function (global) {
    'use strict';
    const Palace = global.MemoryPalace, Core = global.MemoryPalaceCore, Rules = global.MemoryGovernanceCore;
    const locks = new Set();
    let selectedId = '', timer = null;
    const controls = {
        'setting-memory-palace-enabled': ['memoryPalaceEnabled', false],
        'setting-memory-palace-auto-archive': ['autoArchiveEnabled', true],
        'setting-memory-palace-spreading-activation': ['memoryPalaceActivationEnabled', true],
        'palace-seven-enabled': ['memoryPalaceSevenEnabled', true],
        'palace-night-enabled': ['memoryPalaceNightEnabled', true],
        'setting-relationship-memory-enabled': ['relationshipMemoryEnabled', true],
    };
    const unifiedCoreKeys = ['autoArchiveEnabled', 'memoryPalaceActivationEnabled', 'memoryPalaceSevenEnabled', 'memoryPalaceNightEnabled', 'relationshipMemoryEnabled'];
    const character = () => (db.characters || []).find(c => c.id === selectedId);
    function clock(c, realNow = Date.now()) {
        const config = global.VirtualClock.resolveCharacter(c);
        const now = global.VirtualClock.virtualInstantMs(config, realNow);
        const parts = global.VirtualClock.getParts(config, realNow);
        const date = global.VirtualClock.dateKey(config, realNow);
        const hour = Math.max(0, Math.min(23, Number(c.memoryPalaceNightHour ?? 3) || 0));
        // The latest scheduled night, including catch-up when the app opens before today's hour.
        const day = parts.hour >= hour ? date : new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - 86400000).toISOString().slice(0,10);
        return { now, date, day };
    }
    function loadSettings(c) {
        if (!c) return;
        selectedId = c.id; Palace.ensureSettings(c);
        for (const [id, [key, fallback]] of Object.entries(controls)) document.getElementById(id).checked = c[key] ?? fallback;
        document.getElementById('setting-memory-palace-topk').value = c.memoryPalaceTopK || 8;
        document.getElementById('setting-memory-palace-waterline').value = c.memoryPalaceWaterline?.preset || 'online';
        document.getElementById('palace-night-hour').value = c.memoryPalaceNightHour ?? 3;
        updateStatus(c);
    }
    function applyUnifiedDefaults(c) {
        if (!c || Number(c.memoryPalaceUnifiedModeVersion) >= 1) return false;
        c.memoryPalaceLegacyFeatureSettings = Object.fromEntries(unifiedCoreKeys.map(key => [key, c[key] !== false]));
        unifiedCoreKeys.forEach(key => { c[key] = true; });
        c.memoryPalaceUnifiedModeVersion = 1;
        return true;
    }
    function updateStatus(c) {
        if (c.id !== selectedId) return;
        const target = document.getElementById('palace-process-status'); if (!target) return;
        const state = c.memoryPalaceArchiveState || {};
        const config = Palace.featureConfig('memoryProcess', c);
        const embedding = Palace.featureConfig('embedding', c);
        const rerank = Palace.featureConfig('rerank', c);
        const messages = (c.history || []).map(Palace.originalMessageEntry).filter(Boolean);
        const selection = Core.selectArchiveWindow(messages, state, c.memoryPalaceWaterline);
        const enabled = c.memoryPalaceEnabled === true;
        const autoStatus = !enabled ? '未启用' : !c.autoArchiveEnabled ? '已关闭' : !config ? '等待 API' : state.lastError ? '上次失败' : selection.bufferCount < selection.waterline.bufferThreshold ? `等待 ${selection.bufferCount}/${selection.waterline.bufferThreshold}` : `可整理 ${selection.bufferCount} 条`;
        const recallStatus = !enabled ? '未启用' : c.memoryPalaceSevenEnabled ? (embedding ? '七通道就绪' : '本地召回可用') : (embedding ? '混合召回' : '关键词召回');
        const autoTarget = document.getElementById('memory-palace-auto-status');
        const recallTarget = document.getElementById('memory-palace-recall-status');
        const apiTarget = document.getElementById('memory-palace-api-state');
        if (autoTarget) autoTarget.textContent = autoStatus;
        if (recallTarget) recallTarget.textContent = recallStatus;
        if (apiTarget) apiTarget.textContent = `${global.FeatureApiRegistry?.sourceLabel(global.FeatureApiRegistry.resolve('memoryProcess',{context:c}))||'请配置主 API'} · ${embedding ? 'Embedding 已配置' : '使用本地检索'}${rerank ? ' · Rerank 已配置' : ''}`;
        const lastError = state.lastError || c.memoryPalaceGovernanceError || '';
        const nightStatus = !enabled ? '夜间整理未启用' : !c.memoryPalaceNightEnabled ? '夜间整理已关闭' : !config ? '夜间整理等待记忆处理 API' : c.memoryPalaceLastGovernanceDay === clock(c).day ? '今日夜间整理已完成' : `夜间整理等待角色当地 ${String(c.memoryPalaceNightHour ?? 3).padStart(2, '0')}:00`;
        target.textContent = `${config ? '记忆处理 API 可用' : '记忆处理 API 未配置'} · 待整理 ${selection.bufferCount} 条 / 触发 ${selection.waterline.bufferThreshold} 条 · ${nightStatus}${lastError ? ` · 最近状态：${lastError}` : ''}`;
    }
    async function distill(c, nodes) {
        if (!nodes.length) return [];
        const config = Palace.featureConfig('memoryProcess', c);
        if (!config) throw Error('夜间整理需要配置并启用记忆处理 API');
        const source = nodes.slice(0, 30);
        const response = await Palace.withTimeout(global.fetchAiResponse(config, {
            model: config.model, temperature: 0.2, stream: false,
            messages: [{ role: 'user', content: '根据下列已有记忆整理最多2条有证据的稳定认知。不要猜测新事实，不要将愿望视为已发生。没有新认识返回空数组。只返回JSON：{"memories":[{"content":"认知内容","sourceMessageIds":["下列记忆id"]}]}。\n' + JSON.stringify(source.map(n => ({ id:n.id, content:n.content, subject:n.subject, confidence:n.confidence }))) }],
        }, global.getApiConfigHeaders(config), global.getApiConfigEndpoint(config, false), false));
        const allowed = new Set(source.map(n => n.id));
        return Palace.parseExtractionReply(response).slice(0,2).map(n => ({ ...n, sourceNodeIds: n.sourceMessageIds.filter(id => allowed.has(id)) })).filter(n => n.sourceNodeIds.length);
    }
    async function govern(c, options = {}) {
        if (!c?.memoryPalaceEnabled || !c.memoryPalaceSevenEnabled || !c.memoryPalaceNightEnabled) return { skipped: true };
        if (!Palace.featureConfig('memoryProcess', c)) return { skipped: true, reason: 'api-unavailable' };
        if (locks.has(c.id)) return { skipped: true };
        locks.add(c.id);
        try {
            const { now, day } = clock(c, options.realNow);
            const id = `mpg:${c.id}:${day}`;
            const previous = await Palace.getDigestReport(id);
            if (previous || c.memoryPalaceLastGovernanceDay === day) return { skipped: true, reason: 'already-done' };
            if (!options.force && c.memoryPalaceGovernanceRetryAt > Date.now()) return { skipped: true, reason: 'retry-delay' };
            const nodes = await Palace.listNodes(c.id);
            const changes = Rules.plan(nodes, now);
            const processed = new Set(nodes.filter(n => n.layer === 'cognition').flatMap(n => n.sourceNodeIds || []));
            const pending = nodes.filter(n => !n.archived && !n.pinned && n.layer !== 'cognition' && !processed.has(n.id) && !changes.some(ch => ch.before.id === n.id)).sort((a,b) => b.updatedAt-a.updatedAt).slice(0,30);
            const distilled = await distill(c, pending);
            if (!c.memoryPalaceEnabled || !c.memoryPalaceSevenEnabled || !c.memoryPalaceNightEnabled || clock(c, options.realNow).day !== day) return { skipped:true, reason:'settings-changed' };
            const existingKeys = new Set(nodes.map(n => Core.memoryFingerprint(n.content)));
            for (const item of distilled) {
                const hash = Core.memoryFingerprint(item.content);
                if (existingKeys.has(hash)) continue;
                existingKeys.add(hash);
                const node = Core.normalizeNode({ id: Core.id('mpn'), characterId:c.id, owner:c.id, subject:'reflection', content:item.content, layer:'cognition', room:'self_room', confidence:0.6, sourceNodeIds:item.sourceNodeIds, source:{type:'night_governance',reportId:id,characterDate:day}, revision:1 });
                changes.push({ before:null, after:node });
            }
            const report = Core.normalizeDigestReport({ id, characterId:c.id, trigger:'auto',
                examined:[{label:'夜间整理',items:[`角色日期 ${day}`,`检查 ${nodes.length} 条记忆`]}],
                outcomes:[{label:'处理结果',items:changes.map(ch => `${ch.after.archiveReason || '形成认知'}：${ch.after.content}`)}],
                governance:{ day, changes, undone:false, sourceIds:pending.map(n=>n.id) },
            });
            await dexieDB.transaction('rw', dexieDB.memoryPalaceNodes, dexieDB.memoryPalaceDigestReports, async () => {
                if (await dexieDB.memoryPalaceDigestReports.get(id)) return;
                // A manual edit or deletion while the model was running must never be overwritten.
                for (const node of nodes) {
                    const latest = await dexieDB.memoryPalaceNodes.get(node.id);
                    if (!latest || latest.updatedAt !== node.updatedAt || (latest.revision || 0) !== (node.revision || 0)) throw Error('整理期间记忆已修改，请稍后重试');
                }
                if (changes.length) await dexieDB.memoryPalaceNodes.bulkPut(changes.map(ch => ch.after));
                await dexieDB.memoryPalaceDigestReports.put(report);
            });
            c.memoryPalaceGovernanceError = ''; c.memoryPalaceGovernanceRetryAt = 0;
            c.memoryPalaceLastGovernanceDay = day;
            await global.saveCharacter(c.id);
            return { changed:changes.length, reportId:id };
        } catch (error) {
            c.memoryPalaceGovernanceError = error.message;
            c.memoryPalaceGovernanceRetryAt = Date.now() + 300000;
            await global.saveCharacter(c.id);
            return { error:error.message };
        } finally { locks.delete(c.id); updateStatus(c); }
    }
    async function undo(id) {
        const report = await Palace.getDigestReport(id);
        if (!report?.governance || report.governance.undone) return;
        if (!Array.isArray(report.governance.changes) || report.governance.changes.some(change => change.after?.characterId !== report.characterId || (change.before && (change.before.characterId !== report.characterId || change.before.id !== change.after.id)))) throw Error('整理记录的来源不一致，无法撤销');
        await dexieDB.transaction('rw', dexieDB.memoryPalaceNodes, dexieDB.memoryPalaceVectors, dexieDB.memoryPalaceDigestReports, async () => {
            for (const change of report.governance.changes) {
                const latest = await dexieDB.memoryPalaceNodes.get(change.after.id);
                if (!latest || latest.revision !== change.after.revision || latest.updatedAt !== change.after.updatedAt) throw Error('部分记忆已被再次修改，不能覆盖；请在记忆列表中逐条核对');
            }
            for (const change of report.governance.changes) {
                if (change.before) await dexieDB.memoryPalaceNodes.put({ ...change.before, revision:change.after.revision+1, updatedAt:Date.now() });
                else { await dexieDB.memoryPalaceNodes.put({ ...change.after, archived:true, archiveReason:'已撤销自动整理', revision:change.after.revision+1, updatedAt:Date.now() }); }
            }
            await dexieDB.memoryPalaceDigestReports.put({ ...report, governance:{...report.governance,undone:true} });
        });
    }
    async function tick() {
        for (const c of [...(db.characters || [])]) {
            if (!c.memoryPalaceEnabled) continue;
            try {
                const run = async () => { await Palace.checkAndTriggerAutoArchive(c); await govern(c); };
                if (global.navigator?.locks) await navigator.locks.request(`mio-memory-maintenance:${c.id}`, { ifAvailable:true }, lock => lock ? run() : undefined);
                else await run();
            } catch (error) { c.memoryPalaceGovernanceError = error.message; }
            updateStatus(c);
        }
    }
    function setup() {
        if (timer) return;
        document.getElementById('setting-memory-palace-enabled')?.addEventListener('change', async event => {
            const c = character(); if (!c) return;
            Palace.ensureSettings(c);
            c.memoryPalaceEnabled = event.currentTarget.checked;
            if (c.memoryPalaceEnabled) applyUnifiedDefaults(c);
            loadSettings(c);
            await global.saveCharacter(c.id);
            updateStatus(c);
            await Palace.render();
            if (c.memoryPalaceEnabled) void tick();
            showToast(c.memoryPalaceEnabled ? '记忆宫殿已启用，核心能力将按当前高级设置运行' : '记忆宫殿已关闭，已有记忆仍会保留');
        });
        document.getElementById('palace-save-settings')?.addEventListener('click', async () => {
            const c = character(); if (!c) return;
            for (const [id,[key]] of Object.entries(controls)) c[key] = document.getElementById(id).checked;
            c.memoryPalaceUnifiedModeVersion = 1;
            c.memoryPalaceTopK = Math.max(1,Math.min(12,Number(document.getElementById('setting-memory-palace-topk').value)||8));
            c.memoryPalaceWaterline = Core.resolveWaterline({preset:document.getElementById('setting-memory-palace-waterline').value});
            c.memoryPalaceNightHour = Math.max(0,Math.min(23,Number(document.getElementById('palace-night-hour').value)||0));
            await global.saveCharacter(c.id); updateStatus(c); await Palace.render(); showToast('宫殿设置已保存'); void tick();
        });
        document.getElementById('palace-govern-now')?.addEventListener('click', async event => {
            const c = character(); if (!c) return;
            event.currentTarget.disabled = true;
            try { const result = await govern(c,{force:true}); showToast(result.error || (result.reason === 'api-unavailable' ? '尚未配置并启用记忆处理 API' : result.skipped ? '当前未启用夜间整理，或同一角色日期已经整理' : '整理完成，可在整理记录中查看和撤销')); await Palace.render(); }
            finally { document.getElementById('palace-govern-now').disabled = false; }
        });
        document.getElementById('palace-layer-filter')?.addEventListener('change', () => void Palace.render());
        timer = setInterval(() => void tick(), 60000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) void tick(); });
        setTimeout(() => void tick(), 2000);
    }
    global.MemoryPalaceMaintenance = { clock, govern, undo, tick, setup, loadSettings, updateStatus, applyUnifiedDefaults };
})(window);
