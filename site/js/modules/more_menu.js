// --- Menu Screen & Status Bar Manager Logic ---

// 初始化 Menu 页面
function initMoreMenu() {
    arrangePersonalMenu();
    // 初始化搜索模块
    if (window.SearchSystem) {
        window.SearchSystem.init();
        
        // 绑定搜索入口点击
        const searchEntry = document.querySelector('.search-bar-decoration');
        if (searchEntry) {
            searchEntry.addEventListener('click', () => {
                window.SearchSystem.open();
            });
        }
    }

    const menuGrids = document.querySelectorAll('.menu-grid');
    if (!menuGrids.length) return;

    menuGrids.forEach(menuGrid => {
    menuGrid.addEventListener('click', (e) => {
        const item = e.target.closest('.menu-item');
        if (!item) return;

        const action = item.dataset.action;
        if (item.closest('#personal-preferences-screen')) {
            const target = { 'status-bar': 'status-bar-manager-screen', 'cot-settings': 'cot-settings-screen', 'regex-filter': 'regex-filter-manager-screen' }[action];
            if (target) document.querySelector(`#${target} .back-btn`).dataset.target = 'personal-preferences-screen';
        }
        if (action === 'my-profile') {
            setupMyProfileScreen();
            document.querySelector('#my-profile-screen .back-btn').dataset.target = 'more-screen';
            switchScreen('my-profile-screen');
        } else if (action === 'personal-preferences') {
            switchScreen('personal-preferences-screen');
        } else if (action === 'archives') {
            openArchiveLibrary();
        } else if (action === 'status-bar') {
            openStatusBarManager();
        } else if (action === 'calendar') {
            switchScreen('health-screen');
        } else if (action === 'star') {
            if (typeof openFavoritesScreen === 'function') openFavoritesScreen();
            else showToast('收藏功能加载中…');
        } else if (action === 'regex-filter') {
            if (typeof openRegexFilterManager === 'function') openRegexFilterManager();
            else showToast('正则过滤功能加载中…');
        } else if (action === 'small-account') {
            showToast('小号功能正在开发中…');
        } else if (action === 'moments') {
            if (window.Moments) window.Moments.open();
        } else if (action === 'live-room') {
            if (window.LiveModule) {
                const activeCharacterId = typeof currentChatId !== 'undefined' ? currentChatId : null;
                const character = (typeof db !== 'undefined' && Array.isArray(db.characters))
                    ? db.characters.find(character => character.id === activeCharacterId) || db.characters[0]
                    : null;
                window.LiveModule.enterLiveRoom(
                    character?.remarkName || character?.realName || '测试主播',
                    character?.avatar || character?.avatarUrl || '',
                    item.closest('#personal-preferences-screen') ? 'personal-preferences-screen' : 'more-screen'
                );
            } else {
                showToast('直播间加载中…');
            }
        } else if (action === 'online') {
            showToast('联机功能正在开发中…');
        } else if (action === 'tavern-bridge') {
            showToast('互通酒馆功能正在开发中…');
        }
    });
    });

    // 绑定状态栏管理界面的按钮事件
    const addStatusPresetBtn = document.getElementById('add-status-preset-btn');
    if (addStatusPresetBtn) {
        addStatusPresetBtn.addEventListener('click', () => {
            openStatusBarEditor();
        });
    }

    const saveStatusPresetBtn = document.getElementById('save-status-preset-btn');
    if (saveStatusPresetBtn) {
        saveStatusPresetBtn.addEventListener('click', saveStatusBarPreset);
    }

    const importStatusPresetBtn = document.getElementById('import-status-preset-btn');
    if (importStatusPresetBtn) importStatusPresetBtn.addEventListener('click', () => document.getElementById('status-preset-import-input').click());

    const statusPresetImportInput = document.getElementById('status-preset-import-input');
    if (statusPresetImportInput) statusPresetImportInput.addEventListener('change', importStatusBarPreset);

// 初始化编辑器预览逻辑
initStatusBarPreview();

    if (typeof initFavoritesScreen === 'function') initFavoritesScreen();

    // 初始化正则过滤模块
    if (typeof initRegexFilter === 'function') initRegexFilter();
}

// Keep the original direct four-column menu. Relocating an app must not hide
// its only working entry before its replacement navigation is available.
function arrangePersonalMenu() {
    const container = document.querySelector('#more-screen .more-content-placeholder');
    if (!container || container.dataset.organized) return;
    container.dataset.organized = 'true';
    const oldGrids = [...container.querySelectorAll('.menu-grid')];
    const entry = action => container.querySelector(`.menu-item[data-action="${action}"]`);
    const profile = document.createElement('button');
    profile.type = 'button';
    profile.className = 'menu-item';
    profile.dataset.action = 'my-profile';
    profile.style.cssText = 'border:0;background:transparent;font:inherit;color:inherit;';
    profile.append(entry('small-account').querySelector('.menu-icon-wrapper').cloneNode(true));
    const label = document.createElement('span');
    label.className = 'menu-item-label'; label.textContent = '档案';
    profile.append(label);
    const archive = document.createElement('button');
    archive.type = 'button'; archive.className = 'menu-item'; archive.dataset.action = 'archives';
    archive.style.cssText = profile.style.cssText;
    archive.innerHTML = '<div class="menu-icon-wrapper"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v12h14V8M10 12h4"/></svg></div><span class="menu-item-label">存档</span>';
    const preferences = document.createElement('button');
    preferences.type = 'button'; preferences.className = 'menu-item'; preferences.dataset.action = 'personal-preferences';
    preferences.style.cssText = profile.style.cssText;
    preferences.innerHTML = '<div class="menu-icon-wrapper"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6M16 9v6M10 15v6"/></svg></div><span class="menu-item-label">偏好</span>';
    const preferenceList = document.querySelector('#personal-preferences-screen .menu-grid');
    container.querySelectorAll('.commerce-preference').forEach(item=>preferenceList.append(item));
    for (const action of ['status-bar', 'cot-settings', 'regex-filter', 'live-room', 'small-account', 'online', 'tavern-bridge']) {
        const item = entry(action);
        if (!item) continue;
        const names = { 'live-room': '直播预览', 'small-account': '小号', online: '联机', 'tavern-bridge': '互通酒馆' };
        if (names[action]) item.querySelector('.menu-item-label').textContent = names[action];
        if (['small-account','online','tavern-bridge'].includes(action)) {
            const status = document.createElement('small'); status.className = 'preference-status'; status.textContent = '未开放'; item.append(status);
        }
        item.setAttribute('role', 'button'); item.tabIndex = 0;
        item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); } });
        preferenceList.append(item);
    }
    const entries = [
        profile, entry('star'), archive, preferences,
    ];
    entry('calendar')?.remove();
    container.querySelector('[data-target="timetable-screen"]')?.remove();
    const grid = document.createElement('div'); grid.className = 'menu-grid';
    entries.filter(Boolean).forEach(node => grid.append(node));
    container.append(grid);
    oldGrids.forEach(grid => { if (!grid.children.length) grid.remove(); });
}

// 简单的 HTML 转义函数
function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, '"')
        .replace(/'/g, "&#039;");
}

// --- Status Bar Manager ---

// 打开状态栏管理界面
function openStatusBarManager() {
    renderStatusBarManager();
    switchScreen('status-bar-manager-screen');
}

// 渲染状态栏预设列表
function renderStatusBarManager() {
    const listContainer = document.getElementById('status-bar-preset-list');
    listContainer.innerHTML = '';

    const presets = db.statusBarPresets || [];

    if (presets.length === 0) {
        listContainer.innerHTML = '<div class="placeholder-text" style="grid-column: 1/-1;">暂无预设，点击右上角“+”添加</div>';
        return;
    }

    presets.forEach(preset => {
        const div = document.createElement('div');
        div.className = 'preset-card';
        div.onclick = (e) => {
            // 如果点击的是按钮，不触发编辑
            if (e.target.closest('.preset-action-btn')) return;
            openStatusBarEditor(preset.id);
        };
        div.innerHTML = `
            <div class="preset-info-col">
                <div class="preset-name">${preset.name}</div>
                <div class="preset-desc">${preset.promptSuffix || '无 Prompt 后缀'}</div>
            </div>
            <div class="preset-actions-col">
                <button class="preset-action-btn" title="导出" onclick="exportStatusBarPreset('${preset.id}')">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                </button>
                <button class="preset-action-btn delete" title="删除" onclick="deleteStatusBarPreset('${preset.id}', event)">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;
        listContainer.appendChild(div);
    });
}

// 打开状态栏编辑器（新增或编辑）
window.openStatusBarEditor = function(presetId = null) {
    const title = document.getElementById('status-bar-editor-title');
    const nameInput = document.getElementById('sb-preset-name');
    const promptInput = document.getElementById('sb-preset-prompt');
    const regexInput = document.getElementById('sb-preset-regex');
    const htmlInput = document.getElementById('sb-preset-html');
    const idInput = document.getElementById('sb-preset-id');
    const testInput = document.getElementById('sb-test-input');

    if (presetId) {
        const preset = db.statusBarPresets.find(p => p.id === presetId);
        if (preset) {
            title.textContent = '编辑预设';
            nameInput.value = preset.name;
            promptInput.value = preset.promptSuffix;
            regexInput.value = preset.regexPattern;
            htmlInput.value = preset.replacePattern;
            idInput.value = preset.id;
        }
    } else {
        title.textContent = '新建预设';
        nameInput.value = '';
        promptInput.value = '';
        regexInput.value = '';
        htmlInput.value = '';
        idInput.value = '';
    }

    // 重置测试输入和预览
    testInput.value = '';
    updateStatusBarPreview(); // 触发一次预览更新

    switchScreen('status-bar-editor-screen');
};

// 初始化状态栏预览逻辑
function initStatusBarPreview() {
    const inputs = ['sb-test-input', 'sb-preset-regex', 'sb-preset-html'];
    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateStatusBarPreview);
        }
    });
}

// 更新预览
function updateStatusBarPreview() {
    const testText = document.getElementById('sb-test-input').value;
    const regexStr = document.getElementById('sb-preset-regex').value;
    const htmlTpl = document.getElementById('sb-preset-html').value;
    const statusTag = document.getElementById('sb-match-status');
    const previewContainer = document.getElementById('sb-preview-container');

    if (!testText || !regexStr) {
        statusTag.textContent = '等待输入';
        statusTag.className = 'status-tag';
        previewContainer.innerHTML = '<span style="color:#ccc;">请输入测试文本和正则...</span>';
        return;
    }

    try {
        const regex = new RegExp(regexStr);
        const match = testText.match(regex);

        if (match) {
            statusTag.textContent = '匹配成功';
            statusTag.className = 'status-tag success';
            
            let resultHtml = htmlTpl;
            // 替换 $1, $2 等变量
            // 注意：match[0] 是完整匹配，match[1] 是第一个捕获组
            // 用户习惯用 $1 代表第一个捕获组
            
            // 倒序替换，防止 $1 误伤 $10
            for (let i = match.length - 1; i >= 1; i--) {
                // 对捕获内容进行 HTML 转义，防止破坏布局
                const safeContent = escapeHtml(match[i]);
                resultHtml = resultHtml.replace(new RegExp('\\$' + i, 'g'), safeContent);
            }
            
            previewContainer.innerHTML = resultHtml;
        } else {
            statusTag.textContent = '未匹配';
            statusTag.className = 'status-tag';
            previewContainer.innerHTML = '<span style="color:#999;">正则未匹配到内容</span>';
        }
    } catch (e) {
        statusTag.textContent = '正则错误';
        statusTag.className = 'status-tag error';
        previewContainer.innerHTML = `<span style="color:red;">${e.message}</span>`;
    }
}

// 导出单个预设
window.exportStatusBarPreset = function(presetId) {
    const preset = db.statusBarPresets.find(p => p.id === presetId);
    if (!preset) return;

    const data = JSON.stringify(preset, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `status_preset_${preset.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
};

// 导入预设
function importStatusBarPreset(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const imported = JSON.parse(event.target.result);
            // 简单校验结构
            if (imported.name && imported.regexPattern !== undefined) {
                // 可能是单个对象，也可能是数组（如果是批量导出的话，虽然目前只做了单个导出，但兼容一下数组更好）
                const presetsToAdd = Array.isArray(imported) ? imported : [imported];
                
                if (!db.statusBarPresets) db.statusBarPresets = [];

                let addedCount = 0;
                presetsToAdd.forEach(p => {
                    // 生成新ID避免冲突
                    p.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                    db.statusBarPresets.push(p);
                    addedCount++;
                });

                await saveData();
                renderStatusBarManager();
                showToast(`成功导入 ${addedCount} 个预设`);
            } else {
                showToast('无效的预设文件');
            }
        } catch (error) {
            console.error(error);
            showToast('解析失败');
        }
    };
    reader.readAsText(file);
    e.target.value = ''; // 重置 input
}

// 保存预设
async function saveStatusBarPreset() {
    const id = document.getElementById('sb-preset-id').value;
    const name = document.getElementById('sb-preset-name').value.trim();
    const promptSuffix = document.getElementById('sb-preset-prompt').value;
    const regexPattern = document.getElementById('sb-preset-regex').value;
    const replacePattern = document.getElementById('sb-preset-html').value;

    if (!name) {
        showToast('请输入预设名称');
        return;
    }

    // 校验正则有效性
    try {
        new RegExp(regexPattern);
    } catch (e) {
        showToast('正则表达式无效，请检查');
        return;
    }

    if (!db.statusBarPresets) db.statusBarPresets = [];

    if (id) {
        // 编辑现有
        const index = db.statusBarPresets.findIndex(p => p.id === id);
        if (index !== -1) {
            db.statusBarPresets[index] = { id, name, promptSuffix, regexPattern, replacePattern };
        }
    } else {
        // 新增
        const newPreset = {
            id: Date.now().toString(),
            name,
            promptSuffix,
            regexPattern,
            replacePattern
        };
        db.statusBarPresets.push(newPreset);
    }

    await saveData();
    showToast('预设已保存');
    openStatusBarManager(); // 返回列表页
}

// 删除预设
window.deleteStatusBarPreset = async function(presetId, event) {
    event.stopPropagation(); // 阻止冒泡触发编辑
    if (confirm('确定要删除这个预设吗？')) {
        db.statusBarPresets = db.statusBarPresets.filter(p => p.id !== presetId);
        await saveData();
        renderStatusBarManager();
        showToast('预设已删除');
    }
};

// 填充设置页面的下拉框 (供 settings.js 调用)
function populateStatusBarPresetSelect() {
    const select = document.getElementById('setting-status-preset-select');
    if (!select) return;

    select.innerHTML = '<option value="">-- 选择预设自动填充 --</option>';
    const presets = db.statusBarPresets || [];
    
    presets.forEach(preset => {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        select.appendChild(option);
    });

    // 绑定选择事件
    select.onchange = function() {
        const presetId = this.value;
        if (!presetId) return;

        const preset = db.statusBarPresets.find(p => p.id === presetId);
        if (preset) {
            document.getElementById('setting-status-prompt-suffix').value = preset.promptSuffix;
            document.getElementById('setting-status-regex').value = preset.regexPattern;
            document.getElementById('setting-status-replace').value = preset.replacePattern;
            showToast('已填充预设内容');
        }
    };

    // 绑定快速保存按钮事件
    const quickSaveBtn = document.getElementById('quick-save-status-preset-btn');
    if (quickSaveBtn) {
        quickSaveBtn.onclick = saveStatusBarPresetFromSettings;
    }
}

// 从设置界面快速保存预设
async function saveStatusBarPresetFromSettings() {
    const promptSuffix = document.getElementById('setting-status-prompt-suffix').value;
    const regexPattern = document.getElementById('setting-status-regex').value;
    const replacePattern = document.getElementById('setting-status-replace').value;

    if (!regexPattern && !replacePattern) {
        showToast('请先填写状态栏配置');
        return;
    }

    const name = prompt('请输入预设名称（同名将覆盖）：');
    if (!name) return;

    if (!db.statusBarPresets) db.statusBarPresets = [];

    const existingIndex = db.statusBarPresets.findIndex(p => p.name === name);
    
    const newPreset = {
        id: existingIndex !== -1 ? db.statusBarPresets[existingIndex].id : Date.now().toString(),
        name,
        promptSuffix,
        regexPattern,
        replacePattern
    };

    if (existingIndex !== -1) {
        db.statusBarPresets[existingIndex] = newPreset;
    } else {
        db.statusBarPresets.push(newPreset);
    }

    await saveData();
    showToast('预设已保存');
    populateStatusBarPresetSelect(); // 刷新下拉列表
    
    // 选中刚才保存的预设
    const select = document.getElementById('setting-status-preset-select');
    if (select) select.value = newPreset.id;
}

// 导出全局函数供 HTML 调用
window.openStatusBarEditor = openStatusBarEditor;
window.deleteStatusBarPreset = deleteStatusBarPreset;
