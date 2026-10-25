// --- 聊天记录搜索模块 ---

const SearchSystem = {
    currentScope: 'all',
    currentResults: [],
    searchTimer: null,

    init() {
        document.getElementById('search-scope-select')?.addEventListener('click', () => this.openScopeModal());
        ['search-ignore-status', 'search-type-filter', 'search-sender-filter', 'search-date-from', 'search-date-to'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.performSearch());
        });
        const input = document.getElementById('search-history-input');
        if (input) {
            input.addEventListener('input', () => {
                if (this.searchTimer) clearTimeout(this.searchTimer);
                this.searchTimer = setTimeout(() => this.performSearch(), 300);
            });
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    this.performSearch();
                    input.blur();
                }
            });
        }
        document.getElementById('search-cancel-btn')?.addEventListener('click', () => this.closeSearchScreen());
        const modal = document.getElementById('search-scope-modal');
        modal?.addEventListener('click', event => {
            if (event.target === modal) modal.classList.remove('visible');
        });
    },

    open() {
        this.currentScope = 'all';
        this.updateScopeUI();
        const defaults = {
            'search-history-input': '',
            'search-type-filter': 'all',
            'search-sender-filter': 'all',
            'search-date-from': '',
            'search-date-to': '',
        };
        Object.entries(defaults).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.value = value;
        });
        this.renderPlaceholder();
        switchScreen('search-history-screen');
        setTimeout(() => document.getElementById('search-history-input')?.focus(), 100);
    },

    renderPlaceholder() {
        const container = document.getElementById('search-results-container');
        if (!container) return;
        container.innerHTML = `<div class="search-placeholder">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <p>搜索过去的聊天记录</p>
            <p style="font-size:12px; margin-top:5px;">可按关键词、日期、发送者或消息类型筛选</p>
        </div>`;
    },

    closeSearchScreen() { switchScreen('more-screen'); },

    getFilters(keyword) {
        return {
            keyword: keyword == null ? (document.getElementById('search-history-input')?.value || '').trim() : keyword,
            type: document.getElementById('search-type-filter')?.value || 'all',
            sender: document.getElementById('search-sender-filter')?.value || 'all',
            dateFrom: document.getElementById('search-date-from')?.value || '',
            dateTo: document.getElementById('search-date-to')?.value || '',
        };
    },

    hasCriteria(filters) {
        return !!(filters.keyword || filters.type !== 'all' || filters.sender !== 'all' || filters.dateFrom || filters.dateTo);
    },

    cleanStatus(message, enabled, fallbackRegex) {
        if (!enabled || typeof message.content !== 'string') return message;
        let regex = fallbackRegex;
        if (message.statusSnapshot?.regex) {
            try { regex = new RegExp(message.statusSnapshot.regex, 'g'); }
            catch (error) { console.error('Invalid snapshot regex:', error); }
        }
        return regex ? { ...message, content: message.content.replace(regex, '') } : message;
    },

    performSearch(keyword) {
        const container = document.getElementById('search-results-container');
        if (!container || !window.MessageReference) return;
        const filters = this.getFilters(keyword);
        if (!this.hasCriteria(filters)) {
            this.renderPlaceholder();
            return;
        }
        if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
            container.innerHTML = '<div class="search-placeholder"><p>开始日期不能晚于结束日期</p></div>';
            return;
        }
        const ignoreStatus = !!document.getElementById('search-ignore-status')?.checked;
        let targets = [];
        if (this.currentScope === 'all') {
            targets = [
                ...(db.characters || []).map(chat => ({ ...chat, type: 'private' })),
                ...(db.groups || []).map(chat => ({ ...chat, type: 'group' })),
            ];
        } else {
            const character = (db.characters || []).find(chat => chat.id === this.currentScope);
            const group = (db.groups || []).find(chat => chat.id === this.currentScope);
            if (character) targets.push({ ...character, type: 'private' });
            else if (group) targets.push({ ...group, type: 'group' });
        }

        const results = [];
        let totalCount = 0;
        targets.forEach(chat => {
            let statusRegex = null;
            if (ignoreStatus && chat.type === 'private' && chat.statusPanel?.regexPattern) {
                try { statusRegex = new RegExp(chat.statusPanel.regexPattern, 'g'); }
                catch (error) { console.error('Invalid status regex:', error); }
            }
            const messages = (chat.history || []).filter(message => {
                if (ignoreStatus && message.isStatusUpdate) return false;
                return window.MessageReference.matches(this.cleanStatus(message, ignoreStatus, statusRegex), filters);
            }).map(message => {
                const cleaned = this.cleanStatus(message, ignoreStatus, statusRegex);
                const parsed = window.MessageReference.parseContent(window.MessageReference.extractText(cleaned));
                const type = window.MessageReference.classify(message);
                const original = message.transcriptOriginal || parsed.original || '';
                const translation = message.translation || parsed.translation || '';
                return {
                    ...message,
                    searchOriginal: original || `[${window.MessageReference.TYPE_LABELS[type] || '消息'}]`,
                    searchTranslation: translation,
                    searchType: type,
                    senderName: window.MessageReference.getSenderName(chat.type, chat, message),
                };
            }).sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));
            if (!messages.length) return;
            const name = chat.type === 'private' ? (chat.remarkName || chat.name) : chat.name;
            results.push({ chatId: chat.id, chatType: chat.type, name: name || '未命名聊天', avatar: chat.avatar || '', count: messages.length, messages });
            totalCount += messages.length;
        });
        results.sort((left, right) => right.count - left.count);
        this.currentResults = results;
        if (!totalCount) {
            container.innerHTML = '<div class="search-placeholder"><p>未找到符合条件的聊天记录</p></div>';
            return;
        }
        if (this.currentScope === 'all') this.renderOverview(results, totalCount, filters.keyword);
        else this.renderDetail(results[0], filters.keyword, true);
    },

    renderOverview(results, totalCount, keyword) {
        const container = document.getElementById('search-results-container');
        container.innerHTML = '';
        const header = document.createElement('div');
        header.className = 'search-stat-header';
        header.innerHTML = `共找到 <strong>${totalCount}</strong> 条符合条件的记录`;
        container.appendChild(header);
        const list = document.createElement('div');
        list.className = 'search-group-list';
        results.forEach(group => {
            const item = document.createElement('div');
            item.className = 'search-group-item';
            item.innerHTML = `${group.avatar ? `<img src="${this.escapeHtml(group.avatar)}" class="search-group-avatar" alt="avatar">` : '<div class="search-group-avatar"></div>'}
                <div class="search-group-info"><div class="search-group-name"><span>${this.escapeHtml(group.name)}</span><span class="search-group-count">${group.count}条</span></div>
                <div class="search-group-preview">${this.escapeHtml(group.messages[0].searchOriginal)}</div></div>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ccc" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
            item.addEventListener('click', () => this.renderDetail(group, keyword));
            list.appendChild(item);
        });
        container.appendChild(list);
    },

    renderDetail(group, keyword, isDirectMode = false) {
        if (!group) return;
        const container = document.getElementById('search-results-container');
        container.innerHTML = '';
        const header = document.createElement('div');
        header.className = 'search-detail-header';
        header.innerHTML = `${isDirectMode ? '' : '<button class="search-back-btn">‹</button>'}<div class="search-detail-title">${this.escapeHtml(group.name)} (${group.count}条)</div>`;
        header.querySelector('.search-back-btn')?.addEventListener('click', () => this.performSearch());
        container.appendChild(header);
        const list = document.createElement('div');
        list.className = 'search-result-list';
        group.messages.forEach(message => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            const date = new Date(message.timestamp);
            const time = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
            const translation = message.searchTranslation
                ? `<div class="search-result-translation">译：${this.highlightKeyword(message.searchTranslation, keyword)}</div>`
                : '';
            item.innerHTML = `<div class="search-result-header"><span class="search-result-name">${this.escapeHtml(message.senderName)}</span>
                <span class="search-result-type">${this.escapeHtml(window.MessageReference.TYPE_LABELS[message.searchType] || '消息')}</span><span class="search-result-time">${time}</span></div>
                <div class="search-result-content">${this.highlightKeyword(message.searchOriginal, keyword)}</div>${translation}`;
            item.addEventListener('click', () => {
                if (!window.MessageReference.locate(group.chatType, group.chatId, message.id)) showToast('该消息已不存在');
            });
            list.appendChild(item);
        });
        container.appendChild(list);
    },

    highlightKeyword(content, keyword) {
        const safeContent = this.escapeHtml(content || '');
        if (!keyword) return safeContent;
        const escapedPattern = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return safeContent.replace(new RegExp(`(${escapedPattern})`, 'gi'), '<span class="keyword-highlight">$1</span>');
    },

    openScopeModal() {
        const modal = document.getElementById('search-scope-modal');
        const list = document.getElementById('search-scope-list');
        if (!modal || !list) return;
        list.innerHTML = '';
        this.createScopeItem(list, 'all', '全部范围', '', this.currentScope === 'all');
        (db.characters || []).forEach(chat => this.createScopeItem(list, chat.id, chat.remarkName || chat.name, chat.avatar, this.currentScope === chat.id));
        (db.groups || []).forEach(chat => this.createScopeItem(list, chat.id, chat.name, chat.avatar, this.currentScope === chat.id));
        modal.classList.add('visible');
    },

    createScopeItem(container, id, name, avatar, selected) {
        const item = document.createElement('div');
        item.className = `scope-item ${selected ? 'selected' : ''}`;
        item.innerHTML = `${id === 'all' ? '<div class="scope-avatar scope-all">ALL</div>' : `<img src="${this.escapeHtml(avatar || '')}" class="scope-avatar" alt="avatar">`}
            <span style="flex:1;">${this.escapeHtml(name || '未命名')}</span>${selected ? '<span style="color:var(--primary-color);">✔</span>' : ''}`;
        item.addEventListener('click', () => {
            this.currentScope = id;
            this.updateScopeUI();
            document.getElementById('search-scope-modal')?.classList.remove('visible');
            if (this.hasCriteria(this.getFilters())) this.performSearch();
        });
        container.appendChild(item);
    },

    updateScopeUI() {
        const label = document.querySelector('#search-scope-select span');
        if (!label) return;
        if (this.currentScope === 'all') label.textContent = '搜索范围：全部';
        else {
            const target = (db.characters || []).find(chat => chat.id === this.currentScope) || (db.groups || []).find(chat => chat.id === this.currentScope);
            label.textContent = `搜索范围：${target ? (target.remarkName || target.name) : '未知'}`;
        }
    },

    escapeHtml(text) {
        return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    },
};

window.SearchSystem = SearchSystem;
