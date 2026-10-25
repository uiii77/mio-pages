(function attachCurrencyTransfer(global) {
    'use strict';
    const core = () => global.CurrencyCore;
    const state = { roleId: '', direction: 'user-to-role' };
    let ledgerFxHistory=[];
    const byId = id => global.document?.getElementById(id);
    const userOwnerId = 'user';
    function currentChat() {
        try { if (typeof currentChatId !== 'undefined' && currentChatType === 'private') return String(currentChatId); } catch (_) {}
        return '';
    }
    function roles() { return Array.isArray(global.db?.characters) ? global.db.characters : []; }
    function ledgerWallet(ownerId){const value=global.WalletLedger?.snapshot(ownerId);return {defaultCurrency:value?.defaultCurrency||'CNY',accounts:Object.fromEntries((value?.accounts||[]).map(row=>[row.currency,{...row}])),transactions:value?.currencyTransactions||[]};}
    function ensureUserWallet() {
        if(global.WalletLedger?.cachedMode()&&global.WalletLedger.cachedMode()!=='legacy')return ledgerWallet('user');
        if (!global.db.piggyBank || typeof global.db.piggyBank !== 'object') global.db.piggyBank = { balance: 520, transactions: [] };
        const bank = global.db.piggyBank;
        const legacyBalance = Number.isFinite(Number(bank.balance)) ? Number(bank.balance) : 520;
        bank.currencyWallet = core().normalizeWallet(bank.currencyWallet, legacyBalance, bank.currency || 'CNY');
        if (bank.legacyCurrencyBalanceSnapshot === undefined) bank.legacyCurrencyBalanceSnapshot = legacyBalance;
        if (Number(bank.balance) !== Number(bank.legacyCurrencyBalanceSnapshot)) {
            core().setBalance(bank.currencyWallet, 'CNY', Math.max(0, Math.round(legacyBalance * 100)));
            bank.legacyCurrencyBalanceSnapshot = legacyBalance;
        }
        return bank.currencyWallet;
    }
    function ensureRoleWallet(role) {
        if (!role) return null;
        if(global.WalletLedger?.cachedMode()&&global.WalletLedger.cachedMode()!=='legacy')return ledgerWallet(String(role.id));
        if (!role.walletLedger || typeof role.walletLedger !== 'object') role.walletLedger = { balance: null, transactions: [] };
        const ledger = role.walletLedger;
        const legacyBalance = Number.isFinite(Number(ledger.balance)) ? Number(ledger.balance) : null;
        ledger.currencyWallet = core().normalizeWallet(ledger.currencyWallet, legacyBalance, ledger.currency || 'CNY');
        if (ledger.legacyCurrencyBalanceSnapshot === undefined) ledger.legacyCurrencyBalanceSnapshot = legacyBalance;
        if (legacyBalance !== null && Number(legacyBalance) !== Number(ledger.legacyCurrencyBalanceSnapshot)) {
            core().setBalance(ledger.currencyWallet, 'CNY', Math.max(0, Math.round(legacyBalance * 100)));
            ledger.legacyCurrencyBalanceSnapshot = legacyBalance;
        }
        return ledger.currencyWallet;
    }
    function roleName(role) { return role?.remarkName || role?.realName || role?.name || '角色'; }
    function ownerWallet(kind, role) { return kind === 'user' ? ensureUserWallet() : ensureRoleWallet(role); }
    function getDefault(kind, role) {
        const wallet = ownerWallet(kind, role);
        if(global.WalletLedger?.cachedMode()==='ledger')return wallet?.defaultCurrency||'CNY';
        return core().currency(kind === 'user' ? global.db?.piggyBank?.currency : role?.walletLedger?.currency || wallet?.defaultCurrency || 'CNY');
    }
    function selectedRole() { return roles().find(item => String(item.id) === state.roleId) || null; }
    function optionsHtml(selected) { return core().listCurrencies().map(item => `<option value="${item.code}"${item.code === selected ? ' selected' : ''}>${item.code} · ${item.name}</option>`).join(''); }
    function setCurrencyOptions(source, target) {
        const sourceEl = byId('currency-source');
        const targetEl = byId('currency-target');
        if (!sourceEl || !targetEl) return;
        sourceEl.innerHTML = optionsHtml(source);
        targetEl.innerHTML = optionsHtml(target);
        sourceEl.value = source; targetEl.value = target;
    }
    function renderRoleOptions() {
        const roleEl = byId('currency-role-select');
        if (!roleEl) return;
        const preferred = state.roleId || currentChat() || roles()[0]?.id || '';
        roleEl.innerHTML = roles().map(role => `<option value="${String(role.id)}">${escape(roleName(role))}</option>`).join('');
        state.roleId = roles().some(item => String(item.id) === String(preferred)) ? String(preferred) : String(roles()[0]?.id || '');
        roleEl.value = state.roleId;
    }
    function renderDefaults() {
        const role = selectedRole();
        const userDefault = getDefault('user', role);
        const roleDefault = getDefault('role', role) || 'CNY';
        const userEl = byId('currency-user-default');
        const roleEl = byId('currency-role-default');
        if (userEl) { userEl.innerHTML = optionsHtml(userDefault); userEl.value = userDefault; }
        if (roleEl) { roleEl.innerHTML = optionsHtml(roleDefault); roleEl.value = roleDefault; roleEl.disabled = !role; }
        const direction = byId('currency-direction');
        if (direction) direction.value = state.direction;
        let source = state.direction === 'user-to-role' ? userDefault : roleDefault;
        let target = state.direction === 'user-to-role' ? roleDefault : userDefault;
        if (source === target) target = core().listCurrencies().find(item => item.code !== source)?.code || 'USD';
        setCurrencyOptions(source, target);
    }
    function renderHistory() {
        const list = byId('currency-transfer-history');
        if (!list) return;
        const role = selectedRole();
        const userWallet = ensureUserWallet();
        const roleWallet = ensureRoleWallet(role);
        const entries = [...(global.WalletLedger?.cachedMode()==='ledger'?ledgerFxHistory:userWallet?.transactions || [])].filter(item => item.toOwnerId === String(role?.id || '') || item.fromOwnerId === String(role?.id || '')).slice(0, 20);
        list.innerHTML = entries.length ? entries.map(item => {
            const sending = item.type === 'send';
            const amount = sending ? item.sourceAmountMinor : item.targetAmountMinor;
            const code = sending ? item.fromCurrency : item.toCurrency;
            const other = sending ? `→ ${escape(roleName(role))}` : `← ${escape(roleName(role))}`;
            const received = `${core().formatMinor(sending ? item.targetAmountMinor : item.sourceAmountMinor, sending ? item.toCurrency : item.fromCurrency)}`;
            return `<li><span>${other} · ${escape(item.remark || '跨币种转账')}<small>${new Date(item.createdAt).toLocaleString('zh-CN')}</small></span><strong>${sending ? '-' : '+'}${core().formatMinor(amount, code)}<small>${sending ? '对方收到 ' : '对方发送 '}${received}</small></strong></li>`;
        }).join('') : '<li class="currency-empty">暂无跨币种转账记录</li>';
    }
    let renderGeneration=0;
    function render(){renderRoleOptions();if(global.WalletLedger?.cachedMode()==='ledger'){const generation=++renderGeneration,roleId=state.roleId;return (async()=>{await global.WalletSystem.refresh('user');if(roleId)await global.WalletSystem.refresh(String(roleId));const transactions=await global.WalletSystem.fxHistory('user',String(roleId));if(generation!==renderGeneration)return;ledgerFxHistory=transactions;renderDefaults();renderHistory();})().catch(()=>status('账本读取失败，请重新打开'));}renderDefaults();renderHistory();}
    function escape(value) { const node = global.document.createElement('div'); node.textContent = String(value ?? ''); return node.innerHTML; }
    async function saveDefaults() {
        const role = selectedRole();
        const user=await global.WalletSystem.command({kind:'preferences',ownerId:'user',currency:byId('currency-user-default')?.value || 'CNY',idempotencyKey:crypto.randomUUID()});
        const character=role ? await global.WalletSystem.command({kind:'preferences',ownerId:role.id,currency:byId('currency-role-default')?.value || 'CNY',idempotencyKey:crypto.randomUUID()}) : {ok:true};
        status(user.ok && character.ok ? '默认货币已保存' : '默认货币保存失败');
        render();
    }
    function status(message) { const el = byId('currency-transfer-status'); if (el) el.textContent = message; }
    async function transfer() {
        const role = selectedRole();
        if (!role) return status('请先选择一个角色');
        const userToRole = state.direction === 'user-to-role';
        const fromOwnerId = userToRole ? userOwnerId : String(role.id);
        const toOwnerId = userToRole ? String(role.id) : userOwnerId;
        const sourceCurrency = byId('currency-source')?.value || 'CNY';
        const targetCurrency = byId('currency-target')?.value || 'USD';
        const rawAmount = byId('currency-amount')?.value || '';
        const rawRate = byId('currency-rate')?.value || '';
        const amountMinor = core().amountToMinor(rawAmount, sourceCurrency);
        const rateScaled = core().rateToScaled(rawRate);
        if (amountMinor == null) return status('金额格式无效，请按当前币种精度填写');
        if (rateScaled == null) return status('汇率必须是大于 0 的数字');
        const response = await global.WalletSystem.command({kind:'exchange',ownerId:fromOwnerId,targetOwnerId:toOwnerId,
            sourceCurrency,targetCurrency,amountMinor,rateScaled,rate:String(rawRate).trim(),remark:byId('currency-remark')?.value || '',idempotencyKey:crypto.randomUUID()});
        if (!response.ok) return status(response.reason || response.error.code);
        const received = core().formatMinor(response.data.targetAmountMinor, targetCurrency);
        status(`转账成功，对方收到 ${received}`);
        const amountEl = byId('currency-amount'); if (amountEl) amountEl.value = '';
        const remarkEl = byId('currency-remark'); if (remarkEl) remarkEl.value = '';
        render();
    }
    function setup() {
        if (!byId('currency-transfer-card') || byId('currency-transfer-card').dataset.ready) return;
        byId('currency-transfer-card').dataset.ready = 'true';
        byId('currency-role-select')?.addEventListener('change', event => { state.roleId = event.target.value; render(); });
        byId('currency-direction')?.addEventListener('change', event => { state.direction = event.target.value; renderDefaults(); });
        byId('currency-save-defaults')?.addEventListener('click', () => void saveDefaults());
        byId('currency-submit')?.addEventListener('click', () => void transfer());
        render();
    }
    global.CurrencyTransfer = { setup, render, transfer, ensureUserWallet, ensureRoleWallet, get state() { return state; } };
})(typeof window !== 'undefined' ? window : globalThis);
