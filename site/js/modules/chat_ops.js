// --- 消息操作模块 (编辑、撤回、多选、截图、历史记录管理) ---

let currentMultiSelectMode = 'delete'; // 'delete' or 'capture'
let messageEditViewportAnchor = null;

const MESSAGE_DEBUG_EDITABLE_FIELDS = Object.freeze([
    'content', 'translation', 'transcriptOriginal', 'parts', 'quote',
    'hiddenFromDisplay', 'isContextDisabled', 'excludeFromContext'
]);
const MESSAGE_DEBUG_MEDIA_PLACEHOLDER = /^\[\[BASE64_DATA_PRESERVED:(\d+)\]\]$/;

function cloneMessageDebugValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function protectDebugParts(parts) {
    if (!Array.isArray(parts)) return undefined;
    return cloneMessageDebugValue(parts).map((part, index) => {
        if (part && part.type === 'image' && typeof part.data === 'string' && part.data) {
            part.data = `[[BASE64_DATA_PRESERVED:${index}]]`;
        }
        return part;
    });
}

function findMessageIndexById(history, messageId) {
    if (!Array.isArray(history)) return -1;
    const normalizedId = String(messageId ?? '');
    return history.findIndex(message => String(message?.id ?? '') === normalizedId);
}

function getMessageEditDisplayHistory(chat, chatType = currentChatType) {
    if (typeof getDisplayMessageHistory === 'function') return getDisplayMessageHistory(chat, chatType);
    return Array.isArray(chat?.history) ? chat.history : [];
}

function getMessagePage(chat, messageId, fallbackPage = 1, chatType = currentChatType) {
    const history = getMessageEditDisplayHistory(chat, chatType);
    const pageSize = (typeof MESSAGES_PER_PAGE !== 'undefined' && Number(MESSAGES_PER_PAGE) > 0)
        ? Number(MESSAGES_PER_PAGE) : 50;
    const maxPage = Math.max(1, Math.ceil(history.length / pageSize));
    const index = findMessageIndexById(history, messageId);
    if (index === -1) return Math.max(1, Math.min(Number(fallbackPage) || 1, maxPage));
    return Math.max(1, Math.ceil((history.length - index) / pageSize));
}

function captureChatEditSnapshot(chat) {
    return {
        history: cloneMessageDebugValue(chat.history),
        hasStatus: Object.prototype.hasOwnProperty.call(chat, 'status'),
        status: cloneMessageDebugValue(chat.status),
        hasStatusPanel: Object.prototype.hasOwnProperty.call(chat, 'statusPanel'),
        statusPanel: cloneMessageDebugValue(chat.statusPanel)
    };
}

function restoreChatEditSnapshot(chat, snapshot) {
    chat.history = cloneMessageDebugValue(snapshot.history);
    if (snapshot.hasStatus) chat.status = cloneMessageDebugValue(snapshot.status);
    else delete chat.status;
    if (snapshot.hasStatusPanel) chat.statusPanel = cloneMessageDebugValue(snapshot.statusPanel);
    else delete chat.statusPanel;
}

function createMessageDebugDraft(message) {
    const draft = {
        content: String(message?.content || ''),
        translation: String(message?.translation || ''),
        transcriptOriginal: String(message?.transcriptOriginal || '')
    };
    for (const field of MESSAGE_DEBUG_EDITABLE_FIELDS.slice(3)) {
        if (message && Object.prototype.hasOwnProperty.call(message, field)) {
            draft[field] = field === 'parts' ? protectDebugParts(message[field]) : cloneMessageDebugValue(message[field]);
        }
    }
    return draft;
}

function restoreDebugParts(parts, originalParts) {
    if (!Array.isArray(parts)) throw new Error('parts 必须是数组或省略');
    const protectedSourceIndexes = new Set();
    (Array.isArray(originalParts) ? originalParts : []).forEach((part, index) => {
        if (part && part.type === 'image' && typeof part.data === 'string' && part.data) protectedSourceIndexes.add(index);
    });
    const restoredSourceIndexes = new Set();
    const restoredParts = cloneMessageDebugValue(parts).map((part, index) => {
        if (!part || typeof part !== 'object' || Array.isArray(part) || typeof part.type !== 'string') {
            throw new Error(`parts[${index}] 缺少有效的 type`);
        }
        if (!part.type.trim()) throw new Error(`parts[${index}] 缺少有效的 type`);
        const placeholder = part.type === 'image' ? String(part.data || '').match(MESSAGE_DEBUG_MEDIA_PLACEHOLDER) : null;
        if (placeholder) {
            const sourceIndex = Number(placeholder[1]);
            const original = Array.isArray(originalParts) ? originalParts[sourceIndex] : null;
            if (!Number.isSafeInteger(sourceIndex) || !original || original.type !== 'image' || typeof original.data !== 'string' || !original.data) {
                throw new Error(`parts[${index}] 的原始图片数据不存在`);
            }
            if (restoredSourceIndexes.has(sourceIndex)) throw new Error(`parts[${index}] 重复引用了原始图片 ${sourceIndex}`);
            part.data = original.data;
            restoredSourceIndexes.add(sourceIndex);
        }
        return part;
    });
    for (const sourceIndex of protectedSourceIndexes) {
        if (!restoredSourceIndexes.has(sourceIndex)) throw new Error(`原始图片 ${sourceIndex} 的保护占位符不能删除或替换`);
    }
    return restoredParts;
}

function applyMessageDebugDraft(message, rawDraft) {
    let draft;
    try { draft = JSON.parse(String(rawDraft || '')); }
    catch (_) { throw new Error('调试内容必须是有效的 JSON 对象'); }
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('调试内容必须是 JSON 对象');
    if (typeof draft.content !== 'string' || !draft.content.trim()) throw new Error('content 必须是非空字符串');

    const unknown = Object.keys(draft).filter(field => !MESSAGE_DEBUG_EDITABLE_FIELDS.includes(field));
    if (unknown.length) throw new Error(`不允许编辑字段：${unknown.join('、')}`);

    const candidate = cloneMessageDebugValue(message);
    candidate.content = draft.content;
    for (const field of ['translation', 'transcriptOriginal']) {
        if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
        if (typeof draft[field] !== 'string') throw new Error(`${field} 必须是字符串`);
        if (draft[field].trim()) candidate[field] = draft[field];
        else delete candidate[field];
    }
    if (Object.prototype.hasOwnProperty.call(draft, 'parts')) {
        if (draft.parts == null) {
            restoreDebugParts([], message.parts);
            delete candidate.parts;
        }
        else candidate.parts = restoreDebugParts(draft.parts, message.parts);
    }
    if (Object.prototype.hasOwnProperty.call(draft, 'quote')) {
        if (draft.quote == null) delete candidate.quote;
        else if (typeof draft.quote === 'object' && !Array.isArray(draft.quote)) candidate.quote = cloneMessageDebugValue(draft.quote);
        else throw new Error('quote 必须是对象、null 或省略');
    }
    for (const field of ['hiddenFromDisplay', 'isContextDisabled', 'excludeFromContext']) {
        if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
        if (typeof draft[field] !== 'boolean') throw new Error(`${field} 必须是布尔值`);
        candidate[field] = draft[field];
    }
    for (const field of MESSAGE_DEBUG_EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(candidate, field)) message[field] = candidate[field];
        else delete message[field];
    }
    return message;
}

function findMessageWrapper(area, messageId) {
    return Array.from(area?.querySelectorAll?.('.message-wrapper[data-id]') || [])
        .find(node => node.dataset.id === String(messageId || '')) || null;
}

function captureMessageEditAnchor(messageId) {
    const area = document.getElementById('message-area');
    if (!area) return null;
    const wrapper = findMessageWrapper(area, messageId);
    const areaRect = area.getBoundingClientRect ? area.getBoundingClientRect() : { top: 0 };
    const wrapperRect = wrapper?.getBoundingClientRect ? wrapper.getBoundingClientRect() : null;
    return {
        messageId: String(messageId || ''),
        page: Math.max(1, Number(currentPage) || 1),
        relativeTop: wrapperRect ? wrapperRect.top - areaRect.top : null,
        scrollTop: Number(area.scrollTop) || 0,
        distanceFromBottom: Math.max(0, (Number(area.scrollHeight) || 0) - (Number(area.scrollTop) || 0) - (Number(area.clientHeight) || 0))
    };
}

function restoreMessageEditAnchor(anchor) {
    if (!anchor) return;
    const restore = () => {
        const area = document.getElementById('message-area');
        if (!area) return;
        const style = area.style || null;
        const previousScrollBehavior = style?.scrollBehavior || '';
        if (style) style.scrollBehavior = 'auto';
        const wrapper = findMessageWrapper(area, anchor.messageId);
        if (wrapper && anchor.relativeTop != null && wrapper.getBoundingClientRect) {
            const areaTop = area.getBoundingClientRect ? area.getBoundingClientRect().top : 0;
            area.scrollTop += wrapper.getBoundingClientRect().top - areaTop - anchor.relativeTop;
        } else {
            area.scrollTop = Math.max(0, Math.min(Number(anchor.scrollTop) || 0, Math.max(0, area.scrollHeight - area.clientHeight)));
        }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { if (style) style.scrollBehavior = previousScrollBehavior; });
        } else if (style) {
            style.scrollBehavior = previousScrollBehavior;
        }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(restore));
    else setTimeout(restore, 0);
}

async function releaseSharedMessageAssets(messageIds, chatType = currentChatType, chatId = currentChatId) {
    if (!window.SharedAssets?.detachOwner) return;
    for (const messageId of messageIds || []) {
        try { await window.SharedAssets.detachOwner('message', `${chatType}:${chatId}:${messageId}`); }
        catch (error) { console.warn('[Chat] shared message asset detach skipped:', error); }
    }
}

function handleMessageLongPress(messageWrapper, x, y) {
    if (isInMultiSelectMode) return;
    clearTimeout(longPressTimer);
    // 清除可能存在的文本选择，防止干扰菜单点击
    if (window.getSelection) {
        window.getSelection().removeAllRanges();
    }
    const messageId = messageWrapper.dataset.id;
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const messageIndex = findMessageIndexById(chat?.history, messageId);
    const message = messageIndex === -1 ? null : chat.history[messageIndex];
    if (!message) return;

    let menuItems = [];
    if (message.apiUsage) menuItems.push({ label: 'API 调用详情', action: () => {
        const usage = message.apiUsage;
        customAlert(`API：${usage.name}\n模型：${usage.model}\n来源：${usage.source}\n${usage.fallback ? '本次使用备用配置' : '本次使用选定配置'}${usage.elapsedMs != null ? `\n耗时：${(usage.elapsedMs / 1000).toFixed(1)} 秒` : ''}`, 'API 调用详情');
    } });

    if (message.isNodeBoundary) {
        menuItems.push({
            label: '删除节点标记',
            action: async () => {
                if (confirm('确定要删除该节点标记吗？如果是开始标记，将同时删除该节点记录。')) {
                    const char = db.characters.find(c => c.id === currentChatId);
                    if (!char) return;
                    
                    if (message.nodeAction === 'start') {
                        if (char.nodes) {
                            char.nodes = char.nodes.filter(n => n.id !== message.nodeId);
                        }
                        if (char.activeNodeId === message.nodeId) {
                            char.activeNodeId = null;
                        }
                    } else if (message.nodeAction === 'end') {
                        if (char.nodes) {
                            const node = char.nodes.find(n => n.id === message.nodeId);
                            if (node) {
                                node.status = 'active';
                                char.activeNodeId = message.nodeId;
                            }
                        }
                    }
                    
                    char.history = char.history.filter(m => m.id !== messageId);
                    await releaseSharedMessageAssets([messageId]);
                    
                    await saveCurrentChat();
                    renderMessages(false, true);
                    if (typeof NodeSystem !== 'undefined') {
                        NodeSystem.checkActiveNodeUI();
                    }
                    showToast('节点标记已删除');
                }
            }
        });
        
        if (menuItems.length > 0) {
            triggerHapticFeedback('medium');
            createContextMenu(menuItems, x, y);
        }
        return;
    }

    const isImageRecognitionMsg = message.parts && message.parts.some(p => p.type === 'image');
    const isVoiceMessage = /\[.*?的语音：.*?\]/.test(message.content);
    const isStickerMessage = /\[.*?的表情包：.*?\]|\[.*?发送的表情包：.*?\]/.test(message.content);
    const isPhotoVideoMessage = /\[.*?发来的照片\/视频：.*?\]/.test(message.content);
    const isTransferMessage = /\[.*?给你转账：.*?\]|\[.*?的转账：.*?\]|\[.*?向.*?转账：.*?\]/.test(message.content);
    const isGiftMessage = /\[.*?送来的礼物：.*?\]|\[.*?向.*?送来了礼物：.*?\]/.test(message.content);
    const timeGapMatch = message.content.match(/\[system-display:距离上次聊天已经过去 (.*?)\]/);
    
    let invisibleRegex;
    if (chat.showStatusUpdateMsg) {
        invisibleRegex = /\[.*?(?:接收|退回).*?的转账\]|\[.*?已接收礼物\]|\[system:.*?\]|\[.*?邀请.*?加入了群聊\]|\[.*?修改群名为：.*?\]|\[system-display:.*?\]|\[avatar-action:.*?\]/;
    } else {
        invisibleRegex = /\[.*?(?:接收|退回).*?的转账\]|\[.*?更新状态为：.*?\]|\[.*?已接收礼物\]|\[system:.*?\]|\[.*?邀请.*?加入了群聊\]|\[.*?修改群名为：.*?\]|\[system-display:.*?\]|\[avatar-action:.*?\]/;
    }
    const isInvisibleMessage = invisibleRegex.test(message.content);
    if (message.activityTrace && window.ActivityTraceNavigator) {
        menuItems.push({ label: '查看关联记录', action: () => window.ActivityTraceNavigator.open(message.activityTrace, { source: 'chat' }) });
    }
    const isWithdrawn = message.isWithdrawn; 

    if (!isWithdrawn) {
        if (!isImageRecognitionMsg && !isVoiceMessage && !isStickerMessage && !isPhotoVideoMessage && !isTransferMessage && !isGiftMessage && !isInvisibleMessage) {
            menuItems.push({label: '编辑', action: () => startMessageEdit(messageId)});
        }
        
        if (!isInvisibleMessage) {
            menuItems.push({label: '引用', action: () => startQuoteReply(messageId)});
        }

        if (message.role === 'user') {
            menuItems.push({label: '撤回', action: () => withdrawMessage(messageId)});
        }
    }

    if (timeGapMatch) {
        menuItems.push({
            label: '编辑时间',
            action: async () => {
                const newTime = await customPrompt('修改经过的时间', timeGapMatch[1], '编辑时间');
                if (newTime !== null && newTime.trim() !== '') {
                    message.content = `[system-display:距离上次聊天已经过去 ${newTime.trim()}]`;
                    if (message.parts && message.parts.length > 0) {
                        message.parts = [{type: 'text', text: message.content}];
                    }
                    if (typeof saveCurrentChat === 'function') await saveCurrentChat();
                    renderMessages(false, true);
                    if (typeof showToast === 'function') showToast('时间已修改');
                }
            }
        });
    }

    if (!isInvisibleMessage) {
        menuItems.push({label: '收藏', action: () => { if (typeof addMessageToFavorites === 'function') addMessageToFavorites(messageId); }});
    }

    menuItems.push({
        label: isDebugMode ? '退出调试' : '进入调试',
        action: () => {
            isDebugMode = !isDebugMode;
            showToast(isDebugMode ? '已进入调试模式' : '已退出调试模式');
            renderMessages(false, true); 
        }
    });

    if (currentChatType === 'private') {
        menuItems.push({
            label: '插入节点',
            action: () => {
                // 优化：使用自定义弹窗代替原生 confirm
                const position = confirm('点击“确定”在此消息之后插入，点击“取消”在此消息之前插入') ? 'after' : 'before';
                if (typeof NodeSystem !== 'undefined') {
                    NodeSystem.insertNodeBoundary(messageId, position);
                }
            }
        });
    }

    // 角色 TTS 音频：用户消息不再通过 AI 合成语音。
    if (!isWithdrawn && !isInvisibleMessage &&
        message.role !== 'user' &&
        typeof MinimaxTTSService !== 'undefined' && MinimaxTTSService.isConfigured() &&
        chat.ttsConfig && chat.ttsConfig.chatTtsEnabled &&
        typeof VoiceSelector !== 'undefined') {
        const getRoleVoicePayload = () => {
            const voiceConfig = VoiceSelector.getVoiceConfig(currentChatId, 'char');
            if (!voiceConfig || !voiceConfig.voiceId) throw new Error('未设置角色音色');
            let text = message.content || '';
            if (typeof MessageContentParser !== 'undefined' && typeof MessageContentParser.toSpeechText === 'function') {
                text = MessageContentParser.toSpeechText(text);
            }
            text = MinimaxTTSService.cleanText(text, MinimaxTTSService.config);
            if (!text) throw new Error('消息内容为空');
            return {
                text,
                voiceConfig,
                options: { speed: voiceConfig.speed, chatId: currentChatId, messageId }
            };
        };
        menuItems.push({
            label: '下载语音',
            action: async () => {
                try {
                    showToast('🔊 正在生成语音...');
                    const { text, voiceConfig, options } = getRoleVoicePayload();
                    await MinimaxTTSService.download(text, voiceConfig.voiceId, voiceConfig.language || 'auto', options);
                    showToast('✅ 语音已下载');
                } catch (err) {
                    console.error('[ChatOps] 下载语音失败:', err);
                    showToast('❌ 下载失败: ' + err.message);
                }
            }
        });
        menuItems.push({
            label: message.ttsAudioPermanentKey ? '取消永久保存语音' : '永久保存语音',
            action: async () => {
                try {
                    if (message.ttsAudioPermanentKey) {
                        await MinimaxTTSService.setPermanentByKey(message.ttsAudioPermanentKey, false, { chatId: currentChatId, messageId });
                        delete message.ttsAudioPermanentKey;
                        await saveCurrentChat();
                        showToast('已改为普通缓存');
                        return;
                    }
                    showToast('🔊 正在保存语音...');
                    const { text, voiceConfig, options } = getRoleVoicePayload();
                    message.ttsAudioPermanentKey = await MinimaxTTSService.setPermanent(
                        text, voiceConfig.voiceId, voiceConfig.language || 'auto', options, true
                    );
                    await saveCurrentChat();
                    showToast('✅ 语音已永久保留');
                } catch (err) {
                    console.error('[ChatOps] 保存语音失败:', err);
                    showToast('❌ 保存失败: ' + err.message);
                }
            }
        });
    }

    if (!isWithdrawn && message.role === 'user' && message.audioAssetId && window.RecordedAudioService) {
        menuItems.push({
            label: '保存录音到本地',
            action: async () => {
                try { await RecordedAudioService.download(message.audioAssetId); showToast('✅ 录音已下载'); }
                catch (error) { showToast('❌ 下载失败：' + error.message); }
            }
        });
    }

    // 生成图片/重新生图：无论是否开启，都显示选项，在点击时判断
    if (!isWithdrawn && !isInvisibleMessage) {
        menuItems.push({
            label: isPhotoVideoMessage ? '重新生图' : '生成图片',
            action: async () => {
                const gptSettings = db.gptImageSettings || {};
                const naiSettings = db.novelAiSettings || {};
                const googleSettings = db.googleImageSettings || {};
                const stabilitySettings = db.stabilityImageSettings || {};
                
                const isGptOn = gptSettings.enabled;
                const isNaiOn = naiSettings.enabled;
                const isGoogleOn = googleSettings.enabled;
                const isStabilityOn = stabilitySettings.enabled;
                
                if (!isGptOn && !isNaiOn && !isGoogleOn && !isStabilityOn) {
                    showToast('未开启生图功能，请先在设置中开启生图引擎');
                    return;
                }
                
                const activeProvider = db.activeImageProvider || (isGptOn ? 'gpt' : isNaiOn ? 'novelai' : isGoogleOn ? 'google' : 'stability');
                if (activeProvider === 'gpt') {
                    if (!gptSettings.url || !gptSettings.key) {
                        showToast('已开启 GPT 生图，但未填写 URL 或 API Key');
                        return;
                    }
                } else if (activeProvider === 'novelai') {
                    if (!naiSettings.token && naiSettings.authMode !== 'none') {
                        showToast('已开启 NovelAI 生图，但未填写 Token');
                        return;
                    }
                } else if (activeProvider === 'google' && (!googleSettings.url || !googleSettings.key)) {
                    showToast('已开启 Google 生图，但未填写地址或 API Key');
                    return;
                } else if (activeProvider === 'stability' && (!stabilitySettings.url || !stabilitySettings.key)) {
                    showToast('已开启 Stability 生图，但未填写地址或 API Key');
                    return;
                }

                if (typeof window.retryImageGen === 'function') {
                    showToast('🎨 已加入重新生成队列...');
                    window.retryImageGen(message.id, currentChatId, currentChatType);
                } else {
                    showToast('❌ 生图组件未就绪');
                }
            }
        });
    }

    menuItems.push({label: '删除', action: () => enterMultiSelectMode(messageId)});
    if (!isInvisibleMessage) {
        menuItems.push({label: '多选收藏', action: () => enterMultiSelectMode(messageId, 'favorite')});
    }
    
    // 新增：转发选项
    menuItems.push({
        label: '转发',
        action: () => {
            enterMultiSelectMode(messageId, 'forward');
        }
    });

    if (menuItems.length > 0) {
        triggerHapticFeedback('medium');
        createContextMenu(menuItems, x, y);
    }
}

function startDebugEdit(messageId) {
    exitMultiSelectMode();
    editingMessageId = messageId;
    isRawEditMode = true; 

    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const messageIndex = findMessageIndexById(chat?.history, messageId);
    const message = messageIndex === -1 ? null : chat.history[messageIndex];
    if (!message) return;
    messageEditViewportAnchor = captureMessageEditAnchor(messageId);

    const modal = document.getElementById('message-edit-modal');
    const textarea = document.getElementById('message-edit-textarea');
    const title = modal.querySelector('h3');
    const deleteBtn = document.getElementById('debug-delete-msg-btn'); 

    if (!modal.dataset.originalTitle) modal.dataset.originalTitle = title.textContent;
    title.textContent = "调试/编辑源码";

    textarea.value = JSON.stringify(createMessageDebugDraft(message), null, 2);

    const timestampInput = document.getElementById('message-edit-timestamp');
    const timestampGroup = document.getElementById('message-edit-timestamp-group');
    if (timestampInput && timestampGroup) {
        const date = new Date(message.timestamp);
        const Y = date.getFullYear();
        const M = String(date.getMonth() + 1).padStart(2, '0');
        const D = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const m = String(date.getMinutes()).padStart(2, '0');
        timestampInput.value = `${Y}-${M}-${D}T${h}:${m}`;
        timestampInput.dataset.originalValue = timestampInput.value;
        timestampGroup.style.display = 'flex';
    }
    
    if (deleteBtn) {
        deleteBtn.style.display = 'block';
        const newDeleteBtn = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
        
        newDeleteBtn.addEventListener('click', async () => {
            if (confirm('【调试模式】确定要永久删除这条消息吗？')) {
                const snapshot = captureChatEditSnapshot(chat);
                const displayHistory = getMessageEditDisplayHistory(chat, currentChatType);
                const displayIndex = findMessageIndexById(displayHistory, messageId);
                const fallbackMessage = displayHistory[displayIndex + 1] || displayHistory[displayIndex - 1];
                const anchor = messageEditViewportAnchor || captureMessageEditAnchor(messageId);
                if (anchor && fallbackMessage) anchor.messageId = fallbackMessage.id;
                chat.history = chat.history.filter(m => String(m?.id ?? '') !== String(messageId ?? ''));
                
                if (currentChatType === 'private') {
                    recalculateChatStatus(chat);
                }

                let saved = false;
                try { saved = await saveCurrentChat(); }
                catch (error) { console.error('save debug message deletion failed:', error); }
                if (saved === false) {
                    restoreChatEditSnapshot(chat, snapshot);
                    if (currentChatType === 'private') recalculateChatStatus(chat);
                    showToast('消息删除保存失败，原消息已恢复');
                    return;
                }
                await releaseSharedMessageAssets([message.id]);
                if (anchor) {
                    anchor.page = fallbackMessage
                        ? getMessagePage(chat, fallbackMessage.id, anchor.page, currentChatType)
                        : getMessagePage(chat, '', anchor.page, currentChatType);
                    currentPage = anchor.page;
                }
                renderMessages(false, false);
                cancelMessageEdit(); 
                restoreMessageEditAnchor(anchor);
                showToast('消息已删除');
            }
        });
    }

    modal.classList.add('visible');
    textarea.focus();
}

function startQuoteReply(messageId) {
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const messageIndex = findMessageIndexById(chat?.history, messageId);
    const message = messageIndex === -1 ? null : chat.history[messageIndex];
    if (!message) return;

    let senderName = '';
    let senderId = '';
    if (message.role === 'user') {
        senderName = (currentChatType === 'private') ? chat.myName : chat.me.nickname;
        senderId = 'user_me';
    } else { 
        if (currentChatType === 'private') {
            senderName = chat.remarkName;
            senderId = chat.id;
        } else {
            const sender = chat.members.find(m => m.id === message.senderId);
            senderName = sender ? sender.groupNickname : '未知成员';
            senderId = sender ? sender.id : 'unknown';
        }
    }
    
    let previewContent = message.content;
    const textMatch = message.content.match(/\[.*?的消息：([\s\S]+?)\]/);
    if (textMatch) {
        previewContent = textMatch[1];
    } else if (/\[.*?的表情包：.*?\]/.test(message.content)) {
        previewContent = '[表情包]';
    } else if (/\[.*?的语音：.*?\]/.test(message.content)) {
        previewContent = '[语音]';
    } else if (/\[.*?发来的照片\/视频：.*?\]/.test(message.content)) {
        previewContent = '[照片/视频]';
    } else if (message.parts && message.parts.some(p => p.type === 'image')) {
        previewContent = '[图片]';
    }
    
    currentQuoteInfo = {
        id: message.id,
        senderId: senderId,
        senderName: senderName,
        content: previewContent.substring(0, 100) 
    };

    const previewBar = document.getElementById('reply-preview-bar');
    previewBar.querySelector('.reply-preview-name').textContent = `回复 ${senderName}`;
    previewBar.querySelector('.reply-preview-text').textContent = currentQuoteInfo.content;
    previewBar.classList.add('visible');
    
    messageInput.focus();
}

function cancelQuoteReply() {
    currentQuoteInfo = null;
    const previewBar = document.getElementById('reply-preview-bar');
    previewBar.classList.remove('visible');
}

function startMessageEdit(messageId) {
    exitMultiSelectMode();
    editingMessageId = messageId;
    isRawEditMode = false;
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const messageIndex = findMessageIndexById(chat?.history, messageId);
    const message = messageIndex === -1 ? null : chat.history[messageIndex];
    if (!message) return;
    messageEditViewportAnchor = captureMessageEditAnchor(messageId);

    const modal = document.getElementById('message-edit-modal');
    const textarea = document.getElementById('message-edit-textarea');

    let contentToEdit = message.content;
    const plainTextMatch = contentToEdit.match(/^\[.*?：([\s\S]*)\]$/);
    if (plainTextMatch && plainTextMatch[1]) {
        contentToEdit = plainTextMatch[1].trim();
    }
    contentToEdit = contentToEdit.replace(/\[发送时间:.*?\]/g, '').trim();
    
    textarea.value = contentToEdit;

    const timestampInput = document.getElementById('message-edit-timestamp');
    const timestampGroup = document.getElementById('message-edit-timestamp-group');
    if (timestampInput && timestampGroup) {
        const date = new Date(message.timestamp);
        const Y = date.getFullYear();
        const M = String(date.getMonth() + 1).padStart(2, '0');
        const D = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const m = String(date.getMinutes()).padStart(2, '0');
        timestampInput.value = `${Y}-${M}-${D}T${h}:${m}`;
        timestampInput.dataset.originalValue = timestampInput.value;
        timestampGroup.style.display = 'flex';
    }

    modal.classList.add('visible');
    textarea.focus();
}

async function saveMessageEdit() {
    const newText = document.getElementById('message-edit-textarea').value.trim();
    if (!newText || !editingMessageId) {
        cancelMessageEdit();
        return;
    }

    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const messageIndex = findMessageIndexById(chat?.history, editingMessageId);
    if (messageIndex === -1) {
        cancelMessageEdit();
        return;
    }

    const snapshot = captureChatEditSnapshot(chat);
    const editedMessage = chat.history[messageIndex];

    if (isRawEditMode) {
        try {
            applyMessageDebugDraft(editedMessage, newText);
        } catch (error) {
            showToast(error.message || '调试内容无效');
            return;
        }
    } else {
        const oldContent = editedMessage.content;
        // 如果编辑的内容已经是 [xxx] 的形式（用户使用了插入模板等）直接应用新文本
        let newContent = newText;
        if (!newText.match(/^\[.*?\]$/)) {
            // 普通文本，沿用原消息的前缀
            const prefixMatch = oldContent.match(/(\[.*?：)[\s\S]*\]/);
            if (prefixMatch && prefixMatch[1]) {
                const prefix = prefixMatch[1];
                newContent = `${prefix}${newText}]`;
            } else if (oldContent.startsWith('[') && oldContent.endsWith(']')) {
                // 原文有括号但没匹配到冒号，尽量保留发送者名字前缀
                const nameMatch = oldContent.match(/^\[(.*?的消息：)/);
                if (nameMatch) {
                    newContent = `${nameMatch[1]}${newText}]`;
                }
            }
        }

        editedMessage.content = newContent;
        if (editedMessage.parts) {
            editedMessage.parts = [{type: 'text', text: newContent}];
        }
    }

    const timestampInput = document.getElementById('message-edit-timestamp');
    if (timestampInput && timestampInput.value) {
        if (timestampInput.value !== timestampInput.dataset.originalValue) {
            const newTime = new Date(timestampInput.value).getTime();
            if (!isNaN(newTime)) {
                editedMessage.timestamp = newTime;
                chat.history.sort((a, b) => a.timestamp - b.timestamp);
            }
        }
    }
    
    if (currentChatType === 'private') {
        recalculateChatStatus(chat);

        if (chat.statusPanel && chat.statusPanel.enabled && chat.statusPanel.regexPattern) {
            try {
                let pattern = chat.statusPanel.regexPattern;
                let flags = 'gs'; 

                const matchParts = pattern.match(/^\/(.*?)\/([a-z]*)$/);
                if (matchParts) {
                    pattern = matchParts[1];
                    flags = matchParts[2] || 'gs';
                    if (!flags.includes('s')) flags += 's';
                }

                const regex = new RegExp(pattern, flags);
                const match = regex.exec(editedMessage.content);
                
                if (match) {
                    const rawStatus = match[0];
                    
                    let html = chat.statusPanel.replacePattern;
                    
                    for (let i = 1; i < match.length; i++) {
                        html = html.replace(new RegExp(`\\$${i}`, 'g'), match[i]);
                    }

                    // 更新 history 中对应的旧条目
                    if (!chat.statusPanel.history) chat.statusPanel.history = [];
                    const oldRaw = editedMessage.statusSnapshot
                        ? editedMessage.statusSnapshot.oldRaw || ''
                        : '';
                    const existingIndex = chat.statusPanel.history.findIndex(h => h.raw === oldRaw || h.raw === rawStatus);
                    if (existingIndex !== -1) {
                        chat.statusPanel.history[existingIndex].raw = rawStatus;
                        chat.statusPanel.history[existingIndex].html = html;
                        chat.statusPanel.history[existingIndex].timestamp = Date.now();
                    } else {
                        // 之前不是状态消息，现在编辑成了状态消息，新增一条
                        chat.statusPanel.history.unshift({
                            raw: rawStatus,
                            html: html,
                            timestamp: Date.now()
                        });
                        const storedLimit = chat.statusPanel.historyRetentionLimit;
                        const retentionLimit = Number.isSafeInteger(storedLimit) && storedLimit >= 0 ? storedLimit : 20;
                        if (retentionLimit > 0 && chat.statusPanel.history.length === retentionLimit + 1) {
                            showToast('状态栏历史已超过参考数量，可在存储分析中手动整理');
                        }
                    }

                    chat.statusPanel.currentStatusRaw = rawStatus;
                    chat.statusPanel.currentStatusHtml = html;
                    
                    editedMessage.isStatusUpdate = true;
                    editedMessage.statusSnapshot = window.StatusStorage
                        ? window.StatusStorage.makeSnapshot(chat, pattern, rawStatus, editedMessage.statusSnapshot) : {
                        regex: pattern,
                        replacePattern: chat.statusPanel.replacePattern,
                        oldRaw: rawStatus
                    };
                } else {
                    // 编辑后不再匹配状态，从 history 中移除旧条目
                    if (editedMessage.isStatusUpdate && chat.statusPanel.history) {
                        const oldRaw = editedMessage.statusSnapshot
                            ? editedMessage.statusSnapshot.oldRaw || ''
                            : '';
                        if (oldRaw) {
                            const removeIndex = chat.statusPanel.history.findIndex(h => h.raw === oldRaw);
                            if (removeIndex !== -1) {
                                chat.statusPanel.history.splice(removeIndex, 1);
                            }
                        }
                        // 重新计算 currentStatus 为最新的 history 条目
                        if (chat.statusPanel.history.length > 0) {
                            chat.statusPanel.currentStatusRaw = chat.statusPanel.history[0].raw;
                            chat.statusPanel.currentStatusHtml = chat.statusPanel.history[0].html;
                        } else {
                            chat.statusPanel.currentStatusRaw = '';
                            chat.statusPanel.currentStatusHtml = '';
                        }
                    }
                    editedMessage.isStatusUpdate = false;
                    delete editedMessage.statusSnapshot;
                }
            } catch (e) {
                console.error("编辑时解析状态栏错误:", e);
            }
        }
    }

    const anchor = messageEditViewportAnchor || captureMessageEditAnchor(editingMessageId);
    let saved = false;
    try { saved = await saveCurrentChat(); }
    catch (error) { console.error('save message edit failed:', error); }
    if (saved === false) {
        restoreChatEditSnapshot(chat, snapshot);
        if (currentChatType === 'private') recalculateChatStatus(chat);
        showToast('消息保存失败，原内容已恢复，编辑草稿仍保留');
        return false;
    }
    if (anchor) {
        anchor.page = getMessagePage(chat, editedMessage.id, anchor.page, currentChatType);
        currentPage = anchor.page;
    }
    renderMessages(false, false);
    renderChatList();
    cancelMessageEdit();
    restoreMessageEditAnchor(anchor);
    return true;
}

function cancelMessageEdit() {
    editingMessageId = null;
    isRawEditMode = false; 
    const modal = document.getElementById('message-edit-modal');
    const deleteBtn = document.getElementById('debug-delete-msg-btn');
    if (deleteBtn) deleteBtn.style.display = 'none';

    const timestampInput = document.getElementById('message-edit-timestamp');
    const timestampGroup = document.getElementById('message-edit-timestamp-group');
    if (timestampInput && timestampGroup) {
        timestampInput.value = '';
        timestampGroup.style.display = 'none';
    }

    if (modal) {
        modal.classList.remove('visible');
        const title = modal.querySelector('h3');
        if (modal.dataset.originalTitle) {
            title.textContent = modal.dataset.originalTitle;
        } else {
            title.textContent = "编辑消息";
        }
    }
    messageEditViewportAnchor = null;
}

function enterMultiSelectMode(initialMessageId, mode = 'delete') {
    isInMultiSelectMode = true;
    currentMultiSelectMode = mode;
    
    chatRoomHeaderDefault.style.display = 'none';
    chatRoomHeaderSelect.style.display = 'flex';
    document.querySelector('.chat-input-wrapper').style.display = 'none';
    
    const delBtn = document.getElementById('delete-selected-btn');
    const favBtn = document.getElementById('favorite-selected-btn');
    const mergeBtn = document.getElementById('favorite-merge-btn');
    const fwdBtn = document.getElementById('forward-selected-btn');

    if (mode === 'delete') {
        multiSelectBar.classList.add('visible');
        document.getElementById('multi-select-title').textContent = '选择消息';
        if (delBtn) delBtn.style.display = '';
        if (favBtn) favBtn.style.display = 'none';
        if (mergeBtn) mergeBtn.style.display = 'none';
        if (fwdBtn) fwdBtn.style.display = 'none';
    } else if (mode === 'capture') {
        document.getElementById('capture-mode-bar').classList.add('visible');
        document.getElementById('multi-select-title').textContent = '选择截图范围';
    } else if (mode === 'favorite') {
        multiSelectBar.classList.add('visible');
        document.getElementById('multi-select-title').textContent = '选择要收藏的消息';
        if (delBtn) delBtn.style.display = 'none';
        if (fwdBtn) fwdBtn.style.display = 'none';
        if (favBtn) { favBtn.style.display = ''; favBtn.disabled = selectedMessageIds.size === 0; }
        if (mergeBtn) { mergeBtn.style.display = ''; mergeBtn.disabled = selectedMessageIds.size === 0; }
    } else if (mode === 'forward') {
        multiSelectBar.classList.add('visible');
        document.getElementById('multi-select-title').textContent = '选择要转发的消息';
        if (delBtn) delBtn.style.display = 'none';
        if (favBtn) favBtn.style.display = 'none';
        if (mergeBtn) mergeBtn.style.display = 'none';
        if (fwdBtn) { fwdBtn.style.display = ''; fwdBtn.disabled = selectedMessageIds.size === 0; }
    }
    
    chatRoomScreen.classList.add('multi-select-active');
    selectedMessageIds.clear();
    if (initialMessageId) {
        toggleMessageSelection(initialMessageId);
    }
}

function exitMultiSelectMode() {
    isInMultiSelectMode = false;
    chatRoomHeaderDefault.style.display = 'flex';
    chatRoomHeaderSelect.style.display = 'none';
    document.querySelector('.chat-input-wrapper').style.display = 'block';
    
    multiSelectBar.classList.remove('visible');
    document.getElementById('capture-mode-bar').classList.remove('visible');
    const delBtn = document.getElementById('delete-selected-btn');
    const favBtn = document.getElementById('favorite-selected-btn');
    const mergeBtn = document.getElementById('favorite-merge-btn');
    const fwdBtn = document.getElementById('forward-selected-btn');
    if (delBtn) delBtn.style.display = '';
    if (favBtn) favBtn.style.display = 'none';
    if (mergeBtn) mergeBtn.style.display = 'none';
    if (fwdBtn) fwdBtn.style.display = 'none';
    
    chatRoomScreen.classList.remove('multi-select-active');
    selectedMessageIds.forEach(id => {
        const el = messageArea.querySelector(`.message-wrapper[data-id="${id}"]`);
        if (el) el.classList.remove('multi-select-selected');
    });
    selectedMessageIds.clear();
    currentMultiSelectMode = 'delete';
}

function toggleMessageSelection(messageId) {
    const el = messageArea.querySelector(`.message-wrapper[data-id="${messageId}"]`);
    if (!el) return;
    if (selectedMessageIds.has(messageId)) {
        selectedMessageIds.delete(messageId);
        el.classList.remove('multi-select-selected');
    } else {
        selectedMessageIds.add(messageId);
        el.classList.add('multi-select-selected');
    }
    
    if (currentMultiSelectMode === 'delete') {
        selectCount.textContent = `已选择 ${selectedMessageIds.size} 项`;
        deleteSelectedBtn.disabled = selectedMessageIds.size === 0;
    } else if (currentMultiSelectMode === 'capture') {
        document.getElementById('capture-select-count').textContent = `已选择 ${selectedMessageIds.size} 项`;
    } else if (currentMultiSelectMode === 'favorite') {
        selectCount.textContent = `已选择 ${selectedMessageIds.size} 项`;
        const favBtn = document.getElementById('favorite-selected-btn');
        const mergeBtn = document.getElementById('favorite-merge-btn');
        if (favBtn) favBtn.disabled = selectedMessageIds.size === 0;
        if (mergeBtn) mergeBtn.disabled = selectedMessageIds.size === 0;
    } else if (currentMultiSelectMode === 'forward') {
        selectCount.textContent = `已选择 ${selectedMessageIds.size} 项`;
        const fwdBtn = document.getElementById('forward-selected-btn');
        if (fwdBtn) fwdBtn.disabled = selectedMessageIds.size === 0;
    }
}

async function generateCapture() {
    if (selectedMessageIds.size === 0) return showToast('请至少选择一条消息');
    
    showToast('正在生成截图，请稍候...', 3000);
    
    // 1. 获取选中的消息元素并排序
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const sortedMessages = chat.history.filter(m => selectedMessageIds.has(m.id));
    
    // 2. 创建临时容器
    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.top = '-9999px';
    tempContainer.style.left = '0';
    tempContainer.style.width = '400px'; // 固定宽度模拟手机
    tempContainer.style.backgroundColor = '#f5f5f5'; // 默认背景
    if (chat.chatBg) {
        tempContainer.style.backgroundImage = `url(${chat.chatBg})`;
        tempContainer.style.backgroundSize = 'cover';
        tempContainer.style.backgroundPosition = 'center';
    } else if (chat.theme) {
        // 应用主题背景色
        const theme = colorThemes[chat.theme] || colorThemes['white_pink'];
        // 这里简单处理，如果需要更精确的主题背景，可能需要更多逻辑
    }
    
    tempContainer.style.padding = '20px';
    tempContainer.style.display = 'flex';
    tempContainer.style.flexDirection = 'column';
    
    // 3. 克隆并处理消息元素
    // 为了保证样式正确，我们需要重新渲染这些消息，或者克隆现有的 DOM
    // 这里选择重新渲染，因为现有的 DOM 可能包含多选状态的样式
    
    // 临时借用 createMessageBubbleElement，但需要注意它依赖全局状态
    // 我们可以手动构建或者克隆现有的 DOM 并移除 .multi-select-selected 类
    
    sortedMessages.forEach(msg => {
        const originalEl = messageArea.querySelector(`.message-wrapper[data-id="${msg.id}"]`);
        if (originalEl) {
            const clone = originalEl.cloneNode(true);
            clone.classList.remove('multi-select-selected');
            clone.style.marginBottom = '15px';
            
            // 处理一些可能在截图时显示不正常的元素
            // 例如：如果是 HTML 气泡，iframe 可能无法被 html2canvas 捕获
            // 这里暂时不做特殊处理，html2canvas 对 iframe 支持有限
            
            tempContainer.appendChild(clone);
        }
    });
    
    // 添加水印
    
    
    document.body.appendChild(tempContainer);
    
    try {
        // 4. 生成截图
        const canvas = await html2canvas(tempContainer, {
            useCORS: true, // 允许跨域图片
            scale: 2, // 提高清晰度
            backgroundColor: null // 透明背景
        });
        
        const imgUrl = canvas.toDataURL('image/png');
        
        // 5. 显示结果
        const previewContainer = document.getElementById('capture-preview-container');
        previewContainer.innerHTML = '';
        const img = document.createElement('img');
        img.src = imgUrl;
        previewContainer.appendChild(img);
        
        // 设置下载按钮
        const downloadBtn = document.getElementById('download-capture-btn');
        if (downloadBtn) {
            downloadBtn.onclick = () => {
                const link = document.createElement('a');
                link.href = imgUrl;
                link.download = `uwu_chat_${new Date().getTime()}.png`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            };
        }

        document.getElementById('capture-result-modal').classList.add('visible');
        exitMultiSelectMode();
        
    } catch (error) {
        console.error('截图生成失败:', error);
        showToast('截图生成失败，请重试');
    } finally {
        document.body.removeChild(tempContainer);
    }
}

async function deleteSelectedMessages() {
    if (selectedMessageIds.size === 0) return;
    const deletedCount = selectedMessageIds.size;
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);

    // 收集需要一并删除的关联消息 ID（思维链 + 状态栏消息）
    const idsToDelete = new Set(selectedMessageIds);

    for (const msgId of selectedMessageIds) {
        const msgIndex = chat.history.findIndex(m => m.id === msgId);
        if (msgIndex === -1) continue;
        const msg = chat.history[msgIndex];

        // 1. 如果删除的是普通 assistant 消息，查找紧邻其前面的 isThinking 消息一并删除
        if (msg.role === 'assistant' && !msg.isThinking) {
            for (let i = msgIndex - 1; i >= 0; i--) {
                const prev = chat.history[i];
                // 找到紧邻的思维链消息（时间差在 30 秒内，属于同一轮对话）
                if (prev.isThinking && prev.role === 'assistant' && (msg.timestamp - prev.timestamp) < 30000) {
                    idsToDelete.add(prev.id);
                }
                // 遇到非 thinking 的 assistant 消息或 user 消息就停止向前搜索
                if (!prev.isThinking) break;
            }
            // 同时查找紧邻其后面的 isStatusUpdate 消息
            for (let i = msgIndex + 1; i < chat.history.length; i++) {
                const next = chat.history[i];
                if (next.isStatusUpdate && next.role === 'assistant' && (next.timestamp - msg.timestamp) < 5000) {
                    idsToDelete.add(next.id);
                }
                if (!next.isStatusUpdate && !next.isThinking) break;
            }
        }

        // 2. 如果删除的消息带有状态栏快照，清理 statusPanel.history 中对应的条目
        if (msg.isStatusUpdate && msg.statusSnapshot && chat.statusPanel && chat.statusPanel.history) {
            const msgContent = msg.content;
            chat.statusPanel.history = chat.statusPanel.history.filter(h => {
                // 通过 raw 内容匹配：如果状态栏历史的 raw 文本包含在被删消息中，则移除
                return !msgContent.includes(h.raw);
            });
            // 更新当前状态为最新的历史记录，或清空
            if (chat.statusPanel.history.length > 0) {
                chat.statusPanel.currentStatusHtml = chat.statusPanel.history[0].html;
                chat.statusPanel.currentStatusRaw = chat.statusPanel.history[0].raw;
            } else {
                chat.statusPanel.currentStatusHtml = '';
                chat.statusPanel.currentStatusRaw = '';
            }
        }
    }

    chat.history = chat.history.filter(m => !idsToDelete.has(m.id));
    await releaseSharedMessageAssets(idsToDelete);

    if (currentChatType === 'private') {
        recalculateChatStatus(chat);
    }

    await saveCurrentChat();
    currentPage = 1;
    renderMessages(false, true);
    renderChatList();
    exitMultiSelectMode();
    showToast(`已删除 ${deletedCount} 条消息`);
}

async function withdrawMessage(messageId) {
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat) return;

    const messageIndex = chat.history.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const message = chat.history[messageIndex];
    const messageTime = message.timestamp;
    const now = Date.now();

    if (now - messageTime > 2 * 60 * 1000) {
        showToast('超过2分钟的消息无法撤回');
        return;
    }

    message.isWithdrawn = true;

    const cleanContentMatch = message.content.match(/\[.*?的消息：([\s\S]+?)\]/);
    const cleanOriginalContent = cleanContentMatch ? cleanContentMatch[1] : message.content;
    message.originalContent = cleanOriginalContent; 

    const myName = (currentChatType === 'private') ? chat.myName : chat.me.nickname;

    message.content = `[${myName} 撤回了一条消息：${cleanOriginalContent}]`;

    if (currentChatType === 'private') {
        recalculateChatStatus(chat);
    }

    await saveCurrentChat();

    currentPage = 1;
    renderMessages(false, true);
    renderChatList();
    showToast('消息已撤回');
    triggerHapticFeedback('medium');
}

function openDeleteChunkModal() {
    const modal = document.getElementById('delete-chunk-modal');
    if(!modal.querySelector('[data-record-position]')) {
        const actions = document.createElement('div'); actions.className='record-position-actions'; actions.dataset.recordPosition='';
        for(const [label,suffix] of [['回顶','top-all'],['回底','bottom']]) {
            const button=document.createElement('button');button.className='action-sheet-button';button.textContent=label;
            button.onclick=()=>{
                const chat=MessageReference.getChat(db,currentChatType,currentChatId);
                const message=suffix==='top-all'?chat?.history?.[0]:chat?.history?.at(-1);
                modal.classList.remove('visible');
                if(!message || !MessageReference.locate(currentChatType,currentChatId,message.id)) showToast('没有可定位的消息');
            };actions.append(button);
        }
        document.getElementById('chat-room-history-search').after(actions);
        const editor=document.createElement('section');editor.dataset.recordEditor='';editor.hidden=true;
        const toggle=document.createElement('button');toggle.className='action-sheet-button';toggle.textContent='批量整理记录';toggle.setAttribute('aria-expanded','false');
        toggle.onclick=()=>{editor.hidden=!editor.hidden;toggle.setAttribute('aria-expanded',String(!editor.hidden));};
        actions.after(toggle,editor);
        for(const id of ['delete-chunk-range-info','delete-chunk-hidden-info','delete-chunk-form','delete-chunk-preview-box']) editor.append(document.getElementById(id));
        editor.append(document.getElementById('btn-block-range').parentElement);
    }
    modal.querySelector('[data-record-editor]').hidden=true;
    modal.querySelector('[aria-expanded]').setAttribute('aria-expanded','false');
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat || !chat.history || chat.history.length === 0) {
        showToast('当前没有聊天记录可管理');
        return;
    }
    const totalMessages = chat.history.length;
    const rangeInfo = document.getElementById('delete-chunk-range-info');
    rangeInfo.textContent = `当前聊天总消息数: ${totalMessages}`;
    
    // 计算并显示已隐藏的范围
    updateHiddenRangesInfo(chat);
    
    document.getElementById('delete-chunk-form').reset();
    document.getElementById('delete-chunk-preview-box').innerHTML = '<p style="color: #999; text-align: center; margin-top: 30px;">输入范围以预览内容</p>';
    
    document.getElementById('delete-chunk-modal').classList.add('visible');
}

function updateHiddenRangesInfo(chat) {
    const hiddenInfo = document.getElementById('delete-chunk-hidden-info');
    if (!hiddenInfo) return;

    if (!chat.history || chat.history.length === 0) {
        hiddenInfo.textContent = '';
        return;
    }

    const ranges = [];
    let start = -1;

    for (let i = 0; i < chat.history.length; i++) {
        const isHidden = chat.history[i].isContextDisabled;
        if (isHidden) {
            if (start === -1) start = i; // Start of a range
        } else {
            if (start !== -1) {
                // End of a range
                ranges.push(start === i - 1 ? `${start + 1}` : `${start + 1}-${i}`);
                start = -1;
            }
        }
    }
    // Handle case where range goes until the end
    if (start !== -1) {
        ranges.push(start === chat.history.length - 1 ? `${start + 1}` : `${start + 1}-${chat.history.length}`);
    }

    if (ranges.length > 0) {
        hiddenInfo.textContent = `当前已隐藏范围: ${ranges.join(', ')}`;
        hiddenInfo.style.display = 'block';
    } else {
        hiddenInfo.textContent = '';
        hiddenInfo.style.display = 'none';
    }
}

function generateRangePreview(chat, startIndex, endIndex) {
    const previewBox = document.getElementById('delete-chunk-preview-box');
    if (!previewBox) return;

    if (startIndex < 0 || endIndex > chat.history.length || startIndex >= endIndex) {
        previewBox.innerHTML = '<p style="color: #999; text-align: center; margin-top: 30px;">无效的范围</p>';
        return;
    }

    const messagesToPreview = chat.history.slice(startIndex, endIndex);
    const totalToPreview = messagesToPreview.length;
    let previewHtml = '';

    if (totalToPreview === 0) {
        previewBox.innerHTML = '<p style="color: #999; text-align: center; margin-top: 30px;">范围为空</p>';
        return;
    }

    const renderMsg = (msg) => {
        const contentMatch = msg.content.match(/\[.*?的消息：([\s\S]+)\]/);
        let text = contentMatch ? contentMatch[1] : msg.content;
        text = text.replace(/</g, '<').replace(/>/g, '>'); // Escape HTML
        const sender = msg.role === 'user' ? '我' : (chat.remarkName || chat.name || '对方');
        const status = msg.isContextDisabled ? ' <span style="color:red; font-size:10px;">(已隐藏)</span>' : '';
        return `<div style="margin-bottom:4px; padding-bottom:4px; border-bottom:1px solid #eee;">
            <span style="font-weight:600; color:#555;">${sender}</span>${status}: 
            <span style="color:#666;">${text.substring(0, 60)}${text.length > 60 ? '...' : ''}</span>
        </div>`;
    };

    if (totalToPreview <= 5) {
        previewHtml = messagesToPreview.map(renderMsg).join('');
    } else {
        const firstThree = messagesToPreview.slice(0, 3);
        const lastTwo = messagesToPreview.slice(-2);
        
        previewHtml = firstThree.map(renderMsg).join('') + 
                      `<div style="text-align: center; color: #999; margin: 8px 0; font-size: 10px;">... 共 ${totalToPreview} 条 ...</div>` + 
                      lastTwo.map(renderMsg).join('');
    }
    
    previewBox.innerHTML = previewHtml;
}

function setupDeleteHistoryChunk() {
    const deleteChunkModal = document.getElementById('delete-chunk-modal');
    const startInput = document.getElementById('delete-range-start');
    const endInput = document.getElementById('delete-range-end');
    
    // Real-time Preview Logic
    const updatePreview = () => {
        const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
        if (!chat) return;
        
        const s = parseInt(startInput.value);
        const e = parseInt(endInput.value);
        
        if (!isNaN(s) && !isNaN(e) && s > 0 && e >= s && e <= chat.history.length) {
            generateRangePreview(chat, s - 1, e);
        }
    };

    startInput.addEventListener('input', updatePreview);
    endInput.addEventListener('input', updatePreview);

    // Button Actions
    const btnBlock = document.getElementById('btn-block-range');
    const btnRestore = document.getElementById('btn-restore-range');
    const btnDelete = document.getElementById('btn-delete-range');
    
    const getRange = () => {
        const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
        const s = parseInt(startInput.value);
        const e = parseInt(endInput.value);
        if (!chat || isNaN(s) || isNaN(e) || s <= 0 || e < s || e > chat.history.length) {
            showToast('请输入有效的起止范围');
            return null;
        }
        return { chat, startIndex: s - 1, endIndex: e, count: e - s + 1 };
    };

    if (btnBlock) {
        btnBlock.addEventListener('click', async () => {
            const range = getRange();
            if (!range) return;
            
            let changedCount = 0;
            const modifiedIds = [];
            for (let i = range.startIndex; i < range.endIndex; i++) {
                if (!range.chat.history[i].isContextDisabled) {
                    range.chat.history[i].isContextDisabled = true;
                    modifiedIds.push(range.chat.history[i].id);
                    changedCount++;
                }
            }
            
            if (changedCount > 0) {
                await saveCurrentChat();
                showToast(`已屏蔽 ${changedCount} 条消息`);
                // Update DOM in-place
                modifiedIds.forEach(id => {
                    const el = document.querySelector(`.message-wrapper[data-id="${id}"]`);
                    if (el) el.classList.add('context-disabled');
                });
                updateHiddenRangesInfo(range.chat);
                generateRangePreview(range.chat, range.startIndex, range.endIndex);
            } else {
                showToast('选中范围内没有需要屏蔽的消息');
            }
        });
    }

    if (btnRestore) {
        btnRestore.addEventListener('click', async () => {
            const range = getRange();
            if (!range) return;
            
            let changedCount = 0;
            const modifiedIds = [];
            for (let i = range.startIndex; i < range.endIndex; i++) {
                const msg = range.chat.history[i];
                // 检查是否为思维链消息 (isThinking 标记或内容以 <thinking> 开头)
                const isThinkingMsg = msg.isThinking || (msg.content && typeof msg.content === 'string' && msg.content.trim().startsWith('<thinking>'));
                
                if (msg.isContextDisabled && !isThinkingMsg) {
                    msg.isContextDisabled = false;
                    modifiedIds.push(msg.id);
                    changedCount++;
                }
            }
            
            if (changedCount > 0) {
                await saveCurrentChat();
                showToast(`已恢复 ${changedCount} 条消息`);
                // Update DOM in-place
                modifiedIds.forEach(id => {
                    const el = document.querySelector(`.message-wrapper[data-id="${id}"]`);
                    if (el) el.classList.remove('context-disabled');
                });
                updateHiddenRangesInfo(range.chat);
                generateRangePreview(range.chat, range.startIndex, range.endIndex);
            } else {
                showToast('选中范围内没有被屏蔽的消息');
            }
        });
    }

    // Delete Logic (With Confirmation)
    const confirmDeleteModal = document.getElementById('delete-chunk-confirm-modal');
    const confirmDeleteBtn = document.getElementById('confirm-delete-chunk-btn');
    const cancelDeleteBtn = document.getElementById('cancel-delete-chunk-btn');
    
    let pendingDeleteRange = null;

    if (btnDelete) {
        btnDelete.addEventListener('click', () => {
            const range = getRange();
            if (range) {
                pendingDeleteRange = range;
                confirmDeleteModal.classList.add('visible');
            }
        });
    }

    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async () => {
            if (!pendingDeleteRange) return;
            
            const { chat, startIndex, count } = pendingDeleteRange;

            // 清理被删除消息中关联的状态栏历史
            if (currentChatType === 'private' && chat.statusPanel && chat.statusPanel.history) {
                const deletedMsgs = chat.history.slice(startIndex, startIndex + count);
                for (const msg of deletedMsgs) {
                    if (msg.isStatusUpdate && msg.statusSnapshot) {
                        chat.statusPanel.history = chat.statusPanel.history.filter(h => !msg.content.includes(h.raw));
                    }
                }
                if (chat.statusPanel.history.length > 0) {
                    chat.statusPanel.currentStatusHtml = chat.statusPanel.history[0].html;
                    chat.statusPanel.currentStatusRaw = chat.statusPanel.history[0].raw;
                } else {
                    chat.statusPanel.currentStatusHtml = '';
                    chat.statusPanel.currentStatusRaw = '';
                }
            }

            const deletedMessageIds = chat.history.slice(startIndex, startIndex + count).map(message => message.id).filter(Boolean);
            chat.history.splice(startIndex, count);
            await releaseSharedMessageAssets(deletedMessageIds);

            if (currentChatType === 'private') {
                recalculateChatStatus(chat);
            }

            await saveCurrentChat();
            confirmDeleteModal.classList.remove('visible');
            deleteChunkModal.classList.remove('visible');
            showToast(`已永久删除 ${count} 条消息`);
            
            currentPage = 1;
            renderMessages(false, true);
            renderChatList();
            
            pendingDeleteRange = null;
        });
    }

    if (cancelDeleteBtn) {
        cancelDeleteBtn.addEventListener('click', () => {
            confirmDeleteModal.classList.remove('visible');
            pendingDeleteRange = null;
        });
    }

    document.getElementById('close-delete-modal-btn').addEventListener('click', () => {
        deleteChunkModal.classList.remove('visible');
    });
}

// 重新计算并更新角色状态
function recalculateChatStatus(chat) {
    if (!chat || !chat.history) return;
    
    // 仅针对私聊且非群聊
    // 注意：虽然函数参数叫 chat，但在调用处需确保是 private 类型或者在这里判断
    // 由于群聊没有状态栏，这里主要针对 private
    // 但为了通用性，我们可以检查 chat.realName 是否存在
    
    if (!chat.realName) return; // 简单判断，群聊通常没有单人的 realName 用于状态更新（群聊逻辑不同）

    const updateStatusRegex = new RegExp(`\\[${chat.realName}更新状态为：(.*?)\\]`);
    let foundStatus = '在线'; // 默认状态

    // 倒序遍历历史记录
    for (let i = chat.history.length - 1; i >= 0; i--) {
        const msg = chat.history[i];
        // 忽略被撤回的消息
        if (msg.isWithdrawn) continue;

        const match = msg.content.match(updateStatusRegex);
        if (match) {
            foundStatus = match[1];
            break; // 找到最近的一个状态，停止遍历
        }
    }

    // 更新状态
    chat.status = foundStatus;
    
    // 如果当前正在该聊天室，实时更新 UI
    if (currentChatId === chat.id) {
        const statusTextEl = document.getElementById('chat-room-status-text');
        if (statusTextEl) {
            statusTextEl.textContent = foundStatus;
        }
    }
}

// 快捷插入文本功能
window.insertFormatText = function(textareaId, type) {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;
    
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    
    // 确定发送者身份名称
    let senderName = chat ? (chat.remarkName || chat.name || '角色') : '角色';
    
    // 如果是在新增消息面板，判断选择了谁
    const senderRoleRadio = document.querySelector('input[name="insert-sender-role"]:checked');
    if (textareaId === 'insert-message-textarea' && senderRoleRadio && senderRoleRadio.value === 'user') {
        senderName = (currentChatType === 'private') ? (chat.myName || '我') : (chat.me ? chat.me.nickname : '我');
    } else if (textareaId === 'message-edit-textarea') {
        // 如果是普通编辑面板，尝试从已有消息推断角色名，或者直接用默认角色名
        const currentMessageIndex = chat.history.findIndex(m => m.id === editingMessageId);
        if (currentMessageIndex !== -1) {
            const msg = chat.history[currentMessageIndex];
            if (msg.role === 'user') {
                senderName = (currentChatType === 'private') ? (chat.myName || '我') : (chat.me ? chat.me.nickname : '我');
            }
        }
    }

    // 提取当前输入框中已有的话（如果本身有带[]的前缀，就把前缀清理掉提取纯文本）
    let currentText = textarea.value.trim();
    if (currentText.match(/^\[.*?：([\s\S]*)\]$/)) {
        currentText = currentText.match(/^\[.*?：([\s\S]*)\]$/)[1].trim();
    } else if (currentText.match(/^\[(.*?)\]$/)) {
        // 对于有些没冒号但带括号的特殊情况
        currentText = currentText.match(/^\[(.*?)\]$/)[1].trim();
    }
    
    let template = '';
    let newCursorPos = -1;
    
    switch(type) {
        case 'voice':
            template = `[${senderName}的语音：${currentText}]`;
            newCursorPos = template.length - 1; // 光标留在 ] 前
            break;
        case 'quote':
            // 引用的话，原本的话当做回复内容，引用的内容需要用户去填
            template = `[${senderName}引用“”并回复：${currentText}]`;
            // 光标留在第一个 ” 里
            newCursorPos = template.indexOf('”');
            break;
        case 'visual':
            template = `[${senderName}发来的照片/视频：${currentText}]`;
            newCursorPos = template.length - 1;
            break;
    }
    
    if (template) {
        textarea.value = template;
        textarea.focus();
        if (newCursorPos !== -1) {
            textarea.setSelectionRange(newCursorPos, newCursorPos);
        }
    }
};

// 在当前编辑的消息下方插入新消息
function insertMessageBelow() {
    if (!editingMessageId) {
        showToast('无法获取当前编辑的消息');
        return;
    }

    // 显示自定义插入消息弹窗
    const insertModal = document.getElementById('insert-message-modal');
    const insertTextarea = document.getElementById('insert-message-textarea');
    
    if (!insertModal || !insertTextarea) {
        showToast('弹窗元素不存在，请刷新页面');
        return;
    }
    
    insertTextarea.value = '';
    
    // 初始化选择发送者的radio
    const currentMessageIndex = ((currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId))?.history.findIndex(m => m.id === editingMessageId);
    if (currentMessageIndex !== undefined && currentMessageIndex !== -1) {
        const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
        const currentMessage = chat.history[currentMessageIndex];
        const isCharMessage = currentMessage.role === 'char' || currentMessage.role === 'assistant';
        if (isCharMessage) {
            document.getElementById('insert-sender-char').checked = true;
        } else {
            document.getElementById('insert-sender-me').checked = true;
        }
    }
    
    insertModal.classList.add('visible');
    insertTextarea.focus();
}

// 确认插入新消息
async function confirmInsertMessage() {
    let newContent = document.getElementById('insert-message-textarea').value.trim();
    if (!newContent) {
        showToast('请输入消息内容');
        return;
    }

    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat) {
        showToast('无法获取聊天数据');
        return;
    }

    const currentMessageIndex = chat.history.findIndex(m => m.id === editingMessageId);
    if (currentMessageIndex === -1) {
        showToast('找不到当前消息');
        return;
    }

    const currentMessage = chat.history[currentMessageIndex];
    
    // 计算新消息的时间戳
    let newTimestamp;
    if (currentMessageIndex < chat.history.length - 1) {
        const nextMessage = chat.history[currentMessageIndex + 1];
        // 在当前消息和下一条消息之间插入（取中间时间）
        newTimestamp = Math.floor((currentMessage.timestamp + nextMessage.timestamp) / 2);
    } else {
        // 如果当前消息是最后一条，则在其后1分钟
        newTimestamp = currentMessage.timestamp + 60000;
    }

    // 获取选择的发送者身份
    const senderRole = document.querySelector('input[name="insert-sender-role"]:checked').value;
    const isCharMessage = senderRole === 'char';
    const myName = (currentChatType === 'private') ? (chat.myName || '我') : (chat.me ? chat.me.nickname : '我');
    const senderName = isCharMessage ? (chat.name || '角色') : myName;

    // 如果文本本身已经被 [] 包裹了(如用户使用了插入语音/引用格式), 就直接使用它，不再重复包裹
    // 但如果它是以 [xxx发送的xxx：开头这种特定格式就不重复包，否则还是包一下普通的
    let messageContent = newContent;
    if (!newContent.match(/^\[.*?\]$/)) {
        messageContent = `[${senderName}的消息：${newContent}]`;
    }

    const newMessage = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        content: messageContent,
        parts: [{type: 'text', text: messageContent}],
        timestamp: newTimestamp,
        role: isCharMessage ? 'assistant' : 'user',
        senderId: isCharMessage ? (currentMessage.senderId || chat.id) : 'user_me'
    };

    // 插入新消息到数组
    chat.history.splice(currentMessageIndex + 1, 0, newMessage);

    // 保存数据
    if (currentChatType === 'private') {
        recalculateChatStatus(chat);
    }

    await saveCurrentChat();
    currentPage = 1;
    renderMessages(false, true);
    renderChatList();

    // 关闭插入弹窗和编辑弹窗
    document.getElementById('insert-message-modal').classList.remove('visible');
    cancelMessageEdit();
    
    showToast('新消息已插入');
}

// 打开转发选择目标弹窗
function openForwardModal() {
    if (selectedMessageIds.size === 0) {
        showToast('请至少选择一条要转发的消息');
        return;
    }

    const modal = document.getElementById('forward-message-modal');
    const targetList = document.getElementById('forward-target-list');
    const searchInput = document.getElementById('forward-search-input');
    if (!modal || !targetList) return;

    // 获取所有联系人(角色)和群聊
    let allTargets = [];
    db.characters.forEach(c => {
        allTargets.push({
            id: c.id,
            type: 'private',
            name: c.remarkName || c.realName || c.name,
            avatar: c.avatar || 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg'
        });
    });
    db.groups.forEach(g => {
        allTargets.push({
            id: g.id,
            type: 'group',
            name: g.name,
            avatar: g.avatar || 'https://i.postimg.cc/mDMBh2R8/group-default.png'
        });
    });

    // 渲染列表函数
    const renderList = (targets) => {
        targetList.innerHTML = '';
        if (targets.length === 0) {
            targetList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">没有找到联系人</div>';
            return;
        }

        targets.forEach(target => {
            const li = document.createElement('li');
            li.style.display = 'flex';
            li.style.alignItems = 'center';
            li.style.padding = '10px';
            li.style.borderBottom = '1px solid #f0f0f0';
            li.style.cursor = 'pointer';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = `${target.type}:${target.id}`;
            checkbox.className = 'forward-target-checkbox';
            checkbox.style.marginRight = '10px';
            checkbox.style.width = '18px';
            checkbox.style.height = '18px';

            const avatar = document.createElement('img');
            avatar.src = target.avatar;
            avatar.className = 'squircle';
            avatar.style.width = '40px';
            avatar.style.height = '40px';
            avatar.style.marginRight = '10px';
            avatar.style.objectFit = 'cover';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = target.name;
            nameSpan.style.flex = '1';
            nameSpan.style.fontSize = '14px';
            nameSpan.style.fontWeight = '500';

            li.appendChild(checkbox);
            li.appendChild(avatar);
            li.appendChild(nameSpan);

            // 点击整行触发选中
            li.addEventListener('click', (e) => {
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                }
            });

            targetList.appendChild(li);
        });
    };

    renderList(allTargets);

    // 搜索功能
    if (searchInput) {
        searchInput.value = '';
        searchInput.oninput = () => {
            const keyword = searchInput.value.toLowerCase();
            const filtered = allTargets.filter(t => t.name.toLowerCase().includes(keyword));
            renderList(filtered);
        };
    }

    modal.classList.add('visible');

    // 绑定确认/取消按钮
    document.getElementById('confirm-forward-btn').onclick = confirmForwardMessages;
    document.getElementById('cancel-forward-btn').onclick = () => modal.classList.remove('visible');
}

// 确认转发消息
async function confirmForwardMessages() {
    const checkboxes = document.querySelectorAll('.forward-target-checkbox:checked');
    if (checkboxes.length === 0) {
        showToast('请至少选择一个转发目标');
        return;
    }

    // 获取当前聊天中选中的消息
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat || !chat.history) return;

    // 按时间顺序获取选中的消息内容
    const messagesToForward = chat.history
        .filter(m => selectedMessageIds.has(m.id))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    let forwardCount = 0;

    // 遍历选中的接收目标
    for (const cb of checkboxes) {
        const [targetType, targetId] = cb.value.split(':');
        const targetChat = (targetType === 'private') ? db.characters.find(c => c.id === targetId) : db.groups.find(g => g.id === targetId);
        
        if (!targetChat) continue;
        if (!targetChat.history) targetChat.history = [];

        // 获取用户在这个聊天里的名字
        const myName = (targetType === 'private') ? (targetChat.myName || '我') : (targetChat.me ? targetChat.me.nickname : '我');

        // 转发每条消息
        for (let i = 0; i < messagesToForward.length; i++) {
            const originalMsg = messagesToForward[i];
            let cleanText = '';

            // 提取纯文本内容，去掉原本的 [xxx的消息：...] 等
            if (typeof originalMsg.content === 'string') {
                const match = originalMsg.content.match(/^\[.*?：([\s\S]*?)\]$/);
                if (match && match[1]) {
                    cleanText = match[1].trim();
                } else {
                    // 如果不是标准格式，直接取原内容但需要稍微清理可能的括号
                    cleanText = originalMsg.content.replace(/^\[(.*?)\]$/, '$1').trim();
                }
            } else if (originalMsg.parts && originalMsg.parts.length > 0) {
                // 如果是复合消息(通常新版不会，但以防万一)
                cleanText = originalMsg.parts.map(p => p.text || '').join('');
                const match = cleanText.match(/^\[.*?：([\s\S]*?)\]$/);
                if (match && match[1]) cleanText = match[1].trim();
            }

            if (!cleanText) cleanText = "不支持转发的消息格式";

            const newContent = `[${myName}的消息：${cleanText}]`;
            
            // 为了保证时间戳递增，在当前时间基础上微加偏移
            const newTimestamp = Date.now() + i;

            const newMessage = {
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                role: 'user', // 转成用户发出的
                content: newContent,
                parts: [{type: 'text', text: newContent}],
                timestamp: newTimestamp,
                senderId: 'user_me'
            };

            targetChat.history.push(newMessage);
        }

        // 如果是私聊，更新一下状态
        if (targetType === 'private' && typeof recalculateChatStatus === 'function') {
            recalculateChatStatus(targetChat);
        }

        forwardCount++;
    }

    await saveCurrentChat();
    
    // 更新外层聊天列表显示
    if (typeof renderChatList === 'function') {
        renderChatList();
    }

    // 关闭弹窗和多选模式
    document.getElementById('forward-message-modal').classList.remove('visible');
    exitMultiSelectMode();

    showToast(`已成功转发 ${messagesToForward.length} 条消息给 ${forwardCount} 个联系人`);
}

// 供外部调用
window.openForwardModal = openForwardModal;
