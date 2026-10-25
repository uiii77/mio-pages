// User-only reconciliation view. Opening the view never starts a migration.
(function () {
    'use strict';
    let busy = false;
    function element(tag, text) { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; }
    async function open() {
        if (busy) return;
        const existing = document.getElementById('economy-reconciliation-dialog');
        if (existing) { existing.showModal(); return; }
        const dialog = element('dialog'); dialog.id = 'economy-reconciliation-dialog';
        Object.assign(dialog.style, { width: 'min(480px,calc(100vw - 32px))', maxHeight: '85dvh', overflow: 'auto', boxSizing: 'border-box', borderRadius: '18px', background: 'var(--mio-surface,#fff)', color: 'var(--text-color,#333)', border: '1px solid #ddd', padding: '20px' });
        dialog.append(element('h2', '钱包迁移核对'));
        const close = element('button', '关闭'); close.className = 'btn btn-secondary';
        close.onclick = () => { if (!busy) { dialog.close(); dialog.remove(); } };
        dialog.append(close);
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else dialog.remove(); });
        const status = element('p', '正在读取…'); status.setAttribute('role', 'status'); dialog.append(status);
        document.body.append(dialog); dialog.showModal();
        try {
            const service = EconomyMigrationStorage.forDatabase(dexieDB);
            const cutover=window.WalletCutover?.forDatabase(dexieDB);
            const recoveryService=cutover && (await cutover.status()).activationJournalId ? cutover : service;
            const result = await service.getReconciliation();
            if (!result.ok) throw new Error('读取失败');
            if (!result.data) { status.textContent = '尚无已执行的迁移核对记录。此页面不会启动迁移或更改旧钱包。'; return; }
            const original = await dexieDB.economyJournals.get(EconomyMigrationCore.journalId);
            status.textContent = '请逐项核对原始记录。确认金额只建立核对后的期初账户，不会补执行旧转账。';
            const resolved = new Set(result.data.resolutions.flatMap(row => row.entries.map(entry => entry.ownerId)));
            const owners = [...new Set(result.data.checklist.flatMap(row => [row.ownerId, row.relatedOwnerId]).filter(Boolean))];
            for (const ownerId of owners) {
                const character = (db.characters || []).find(row => String(row.id) === ownerId);
                const section = element('section'); section.append(element('h3', ownerId === 'user' ? '我的账户' : (character?.realName || character?.name || `角色账户 ${ownerId}`)));
                const explanations = { BALANCE_CONFLICT: '旧余额与币种账户余额不一致', UNKNOWN_BALANCE: '余额未知，需要人工确认', PENDING_TRANSFER_REVIEW: '待领取转账：无法确认原始扣款，请核对双方记录',GROUP_PENDING_TRANSFER_REVIEW:'旧群聊转账待核对，关联账户需要一起确认',RELATED_GRANT_REVIEW:'关联亲属卡的账户需要一起核对', RELATED_TRANSFER_REVIEW: '关联转账的另一账户需要核对', INVALID_ACCOUNT_BALANCE: '币种账户金额无效', INVALID_LEGACY_BALANCE: '旧余额金额无效', TRANSFER_HISTORY_CONFLICT: '转账双方记录不一致', ORDER_HISTORY_CONFLICT: '订单与扣款流水金额不一致' };
                for (const code of new Set(result.data.checklist.filter(row => row.ownerId === ownerId || row.relatedOwnerId === ownerId).map(row => row.code))) section.append(element('p', explanations[code] || '原始记录需要人工核对，请查看下方详情。'));
                const details = element('details'); details.append(element('summary', '查看原始余额、流水与转账状态'));
                const raw = ownerId === 'user' ? result.data.sourceSnapshot.piggyBank : result.data.sourceSnapshot.characters.find(row => String(row.id) === ownerId);
                details.addEventListener('toggle', () => { if (details.open && !details.querySelector('pre')) { const pre = element('pre', JSON.stringify(raw, null, 2)); pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere'; details.append(pre); } }); section.append(details);
                if (resolved.has(ownerId)) section.append(element('p', '已确认恢复；重复操作不会再次入账。'));
                else {
                    const form = element('form');
                    const fields = {};
                    for (const [name, title, type] of [['amount', '核对后的全部币种余额，每行如 CNY=100.00', 'text'], ['reason', '确认依据', 'text']]) {
                        const label = element('label', title); Object.assign(label.style, { display: 'block', margin: '14px 0', fontSize: '14px', lineHeight: '1.6' });
                        const input = element(name === 'amount' ? 'textarea' : 'input'); if (name !== 'amount') input.type = type; input.required = true; input.name = name; Object.assign(input.style, { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: '6px', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border-color,#ddd)', background: 'var(--input-bg,#f8f8f8)', color: 'inherit', font: 'inherit' }); if (name === 'amount') input.rows = 3;
                                                label.append(input); form.append(label); fields[name] = input;
                    }
                    const label = element('label', '我已核对原始记录，确认上述金额；不自动补扣或补发旧转账。');
                    const checkbox = element('input'); label.style.display = 'block'; label.style.margin = '14px 0'; checkbox.type = 'checkbox'; checkbox.required = true; label.prepend(checkbox); form.append(label);
                    const submit = element('button', '确认恢复'); submit.type = 'submit'; submit.className = 'btn btn-primary'; form.append(submit);
                    form.onsubmit = async event => {
                        event.preventDefault(); if (busy) return;
                        const monies = fields.amount.value.trim().split(/\n/).map(line => { const parts = line.split('='); return parts.length === 2 ? EconomyCore.parseMoney(parts[1].trim(), parts[0].trim().toUpperCase()) : { ok: false }; });
                        if (!monies.length || monies.some(money => !money.ok)) { status.textContent = '请填写有效币种与精确余额。'; return; }
                        busy = true; submit.disabled = true; close.disabled = true;
                        try {
                            const saved = await recoveryService.confirmRecovery({ ownerId, confirmed: checkbox.checked, reason: fields.reason.value,
                                expectedFingerprint: original.requestFingerprint, balances: monies.map(money => money.data) });
                            if (!saved.ok) { status.textContent = `未恢复：${saved.error.code}。请保留原记录并重新核对。`; return; }
                            form.replaceWith(element('p', '已确认恢复。')); status.textContent = saved.data.requiresGrantReview?'余额核对已保存；关联账户和历史亲属卡仍按核对状态限制。':'恢复记录已保存。';
                        } catch (_) { status.textContent = '保存失败，原数据保留，可重试。'; }
                        finally { busy = false; submit.disabled = false; close.disabled = false; }
                    };
                    section.append(form);
                }
                dialog.append(section);
            }
        } catch (_) { status.textContent = '核对记录读取失败，请稍后重试。'; }
    }
    document.addEventListener('click', event => { if (event.target.closest('[data-economy-reconciliation]')) open(); });
})();
