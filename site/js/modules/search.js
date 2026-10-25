// One local search surface for the chat list, current conversation and original-message navigation.
const SearchSystem = {
    currentScope: 'all', currentResults: [], searchTimer: null, generation: 0,
    showing: false, origin: null, returnScreen: 'chat-list-screen', detailGroup: null, navigation: null,
    sessionKey: 'mio-chat-history-view',
    init() {
        if (this.initialized) return;
        this.initialized = true;
        this.panel = document.getElementById('search-history-screen');
        this.home = this.panel.parentElement;
        document.getElementById('chat-list-history-search').onclick = () => this.open();
        document.getElementById('chat-room-history-search').onclick = () => this.open({chatType:currentChatType,chatId:currentChatId});
        document.getElementById('search-scope-select').onclick = () => this.openScopeModal();
        ['search-ignore-status','search-type-filter','search-sender-filter','search-date-from','search-date-to'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => { this.detailGroup = null; this.resultLimit = 50; void this.performSearch(); });
        });
        const tools = document.createElement('div'); tools.className = 'search-history-tools';
        const media = document.createElement('div'); media.className = 'search-media-tabs'; media.setAttribute('aria-label','历史消息分类');
        for (const [value,label] of [['all','全部'],['image','图片'],['video','视频'],['audio','语音'],['file','文件']]) {
            const button = this.button(label, () => { document.getElementById('search-type-filter').value = value; void this.performSearch(); });
            button.dataset.type = value; media.append(button);
        }
        const date = document.createElement('label'); date.className = 'search-date-jump'; date.textContent = '按日期查找';
        const input = document.createElement('input'); input.type = 'date'; input.id = 'search-jump-date'; input.setAttribute('aria-label','定位日期');
        date.append(input, this.button('定位', () => this.jumpDate())); tools.append(media,date);
        this.panel.insertBefore(tools,document.querySelector('.search-advanced-filters'));
        const audioOption = new Option('全部语音','audio'); document.getElementById('search-type-filter').append(audioOption);
        const search = document.getElementById('search-history-input');
        search.addEventListener('input', () => { clearTimeout(this.searchTimer); this.generation++; this.resultLimit=50; this.detailGroup=null; this.searchTimer = setTimeout(() => this.performSearch(),220); });
        search.addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(this.searchTimer); void this.performSearch(); search.blur(); } });
        document.getElementById('search-cancel-btn').onclick = () => this.closeSearchScreen();
        document.getElementById('search-scope-modal').addEventListener('click', event => { if (event.target.id === 'search-scope-modal') event.target.classList.remove('visible'); });
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.showing) this.closeSearchScreen(); });
        document.querySelector('#chat-room-header-default .back-btn').addEventListener('click',event=>{if(this.showing){event.preventDefault();event.stopImmediatePropagation();this.closeSearchScreen();}else if(this.navigation){this.navigation=null;this.hideNavigation();this.clearSession();}},true);
        this.panel.addEventListener('scroll', () => this.persist(), true);
        setTimeout(() => this.restoreSession(),0);
    },
    button(text, action) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.onclick = action; return button;
    },
    name(chat) { return chat.remarkName || chat.realName || chat.name || '未命名聊天'; },
    targets() {
        if (this.currentScope === 'all') return [...(db.characters||[]).map(chat=>({chat,type:'private'})),...(db.groups||[]).map(chat=>({chat,type:'group'}))];
        const chat = MessageReference.getChat(db,this.currentScope.chatType,this.currentScope.chatId);
        return chat ? [{chat,type:this.currentScope.chatType}] : [];
    },
    open(scope = 'all', saved = null) {
        this.generation++; clearTimeout(this.searchTimer);
        this.origin = saved?.origin || ChatHistoryViewport.capture();
        this.returnScreen = saved?.returnScreen || document.querySelector('.phone-screen > .screen.active')?.id || 'chat-list-screen';
        this.currentScope = scope; this.detailGroup = saved?.detailGroup || null; this.navigation = saved?.navigation || null;
        this.resultLimit = saved?.resultLimit || 50;
        this.updateScopeUI();
        const filters = saved?.filters || {keyword:'',type:'all',sender:'all',dateFrom:'',dateTo:''};
        for (const [id,key] of [['search-history-input','keyword'],['search-type-filter','type'],['search-sender-filter','sender'],['search-date-from','dateFrom'],['search-date-to','dateTo']]) document.getElementById(id).value = filters[key] || (['type','sender'].includes(key)?'all':'');
        document.getElementById('search-ignore-status').checked = saved?.ignoreStatus !== false;
        document.getElementById('search-jump-date').value = saved?.jumpDate || '';
        this.present();
        void this.performSearch().then(() => { document.getElementById('search-results-container').scrollTop = saved?.scroll || 0; });
        if (!saved) document.getElementById('search-history-input').focus();
    },
    present() {
        this.showing = true; this.hideNavigation();
        if (this.currentScope !== 'all' && this.origin) {
            const room = document.getElementById('chat-room-screen');
            this.panel.classList.remove('active'); room.append(this.panel);
            this.panel.classList.add('search-inline-panel');
            this.panel.style.setProperty('--search-header-height',document.getElementById('chat-room-header-default').offsetHeight+'px');
            if (!room.classList.contains('active')) switchScreen('chat-room-screen');
        } else {
            this.home.append(this.panel); this.panel.classList.remove('search-inline-panel'); switchScreen('search-history-screen');
        }
        this.persist();
    },
    dismiss() {
        this.showing = false; this.generation++; clearTimeout(this.searchTimer);
        this.panel.querySelectorAll('audio,video').forEach(media=>media.pause());
        this.panel.classList.remove('search-inline-panel','active'); this.home.append(this.panel);
        document.getElementById('search-scope-modal').classList.remove('visible');
    },
    closeSearchScreen() {
        this.dismiss(); this.navigation = null; this.hideNavigation();
        if (this.origin) { switchScreen('chat-room-screen'); ChatHistoryViewport.restore(this.origin); }
        else switchScreen(this.returnScreen === 'search-history-screen' ? 'chat-list-screen' : this.returnScreen);
        this.clearSession();
    },
    getFilters(keyword) {
        return {keyword:keyword == null ? document.getElementById('search-history-input').value.trim() : String(keyword), type:document.getElementById('search-type-filter').value, sender:document.getElementById('search-sender-filter').value, dateFrom:document.getElementById('search-date-from').value, dateTo:document.getElementById('search-date-to').value};
    },
    hasCriteria(f) { return !!(f.keyword || f.type !== 'all' || f.sender !== 'all' || f.dateFrom || f.dateTo); },
    cleanStatus(message, enabled, fallbackRegex) {
        if (!enabled || typeof message.content !== 'string') return message;
        let regex = fallbackRegex;
        if (message.statusSnapshot?.regex) { try { regex = new RegExp(message.statusSnapshot.regex,'g'); } catch {} }
        return regex ? {...message,content:message.content.replace(regex,'')} : message;
    },
    searchable(message, chat) {
        if (!message || typeof message !== 'object') return false;
        if (message.hiddenFromDisplay || message.isThinking || message.isTransferAction) return false;
        if (message.isMomentsActivity && !chat.momentsSettings?.showActivityNarration) return false;
        return true;
    },
    renderPlaceholder(text = '搜索过去的聊天记录') {
        const container = document.getElementById('search-results-container'); container.replaceChildren();
        const p = document.createElement('p'); p.className = 'search-placeholder'; p.textContent = text; container.append(p);
    },
    async performSearch(keyword) {
        const generation = ++this.generation, filters = this.getFilters(keyword);
        if (!this.showing) return;
        this.panel.querySelectorAll('.search-media-tabs button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.type===filters.type)));
        if (!this.hasCriteria(filters) && this.currentScope === 'all') { this.currentResults=[]; this.renderPlaceholder('搜索所有角色与群聊，或选择消息分类'); this.persist(); return; }
        if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) { this.currentResults=[]; this.renderPlaceholder('开始日期不能晚于结束日期'); return; }
        const ignoreStatus = document.getElementById('search-ignore-status').checked;
        this.renderPlaceholder('正在查找…');
        const results=[]; let visited=0;
        for (const {chat,type} of this.targets()) {
            let regex=null;
            if (ignoreStatus && chat.statusPanel?.regexPattern) { try { regex=new RegExp(chat.statusPanel.regexPattern,'g'); } catch {} }
            const matches=[];
            for (const message of chat.history||[]) {
                if (++visited % 500 === 0) { await new Promise(resolve=>setTimeout(resolve,0)); if (generation!==this.generation) return; }
                if (!this.searchable(message,chat) || ignoreStatus && message.isStatusUpdate) continue;
                if (MessageReference.matches(this.cleanStatus(message,ignoreStatus,regex),filters)) matches.push(message);
            }
            if (matches.length) results.push({chatId:chat.id,chatType:type,name:this.name(chat),avatar:chat.avatar||'',count:matches.length,messages:matches.sort((a,b)=>MessageReference.timestampOf(b)-MessageReference.timestampOf(a))});
        }
        if (generation!==this.generation) return;
        this.currentResults=results.sort((a,b)=>b.count-a.count);
        const total=results.reduce((sum,group)=>sum+group.count,0);
        if (!total) this.renderPlaceholder('未找到符合条件的聊天记录');
        else {
            const detail = this.detailGroup && results.find(group=>group.chatId===this.detailGroup.chatId&&group.chatType===this.detailGroup.chatType);
            if (this.currentScope!=='all' || detail) this.renderDetail(detail||results[0],filters.keyword,this.currentScope!=='all');
            else this.renderOverview(results,total,filters.keyword);
        }
        this.persist();
    },
    preview(message) {
        const type=MessageReference.classify(message),raw=MessageReference.extractText(message);
        const parsed=MessageReference.parseContent(/^data:|^https?:\/\/\S+$/i.test(raw)?'':raw);
        return {type,original:(message.transcriptOriginal||parsed.original||message.fileName||MessageReference.TYPE_LABELS[type]||'消息').slice(0,800),translation:(message.translation||message.transcriptTranslation||parsed.translation||'').slice(0,800)};
    },
    renderOverview(results,total,keyword) {
        this.detailGroup=null;
        const container=document.getElementById('search-results-container'); container.replaceChildren();
        const header=document.createElement('p'); header.className='search-stat-header'; header.textContent=`共找到 ${total} 条记录 · ${results.length} 个会话`; container.append(header);
        for (const group of results) {
            const item=this.button('',()=>{this.resultLimit=50;this.renderDetail(group,keyword);this.persist();}); item.className='search-group-item';
            const name=document.createElement('strong'),preview=document.createElement('span');
            name.textContent=`${group.name} · ${group.chatType==='group'?'群聊':'角色'} · ${group.count} 条`; preview.textContent=this.preview(group.messages[0]).original.slice(0,140);
            item.append(name,preview); container.append(item);
        }
    },
    renderDetail(group,keyword,isDirectMode=false) {
        if (!group) return;
        this.detailGroup={chatType:group.chatType,chatId:group.chatId};
        const container=document.getElementById('search-results-container');container.replaceChildren();
        const header=document.createElement('div');header.className='search-detail-header';
        if (!isDirectMode) header.append(this.button('‹ 全部会话',()=>{this.detailGroup=null;void this.performSearch();}));
        const title=document.createElement('strong');title.textContent=`${group.name} · ${group.count} 条`;header.append(title);container.append(header);
        const list=document.createElement('div');list.className='search-result-list';container.append(list);
        const chat=MessageReference.getChat(db,group.chatType,group.chatId);
        for (const message of group.messages.slice(0,this.resultLimit||50)) {
            const preview=this.preview(message),item=document.createElement('article');item.className='search-result-item';
            const jump=this.button('',()=>this.jump(group,message.id));jump.className='search-result-open';
            const info=document.createElement('span');info.className='search-result-header';
            info.textContent=`${MessageReference.getSenderName(group.chatType,chat,message)} · ${MessageReference.TYPE_LABELS[preview.type]||'消息'} · ${new Date(MessageReference.timestampOf(message)).toLocaleString()}`;
            const text=document.createElement('div');text.className='search-result-content';text.innerHTML=this.highlightKeyword(preview.original,keyword);
            jump.append(info,text);
            if(preview.translation){const translation=document.createElement('div');translation.className='search-result-translation';translation.innerHTML=this.highlightKeyword(preview.translation,keyword);jump.append(translation);}
            jump.setAttribute('aria-label','定位原消息：'+preview.original.slice(0,60));item.append(jump);
            this.addMedia(item,message,preview.type,()=>this.jump(group,message.id));list.append(item);
        }
        if(group.count>(this.resultLimit||50))container.append(this.button('加载更多结果',()=>{const scroll=container.scrollTop;this.resultLimit=(this.resultLimit||50)+50;this.renderDetail(group,keyword,isDirectMode);container.scrollTop=scroll;this.persist();}));
    },
    addMedia(item,message,type,jump) {
        const parts=Array.isArray(message.parts)?message.parts:[];
        const part=parts.find(p=>p?.type===type || type==='image'&&p?.type==='image_url');
        const candidate=part?.url||part?.data||part?.image_url?.url||message.imageUrl||MessageReference.extractText(message);
        const source=typeof candidate==='string'&&(/^(https?:\/\/|blob:)/i.test(candidate)||new RegExp('^data:'+type+'/','i').test(candidate))?candidate:null;
        if(type==='image'&&source){const button=this.button('',jump),img=document.createElement('img');button.className='search-media-preview';img.src=source;img.alt='图片原消息';img.loading='lazy';button.append(img);item.append(button);}
        if(type==='video'&&source){const video=document.createElement('video');video.controls=true;video.preload='none';video.src=source;video.className='search-media-preview';item.append(video);}
        if(message.audioAssetId && window.RecordedAudioService){const button=this.button('播放录音',async()=>{try{await RecordedAudioService.play(message.audioAssetId);}catch{showToast('录音文件暂不可用，可查看原消息');}});item.append(button);}
    },
    flattened() { return this.currentResults.flatMap(group=>group.messages.map(message=>({chatType:group.chatType,chatId:group.chatId,messageId:message.id}))); },
    jump(group,messageId) {
        const refs=this.flattened(),index=refs.findIndex(ref=>ref.chatId===group.chatId&&ref.chatType===group.chatType&&ref.messageId===messageId);
        this.navigation={refs,index,origin:this.origin,returnScreen:this.returnScreen,fromSearch:true};
        this.resultScroll=document.getElementById('search-results-container').scrollTop;
        if(!MessageReference.locate(group.chatType,group.chatId,messageId))showToast('该消息已不存在或标识不唯一');
    },
    beforeLocate() {
        if (!this.navigation) this.navigation={refs:[],index:0,origin:ChatHistoryViewport.capture(),returnScreen:document.querySelector('.phone-screen > .screen.active')?.id||'chat-list-screen',fromSearch:false};
        if(this.showing)this.dismiss();
    },
    afterLocate(chatType,chatId,messageId) {
        if(!this.navigation)return;
        this.navigation.target={chatType,chatId,messageId};this.showNavigation();this.persist();
    },
    showNavigation() {
        this.hideNavigation();const nav=this.navigation;if(!nav)return;
        const bar=document.createElement('div');bar.id='chat-history-navigation';bar.setAttribute('aria-label','历史消息导航');
        if(nav.fromSearch && nav.refs.length){const previous=this.button('上一条',()=>this.step(-1)),next=this.button('下一条',()=>this.step(1)),count=document.createElement('span');previous.disabled=nav.index<=0;next.disabled=nav.index>=nav.refs.length-1;count.textContent=`${nav.index+1} / ${nav.refs.length}`;bar.append(previous,count,next);}
        if(nav.fromSearch)bar.append(this.button('搜索结果',()=>{this.present();void this.performSearch().then(()=>document.getElementById('search-results-container').scrollTop=this.resultScroll||0);}));
        bar.append(this.button('返回原位置',()=>this.returnToOrigin()));document.getElementById('message-area').before(bar);
    },
    step(delta) {
        const nav=this.navigation;if(!nav)return;const index=nav.index+delta,ref=nav.refs[index];if(!ref)return;
        if(!MessageReference.resolve(ref.chatType,ref.chatId,ref.messageId)){showToast('该消息已不存在');return;}
        nav.index=index;MessageReference.locate(ref.chatType,ref.chatId,ref.messageId);
    },
    hideNavigation(){document.getElementById('chat-history-navigation')?.remove();},
    returnToOrigin(){const nav=this.navigation;this.navigation=null;this.hideNavigation();this.dismiss();this.clearSession();if(nav?.origin){switchScreen('chat-room-screen');ChatHistoryViewport.restore(nav.origin);}else switchScreen(nav?.returnScreen||'chat-list-screen');},
    onChatOpened(){if(!window._pendingMessageLocation){this.navigation=null;this.hideNavigation();if(!this.showing)this.clearSession();}},
    jumpDate(){
        const date=document.getElementById('search-jump-date').value;if(!date)return;
        if(this.currentScope==='all'){document.getElementById('search-date-from').value=date;document.getElementById('search-date-to').value=date;void this.performSearch();return;}
        const target=this.targets()[0];if(!target)return;
        const message=MessageReference.nearestDate((target.chat.history||[]).filter(m=>this.searchable(m,target.chat)&&!m.isStatusUpdate),date);
        if(!message){showToast('没有可定位的历史消息');return;}
        this.navigation={refs:[],index:0,origin:this.origin,returnScreen:this.returnScreen,fromSearch:true};
        MessageReference.locate(target.type,target.chat.id,message.id);
    },
    openScopeModal(){const modal=document.getElementById('search-scope-modal'),list=document.getElementById('search-scope-list');list.replaceChildren();const add=(scope,name)=>list.append(this.button(name,()=>{this.currentScope=scope;this.detailGroup=null;this.resultLimit=50;this.updateScopeUI();modal.classList.remove('visible');void this.performSearch();}));add('all','全部角色与群聊');for(const [type,rows]of [['private',db.characters||[]],['group',db.groups||[]]])for(const chat of rows)add({chatType:type,chatId:chat.id},this.name(chat)+(type==='group'?' · 群聊':''));modal.classList.add('visible');},
    updateScopeUI(){const chat=this.currentScope==='all'?null:MessageReference.getChat(db,this.currentScope.chatType,this.currentScope.chatId);document.querySelector('#search-scope-select span').textContent=chat?'范围：'+this.name(chat):'范围：全部角色与群聊';const select=document.getElementById('search-sender-filter');select.replaceChildren(new Option('全部发送者','all'),new Option('我','user'),new Option('角色 / 群成员','assistant'));if(chat&&this.currentScope.chatType==='group')for(const member of chat.members||[])select.append(new Option(member.groupNickname||member.realName||member.name||'群成员','member:'+member.id));},
    persist(){try{const nav=this.navigation;sessionStorage.setItem(this.sessionKey,JSON.stringify({scope:this.currentScope,filters:this.getFilters(),jumpDate:document.getElementById('search-jump-date').value,ignoreStatus:document.getElementById('search-ignore-status').checked,origin:this.origin,returnScreen:this.returnScreen,detailGroup:this.detailGroup,resultLimit:Math.min(this.resultLimit||50,500),scroll:this.showing?document.getElementById('search-results-container').scrollTop:this.resultScroll||0,showing:this.showing,navigation:nav?{...nav,refs:[]}:null}));}catch{}},
    clearSession(){try{sessionStorage.removeItem(this.sessionKey);}catch{}},
    restoreSession(){let saved;try{saved=JSON.parse(sessionStorage.getItem(this.sessionKey)||'null');}catch{}if(!saved||(!saved.showing&&!saved.navigation))return;if(saved.origin && MessageReference.getChat(db,saved.origin.chatType,saved.origin.chatId)){openChatRoom(saved.origin.chatId,saved.origin.chatType);ChatHistoryViewport.restore(saved.origin);}this.open(saved.scope,saved);if(!saved.showing&&saved.navigation?.target){const target=saved.navigation.target;this.performSearch().then(()=>{this.navigation={...saved.navigation,refs:this.flattened()};this.navigation.index=this.navigation.refs.findIndex(r=>r.chatType===target.chatType&&r.chatId===target.chatId&&r.messageId===target.messageId);MessageReference.locate(target.chatType,target.chatId,target.messageId);});}},
    highlightKeyword(content,keyword){if(!keyword)return this.escapeHtml(content);const pattern=String(keyword).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return String(content).split(new RegExp('('+pattern+')','gi')).map((part,index)=>index%2?'<mark class="keyword-highlight">'+this.escapeHtml(part)+'</mark>':this.escapeHtml(part)).join('');},
    escapeHtml(text){return String(text??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
};
window.SearchSystem=SearchSystem;
