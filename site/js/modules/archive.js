// --- 记忆存档库模块 ---
// 保存/读取/删除当前角色的聊天设置、长期记忆与聊天记录快照

var currentArchiveCharacterId = null;
var archiveMultiSelectMode = false;
var selectedArchiveIds = new Set();
var archiveReturnScreen = 'chat-settings-screen';

// Transient identity only: recall consumers load after startup; no archive data is changed.
window.ChatArchiveIdentity = (() => {
    const epochs = new WeakMap();
    const key = character => JSON.stringify([character.id, String(character.chatArchiveScopeId || ''), epochs.get(character) || 0]);
    function capture(character, readOnly = false) {
        const live = character && db.characters?.find(item => item.id === character.id);
        // Token previews use copies; only synchronous readers may resolve a same-archive copy.
        if (!live || !readOnly && live !== character || String(live.chatArchiveScopeId || '') !== String(character.chatArchiveScopeId || '')) return null;
        return { character:live, characterId:live.id, scope:String(live.chatArchiveScopeId || ''), key:key(live) };
    }
    function isCurrent(identity) {
        return !!identity && db.characters?.find(item => item.id === identity.characterId) === identity.character
            && key(identity.character) === identity.key;
    }
    function invalidate(character) { if (character) epochs.set(character, (epochs.get(character) || 0) + 1); }
    return { capture, isCurrent, invalidate };
})();

function openArchiveLibrary(characterId = null, origin = 'more-screen') {
    archiveReturnScreen = origin === 'more-screen' ? origin : 'chat-settings-screen';
    const preferred = [characterId, currentArchiveCharacterId, typeof currentChatId === 'undefined' ? null : currentChatId];
    currentArchiveCharacterId = preferred.map(id => db.characters.find(c => id != null && c.id === id)).find(Boolean)?.id ?? db.characters[0]?.id ?? null;
    selectedArchiveIds.clear(); archiveMultiSelectMode = false;
    const screen = document.getElementById('archive-screen');
    screen.querySelector('.back-btn').dataset.target = archiveReturnScreen;
    let row = screen.querySelector('[data-archive-picker]');
    if (!row) {
        row = document.createElement('label'); row.dataset.archivePicker = ''; row.className = 'kkt-item';
        const text = document.createElement('span'); text.textContent = '角色'; text.className = 'kkt-item-label';
        const select = document.createElement('select'); select.setAttribute('aria-label', '存档所属角色');
        row.append(text, select); screen.querySelector('main').prepend(row);
        select.onchange = () => {
            currentArchiveCharacterId = db.characters.find(c => String(c.id) === select.value)?.id ?? null;
            selectedArchiveIds.clear(); archiveMultiSelectMode = false;
            renderArchiveList(); updateArchiveMultiSelectUI();
        };
    }
    row.hidden = archiveReturnScreen !== 'more-screen';
    const select = row.querySelector('select');
    select.replaceChildren(new Option('选择角色', ''), ...db.characters.map(c => new Option(c.remarkName || c.realName || c.name || '角色', String(c.id))));
    select.value = currentArchiveCharacterId == null ? '' : String(currentArchiveCharacterId);
    renderArchiveList(); updateArchiveMultiSelectUI(); switchScreen('archive-screen');
}

function archiveCharacterId() {
    return currentArchiveCharacterId ?? (archiveReturnScreen === 'more-screen' ? null : currentChatId);
}

function getArchivesForCharacter(characterId) {
    if (!db.archives) return [];
    return db.archives.filter(a => a.characterId === characterId).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function createChatArchiveScopeId() {
    if (globalThis.crypto?.randomUUID) return `chat_${globalThis.crypto.randomUUID()}`;
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Start a new chat archive without touching persona/settings or deleting records owned by older archives.
// Independent memory stores use chatArchiveScopeId as their read boundary.
function resetCharacterForNewArchive(character) {
    if (!character) return '';
    window.ChatArchiveIdentity.invalidate(character);
    character.chatArchiveScopeId = createChatArchiveScopeId();
    character.history = [];
    character.tokens = 0;
    if (character.memory) {
        character.memory.journal = [];
        character.memory.context = '';
    }
    character.memoryJournals = [];
    character.nodes = [];
    character.activeNodeId = null;
    character.chatHistory = [];
    character.messages = [];
    character.chatContext = '';
    character.chatSummary = '';
    character.autoJournalState = 'idle';
    character.autoJournalPending = false;
    character.memoryPalaceArchiveState = {};
    character.memoryPalaceGovernanceError = '';
    character.memoryPalaceGovernanceRetryAt = 0;
    character.memoryPalaceLastGovernanceDay = '';
    if (character.memoryTables && typeof character.memoryTables === 'object') {
        character.memoryTables.data = {};
        character.memoryTables.history = [];
        character.memoryTables.lastChangedFieldPaths = [];
        character.memoryTables.lastUpdateMsgId = null;
        character.memoryTables.lastUpdateMsgTimestamp = null;
        character.memoryTables.autoUpdateState = 'idle';
        character.memoryTables.autoUpdatePending = false;
    }
    if (character.vectorMemory && typeof character.vectorMemory === 'object') {
        character.vectorMemory.entries = [];
        character.vectorMemory.history = [];
        character.vectorMemory.lastSummarizedMsgId = null;
        character.vectorMemory.lastSummarizedMsgTimestamp = null;
        character.vectorMemory.lastContextBlock = '';
        character.vectorMemory.lastRetrievedEntryIds = [];
        character.vectorMemory.lastQueryText = '';
        character.vectorMemory.lastPreparedAt = null;
        character.vectorMemory.lastCacheKey = '';
        character.vectorMemory.lastRetrievalMode = '';
        character.vectorMemory.autoSummaryState = 'idle';
        character.vectorMemory.autoSummaryPending = false;
    }

    character.blockHistory = [];
    character.friendRequests = [];
    character.charBlockHistory = [];
    character.userFriendRequests = [];
    character.isBlocked = false;
    character.blockedAt = null;
    character.blockReapply = null;
    character.isBlockedByChar = false;
    character.blockedByCharAt = null;
    character.blockedByCharReason = null;
    return character.chatArchiveScopeId;
}

async function createArchive(characterId, archiveName) {
    const character = db.characters.find(c => c.id === characterId);
    if (!character) {
        showToast('角色不存在');
        return;
    }
    const name = (archiveName || '').trim() || `存档_${new Date().toLocaleString('zh-CN')}`;
    const archive = {
        id: `archive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: name,
        timestamp: Date.now(),
        characterId: characterId,
        snapshot: JSON.parse(JSON.stringify(character))
    };
    if (!db.archives) db.archives = [];
    db.archives.push(archive);
    if (await saveData() === false) {
        db.archives = db.archives.filter(item => item !== archive);
        return false;
    }
    showToast('存档保存成功！');
    renderArchiveList();
    updateArchiveMultiSelectUI();
}

async function loadArchive(archiveId) {
    const archive = db.archives.find(a => a.id === archiveId);
    if (!archive) {
        showToast('存档不存在');
        return;
    }
    const characterIndex = db.characters.findIndex(c => c.id === archive.characterId);
    if (characterIndex === -1) {
        showToast('原角色已被删除，无法读取');
        return;
    }
    const snapshot = JSON.parse(JSON.stringify(archive.snapshot));
    const previous = db.characters[characterIndex];
    window.ChatArchiveIdentity.invalidate(previous);
    // Old archives predate room layouts and must not erase current custom-room references.
    if (!Object.hasOwn(snapshot, 'memoryPalaceRoomLayout') && previous.memoryPalaceRoomLayout !== undefined) {
        snapshot.memoryPalaceRoomLayout = JSON.parse(JSON.stringify(previous.memoryPalaceRoomLayout));
    }
    const persisted = await dexieDB.characters.get(archive.characterId);
    const restoredChar = window.WalletStorage ? window.WalletStorage.protectChat(snapshot,persisted || previous,true) : snapshot;
    restoredChar.id = archive.characterId;
    // Restore against the current chat version, not the historical snapshot's write token.
    restoredChar._chatSaveRevision = previous._chatSaveRevision;
    restoredChar._statusStorageRevision = previous._statusStorageRevision;
    db.characters[characterIndex] = restoredChar;
    try {
        if (await window.saveCharacter(archive.characterId) === false) throw Error('存档读取未保存，请重试');
    } catch (error) {
        if (db.characters[characterIndex] === restoredChar) db.characters[characterIndex] = previous;
        showToast(error.message || '存档读取失败');
        return false;
    }
    if (currentChatId === archive.characterId && typeof renderMessages === 'function') {
        renderMessages();
    }
    if (typeof renderChatList === 'function') renderChatList();
    showToast('存档已读取，当前状态已覆盖');
    if (archiveReturnScreen === 'more-screen') renderArchiveList();
    else switchScreen('chat-settings-screen');
    return true;
}

async function deleteArchives(archiveIds) {
    if (!archiveIds || archiveIds.length === 0) return;
    const removed = db.archives.filter(archive => archiveIds.includes(archive.id));
    for (const character of db.characters) {
        if (removed.some(archive => archive.characterId === character.id
            && String(archive.snapshot?.chatArchiveScopeId || '') === String(character.chatArchiveScopeId || ''))) window.ChatArchiveIdentity.invalidate(character);
    }
    db.archives = db.archives.filter(a => !archiveIds.includes(a.id));
    if (dexieDB.archives) await dexieDB.archives.bulkDelete(archiveIds);
    await saveData();
    selectedArchiveIds.clear();
    archiveMultiSelectMode = false;
    renderArchiveList();
    updateArchiveMultiSelectUI();
    showToast(`已删除 ${archiveIds.length} 个存档`);
}

function renameArchive(archiveId, newName) {
    const archive = db.archives.find(a => a.id === archiveId);
    if (!archive) return;
    const trimmed = (newName || '').trim();
    if (!trimmed) return;
    archive.name = trimmed;
    saveData();
    renderArchiveList();
}

function renderArchiveList() {
    const container = document.getElementById('archive-list-container');
    const placeholder = document.getElementById('no-archives-placeholder');
    const multiBar = document.getElementById('archive-multi-select-bar');
    if (!container) return;
    const cid = archiveCharacterId();
    document.getElementById('create-archive-btn').disabled = !db.characters.some(c => c.id === cid);
    const list = getArchivesForCharacter(cid);
    if (list.length === 0) {
        container.innerHTML = '';
        if (placeholder) placeholder.style.display = 'block';
        if (placeholder) placeholder.textContent = cid != null ? '还没有保存任何存档' : '请选择要查看存档的角色';
        if (multiBar) multiBar.classList.remove('visible');
        return;
    }
    if (placeholder) placeholder.style.display = 'none';
    container.innerHTML = list.map(arch => {
        const timeStr = arch.timestamp ? new Date(arch.timestamp).toLocaleString('zh-CN') : '';
        const msgCount = (arch.snapshot && arch.snapshot.history) ? arch.snapshot.history.length : 0;
        const isSelected = selectedArchiveIds.has(arch.id);
        const itemClass = archiveMultiSelectMode ? 'archive-item selectable' : 'archive-item';
        const checkClass = isSelected ? 'archive-checkbox checked' : 'archive-checkbox';
        return `
            <li class="${itemClass}" data-archive-id="${arch.id}">
                ${archiveMultiSelectMode ? `<span class="${checkClass}" data-archive-id="${arch.id}"></span>` : ''}
                <div class="archive-item-main">
                    <div class="archive-item-header">
                        <span class="archive-name">${escapeHtml(arch.name)}</span>
                    </div>
                    <div class="archive-timestamp">${timeStr}</div>
                    <div class="archive-stats">聊天记录 ${msgCount} 条</div>
                    ${!archiveMultiSelectMode ? `
                    <div class="archive-actions">
                        <button type="button" class="archive-btn archive-btn-load" data-action="load" data-archive-id="${arch.id}">读取</button>
                        <button type="button" class="archive-btn archive-btn-rename" data-action="rename" data-archive-id="${arch.id}">重命名</button>
                        <button type="button" class="archive-btn archive-btn-delete" data-action="delete" data-archive-id="${arch.id}">删除</button>
                    </div>
                    ` : ''}
                </div>
            </li>
        `;
    }).join('');
    if (list.length > 0 && archiveMultiSelectMode && multiBar) multiBar.classList.add('visible');
    bindArchiveListEvents();
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function bindArchiveListEvents() {
    const container = document.getElementById('archive-list-container');
    if (!container) return;
    container.querySelectorAll('.archive-item').forEach(el => {
        const archiveId = el.getAttribute('data-archive-id');
        if (archiveMultiSelectMode) {
            el.addEventListener('click', (e) => {
                const item = e.target.closest('.archive-item');
                const id = item ? item.getAttribute('data-archive-id') : archiveId;
                if (id) toggleArchiveSelection(id);
            });
        } else {
            container.querySelectorAll(`[data-action="load"][data-archive-id="${archiveId}"]`).forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (await showAppConfirmDialog({ title: '读取存档', message: '读取此存档将覆盖当前聊天记录与设置，是否继续？', confirmText: '读取', dismissText: '' }) !== 'confirm') return;
                    loadArchive(archiveId);
                });
            });
            container.querySelectorAll(`[data-action="rename"][data-archive-id="${archiveId}"]`).forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const arch = db.archives.find(a => a.id === archiveId);
                    const result = await showAppFormDialog({ title: '重命名存档', fields: [{ name: 'name', label: '存档名称', value: arch?.name || '', required: true }], confirmText: '保存' });
                    if (result) renameArchive(archiveId, result.name);
                });
            });
            container.querySelectorAll(`[data-action="delete"][data-archive-id="${archiveId}"]`).forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (await showAppConfirmDialog({ title: '删除存档', message: '确定删除该存档？当前聊天记录不受影响。', confirmText: '删除', dismissText: '' }) !== 'confirm') return;
                    deleteArchives([archiveId]);
                });
            });
        }
    });
}

function toggleArchiveSelection(archiveId) {
    if (selectedArchiveIds.has(archiveId)) {
        selectedArchiveIds.delete(archiveId);
    } else {
        selectedArchiveIds.add(archiveId);
    }
    updateArchiveSelectionUI();
}

function updateArchiveSelectionUI() {
    document.querySelectorAll('.archive-item .archive-checkbox').forEach(cb => {
        const id = cb.getAttribute('data-archive-id');
        cb.classList.toggle('checked', selectedArchiveIds.has(id));
    });
    const bar = document.getElementById('archive-multi-select-bar');
    const countEl = document.getElementById('archive-selected-count');
    if (countEl) countEl.textContent = selectedArchiveIds.size;
    if (bar) {
        const deleteBtn = bar.querySelector('#archive-multi-delete-btn');
        if (deleteBtn) deleteBtn.disabled = selectedArchiveIds.size === 0;
    }
}

function updateArchiveMultiSelectUI() {
    const btn = document.getElementById('archive-multi-select-btn');
    const bar = document.getElementById('archive-multi-select-bar');
    if (btn) {
        btn.textContent = archiveMultiSelectMode ? '取消' : '多选';
        btn.setAttribute('aria-pressed', String(archiveMultiSelectMode));
        btn.disabled = getArchivesForCharacter(archiveCharacterId()).length === 0;
    }
    updateArchiveSelectionUI();
    if (bar) bar.classList.toggle('visible', archiveMultiSelectMode && getArchivesForCharacter(archiveCharacterId()).length > 0);
}

function setupArchiveApp() {
    const openBtn = document.getElementById('open-archive-library-btn');
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            openArchiveLibrary(currentChatId, 'chat-settings-screen');
        });
    }

    const backBtn = document.querySelector('#archive-screen .back-btn');
    if (backBtn) {
        backBtn.setAttribute('data-target', 'chat-settings-screen');
    }

    const createBtn = document.getElementById('create-archive-btn');
    const createModal = document.getElementById('create-archive-modal');
    const createForm = document.getElementById('create-archive-form');
    const nameInput = document.getElementById('archive-name-input');
    const msgCountEl = document.getElementById('current-message-count');

    if (createBtn && createModal) {
        createBtn.addEventListener('click', () => {
            const cid = archiveCharacterId();
            if (cid == null) {
                showToast('请先进入一个角色的聊天');
                return;
            }
            const char = db.characters.find(c => c.id === cid);
            if (msgCountEl && char) msgCountEl.textContent = (char.history && char.history.length) || 0;
            if (nameInput) nameInput.value = '';
            createModal.classList.add('visible');
        });
    }

    if (createForm) {
        createForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const cid = archiveCharacterId();
            const name = nameInput ? nameInput.value.trim() : '';
            createModal.classList.remove('visible');
            await createArchive(cid, name || undefined);
        });
    }

    const cancelArchiveBtn = document.getElementById('cancel-archive-btn');
    if (cancelArchiveBtn && createModal) {
        cancelArchiveBtn.addEventListener('click', () => createModal.classList.remove('visible'));
    }

    const multiSelectBtn = document.getElementById('archive-multi-select-btn');
    if (multiSelectBtn) {
        multiSelectBtn.addEventListener('click', () => {
            archiveMultiSelectMode = !archiveMultiSelectMode;
            if (!archiveMultiSelectMode) selectedArchiveIds.clear();
            renderArchiveList();
            updateArchiveMultiSelectUI();
        });
    }

    const multiDeleteBtn = document.getElementById('archive-multi-delete-btn');
    if (multiDeleteBtn) {
        multiDeleteBtn.addEventListener('click', async () => {
            if (selectedArchiveIds.size === 0) return;
            const ids = Array.from(selectedArchiveIds);
            if (await showAppConfirmDialog({ title: '删除存档', message: `确定删除选中的 ${ids.length} 个存档？当前聊天记录不受影响。`, confirmText: '删除', dismissText: '' }) !== 'confirm') return;
            await deleteArchives(ids);
        });
    }

    const cancelMultiBtn = document.getElementById('archive-cancel-multi-btn');
    if (cancelMultiBtn) {
        cancelMultiBtn.addEventListener('click', () => {
            archiveMultiSelectMode = false;
            selectedArchiveIds.clear();
            renderArchiveList();
            updateArchiveMultiSelectUI();
        });
    }
}
