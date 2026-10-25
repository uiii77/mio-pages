// --- 消息渲染模块 ---

// NovelAI 自动生图队列（避免同时发出大量请求）
const _naiAutoGenQueue = [];
let _naiAutoGenRunning = false;
// 标记：仅新消息触发自动生图，历史消息加载时不触发
let _naiAutoGenNewMsgIds = new Set();
function appendChatBubble(container, bubble) {
    const previous = container.lastElementChild;
    if (bubble.classList.contains('debug-thought-visible') && previous?.classList.contains('debug-thought-visible')) {
        const previousRequestId = previous.dataset.replyRequestId;
        const nextRequestId = bubble.dataset.replyRequestId;
        const previousTime = Number(previous.dataset.debugTimestamp);
        const nextTime = Number(bubble.dataset.debugTimestamp);
        const sameReply = previousRequestId && nextRequestId
            ? previousRequestId === nextRequestId
            : previousTime > 0 && nextTime > 0 && Math.abs(nextTime - previousTime) < 60000;
        const previousBody = previous.querySelector('.debug-thought-body');
        const nextBody = bubble.querySelector('.debug-thought-body');
        if (sameReply && previousBody && nextBody) {
            while (nextBody.firstChild) previousBody.appendChild(nextBody.firstChild);
            previous.dataset.debugTimestamp = bubble.dataset.debugTimestamp;
            return previous;
        }
    }
    container.appendChild(bubble);
    return bubble;
}
async function _naiAutoGenProcess() {
    if (_naiAutoGenRunning) return;
    _naiAutoGenRunning = true;
    while (_naiAutoGenQueue.length > 0) {
        const task = _naiAutoGenQueue.shift();
        try {
            await task();
        } catch (e) {
            console.error('[NovelAI AutoGen Queue] 任务出错:', e);
        }
    }
    _naiAutoGenRunning = false;
}

// 根据时间戳格式设置生成时间字符串
function formatTimestampByFormat(timestamp, chat) {
    const d = new Date(timestamp);
    const fmt = chat.timestampFormat || 'hm';
    if (fmt === 'hms') {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    if (fmt === 'ymd') {
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    }
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getDisplayMessageHistory(chat, chatType = currentChatType) {
    if (!chat || !Array.isArray(chat.history)) return [];
    // 节点系统：过滤掉已收纳节点的消息
    let displayHistory = chat.history;
    if (chatType === 'private' && chat.nodes && !ChatHistoryViewport.rangeFor(chat.id, chatType)?.includeArchived) {
        const archivedNodeIds = new Set(chat.nodes.filter(n => n.status === 'archived').map(n => n.id));
        if (archivedNodeIds.size > 0) {
            let currentArchivedNodeId = null;
            displayHistory = chat.history.filter(m => {
                // 如果消息本身带有 nodeId 且该节点已被收纳，直接过滤掉（包括 start 和 end 边界消息）
                if (m.nodeId && archivedNodeIds.has(m.nodeId)) {
                    return false;
                }
                
                // 兼容旧逻辑：处理没有 nodeId 的普通消息，通过 start/end 边界来判断
                if (m.isNodeBoundary) {
                    if (m.nodeAction === 'start' && archivedNodeIds.has(m.nodeId)) {
                        currentArchivedNodeId = m.nodeId;
                        return false;
                    }
                    if (m.nodeAction === 'end' && m.nodeId === currentArchivedNodeId) {
                        currentArchivedNodeId = null;
                        return false;
                    }
                }
                if (currentArchivedNodeId) return false;
                return true;
            });
        }
    }
    if (chatType === 'private' && !chat.momentsSettings?.showActivityNarration) displayHistory = displayHistory.filter(message => !message.isMomentsActivity);
    return displayHistory;
}

function renderMessages(isLoadMore = false, forceScrollToBottom = false) {
    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    if (!chat || !chat.history) return;
    if (forceScrollToBottom && ChatHistoryViewport.rangeFor(chat.id, currentChatType)) {
        ChatHistoryViewport.reset(); currentPage = 1;
    }
    const oldScrollHeight = messageArea.scrollHeight;
    const displayHistory = getDisplayMessageHistory(chat, currentChatType);

    const totalMessages = displayHistory.length;
    
    // 确保 MESSAGES_PER_PAGE 存在
    const pageSize = (typeof MESSAGES_PER_PAGE !== 'undefined') ? MESSAGES_PER_PAGE : 20;

    const view = ChatHistoryViewport.rangeFor(chat.id, currentChatType);
    if (view && view.page !== currentPage) {
        view.end = Math.max(0, totalMessages-(currentPage-1)*pageSize);
        view.start = Math.max(0, view.end-pageSize); view.page = currentPage;
    }
    const end = view ? Math.min(totalMessages, view.end) : totalMessages - (currentPage - 1) * pageSize;
    const start = view ? view.start : Math.max(0, end - pageSize);
    const messagesToRender = displayHistory.slice(start, end);
    if (!isLoadMore) messageArea.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    let lastMsgTime = 0;
    
    if (start > 0) {
        lastMsgTime = displayHistory[start - 1].timestamp;
    }

    messagesToRender.forEach((msg, index) => {
        const currentMsgTime = msg.timestamp;
        const timeDiff = currentMsgTime - lastMsgTime;
        const isSameDay = new Date(currentMsgTime).toDateString() === new Date(lastMsgTime).toDateString();
        
        if (timeDiff > 10 * 60 * 1000 || !isSameDay || lastMsgTime === 0) {
            const timeDivider = document.createElement('div');
            timeDivider.className = 'message-wrapper system-notification time-divider'; 
            
            const timeText = formatTimeDivider(currentMsgTime);
            
            timeDivider.innerHTML = `<div class="system-notification-bubble" style="background-color: transparent; color: #999; font-size: 12px; padding: 2px 8px;">${timeText}</div>`;
            fragment.appendChild(timeDivider);
        }
        lastMsgTime = currentMsgTime;

        let isContinuous = false;
        
        let invisibleRegex;
        if (chat.showStatusUpdateMsg) {
            invisibleRegex = /\[.*?(?:接收|退回).*?的转账\]|\[.*?(?:接收|退还).*?的亲属卡\]|\[.*?(?:冻结|解冻|收回)了(?:给.*?的)?亲属卡\]|\[.*?调整(?:给.*?的)?亲属卡额度为：.*?\]|\[.*?已接收礼物\]|\[system:.*?\]|\[.*?邀请.*?加入了群聊\]|\[.*?修改群名为：.*?\]|\[system-display:.*?\]|\[.*?同意了.*?的代付请求\]|\[.*?拒绝了.*?的代付请求\]|\[avatar-action:.*?\]|<thinking>[\s\S]*?<\/thinking>|^<thinking>[\s\S]*/;
        } else {
            invisibleRegex = /\[.*?(?:接收|退回).*?的转账\]|\[.*?(?:接收|退还).*?的亲属卡\]|\[.*?(?:冻结|解冻|收回)了(?:给.*?的)?亲属卡\]|\[.*?调整(?:给.*?的)?亲属卡额度为：.*?\]|\[.*?更新状态为：.*?\]|\[.*?已接收礼物\]|\[system:.*?\]|\[.*?邀请.*?加入了群聊\]|\[.*?修改群名为：.*?\]|\[system-display:.*?\]|\[.*?同意了.*?的代付请求\]|\[.*?拒绝了.*?的代付请求\]|\[avatar-action:.*?\]|<thinking>[\s\S]*?<\/thinking>|^<thinking>[\s\S]*/;
        }

        const isSystemMsg = /\[system:.*?\]|\[system-display:.*?\]/.test(msg.content) || msg.isNodeBoundary || msg.type === 'poke';
        
        if (!isSystemMsg) {
            let prevMsg = null;
            let currentIndexInHistory = start + index;
            
            for (let i = currentIndexInHistory - 1; i >= 0; i--) {
                const candidate = displayHistory[i];
                // 跳过隐藏的上下文消息（如角色自知消息），不影响连续消息判断
                if (candidate.hiddenFromDisplay || candidate.isNodeBoundary || candidate.type === 'poke') continue;
                if (!invisibleRegex.test(candidate.content)) {
                    prevMsg = candidate;
                    break;
                }
            }

            if (prevMsg) {
                const currentSender = msg.role === 'user' ? 'user' : (msg.senderId || 'assistant');
                const prevSender = prevMsg.role === 'user' ? 'user' : (prevMsg.senderId || 'assistant');
                
                const timeGap = msg.timestamp - prevMsg.timestamp;
                const isTimeClose = timeGap < 10 * 60 * 1000;

                if (currentSender === prevSender && isTimeClose) {
                    isContinuous = true;
                }
            }
        }

        // Historical inspection must not let legacy renderer defaults rewrite the source message.
        const historyInspection = !!view || !!window._pendingMessageLocation;
        const bubble = createMessageBubbleElement(historyInspection ? {...msg} : msg, isContinuous, {historyInspection});
        if (bubble) {
            bubble.dataset.historyIndex = String(start + index);
            bindQuotedMessageNavigation(bubble, msg, currentChatId, currentChatType);
            appendChatBubble(fragment, bubble);
            
            // 节点系统：渲染独立摘要
            if (msg.nodeSummary) {
                // 判断是否是连续带有相同摘要的最后一条消息
                let isLastSummaryMsg = true;
                let currentIndexInHistory = start + index;
                
                // 往后找下一条可见消息
                for (let i = currentIndexInHistory + 1; i < displayHistory.length; i++) {
                    const nextMsg = displayHistory[i];
                    // 跳过隐藏消息
                    if (nextMsg.hiddenFromDisplay || nextMsg.isNodeBoundary || (nextMsg.isThinking && nextMsg.thinkingDisplay !== 'summary' && nextMsg.thinkingDisplay !== 'detail')) continue;
                    
                    // 如果下一条消息是同一个发送者，且带有相同的摘要，则当前消息不是最后一条
                    const currentSender = msg.role === 'user' ? 'user' : (msg.senderId || 'assistant');
                    const nextSender = nextMsg.role === 'user' ? 'user' : (nextMsg.senderId || 'assistant');
                    
                    if (currentSender === nextSender && nextMsg.nodeSummary === msg.nodeSummary) {
                        isLastSummaryMsg = false;
                    }
                    break; // 只看下一条可见消息
                }

                if (isLastSummaryMsg) {
                    const summaryText = db.nodeSummaryText || '摘要';
                    const summaryWrapper = document.createElement('div');
                    const roleClass = msg.role === 'user' ? 'sent' : 'received';
                    summaryWrapper.className = `message-wrapper system-notification independent-summary-wrapper ${roleClass}`;
                    summaryWrapper.style.margin = '10px 0';
                    
                    const summaryEl = document.createElement('div');
                    summaryEl.className = 'node-summary-container independent-summary';
                    summaryEl.style.maxWidth = '90%';
                    
                    summaryEl.innerHTML = `
                        <div class="node-summary-toggle">
                            <span class="node-summary-star spin">☆</span>
                            <span>${DOMPurify.sanitize(summaryText)}</span>
                        </div>
                        <div class="node-summary-content" style="display:none;">${DOMPurify.sanitize(msg.nodeSummary)}</div>
                    `;
                    summaryEl.querySelector('.node-summary-toggle').addEventListener('click', () => {
                        const content = summaryEl.querySelector('.node-summary-content');
                        content.style.display = content.style.display === 'none' ? 'block' : 'none';
                    });
                    
                    summaryWrapper.appendChild(summaryEl);
                    fragment.appendChild(summaryWrapper);
                }
            }
        }
    });
    const existingLoadBtn = document.getElementById('load-more-btn');
    if (existingLoadBtn) existingLoadBtn.remove();
    const existingLoadNewerBtn = document.getElementById('load-newer-btn');
    if (existingLoadNewerBtn) existingLoadNewerBtn.remove();
    messageArea.prepend(fragment);
    
    if (start > 0) {
        const loadMoreButton = document.createElement('button');
        loadMoreButton.id = 'load-more-btn';
        loadMoreButton.className = 'load-more-btn';
        loadMoreButton.textContent = '加载更早的消息';
        messageArea.prepend(loadMoreButton);
    }
    // 当不在最新页时，显示"加载更新的消息"按钮
    if (view ? end < totalMessages : currentPage > 1) {
        const loadNewerButton = document.createElement('button');
        loadNewerButton.id = 'load-newer-btn';
        loadNewerButton.className = 'load-more-btn';
        loadNewerButton.textContent = '加载更新的消息';
        messageArea.appendChild(loadNewerButton);
    }
    if (forceScrollToBottom) {
        setTimeout(() => {
            if (currentChatId === chat.id && !ChatHistoryViewport.rangeFor(chat.id, currentChatType)) messageArea.scrollTop = messageArea.scrollHeight;
        }, 0);
    } else if (isLoadMore) {
        // 临时禁用平滑滚动以防止位置跳动
        messageArea.style.scrollBehavior = 'auto';
        messageArea.scrollTop = messageArea.scrollHeight - oldScrollHeight;
        // 恢复平滑滚动 (使用 setTimeout 确保渲染周期完成)
        setTimeout(() => {
            messageArea.style.scrollBehavior = '';
        }, 0);
    }
}

function loadMoreMessages() {
    if (ChatHistoryViewport.move(-1)) return;
    currentPage++;
    renderMessages(true, false);
}

function loadNewerMessages() {
    if (ChatHistoryViewport.move(1)) return;
    if (currentPage > 1) {
        currentPage--;
        renderMessages(false, false);
        // 滚动到顶部以便用户从上往下阅读
        const area = document.getElementById('message-area');
        if (area) area.scrollTop = 0;
    }
}

// Temporary display ranges belong to the renderer; historical messages are never rewritten.
const ChatHistoryViewport = window.ChatHistoryViewport = {
    range: null,
    generation: 0,
    reset() { this.range = null; this.generation++; },
    rangeFor(id, type) { return this.range?.chatId === id && this.range.chatType === type ? this.range : null; },
    capture() {
        if (!document.getElementById('chat-room-screen')?.classList.contains('active')) return null;
        const chat = MessageReference.getChat(db, currentChatType, currentChatId);
        if (!chat) return null;
        messageArea.scrollTo({top: messageArea.scrollTop, behavior:'instant'});
        const top = messageArea.getBoundingClientRect().top;
        const nodes = [...messageArea.querySelectorAll('.message-wrapper[data-history-index]')];
        const node = nodes.find(el => el.getBoundingClientRect().bottom > top);
        const history = getDisplayMessageHistory(chat, currentChatType);
        const message = node && history[Number(node.dataset.historyIndex)];
        return {chatId: chat.id, chatType: currentChatType, messageId: message?.id ?? null, offset: node ? node.getBoundingClientRect().top-top : 0, includeArchived: !!this.range?.includeArchived, firstId: history[Number(nodes[0]?.dataset.historyIndex)]?.id, lastId: history[Number(nodes.at(-1)?.dataset.historyIndex)]?.id};
    },
    locate(type, id, messageId, offset, bounds) {
        const resolved = MessageReference.resolve(type, id, messageId, db);
        if (!resolved || currentChatId !== resolved.chat.id || currentChatType !== type) return false;
        this.range = {chatId: resolved.chat.id, chatType: type, start: 0, end: 0, includeArchived: !!bounds?.includeArchived};
        let history = getDisplayMessageHistory(resolved.chat, type), index = history.indexOf(resolved.message);
        if (index < 0) { this.range.includeArchived = true; history = getDisplayMessageHistory(resolved.chat, type); index = history.indexOf(resolved.message); }
        if (index < 0) { this.reset(); return false; }
        this.range.start = Math.max(0, index-25); this.range.end = Math.min(history.length, index+26);
        if (bounds) {
            const first = history.findIndex(message => message.id === bounds.firstId), last = history.findIndex(message => message.id === bounds.lastId);
            if (first >= 0 && first <= index && last >= index) { this.range.start = first; this.range.end = last+1; }
        }
        currentPage = Math.max(1, Math.ceil((history.length-index)/MESSAGES_PER_PAGE));
        this.range.page = currentPage;
        renderMessages(false, false);
        const element = [...messageArea.querySelectorAll('.message-wrapper[data-history-index]')].find(node => Number(node.dataset.historyIndex) === index);
        if (!element) { this.reset(); renderMessages(false, false); return false; }
        const generation = ++this.generation;
        const align = () => {
            if (this.generation !== generation || !element.isConnected) return;
            if (offset == null) element.scrollIntoView({block:'center', behavior:'instant'});
            else messageArea.scrollTo({top:messageArea.scrollTop+element.getBoundingClientRect().top-messageArea.getBoundingClientRect().top-offset,behavior:'instant'});
        };
        align(); requestAnimationFrame(align);
        element.querySelectorAll('img').forEach(img => img.addEventListener('load', align, {once:true}));
        element.classList.add('message-locate-highlight');
        setTimeout(() => element.classList.remove('message-locate-highlight'),2200);
        return true;
    },
    restore(anchor) {
        if (!anchor) return;
        if (currentChatId !== anchor.chatId || currentChatType !== anchor.chatType) openChatRoom(anchor.chatId,anchor.chatType);
        if (anchor.messageId != null) this.locate(anchor.chatType,anchor.chatId,anchor.messageId,anchor.offset,anchor);
    },
    move(direction) {
        const view = this.rangeFor(currentChatId,currentChatType);
        if (!view) return false;
        const history = getDisplayMessageHistory(MessageReference.getChat(db,currentChatType,currentChatId),currentChatType);
        const anchor = this.capture();
        if (direction < 0) { view.start = Math.max(0,view.start-MESSAGES_PER_PAGE); view.end = Math.min(view.end,view.start+200); }
        else { view.end = Math.min(history.length,view.end+MESSAGES_PER_PAGE); view.start = Math.max(view.start,view.end-200); }
        currentPage = view.page = Math.max(1,Math.ceil((history.length-view.end+1)/MESSAGES_PER_PAGE));
        renderMessages(false,false);
        const target = history.findIndex(message => message.id === anchor?.messageId);
        const node = [...messageArea.querySelectorAll('[data-history-index]')].find(el => Number(el.dataset.historyIndex)===target);
        if (node) messageArea.scrollTo({top:messageArea.scrollTop+node.getBoundingClientRect().top-messageArea.getBoundingClientRect().top-anchor.offset,behavior:'instant'});
        else messageArea.scrollTop = direction < 0 ? 0 : messageArea.scrollHeight;
        return true;
    }
};

function bindQuotedMessageNavigation(bubble, msg, chatId, chatType) {
    if (!bubble) return;
    bubble.querySelectorAll('.quoted-message').forEach(quote => {
        quote.tabIndex = 0;
        quote.setAttribute('role', 'button');
        quote.setAttribute('aria-label', '查看引用的原消息');
        const jump = event => {
            if (isInMultiSelectMode) return;
            event.preventDefault(); event.stopPropagation();
            if (!MessageReference.locate(chatType, chatId, msg.quote?.messageId ?? msg.quote?.id)) showToast('引用的原消息已不存在');
        };
        quote.addEventListener('click', jump);
        quote.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') jump(event); });
    });
}
