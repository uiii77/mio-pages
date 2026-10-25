// --- 核心聊天逻辑 (js/chat.js) ---
// 此文件保留核心入口和胶水代码，具体功能已拆分至 js/modules/chat_*.js

async function saveCurrentChat() {
    if (currentChatType === 'group') {
        await saveGroup(currentChatId);
    } else {
        await saveCharacter(currentChatId);
    }
}

// Keep the chat expansion panel grouped without changing the existing button IDs.
// The swiper is built later by setupFunctionPanelSwiper(), so ordering the source
// nodes here keeps every existing listener and data contract intact.
function arrangeChatExpansionItems() {
    const grid = document.querySelector('#panel-function-area .expansion-grid');
    if (!grid) return;
    const order = [
        'voice-message-btn', 'photo-video-btn', 'camera-capture-btn', 'video-call-btn',
        'location-btn', 'wallet-btn', 'gift-btn', 'abort-reply-btn',
        'schedule-open-btn', 'chat-calendar-btn', 'memory-palace-btn', 'regenerate-btn',
        'capture-btn', 'memory-journal-btn', 'char-gallery-manage-btn', 'memory-table-btn',
        'chat-trpg-btn', 'reading-btn', 'listen-together-btn', 'watch-together-btn',
        'collaboration-btn', 'exchange-diary-btn', 'reminder-btn', 'node-system-btn',
        'delete-history-btn',
        'time-skip-btn', 'vector-memory-btn', 'shop-btn', 'msg-version-btn', 'group-poke-expansion-btn',
    ];
    order.forEach(id => {
        const item = document.getElementById(id);
        if (item && item.parentElement === grid) grid.appendChild(item);
    });
    Array.from(grid.children).filter(item => !order.includes(item.id)).forEach(item => grid.appendChild(item));
}

function setupChatRoom() {
    document.getElementById('chat-calendar-btn')?.addEventListener('click', () => { showPanel('none'); switchScreen('health-screen'); });
    document.getElementById('chat-records-search-btn')?.addEventListener('click', () => { switchScreen('chat-room-screen'); SearchSystem.open({chatType:currentChatType,chatId:currentChatId}); });
    for(const id of ['chat-calendar-btn'])document.getElementById(id)?.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}});
    document.getElementById('chat-trpg-btn')?.addEventListener('click', () => {
        showPanel('none'); window.TrpgPlayUI?.open();
    });
    const memoryJournalBtn = document.getElementById('memory-journal-btn');
    const memoryTableBtn = document.getElementById('memory-table-btn');
    const vectorMemoryBtn = document.getElementById('vector-memory-btn');
    const memoryPalaceBtn = document.getElementById('memory-palace-btn');
    const collaborationBtn = document.getElementById('collaboration-btn');
    const listenTogetherBtn = document.getElementById('listen-together-btn');
    const exchangeDiaryBtn = document.getElementById('exchange-diary-btn');
    const deleteHistoryBtn = document.getElementById('delete-history-btn');
    const captureBtn = document.getElementById('capture-btn');
    const toggleExpansionBtn = document.getElementById('toggle-expansion-btn');
    const charStatusBtn = document.getElementById('char-status-btn');
    const statusOverlay = document.getElementById('char-status-overlay');
    const closeStatusBtn = document.getElementById('close-status-panel-btn');
    const statusContent = document.getElementById('char-status-content');

    arrangeChatExpansionItems();

    if (charStatusBtn) {
        charStatusBtn.addEventListener('click', () => {
            const char = db.characters.find(c => c.id === currentChatId);
            if (!char || !char.statusPanel) return;

            statusContent.innerHTML = ''; // Clear previous content

            // Prepare data: combine history and current if needed
            let slidesData = [];
            if (char.statusPanel.history && char.statusPanel.history.length > 0) {
                // history is [newest, older, oldest...]
                // We want to display newest last (on the right), so history is on the left
                slidesData = [...char.statusPanel.history].reverse();
            } else if (char.statusPanel.currentStatusHtml) {
                slidesData = [{ html: char.statusPanel.currentStatusHtml, timestamp: Date.now() }];
            }

            if (slidesData.length === 0) {
                statusContent.innerHTML = '<p style="text-align:center; color:#999;">暂无状态信息</p>';
                statusOverlay.classList.add('visible');
                if (window.applyStatusManageBtnPosition) window.applyStatusManageBtnPosition();
                return;
            }

            // Build Swiper Structure
            const swiper = document.createElement('div');
            swiper.className = 'status-swiper';
            const loadedSlides = new Set();

            // Helper function for Lazy Loading
            const loadSlideContent = (index) => {
                if (index < 0 || index >= slidesData.length) return;
                const slide = swiper.children[index];
                if (!slide) return;
                const slideInner = slide.querySelector('.status-slide-inner');
                if (slideInner.hasChildNodes()) return; // Already loaded

                const item = slidesData[index];
                const htmlContent = item.html;
                if (htmlContent.includes('<!DOCTYPE html>') || htmlContent.includes('<html') || htmlContent.includes('<style')) {
                    const iframe = document.createElement('iframe');
                    iframe.style.cssText = "width: 100%; height: 100%; min-height: 80vh; border: none; background: transparent; display: block;";
                    iframe.srcdoc = processTemplate(htmlContent, char);
                    slideInner.appendChild(iframe);
                } else {
                    slideInner.innerHTML = processTemplate(htmlContent, char);
                }
                loadedSlides.add(index);
            };

            const unloadDistantSlides = (currentIndex) => {
                if (slidesData.length <= 100) return;
                for (const index of loadedSlides) {
                    if (Math.abs(index - currentIndex) <= 2) continue;
                    swiper.children[index].querySelector('.status-slide-inner').replaceChildren();
                    loadedSlides.delete(index);
                }
            };

            // Create empty slides first
            const slidesFragment = document.createDocumentFragment();
            slidesData.forEach((item, index) => {
                const slide = document.createElement('div');
                slide.className = 'status-slide';
                
                const slideInner = document.createElement('div');
                slideInner.className = 'status-slide-inner';
                // Content will be loaded lazily
                
                slide.appendChild(slideInner);
                slidesFragment.appendChild(slide);
            });
            swiper.appendChild(slidesFragment);

            // Indicator
            const indicator = document.createElement('div');
            indicator.className = 'status-indicator';
            indicator.textContent = `${slidesData.length} / ${slidesData.length}`;

            statusContent.appendChild(swiper);
            statusContent.appendChild(indicator);

            // Initial Load: Load the last slide (newest) and previous ones
            const lastIndex = slidesData.length - 1;
            loadSlideContent(lastIndex);
            if (lastIndex > 0) loadSlideContent(lastIndex - 1);
            if (lastIndex > 1) loadSlideContent(lastIndex - 2);

            // Scroll to the end (newest) initially
            setTimeout(() => {
                swiper.style.scrollBehavior = 'auto';
                swiper.scrollLeft = swiper.scrollWidth;
                setTimeout(() => {
                    swiper.style.scrollBehavior = 'smooth';
                }, 50);
            }, 0);

            // Scroll Listener for Indicator & Lazy Loading
            swiper.addEventListener('scroll', () => {
                const width = swiper.offsetWidth;
                if (width > 0) {
                    const currentIndex = Math.round(swiper.scrollLeft / width);
                    indicator.textContent = `${currentIndex + 1} / ${slidesData.length}`;
                    
                    // Lazy load adjacent slides (current +/- 2)
                    for (let i = currentIndex - 2; i <= currentIndex + 2; i++) {
                        loadSlideContent(i);
                    }
                    unloadDistantSlides(currentIndex);
                }
            });

            statusOverlay.classList.add('visible');
            if (window.applyStatusManageBtnPosition) window.applyStatusManageBtnPosition();
        });
    }

    if (closeStatusBtn) {
        closeStatusBtn.addEventListener('click', () => {
            if (statusOverlay.classList.contains('multi-select-mode')) {
                exitStatusMultiSelect();
                return;
            }
            statusOverlay.classList.remove('visible');
        });
    }
    
    if (statusOverlay) {
        statusOverlay.addEventListener('click', (e) => {
            if (e.target === statusOverlay) {
                if (statusOverlay.classList.contains('multi-select-mode')) {
                    exitStatusMultiSelect();
                    return;
                }
                statusOverlay.classList.remove('visible');
            }
        });
    }

    // 状态栏管理按钮 - 可拖动定位，点击进入多选模式
    const statusManageBtn = document.getElementById('status-manage-btn');
    if (statusManageBtn && statusOverlay) {
        initStatusManageBtnDrag(statusManageBtn, statusOverlay);
    }

    // 重置状态栏管理按钮位置
    const resetStatusBtnPos = document.getElementById('reset-status-manage-btn-pos');
    if (resetStatusBtnPos) {
        resetStatusBtnPos.addEventListener('click', () => {
            localStorage.removeItem('statusManageBtnPosition');
            const btn = document.getElementById('status-manage-btn');
            if (btn) {
                btn.style.left = '';
                btn.style.top = '';
                btn.style.right = '';
            }
            if (typeof showToast === 'function') {
                showToast('删除按钮位置已重置');
            } else {
                alert('删除按钮位置已重置');
            }
        });
    }

    // 状态栏多选 - 全选
    const statusSelectAllBtn = document.getElementById('status-select-all-btn');
    if (statusSelectAllBtn) {
        statusSelectAllBtn.addEventListener('click', () => {
            const checkboxes = statusContent.querySelectorAll('.status-slide-checkbox');
            const allChecked = Array.from(checkboxes).every(cb => cb.classList.contains('checked'));
            checkboxes.forEach(cb => {
                if (allChecked) cb.classList.remove('checked');
                else cb.classList.add('checked');
            });
            statusSelectAllBtn.textContent = allChecked ? '全选' : '取消全选';
            updateStatusSelectCount();
        });
    }

    // 状态栏多选 - 删除选中
    const statusDeleteSelectedBtn = document.getElementById('status-delete-selected-btn');
    if (statusDeleteSelectedBtn) {
        statusDeleteSelectedBtn.addEventListener('click', () => {
            deleteSelectedStatusSlides();
        });
    }

    // 状态栏多选 - 取消
    const statusCancelMultiBtn = document.getElementById('status-cancel-multi-btn');
    if (statusCancelMultiBtn) {
        statusCancelMultiBtn.addEventListener('click', () => {
            exitStatusMultiSelect();
        });
    }

    // 状态栏交互事件委托
    if (statusContent) {
        statusContent.addEventListener('click', (e) => {
            const target = e.target.closest('[data-send-msg]');
            if (target) {
                const msg = target.dataset.sendMsg;
                if (msg) {
                    const input = document.getElementById('message-input');
                    if (input) {
                        input.value = msg;
                        document.getElementById('send-message-btn').click();
                        // 关闭状态栏面板
                        statusOverlay.classList.remove('visible');
                    }
                }
            }
        });
    }

    if (toggleExpansionBtn) {
        toggleExpansionBtn.addEventListener('click', () => {
            if (chatExpansionPanel.classList.contains('visible') && panelFunctionArea.style.display !== 'none') {
                showPanel('none');
            } else {
                showPanel('function');
            }
        });
    }

    if (memoryJournalBtn) {
        memoryJournalBtn.addEventListener('click', () => {
            renderJournalList();
            const backBtn = document.querySelector('#memory-journal-screen .back-btn');
            if (backBtn) backBtn.setAttribute('data-target', 'chat-room-screen');
            switchScreen('memory-journal-screen');
            const chat = currentChatType === 'private'
                ? db.characters.find(c => c.id === currentChatId)
                : db.groups.find(g => g.id === currentChatId);
            if (chat?.journalNewestFirst === true) {
                const content = document.querySelector('#memory-journal-screen .content');
                if (content) content.scrollTop = 0;
            }
            showPanel('none'); 
        });
    }

    if (memoryTableBtn) {
        memoryTableBtn.addEventListener('click', () => {
            if (currentChatType !== 'private') {
                showToast('结构化记忆暂时只支持单角色私聊');
                showPanel('none');
                return;
            }
            if (typeof renderMemoryTableScreen === 'function') {
                const backBtn = document.querySelector('#memory-table-screen .back-btn');
                if (backBtn) backBtn.setAttribute('data-target', 'chat-room-screen');
                renderMemoryTableScreen();
                switchScreen('memory-table-screen');
            } else {
                showToast('结构化记忆模块未加载');
            }
            showPanel('none');
        });
    }

    if (vectorMemoryBtn) {
        vectorMemoryBtn.addEventListener('click', () => {
            if (currentChatType !== 'private') {
                showToast('向量记忆暂时只支持单角色私聊');
                showPanel('none');
                return;
            }
            if (typeof renderVectorMemoryScreen === 'function') {
                const backBtn = document.querySelector('#vector-memory-screen .back-btn');
                if (backBtn) backBtn.setAttribute('data-target', 'chat-room-screen');
                renderVectorMemoryScreen();
                switchScreen('vector-memory-screen');
            } else {
                showToast('向量记忆模块未加载');
            }
            showPanel('none');
        });
    }

    if (memoryPalaceBtn) {
        memoryPalaceBtn.addEventListener('click', () => {
            if (currentChatType !== 'private') {
                showToast('记忆宫殿暂时只支持单角色私聊');
                showPanel('none');
                return;
            }
            if (window.MemoryPalace?.open) {
                window.MemoryPalace.open(currentChatId, 'chat-room-screen');
            } else {
                showToast('记忆宫殿模块尚未加载');
            }
            showPanel('none');
        });
    }

    if (collaborationBtn) {
        collaborationBtn.addEventListener('click', () => {
            if (currentChatType !== 'private') {
                showToast('协同工作目前只支持角色私聊');
                showPanel('none');
                return;
            }
            if (window.Collaboration?.open) {
                void window.Collaboration.open(currentChatId, 'chat-room-screen');
            } else {
                showToast('协同工作模块尚未加载');
            }
            showPanel('none');
        });
    }

    if (listenTogetherBtn) {
        listenTogetherBtn.addEventListener('click', () => {
            if (currentChatType !== 'private') {
                showToast('一起听目前只支持角色私聊');
                showPanel('none');
                return;
            }
            if (window.MioMusic?.open) {
                void window.MioMusic.open({ roleId: currentChatId, returnTarget: 'chat-room-screen' });
            } else {
                showToast('音乐模块尚未加载');
            }
            showPanel('none');
        });
    }

    if (exchangeDiaryBtn) {
        exchangeDiaryBtn.addEventListener('click', () => {
            if (currentChatType !== 'private') {
                showToast('交换日记目前只支持角色私聊');
                showPanel('none');
                return;
            }
            if (window.ExchangeDiary?.open) {
                void window.ExchangeDiary.open(currentChatId);
            } else {
                showToast('交换日记模块尚未加载');
            }
            showPanel('none');
        });
    }

    if (deleteHistoryBtn) {
        deleteHistoryBtn.addEventListener('click', () => {
            openDeleteChunkModal();
            showPanel('none'); 
        });
    }

    if (captureBtn) {
        captureBtn.addEventListener('click', () => {
            enterMultiSelectMode(null, 'capture');
            showPanel('none');
        });
    }

    const shopBtn = document.getElementById('shop-btn');
    if (shopBtn) {
        shopBtn.addEventListener('click', () => {
            if (typeof openShopScreen === 'function') {
                openShopScreen();
                showPanel('none');
            } else {
                showToast('商城模块未加载');
            }
        });
    }

    const videoCallBtn = document.getElementById('video-call-btn');
    if (videoCallBtn) {
        videoCallBtn.addEventListener('click', () => {
            if (window.VideoCallModule) {
                window.VideoCallModule.showCallTypeModal();
                showPanel('none');
            } else {
                showToast('视频通话模块未加载');
            }
        });
    }

    const charGalleryManageBtn = document.getElementById('char-gallery-manage-btn');
    if (charGalleryManageBtn) {
        charGalleryManageBtn.addEventListener('click', () => {
            if (typeof openGalleryManager === 'function') {
                openGalleryManager();
                showPanel('none');
            } else {
                showToast('相册功能未加载');
            }
        });
    }

    document.getElementById('send-message-btn').addEventListener('click', sendMessage);
    document.getElementById('send-message-btn').addEventListener('touchend', (e) => {
        e.preventDefault();
        sendMessage();
        setTimeout(() => {
            messageInput.focus();
        }, 50);
    });
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !isGenerating) sendMessage();
    });

    // 监听输入框聚焦事件：自动收起底部面板，避免与键盘冲突
    messageInput.addEventListener('focus', () => {
        if (chatExpansionPanel.classList.contains('visible')) {
            // 立即禁用动画，防止键盘弹出时面板被顶起
            chatExpansionPanel.classList.add('no-transition');
            showPanel('none');
            // 恢复动画属性
            setTimeout(() => {
                chatExpansionPanel.classList.remove('no-transition');
            }, 100);
        }
    });

    getReplyBtn.addEventListener('click', () => getAiReply(currentChatId, currentChatType));
    regenerateBtn.addEventListener('click', handleRegenerate);

    const abortReplyBtn = document.getElementById('abort-reply-btn');
    if (abortReplyBtn) {
        abortReplyBtn.addEventListener('click', async () => {
            const hadLiveController = typeof currentReplyAbortController !== 'undefined' && !!currentReplyAbortController;
            if (hadLiveController) {
                currentReplyAbortController.abort();
            }
            let clearedPersistedTask = false;
            if (window.ReplyResilience && typeof window.ReplyResilience.cancelForChat === 'function') {
                try {
                    clearedPersistedTask = await window.ReplyResilience.cancelForChat(currentChatId, currentChatType);
                } catch (error) {
                    console.warn('[ReplyResilience] could not cancel persisted reply:', error);
                }
            }
            if (hadLiveController || clearedPersistedTask) {
                isGenerating = false;
                getReplyBtn.disabled = false;
                regenerateBtn.disabled = false;
                if (typingIndicator && typingIndicator.getAttribute('data-theater-generating') !== 'true') {
                    typingIndicator.style.display = 'none';
                }
                if (!hadLiveController && typeof showToast === 'function') showToast('已暂停调用');
            }
        });
    }
    
    function getChatSpeechKey(wrapper) {
        const id = wrapper?.dataset?.id || '';
        return `chat:${String(currentChatType || '')}:${String(currentChatId || '')}:${String(id)}`;
    }

    messageArea.addEventListener('click', (e) => {
        if (e.target.closest('.debug-thought-details summary')) return;
        if (isDebugMode) {
            const messageWrapper = e.target.closest('.message-wrapper');
            if (messageWrapper) {
                startDebugEdit(messageWrapper.dataset.id);
                return; 
            }
        }

        if (chatExpansionPanel.classList.contains('visible')) {
            showPanel('none');
            return;
        }

        if (e.target && e.target.id === 'load-more-btn') {
            loadMoreMessages();
        } else if (e.target && e.target.id === 'load-newer-btn') {
            loadNewerMessages();
        } else if (isInMultiSelectMode) {
            const messageWrapper = e.target.closest('.message-wrapper');
            if (messageWrapper) {
                toggleMessageSelection(messageWrapper.dataset.id);
            }
        } else {
            const voiceBubble = e.target.closest('.voice-bubble');
            if (voiceBubble) {
                const wrapper = voiceBubble.closest('.message-wrapper');
                const transcript = wrapper ? wrapper.querySelector('.voice-transcript') : null;
                if (transcript) {
                    transcript.classList.toggle('active');
                    const voiceText = typeof MessageContentParser !== 'undefined'
                        ? MessageContentParser.toSpeechText(voiceBubble.dataset.speechText || transcript.textContent)
                        : (voiceBubble.dataset.speechText || transcript.textContent).trim();
                    if (!voiceText) return;

                    const playKey = getChatSpeechKey(wrapper);
                    const svc = typeof MinimaxTTSService !== 'undefined' ? MinimaxTTSService : null;
                    const state = svc ? svc.getPlayState() : {};
                    const isUserMsg = wrapper && wrapper.classList.contains('sent');

                    // 用户语音只允许播放真实录音；旧的文字消息不再调用 AI 合成用户语音。
                    if (isUserMsg) {
                        const audioAssetId = voiceBubble.dataset.audioAssetId;
                        if (audioAssetId && window.RecordedAudioService) {
                            RecordedAudioService.play(audioAssetId).catch(error => showToast('录音播放失败：' + error.message));
                        }
                        return;
                    }

                    // 对应的角色/用户 API 开关 + 当前聊天语音开关必须同时打开。
                    // 配置不完整时给出真实原因，避免语音气泡看起来像无响应。
                    if (!svc || !svc.config.enabled) {
                        showToast('角色语音尚未启用，请先在 API 设置中配置 TTS');
                        return;
                    }
                    if (currentChatId && typeof db !== 'undefined' && db.characters) {
                        const _chat = db.characters.find(c => c.id === currentChatId);
                        if (!_chat || !_chat.ttsConfig || !_chat.ttsConfig.chatTtsEnabled) {
                            showToast('请先在角色详情中启用 TTS 语音');
                            return;
                        }
                    }

                    // 当前正在播的就是这条：切换暂停/恢复，避免重复读
                    if (svc && state.currentPlayKey === playKey && state.isPlaying) {
                        svc.togglePause();
                        return;
                    }

                    const opts = { playKey: playKey, messageId: playKey, chatId: currentChatId };
                    if (!MinimaxTTSService.isConfigured()) {
                        showToast('TTS 配置不完整，请检查服务地址、密钥和模型');
                        return;
                    }
                    if (typeof VoiceSelector !== 'undefined' && currentChatId) {
                        const voiceConfig = VoiceSelector.getVoiceConfig(currentChatId);
                        if (voiceConfig && voiceConfig.voiceId) {
                            Object.assign(opts, { speed: voiceConfig.speed });
                            MinimaxTTSService.synthesizeAndPlay(
                                voiceText,
                                voiceConfig.voiceId,
                                voiceConfig.language || 'auto',
                                opts
                            ).catch(err => {
                                console.error('[Chat] TTS 播放失败:', err);
                                showToast('TTS 播放失败：' + (err.message || '未知错误'));
                            });
                        } else {
                            showToast('请先为角色选择可用音色');
                        }
                    } else {
                        showToast('角色音色组件尚未就绪，请重新打开 Mio');
                    }
                }
            }
            
            const bilingualBubble = e.target.closest('.bilingual-bubble');
            if (bilingualBubble) {
                const translationText = bilingualBubble.closest('.message-wrapper').querySelector('.translation-text');
                if (translationText) {
                    translationText.classList.toggle('active');
                }
            }

            const pvCard = e.target.closest('.pv-card');
            if (pvCard) {
                const imageOverlay = pvCard.querySelector('.pv-card-image-overlay');
                const footer = pvCard.querySelector('.pv-card-footer');
                imageOverlay.classList.toggle('hidden');
                footer.classList.toggle('hidden');
            }
            const giftCard = e.target.closest('.gift-card');
            if (giftCard) {
                const description = giftCard.closest('.message-wrapper').querySelector('.gift-card-description');
                if (description) {
                    description.classList.toggle('active');
                }
            }
            const transferCard = e.target.closest('.transfer-card.received-transfer');
            if (transferCard) {
                const messageWrapper = transferCard.closest('.message-wrapper');
                const messageId = messageWrapper.dataset.id;
                
                if (currentChatType === 'private') {
                    const character = db.characters.find(c => c.id === currentChatId);
                    const message = character.history.find(m => m.id === messageId);
                    if (message && (!message.transferStatus || message.transferStatus === 'pending')) {
                        handleReceivedTransferClick(messageId);
                    }
                } else if (currentChatType === 'group') {
                    const group = db.groups.find(g => g.id === currentChatId);
                    const message = group.history.find(m => m.id === messageId);
                    if (message && (!message.transferStatus || message.transferStatus === 'pending')) {
                        // 检查是否是发给用户的转账（角色向用户转账）
                        const groupTransferRegex = /\[(.*?)\s*向\s*(.*?)\s*转账[：:]([\d.,]+)元[；;]备注[：:](.*?)\]/;
                        const transferMatch = message.content.match(groupTransferRegex);
                        if (transferMatch) {
                            const to = transferMatch[2];
                            const myName = group.me.nickname;
                            // 只有发给用户的转账（角色向用户转账）可以点击接收
                            if (to === myName && message.role === 'assistant') {
                                handleReceivedTransferClick(messageId);
                            }
                        }
                    }
                }
            }

            const familyCardAcceptBtn = e.target.closest('.family-card-accept');
            const familyCardReturnBtn = e.target.closest('.family-card-return');
            if (familyCardAcceptBtn || familyCardReturnBtn) {
                const btn = familyCardAcceptBtn || familyCardReturnBtn;
                const msgId = btn.getAttribute('data-msg-id');
                if (msgId && typeof sendFamilyCardResponse === 'function') {
                    sendFamilyCardResponse(msgId, familyCardAcceptBtn ? 'accept' : 'return');
                }
            }
        }
    });

    // TTS 状态变化时更新所有语音条的播放/暂停样式
    function updateVoiceBubblesPlayState() {
        const state = typeof MinimaxTTSService !== 'undefined' ? MinimaxTTSService.getPlayState() : {};
        const key = state.currentPlayKey;
        const isPlaying = state.isPlaying;
        const isPaused = state.isPaused;
        const area = document.getElementById('message-area');
        if (!area) return;
        area.querySelectorAll('.voice-bubble').forEach(function(bubble) {
            const w = bubble.closest('.message-wrapper');
            const id = w ? getChatSpeechKey(w) : null;
            bubble.classList.remove('playing', 'paused');
            if (id && id === key) {
                if (isPlaying && !isPaused) bubble.classList.add('playing');
                else if (isPaused) bubble.classList.add('paused');
            }
        });
    }
    document.addEventListener('ttsStateChange', updateVoiceBubblesPlayState);

    messageArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (e.target.id === 'load-more-btn' || e.target.id === 'load-newer-btn' || isInMultiSelectMode) return;
        const messageWrapper = e.target.closest('.message-wrapper, .node-divider-wrapper');
        if (!messageWrapper) return;
        handleMessageLongPress(messageWrapper, e.clientX, e.clientY);
    });
    messageArea.addEventListener('touchstart', (e) => {
        if (e.target.id === 'load-more-btn' || e.target.id === 'load-newer-btn') return;
        const messageWrapper = e.target.closest('.message-wrapper, .node-divider-wrapper');
        if (!messageWrapper) return;
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            handleMessageLongPress(messageWrapper, touch.clientX, touch.clientY);
        }, 400);
    });
    messageArea.addEventListener('touchend', () => clearTimeout(longPressTimer));
    messageArea.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    
    const messageEditForm = document.getElementById('message-edit-form');
    if(messageEditForm) {
        messageEditForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveMessageEdit();
        });
    }

    const cancelEditModalBtn = document.getElementById('cancel-edit-modal-btn');
    if(cancelEditModalBtn) {
        cancelEditModalBtn.addEventListener('click', cancelMessageEdit);
    }

    const insertMessageBelowBtn = document.getElementById('insert-message-below-btn');
    if(insertMessageBelowBtn) {
        insertMessageBelowBtn.addEventListener('click', insertMessageBelow);
    }

    const insertMessageForm = document.getElementById('insert-message-form');
    if(insertMessageForm) {
        insertMessageForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await confirmInsertMessage();
        });
    }

    const cancelInsertModalBtn = document.getElementById('cancel-insert-modal-btn');
    if(cancelInsertModalBtn) {
        cancelInsertModalBtn.addEventListener('click', () => {
            document.getElementById('insert-message-modal').classList.remove('visible');
        });
    }

    const hideTimestampBtn = document.getElementById('hide-timestamp-btn');
    if (hideTimestampBtn) {
        hideTimestampBtn.addEventListener('click', () => {
            if (!editingMessageId) return;
            
            const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
            const messageIndex = chat.history.findIndex(m => m.id === editingMessageId);
            
            let targetTime;
            if (messageIndex > 0) {
                const prevMsg = chat.history[messageIndex - 1];
                targetTime = prevMsg.timestamp + 60000; 
            } else {
                targetTime = Date.now(); 
            }
            
            const date = new Date(targetTime);
            const Y = date.getFullYear();
            const M = String(date.getMonth() + 1).padStart(2, '0');
            const D = String(date.getDate()).padStart(2, '0');
            const h = String(date.getHours()).padStart(2, '0');
            const m = String(date.getMinutes()).padStart(2, '0');
            
            const timestampInput = document.getElementById('message-edit-timestamp');
            if (timestampInput) {
                timestampInput.value = `${Y}-${M}-${D}T${h}:${m}`;
            }
        });
    }

    document.getElementById('cancel-multi-select-btn').addEventListener('click', exitMultiSelectMode);
    document.getElementById('delete-selected-btn').addEventListener('click', deleteSelectedMessages);
    const favoriteSelectedBtn = document.getElementById('favorite-selected-btn');
    if (favoriteSelectedBtn) favoriteSelectedBtn.addEventListener('click', () => { if (typeof addFavoritesFromSelection === 'function') addFavoritesFromSelection(); });
    const favoriteMergeBtn = document.getElementById('favorite-merge-btn');
    if (favoriteMergeBtn) favoriteMergeBtn.addEventListener('click', () => { if (typeof addFavoritesFromSelectionMerged === 'function') addFavoritesFromSelectionMerged(); });
    const forwardSelectedBtn = document.getElementById('forward-selected-btn');
    if (forwardSelectedBtn) forwardSelectedBtn.addEventListener('click', () => { if (typeof openForwardModal === 'function') openForwardModal(); });
    document.getElementById('generate-capture-btn').addEventListener('click', generateCapture);
    document.getElementById('close-capture-modal-btn').addEventListener('click', () => {
        document.getElementById('capture-result-modal').classList.remove('visible');
    });
    document.getElementById('cancel-reply-btn').addEventListener('click', cancelQuoteReply);

    if (typeof setupLocationSystem === 'function') setupLocationSystem();
}

function openChatRoom(chatId, type) {
    const chat = (type === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return;

    const requestedLocation = window._pendingMessageLocation;
    if (currentChatId === chatId && currentChatType === type && requestedLocation?.chatId === chatId && requestedLocation.chatType === type) {
        window._pendingMessageLocation = null;
        switchScreen('chat-room-screen');
        if (!ChatHistoryViewport.locate(type, chatId, requestedLocation.messageId)) showToast('该记录已不存在或当前不可显示');
        return;
    }

    currentChatId = chatId;
    currentChatType = type;
    ChatHistoryViewport.reset();
    window.SearchSystem?.onChatOpened?.(chatId, type);

    // 迁移旧的私聊数据 (仅群聊)
    if (type === 'group' && chat.privateSessions && typeof migratePrivateSessionsToHistory === 'function') {
        migratePrivateSessionsToHistory(chat);
        if (typeof saveGroup === 'function') saveGroup(chatId); // 迁移后立即保存当前群
        else saveData();
    }

    if (chat.unreadCount && chat.unreadCount > 0) {
        chat.unreadCount = 0;
        saveCurrentChat();
        renderChatList(); 
    }
    exitMultiSelectMode();
    cancelMessageEdit();
    if (typeof chatRoomTitle !== 'undefined' && chatRoomTitle) {
        chatRoomTitle.textContent = (type === 'private') ? (chat.remarkName || chat.realName || chat.name) : chat.name;
    }
    if (window.PokeSystem) window.PokeSystem.updateTriggerUI(chat, type);
    const subtitle = document.getElementById('chat-room-subtitle');
    if (type === 'private') {
        subtitle.style.display = (chat.showStatus !== false) ? 'flex' : 'none';
        chatRoomStatusText.textContent = chat.status || '在线';
    } else {
        subtitle.style.display = 'none';
    }
    getReplyBtn.style.display = 'inline-flex';
    chatRoomScreen.style.backgroundImage = chat.chatBg ? `url(${chat.chatBg})` : (db.globalChatWallpaper ? `url(${db.globalChatWallpaper})` : 'none');
    const hasActiveReply = !!(window.ReplyResilience && window.ReplyResilience.hasActive(chatId, type));
    if (hasActiveReply) {
        const typingName = type === 'private' ? (chat.remarkName || chat.realName || chat.name) : chat.name;
        typingIndicator.textContent = `“${typingName}”正在输入中...`;
        typingIndicator.style.display = 'block';
    } else {
        typingIndicator.style.display = 'none';
    }
    isGenerating = hasActiveReply;
    getReplyBtn.disabled = hasActiveReply;
    regenerateBtn.disabled = hasActiveReply;
    currentPage = 1;
    chatRoomScreen.className = chatRoomScreen.className.replace(/\bchat-active-[^ ]+\b/g, '');
    chatRoomScreen.classList.add(`chat-active-${chatId}`);
    
    const avatarRadius = chat.avatarRadius !== undefined ? chat.avatarRadius : 50;
    document.documentElement.style.setProperty('--chat-avatar-radius', `${avatarRadius}%`);

    if (chat.bubbleBlurEnabled === false) {
        chatRoomScreen.classList.add('disable-blur');
    } else {
        chatRoomScreen.classList.remove('disable-blur');
    }

    if (chat.showTimestamp) {
        chatRoomScreen.classList.add('show-timestamp');
    } else {
        chatRoomScreen.classList.remove('show-timestamp');
    }
    chatRoomScreen.classList.remove('timestamp-side');

    chatRoomScreen.classList.remove('timestamp-style-bubble', 'timestamp-style-avatar');
    chatRoomScreen.classList.add(`timestamp-style-${chat.timestampStyle || 'bubble'}`);

    const header = document.getElementById('chat-room-header-default');
    if (chat.titleLayout === 'center') {
        header.classList.add('title-centered');
    } else {
        header.classList.remove('title-centered');
    }

    const journalBtnLabel = document.querySelector('#memory-journal-btn .expansion-item-name');
    if (journalBtnLabel) {
        journalBtnLabel.textContent = (type === 'group') ? '总结' : '日记';
    }
    const memoryTableBtn = document.getElementById('memory-table-btn');
    if (memoryTableBtn) {
        memoryTableBtn.style.display = type === 'private' ? '' : 'none';
    }
    const memoryPalaceBtn = document.getElementById('memory-palace-btn');
    if (memoryPalaceBtn) {
        memoryPalaceBtn.style.display = type === 'private' ? '' : 'none';
    }
    const readingBtn = document.getElementById('reading-btn');
    if (readingBtn) {
        readingBtn.style.display = type === 'private' ? '' : 'none';
    }
    const listenTogetherBtn = document.getElementById('listen-together-btn');
    if (listenTogetherBtn) {
        listenTogetherBtn.style.display = type === 'private' ? '' : 'none';
    }
    const collaborationBtn = document.getElementById('collaboration-btn');
    if (collaborationBtn) {
        collaborationBtn.style.display = type === 'private' ? '' : 'none';
    }
    const exchangeDiaryBtn = document.getElementById('exchange-diary-btn');
    if (exchangeDiaryBtn) {
        exchangeDiaryBtn.style.display = type === 'private' ? '' : 'none';
    }

    const starBtn = document.getElementById('char-status-btn');
    if (starBtn) {
        if (type === 'private' && chat.statusPanel && chat.statusPanel.enabled) {
            starBtn.style.display = 'flex';
        } else {
            starBtn.style.display = 'none';
        }
    }

    const peekBtn = document.getElementById('peek-btn');
    if (peekBtn) {
        if (type === 'private') {
            peekBtn.style.display = 'flex';
            peekBtn.classList.remove('has-unread');
            const badge = document.getElementById('gossip-badge');
            if (badge) badge.style.display = 'none';
        } else {
            // 群聊
            if (chat.allowGossip) {
                peekBtn.style.display = 'flex';
                // 检查未读
                const hasUnread = Object.values(gossipUnreadMap || {}).some(count => count > 0);
                const badge = document.getElementById('gossip-badge');
                if (hasUnread) {
                    peekBtn.classList.add('has-unread');
                    if (badge) badge.style.display = 'block';
                } else {
                    peekBtn.classList.remove('has-unread');
                    if (badge) badge.style.display = 'none';
                }
            } else {
                peekBtn.style.display = 'none';
            }
        }
    }

    updateCustomBubbleStyle(chatId, chat.customBubbleCss, chat.useCustomBubbleCss);
    renderMessages(false, true);
    switchScreen('chat-room-screen');
    if (window.ReplyResilience) window.ReplyResilience.scheduleSessionSave();

    // 角色拉黑用户时的输入区覆盖层：仅根据当前角色状态显示，不修改输入框，避免跨角色污染
    var charBlockedOverlay = document.getElementById('char-blocked-overlay');
    if (charBlockedOverlay) {
        charBlockedOverlay.style.display = (type === 'private' && chat.isBlockedByChar) ? 'flex' : 'none';
    }

    const pendingLocation = window._pendingMessageLocation;
    const legacyMessageId = window._searchScrollToMessageId;
    const locationMatchesChat = pendingLocation && pendingLocation.chatId === chatId && pendingLocation.chatType === type;
    const messageIdToLocate = locationMatchesChat ? pendingLocation.messageId : legacyMessageId;
    if (locationMatchesChat) window._pendingMessageLocation = null;
    window._searchScrollToMessageId = null;
    if (messageIdToLocate != null && !ChatHistoryViewport.locate(type, chatId, messageIdToLocate)) {
        showToast('该记录已不存在或当前不可显示');
    }

    requestAnimationFrame(() => {
        void document.body.offsetHeight;
    });
}

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isGenerating) return;
    messageInput.value = '';
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);

    if (!chat) return;
    if (!chat.history) chat.history = [];

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

    let messageContent;
    const systemRegex = /\[system:.*?\]|\[system-display:.*?\]/;
    const inviteRegex = /\[.*?邀请.*?加入群聊\]/;
    const renameRegex = /\[(.*?)修改群名为“(.*?)”\]/;
    const shopOrderRegex = /\[.*?为你下单的商品：.*?\]/;
    const myName = (currentChatType === 'private') ? chat.myName : chat.me.nickname;

    if (renameRegex.test(text)) {
        const match = text.match(renameRegex);
        chat.name = match[2];
        chatRoomTitle.textContent = chat.name;
        messageContent = `[${chat.me.nickname}修改群名为“${chat.name}”]`;
    } else if (systemRegex.test(text) || inviteRegex.test(text) || shopOrderRegex.test(text)) {
        messageContent = text;
    } else {
        let userText = text;
        messageContent = `[${myName}的消息：${userText}]`;
    }

    const message = {
        id: `msg_${Date.now()}`,
        role: 'user',
        content: messageContent,
        parts: [{type: 'text', text: messageContent}],
        timestamp: Date.now()
    };

    if (currentQuoteInfo) {
        message.quote = {
            messageId: currentQuoteInfo.id,
            senderId: currentQuoteInfo.senderId, 
            content: currentQuoteInfo.content
        };
    }

    if (currentChatType === 'group') {
        message.senderId = 'user_me';
    }
    if (currentChatType === 'private' && chat.isBlocked) {
        message.sentWhileBlocked = true;
    }
    chat.history.push(message);
    addMessageBubble(message, currentChatId, currentChatType);
    if (db.globalMessageSentSound && typeof playSound === 'function') {
        playSound(db.globalMessageSentSound);
    }
    triggerHapticFeedback('success');

    if (chat.history.length > 0 && chat.history.length % 300 === 0) {
        promptForBackupIfNeeded('history_milestone');
    }

    await saveCurrentChat();
    renderChatList();

    if (currentQuoteInfo) {
        cancelQuoteReply();
    }
}

// 备份提示
function promptForBackupIfNeeded(triggerType) {
    if (triggerType === 'history_milestone') {
        showToast('uwu提醒您：记得备份噢');
    }
}

// --- 状态栏管理按钮可拖动（移动端/电脑端通用，位置持久化）---

function initStatusManageBtnDrag(btn, overlay) {
    const STORAGE_KEY = 'statusManageBtnPosition';
    const BTN_SIZE = 38;
    const DRAG_THRESHOLD = 5;

    function getOverlayRect() { return overlay.getBoundingClientRect(); }

    function applyPosition(pct) {
        btn.style.left = pct.leftPct + '%';
        btn.style.top = pct.topPct + '%';
        btn.style.right = '';
    }

    function clampToOverlay(leftPct, topPct) {
        const r = getOverlayRect();
        if (r.width <= 0 || r.height <= 0) return { leftPct, topPct };
        const leftPx = (leftPct / 100) * r.width;
        const topPx = (topPct / 100) * r.height;
        const clampedLeftPx = Math.max(0, Math.min(r.width - BTN_SIZE, leftPx));
        const clampedTopPx = Math.max(0, Math.min(r.height - BTN_SIZE, topPx));
        return {
            leftPct: (clampedLeftPx / r.width) * 100,
            topPct: (clampedTopPx / r.height) * 100
        };
    }

    function getCurrentPosition() {
        const r = getOverlayRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const leftVal = btn.style.left;
        const topVal = btn.style.top;
        if (leftVal && topVal) {
            return { leftPct: parseFloat(leftVal), topPct: parseFloat(topVal) };
        }
        const br = btn.getBoundingClientRect();
        return {
            leftPct: ((br.left - r.left) / r.width) * 100,
            topPct: ((br.top - r.top) / r.height) * 100
        };
    }

    function loadSavedPosition() {
        const r = getOverlayRect();
        if (r.width <= 0 || r.height <= 0) return;
        try {
            const s = localStorage.getItem(STORAGE_KEY);
            if (s) {
                const p = JSON.parse(s);
                const clamped = clampToOverlay(p.leftPct, p.topPct);
                applyPosition(clamped);
                return;
            }
        } catch (_) {}
        // 无保存位置时不写 inline，保留 CSS 默认 right/top
    }

    window.applyStatusManageBtnPosition = loadSavedPosition;

    let startX = 0, startY = 0, startLeftPct = 0, startTopPct = 0, isDrag = false;

    function onMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!isDrag && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            isDrag = true;
            btn.classList.add('status-manage-btn-dragging');
        }
        if (!isDrag) return;
        e.preventDefault();
        const r = getOverlayRect();
        if (r.width <= 0 || r.height <= 0) return;
        const curLeftPx = (startLeftPct / 100) * r.width + dx;
        const curTopPx = (startTopPct / 100) * r.height + dy;
        const leftPct = (curLeftPx / r.width) * 100;
        const topPct = (curTopPx / r.height) * 100;
        const clamped = clampToOverlay(leftPct, topPct);
        applyPosition(clamped);
    }

    function onUp(e) {
        btn.releasePointerCapture(e.pointerId);
        btn.removeEventListener('pointermove', onMove);
        btn.removeEventListener('pointerup', onUp);
        btn.removeEventListener('pointercancel', onUp);
        btn.removeEventListener('pointerleave', onUp);
        btn.classList.remove('status-manage-btn-dragging');
        if (isDrag) {
            try {
                const leftPct = parseFloat(btn.style.left);
                const topPct = parseFloat(btn.style.top);
                if (!isNaN(leftPct) && !isNaN(topPct)) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify({ leftPct, topPct }));
                }
            } catch (_) {}
        } else {
            enterStatusMultiSelect();
        }
    }

    btn.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        const cur = getCurrentPosition();
        if (!cur) return;
        startX = e.clientX;
        startY = e.clientY;
        startLeftPct = cur.leftPct;
        startTopPct = cur.topPct;
        isDrag = false;
        btn.setPointerCapture(e.pointerId);
        btn.addEventListener('pointermove', onMove);
        btn.addEventListener('pointerup', onUp);
        btn.addEventListener('pointercancel', onUp);
        btn.addEventListener('pointerleave', onUp);
    });
}

// --- 状态栏多选删除功能 ---

function enterStatusMultiSelect() {
    const overlay = document.getElementById('char-status-overlay');
    if (!overlay) return;
    overlay.classList.add('multi-select-mode');

    // 给每个 slide 添加 checkbox
    const slides = overlay.querySelectorAll('.status-slide');
    slides.forEach((slide, index) => {
        if (slide.querySelector('.status-slide-checkbox')) return;
        const cb = document.createElement('div');
        cb.className = 'status-slide-checkbox';
        cb.dataset.index = index;
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            cb.classList.toggle('checked');
            updateStatusSelectCount();
        });
        slide.appendChild(cb);
    });

    // 也允许点击 slide 本身来切换选中
    slides.forEach(slide => {
        slide._statusMultiSelectHandler = (e) => {
            if (e.target.closest('.status-slide-checkbox')) return;
            const cb = slide.querySelector('.status-slide-checkbox');
            if (cb) {
                cb.classList.toggle('checked');
                updateStatusSelectCount();
            }
        };
        slide.addEventListener('click', slide._statusMultiSelectHandler);
    });

    updateStatusSelectCount();
    if (typeof triggerHapticFeedback === 'function') triggerHapticFeedback('light');
}

function exitStatusMultiSelect() {
    const overlay = document.getElementById('char-status-overlay');
    if (!overlay) return;
    overlay.classList.remove('multi-select-mode');

    // 移除 checkbox 和事件
    const slides = overlay.querySelectorAll('.status-slide');
    slides.forEach(slide => {
        const cb = slide.querySelector('.status-slide-checkbox');
        if (cb) cb.remove();
        if (slide._statusMultiSelectHandler) {
            slide.removeEventListener('click', slide._statusMultiSelectHandler);
            delete slide._statusMultiSelectHandler;
        }
    });

    // 重置全选按钮文字
    const selectAllBtn = document.getElementById('status-select-all-btn');
    if (selectAllBtn) selectAllBtn.textContent = '全选';
}

function updateStatusSelectCount() {
    const overlay = document.getElementById('char-status-overlay');
    const checked = overlay ? overlay.querySelectorAll('.status-slide-checkbox.checked') : [];
    const countEl = document.getElementById('status-select-count');
    const deleteBtn = document.getElementById('status-delete-selected-btn');
    if (countEl) countEl.textContent = `已选 ${checked.length} 项`;
    if (deleteBtn) deleteBtn.disabled = checked.length === 0;
}

async function deleteSelectedStatusSlides() {
    const overlay = document.getElementById('char-status-overlay');
    if (!overlay) return;

    const char = db.characters.find(c => c.id === currentChatId);
    if (!char || !char.statusPanel || !char.statusPanel.history) return;

    const checked = overlay.querySelectorAll('.status-slide-checkbox.checked');
    if (checked.length === 0) return;

    // slidesData 是 history reversed，所以 slide index 0 = history 最旧的
    // history 是 [newest, ..., oldest]，reversed 后是 [oldest, ..., newest]
    // slide index i 对应 history index = history.length - 1 - i
    const historyLen = char.statusPanel.history.length;
    const indicesToDelete = new Set();
    checked.forEach(cb => {
        const slideIdx = parseInt(cb.dataset.index);
        const historyIdx = historyLen - 1 - slideIdx;
        if (historyIdx >= 0 && historyIdx < historyLen) {
            indicesToDelete.add(historyIdx);
        }
    });

    const deletedCount = indicesToDelete.size;

    // 从 history 中移除
    char.statusPanel.history = char.statusPanel.history.filter((_, i) => !indicesToDelete.has(i));

    // 更新当前状态
    if (char.statusPanel.history.length > 0) {
        char.statusPanel.currentStatusHtml = char.statusPanel.history[0].html;
        char.statusPanel.currentStatusRaw = char.statusPanel.history[0].raw;
    } else {
        char.statusPanel.currentStatusHtml = '';
        char.statusPanel.currentStatusRaw = '';
    }

    await saveCurrentChat();

    // 退出多选模式并关闭面板
    exitStatusMultiSelect();
    overlay.classList.remove('visible');
    showToast(`已删除 ${deletedCount} 条状态栏`);
}
