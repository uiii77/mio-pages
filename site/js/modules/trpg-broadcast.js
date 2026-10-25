(function attachTrpgBroadcastModule(global) {
    'use strict';

    const state = {
        session: null,
        currentIndex: -1,
        playing: false,
        request: 0,
        busy: false,
        notice: '',
    };

    const core = () => global.TRPGBroadcastCore;
    const service = () => global.TTSService || global.MinimaxTTSService || null;
    const byId = id => global.document?.getElementById(id);
    const notify = message => { if (typeof global.showToast === 'function') global.showToast(message); };
    const makeId = () => `trpg-session:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const makeEntryId = () => `trpg-entry:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    function characterList() {
        return Array.isArray(global.db?.characters) ? global.db.characters : [];
    }

    function characterName(character) {
        return character?.name || character?.charName || character?.nickname || '角色';
    }

    function getSpeakerConfig(value) {
        const [type, id] = String(value || 'narrator').split(':');
        if (type !== 'character' || !id) {
            const cfg = service()?.config || {};
            return {
                speakerType: 'narrator',
                speakerId: '',
                speakerName: '旁白',
                voiceId: cfg.provider === 'elevenlabs' ? (cfg.elevenVoiceId || '') : 'female-shaonv',
                language: 'auto',
                speed: 1,
                voiceConfig: {},
            };
        }
        const character = characterList().find(item => String(item.id) === id);
        const voice = global.VoiceSelector?.getVoiceConfig?.(id, 'char') || {};
        return {
            speakerType: 'character',
            speakerId: id,
            speakerName: characterName(character),
            voiceId: voice.voiceId || '',
            language: voice.language || 'auto',
            speed: voice.speed || 1,
            voiceConfig: { ...(character?.ttsConfig || {}), ...voice },
        };
    }

    function session() {
        if (!state.session) state.session = core().normalizeSession({ id: makeId() });
        return state.session;
    }

    function playbackState() {
        return service()?.getPlayState?.() || { currentPlayKey: '', isPlaying: false, isPaused: false };
    }

    function renderSpeakerOptions() {
        const select = byId('trpg-broadcast-speaker');
        if (!select) return;
        const current = select.value || 'narrator';
        select.replaceChildren();
        const narrator = document.createElement('option');
        narrator.value = 'narrator';
        narrator.textContent = '旁白';
        select.appendChild(narrator);
        characterList().forEach(character => {
            const option = document.createElement('option');
            option.value = `character:${String(character.id)}`;
            option.textContent = characterName(character);
            select.appendChild(option);
        });
        select.value = [...select.options].some(option => option.value === current) ? current : 'narrator';
        renderSpeakerNote();
    }

    function renderSpeakerNote() {
        const note = byId('trpg-broadcast-speaker-note');
        if (!note) return;
        const config = getSpeakerConfig(byId('trpg-broadcast-speaker')?.value);
        note.textContent = config.speakerType === 'character'
            ? `${config.speakerName}：使用角色已配置音色${config.voiceId ? '' : '（当前未设置音色，将由 TTS 服务决定）'}`
            : '旁白使用独立的默认播报音色；不会写入角色或聊天配置。';
    }

    function entryStatus(index) {
        if (!state.playing) return '';
        if (index === state.currentIndex) return playbackState().isPaused ? '已暂停' : '正在播放';
        if (index < state.currentIndex) return '已播报';
        return '等待中';
    }

    function renderQueue() {
        const list = byId('trpg-broadcast-queue');
        const empty = byId('trpg-broadcast-empty');
        const currentSession = session();
        if (!list) return;
        list.replaceChildren();
        if (empty) empty.hidden = currentSession.entries.length > 0;
        currentSession.entries.forEach((entry, index) => {
            const item = document.createElement('article');
            item.className = `trpg-broadcast-entry${index === state.currentIndex ? ' is-active' : ''}`;
            item.dataset.trpgEntry = entry.id;
            const header = document.createElement('div');
            header.className = 'trpg-broadcast-entry-header';
            const speaker = document.createElement('strong');
            speaker.textContent = entry.speakerName;
            const status = document.createElement('small');
            status.textContent = entryStatus(index);
            header.append(speaker, status);
            const content = document.createElement('p');
            content.textContent = entry.text || '（空文本）';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'trpg-broadcast-entry-remove';
            remove.dataset.trpgRemoveEntry = entry.id;
            remove.textContent = '移除';
            item.append(header, content, remove);
            list.appendChild(item);
        });
        const count = byId('trpg-broadcast-count');
        if (count) count.textContent = `${currentSession.entries.length} / ${core().MAX_ENTRIES} 条`;
    }

    function renderControls() {
        const play = byId('trpg-broadcast-play-btn');
        const pause = byId('trpg-broadcast-pause-btn');
        const stop = byId('trpg-broadcast-stop-btn');
        const clear = byId('trpg-broadcast-clear-btn');
        const current = playbackState();
        const active = state.playing && state.currentIndex >= 0 && current.isPlaying;
        if (play) play.disabled = state.busy || !session().entries.some(entry => entry.text);
        if (pause) {
            pause.disabled = !active;
            pause.textContent = current.isPaused ? '继续播放' : '暂停播放';
        }
        if (stop) stop.disabled = !state.playing && !current.isPlaying;
        if (clear) clear.disabled = state.busy || !session().entries.length;
        const status = byId('trpg-broadcast-status');
        if (status && !state.busy) {
            status.textContent = state.playing
                ? (active ? `${session().entries[state.currentIndex]?.speakerName || '当前条目'}：${current.isPaused ? '已暂停' : '播放中'}` : '播报已结束')
                : (state.notice || (session().entries.length ? '队列已就绪；播放内容仅来自本页手动添加的条目。' : '请先添加旁白或角色台词。'));
        }
    }

    function render() {
        const title = byId('trpg-broadcast-session-title');
        if (title && document.activeElement !== title) title.value = session().title;
        renderSpeakerOptions();
        renderQueue();
        renderControls();
    }

    function setBusy(value, message = '') {
        state.busy = !!value;
        if (message) state.notice = message;
        const status = byId('trpg-broadcast-status');
        if (status && message) status.textContent = message;
        renderControls();
    }

    function stop() {
        state.request += 1;
        state.playing = false;
        state.currentIndex = -1;
        state.busy = false;
        state.notice = '';
        service()?.stop?.();
        renderQueue();
        renderControls();
    }

    function togglePause() {
        if (!state.playing || state.currentIndex < 0) return;
        service()?.togglePause?.();
        renderQueue();
        renderControls();
    }

    async function playQueue() {
        const tts = service();
        const entries = session().entries.filter(entry => core().hasPlayableText(entry));
        if (!entries.length) return notify('请先添加有内容的播报条目');
        if (!tts?.synthesizeAndPlay) return notify('TTS 服务尚未就绪，请重新打开 Mio');
        if (!tts.isConfigured?.()) return notify('请先在 TTS 设置中完成配置');

        if (state.playing && state.currentIndex >= 0 && playbackState().isPlaying) {
            togglePause();
            return;
        }

        stop();
        const request = ++state.request;
        state.playing = true;
        setBusy(true, '正在准备 TRPG 播报…');
        try {
            for (let index = 0; index < entries.length; index += 1) {
                if (request !== state.request) return;
                const entry = entries[index];
                const originalIndex = session().entries.indexOf(entry);
                state.currentIndex = originalIndex;
                renderQueue();
                renderControls();
                const key = core().makePlaybackKey(session().id, entry.id);
                const completed = await tts.synthesizeAndPlay(entry.text, entry.voiceId, entry.language, {
                    speed: entry.speed,
                    playKey: key,
                    chatId: `trpg:${session().id}`,
                    messageId: key,
                    voiceConfig: entry.voiceConfig || {},
                });
                if (request !== state.request || completed === false) return;
            }
            if (request === state.request) setBusy(false, '本轮 TRPG 播报已完成。');
        } catch (error) {
            if (request === state.request) {
                setBusy(false, error?.message || 'TRPG 播报失败');
                notify(error?.message || 'TRPG 播报失败');
            }
        } finally {
            if (request === state.request) {
                state.playing = false;
                state.currentIndex = -1;
                renderQueue();
                renderControls();
            }
        }
    }

    function addEntry() {
        const currentSession = session();
        if (currentSession.entries.length >= core().MAX_ENTRIES) return notify(`最多添加 ${core().MAX_ENTRIES} 条播报`);
        const input = byId('trpg-broadcast-text');
        const content = String(input?.value || '').trim();
        if (!content) return notify('请输入旁白或角色台词');
        const speaker = getSpeakerConfig(byId('trpg-broadcast-speaker')?.value);
        currentSession.entries.push(core().normalizeEntry({ ...speaker, id: makeEntryId(), text: content }));
        currentSession.updatedAt = Date.now();
        if (!String(byId('trpg-broadcast-session-title')?.value || '').trim()) {
            currentSession.title = currentSession.entries.length === 1 ? `${speaker.speakerName}的 TRPG 播报` : currentSession.title;
        }
        if (input) input.value = '';
        state.notice = '';
        render();
    }

    function removeEntry(id) {
        const currentSession = session();
        const index = currentSession.entries.findIndex(entry => entry.id === id);
        if (index < 0) return;
        if (state.playing && index === state.currentIndex) stop();
        currentSession.entries.splice(index, 1);
        currentSession.updatedAt = Date.now();
        if (state.currentIndex > index) state.currentIndex -= 1;
        renderQueue();
        renderControls();
    }

    function newSession() {
        stop();
        state.session = core().normalizeSession({ id: makeId() });
        state.notice = '';
        render();
        notify('已新建 TRPG 播报会话');
    }

    function prepareText(text) {
        const input = byId('trpg-broadcast-text');
        if (!input) throw new Error('播报编辑器未就绪');
        if (input.value.trim() && !global.confirm('替换当前尚未加入队列的播报草稿？')) return false;
        input.value = String(text || '').slice(0, 4000);
        input.focus();
        return true;
    }
    function open(options = {}) {
        session();
        const back = byId('trpg-broadcast-screen')?.querySelector('.back-btn');
        if (back) back.dataset.target = options.returnTarget === 'chat-room-screen' ? 'chat-room-screen' : 'home-screen';
        if (typeof global.switchScreen === 'function') global.switchScreen('trpg-broadcast-screen');
        else {
            try { if (typeof switchScreen === 'function') switchScreen('trpg-broadcast-screen'); } catch (_) { /* lexical binding unavailable */ }
        }
        render();
    }

    function setup() {
        global.CoC7?.setup();
        global.TrpgLibrary?.setup();
        byId('trpg-broadcast-speaker')?.addEventListener('change', renderSpeakerNote);
        byId('trpg-broadcast-add-btn')?.addEventListener('click', addEntry);
        byId('trpg-broadcast-play-btn')?.addEventListener('click', () => void playQueue());
        byId('trpg-broadcast-pause-btn')?.addEventListener('click', togglePause);
        byId('trpg-broadcast-stop-btn')?.addEventListener('click', stop);
        byId('trpg-broadcast-clear-btn')?.addEventListener('click', () => { stop(); state.session.entries = []; render(); });
        byId('trpg-broadcast-new-btn')?.addEventListener('click', newSession);
        byId('trpg-broadcast-session-title')?.addEventListener('input', event => {
            session().title = String(event.target.value || '').trim().slice(0, 120) || '未命名 TRPG 播报';
            session().updatedAt = Date.now();
        });
        byId('trpg-broadcast-queue')?.addEventListener('click', event => {
            const remove = event.target.closest('[data-trpg-remove-entry]');
            if (remove) removeEntry(remove.dataset.trpgRemoveEntry);
        });
        global.document?.addEventListener('ttsStateChange', renderControls);
        render();
    }

    global.TRPGBroadcast = Object.freeze({ VERSION: 1, setup, open, stop, render, newSession, prepareText });
})(window);
