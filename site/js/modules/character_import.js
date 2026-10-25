// --- 角色导入与创建模块 ---

let pendingImportData = null;

function setupAddCharModal() {
    document.getElementById('add-char-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newChar = {
            peekData: {},
            id: `char_${Date.now()}`,
            realName: document.getElementById('char-real-name').value,
            remarkName: document.getElementById('char-remark-name').value,
            persona: document.getElementById('char-persona-input').value || '',
            birthday: document.getElementById('char-birthday') ? document.getElementById('char-birthday').value : '',
            enableDynamicAge: document.getElementById('char-enable-dynamic-age') ? document.getElementById('char-enable-dynamic-age').checked : false,
            avatar: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg',
            myName: document.getElementById('my-name-for-char').value || 'user',
            myPersona: '',
            myAvatar: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg',
            theme: 'white_pink',
            maxMemory: 100,
            chatBg: '',
            history: [],
            pokeEnabled: false,
            isPinned: false,
            status: '在线',
            worldBookIds: [],
            useCustomBubbleCss: false,
            customBubbleCss: '',
            bilingualBubbleStyle: 'under',
            unreadCount: 0,
            memoryJournals: [],
            journalWorldBookIds: [],
            peekScreenSettings: { wallpaper: '', customIcons: {}, unlockAvatar: '' },
            lastUserMessageTimestamp: null,
            statusPanel: {
                enabled: false,
                promptSuffix: '',
                regexPattern: '',
                replacePattern: '',
                historyLimit: 3,
                historyRetentionLimit: 20,
                currentStatusRaw: '',
                currentStatusHtml: '',
                history: []
            },
            autoReply: {
                enabled: false,
                interval: 60,
                lastTriggerTime: 0
            },
            followUpReply: {
                enabled: false,
                delayMode: 'random',
                fixedDelayMinutes: 120,
                minDelayMinutes: 60,
                maxDelayMinutes: 180,
                probability: 35,
                maxFollowUps: 1,
                pending: null,
                lastSuccessAt: 0,
                lastDecision: null
            },
            userAvatarLibrary: [],
            charAvatarLibrary: [],
            avatarSystemEnabled: false,
            charSenseAvatarChangeEnabled: false,
            charCanSwitchAvatarEnabled: false,
            charCollectImageAsAvatarEnabled: false,
            coupleAvatarLibrary: [],
            charCollectCoupleAvatarEnabled: false,
            charSenseCoupleAvatarEnabled: false,
            activeCoupleAvatarId: null,
            avatarRelationshipHistory: [],
            showAvatarActionMsg: false,
            phoneControlEnabled: false,
            phoneControlViewLimit: 10,
            phoneControlHistory: []
        };
        db.characters.push(newChar);
        await saveData();
        renderChatList();
        if (typeof renderContactList === 'function') renderContactList();
        document.getElementById('add-char-modal').classList.remove('visible');
        // 重置表单并清除导入提示
        document.getElementById('add-char-form').reset();
        const personaInput = document.getElementById('char-persona-input');
        if (personaInput) personaInput.value = '';
        const hint = document.getElementById('char-persona-import-hint');
        if (hint) hint.style.display = 'none';
        // 隐藏角色描述区块，恢复手动创建原始状态
        const personaGroup = document.getElementById('char-persona-group');
        if (personaGroup) personaGroup.style.display = 'none';
        showToast(`角色“${newChar.remarkName}”创建成功！`);
        promptForBackupIfNeeded('new_char');
        // 批量导入：继续处理队列中剩余文件
        checkAndContinueDocImportQueue();
    });
}

async function handleCharacterImport(file) {
    if (!file) return;
    showToast('正在解析角色卡...');
    try {
        let result;
        if (file.name.toLowerCase().endsWith('.png')) {
            result = await parseCharPng(file);
        } else if (file.name.toLowerCase().endsWith('.json')) {
            result = await parseCharJson(file);
        } else {
            throw new Error('不支持的文件格式。请选择 .png 或 .json 文件。');
        }

        if (result) {
            showImportConfirmModal(result.data, result.avatar);
        }
    } catch (error) {
        console.error('角色卡导入失败:', error);
        showToast(`导入失败: ${error.message}`);
    }
}

function validateCharacterCard(data) {
    const card = data?.data || data;
    if (!card || Array.isArray(card) || typeof card.name !== 'string' || !card.name.trim()) throw new Error('角色卡缺少有效名称');
    if (!['description','persona','personality','scenario','first_mes','mes_example'].some(key => typeof card[key] === 'string')) throw new Error('未找到角色设定，这不是可识别的角色卡');
    for (const key of ['description','persona','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions','creator_notes']) {
        if (card[key] != null && typeof card[key] !== 'string') throw new Error(`角色字段 ${key} 必须是文字`);
    }
    if (card.alternate_greetings != null && (!Array.isArray(card.alternate_greetings) || card.alternate_greetings.some(text => typeof text !== 'string'))) throw new Error('备选开场白格式错误');
    return card;
}

async function parseCharPng(file) {
    if (file.size > 32 * 1024 * 1024) throw new Error('角色卡图片不能超过 32 MB');
    const buffer = await file.arrayBuffer(), bytes = new Uint8Array(buffer), view = new DataView(buffer);
    const signature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 20 || !signature.every((n,i) => bytes[i] === n)) throw new Error('不是有效的 PNG 图片');
    const cards = new Map(); let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        if (length > bytes.length - offset - 12) throw new Error('PNG 数据不完整');
        const type = new TextDecoder().decode(bytes.subarray(offset+4,offset+8));
        if (type === 'tEXt') {
            const chunk = bytes.subarray(offset+8,offset+8+length), zero = chunk.indexOf(0);
            const key = new TextDecoder().decode(chunk.subarray(0,zero));
            if (zero >= 0 && ['chara','ccv3'].includes(key)) {
                if (length > 8 * 1024 * 1024 || cards.has(key)) throw new Error('角色数据过大或包含重复字段');
                let crc = 0xffffffff;
                for (const byte of bytes.subarray(offset+4,offset+8+length)) {
                    crc ^= byte;
                    for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
                }
                if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(offset+8+length)) throw new Error('角色数据校验失败，文件可能已损坏');
                const text = new TextDecoder().decode(chunk.subarray(zero+1));
                cards.set(key, JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(text),c=>c.charCodeAt(0)))));
            }
        }
        offset += length+12;
        if (type === 'IEND') { ended = true; break; }
    }
    if (!ended) throw new Error('PNG 文件未完整结束');
    const data = cards.get('ccv3') || cards.get('chara');
    if (!data) throw new Error('这是普通图片，未包含角色卡数据');
    validateCharacterCard(data);
    const avatar = await new Promise((resolve,reject) => { const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file); });
    return { data, avatar };
}

async function parseCharJson(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error('角色卡 JSON 不能超过 8 MB');
    const data = JSON.parse((await file.text()).replace(/^\uFEFF/,''));
    validateCharacterCard(data);
    return {data, avatar:'https://i.postimg.cc/Y96LPskq/o-o-2.jpg'};
}

async function createCharacterFromData(data, avatar, options) {
    const charData = validateCharacterCard(data);
    const sourceCard = structuredClone(data);
    const newBooks = [];
    const books = [...db.worldBooks];

    if (!charData || !charData.name) {
        throw new Error('角色卡数据无效，缺少角色名称。');
    }

    const newChar = {
        peekData: {},
        id: `char_${crypto.randomUUID()}`,
            realName: charData.name || '未命名',
            remarkName: charData.name || '未命名',
            persona: options?.persona ?? [charData.description || charData.persona, charData.personality && '性格：'+charData.personality, charData.scenario && '情境：'+charData.scenario, charData.mes_example && '示例对话：\n'+charData.mes_example].filter(Boolean).join('\n\n'),
            importedCharacterCard: sourceCard,
            birthday: '',
            enableDynamicAge: false,
            avatar: avatar || 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg',
        myName: 'user',
        myPersona: '',
        myAvatar: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg',
        theme: 'white_pink',
        maxMemory: 100,
        chatBg: '',
        history: [],
        isPinned: false,
        status: '在线',
        worldBookIds: [],
        useCustomBubbleCss: false,
        customBubbleCss: '',
        bilingualBubbleStyle: 'under',
        unreadCount: 0,
        memoryJournals: [],
        journalWorldBookIds: [],
        peekScreenSettings: { wallpaper: '', customIcons: {}, unlockAvatar: '' },
        lastUserMessageTimestamp: null,
        statusPanel: {
            enabled: false,
            promptSuffix: '',
            regexPattern: '',
            replacePattern: '',
            historyLimit: 3,
            historyRetentionLimit: 20,
            currentStatusRaw: '',
            currentStatusHtml: '',
            history: []
        },
        autoReply: {
            enabled: false,
            interval: 60,
            lastTriggerTime: 0
        },
        followUpReply: {
            enabled: false,
            delayMode: 'random',
            fixedDelayMinutes: 120,
            minDelayMinutes: 60,
            maxDelayMinutes: 180,
            probability: 35,
            maxFollowUps: 1,
            pending: null,
            lastSuccessAt: 0,
            lastDecision: null
        },
        userAvatarLibrary: [],
        charAvatarLibrary: [],
        avatarSystemEnabled: false,
        charSenseAvatarChangeEnabled: false,
        charCanSwitchAvatarEnabled: false,
        charCollectImageAsAvatarEnabled: false,
        coupleAvatarLibrary: [],
        charCollectCoupleAvatarEnabled: false,
        charSenseCoupleAvatarEnabled: false,
        activeCoupleAvatarId: null,
        avatarRelationshipHistory: [],
        showAvatarActionMsg: false
    };

    // 解析开场白：仅在用户选择导入时处理；优先 data.alternate_greetings，否则用 first_mes
    const importGreeting = !(typeof options === 'object' && options && options.importGreeting === false);
    if (importGreeting) {
        const greetings = [...new Set([charData.first_mes, ...(charData.alternate_greetings || [])].filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()))];
        if (greetings.length > 0) {
            newChar.alternateGreetings = greetings;
            newChar.currentGreetingIndex = 0;
            const firstContent = greetings[0];
            newChar.history = [{
                id: `msg_${crypto.randomUUID()}_greeting`,
                role: 'assistant',
                senderId: newChar.id,
                content: firstContent,
                timestamp: Date.now()
            }];
        }
    }

    const importedWorldBookIds = [];

    if (charData.character_book && Array.isArray(charData.character_book.entries)) {
        const categoryName = data.name || charData.name;
        charData.character_book.entries.forEach(entry => {
            if (entry.enabled === false) return;
            const name = entry.comment || entry.name || (entry.keys || []).join('、') || '角色资料';
            const content = entry.content;
            if (name && content) {
                // 策略：内容相同则复用，内容不同则重命名导入
                const exactMatch = books.find(wb => wb.name.toLowerCase() === name.toLowerCase() && wb.content === content);
                if (exactMatch) {
                    if (!importedWorldBookIds.includes(exactMatch.id)) importedWorldBookIds.push(exactMatch.id);
                } else {
                    // 检查是否已经导入过重命名版本
                    const renamedName = `${name} (${categoryName})`;
                    const renamedMatch = books.find(wb => wb.name.toLowerCase() === renamedName.toLowerCase() && wb.content === content);

                    if (renamedMatch) {
                        if (!importedWorldBookIds.includes(renamedMatch.id)) importedWorldBookIds.push(renamedMatch.id);
                    } else {
                        // 需要新建
                        let newBookName = name;
                        const nameConflict = books.find(wb => wb.name.toLowerCase() === name.toLowerCase());
                        if (nameConflict) {
                            newBookName = renamedName;
                            // 二次冲突检查
                            if (books.some(wb => wb.name.toLowerCase() === newBookName.toLowerCase())) {
                                newBookName = `${newBookName}_${Math.random().toString(36).substr(2, 4)}`;
                            }
                        }

                        const newBook = {
                            id: `wb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                            name: newBookName,
                            content: content,
                            position: 'after',
                            category: categoryName
                        };
                        books.push(newBook); newBooks.push(newBook);
                        importedWorldBookIds.push(newBook.id);
                    }
                }
            }
        });
    }
    else {
        const worldInfo = charData.world_info || charData.wi || '';
        if (worldInfo && typeof worldInfo === 'string' && worldInfo.trim() !== '') {
            const entries = worldInfo.split(/\n\s*\n/).filter(entry => entry.trim() !== '');
            entries.forEach(entryText => {
                const lines = entryText.trim().split('\n');
                if (lines.length > 0) {
                    const name = lines[0].trim();
                    const content = lines.slice(1).join('\n').trim();
                    if (name && content) {
                        const categoryName = '导入的角色设定';
                        // 策略：内容相同则复用，内容不同则重命名导入
                        const exactMatch = books.find(wb => wb.name.toLowerCase() === name.toLowerCase() && wb.content === content);
                        if (exactMatch) {
                            if (!importedWorldBookIds.includes(exactMatch.id)) importedWorldBookIds.push(exactMatch.id);
                        } else {
                            // 检查是否已经导入过重命名版本
                            const renamedName = `${name} (${charData.name || '未命名'})`;
                            const renamedMatch = books.find(wb => wb.name.toLowerCase() === renamedName.toLowerCase() && wb.content === content);

                            if (renamedMatch) {
                                if (!importedWorldBookIds.includes(renamedMatch.id)) importedWorldBookIds.push(renamedMatch.id);
                            } else {
                                // 需要新建
                                let newBookName = name;
                                const nameConflict = books.find(wb => wb.name.toLowerCase() === name.toLowerCase());
                                if (nameConflict) {
                                    newBookName = renamedName;
                                    // 二次冲突检查
                                    if (books.some(wb => wb.name.toLowerCase() === newBookName.toLowerCase())) {
                                        newBookName = `${newBookName}_${Math.random().toString(36).substr(2, 4)}`;
                                    }
                                }

                                const newBook = {
                                    id: `wb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                                    name: newBookName,
                                    content: content,
                                    position: 'after',
                                    category: categoryName
                                };
                                books.push(newBook); newBooks.push(newBook);
                                importedWorldBookIds.push(newBook.id);
                            }
                        }
                    }
                }
            });
        }
    }

    if (importedWorldBookIds.length > 0) {
        newChar.worldBookIds = importedWorldBookIds;

    }

    await dexieDB.transaction('rw', dexieDB.characters, dexieDB.worldBooks, async () => {
        await dexieDB.characters.add(newChar);
        if (newBooks.length) await dexieDB.worldBooks.bulkAdd(newBooks);
    });
    db.characters.push(newChar);
    db.worldBooks.push(...newBooks);
    renderChatList();
    if (typeof renderContactList === 'function') renderContactList();
    showToast(`角色“${newChar.remarkName}”导入成功！`);
}

function setupImportConfirmModal() {
    const modal = document.getElementById('import-confirm-modal');
    const form = document.getElementById('import-confirm-form');
    const cancelBtn = document.getElementById('cancel-import-btn');
    const nameInput = document.getElementById('import-char-name');

    if (!modal || !form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!pendingImportData) return;

        const newName = nameInput.value.trim();
        if (!newName) return showToast('请输入角色真名');

        // 更新名字
        if (pendingImportData.data.data) {
            // 适配 V2 格式 (data.data.name)
            pendingImportData.data.data.name = newName;
        } else {
            // 适配 V1 格式 (data.name)
            pendingImportData.data.name = newName;
        }

        const importGreetingCheckbox = document.getElementById('import-greeting-checkbox');
        const importGreeting = importGreetingCheckbox ? importGreetingCheckbox.checked : true;
        const submit = form.querySelector('[type=submit]');
        if (submit.disabled) return;
        submit.disabled = true;
        try {
            await createCharacterFromData(pendingImportData.data, pendingImportData.avatar, { importGreeting, persona: form.querySelector('[name=card-persona]').value });
            modal.classList.remove('visible');
            pendingImportData = null;
        } catch (error) {
            console.error(error);
            showToast('创建角色失败: ' + error.message);
        } finally { submit.disabled = false; }
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('visible');
        pendingImportData = null;
    });
}

function showImportConfirmModal(data, avatar) {
    const modal = document.getElementById('import-confirm-modal');
    const nameInput = document.getElementById('import-char-name');

    if (!modal) return;

    pendingImportData = { data, avatar };

    // 获取原始名字
    let originalName = '';
    if (data.data && data.data.name) {
        originalName = data.data.name;
    } else if (data.name) {
        originalName = data.name;
    }

    const card = validateCharacterCard(data);
    const form = document.getElementById('import-confirm-form');
    form.querySelector('[name=card-persona]').value = [card.description || card.persona,card.personality && '性格：'+card.personality,card.scenario && '情境：'+card.scenario,card.mes_example && '示例对话：\n'+card.mes_example].filter(Boolean).join('\n\n');
    form.querySelector('.card-greeting-preview').textContent = card.first_mes || card.alternate_greetings?.[0] || '无开场白';
    form.querySelector('.card-notes-preview').textContent = card.creator_notes || '';
    form.querySelector('.card-field-summary').textContent = `备选开场白 ${card.alternate_greetings?.length || 0} 条 · 世界资料 ${card.character_book?.entries?.length || 0} 条 · 扩展 ${Object.keys(card.extensions || {}).length} 项`;
    nameInput.value = originalName;
    modal.classList.add('visible');
}

// ============================================================
// 文档导入功能模块 (TXT / DOCX / ZIP)
// ============================================================

// 全局状态：待处理的文档导入队列
let docImportQueue = [];      // [{name, content}, ...]
let docImportCurrentIndex = 0;

/**
 * 打开创建方式选择 Action Sheet
 */
function openCreateCharMethodSheet() {
    const sheet = document.getElementById('create-char-method-sheet');
    if (sheet) sheet.classList.add('visible');
}

/**
 * 设置创建方式 Action Sheet 的事件绑定
 */
function setupCreateCharMethodSheet() {
    const sheet = document.getElementById('create-char-method-sheet');
    if (!sheet) return;

    // 手动创建：打开原有 modal
    document.getElementById('method-manual-btn').addEventListener('click', () => {
        sheet.classList.remove('visible');
        const addCharModal = document.getElementById('add-char-modal');
        const addCharForm = document.getElementById('add-char-form');
        // 清空任何之前的导入内容
        const personaInput = document.getElementById('char-persona-input');
        const hint = document.getElementById('char-persona-import-hint');
        if (personaInput) personaInput.value = '';
        if (hint) hint.style.display = 'none';
        // 手动创建时隐藏角色描述区块，且不启用弹窗滚动条
        const personaGroup = document.getElementById('char-persona-group');
        if (personaGroup) personaGroup.style.display = 'none';
        if (addCharModal) addCharModal.classList.remove('import-mode');
        if (addCharForm) addCharForm.reset();
        if (addCharModal) addCharModal.classList.add('visible');
    });

    // 导入文档
    document.getElementById('method-import-doc-btn').addEventListener('click', () => {
        sheet.classList.remove('visible');
        openDocImportSelectModal();
    });

    // 取消
    document.getElementById('method-cancel-btn').addEventListener('click', () => {
        sheet.classList.remove('visible');
    });

    // 通用角色卡入口，复用解析与预览。
    document.getElementById('method-import-ovo-card-btn').addEventListener('click', () => {
        sheet.classList.remove('visible');
        document.getElementById('character-card-input').click();
    });

    // 点击遮罩关闭
    sheet.addEventListener('click', (e) => {
        if (e.target === sheet) sheet.classList.remove('visible');
    });
}

/**
 * 打开文件选择模态框
 */
function openDocImportSelectModal() {
    const modal = document.getElementById('doc-import-select-modal');
    const fileList = document.getElementById('doc-import-file-list');
    const startBtn = document.getElementById('doc-import-start-btn');
    const fileInput = document.getElementById('doc-import-file-input');
    if (!modal) return;

    // 重置状态
    fileList.innerHTML = '';
    startBtn.disabled = true;
    fileInput.value = '';
    modal.classList.add('visible');
}

/**
 * 设置文档选择模态框交互
 */
function setupDocImportSelectModal() {
    const modal = document.getElementById('doc-import-select-modal');
    if (!modal) return;

    const fileInput = document.getElementById('doc-import-file-input');
    const dropZone = document.getElementById('doc-import-drop-zone');
    const fileList = document.getElementById('doc-import-file-list');
    const startBtn = document.getElementById('doc-import-start-btn');
    const cancelBtn = document.getElementById('doc-import-cancel-btn');
    const closeBtn = document.getElementById('doc-import-close-btn');

    let selectedFiles = [];

    function renderFileList() {
        fileList.innerHTML = '';
        if (selectedFiles.length === 0) {
            startBtn.disabled = true;
            return;
        }
        startBtn.disabled = false;
        selectedFiles.forEach((file, idx) => {
            const ext = file.name.split('.').pop().toLowerCase();
            const icon = ext === 'zip' ? '🗜️' : ext === 'docx' ? '📝' : '📄';
            const item = document.createElement('div');
            item.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; background:#f8f8f8; margin-bottom:6px;';
            item.innerHTML = `
                <span style="font-size:18px;">${icon}</span>
                <span style="flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${file.name}</span>
                <button data-idx="${idx}" style="background:none; border:none; color:#ff4d4f; cursor:pointer; font-size:16px; padding:2px 6px;">×</button>
            `;
            item.querySelector('button').addEventListener('click', () => {
                selectedFiles.splice(idx, 1);
                renderFileList();
            });
            fileList.appendChild(item);
        });
    }

    function handleFiles(files) {
        const validExts = ['txt', 'docx', 'zip'];
        const newFiles = Array.from(files).filter(f => {
            const ext = f.name.split('.').pop().toLowerCase();
            return validExts.includes(ext);
        });
        if (newFiles.length < Array.from(files).length) {
            showToast('部分文件格式不支持，已自动过滤（仅支持 TXT/DOCX/ZIP）');
        }
        selectedFiles = [...selectedFiles, ...newFiles];
        // 去重（按文件名）
        const seen = new Set();
        selectedFiles = selectedFiles.filter(f => {
            if (seen.has(f.name)) return false;
            seen.add(f.name);
            return true;
        });
        renderFileList();
    }

    // 点击 drop zone 触发选文件
    dropZone.addEventListener('click', () => fileInput.click());

    // 文件 input 变化
    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
        e.target.value = '';
    });

    // 拖拽入
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#4a90e2';
        dropZone.style.background = '#f0f7ff';
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '#ddd';
        dropZone.style.background = '';
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ddd';
        dropZone.style.background = '';
        handleFiles(e.dataTransfer.files);
    });

    // 取消/关闭
    [cancelBtn, closeBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.classList.remove('visible');
            selectedFiles = [];
        });
    });

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('visible');
            selectedFiles = [];
        }
    });

    // 开始解析
    startBtn.addEventListener('click', async () => {
        if (selectedFiles.length === 0) return;
        modal.classList.remove('visible');
        startBtn.disabled = true;

        showToast('正在解析文档，请稍候...');
        const queue = [];

        for (const file of selectedFiles) {
            const ext = file.name.split('.').pop().toLowerCase();
            try {
                if (ext === 'txt') {
                    const content = await readFileAsText(file);
                    if (content.trim()) queue.push({ name: file.name, content: content.trim() });
                } else if (ext === 'docx') {
                    const content = await parseDocxFile(file);
                    if (content.trim()) queue.push({ name: file.name, content: content.trim() });
                } else if (ext === 'zip') {
                    const extracted = await parseZipFile(file);
                    queue.push(...extracted);
                }
            } catch (err) {
                console.error(`解析文件 ${file.name} 失败:`, err);
                showToast(`⚠️ 解析 ${file.name} 失败: ${err.message}`);
            }
        }

        selectedFiles = [];

        if (queue.length === 0) {
            showToast('没有从文档中解析出有效内容');
            return;
        }

        // 开始弹窗预览队列
        docImportQueue = queue;
        docImportCurrentIndex = 0;
        showDocPreviewModal();
    });
}

/**
 * 读取文件为文本（UTF-8）
 */
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsText(file, 'UTF-8');
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
    });
}

/**
 * 用 mammoth.js 解析 DOCX 文件，返回纯文本
 */
async function parseDocxFile(file) {
    if (typeof mammoth === 'undefined') {
        throw new Error('mammoth.js 未加载，无法解析 DOCX 文件');
    }
    const arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsArrayBuffer(file);
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('读取DOCX失败'));
    });
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value || '';
}

/**
 * 用 JSZip 解析 ZIP 文件，提取其中 TXT 和 DOCX 文件
 */
async function parseZipFile(file) {
    if (typeof JSZip === 'undefined') {
        throw new Error('JSZip 未加载，无法解析 ZIP 文件');
    }
    const arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsArrayBuffer(file);
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('读取ZIP失败'));
    });

    const zip = await JSZip.loadAsync(arrayBuffer);
    const results = [];

    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue;
        const fname = relativePath.split('/').pop();
        const ext = fname.split('.').pop().toLowerCase();

        if (ext === 'txt') {
            try {
                const content = await zipEntry.async('string');
                if (content.trim()) results.push({ name: fname, content: content.trim() });
            } catch (e) { console.warn('ZIP内TXT解析失败:', fname, e); }
        } else if (ext === 'docx') {
            try {
                const ab = await zipEntry.async('arraybuffer');
                if (typeof mammoth !== 'undefined') {
                    const r = await mammoth.extractRawText({ arrayBuffer: ab });
                    if (r.value && r.value.trim()) results.push({ name: fname, content: r.value.trim() });
                }
            } catch (e) { console.warn('ZIP内DOCX解析失败:', fname, e); }
        }
        // 其他格式跳过
    }

    return results;
}

/**
 * 显示文档预览弹窗（逐个预览）
 */
function showDocPreviewModal() {
    const modal = document.getElementById('doc-preview-modal');
    if (!modal || docImportQueue.length === 0) return;

    if (docImportCurrentIndex >= docImportQueue.length) {
        // 全部处理完
        modal.classList.remove('visible');
        docImportQueue = [];
        return;
    }

    const item = docImportQueue[docImportCurrentIndex];
    document.getElementById('doc-preview-filename').textContent = item.name;
    document.getElementById('doc-preview-progress').textContent = `第 ${docImportCurrentIndex + 1} / ${docImportQueue.length} 个`;
    document.getElementById('doc-preview-content').value = item.content;

    modal.classList.add('visible');
}

/**
 * 设置文档预览弹窗的按钮逻辑
 */
function setupDocPreviewModal() {
    const modal = document.getElementById('doc-preview-modal');
    if (!modal) return;

    // 确定：将内容填入 add-char-modal 的描述框，然后打开手动创建
    document.getElementById('doc-preview-confirm-btn').addEventListener('click', () => {
        const content = document.getElementById('doc-preview-content').value;
        modal.classList.remove('visible');

        // 填入 add-char-modal 中的 persona 字段
        const personaInput = document.getElementById('char-persona-input');
        const hint = document.getElementById('char-persona-import-hint');
        const addCharForm = document.getElementById('add-char-form');
        const addCharModal = document.getElementById('add-char-modal');

        if (personaInput) personaInput.value = content;
        // 显示角色描述区块（文档导入时才展示），并启用弹窗滚动条
        const personaGroup = document.getElementById('char-persona-group');
        if (personaGroup) personaGroup.style.display = 'block';
        if (hint) hint.style.display = 'block';
        if (addCharModal) addCharModal.classList.add('import-mode');
        if (addCharForm) {
            // 只重置姓名类字段，不重置persona
            const realName = document.getElementById('char-real-name');
            const remarkName = document.getElementById('char-remark-name');
            const myName = document.getElementById('my-name-for-char');
            if (realName) realName.value = '';
            if (remarkName) remarkName.value = '';
            if (myName) myName.value = '';
        }
        if (addCharModal) addCharModal.classList.add('visible');
        // 不推进队列，等用户创建完再看是否有更多
        // 用户创建完后如果还有队列?
        // 简化处理：确定后直接进入创建，剩余队列丢弃（符合批量预览逻辑：用户一次看一个）
        // 若要继续下一个，可在创建完成后手动触发
        docImportCurrentIndex++;
        // 如果还有剩余，等当前modal关闭后再决定
        // 这里在创建完成后才调用 showDocPreviewModal
    });

    // 跳过：不导入当前文件，看下一个
    document.getElementById('doc-preview-skip-btn').addEventListener('click', () => {
        docImportCurrentIndex++;
        if (docImportCurrentIndex >= docImportQueue.length) {
            modal.classList.remove('visible');
            docImportQueue = [];
            showToast('已跳过所有文件');
        } else {
            showDocPreviewModal();
        }
    });

    // 取消全部
    document.getElementById('doc-preview-cancel-btn').addEventListener('click', () => {
        modal.classList.remove('visible');
        docImportQueue = [];
        docImportCurrentIndex = 0;
        showToast('已取消导入');
    });
}

/**
 * 钩入 add-char-modal 的关闭逻辑：创建完成后如果还有队列则继续
 * 在 add-char-form submit 完成后调用
 */
function checkAndContinueDocImportQueue() {
    if (docImportQueue.length > 0 && docImportCurrentIndex < docImportQueue.length) {
        setTimeout(() => showDocPreviewModal(), 300);
    }
}
