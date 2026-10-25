// --- 聊天辅助功能模块 ---

// 辅助功能
function setupVoiceMessageSystem() {
    const voiceMessageBtn = document.getElementById('voice-message-btn');
    const sendVoiceForm = document.getElementById('send-voice-form');
    const sendVoiceModal = document.getElementById('send-voice-modal');
    const voiceDurationPreview = document.getElementById('voice-duration-preview');
    const voiceTextInput = document.getElementById('voice-text-input');

    const toggleBtn = document.getElementById('voice-record-toggle-btn');
    const cancelBtn = document.getElementById('voice-record-cancel-btn');
    const sendBtn = document.getElementById('voice-record-send-btn');
    const status = document.getElementById('voice-record-status');
    const preview = document.getElementById('voice-record-preview');
    let session = null;
    let recording = null;
    let timer = null;
    let startedAt = 0;

    const reset = () => {
        if (session) session.cancel();
        session = null; recording = null; clearInterval(timer); timer = null;
        sendVoiceForm.reset();
        voiceDurationPreview.textContent = '0"';
        status.textContent = '尚未录音';
        toggleBtn.textContent = '开始录音';
        cancelBtn.style.display = 'none';
        sendBtn.disabled = true;
        preview.pause(); preview.removeAttribute('src'); preview.style.display = 'none';
    };

    voiceMessageBtn.addEventListener('click', () => {
        reset();
        sendVoiceForm.reset();
        sendVoiceModal.classList.add('visible');
    });

    toggleBtn.addEventListener('click', async () => {
        if (session) {
            toggleBtn.disabled = true; status.textContent = '正在完成转写…';
            try {
                recording = await session.stop();
                session = null; clearInterval(timer); timer = null;
                voiceTextInput.value = recording.transcriptOriginal || voiceTextInput.value;
                status.textContent = recording.sttSource === 'cloud' ? '云端转写完成' : recording.sttSource === 'browser' ? '浏览器转写完成' : '录音完成，请手动补充原文';
                preview.src = recording.dataUrl; preview.style.display = 'block';
                sendBtn.disabled = !voiceTextInput.value.trim();
                toggleBtn.textContent = '重新录音'; cancelBtn.style.display = 'inline-block';
            } catch (error) { session = null; clearInterval(timer); showToast(error.message); status.textContent = '录音或转写失败'; }
            finally { toggleBtn.disabled = false; }
            return;
        }
        if (recording) reset();
        try {
            voiceTextInput.value = '';
            session = await RecordedAudioService.start({
                onPartial: text => { voiceTextInput.value = text; },
                onBrowserError: message => { if (message) status.textContent = `${message}；停止后将按设置处理`; },
                onState: value => { if (value === 'transcribing-cloud') status.textContent = '浏览器识别不可用，正在云端转写…'; }
            });
            startedAt = Date.now(); status.textContent = '正在录音'; toggleBtn.textContent = '停止录音'; cancelBtn.style.display = 'inline-block';
            timer = setInterval(() => { voiceDurationPreview.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}"`; }, 250);
        } catch (error) { showToast(error.message); status.textContent = '无法开始录音'; }
    });

    cancelBtn.addEventListener('click', reset);
    voiceTextInput.addEventListener('input', () => { sendBtn.disabled = !recording || !voiceTextInput.value.trim(); });
    sendVoiceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!recording || !voiceTextInput.value.trim()) return;
        sendBtn.disabled = true;
        try { await sendMyVoiceMessage(voiceTextInput.value.trim(), recording); reset(); }
        catch (error) { showToast('语音发送失败：' + error.message); sendBtn.disabled = false; }
    });
}

async function sendMyVoiceMessage(text, recording) {
    if (!text || !recording) return;
    document.getElementById('send-voice-modal').classList.remove('visible');
    return new Promise((resolve, reject) => setTimeout(async () => {
        try {
        const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
        if (!chat.history) chat.history = [];

        // --- 添加时间感知逻辑 ---
        if (db.apiSettings && db.apiSettings.timePerceptionEnabled) {
            const now = new Date();
            const lastMessageTime = chat.lastUserMessageTimestamp;
            if (lastMessageTime) {
                const timeGap = now.getTime() - lastMessageTime;
                const thirtyMinutes = 30 * 60 * 1000;

                if (timeGap > thirtyMinutes) {
                    const displayContent = `[system-display:距离上次聊天已经过去 ${formatTimeGap(timeGap)}]`;
                    const visualMessage = {
                        id: `msg_visual_timesense_${Date.now()}`,
                        role: 'system',
                        content: displayContent,
                        parts: [],
                        timestamp: now.getTime() - 2
                    };

                    if (currentChatType === 'group') {
                        visualMessage.senderId = 'user_me';
                    }

                    chat.history.push(visualMessage);
                    addMessageBubble(visualMessage, currentChatId, currentChatType);
                }
            }
            chat.lastUserMessageTimestamp = now.getTime();
        }
        // ----------------------

        const myName = (currentChatType === 'private') ? chat.myName : chat.me.nickname;
        const content = `[${myName}的语音：${text}]`;
        const messageId = `msg_${Date.now()}`;
        const audioAssetId = await RecordedAudioService.saveAsset(recording, { chatId: currentChatId, messageId });
        const message = {
            id: messageId,
            role: 'user',
            content: content,
            parts: [{type: 'text', text: content}],
            timestamp: Date.now(),
            messageType: 'recorded-audio',
            audioAssetId,
            transcriptOriginal: text,
            translation: recording.translation || '',
            audioDurationMs: recording.durationMs || 0,
            audioLanguage: recording.language || '',
            sttSource: recording.sttSource || '',
            sttError: recording.sttError || ''
        };
        if (currentChatType === 'group') {
            message.senderId = 'user_me';
        }
        chat.history.push(message);
        addMessageBubble(message, currentChatId, currentChatType);
        await saveCurrentChat();
        renderChatList();
        resolve(message);
        } catch (error) { reject(error); }
    }, 100));
}

function setupPhotoVideoSystem() {
    const photoVideoBtn = document.getElementById('photo-video-btn');
    const sendPvForm = document.getElementById('send-pv-form');
    const sendPvModal = document.getElementById('send-pv-modal');
    const pvTextInput = document.getElementById('pv-text-input');

    photoVideoBtn.addEventListener('click', () => {
        document.getElementById('image-recognition-btn').click();
    });
    document.getElementById('photo-description-open-btn')?.addEventListener('click', () => {
        sendPvForm.reset();
        sendPvForm.hidden = false;
        sendPvModal.classList.add('visible');
        pvTextInput.focus();
    });
    document.getElementById('photo-description-btn').addEventListener('click', () => {
        sendPvForm.hidden = false;
        pvTextInput.focus();
    });
    sendPvForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendMyPhotoVideo(pvTextInput.value.trim());
    });
}

function sendMyPhotoVideo(text) {
    if (!text) return;
    document.getElementById('send-pv-modal').classList.remove('visible');
    const targetChatId=currentChatId, targetChatType=currentChatType;
    setTimeout(() => {
        const chat = (targetChatType === 'private') ? db.characters.find(c => c.id === targetChatId) : db.groups.find(g => g.id === targetChatId);
        if (!chat) return;
        if (!chat.history) chat.history = [];

        // --- 添加时间感知逻辑 ---
        if (db.apiSettings && db.apiSettings.timePerceptionEnabled) {
            const now = new Date();
            const lastMessageTime = chat.lastUserMessageTimestamp;
            if (lastMessageTime) {
                const timeGap = now.getTime() - lastMessageTime;
                const thirtyMinutes = 30 * 60 * 1000;

                if (timeGap > thirtyMinutes) {
                    const displayContent = `[system-display:距离上次聊天已经过去 ${formatTimeGap(timeGap)}]`;
                    const visualMessage = {
                        id: `msg_visual_timesense_${Date.now()}`,
                        role: 'system',
                        content: displayContent,
                        parts: [],
                        timestamp: now.getTime() - 2
                    };

                    if (targetChatType === 'group') {
                        visualMessage.senderId = 'user_me';
                    }

                    chat.history.push(visualMessage);
                    addMessageBubble(visualMessage, targetChatId, targetChatType);
                }
            }
            chat.lastUserMessageTimestamp = now.getTime();
        }
        // ----------------------

        const myName = (targetChatType === 'private') ? chat.myName : chat.me.nickname;
        const content = `[${myName}发来的照片\/视频：${text}]`;
        const message = {
            id: `msg_${Date.now()}`,
            role: 'user',
            content: content,
            parts: [{type: 'text', text: content}],
            timestamp: Date.now()
        };
        if (targetChatType === 'group') {
            message.senderId = 'user_me';
        }
        chat.history.push(message);
        addMessageBubble(message, targetChatId, targetChatType);
        (targetChatType === 'private' ? saveCharacter(targetChatId) : saveGroup(targetChatId)).catch(() => showToast('消息保存失败，请检查存储空间'));
        renderChatList();
    }, 100);
}

function setupImageRecognition() {
    const imageRecognitionBtn = document.getElementById('image-recognition-btn');
    const imageUploadInput = document.getElementById('image-upload-input');

    let destination, selection = 0;
    imageRecognitionBtn.addEventListener('click', () => {
        destination = {id:currentChatId,type:currentChatType};
        document.getElementById('send-pv-modal').classList.remove('visible');
        imageUploadInput.click();
    });
    imageUploadInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const target = destination && { ...destination }, request = ++selection;
        let sent = 0;
        const opts = { quality: 0.8, maxWidth: 1024, maxHeight: 1024 };
        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                try {
                    const compressedUrl = await compressImage(file, opts);
                    if(target?.id!==currentChatId || target?.type!==currentChatType){showToast('聊天已切换，未发送剩余图片');break;}
                    if (await sendImageForRecognition(compressedUrl)) sent++;
                } catch (err) {
                    console.error('Image compression failed:', err);
                    showToast(`第 ${i + 1} 张图片处理失败，请重试`);
                }
            }
            if (files.length > 1) {
                showToast(sent ? `已发送 ${sent} / ${files.length} 张图片` : '这些图片尚未发送，请稍后重新选择');
            }
        } finally {
            if (request === selection) e.target.value = null;
        }
    });
}

function setupCameraCapture() {
    const cameraCaptureBtn = document.getElementById('camera-capture-btn');
    const cameraUploadInput = document.getElementById('camera-upload-input');
    if (!cameraCaptureBtn || !cameraUploadInput) return;

    let destination;
    cameraCaptureBtn.addEventListener('click', () => {
        destination={id:currentChatId,type:currentChatType};
        void openChatCamera(cameraUploadInput, destination);
    });
    cameraUploadInput.addEventListener('change', async (e) => {
        const target = destination && { ...destination };
        const file = e.target.files[0];
        if (file) {
            try {
                const compressedUrl = await compressImage(file, {
                    quality: 0.8,
                    maxWidth: 1024,
                    maxHeight: 1024
                });
                if(target?.id!==currentChatId || target?.type!==currentChatType){showToast('聊天已切换，请重新拍照');return;}
                await sendImageForRecognition(compressedUrl);
            } catch (error) {
                console.error('Image compression failed:', error);
                showToast('图片处理失败，请重试');
            } finally {
                e.target.value = null;
            }
        }
    });
}

async function openChatCamera(fallbackInput, destination) {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        showToast('浏览器无法直接预览摄像头，使用系统拍照或相册');fallbackInput.click();return;
    }
    const overlay=document.createElement('div');overlay.className='modal-overlay visible';overlay.id='chat-camera-preview';
    overlay.innerHTML='<div class="modal-window chat-camera-window" role="dialog" aria-modal="true" aria-label="拍照"><h3>拍照</h3><video autoplay playsinline muted></video><p role="status">正在打开摄像头…</p><div class="app-confirm-dialog-actions"><button type="button" class="btn btn-neutral" data-action="cancel">取消</button><button type="button" class="btn btn-secondary" data-action="album">选择照片</button><button type="button" class="btn btn-primary" data-action="capture" disabled>拍摄并发送</button></div></div>';
    document.body.append(overlay);const video=overlay.querySelector('video'),status=overlay.querySelector('p'),capture=overlay.querySelector('[data-action=capture]');let stream,closed=false;
    const close=()=>{closed=true;stream?.getTracks().forEach(track=>track.stop());video.srcObject=null;observer.disconnect();overlay.remove();document.removeEventListener('keydown',keydown,true);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',close);};
    const visibility=()=>{if(document.hidden)close();};
    const observer=new MutationObserver(()=>{if(!overlay.classList.contains('visible'))close();});observer.observe(overlay,{attributes:true,attributeFilter:['class']});
    const keydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}};
    overlay.onclick=event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(event.target===overlay||action==='cancel')close();if(action==='album'){close();document.getElementById('image-recognition-btn').click();}};
    document.addEventListener('keydown',keydown,true);document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',close,{once:true});
    capture.onclick=async()=>{
        if(!video.videoWidth)return;capture.disabled=true;
        try{const canvas=document.createElement('canvas'),scale=Math.min(1,1024/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',.8);close();if(destination.id!==currentChatId||destination.type!==currentChatType){showToast('聊天已切换，请重新拍照');return;}await sendImageForRecognition(data);}catch{showToast('拍照失败，可选择相册照片');capture.disabled=false;}
    };
    try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});if(closed){stream.getTracks().forEach(track=>track.stop());return;}video.srcObject=stream;await video.play();status.textContent='仅在点击发送后分享照片';capture.disabled=false;}catch(error){if(closed)return;status.textContent=error.name==='NotAllowedError'?'未获得摄像头权限，可在浏览器设置中授权，或选择相册照片。':'摄像头暂不可用，请选择相册照片。';}
}

async function sendImageForRecognition(base64Data) {
    if (!base64Data) return false;
    if (isGenerating) { showToast('请等待当前回复完成后再发送图片'); return false; }
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat) return false;
    if (!chat.history) chat.history = [];

    // --- 添加时间感知逻辑 ---
    if (db.apiSettings && db.apiSettings.timePerceptionEnabled) {
        const now = new Date();
        const lastMessageTime = chat.lastUserMessageTimestamp;
        if (lastMessageTime) {
            const timeGap = now.getTime() - lastMessageTime;
            const thirtyMinutes = 30 * 60 * 1000;

            if (timeGap > thirtyMinutes) {
                const displayContent = `[system-display:距离上次聊天已经过去 ${formatTimeGap(timeGap)}]`;
                const visualMessage = {
                    id: `msg_visual_timesense_${Date.now()}`,
                    role: 'system',
                    content: displayContent,
                    parts: [],
                    timestamp: now.getTime() - 2
                };

                if (currentChatType === 'group') {
                    visualMessage.senderId = 'user_me';
                }

                chat.history.push(visualMessage);
                addMessageBubble(visualMessage, currentChatId, currentChatType);
            }
        }
        chat.lastUserMessageTimestamp = now.getTime();
    }
    // ----------------------

    const myName = (currentChatType === 'private') ? chat.myName : chat.me.nickname;
    const textPrompt = `[${myName}发来了一张图片：]`;
    const message = {
        id: `msg_${Date.now()}_${crypto.randomUUID()}`,
        role: 'user',
        content: textPrompt,
        parts: [{type: 'text', text: textPrompt}, {type: 'image', data: base64Data}],
        timestamp: Date.now(),
    };
    if (currentChatType === 'group') {
        message.senderId = 'user_me';
    }
    chat.history.push(message);
    addMessageBubble(message, currentChatId, currentChatType);
    await saveCurrentChat();
    renderChatList();
    return true;
}

function setupWalletSystem() {
    const walletBtn = document.getElementById('wallet-btn');
    const sendTransferForm = document.getElementById('send-transfer-form');
    const sendTransferModal = document.getElementById('send-transfer-modal');
    const transferAmountInput = document.getElementById('transfer-amount-input');
    const transferRemarkInput = document.getElementById('transfer-remark-input');
    const acceptTransferBtn = document.getElementById('accept-transfer-btn');
    const returnTransferBtn = document.getElementById('return-transfer-btn');

    let paymentGeneration=0,paymentsReady=false;
    const sending=new Set(),sessionKey=(type,id)=>JSON.stringify([type,id]);
    const transferSubmit=sendTransferForm.querySelector('[type="submit"]');
    const currencyRoute=document.getElementById('transfer-open-currency'),useCny=document.getElementById('transfer-use-cny');
    currencyRoute.addEventListener('click',async()=>{
        const roleId=currentChatType==='private'?String(currentChatId):null;
        currencyRoute.disabled=true;
        try{await CurrencyTransfer.open({roleId});sendTransferModal.classList.remove('visible');}
        catch{showToast('多币种转账暂时无法打开，请重试。');}
        finally{currencyRoute.disabled=false;}
    });
    useCny.addEventListener('click',()=>{sendTransferForm.hidden=false;useCny.hidden=true;transferAmountInput.focus();});
    async function refreshTransferPaymentMethods(){
        const generation=++paymentGeneration,chatId=currentChatId,chatType=currentChatType;
        const methodList=document.getElementById('transfer-payment-methods'),note=document.getElementById('transfer-currency-note');
        paymentsReady=false;transferSubmit.disabled=true;currencyRoute.disabled=true;useCny.hidden=true;sendTransferForm.hidden=true;methodList.replaceChildren();note.textContent='正在读取钱包…';
        try{
            const read=await WalletSystem.read('user');if(!read.ok)throw Error('READ_FAILED');
            const role=chatType==='private'?db.characters.find(row=>String(row.id)===String(chatId)):null;
            const recipient=role?await WalletSystem.read(String(role.id)):null;
            if(generation!==paymentGeneration||currentChatId!==chatId||currentChatType!==chatType||!sendTransferModal.classList.contains('visible'))return;
            const userCurrency=CurrencyCore.currency(read.data.defaultCurrency||db.piggyBank?.currency||db.piggyBank?.currencyWallet?.defaultCurrency);
            const roleCurrency=CurrencyCore.currency(recipient?.data?.defaultCurrency||role?.walletLedger?.currency||role?.walletLedger?.currencyWallet?.defaultCurrency);
            const preferCurrency=userCurrency!=='CNY'||role&&roleCurrency!=='CNY';
            note.textContent='我的默认币种：'+CurrencyCore.meta(userCurrency).name+' '+userCurrency+(role?'；对方：'+(recipient?.ok?CurrencyCore.meta(roleCurrency).name+' '+roleCurrency:'暂时无法读取'):'')+'。多币种转账确认后直接到账；聊天待领取转账目前仅支持人民币 CNY。';
            currencyRoute.textContent=role?'多币种转账给 '+(role.remarkName||role.realName||'当前角色'):'多币种转账（选择收款角色）';
            currencyRoute.className='btn '+(preferCurrency?'btn-primary':'btn-neutral');currencyRoute.disabled=false;
            sendTransferForm.hidden=!!preferCurrency;useCny.hidden=!preferCurrency;
            function choice(value,name,amount,checked=false,disabled=false){const label=document.createElement('label');label.className='payment-method-item';const radio=document.createElement('input');radio.type='radio';radio.name='transfer-pay-method';radio.value=value;radio.checked=checked;radio.disabled=disabled;const title=document.createElement('span');title.className='pm-name';title.textContent=name;const balance=document.createElement('span');balance.className='pm-balance';balance.textContent=amount;label.append(radio,title,balance);methodList.append(label);}
            const account=read.data.accounts.find(row=>row.currency==='CNY'),available=Number.isSafeInteger(account?.balanceMinor)?account.balanceMinor-(account.reservedMinor||0):null;
            choice('balance','人民币余额',available==null?'待核对':CurrencyCore.formatMinor(available,'CNY'),true,available==null);
            if(read.data.mode==='legacy')for(const card of db.piggyBank?.receivedFamilyCards||[])if(card.status==='active')choice(card.id,(card.fromCharName||'角色')+'的亲属卡','剩余 '+CurrencyCore.formatMinor(Math.max(0,Math.round((card.limit-(card.usedAmount||0))*100)),'CNY'));
            const enabled=methodList.querySelector('input:not(:disabled)');if(enabled)enabled.checked=true;
            paymentsReady=!!enabled;transferSubmit.disabled=!paymentsReady||sending.has(sessionKey(chatType,chatId));
        }catch{if(generation===paymentGeneration){note.textContent='钱包暂时无法读取，请关闭后重试。';transferSubmit.disabled=true;}}
    }
    new MutationObserver(()=>{if(sendTransferModal.classList.contains('visible'))void refreshTransferPaymentMethods();else{paymentGeneration++;paymentsReady=false;}}).observe(sendTransferModal,{attributes:true,attributeFilter:['class']});
    walletBtn.addEventListener('click', () => {
        if (currentChatType === 'private') {
            sendTransferForm.reset();
            sendTransferModal.classList.add('visible');
        } else if (currentChatType === 'group') {
            // currentGroupAction 应该在 group_chat.js 或全局定义
            if (typeof currentGroupAction !== 'undefined') {
                currentGroupAction.type = 'transfer';
            }
            renderGroupRecipientSelectionList('转账给');
            document.getElementById('group-recipient-selection-modal').classList.add('visible');
        }
    });
    sendTransferForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const chatId=currentChatId,chatType=currentChatType,key=sessionKey(chatType,chatId);
        if(sending.has(key)||!paymentsReady||sendTransferForm.hidden)return;
        const chat=chatType==='private'?db.characters.find(row=>row.id===chatId):db.groups.find(row=>row.id===chatId);
        const recipients=chatType==='private'?[chatId]:[...(typeof currentGroupAction!=='undefined'?currentGroupAction?.recipients||[]:[])];
        if(!chat||!recipients.length){showToast('请选择有效的收款会话和角色');return;}
        const isCurrentChat=()=>currentChatId===chatId&&currentChatType===chatType;
        const transferToast=message=>{if(isCurrentChat())showToast(message);};
        sending.add(key);transferSubmit.disabled=true;
        try{
        const amountStr = (transferAmountInput.value || '').trim().replace(',', '.');
        const amountMinor=CurrencyCore.amountToMinor(amountStr,'CNY');
        const amount=amountMinor/100;
        const remark = transferRemarkInput.value.trim();
        if (amountMinor==null || amountMinor <= 0) {
            transferToast('请输入有效的金额');
            return;
        }
        let totalDeduct = amount;
        if (chatType === 'group' && recipients.length > 1) {
            totalDeduct = amount * recipients.length;
        }
        const payMethodRadio = document.querySelector('input[name="transfer-pay-method"]:checked');
        const payMethod = payMethodRadio ? payMethodRadio.value : 'balance';
        if(window.WalletLedger && await WalletSystem.mode()!=='legacy'){
            if(payMethod!=='balance'){transferToast('新亲属卡只授权订单支付，不能转账。');return;}
            const result=await WalletSystem.chat('user').send({chatId:String(chatId),chatType,recipientOwnerIds:recipients.map(String),amountMinor,remark,idempotencyKey:crypto.randomUUID()});
            if(!result.ok){transferToast(result.reason||result.error.code);return;}
            WalletChat.sync(chat,result);
            if(isCurrentChat()){
                sendTransferModal.classList.remove('visible');
                for(const message of result.data.messages)addMessageBubble(message,chatId,chatType);
            }
            await WalletSystem.refresh();if(isCurrentChat())renderChatList();return;
        }
        if (payMethod !== 'balance' && db.piggyBank && db.piggyBank.receivedFamilyCards) {
            const card = db.piggyBank.receivedFamilyCards.find(c => c.id === payMethod);
            if (card && card.status === 'active') {
                const remaining = card.limit - (card.usedAmount || 0);
                if (remaining < totalDeduct) {
                    transferToast('亲属卡额度不足');
                    return;
                }
            } else {
                transferToast('请选择有效的支付方式');
                return;
            }
        }
        if (payMethod === 'balance') {
            if (typeof getPiggyBalance === 'function' && getPiggyBalance() < totalDeduct) {
                transferToast('存钱罐余额不足，无法转账');
                return;
            }
            if (typeof addPiggyTransaction === 'function') {
                let toName = '';
                if (chatType === 'private') {
                    toName = chat && chat.realName;
                } else {
                    // 群聊中，获取所有接收转账的角色名称
                    if (recipients.length > 0) {
                        const recipientNames = recipients.map(recipientId => {
                            const recipient = chat.members.find(m => m.id === recipientId);
                            return recipient ? (recipient.realName || recipient.groupNickname || '') : '';
                        }).filter(name => name).join('、');
                        toName = recipientNames || '';
                    } else {
                        toName = chat && chat.me && chat.me.nickname;
                    }
                }
                const charged=await addPiggyTransaction({ type: 'expense', amount: totalDeduct, remark: remark || '转账', source: '转账', charName: toName || '' });
                if(charged?.ok===false){transferToast(charged.reason);return;}
            }
        } else if (db.piggyBank && db.piggyBank.receivedFamilyCards) {
            const card = db.piggyBank.receivedFamilyCards.find(c => c.id === payMethod);
            if (card) {
                const toName = chatType === 'private' ? chat.realName : (chat.members || []).filter(m=>recipients.includes(m.id)).map(m=>m.realName).filter(Boolean).join('、');
                if (window.WalletSystem && typeof window.WalletSystem.chargeReceivedFamilyCard === 'function') {
                    const chargeResult = await window.WalletSystem.chargeReceivedFamilyCard(card.id, {
                        amount: totalDeduct,
                        scene: '转账',
                        detail: `给“${toName}”转账，备注：“${remark || '无'}”`,
                        targetName: toName || ''
                    });
                    if (!chargeResult.ok) {
                        transferToast(chargeResult.reason || '亲属卡支付失败');
                        return;
                    }
                }
            }
        }
        if (window.WalletSystem && typeof window.WalletSystem.persist === 'function' && await window.WalletSystem.persist()===false) {
            transferToast('钱包保存失败，请核对后重试。');return;
        }
        await sendMyTransfer(amountStr, remark, {chatId,chatType,chat,recipients});
        }catch{transferToast('转账未完成，请核对钱包和聊天记录后重试。');}
        finally{sending.delete(key);if(isCurrentChat())transferSubmit.disabled=!paymentsReady;}
    });
    acceptTransferBtn.addEventListener('click', () => respondToTransfer('received'));
    returnTransferBtn.addEventListener('click', () => respondToTransfer('returned'));
}

async function sendMyTransfer(amount, remark, {chatId,chatType,chat,recipients}) {
        const messages=[];
        if (!chat.history) chat.history = [];

        // --- 添加时间感知逻辑 ---
        if (db.apiSettings && db.apiSettings.timePerceptionEnabled) {
            const now = new Date();
            const lastMessageTime = chat.lastUserMessageTimestamp;
            if (lastMessageTime) {
                const timeGap = now.getTime() - lastMessageTime;
                const thirtyMinutes = 30 * 60 * 1000;

                if (timeGap > thirtyMinutes) {
                    const displayContent = `[system-display:距离上次聊天已经过去 ${formatTimeGap(timeGap)}]`;
                    const visualMessage = {
                        id: `msg_visual_timesense_${Date.now()}`,
                        role: 'system',
                        content: displayContent,
                        parts: [],
                        timestamp: now.getTime() - 2
                    };

                    if (chatType === 'group') {
                        visualMessage.senderId = 'user_me';
                    }

                    chat.history.push(visualMessage);
                    messages.push(visualMessage);
                }
            }
            chat.lastUserMessageTimestamp = now.getTime();
        }
        // ----------------------

        if (chatType === 'private') {
            const content = `[${chat.myName}给你转账：${amount}元；备注：${remark}]`;
            const message = {
                id: `msg_${Date.now()}`,
                role: 'user',
                content: content,
                parts: [{type: 'text', text: content}],
                timestamp: Date.now(),
                transferStatus: 'pending'
            };
            chat.history.push(message);
            messages.push(message);
        } else { 
                recipients.forEach(recipientId => {
                    const recipient = chat.members.find(m => m.id === recipientId);
                    if (recipient) {
                        const content = `[${chat.me.nickname} 向 ${recipient.realName} 转账：${amount}元；备注：${remark}]`;
                        const message = {
                            id: `msg_${Date.now()}_${recipientId}`,
                            role: 'user',
                            content: content,
                            parts: [{type: 'text', text: content}],
                            timestamp: Date.now(),
                            senderId: 'user_me',
                            transferStatus: 'pending'
                        };
                        chat.history.push(message);
                        messages.push(message);
                    }
                });
        }
        const saved=chatType==='private'?await saveCharacter(chatId):await saveGroup(chatId);
        if(saved===false)throw Error('CHAT_SAVE_FAILED');
        if(currentChatId===chatId&&currentChatType===chatType){
            document.getElementById('send-transfer-modal').classList.remove('visible');
            for(const message of messages)addMessageBubble(message,chatId,chatType);
            renderChatList();
        }
}

function handleReceivedTransferClick(messageId) {
    currentTransferMessageId = messageId;
    document.getElementById('receive-transfer-actionsheet').classList.add('visible');
}

function parseTransferAmountFromContent(content) {
    if (!content || typeof content !== 'string') return 0;
    const m = content.match(/转账[：:]\s*([\d.,]+)\s*元/);
    return m ? parseFloat(m[1].replace(/,/g, '.')) || 0 : 0;
}

async function respondToTransfer(action) {
    if (!currentTransferMessageId) return;
    if(window.WalletLedger && await WalletSystem.mode()!=='legacy'){
        const chat=currentChatType==='private'?db.characters.find(row=>row.id===currentChatId):db.groups.find(row=>row.id===currentChatId);
        const result=await WalletSystem.chat('user').settle({chatId:String(currentChatId),chatType:currentChatType,messageId:currentTransferMessageId,action});
        if(!result.ok){showToast(result.reason||result.error.code);return;}
        WalletChat.sync(chat,result);await WalletSystem.refresh();
        document.getElementById('receive-transfer-actionsheet').classList.remove('visible');renderMessages(false,false);renderChatList();return;
    }

    
    if (currentChatType === 'private') {
        const character = db.characters.find(c => c.id === currentChatId);
        const message = character.history.find(m => m.id === currentTransferMessageId);
        if (message) {
            message.transferStatus = action;
            const cardOnScreen = messageArea.querySelector(`.message-wrapper[data-id="${currentTransferMessageId}"] .transfer-card`);
            if (cardOnScreen) {
                cardOnScreen.classList.remove('received', 'returned');
                cardOnScreen.classList.add(action);
                cardOnScreen.querySelector('.transfer-status').textContent = action === 'received' ? '已收款' : '已退回';
                cardOnScreen.style.cursor = 'default';
            }
            if (typeof addPiggyTransaction === 'function' && action === 'received') {
                const amount = parseTransferAmountFromContent(message.content);
                if (amount > 0) {
                    const credited=await addPiggyTransaction({
                        eventId:`receive_${message.id}`,
                        type: 'income',
                        amount,
                        remark: '收款',
                        source: '聊天',
                        charName: character.realName || ''
                    });
                    if(credited?.ok===false){message.transferStatus='pending';showToast(credited.reason);return;}
                }
            }
            let contextMessageContent = (action === 'received') ? `[${character.myName}接收${character.realName}的转账]` : `[${character.myName}退回${character.realName}的转账]`;
            const contextMessage = {
                id: `msg_${Date.now()}`,
                role: 'user',
                content: contextMessageContent,
                parts: [{type: 'text', text: contextMessageContent}],
                timestamp: Date.now()
            };
            character.history.push(contextMessage);
            await saveCurrentChat();
            renderChatList();
        }
    } else if (currentChatType === 'group') {
        const group = db.groups.find(g => g.id === currentChatId);
        const message = group.history.find(m => m.id === currentTransferMessageId);
        if (message) {
            message.transferStatus = action;
            const cardOnScreen = messageArea.querySelector(`.message-wrapper[data-id="${currentTransferMessageId}"] .transfer-card`);
            if (cardOnScreen) {
                cardOnScreen.classList.remove('received', 'returned');
                cardOnScreen.classList.add(action);
                cardOnScreen.querySelector('.transfer-status').textContent = action === 'received' ? '已收款' : '已退回';
                cardOnScreen.style.cursor = 'default';
            }
            
            // 解析转账信息（只处理用户接收角色转账的情况）
            const groupTransferRegex = /\[(.*?)\s*向\s*(.*?)\s*转账[：:]([\d.,]+)元[；;]备注[：:](.*?)\]/;
            const transferMatch = message.content.match(groupTransferRegex);
            if (transferMatch) {
                const from = transferMatch[1];
                const to = transferMatch[2];
                const amount = parseTransferAmountFromContent(message.content);
                const myName = group.me.nickname;
                
                // 只处理角色向用户转账的情况（用户接收角色转账）
                if (message.role === 'assistant' && to === myName) {
                    if (typeof addPiggyTransaction === 'function' && action === 'received' && amount > 0) {
                        // 用户接收角色转账
                        const sender = group.members.find(m => (m.realName === from || m.groupNickname === from));
                        const credited=await addPiggyTransaction({
                            eventId:`receive_${message.id}`,
                            type: 'income',
                            amount,
                            remark: '收款',
                            source: '聊天',
                            charName: sender ? (sender.realName || '') : ''
                        });
                        if(credited?.ok===false){message.transferStatus='pending';showToast(credited.reason);return;}
                    }
                    
                    // 创建上下文消息
                    const contextMessageContent = (action === 'received') 
                        ? `[${myName}接收${from}的转账]` 
                        : `[${myName}退回${from}的转账]`;
                    const contextMessage = {
                        id: `msg_${Date.now()}`,
                        role: 'user',
                        content: contextMessageContent,
                        parts: [{type: 'text', text: contextMessageContent}],
                        timestamp: Date.now(),
                        senderId: 'user_me'
                    };
                    group.history.push(contextMessage);
                }
            }
            
            await saveCurrentChat();
            renderChatList();
        }
    }
    
    document.getElementById('receive-transfer-actionsheet').classList.remove('visible');
    currentTransferMessageId = null;
}

/**
 * 用户接收/退还角色发的亲属卡（私聊）
 * @param {string} msgId - 角色发送亲属卡的那条消息的 id
 * @param {'accept'|'return'} action
 */
window.sendFamilyCardResponse = async function(msgId, action) {
    if (currentChatType !== 'private') return;
    const character = db.characters.find(c => c.id === currentChatId);
    if (!character) return;
    const message = character.history.find(m => m.id === msgId);
    if (!message || !message.receivedFamilyCardId || message.receivedFamilyCardStatus !== 'pending') return;
    const receivedCardsSnapshot = db.piggyBank && Array.isArray(db.piggyBank.receivedFamilyCards)
        ? JSON.parse(JSON.stringify(db.piggyBank.receivedFamilyCards)) : [];
    const historyLengthBefore = character.history.length;

    const statusToSet = action === 'accept' ? 'accepted' : 'returned';
    message.receivedFamilyCardStatus = statusToSet;

    if (window.WalletSystem && typeof window.WalletSystem.respondToReceivedFamilyCard === 'function') {
        const result=await window.WalletSystem.respondToReceivedFamilyCard(character,message,action);
        if(result?.ok===false){message.receivedFamilyCardStatus='pending';showToast(result.reason||result.error.code);return;}
    } else if (action === 'return' && db.piggyBank && db.piggyBank.receivedFamilyCards) {
        const card = db.piggyBank.receivedFamilyCards.find(c => c.id === message.receivedFamilyCardId);
        if (card) card.status = 'returned';
    }

    const fcCardOnScreen = messageArea.querySelector(`.message-wrapper[data-id="${msgId}"] .family-card-receipt`);
    if (fcCardOnScreen) {
        fcCardOnScreen.classList.remove('accepted', 'returned');
        fcCardOnScreen.classList.add(statusToSet);
        const statusElem = fcCardOnScreen.querySelector('.family-card-status-text');
        if (statusElem) statusElem.textContent = statusToSet === 'accepted' ? '已接收' : '已退还';
        const actions = fcCardOnScreen.querySelector('.receipt-actions');
        if (actions) actions.remove();
    }

    const verb = action === 'accept' ? '接收' : '退还';
    const contextMessageContent = `[${character.myName}${verb}${character.realName}的亲属卡]`;
    const contextMessage = {
        id: 'msg_' + Date.now(),
        role: 'user',
        content: contextMessageContent,
        parts: [{ type: 'text', text: contextMessageContent }],
        timestamp: Date.now()
    };
    character.history.push(contextMessage);
    if (typeof addMessageBubble === 'function') addMessageBubble(contextMessage, currentChatId, currentChatType);
    let persisted = true;
    if (window.WalletSystem && typeof window.WalletSystem.persist === 'function') persisted = await window.WalletSystem.persist([character.id]);
    else if (typeof saveCurrentChat === 'function') await saveCurrentChat();
    if (!persisted) {
        db.piggyBank.receivedFamilyCards = receivedCardsSnapshot;
        message.receivedFamilyCardStatus = 'pending';
        character.history.splice(historyLengthBefore);
        if (typeof renderMessages === 'function') renderMessages(false, false);
        if (typeof showToast === 'function') showToast('亲属卡状态保存失败，请重试');
        return;
    }
    if (typeof renderChatList === 'function') renderChatList();
};

function setupGiftSystem() {
    const giftBtn = document.getElementById('gift-btn');
    const sendGiftForm = document.getElementById('send-gift-form');
    const sendGiftModal = document.getElementById('send-gift-modal');
    const giftDescriptionInput = document.getElementById('gift-description-input');

    giftBtn.addEventListener('click', () => {
        if (currentChatType === 'private') {
            sendGiftForm.reset();
            sendGiftModal.classList.add('visible');
        } else if (currentChatType === 'group') {
            if (typeof currentGroupAction !== 'undefined') {
                currentGroupAction.type = 'gift';
            }
            renderGroupRecipientSelectionList('送礼物给');
            document.getElementById('group-recipient-selection-modal').classList.add('visible');
        }
    });
    sendGiftForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendMyGift(giftDescriptionInput.value.trim());
    });
}

function sendMyGift(description) {
    if (!description) return;
    document.getElementById('send-gift-modal').classList.remove('visible');
    setTimeout(() => {
        const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
        if (!chat.history) chat.history = [];

        // --- 添加时间感知逻辑 ---
        if (db.apiSettings && db.apiSettings.timePerceptionEnabled) {
            const now = new Date();
            const lastMessageTime = chat.lastUserMessageTimestamp;
            if (lastMessageTime) {
                const timeGap = now.getTime() - lastMessageTime;
                const thirtyMinutes = 30 * 60 * 1000;

                if (timeGap > thirtyMinutes) {
                    const displayContent = `[system-display:距离上次聊天已经过去 ${formatTimeGap(timeGap)}]`;
                    const visualMessage = {
                        id: `msg_visual_timesense_${Date.now()}`,
                        role: 'system',
                        content: displayContent,
                        parts: [],
                        timestamp: now.getTime() - 2
                    };

                    if (currentChatType === 'group') {
                        visualMessage.senderId = 'user_me';
                    }

                    chat.history.push(visualMessage);
                    addMessageBubble(visualMessage, currentChatId, currentChatType);
                }
            }
            chat.lastUserMessageTimestamp = now.getTime();
        }
        // ----------------------

        if (currentChatType === 'private') {
            const content = `[${chat.myName}送来的礼物：${description}]`;
            const message = {
                id: `msg_${Date.now()}`,
                role: 'user',
                content: content,
                parts: [{type: 'text', text: content}],
                timestamp: Date.now(),
                giftStatus: 'sent'
            };
            chat.history.push(message);
            addMessageBubble(message, currentChatId, currentChatType);
        } else { 
            if (typeof currentGroupAction !== 'undefined' && currentGroupAction.recipients) {
                currentGroupAction.recipients.forEach(recipientId => {
                    const recipient = chat.members.find(m => m.id === recipientId);
                    if (recipient) {
                        const content = `[${chat.me.nickname} 向 ${recipient.realName} 送来了礼物：${description}]`;
                        const message = {
                            id: `msg_${Date.now()}_${recipientId}`,
                            role: 'user',
                            content: content,
                            parts: [{type: 'text', text: content}],
                            timestamp: Date.now(),
                            senderId: 'user_me'
                        };
                        chat.history.push(message);
                        addMessageBubble(message, currentChatId, currentChatType);
                    }
                });
            }
        }
        saveCurrentChat();
        renderChatList();
    }, 100);
}

function setupLocationSystem() {
    const locationBtn = document.getElementById('location-btn');
    const sendLocationModal = document.getElementById('send-location-modal');
    const sendLocationForm = document.getElementById('send-location-form');
    const locationPlaceInput = document.getElementById('location-place-input');
    const locationDistanceInput = document.getElementById('location-distance-input');
    const locationUnitSelect = document.getElementById('location-unit-select');

    if (!locationBtn || !sendLocationForm) return;

    locationBtn.addEventListener('click', () => {
        sendLocationForm.reset();
        sendLocationModal.classList.add('visible');
    });
    document.getElementById('location-device-btn')?.addEventListener('click', async event => {
        const button=event.currentTarget, status=document.getElementById('location-device-status');button.disabled=true;
        status.textContent='正在获取所在城市…';
        try {
            const fix=await RealtimeContextHub.captureUserLocation();
            const region=await RealtimeContextHub.reverseGeocodeLocation(fix);
            if(!sendLocationModal.classList.contains('visible'))return;
            if(region?.label){locationPlaceInput.value=region.label;status.textContent='已填入城市名称，确认发送后才会分享。';}
            else status.textContent='已获得定位，但城市查询不可用，请手动填写地点。';
        } catch(error){status.textContent=error.message || '定位暂不可用，请手动填写地点。';}
        finally{button.disabled=false;}
    });
    sendLocationModal.addEventListener('click', (e) => {
        if (e.target === sendLocationModal) sendLocationModal.classList.remove('visible');
    });
    sendLocationForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const place = (locationPlaceInput.value || '').trim();
        if (!place) {
            if (typeof showToast === 'function') showToast('请输入当前位置');
            return;
        }
        const distanceNum = (locationDistanceInput.value || '').trim();
        const unit = (locationUnitSelect && locationUnitSelect.value) || '千米';
        let content = `[我的位置：${place}`;
        if (distanceNum && !isNaN(parseFloat(distanceNum))) {
            content += `；距你约 ${distanceNum}${unit}`;
        }
        content += ']';
        sendMyLocation(content);
    });
}

function sendMyLocation(content) {
    document.getElementById('send-location-modal').classList.remove('visible');
    const targetChatId=currentChatId, targetChatType=currentChatType;
    setTimeout(() => {
        const chat = (targetChatType === 'private') ? db.characters.find(c => c.id === targetChatId) : db.groups.find(g => g.id === targetChatId);
        if (!chat) return;
        if (!chat.history) chat.history = [];

        // --- 添加时间感知逻辑 ---
        if (db.apiSettings && db.apiSettings.timePerceptionEnabled) {
            const now = new Date();
            const lastMessageTime = chat.lastUserMessageTimestamp;
            if (lastMessageTime) {
                const timeGap = now.getTime() - lastMessageTime;
                const thirtyMinutes = 30 * 60 * 1000;

                if (timeGap > thirtyMinutes) {
                    const displayContent = `[system-display:距离上次聊天已经过去 ${formatTimeGap(timeGap)}]`;
                    const visualMessage = {
                        id: `msg_visual_timesense_${Date.now()}`,
                        role: 'system',
                        content: displayContent,
                        parts: [],
                        timestamp: now.getTime() - 2
                    };

                    if (targetChatType === 'group') {
                        visualMessage.senderId = 'user_me';
                    }

                    chat.history.push(visualMessage);
                    addMessageBubble(visualMessage, targetChatId, targetChatType);
                }
            }
            chat.lastUserMessageTimestamp = now.getTime();
        }
        // ----------------------

        const message = {
            id: `msg_${Date.now()}`,
            role: 'user',
            content: content,
            parts: [{ type: 'text', text: content }],
            timestamp: Date.now()
        };
        if (targetChatType === 'group') {
            message.senderId = 'user_me';
        }
        chat.history.push(message);
        addMessageBubble(message, targetChatId, targetChatType);
        (targetChatType === 'private' ? saveCharacter(targetChatId) : saveGroup(targetChatId)).catch(() => showToast('消息保存失败，请检查存储空间'));
        renderChatList();
    }, 100);
}

function setupTimeSkipSystem() {
    const timeSkipBtn = document.getElementById('time-skip-btn');
    const timeSkipModal = document.getElementById('time-skip-modal');
    const timeSkipForm = document.getElementById('time-skip-form');
    const timeSkipInput = document.getElementById('time-skip-input');

    timeSkipBtn.addEventListener('click', () => {
        timeSkipForm.reset();
        timeSkipModal.classList.add('visible');
    });
    timeSkipModal.addEventListener('click', (e) => {
        if (e.target === timeSkipModal) timeSkipModal.classList.remove('visible');
    });
    timeSkipForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendTimeSkipMessage(timeSkipInput.value.trim());
    });
}

async function sendTimeSkipMessage(text) {
    if (!text) return;
    document.getElementById('time-skip-modal').classList.remove('visible');
    await new Promise(resolve => setTimeout(resolve, 100));
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat) return;

    const visualMessage = {
        id: `msg_visual_${Date.now()}`,
        role: 'system',
        content: `[system-display:${text}]`,
        parts: [],
        timestamp: Date.now()
    };
    const contextMessage = {
        id: `msg_context_${Date.now()}`,
        role: 'user',
        content: `[system: ${text}]`,
        parts: [{type: 'text', text: `[system: ${text}]`}],
        timestamp: Date.now()
    };
    if (currentChatType === 'group') {
        contextMessage.senderId = 'user_me';
        visualMessage.senderId = 'user_me';
    }

    chat.history.push(visualMessage, contextMessage);
    addMessageBubble(visualMessage, currentChatId, currentChatType);
    await saveCurrentChat();
    renderChatList();
}

const AudioManager = {
    _audio: null,
    
    get audio() {
        if (!this._audio) {
            this._audio = new Audio();
            this._audio.addEventListener('ended', () => {
                if (typeof window.resumeMusicPlayback === 'function') {
                    window.resumeMusicPlayback();
                }
            });
            this._audio.addEventListener('error', (e) => {
                console.warn('Audio Object Error:', e);
            });
        }
        return this._audio;
    },

    play(source) {
        if (!source) return;
        const a = this.audio;
        
        // 如果当前正在播放且源相同，可以重置进度（打断重播）
        // 如果源不同，直接切换
        try {
            a.src = source;
            a.volume = 1.0; 
            a.currentTime = 0;
            
            const p = a.play();
            if (p && typeof p.catch === 'function') {
                p.catch(e => {
                    // 忽略 AbortError (被新的播放打断是正常的)
                    if (e.name !== 'AbortError') {
                        console.warn('播放提示音失败:', e);
                    }
                });
            }
        } catch (e) {
            console.warn('音频播放异常:', e);
        }
    },

    // 预热/解锁音频对象（用于在没有发送音效时获取播放权限）
    unlock() {
        if (db.globalReceiveSound) {
            const a = this.audio;
            // 记录当前状态
            const originalSrc = a.src;
            
            // 切换到接收音效进行预热
            if (!a.src || a.src !== db.globalReceiveSound) {
                 a.src = db.globalReceiveSound;
            }
            
            a.volume = 0; // 静音
            const p = a.play();
            if (p) {
                p.then(() => {
                    a.pause();
                    a.currentTime = 0;
                    a.volume = 1; 
                }).catch(e => {
                    // 预热失败也不影响流程
                    a.volume = 1;
                });
            }
        }
    }
};

function playSound(source) {
    AudioManager.play(source);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupCameraCapture);
    } else {
        setupCameraCapture();
    }
}
