(function attachLifeContextSettings(global) {
    'use strict';

    let bound = false;
    let renderToken = 0;

    const esc = value => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const character = () => {
        const id = typeof global.currentChatId === 'undefined' ? '' : global.currentChatId;
        return global.db?.characters?.find(item => item.id === id) || null;
    };

    const toast = message => global.showToast?.(message);

    async function persist(characterValue) {
        if (!characterValue) return false;
        try {
            if (typeof global.saveCharacter === 'function') return (await global.saveCharacter(characterValue.id)) !== false;
            if (typeof global.saveData === 'function') { await global.saveData(); return true; }
        } catch (error) {
            console.warn('[LifeContextSettings] 保存角色设置失败', error);
        }
        return false;
    }

    function getSelectedPackIds() {
        const list = document.getElementById('setting-life-context-pack-list');
        if (!list) return null;
        return [...list.querySelectorAll('input[data-life-pack-id]:checked')]
            .map(input => String(input.dataset.lifePackId || '').trim()).filter(Boolean);
    }

    function statusText(status) {
        return ({ draft: '草稿', active: '已启用', archived: '已归档' })[status] || '草稿';
    }

    function reviewSummary(pack) {
        const rows = [...(pack?.sources || []), ...(pack?.chunks || [])];
        const cards = pack?.manifest?.cards || pack?.cards || [];
        if (!rows.length && !cards.length) return '暂无片段审核记录';
        const approved = rows.filter(row => row.reviewStatus === 'approved').length;
        const sourceBacked = rows.filter(row => row.reviewStatus === 'source-backed').length;
        const rejected = rows.filter(row => row.reviewStatus === 'rejected').length;
        const pending = rows.filter(row => row.reviewStatus === 'unreviewed').length;
        const cardApproved = cards.filter(card => card.reviewStatus === 'approved').length;
        const cardPending = cards.filter(card => card.reviewStatus === 'unreviewed' || card.reviewStatus === 'source-backed').length;
        return `已采用 ${approved} · 有来源 ${sourceBacked} · 待核对 ${pending}${rejected ? ` · 已拒绝 ${rejected}` : ''} · 资料卡 ${cardApproved}/${cards.length}${cardPending ? `（${cardPending} 待审）` : ''}`;
    }

    function reviewText(status) {
        return ({ unreviewed: '待核对', 'source-backed': '有来源', approved: '已采用', rejected: '已拒绝' })[status] || '待核对';
    }

    function reviewOptions(current) {
        return ['unreviewed', 'source-backed', 'approved', 'rejected']
            .map(value => `<option value="${value}"${value === current ? ' selected' : ''}>${reviewText(value)}</option>`).join('');
    }

    function subscriptionMarkup(pack) {
        const manifest = pack?.manifest || pack || {};
        const subscriptions = Array.isArray(manifest.sourceSubscriptions) ? manifest.sourceSubscriptions : [];
        const policy = manifest.sourcePolicy || {};
        const hosts = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
        if (!subscriptions.length) return `<div class="kkt-item-hint">暂无联网来源订阅；添加后仍需在全局 API 设置中明确开启联网更新。</div>`;
        return `<div class="kkt-item-hint">允许域名：${esc(hosts.join('、') || '未设置（联网更新将被拒绝）')} · 缓存周期：${Math.round((Number(policy.cacheTtlMs) || 86400000) / 3600000)} 小时</div>${subscriptions.map(item => `<div class="kkt-item" style="align-items:flex-start;gap:8px;padding:7px 0;"><div style="flex:1;min-width:0;"><strong>${esc(item.title || item.id)}</strong><br><span class="kkt-item-hint">${esc(item.url)} · ${esc(item.state || 'active')} · ${item.lastCheckedAt ? `上次 ${esc(new Date(item.lastCheckedAt).toLocaleString())}` : '尚未更新'}</span></div><div style="display:flex;gap:5px;flex-shrink:0;"><button type="button" class="btn btn-small btn-secondary" data-life-source-refresh="${esc(item.id)}">更新</button><button type="button" class="btn btn-small btn-neutral" data-life-source-subscription-delete="${esc(item.id)}">移除</button></div></div>`).join('')}`;
    }

    async function renderPackEditor(packId, editor) {
        if (!editor || !global.LifeContextStorage?.listSources || !global.LifeContextStorage?.listChunks) return;
        editor.innerHTML = '<div class="kkt-item-hint">正在读取来源与片段…</div>';
        try {
            const [pack, sources, chunks] = await Promise.all([
                global.LifeContextStorage.getPack(packId),
                global.LifeContextStorage.listSources({ packIds: [packId], limit: 200 }),
                global.LifeContextStorage.listChunks({ packIds: [packId], limit: 1000 }),
            ]);
            editor._lifePackDetails = { pack, sources, chunks };
            const sourceNames = new Map(sources.map(source => [source.id, source.title || source.fileName || source.id]));
            const cards = Array.isArray(pack?.manifest?.cards) ? pack.manifest.cards : (Array.isArray(pack?.cards) ? pack.cards : []);
            const cardMarkup = cards.length ? cards.map((card, index) => `<div class="kkt-group" data-life-card-row="${esc(card.id)}" style="margin:8px 0;">
                <div class="kkt-item" style="display:block;padding:10px 8px;">
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;"><strong>资料卡 ${index + 1}</strong><span class="kkt-item-hint">${esc(card.kind || 'fact')} · ${esc((card.sourceIds || []).join('、') || '无来源')} · ${esc(({ unverified: '未核验', verified: '已核验', conflict: '有冲突', skipped: '已跳过' })[card.verificationStatus] || '未核验')}</span></div>
                    <input data-life-card-field="title" value="${esc(card.title || '')}" placeholder="资料卡标题" style="width:100%;border:1px solid #eee;border-radius:7px;padding:6px;">
                    <textarea data-life-card-field="text" rows="3" style="width:100%;resize:vertical;border:1px solid #eee;border-radius:7px;padding:7px;margin-top:6px;">${esc(card.text || '')}</textarea>
                    <div class="kkt-item-hint" style="margin-top:6px;">核验来源：${esc(card.citation || card.sourceUrl || '尚未记录')} ${card.verificationQuote ? ` · 证据摘录：${esc(card.verificationQuote)}` : ''}</div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;"><select data-life-card-field="reviewStatus" style="border:1px solid #eee;border-radius:7px;padding:6px;">${reviewOptions(card.reviewStatus)}</select><button type="button" class="btn btn-small btn-secondary" data-life-card-save="${esc(card.id)}">保存资料卡</button><button type="button" class="btn btn-small btn-neutral" data-life-card-delete="${esc(card.id)}">删除</button></div>
                </div>
            </div>`).join('') : '<div class="kkt-item-hint">暂无资料卡；请先点击“整理资料卡”从已有来源片段生成候选。</div>';
            const sourceMarkup = sources.length ? sources.map(source => `<div class="kkt-group" data-life-source-row="${esc(source.id)}" style="margin:8px 0;">
                <div class="kkt-item" style="display:block;padding:10px 8px;">
                    <div style="font-weight:600;margin-bottom:6px;">来源：${esc(source.title || source.fileName || source.id)}</div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                        <input data-life-source-field="title" value="${esc(source.title || '')}" placeholder="来源标题" style="flex:1;min-width:140px;border:1px solid #eee;border-radius:7px;padding:6px;">
                        <select data-life-source-field="reviewStatus" style="border:1px solid #eee;border-radius:7px;padding:6px;">${reviewOptions(source.reviewStatus)}</select>
                    </div>
                    <input data-life-source-field="citation" value="${esc(source.citation || '')}" placeholder="引用或出处（可选）" style="width:100%;margin-top:6px;border:1px solid #eee;border-radius:7px;padding:6px;">
                    <div class="kkt-item-hint" style="margin-top:6px;">${esc(source.fileName || '无文件名')} · 原文 ${String((source.rawText || '').length)} 字${source.rightsStatus ? ` · ${esc(source.rightsStatus)}` : ''}</div>
                    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:7px;"><button type="button" class="btn btn-small btn-secondary" data-life-source-save="${esc(source.id)}">保存来源信息</button>${source.sourceState === 'withdrawn' ? '<span class="kkt-item-hint">已撤回，不会参与后续检索</span>' : `<button type="button" class="btn btn-small btn-neutral" data-life-source-withdraw="${esc(source.id)}">撤回来源</button>`}</div>
                </div>
            </div>`).join('') : '<div class="kkt-item-hint">暂无来源元数据</div>';
            const chunkMarkup = chunks.length ? chunks.map((chunk, index) => `<div class="kkt-group" data-life-chunk-row="${esc(chunk.id)}" style="margin:8px 0;">
                <div class="kkt-item" style="display:block;padding:10px 8px;">
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;"><strong>片段 ${index + 1}</strong><span class="kkt-item-hint">${esc(sourceNames.get(chunk.sourceId) || chunk.sourceId || '未标注来源')} · ${esc(chunk.sourceStart == null ? '' : `${chunk.sourceStart}-${chunk.sourceEnd}`)}</span></div>
                    <textarea data-life-chunk-field="text" rows="4" style="width:100%;resize:vertical;border:1px solid #eee;border-radius:7px;padding:7px;">${esc(chunk.text || '')}</textarea>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;"><select data-life-chunk-field="reviewStatus" style="border:1px solid #eee;border-radius:7px;padding:6px;">${reviewOptions(chunk.reviewStatus)}</select><span class="kkt-item-hint">来源引用：${esc(chunk.sourceId || '无')}</span><button type="button" class="btn btn-small btn-secondary" data-life-chunk-save="${esc(chunk.id)}">保存片段</button></div>
                </div>
            </div>`).join('') : '<div class="kkt-item-hint">暂无片段；导入原始资料后会自动生成待核对片段。</div>';
            editor.innerHTML = `<div class="kkt-item-hint" style="margin:6px 0;">资料卡是从已核对来源片段生成的候选摘要；保存前保持“待核对”，不会自动成为角色事实。资料缺口整理、来源核验和联网更新均为低频手动操作，结果同样需要审核。</div><div style="font-weight:600;margin:12px 0 6px;">联网来源订阅</div><div data-life-source-subscriptions>${subscriptionMarkup(pack)}</div><div style="display:flex;gap:8px;align-items:center;margin:7px 0 12px;flex-wrap:wrap;"><button type="button" class="btn btn-small btn-secondary" data-life-source-subscribe="${esc(packId)}">添加来源</button><button type="button" class="btn btn-small btn-secondary" data-life-source-refresh-all="${esc(packId)}">更新到期来源</button></div><div style="display:flex;gap:8px;align-items:center;margin:8px 0 6px;flex-wrap:wrap;"><strong>资料卡（${cards.length}）</strong><button type="button" class="btn btn-small btn-secondary" data-life-card-generate="${esc(packId)}">整理资料卡</button><button type="button" class="btn btn-small btn-secondary" data-life-expansion="${esc(packId)}">查找资料缺口</button><button type="button" class="btn btn-small btn-secondary" data-life-source-verify="${esc(packId)}">核验来源</button></div><div data-life-card-list>${cardMarkup}</div><div style="font-weight:600;margin:12px 0 6px;">来源（${sources.length}）</div><div data-life-source-list>${sourceMarkup}</div><div style="font-weight:600;margin:12px 0 6px;">资料片段（${chunks.length}${chunks.length >= 1000 ? '+' : ''}）</div><div data-life-chunk-list>${chunkMarkup}</div>`;
        } catch (error) {
            console.warn('[LifeContextSettings] 读取片段失败', error);
            editor.innerHTML = '<div class="kkt-item-hint">片段读取失败；不会影响普通聊天。</div>';
        }
    }

    async function saveSourceFromUi(button) {
        const current = character();
        const row = button?.closest?.('[data-life-source-row]');
        const editor = button?.closest?.('[data-life-pack-editor]');
        const source = editor?._lifePackDetails?.sources?.find(item => item.id === row?.dataset.lifeSourceRow);
        if (!current || !row || !source || !global.LifeContextStorage?.updateSource) return;
        const title = row.querySelector('[data-life-source-field="title"]')?.value || source.title;
        const citation = row.querySelector('[data-life-source-field="citation"]')?.value || '';
        const reviewStatus = row.querySelector('[data-life-source-field="reviewStatus"]')?.value || source.reviewStatus;
        const result = await global.LifeContextStorage.updateSource({ ...source, title, citation, reviewStatus });
        if (!result.success) { toast(`来源保存失败：${result.error || '未知错误'}`); return; }
        toast('来源信息已保存');
        await renderPackEditor(source.packId, editor);
    }

    async function saveChunkFromUi(button) {
        const row = button?.closest?.('[data-life-chunk-row]');
        const editor = button?.closest?.('[data-life-pack-editor]');
        const chunk = editor?._lifePackDetails?.chunks?.find(item => item.id === row?.dataset.lifeChunkRow);
        if (!row || !chunk || !global.LifeContextStorage?.updateChunk) return;
        const text = row.querySelector('[data-life-chunk-field="text"]')?.value || '';
        const reviewStatus = row.querySelector('[data-life-chunk-field="reviewStatus"]')?.value || chunk.reviewStatus;
        const result = await global.LifeContextStorage.updateChunk({ ...chunk, text, reviewStatus });
        if (!result.success) { toast(`片段保存失败：${result.error || '未知错误'}`); return; }
        toast('资料片段已保存');
        await renderPackEditor(chunk.packId, editor);
    }

    async function generateCardsFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const packId = button?.dataset?.lifeCardGenerate || editor?.dataset?.lifePackEditor;
        if (!packId || !global.LifeContextStorage?.generateCards) return;
        const result = await global.LifeContextStorage.generateCards(packId);
        if (!result.success) { toast(`资料卡整理失败：${result.error || '未知错误'}`); return; }
        toast(`已生成 ${result.generatedCount || 0} 条资料卡候选，请逐条审核`);
        await renderPackEditor(packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function expandPackFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const pack = editor?._lifePackDetails?.pack;
        const packId = button?.dataset?.lifeExpansion || editor?.dataset?.lifePackEditor;
        if (!packId || !pack || !global.LifeContextExpansion?.expand) return;
        const topic = typeof global.prompt === 'function' ? global.prompt('要补充的生活领域或关键词（如：服装、节日、早餐）', '')?.trim() : '';
        if (!topic) return;
        const manifest = pack.manifest || pack;
        const result = await global.LifeContextExpansion.expand(packId, {
            date: manifest.dateRange?.from || '', regions: manifest.regions || [], cultures: manifest.cultures || [],
            domains: manifest.domains || [], keywords: [topic],
        }, { character: character() });
        if (result.reason === 'not-configured') { toast('请先在记忆宫殿服务 API 中配置并启用生活资料整理'); return; }
        if (result.reason === 'cooldown') { toast('资料整理刚刚运行过，请稍后再试'); return; }
        if (result.reason === 'covered') { toast('当前资料已覆盖这个主题，暂不重复整理'); return; }
        if (!result.success) { toast(`资料缺口整理失败：${result.error || result.reason || '未知错误'}`); return; }
        toast(`已加入 ${result.added?.length || 0} 条待审核候选`);
        await renderPackEditor(packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function verifyPackSourcesFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const packId = button?.dataset?.lifeSourceVerify || editor?.dataset?.lifePackEditor;
        if (!packId || !global.LifeContextSourceProvider?.verify) return;
        const result = await global.LifeContextSourceProvider.verify(packId, { character: character() });
        if (result.reason === 'not-configured') { toast('请先配置并启用来源核验 API'); return; }
        if (result.reason === 'no-pending-cards') { toast('当前没有待核验资料卡'); return; }
        if (!result.success) { toast(`来源核验失败：${result.error || result.reason || '未知错误'}`); return; }
        toast(`已记录 ${result.results?.length || 0} 条来源核验结果，请继续人工审核`);
        await renderPackEditor(packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function addSourceSubscriptionFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const details = editor?._lifePackDetails;
        const pack = details?.pack;
        if (!pack || !global.LifeContextStorage?.updateSourceSubscriptions) return;
        const packId = pack.manifest?.id || pack.id;
        const url = global.prompt('联网来源 URL（必须为 HTTPS）', '')?.trim();
        if (!url) return;
        let parsed;
        try { parsed = new URL(url); } catch (_) { toast('来源 URL 无效'); return; }
        if (parsed.protocol !== 'https:') { toast('为保护隐私，联网来源只允许 HTTPS'); return; }
        const title = global.prompt('来源名称（可留空）', parsed.hostname)?.trim() || parsed.hostname;
        const manifest = pack.manifest || pack;
        const policy = manifest.sourcePolicy || {};
        const hosts = new Set(Array.isArray(policy.allowedHosts) ? policy.allowedHosts : []);
        hosts.add(parsed.hostname.toLowerCase());
        const subscriptions = Array.isArray(manifest.sourceSubscriptions) ? manifest.sourceSubscriptions : [];
        subscriptions.push({ id: `subscription:${Date.now().toString(36)}`, title, url, enabled: true, state: 'active', intervalMs: Number(policy.cacheTtlMs) || 86400000 });
        const result = await global.LifeContextStorage.updateSourceSubscriptions(packId, subscriptions, { ...policy, allowedHosts: [...hosts] });
        if (!result.success) { toast(`来源订阅保存失败：${result.error || '未知错误'}`); return; }
        toast('来源订阅已添加；联网更新仍需全局开关');
        await renderPackEditor(packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function removeSourceSubscriptionFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const details = editor?._lifePackDetails;
        const pack = details?.pack;
        const id = button?.dataset?.lifeSourceSubscriptionDelete;
        if (!pack || !id || !global.confirm('移除这个联网来源订阅？已导入的资料不会被删除。')) return;
        const packId = pack.manifest?.id || pack.id;
        const manifest = pack.manifest || pack;
        const subscriptions = (manifest.sourceSubscriptions || []).filter(item => String(item.id) !== String(id));
        const result = await global.LifeContextStorage.updateSourceSubscriptions(packId, subscriptions, manifest.sourcePolicy);
        if (!result.success) { toast(`来源订阅移除失败：${result.error || '未知错误'}`); return; }
        toast('来源订阅已移除；已导入资料仍保留');
        await renderPackEditor(packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function refreshPackSourcesFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const pack = editor?._lifePackDetails?.pack;
        if (!pack || !global.LifeContextSourceProvider?.refresh) return;
        const subscriptionId = button.dataset.lifeSourceRefresh || '';
        const result = await global.LifeContextSourceProvider.refresh(pack.manifest?.id || pack.id, { character: character(), subscriptionIds: subscriptionId ? [subscriptionId] : undefined });
        const messages = { 'not-configured': '请先配置并启用来源核验 API', 'network-disabled': '全局联网更新开关未开启', 'no-allowlist': '请先添加来源订阅以建立域名白名单', 'subscription-not-allowlisted': '订阅 URL 不在允许域名内', 'cache-fresh': '来源仍在缓存周期内，暂不重复请求' };
        if (result.reason && messages[result.reason]) { toast(messages[result.reason]); return; }
        if (!result.success) { toast(`联网来源更新失败：${result.error || result.reason || '未知错误'}`); return; }
        toast(`已接收 ${result.acceptedSources || 0} 个来源、${result.acceptedCards || 0} 条待审核资料卡`);
        await renderPackEditor(pack.manifest?.id || pack.id, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function withdrawSourceFromUi(button) {
        const editor = button?.closest?.('[data-life-pack-editor]');
        const pack = editor?._lifePackDetails?.pack;
        const sourceId = button?.dataset?.lifeSourceWithdraw;
        if (!pack || !sourceId || !global.confirm('撤回这个来源？关联片段和资料卡将不再参与检索，但不会删除原始记录。')) return;
        const result = await global.LifeContextStorage.withdrawSource(pack.manifest?.id || pack.id, sourceId, '用户手动撤回');
        if (!result.success) { toast(`来源撤回失败：${result.error || '未知错误'}`); return; }
        toast(`来源已撤回，影响 ${result.chunkCount || 0} 个片段`);
        await renderPackEditor(pack.manifest?.id || pack.id, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function saveCardFromUi(button) {
        const row = button?.closest?.('[data-life-card-row]');
        const editor = button?.closest?.('[data-life-pack-editor]');
        const card = editor?._lifePackDetails?.pack?.manifest?.cards?.find(item => item.id === row?.dataset.lifeCardRow)
            || editor?._lifePackDetails?.pack?.cards?.find(item => item.id === row?.dataset.lifeCardRow);
        if (!row || !card || !global.LifeContextStorage?.updateCard) return;
        const title = row.querySelector('[data-life-card-field="title"]')?.value || card.title;
        const text = row.querySelector('[data-life-card-field="text"]')?.value || '';
        const reviewStatus = row.querySelector('[data-life-card-field="reviewStatus"]')?.value || card.reviewStatus;
        const result = await global.LifeContextStorage.updateCard({ ...card, title, text, reviewStatus });
        if (!result.success) { toast(`资料卡保存失败：${result.error || '未知错误'}`); return; }
        toast('资料卡已保存');
        await renderPackEditor(card.packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function deleteCardFromUi(button) {
        const row = button?.closest?.('[data-life-card-row]');
        const editor = button?.closest?.('[data-life-pack-editor]');
        const card = editor?._lifePackDetails?.pack?.manifest?.cards?.find(item => item.id === row?.dataset.lifeCardRow)
            || editor?._lifePackDetails?.pack?.cards?.find(item => item.id === row?.dataset.lifeCardRow);
        if (!row || !card || !global.LifeContextStorage?.deleteCard || !global.confirm('删除这条资料卡候选？来源片段不会被删除。')) return;
        await global.LifeContextStorage.deleteCard(card.packId, card.id);
        toast('资料卡已删除');
        await renderPackEditor(card.packId, editor?.querySelector?.('[data-life-pack-editor-body]') || editor);
    }

    async function renderPacks(characterValue) {
        const list = document.getElementById('setting-life-context-pack-list');
        if (!list || !global.LifeContextStorage?.listPacks) return;
        const token = ++renderToken;
        list.innerHTML = '<div class="kkt-item-hint">正在读取资料包…</div>';
        try {
            const packs = (await global.LifeContextStorage.listPacks()).slice(0, 40);
            if (token !== renderToken) return;
            if (!packs.length) {
                list.innerHTML = '<div class="kkt-item-hint">暂无资料包。可导入 .miolife JSON 文件，导入后再勾选角色要使用的资料包。</div>';
                return;
            }
            const selected = new Set(Array.isArray(characterValue.lifeContextPackIds) ? characterValue.lifeContextPackIds.map(String) : []);
            const detailed = await Promise.all(packs.map(async pack => {
                try { return await global.LifeContextStorage.getPack(pack.id); } catch (_) { return null; }
            }));
            if (token !== renderToken) return;
            list.innerHTML = packs.map((pack, index) => {
                const full = detailed[index];
                const scope = [...(pack.regions || []), ...(pack.cultures || [])].slice(0, 4).join('、') || '未限定地域/文化';
                const checked = selected.has(String(pack.id)) ? ' checked' : '';
                return `<div class="kkt-item" style="align-items:flex-start;gap:10px;padding:11px 8px;border-bottom:1px solid #f5f5f5;">
                    <label style="display:flex;gap:10px;align-items:flex-start;flex:1;min-width:0;cursor:pointer;">
                        <input type="checkbox" data-life-pack-id="${esc(pack.id)}"${checked} style="margin-top:4px;">
                        <span style="min-width:0;"><strong>${esc(pack.name || pack.id)}</strong><br><span class="kkt-item-hint">${esc(scope)} · v${esc(pack.version || '1.0.0')} · ${esc(statusText(pack.status))}</span><br><span class="kkt-item-hint">${esc(reviewSummary(full))}</span></span>
                    </label>
                    <div style="display:flex;gap:5px;flex-shrink:0;align-items:flex-start;"><button type="button" class="btn btn-small btn-secondary" data-life-pack-editor-toggle="${esc(pack.id)}">管理片段</button><button type="button" class="btn btn-small btn-neutral" data-life-pack-delete="${esc(pack.id)}" title="删除本地资料包">删除</button></div>
                </div><details class="kkt-group" data-life-pack-editor="${esc(pack.id)}" style="margin:0 0 8px;padding:0 8px;"><summary style="padding:9px 4px;color:var(--primary-color);font-weight:bold;">来源与片段审核</summary><div data-life-pack-editor-body><div class="kkt-item-hint">点击展开后读取片段…</div></div></details>`;
            }).join('');
            list.querySelectorAll('[data-life-pack-editor]').forEach(details => details.addEventListener('toggle', async () => {
                if (!details.open || details.dataset.loaded === 'true') return;
                details.dataset.loaded = 'true';
                await renderPackEditor(details.dataset.lifePackEditor, details.querySelector('[data-life-pack-editor-body]'));
            }));
        } catch (error) {
            console.warn('[LifeContextSettings] 读取资料包失败', error);
            list.innerHTML = '<div class="kkt-item-hint">资料包读取失败；不会影响普通聊天。请稍后重试。</div>';
        }
    }

    function formatMinute(value) {
        const minute = Math.max(0, Math.min(1439, Number(value) || 0));
        return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    }

    function eventTitle(event) {
        return [event.localDate, formatMinute(event.startMinute), event.activity || event.activityCategory || '生活事件'].filter(Boolean).join(' · ');
    }

    function eventDetails(event) {
        return [
            event.food && `饮食：${event.food}`,
            event.outfit && `服装：${event.outfit}`,
            event.locationRef && `地点：${event.locationRef}`,
            event.narrativePattern && `叙事：${event.narrativePattern}`,
        ].filter(Boolean).join('；');
    }

    function eventStatusText(status) {
        return ({ planned: '计划', committed: '已确定', observed: '已发生', cancelled: '已取消' })[status] || '计划';
    }

    async function renderEvents(characterValue) {
        const list = document.getElementById('setting-life-context-event-list');
        if (!list || !global.LifeContextStorage?.listLifeEvents) return;
        try {
            const events = (await global.LifeContextStorage.listLifeEvents({ characterId: characterValue.id })).slice(0, 24);
            const narrativeSummary = global.LifeContextCore?.summarizeNarrativePatterns
                ? global.LifeContextCore.summarizeNarrativePatterns(events, { limit: 8 }) : { patterns: [] };
            const summaryMarkup = narrativeSummary.patterns?.length
                ? `<div class="kkt-item-hint" style="margin:0 0 8px;">近期归纳：${narrativeSummary.patterns.map(item => `${esc(item.value)}（${item.count}次）`).join('、')}</div>` : '';
            if (!events.length) {
                list.innerHTML = `${summaryMarkup}<div class="kkt-item-hint">暂无近期生活事件。可手动新增，或等待后续生活规划模块写入。</div>`;
                return;
            }
            list.innerHTML = `${summaryMarkup}${events.map(event => `<div class="kkt-item" style="align-items:flex-start;gap:8px;padding:10px 0;">
                <div style="flex:1;min-width:0;"><strong>${esc(eventTitle(event))}</strong><br><span class="kkt-item-hint">${esc(eventStatusText(event.status))}${eventDetails(event) ? ` · ${esc(eventDetails(event))}` : ''}</span></div>
                <div style="display:flex;gap:5px;flex-shrink:0;"><button type="button" class="btn btn-small btn-neutral" data-life-event-edit="${esc(event.id)}">编辑</button><button type="button" class="btn btn-small btn-neutral" data-life-event-delete="${esc(event.id)}">删除</button></div>
            </div>`).join('')}`;
            list._lifeEvents = events;
        } catch (error) {
            console.warn('[LifeContextSettings] 读取生活事件失败', error);
            list.innerHTML = '<div class="kkt-item-hint">生活事件读取失败；不会影响普通聊天。</div>';
        }
    }

    function promptEvent(existing, characterValue) {
        const current = existing || {};
        const date = global.prompt('日期（YYYY 或 YYYY-MM-DD）', current.localDate || '')?.trim();
        if (!date) return null;
        const activity = global.prompt('活动（可留空）', current.activity || '')?.trim() || '';
        const category = global.prompt('活动类别（如 meal、outdoor、work）', current.activityCategory || '')?.trim() || '';
        const food = global.prompt('饮食（可留空）', current.food || '')?.trim() || '';
        const outfit = global.prompt('服装（可留空）', current.outfit || '')?.trim() || '';
        const location = global.prompt('地点（可留空）', current.locationRef || '')?.trim() || '';
        const pattern = global.prompt('叙事套路/场景目的（可留空）', current.narrativePattern || '')?.trim() || '';
        const status = global.prompt('状态：planned / committed / observed / cancelled', current.status || 'planned')?.trim() || 'planned';
        const base = { ...current, id: current.id || `life-event:${characterValue.id}:${Date.now()}`, characterId: characterValue.id, localDate: date, activity, activityCategory: category, food, outfit, locationRef: location, narrativePattern: pattern };
        if (!existing) return global.LifeContextCore.normalizeLifeEvent({ ...base, status });
        const transition = global.LifeContextCore.transitionLifeEvent(existing, status, base);
        if (!transition.ok) { toast(`不能将事件从 ${existing.status} 改为 ${status}`); return null; }
        return transition.event;
    }

    async function addEvent() {
        const current = character();
        if (!current || !global.LifeContextStorage?.saveLifeEvent) return;
        const event = promptEvent(null, current);
        if (!event) return;
        const result = await global.LifeContextStorage.saveLifeEvent(event);
        if (!result.success) { toast(`保存生活事件失败：${result.error || '未知错误'}`); return; }
        toast('生活事件已新增');
        await renderEvents(current);
    }

    async function editEvent(id) {
        const current = character();
        const list = document.getElementById('setting-life-context-event-list');
        const event = list?._lifeEvents?.find(item => item.id === id);
        if (!current || !event) return;
        const next = promptEvent(event, current);
        if (!next) return;
        const result = await global.LifeContextStorage.saveLifeEvent(next);
        if (!result.success) { toast(`保存生活事件失败：${result.error || '未知错误'}`); return; }
        toast('生活事件已更新');
        await renderEvents(current);
    }

    async function deleteEvent(id) {
        if (!global.confirm('删除这条生活事件？此操作不会删除聊天记录。')) return;
        const current = character();
        if (!current || !global.LifeContextStorage?.deleteLifeEvent) return;
        await global.LifeContextStorage.deleteLifeEvent(id);
        toast('生活事件已删除');
        await renderEvents(current);
    }

    async function importPack(file) {
        const current = character();
        if (!current || !file || !global.LifeContextStorage?.importPack) return;
        try {
            const result = await global.LifeContextStorage.importPack(await file.text(), { mode: 'merge' });
            if (!result.success) { toast(`资料包导入失败：${result.validation?.errors?.join('、') || '格式无效'}`); return; }
            toast(`已导入「${result.pack?.name || '资料包'}」；请勾选角色要使用的资料包`);
            await renderPacks(current);
        } catch (error) {
            console.warn('[LifeContextSettings] 导入资料包失败', error);
            toast('资料包导入失败；请确认文件是有效的 .miolife JSON');
        }
    }

    function slug(value) {
        return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'life-pack';
    }

    async function importRawSource(file) {
        const current = character();
        if (!current || !file || !global.LifeContextStorage?.importPack || !global.LifeContextCore?.sanitizeLifeSourceText) return;
        const raw = await file.text();
        const stripHtml = /html/i.test(file.type) || /\.(?:html?|xml)$/i.test(file.name || '');
        const text = global.LifeContextCore.sanitizeLifeSourceText(raw, { stripHtml });
        if (!text) { toast('原始资料为空，未导入'); return; }
        const defaultName = String(file.name || '本地资料').replace(/\.[^.]+$/, '') || '本地资料';
        const name = global.prompt('资料包名称', defaultName)?.trim();
        if (!name) return;
        const scopeText = global.prompt('适用地域/文化（可留空，多个用逗号分隔）', '')?.trim() || '';
        const dateText = global.prompt('适用年代或日期范围（可留空，如 1940 或 1940-1945）', '')?.trim() || '';
        const domainText = global.prompt('生活领域（可留空，如 food、clothing、activity）', '')?.trim() || '';
        const packId = `local:${slug(name)}:${Date.now().toString(36)}`;
        const sourceId = `source:${slug(file.name)}:${Date.now().toString(36)}`;
        const dateParts = dateText.includes('-') ? dateText.split('-', 2) : [dateText, dateText];
        const regions = scopeText.split(/[,，]/).map(value => value.trim()).filter(Boolean);
        const source = { id: sourceId, packId, kind: 'document', title: file.name || name, fileName: file.name || '', mimeType: file.type || '', rawText: text, dateRange: { from: dateParts[0] || '', to: dateParts[1] || '' }, regions, cultures: regions, domains: domainText.split(/[,，]/).map(value => value.trim()).filter(Boolean), reviewStatus: 'unreviewed' };
        const result = await global.LifeContextStorage.importPack({
            format: 'miolife', formatRevision: 1,
            manifest: { id: packId, name, version: '1.0.0', language: 'und', dateRange: source.dateRange, regions, cultures: regions, domains: source.domains, status: 'draft', sources: [source] },
            sources: [source], chunks: [],
        }, { mode: 'merge' });
        if (!result.success) { toast(`原始资料导入失败：${result.validation?.errors?.join('、') || '格式无效'}`); return; }
        toast(`已导入原始资料并生成 ${result.chunkCount || 0} 个待核对片段；请打开“管理片段”审核`);
        await renderPacks(current);
    }

    async function deletePack(id) {
        const current = character();
        if (!current || !global.LifeContextStorage?.deletePack) return;
        if (!global.confirm('删除本地资料包及其片段？聊天记录和记忆不会受影响。')) return;
        await global.LifeContextStorage.deletePack(id);
        current.lifeContextPackIds = (current.lifeContextPackIds || []).filter(value => String(value) !== String(id));
        await persist(current);
        toast('资料包已删除');
        await renderPacks(current);
    }

    function setup() {
        if (bound) return;
        bound = true;
        document.getElementById('setting-life-context-import-btn')?.addEventListener('click', () => document.getElementById('setting-life-context-import-file')?.click());
        document.getElementById('setting-life-context-import-file')?.addEventListener('change', async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) await importPack(file);
        });
        document.getElementById('setting-life-context-import-raw-btn')?.addEventListener('click', () => document.getElementById('setting-life-context-import-raw-file')?.click());
        document.getElementById('setting-life-context-import-raw-file')?.addEventListener('change', async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) await importRawSource(file);
        });
        document.getElementById('setting-life-context-refresh-btn')?.addEventListener('click', async () => { const current = character(); if (current) await renderPacks(current); });
        document.getElementById('setting-life-context-add-event-btn')?.addEventListener('click', addEvent);
        document.getElementById('setting-life-context-refresh-events-btn')?.addEventListener('click', async () => { const current = character(); if (current) await renderEvents(current); });
        document.getElementById('setting-life-context-pack-list')?.addEventListener('change', async event => {
            const input = event.target.closest?.('input[data-life-pack-id]');
            const current = character();
            if (!input || !current) return;
            current.lifeContextPackIds = getSelectedPackIds() || [];
            await persist(current);
        });
        document.getElementById('setting-life-context-pack-list')?.addEventListener('click', async event => {
            const button = event.target.closest?.('[data-life-pack-delete]');
            if (button) await deletePack(button.dataset.lifePackDelete);
            const editorButton = event.target.closest?.('[data-life-pack-editor-toggle]');
            if (editorButton) {
                const details = [...(document.getElementById('setting-life-context-pack-list')?.querySelectorAll('[data-life-pack-editor]') || [])]
                    .find(node => node.dataset.lifePackEditor === (editorButton.dataset.lifePackEditorToggle || ''));
                if (details) details.open = true;
            }
            const sourceSave = event.target.closest?.('[data-life-source-save]');
            if (sourceSave) await saveSourceFromUi(sourceSave);
            const chunkSave = event.target.closest?.('[data-life-chunk-save]');
            if (chunkSave) await saveChunkFromUi(chunkSave);
            const cardGenerate = event.target.closest?.('[data-life-card-generate]');
            if (cardGenerate) await generateCardsFromUi(cardGenerate);
            const expansion = event.target.closest?.('[data-life-expansion]');
            if (expansion) await expandPackFromUi(expansion);
            const sourceVerify = event.target.closest?.('[data-life-source-verify]');
            if (sourceVerify) await verifyPackSourcesFromUi(sourceVerify);
            const sourceSubscribe = event.target.closest?.('[data-life-source-subscribe]');
            if (sourceSubscribe) await addSourceSubscriptionFromUi(sourceSubscribe);
            const sourceRefresh = event.target.closest?.('[data-life-source-refresh-all], [data-life-source-refresh]');
            if (sourceRefresh) await refreshPackSourcesFromUi(sourceRefresh);
            const sourceRemove = event.target.closest?.('[data-life-source-subscription-delete]');
            if (sourceRemove) await removeSourceSubscriptionFromUi(sourceRemove);
            const sourceWithdraw = event.target.closest?.('[data-life-source-withdraw]');
            if (sourceWithdraw) await withdrawSourceFromUi(sourceWithdraw);
            const cardSave = event.target.closest?.('[data-life-card-save]');
            if (cardSave) await saveCardFromUi(cardSave);
            const cardDelete = event.target.closest?.('[data-life-card-delete]');
            if (cardDelete) await deleteCardFromUi(cardDelete);
        });
        document.getElementById('setting-life-context-event-list')?.addEventListener('click', async event => {
            const edit = event.target.closest?.('[data-life-event-edit]');
            const remove = event.target.closest?.('[data-life-event-delete]');
            if (edit) await editEvent(edit.dataset.lifeEventEdit);
            if (remove) await deleteEvent(remove.dataset.lifeEventDelete);
        });
    }

    async function load(characterValue) {
        if (!characterValue) return;
        global.LifeContextRuntime?.ensureSettings?.(characterValue);
        const enabled = document.getElementById('setting-life-context-enabled');
        const maxChars = document.getElementById('setting-life-context-max-chars');
        if (enabled) enabled.checked = characterValue.lifeContextEnabled === true;
        if (maxChars) maxChars.value = String([800, 1200, 1600].includes(Number(characterValue.lifeContextMaxChars)) ? characterValue.lifeContextMaxChars : 1200);
        await Promise.all([renderPacks(characterValue), renderEvents(characterValue)]);
    }

    global.LifeContextSettings = Object.freeze({ setup, load, getSelectedPackIds });
}(window));
