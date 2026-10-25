(function (global) {
    'use strict';
    // Owns musicLibrary records; audio payloads never enter db/global settings or chat.
    let tracks = [], queue = null, generation = 0, url = '', initialized = false;
    let writes = Promise.resolve();
    let lyricKey = null, lyricData = null, activeLyric = -1, pickerTrackId = '', loadedTrackId = '';
    // Together-listening belongs to this tab/session and selected roles; track changes keep it active.
    let sharing = null;
    let candidateSelection = new Set(), suggestionTicket = null, pendingSuggestion = null;
    let onlineRequest = 0, lyricEditorId = '', playMode = 'sequence';
    let accountKey = '', accountEpoch = 0;
    let playlists = [], playlistId = '', listenTick = null;
    const listenTotals = new Map(), listenPending = new Map();
    const tickets = new Map();
    const table = () => global.dexieDB.musicLibrary;
    const root = () => document.getElementById('music-screen');
    const field = name => root().querySelector(`[data-music="${name}"]`);
    const status = text => { field('status').textContent = text; };
    function showView(name) {
        if (!root().querySelector(`[data-music-panel="${name}"]`)) return;
        root().querySelectorAll('[data-music-panel]').forEach(panel => { panel.hidden = panel.dataset.musicPanel !== name; });
        root().querySelectorAll('[data-music-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.musicView === name)));
        root().querySelector('.music-main').scrollTop = 0;
        root().dataset.musicView = name;
    }
    function renderPlayback() {
        const audio = field('audio'), current = tracks.find(track => track.id === queue?.currentId);
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const playing = !audio.paused && !audio.ended;
        field('play').disabled = !current;
        field('play').textContent = playing ? 'Ⅱ' : '▶';
        field('play').setAttribute('aria-label', playing ? '暂停' : '播放');
        field('playback-state').textContent = current ? (audio.error ? '音源暂不可用' : playing ? '正在播放' : '等你按下播放') : '选择一首喜欢的歌';
        field('artist').textContent = current ? (current.artist || (current.online ? '在线歌曲' : '本地音乐')) : '从曲库选择，或搜索新的旋律';
        field('seek').max = String(duration);
        field('seek').value = String(audio.currentTime || 0);
        field('seek').disabled = !duration || !loadedTrackId;
        field('seek').setAttribute('aria-valuetext', `${global.MusicCore.time(audio.currentTime || 0)} / ${global.MusicCore.time(duration)}`);
        field('elapsed').textContent = global.MusicCore.time(audio.currentTime || 0);
        field('duration').textContent = global.MusicCore.time(duration);
        field('volume').value = String(audio.volume);
        field('queue-count').textContent = String(activeOrder().length);
    }
    async function confirmChange(title, message, confirmText = '确定') {
        return await global.showAppConfirmDialog({ title, message, confirmText, cancelText: '取消', dismissText: '' }) === 'confirm';
    }
    function serialize(action) {
        const next = writes.then(action);
        writes = next.catch(() => {});
        return next;
    }
    function report(error) { status(error?.name === 'QuotaExceededError' ? '存储空间不足，请先备份并清理空间' : (error?.message || '音乐操作失败')); }
    function run(action) { return Promise.resolve().then(action).catch(report); }
    function pause() { generation++; field('audio')?.pause(); }
    function activeOrder() { return playlistId ? (playlists.find(item=>item.id===playlistId)?.trackIds || []).filter(id=>tracks.some(track=>track.id===id)) : (queue?.order || []); }
    function countListening() {
        const audio=field('audio'), now=performance.now(),position=audio.currentTime;
        if (listenTick && sharing && !audio.paused && !audio.seeking && listenTick.trackId===loadedTrackId) {
            const seconds=Math.max(0,Math.min((now-listenTick.at)/1000,position-listenTick.position));
            if (seconds>0 && seconds<10)for(const roleId of sharing.roleIds.filter(id=>roles().some(role=>String(role.id)===id))){
                listenTotals.set(roleId,(listenTotals.get(roleId)||0)+seconds);listenPending.set(roleId,(listenPending.get(roleId)||0)+seconds);
            }
        }
        listenTick={at:now,position,trackId:loadedTrackId};
    }
    async function flushListening() {
        const increments=new Map(listenPending);listenPending.clear();if(!increments.size){await writes;return;}
        try {await serialize(()=>global.dexieDB.transaction('rw',table(),async()=>{
            for(const [roleId,amount] of increments){const id='listening:'+roleId,previous=await table().get(id);await table().put({id,kind:'listening',roleId,totalSeconds:(Number(previous?.totalSeconds)||0)+amount});}
        }));}catch(error){for(const [id,amount] of increments)listenPending.set(id,(listenPending.get(id)||0)+amount);throw error;}
    }
    function release() {
        pause();
        loadedTrackId = '';
        const audio = field('audio');
        audio.removeAttribute('src'); audio.load();
        if (url) URL.revokeObjectURL(url);
        url = '';
        syncLyrics();
    }
    async function refresh() {
        const rows = [];
        await table().where('kind').equals('track').each(row => {
            const { dataUrl, ...metadata } = row;
            rows.push(metadata);
        });
        tracks = rows;
        playlists=await table().where('kind').equals('playlist').toArray();
        if(playlistId && !playlists.some(item=>item.id===playlistId))playlistId='';
        for(const row of await table().where('kind').equals('listening').toArray()) if(!listenTotals.has(row.roleId))listenTotals.set(row.roleId,Number(row.totalSeconds)||0);
        queue = global.MusicCore.queue(await table().get('queue'), rows.map(row => row.id));
        render();
    }
    function render() {
        const list = field('list'); list.replaceChildren();
        const current = tracks.find(track => track.id === queue?.currentId);
        field('title').textContent = current?.title || '还没有歌曲';
        field('previous').disabled = !queue?.order.length;
        field('next').disabled = !queue?.order.length;
        renderPlayback();
        renderLyrics(current);
        renderSharingRoles();
        renderCandidates();
        renderSuggestion();
        renderPlaylists();
        if (!activeOrder().length) { list.textContent = tracks.length ? '这个歌单还没有歌曲，点击编辑来添加。' : '曲库还是空的。导入本地歌曲，或去搜索喜欢的音乐。'; return; }
        for (const id of activeOrder()) {
            const track = tracks.find(item => item.id === id);
            const row = document.createElement('div'); row.className = 'music-track';
            const name = document.createElement('button'); name.type = 'button'; name.className = 'music-name';
            name.textContent = `${track.title}${track.artist ? ' · '+track.artist : ''}${track.online ? ' · 在线' : ''}`; name.setAttribute('aria-current', String(id === queue.currentId));
            name.onclick = () => void run(() => play(id));
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除';
            remove.setAttribute('aria-label', `移除 ${track.title}`);
            remove.onclick = () => void run(async () => { if (await confirmChange('移除歌曲', `移除“${track.title}”及其本地音频？此操作不能撤销。`, '移除')) await removeTrack(id); });
            row.append(name, remove);
            if(playlistId){const detach=document.createElement('button');detach.type='button';detach.textContent='移出歌单';detach.onclick=()=>void run(()=>{
                const saved=playlists.find(item=>item.id===playlistId);return savePlaylist(saved.title,saved.trackIds.filter(key=>key!==id),saved.id);
            });row.append(detach);}list.append(row);
        }
    }
    function roles() { return Array.isArray(global.db?.characters) ? global.db.characters : []; }
    function sharingSnapshot(roleId = sharing?.roleId) {
        if (!sharing || !sharing.roleIds.includes(String(roleId)) || !roles().some(role => String(role.id) === String(roleId))) return null;
        const track = tracks.find(item => item.id === sharing.trackId);
        const audio = field('audio');
        if (!track || loadedTrackId !== track.id || queue?.currentId !== track.id || !url || audio.error || audio.readyState < 1 || audio.ended) return null;
        const index = lyricData?.timed ? global.MusicCore.lyricIndex(lyricData.lines, audio.currentTime) : -1;
        return {...sharing, roleId:String(roleId), title:track.title, artist:track.artist, paused:audio.paused, position:audio.currentTime,
            lyric:index >= 0 ? lyricData.lines[index].text : '',
            upcomingLyrics:index >= 0 ? lyricData.lines.slice(index+1,index+3).map(line=>line.text) : [],
            fullLyrics:sharing.lyricMode === 'full' || (sharing.shareLyrics && lyricData && !lyricData.timed) ? track.lyrics?.raw : '',
            listeningSeconds:listenTotals.get(String(roleId)) || 0};
    }
    function getPromptBlock(roleId, options = {}) {
        return global.MusicCore.sharingContext(sharingSnapshot(roleId), {...options, roleId});
    }
    function stopSharing() { countListening();void run(flushListening);sharing = null; tickets.clear(); suggestionTicket = null; pendingSuggestion = null; renderSharingStatus(); renderSuggestion(); }
    function startSharing(roleId, shareLyrics = true, candidateIds = [], options = {}) {
        const id = String(roleId || '');
        const audio = field('audio');
        if (!roles().some(role => String(role.id) === id)) throw new Error('请选择仍存在的角色');
        if (!loadedTrackId || loadedTrackId !== queue?.currentId || !url || audio.error || audio.readyState < 1 || audio.ended) throw new Error('请先加载可播放的歌曲');
        const candidates = [...new Set(candidateIds)];
        if (candidates.some(candidate => !tracks.some(track => track.id === candidate))) throw new Error('所选歌曲已不存在，请刷新曲库');
        stopSharing();
        const roleIds = [...new Set([id,...(options.roleIds || []).map(String)])].filter(key=>roles().some(role=>String(role.id)===key));
        sharing = {roleId:id,roleIds,trackId:loadedTrackId,shareLyrics:shareLyrics === true,lyricMode:options.lyricMode || 'current',autoSwitch:options.autoSwitch === true,allCandidates:options.allCandidates === true,sessionId:global.crypto.randomUUID(),candidateIds:candidates};
        listenTick=null;countListening();
        candidateSelection = new Set(candidates);
        field('sharing-role').value = id;
        field('sharing-lyrics').checked = sharing.shareLyrics;
        renderCandidates();
        renderSharingStatus();
    }
    function prepareChatContext(roleId, options = {}) {
        const text = getPromptBlock(roleId, options);
        if (!text) return {text:'',ticket:null};
        // A newer round supersedes an older unconfirmed proposal for this session.
        tickets.delete(String(roleId));
        if (pendingSuggestion?.roleId === String(roleId)) pendingSuggestion = null;
        renderSuggestion();
        const candidates = (sharing.allCandidates ? activeOrder() : sharing.candidateIds || []).map(id => tracks.find(track => track.id === id)).filter(Boolean).map(track => ({id:track.id,title:track.title}));
        if (!candidates.length) return {text,ticket:null};
        const ticket = global.crypto.randomUUID();
        suggestionTicket = {id:ticket,sessionId:sharing.sessionId,roleId:String(roleId),sourceId:sharing.trackId,candidates,createdAt:Date.now()};
        tickets.set(String(roleId),suggestionTicket);
        let instruction = global.MusicCore.suggestionPrompt(ticket,candidates);
        if (sharing.autoSwitch) instruction = instruction.replace('你可以建议其中一首，但不能执行播放。','用户已允许你从列表切歌，使用以下标记请求播放器执行。').replace('只有用户确认后才播放，不要声称已切歌。','应用会验证会话后执行；收到成功结果前不要声称已经播放。');
        return {text:text + instruction,ticket};
    }
    function validSuggestion(record) {
        return !!record && !!sharingSnapshot(record.roleId) && sharing.sessionId === record.sessionId && sharing.roleIds.includes(record.roleId)
            && sharing.trackId === record.sourceId && Date.now()-record.createdAt < 10*60*1000;
    }
    function receiveSuggestion(ticket, suggestion) {
        const record = [...tickets.values()].find(item=>item.id === ticket);
        if (!record || record.id !== ticket) return false;
        tickets.delete(record.roleId);
        if (!validSuggestion(record) || !suggestion || suggestion.ticket !== ticket || !Number.isInteger(suggestion.choice)) return false;
        const candidate = record.candidates[suggestion.choice-1];
        if (!candidate || !tracks.some(track => track.id === candidate.id)) return false;
        pendingSuggestion = {...record,targetId:candidate.id,title:candidate.title};
        if (sharing.autoSwitch) { void run(()=>acceptSuggestion(record.id)); return true; }
        renderSuggestion();
        global.showToast?.('收到角色点歌建议，请到音乐页确认或拒绝');
        return true;
    }
    function renderSuggestion() {
        if (pendingSuggestion && (!validSuggestion(pendingSuggestion) || !tracks.some(track => track.id === pendingSuggestion.targetId))) pendingSuggestion = null;
        const panel = field('suggestion-card'); panel.hidden = !pendingSuggestion;
        if (!pendingSuggestion) return;
        const role = roles().find(item => String(item.id) === pendingSuggestion.roleId);
        field('suggestion-text').textContent = `${role?.remarkName || role?.realName || role?.name || '角色'} 建议播放：${pendingSuggestion.title}`;
        const id = pendingSuggestion.id;
        field('suggestion-accept').onclick = () => void run(() => acceptSuggestion(id));
        field('suggestion-reject').onclick = () => rejectSuggestion(id);
    }
    function rejectSuggestion(id) {
        if (pendingSuggestion?.id !== id) return false;
        pendingSuggestion = null; renderSuggestion(); status('已拒绝建议，播放保持不变'); return true;
    }
    async function acceptSuggestion(id) {
        const record = pendingSuggestion;
        if (!record || record.id !== id || !validSuggestion(record)) throw new Error('建议已过期或授权已结束');
        const track = await table().get(record.targetId);
        if (pendingSuggestion !== record || !validSuggestion(record) || track?.kind !== 'track') {
            renderSuggestion(); throw new Error('歌曲已删除或建议已失效，未切换播放');
        }
        // Consume before starting asynchronous playback: double clicks cannot execute twice.
        pendingSuggestion = null;
        tickets.clear();
        await play(track.id);
        status('已切换歌曲，一起听继续');
        return true;
    }
    function renderCandidates() {
        const list = field('suggestion-candidates'); list.replaceChildren();
        candidateSelection = new Set([...candidateSelection].filter(id => tracks.some(track => track.id === id)));
        for (const track of tracks) {
            const label = document.createElement('label'); label.className = 'music-sharing-check';
            const input = document.createElement('input'); input.type = 'checkbox'; input.checked = candidateSelection.has(track.id);
            input.onchange = () => {
                if (input.checked) candidateSelection.add(track.id); else candidateSelection.delete(track.id);
                stopSharing();
            };
            label.append(input,document.createTextNode(track.title)); list.append(label);
        }
        if (!tracks.length) list.textContent = '请先添加歌曲';
    }
    function renderSharingRoles() {
        const select = field('sharing-role'), selected = select.value;
        select.replaceChildren(new Option('请选择角色', ''));
        for (const role of roles()) select.append(new Option(role.remarkName || role.realName || role.name || '未命名角色', String(role.id)));
        select.value = selected;
        const others = field('sharing-others'), chosen = new Set([...others.querySelectorAll('input:checked')].map(input=>input.value));
        others.replaceChildren();
        for (const role of roles()) {
            const label=document.createElement('label'); label.className='music-sharing-check';
            const input=document.createElement('input'); input.type='checkbox';input.value=String(role.id);input.checked=chosen.has(input.value);
            input.onchange=stopSharing; label.append(input,document.createTextNode(role.remarkName || role.realName || role.name || '角色'));others.append(label);
        }
        if (sharing && !roles().some(role => String(role.id) === sharing.roleId)) stopSharing();
        renderSharingStatus();
    }
    function renderSharingStatus() {
        const audio = field('audio'), snapshot = sharingSnapshot();
        field('sharing-start').disabled = !field('sharing-role').value || !loadedTrackId || loadedTrackId !== queue?.currentId || audio.readyState < 1 || !!audio.error || audio.ended;
        field('sharing-stop').disabled = !sharing;
        const role = roles().find(item => String(item.id) === sharing?.roleId);
        field('sharing-status').textContent = snapshot
            ? `与 ${role?.remarkName || role?.realName || role?.name || '所选角色'}${sharing.roleIds.length > 1 ? ' 等 '+sharing.roleIds.length+' 位角色' : ''} 一起听：${snapshot.title} · ${global.MusicCore.time(snapshot.position)} · ${snapshot.paused ? '已暂停' : '播放中'}${snapshot.shareLyrics ? ' · 分享歌词' : ' · 不含歌词'}${sharing.autoSwitch ? ' · 角色可切歌' : ' · 切歌需确认'}`
            : (sharing ? '歌曲暂不可用，本次不会附加音乐信息。' : '未开启，不向角色分享音乐。');
        field('sharing-time').textContent = sharing ? `与所选主角色累计一起听 ${global.MusicCore.time(listenTotals.get(sharing.roleId)||0)}（仅计实际播放，暂停不计）` : '';
    }
    function renderLyrics(track) {
        field('import-lyrics').disabled = !track;
        field('clear-lyrics').disabled = !track?.lyrics;
        const key = JSON.stringify([track?.id, track?.lyrics?.name, track?.lyrics?.raw]);
        if (key === lyricKey) { syncLyrics(); return; }
        lyricKey = key; lyricData = null; activeLyric = -1;
        const list = field('lyrics'); list.replaceChildren(); list.scrollTop = 0;
        field('lyrics-note').textContent = track ? '支持在线歌词、粘贴编辑和 UTF-8 LRC/TXT 导入。' : '选择歌曲后可添加歌词。';
        if (!track?.lyrics) return;
        try {
            lyricData = global.MusicCore.parseLyrics(track.lyrics.raw, track.lyrics.name);
            field('lyrics-note').textContent = `${track.lyrics.name} · ${lyricData.timed ? '随播放进度高亮' : '纯文字歌词，不自动同步'}`;
            const fragment = document.createDocumentFragment();
            for (const line of lyricData.lines) {
                const node = document.createElement('p'); node.className = 'music-lyric-line';
                node.textContent = line.text || '♪'; fragment.append(node);
                if (lyricData.timed) {
                    node.tabIndex=0; node.setAttribute('role','button');
                    const seek=()=>{if(loadedTrackId===track.id)field('audio').currentTime=line.at/1000;};
                    node.onclick=seek;node.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();seek();}};
                }
            }
            list.append(fragment); syncLyrics();
        } catch (error) { field('lyrics-note').textContent = `歌词无法读取：${error.message}。可重新导入或清除，不影响音频播放。`; }
    }
    function syncLyrics() {
        if (!lyricData?.timed) return;
        const list = field('lyrics');
        const index = loadedTrackId === queue?.currentId ? global.MusicCore.lyricIndex(lyricData.lines, field('audio').currentTime) : -1;
        if (index === activeLyric) return;
        list.children[activeLyric]?.removeAttribute('aria-current');
        activeLyric = index;
        const node = list.children[index];
        if (node) {
            node.setAttribute('aria-current', 'true');
            // Scroll only this bounded lyrics panel, never the page or playback controls.
            list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - node.offsetHeight) / 2;
        }
    }
    async function importLyrics(id, file) {
        if (!file || !/\.(lrc|txt)$/i.test(file.name)) throw new Error('请选择 LRC 或 TXT 歌词');
        if (!file.size || file.size > global.MusicCore.MAX_LYRIC_BYTES) throw new Error('请选择非空歌词文件；超过 2 MB 时请检查是否选错文件');
        let raw;
        try { raw = new TextDecoder('utf-8', {fatal:true}).decode(await file.arrayBuffer()); }
        catch (_) { throw new Error('歌词读取失败，请使用 UTF-8 编码的文件'); }
        global.MusicCore.parseLyrics(raw, file.name);
        return saveLyrics(id, {name:file.name.slice(-240),raw});
    }
    function saveLyrics(id, lyrics) {
        if (lyrics) global.MusicCore.parseLyrics(lyrics.raw,lyrics.name);
        return serialize(async () => {
            await global.dexieDB.transaction('rw', table(), async () => {
                const track = await table().get(id);
                if (!track || track.kind !== 'track') throw new Error('原歌曲已移除，歌词没有保存');
                await table().update(id, {lyrics});
            });
            await refresh();
            status(lyrics ? '歌词已保存；一起听按所选歌词模式分享' : '歌词已清除，音频保留');
        });
    }
    async function select(id, autoplay = false) {
        tickets.clear(); pendingSuggestion = null;
        release();
        const token = generation;
        const track = await table().get(id);
        if (token !== generation) return;
        if (!track || track.kind !== 'track') throw new Error('歌曲已不存在，请重新打开音乐页');
        if (track.online) {
            const resolved = track.online.source === 'direct'
                ? {url:track.online.playUrl,identity:track.online}
                : await global.MioMusicOnline.resolveSong(track.online,{allowCrossPlatform:false});
            if (token !== generation) return;
            if (!resolved?.url) throw new Error('在线音源暂不可用，请重新搜索或换源；已保留歌曲');
            url = global.MusicCore.remoteUrl(resolved.url);
            if (track.lyrics === undefined) void loadOnlineLyrics(id,resolved.identity).catch(error=>{if(loadedTrackId===id)status(error.message);});
        } else {
        if (typeof track.dataUrl !== 'string' || track.dataUrl.length > global.MusicCore.MAX_BYTES * 4 / 3 + 200 || !/^data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(track.dataUrl)) throw new Error('音频数据无效，请移除后重新导入');
        const comma = track.dataUrl.indexOf(',');
        const binary = atob(track.dataUrl.slice(comma + 1));
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (token !== generation) return;
        url = URL.createObjectURL(new Blob([bytes], {type: track.dataUrl.slice(5, track.dataUrl.indexOf(';'))}));
        }
        field('audio').src = url;
        loadedTrackId = id;
        queue.currentId = id;
        if (sharing) sharing.trackId = id;
        await serialize(() => table().put({ ...queue, order: [...queue.order] }));
        if (token !== generation) return;
        render();
        if (global.navigator?.mediaSession && global.MediaMetadata) {
            global.navigator.mediaSession.metadata = new MediaMetadata({title:track.title,artist:track.artist || ''});
        }
        if (autoplay) {
            try { await field('audio').play(); }
            catch (error) { if (token === generation) throw new Error(error.name === 'NotAllowedError' ? '请点击播放器的播放按钮' : '此音频无法播放，请检查格式或文件是否损坏'); }
        }
    }
    async function play(id) { await select(id || queue?.currentId, true); }
    async function step(delta, automatic = false) {
        const order=activeOrder();if (!order.length) return;
        if (automatic && playMode === 'single') { await play(queue.currentId); return; }
        if (playMode === 'shuffle' && order.length > 1) {
            const others=order.filter(id=>id!==queue.currentId);
            await play(others[Math.floor(Math.random()*others.length)]);return;
        }
        const index = order.indexOf(queue.currentId) + delta;
        if (automatic && index >= order.length && playMode === 'sequence') { status('队列播放完毕'); return; }
        await play(order[(index + order.length) % order.length]);
    }
    async function addOnline(songs) {
        if (!Array.isArray(songs)) throw new Error('在线歌曲列表无效');
        return serialize(async()=>{
            let added=0,duplicates=0; const errors=[],ids=[];
            for (const song of songs) {
                try {
                    const source=String(song.source || 'netease');
                    const playUrl=song.playUrl ? global.MusicCore.remoteUrl(song.playUrl) : '';
                    const lyricUrl=song.lyricUrl ? global.MusicCore.remoteUrl(song.lyricUrl) : '';
                    if (!song.id && !playUrl) throw new Error('歌曲缺少标识或播放链接');
                    const id='music:online:'+await global.SharedAssets.digest(new Blob([source+'|'+(song.id || playUrl)]));
                    if (await table().get(id)) { duplicates++;ids.push(id);continue; }
                    const online={source,id:String(song.id || ''),name:String(song.name || '未命名歌曲'),artist:String(song.artist || ''),provider:String(song.provider || ''),playUrl,lyricUrl};
                    await global.dexieDB.transaction('rw',table(),async()=>{
                        await table().put({id,kind:'track',title:online.name,artist:online.artist,online});
                        await table().put(global.MusicCore.queue(await table().get('queue'),await table().where('kind').equals('track').primaryKeys()));
                    });added++;ids.push(id);
                } catch(error) {errors.push(String(song.name || '歌曲')+'：'+error.message);}
            }
            await refresh();status(`已加入 ${added} 首，重复 ${duplicates} 首${errors.length ? '；'+errors.join('；') : ''}`);
            return {added,duplicates,errors,ids};
        });
    }
    async function loadOnlineLyrics(id, identity, force=false) {
        const raw=await global.MioMusicOnline.loadLyrics(identity);
        if (!raw) {if(force)throw new Error('未获取到在线歌词，可粘贴或导入');return;}
        const name=/\[\d{1,3}:[0-5]\d/.test(raw) ? '在线歌词.lrc' : '在线歌词.txt';
        global.MusicCore.parseLyrics(raw,name);
        await serialize(async()=>{
            await global.dexieDB.transaction('rw',table(),async()=>{
                const row=await table().get(id);
                if (row?.kind === 'track' && (force || row.lyrics === undefined)) await table().update(id,{lyrics:{name,raw}});
            });
            await refresh();
        });
    }
    async function searchOnline(type='search') {
        const token=++onlineRequest, query=field('online-query').value.trim();
        if (!query) {field('online-status').textContent='请输入歌名、歌手或歌单/专辑 ID';return;}
        field('online-status').textContent='正在查询…';field('online-results').replaceChildren();
        try {
            const platform=field('online-platform').value;
            const service=global.MioMusicOnline;
            let songs;
            if (type==='search') songs=await (platform==='all' ? service.searchAll(query) : service.searchPlatform(platform,query));
            else {
                let id=query;
                if (/^https?:/.test(query)) {const parsed=new URL(query);id=parsed.searchParams.get('id') || parsed.hash.match(/[?&]id=(\d+)/)?.[1] || '';}
                if (!/^\d+$/.test(id)) throw new Error('请输入网易云歌单/专辑数字 ID 或含 ID 的链接');
                songs=await (type==='album' ? service.getAlbum(id) : service.getPlaylist(id));
            }
            if (token !== onlineRequest) return;
            renderOnlineResults(songs);
        } catch(error) {if(token===onlineRequest)field('online-status').textContent='查询失败：'+(error.name==='AbortError' ? '服务超时，请重试或切换平台' : error.message);}
    }
    function renderOnlineResults(songs) {
        const list=field('online-results');list.replaceChildren();
        field('online-status').textContent=songs.length ? `找到 ${songs.length} 首，加入队列后播放` : '没有结果，可换关键词或平台';
        if(songs.length) {
            const all=document.createElement('button');all.type='button';all.textContent='全部加入队列';
            all.onclick=()=>void run(()=>addOnline(songs));list.append(all);
            const grouped=document.createElement('button');grouped.type='button';grouped.textContent='导入为歌单';grouped.onclick=()=>{
                void run(async()=>{const values=await global.showAppFormDialog({title:'导入为歌单',fields:[{name:'title',label:'歌单名称',value:field('online-query').value || '在线歌单',type:'text',required:true}],confirmText:'导入'});if(!values)return;const result=await addOnline(songs);await savePlaylist(values.title,result.ids);});
            };list.append(grouped);
        }
        for(const song of songs) {
            const row=document.createElement('div');row.className='music-track';
            const name=document.createElement('span');name.className='music-name';name.textContent=`${song.name} · ${song.artist || '未知歌手'} · ${song.source}`;
            const add=document.createElement('button');add.type='button';add.textContent='加入';add.onclick=()=>void run(()=>addOnline([song]));row.append(name,add);list.append(row);
        }
    }
    function renderPlaylists() {
        const select=field('playlist');select.replaceChildren(new Option('全部歌曲',''));
        for(const list of playlists)select.append(new Option(list.title,list.id));select.value=playlistId;
        field('playlist-delete').disabled=!playlistId;
        field('playlist-edit').disabled=!playlistId;
    }
    function savePlaylist(title,trackIds,id='playlist:'+global.crypto.randomUUID()) {
        if(!String(title).trim())throw new Error('请输入歌单名称');
        return serialize(async()=>{
            const available=new Set(await table().where('kind').equals('track').primaryKeys());
            await table().put({id,kind:'playlist',title:String(title).trim(),trackIds:[...new Set(trackIds)].filter(key=>available.has(key))});
            await refresh();return id;
        });
    }
    function editPlaylist(create=false) {
        const saved=create ? null : playlists.find(item=>item.id===playlistId);
        field('playlist-editor').hidden=false;field('playlist-name').value=saved?.title || '';field('playlist-editor').dataset.id=saved?.id || '';
        const list=field('playlist-members');list.replaceChildren();
        for(const track of tracks){const label=document.createElement('label');label.className='music-sharing-check';const input=document.createElement('input');input.type='checkbox';input.value=track.id;input.checked=saved ? saved.trackIds.includes(track.id) : true;label.append(input,document.createTextNode(track.title));list.append(label);}
    }
    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('音频读取失败'));
            reader.readAsDataURL(file);
        });
    }
    async function importFiles(files) {
        return serialize(async () => {
            let added = 0, duplicates = 0;
            const errors = [];
            for (const file of Array.from(files || [])) {
                try {
                    global.MusicCore.validateFile(file);
                    const hash = await global.SharedAssets.digest(file);
                    const id = `music:${hash}`;
                    if (await table().get(id)) { duplicates++; continue; }
                    const fallbackMime = {mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',opus:'audio/ogg'}[file.name.split('.').pop().toLowerCase()];
                    const mime = /^audio\/[\w.+-]+$/.test(file.type) ? file.type : fallbackMime;
                    const dataUrl = await readFile(new Blob([file], {type: mime || 'audio/mpeg'}));
                    await global.dexieDB.transaction('rw', table(), global.dexieDB.sharedAssets, async () => {
                        const asset = await global.SharedAssets.registerExternal({id:`asset:${id}`, type:'audio', name:file.name, mimeType:mime, size:file.size, contentHash:hash, externalStore:'musicLibrary', externalKey:id, permanent:true});
                        await global.SharedAssets.attach(asset.id, {ownerType:'music',ownerId:id,role:'track'});
                        await table().put({id,kind:'track',title:file.name.replace(/\.[^.]+$/, '').slice(0,240),size:file.size,assetId:asset.id,dataUrl});
                        const saved = await table().get('queue');
                        const ids = await table().where('kind').equals('track').primaryKeys();
                        await table().put(global.MusicCore.queue(saved, ids));
                    });
                    added++;
                } catch (error) { errors.push(`${file.name}: ${error.name === 'QuotaExceededError' ? '存储空间不足' : error.message}`); }
            }
            await refresh();
            status(`已导入 ${added} 首，跳过重复 ${duplicates} 首${errors.length ? `；${errors.join('；')}` : ''}`);
            return {added, duplicates, errors};
        });
    }
    async function removeTrack(id) {
        return serialize(async () => {
            const row = await table().get(id);
            if (!row || row.kind !== 'track') return;
            if (sharing?.trackId === id) stopSharing();
            if (queue?.currentId === id) release();
            await global.dexieDB.transaction('rw', table(), global.dexieDB.sharedAssets, async () => {
                if (row.assetId) {
                    await global.SharedAssets.detachOwner('music', id);
                    await global.SharedAssets.setPermanent(row.assetId, false);
                }
                await table().delete(id);
                for(const list of await table().where('kind').equals('playlist').toArray()){
                    if(list.trackIds.includes(id))await table().update(list.id,{trackIds:list.trackIds.filter(key=>key!==id)});
                }
                const ids = await table().where('kind').equals('track').primaryKeys();
                await table().put(global.MusicCore.queue(await table().get('queue'), ids));
            });
            await refresh(); status('已移除本地歌曲及音频；共享资产索引保留为可清理的孤立记录');
        });
    }
    function setup() {
        if (initialized) return;
        initialized = true;
        root().querySelectorAll('[data-music-view]').forEach(button => { button.onclick = () => showView(button.dataset.musicView); });
        root().querySelectorAll('[data-music-toggle]').forEach(button => { button.onclick = () => {
            const panel = field(button.dataset.musicToggle); panel.hidden = !panel.hidden;
            button.setAttribute('aria-expanded', String(!panel.hidden));
        }; });
        field('play').onclick = () => void run(async () => {
            const audio = field('audio');
            if (!audio.paused) pause();
            else if (loadedTrackId === queue?.currentId && url && !audio.error) await audio.play();
            else await play();
        });
        field('seek').oninput = () => { if (Number.isFinite(field('audio').duration)) field('audio').currentTime = Number(field('seek').value); };
        field('volume').oninput = () => { field('audio').volume = Number(field('volume').value); };
        ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'emptied', 'error', 'volumechange'].forEach(name => field('audio').addEventListener(name, renderPlayback));
        field('import').onclick = () => field('files').click();
        field('files').onchange = event => { const files = Array.from(event.target.files); event.target.value = ''; void run(() => importFiles(files)); };
        field('previous').onclick = () => void run(() => step(-1));
        field('next').onclick = () => void run(() => step(1));
        field('mode').onchange=()=>{playMode=field('mode').value;void run(()=>serialize(()=>table().put({id:'settings',kind:'settings',playMode})));};
        field('playlist').onchange=()=>{playlistId=field('playlist').value;tickets.clear();pendingSuggestion=null;render();};
        field('playlist-new').onclick=()=>editPlaylist(true);field('playlist-edit').onclick=()=>editPlaylist(false);
        field('playlist-cancel').onclick=()=>{field('playlist-editor').hidden=true;};
        field('playlist-save').onclick=()=>void run(async()=>{
            const ids=[...field('playlist-members').querySelectorAll('input:checked')].map(input=>input.value);
            await savePlaylist(field('playlist-name').value,ids,field('playlist-editor').dataset.id || undefined);field('playlist-editor').hidden=true;
        });
        field('playlist-delete').onclick=()=>{const id=playlistId;if(id)void run(async()=>{if(await confirmChange('删除歌单','删除这个歌单？歌曲及音频会保留。','删除'))await serialize(async()=>{await table().delete(id);await refresh();});});};
        field('online-search').onclick=()=>void searchOnline();
        field('online-query').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void searchOnline();}};
        field('online-playlist').onclick=()=>void searchOnline('playlist');
        field('online-album').onclick=()=>void searchOnline('album');
        field('url-form').onsubmit=event=>{event.preventDefault();void run(()=>addOnline([{source:'direct',name:field('url-name').value.trim() || '链接歌曲',playUrl:field('url-audio').value.trim(),lyricUrl:field('url-lyrics').value.trim()}]));};
        field('edit-lyrics').onclick=()=>{
            const track=tracks.find(item=>item.id===queue?.currentId);if(!track)return status('请先选择歌曲');
            lyricEditorId=track.id;field('lyric-editor').hidden=false;field('lyric-text').value=track.lyrics?.raw || '';
        };
        field('save-lyrics').onclick=()=>void run(async()=>{
            const raw=field('lyric-text').value;
            const name=/\[\d{1,3}:[0-5]\d/.test(raw) ? '手动歌词.lrc' : '手动歌词.txt';
            await saveLyrics(lyricEditorId,{name,raw});field('lyric-editor').hidden=true;
        });
        field('cancel-lyrics').onclick=()=>{field('lyric-editor').hidden=true;};
        field('online-lyrics').onclick=()=>void run(async()=>{
            const track=tracks.find(item=>item.id===queue?.currentId);if(!track?.online)throw new Error('当前是本地歌曲，可粘贴或导入歌词');
            if(track.lyrics && !await confirmChange('替换歌词','替换当前歌曲已有歌词？'))return;
            await loadOnlineLyrics(track.id,track.online,true);
        });
        field('sharing-role').onchange = () => { stopSharing(); };
        field('sharing-lyrics').onchange = stopSharing;
        for(const name of ['sharing-lyric-mode','sharing-auto','sharing-all'])field(name).onchange=()=>{stopSharing();field('candidate-options').hidden=field('sharing-all').checked;};
        field('sharing-start').onclick = () => void run(() => startSharing(field('sharing-role').value, field('sharing-lyrics').checked,[...candidateSelection],{
            lyricMode:field('sharing-lyric-mode').value,autoSwitch:field('sharing-auto').checked,allCandidates:field('sharing-all').checked,
            roleIds:[...field('sharing-others').querySelectorAll('input:checked')].map(input=>input.value)
        }));
        field('sharing-stop').onclick = stopSharing;
        field('import-lyrics').onclick = () => void run(async () => {
            const track = tracks.find(item => item.id === queue?.currentId);
            if (!track || (track.lyrics && !await confirmChange('替换歌词','替换当前歌曲已有歌词？'))) return;
            pickerTrackId = track.id; field('lyric-file').click();
        });
        field('lyric-file').onchange = event => {
            const id = pickerTrackId, file = event.target.files[0]; event.target.value = '';
            if (file && id) void run(() => importLyrics(id, file));
        };
        field('clear-lyrics').onclick = () => {
            const id = queue?.currentId;
            if (id) void run(async () => { if (await confirmChange('清除歌词','清除当前歌曲歌词？音频会保留。','清除')) await saveLyrics(id, null); });
        };
        ['timeupdate','seeking','seeked','loadedmetadata','emptied'].forEach(name => field('audio').addEventListener(name, syncLyrics));
        ['timeupdate','play','pause','seeked','loadedmetadata','emptied'].forEach(name => field('audio').addEventListener(name, renderSharingStatus));
        ['timeupdate','play','pause','seeking','seeked','ended'].forEach(name=>field('audio').addEventListener(name,countListening));
        field('audio').addEventListener('pause',()=>void run(flushListening));
        global.setInterval(()=>void run(flushListening),15000);
        field('audio').onended = () => { void run(() => step(1, true)); };
        field('audio').onerror = () => { if (field('audio').hasAttribute('src')) status('音源无法播放；在线链接可能失效，可重试或重新搜索换源。记录已保留。'); };
        field('account-login').onclick=()=>void run(async()=>{
            const epoch=++accountEpoch;field('account-status').textContent='正在获取二维码…';accountKey='';
            const qr=await global.MioMusicOnline.account.createQrLogin();if(epoch!==accountEpoch)return;
            accountKey=qr.key;field('account-qr').src=/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr.qrimg) ? qr.qrimg : global.MusicCore.remoteUrl(qr.qrimg);
            field('account-qr').hidden=false;field('account-status').textContent='用网易云客户端扫码确认后，点击“检查登录”';
        });
        field('account-check').onclick=()=>void run(async()=>{
            if(!accountKey)throw new Error('请先获取登录二维码');const epoch=accountEpoch;
            const result=await global.MioMusicOnline.account.checkQrLogin(accountKey);if(epoch!==accountEpoch)return;
            field('account-status').textContent=result.code===803 ? '已登录，可加载我的歌单' : result.code===800 ? '二维码已过期，请重新获取' : '等待手机扫码确认';
            if(result.code===803){field('account-qr').hidden=true;accountKey='';}
        });
        field('account-logout').onclick=()=>{accountEpoch++;accountKey='';global.MioMusicOnline.account.clearSession();field('account-qr').hidden=true;field('account-playlists').replaceChildren();field('account-status').textContent='已清除本页账号会话，歌曲保留';};
        field('account-load').onclick=()=>void run(async()=>{
            const epoch=accountEpoch;const lists=await global.MioMusicOnline.account.getUserPlaylists();if(epoch!==accountEpoch)return;
            const panel=field('account-playlists');panel.replaceChildren();
            for(const item of lists){const button=document.createElement('button');button.type='button';button.textContent=item.name || '歌单';
                button.onclick=()=>void run(async()=>{const songs=await global.MioMusicOnline.account.getUserPlaylistTracks(item.id);if(epoch===accountEpoch){renderOnlineResults(songs);showView('search');}});panel.append(button);}
        });
        if(global.navigator?.mediaSession)for(const [action,handler] of Object.entries({play:()=>void run(()=>field('audio').play()),pause,previoustrack:()=>void run(()=>step(-1)),nexttrack:()=>void run(()=>step(1)),seekto:event=>{if(Number.isFinite(event.seekTime))field('audio').currentTime=event.seekTime;}})){
            try{global.navigator.mediaSession.setActionHandler(action,handler);}catch(_){/* Browser does not implement this action. */}
        }
        global.addEventListener('pagehide', pause);
        global.addEventListener('pagehide', stopSharing);
    }
    async function open(options = {}) {
        setup();
        const back = root()?.querySelector('.back-btn');
        if (back) back.dataset.target = options.returnTarget || 'home-screen';
        switchScreen('music-screen');
        await writes;
        const settings=await table().get('settings');playMode=['sequence','loop','single','shuffle'].includes(settings?.playMode) ? settings.playMode : 'sequence';field('mode').value=playMode;
        await refresh();
        if (options.roleId && roles().some(role => String(role.id) === String(options.roleId))) {
            field('sharing-role').value = String(options.roleId);
            showView('together');
            renderSharingStatus();
        }
        // Returning from chat must keep the current media snapshot and pending suggestion.
        if (queue.currentId && (loadedTrackId !== queue.currentId || !url)) await select(queue.currentId);
    }
    global.MioMusic = Object.freeze({ open: options => run(() => open(options)), pause, importFiles, addOnline, loadOnlineLyrics, saveLyrics, savePlaylist, flushListening, removeTrack, play, step, refresh, importLyrics, clearLyrics: id => saveLyrics(id, null), startSharing, stopSharing, getPromptBlock, prepareChatContext, receiveSuggestion, acceptSuggestion, rejectSuggestion });
})(window);
