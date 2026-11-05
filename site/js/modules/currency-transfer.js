(function attachCurrencyTransfer(global) {
    'use strict';
    const core = () => global.CurrencyCore;
    const state = { roleId: '', direction: 'user-to-role' };
    let ledgerFxHistory=[],rateGeneration=0,transferring=false,pendingTransfer=null;
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
        return core().currency(kind === 'user' ? global.db?.piggyBank?.currency || wallet?.defaultCurrency : role?.walletLedger?.currency || wallet?.defaultCurrency || 'CNY');
    }
    function selectedRole() { return roles().find(item => String(item.id) === state.roleId) || null; }
    function optionsHtml(selected) { return core().listCurrencies().map(item => `<option value="${item.code}"${item.code === selected ? ' selected' : ''}>${item.name} · ${item.code} · ${item.symbol}</option>`).join(''); }
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
        const preferred = state.roleId === null ? '' : state.roleId || currentChat() || roles()[0]?.id || '';
        roleEl.innerHTML = '<option value="">请选择收款角色</option>' + roles().map(role => `<option value="${escape(String(role.id))}">${escape(roleName(role))}</option>`).join('');
        state.roleId = roles().some(item => String(item.id) === String(preferred)) ? String(preferred) : state.roleId===null?null:'';
        roleEl.value = state.roleId || '';
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
        setCurrencyOptions(source, target);
    }
    let referenceQuote=null,rateController=null;
    const referenceKey=(source,target)=>'mioCurrencyReferenceV1:'+source+':'+target;
    const provider=()=>byId('currency-rate-provider')?.value||'manual';
    const rateKey=(source,target)=>'mioCurrencyRateV1:'+source+':'+target;
    function ratePair(){return [byId('currency-source')?.value,byId('currency-target')?.value];}
    function rateValid(row,source,target){return row?.sourceCurrency===source&&row?.targetCurrency===target&&row.source==='manual'&&core().rateToScaled(row.rate)!=null&&Number.isSafeInteger(row.savedAt)&&row.savedAt>0;}
    function preview(){
        const [source,target]=ratePair(),field=byId('currency-amount'),output=byId('currency-preview');
        if(!field||!output||!core().isSupported(source)||!core().isSupported(target))return;
        field.step=String(10**-core().meta(source).digits);field.min=field.step;field.placeholder=core().meta(source).digits?'0.00':'0';
        if(source===target && source==='CNY'){output.textContent='人民币同币种转账请在聊天中发送，保留待领取流程。';return;}
        const recipient=state.direction==='user-to-role'?roleName(selectedRole()):'用户';
        const amount=core().amountToMinor(field.value,source),rate=source===target?10 ** core().SCALE:core().rateToScaled(byId('currency-rate')?.value);
        const received=core().convertMinor(amount,source,target,rate);
        output.textContent=received>0?'转出 '+core().formatMinor(amount,source)+' '+source+' → '+recipient+' 收到 '+core().formatMinor(received,target)+' '+target+'；确认后直接到账。':source===target?'同币种等额转入'+recipient+'账户，无需汇率；确认后直接到账。':'1 '+source+' = 汇率 × '+target+'；按所选币种精度填写金额，确认后直接到账。';
    }
    async function refreshRate(){
        rateController?.abort();referenceQuote=null;
        const generation=++rateGeneration,[source,target]=ratePair(),field=byId('currency-rate'),info=byId('currency-rate-info');
        if(!field||!info)return;
        field.disabled=source===target||provider()==='ecb';
        byId('currency-fetch-rate').disabled=source===target||provider()!=='ecb';byId('currency-save-rate').disabled=source===target||provider()==='ecb';
        field.value='';info.textContent='正在读取已保存汇率…';preview();
        if(source===target){info.textContent='同币种无需汇率。';return;}
        if(provider()==='ecb'){
            try{
                const cached=(await dexieDB.globalSettings.get(referenceKey(source,target)))?.value;
                if(generation!==rateGeneration)return;
                showReference(cached,source,target);
            }catch{if(generation===rateGeneration)info.textContent='缓存读取失败，可重新获取或切换手动汇率。';}
            return;
        }
        try{
            const saved=(await dexieDB.globalSettings.get(rateKey(source,target)))?.value;
            if(generation!==rateGeneration)return;
            if(rateValid(saved,source,target)){
                field.value=saved.rate;info.textContent='本机手动保存 · '+new Date(saved.savedAt).toLocaleString('zh-CN')+' · 非实时行情。汇率不随备份导出，恢复后请核对。';
            }else{
                info.textContent='此币种对尚未配置手动汇率。手填后可保存，或主动选择现代参考汇率。';
            }
        }catch{if(generation===rateGeneration)info.textContent='保存的汇率暂时无法读取，可手动填写本次汇率。';}
        if(generation===rateGeneration)preview();
    }
    function showReference(row,source,target){
        const quote=core().referenceRate(row,source,target),info=byId('currency-rate-info');
        referenceQuote=quote&&!quote.expired?{...quote,sourceCurrency:source,targetCurrency:target}:null;
        byId('currency-rate').value=referenceQuote?.rate||'';
        info.textContent=quote?'Frankfurter / ECB · 报价日期 '+quote.date+' · '+(quote.expired?'已过期，未应用；请重新获取或切换手动汇率。':'参考价，非实时行情；最多保留 4 天。'):'尚无有效参考报价，请获取或切换手动汇率。';
        preview();
    }
    async function fetchRate(){
        if(provider()!=='ecb')return;
        const [source,target]=ratePair();if(source===target)return;
        rateController?.abort();const controller=new AbortController();rateController=controller;
        const generation=++rateGeneration,button=byId('currency-fetch-rate');button.disabled=true;
        const timer=setTimeout(()=>controller.abort(),10000);
        try{
            const response=await fetch('https://api.frankfurter.dev/v2/rate/'+source.toLowerCase()+'/'+target.toLowerCase()+'?providers=ecb',{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
            if(!response.ok)throw Error('RATE_UNAVAILABLE');
            const row=await response.json();if(!core().referenceRate(row,source,target))throw Error('INVALID_RATE');
            if(generation!==rateGeneration)return;
            await dexieDB.globalSettings.put({key:referenceKey(source,target),value:row});
            if(generation===rateGeneration)showReference(row,source,target);
        }catch{
            if(generation===rateGeneration){
                const quote=referenceQuote;
                if(quote&&Date.now()-Date.parse(quote.date+'T00:00:00Z')>4*86400000){referenceQuote=null;byId('currency-rate').value='';}
                byId('currency-rate-info').textContent='获取失败；'+(referenceQuote?'保留缓存 Frankfurter / ECB · '+referenceQuote.date+'，非实时行情。':'无有效报价，可切换手动汇率。');
            }
        }finally{clearTimeout(timer);if(generation===rateGeneration)button.disabled=false;}
    }
    // This device preference is scoped to the current database; it never changes transaction snapshots.
    async function storeRate(source,target,rate){
        if(!core().isSupported(source)||!core().isSupported(target)||source===target||core().rateToScaled(rate)==null)throw Error('INVALID_RATE');
        const key=rateKey(source,target),existing=(await dexieDB.globalSettings.get(key))?.value;
        if(rateValid(existing,source,target)&&core().rateToScaled(existing.rate)===core().rateToScaled(rate))return;
        await dexieDB.globalSettings.put({key,value:{sourceCurrency:source,targetCurrency:target,rate:String(rate).trim(),source:'manual',savedAt:Date.now()}});
    }
    async function saveRate(){
        const [source,target]=ratePair(),rate=byId('currency-rate')?.value,button=byId('currency-save-rate');
        if(button)button.disabled=true;
        try{await storeRate(source,target,rate);if(ratePair().join(':')===[source,target].join(':'))await refreshRate();status('汇率已保存，下次自动使用。');}
        catch{status('汇率未保存，请填写有效的不同币种汇率，或稍后重试。');}
        finally{if(button)button.disabled=false;}
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
            return `<li><span>${other} · ${escape(item.remark || '转账')}<small>${new Date(item.createdAt).toLocaleString('zh-CN')}</small></span><strong>${sending ? '-' : '+'}${core().formatMinor(amount, code)}<small>${sending ? '对方收到 ' : '对方发送 '}${received}</small></strong></li>`;
        }).join('') : '<li class="currency-empty">暂无转账记录</li>';
    }
    let renderGeneration=0;
    async function render(preservePair=false){
        const pair=preservePair?ratePair():null,generation=++renderGeneration;
        renderRoleOptions();
        try{
            if(global.WalletLedger?.cachedMode()&&global.WalletLedger.cachedMode()!=='legacy'){
                const user=await global.WalletSystem.refresh('user');if(!user.ok)throw Error('READ_FAILED');
                if(state.roleId){const role=await global.WalletSystem.refresh(state.roleId);if(!role.ok)throw Error('READ_FAILED');}
                ledgerFxHistory=await global.WalletSystem.fxHistory('user',state.roleId||'');
            }
            if(generation!==renderGeneration)return;
            renderDefaults();if(pair)setCurrencyOptions(...pair);renderHistory();await refreshRate();
        }catch{status('钱包读取失败，请重新打开');}
    }
    async function open({roleId=null}={}){
        state.roleId=roles().some(row=>String(row.id)===String(roleId))?String(roleId):null;state.direction='user-to-role';
        global.WalletSystem.openView('settings');
        await render();byId(state.roleId?'currency-amount':'currency-role-select')?.focus();byId('currency-transfer-card')?.scrollIntoView({block:'start'});
    }
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
        if(transferring)return;
        const role=selectedRole();if(!role)return status('请先选择一个角色');
        const userToRole=state.direction==='user-to-role',fromOwnerId=userToRole?userOwnerId:String(role.id),toOwnerId=userToRole?String(role.id):userOwnerId;
        const [sourceCurrency,targetCurrency]=ratePair(),rawAmount=byId('currency-amount')?.value||'',rawRate=sourceCurrency===targetCurrency?'1':(byId('currency-rate')?.value||'').trim();
        const amountMinor=core().amountToMinor(rawAmount,sourceCurrency),rateScaled=core().rateToScaled(rawRate);
        if(sourceCurrency===targetCurrency && sourceCurrency==='CNY')return status('人民币同币种转账请在聊天中发送，保留待领取流程。');
        if(amountMinor==null||amountMinor<=0)return status('金额格式无效，请按当前币种精度填写');
        if(sourceCurrency!==targetCurrency&&provider()==='ecb'&&(!referenceQuote||referenceQuote.sourceCurrency!==sourceCurrency||referenceQuote.targetCurrency!==targetCurrency||referenceQuote.rate!==rawRate||Date.now()-Date.parse(referenceQuote.date+'T00:00:00Z')>4*86400000))return status('参考报价缺失或已过期，请重新获取或切换手动汇率');
        if(rateScaled==null)return status('汇率尚未配置，请手填一次并保存');
        const input={kind:'exchange',ownerId:fromOwnerId,targetOwnerId:toOwnerId,sourceCurrency,targetCurrency,amountMinor,rateScaled,rate:rawRate,remark:byId('currency-remark')?.value||''};
        const fingerprint=JSON.stringify(input);if(pendingTransfer?.fingerprint!==fingerprint)pendingTransfer={fingerprint,idempotencyKey:crypto.randomUUID()};
        transferring=true;const controls=[...byId('currency-transfer-card').querySelectorAll('input,select,button')].map(el=>({el,disabled:el.disabled}));controls.forEach(({el})=>el.disabled=true);
        try{
            const response=await global.WalletSystem.command({...input,idempotencyKey:pendingTransfer.idempotencyKey});
            if(!response.ok)return status(response.reason||response.error.code);
            pendingTransfer=null;byId('currency-amount').value='';byId('currency-remark').value='';
            let saved=true;try{if(sourceCurrency!==targetCurrency&&provider()==='manual')await storeRate(sourceCurrency,targetCurrency,rawRate);}catch{saved=false;}
            await render(true);global.renderPiggyBankScreen?.();
            status('转账成功，对方收到 '+core().formatMinor(response.data.targetAmountMinor,targetCurrency)+' '+targetCurrency+(sourceCurrency===targetCurrency?'；同币种无需汇率。':provider()==='ecb'?'；参考汇率已固定于本笔交易。':saved?'；汇率已保存复用。':'；汇率未能保存，下次需重新填写。'));
        }catch{status('转账结果暂时无法确认，请核对流水后重试。');}
        finally{transferring=false;controls.forEach(({el,disabled})=>el.disabled=disabled);}
    }
    function setup() {
        if (!byId('currency-transfer-card') || byId('currency-transfer-card').dataset.ready) return;
        byId('currency-transfer-card').dataset.ready = 'true';
        byId('currency-role-select')?.addEventListener('change', event => { state.roleId = event.target.value; render(); });
        byId('currency-direction')?.addEventListener('change', event => { state.direction = event.target.value; renderDefaults(); void refreshRate(); });
        byId('currency-save-defaults')?.addEventListener('click', () => void saveDefaults());
        byId('currency-submit')?.addEventListener('click', () => void transfer());
        for(const id of ['currency-source','currency-target'])byId(id)?.addEventListener('change',()=>void refreshRate());
        byId('currency-rate')?.addEventListener('input',()=>{rateGeneration++;byId('currency-rate-info').textContent='手动输入 · 本次确认转账后保存；非实时行情';preview();});
        byId('currency-amount')?.addEventListener('input',preview);
        byId('currency-rate-provider')?.addEventListener('change',()=>void refreshRate());
        byId('currency-fetch-rate')?.addEventListener('click',()=>void fetchRate());
        byId('currency-save-rate')?.addEventListener('click',()=>void saveRate());
        void render();
    }
    global.CurrencyTransfer = { setup, render, open, transfer, saveRate, refreshRate, fetchRate, ensureUserWallet, ensureRoleWallet, get state() { return state; } };
})(typeof window !== 'undefined' ? window : globalThis);
