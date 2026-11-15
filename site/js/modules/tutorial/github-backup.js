const GitHubMgr = {
    config: { token: '', repo: '', auto: false, interval: 48, lastTime: 0, fileName: '' },
    
    init: () => {
        const confStr = localStorage.getItem('gh_config');
        if(confStr) GitHubMgr.config = JSON.parse(confStr);
        
        const tokenInput = document.getElementById('gh-token-input');
        const repoInput = document.getElementById('gh-repo-input');
        const fileNameInput = document.getElementById('gh-filename-input');
        const autoSwitch = document.getElementById('gh-auto-switch');
        
        if(tokenInput) tokenInput.value = GitHubMgr.config.token || '';
        if(repoInput) repoInput.value = GitHubMgr.config.repo || '';
        if(fileNameInput) fileNameInput.value = GitHubMgr.config.fileName || '';
        
        if(autoSwitch) {
            autoSwitch.checked = GitHubMgr.config.auto || false;
            document.getElementById('gh-interval-setting').style.display = autoSwitch.checked ? 'flex' : 'none';
        }
        if(document.getElementById('gh-interval-select')) {
            document.getElementById('gh-interval-select').value = GitHubMgr.config.interval || 48;
        }
        
        if(GitHubMgr.config.auto) GitHubMgr.checkAndBackup();
        GitHubMgr.updateStatusText();
    },
    
    saveConfig: () => {
        let token = document.getElementById('gh-token-input').value.trim();
        // 自动清理 Token：移除前缀和空格
        token = token.replace(/^(Bearer|token)\s+/i, '').replace(/\s+/g, '');

        const repo = document.getElementById('gh-repo-input').value.trim();
        const fileName = document.getElementById('gh-filename-input').value.trim();
        const auto = document.getElementById('gh-auto-switch').checked;
        const interval = parseInt(document.getElementById('gh-interval-select').value);
        
        GitHubMgr.config.token = token;
        GitHubMgr.config.repo = repo;
        GitHubMgr.config.fileName = fileName;
        GitHubMgr.config.auto = auto;
        GitHubMgr.config.interval = interval;
        
        document.getElementById('gh-interval-setting').style.display = auto ? 'flex' : 'none';
        
        localStorage.setItem('gh_config', JSON.stringify(GitHubMgr.config));
        GitHubMgr.updateStatusText();
        
        if(auto) GitHubMgr.checkAndBackup();
    },
    
    updateStatusText: () => {
        const el = document.getElementById('gh-status-msg');
        if(!el) return;
        if(!GitHubMgr.config.lastTime) el.innerText = '从未备份过';
        else {
            const date = new Date(GitHubMgr.config.lastTime);
            const nextTime = new Date(GitHubMgr.config.lastTime + (GitHubMgr.config.interval || 48) * 3600000);
            el.innerText = `上次: ${date.toLocaleString()} (下次约: ${nextTime.toLocaleString()})`;
        }
    },
    
    checkAndBackup: async () => {
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo || !GitHubMgr.config.auto) return;
        const now = Date.now();
        const interval = GitHubMgr.config.interval || 48;
        const hours = (now - (GitHubMgr.config.lastTime || 0)) / (1000 * 60 * 60);
        
        if(hours >= interval) {
            console.log(`距离上次备份已过 ${hours.toFixed(1)} 小时，触发自动备份...`);
            
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed; top:10px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.7); color:#fff; padding:8px 15px; border-radius:20px; font-size:12px; z-index:9999; pointer-events:none; transition:opacity 0.5s;';
            toast.innerText = '正在后台准备自动备份...';
            document.body.appendChild(toast);
            
            try {
                await GitHubMgr.performUpload((msg) => { toast.innerText = '自动备份: ' + msg; });
                toast.innerText = '自动备份成功！';
                setTimeout(() => toast.remove(), 3000);
            } catch(e) {
                console.error('自动备份失败', e);
                toast.innerText = '自动备份失败: ' + e.message;
                setTimeout(() => toast.remove(), 5000);
            }
        }
    },
    
    testUpload: async () => {
        GitHubMgr.saveConfig(); // 强制保存当前输入框的值
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo) return alert('请先填写 Token 和 仓库路径');
        showToast('开始备份...');
        const btn = event.target;
        const originalText = btn.innerText;
        btn.innerText = '备份中...';
        btn.style.pointerEvents = 'none';
        
        try {
            await GitHubMgr.performUpload((msg) => { showToast(msg); });
            showToast('上传成功！');
        } catch(e) {
            showToast('上传失败: ' + e.message);
        } finally {
            btn.innerText = originalText;
            btn.style.pointerEvents = 'auto';
        }
    },
    
    // 单文件上传上限（base64 字符数），超过则走分片。约 35MB base64 对应解码后约 26MB，低于 GitHub 100MB 限制
    _SINGLE_FILE_MAX_B64: 35 * 1024 * 1024,
    // 每片 base64 长度（字符数），分片时使用
    _CHUNK_B64_SIZE: 35 * 1024 * 1024,
    // 新备份按压缩后二进制切片，逐片编码上传，避免在内存中创建完整 Base64。
    _SINGLE_FILE_MAX_BYTES: 8 * 1024 * 1024,
    _CHUNK_BINARY_SIZE: 8 * 1024 * 1024,
    _CHUNKS_DIR: 'backup_chunks',

    _arrayBufferToBase64: (arrayBuffer) => {
        const bytes = new Uint8Array(arrayBuffer);
        const step = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
        }
        return btoa(binary);
    },

    _blobToBase64: async (blob) => GitHubMgr._arrayBufferToBase64(await blob.arrayBuffer()),

    _sha256Hex: async (blob) => {
        if (typeof crypto === 'undefined' || !crypto.subtle) return '';
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    },

    _backupTarget: () => {
        const { repo, token, fileName } = GitHubMgr.config;
        if (!token || !/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(repo) || /^\.{1,2}$/.test(repo.split('/')[1])) {
            throw new Error('请填写 GitHub Token 和有效的私有仓库路径（用户名/仓库名）');
        }
        return Object.freeze({ repo, token, fileName: fileName || '', url: `https://api.github.com/repos/${repo}` });
    },

    _verifyPrivateRepo: async (target, expectedId) => {
        const res = await fetch(target.url, {
            headers: { 'Authorization': `token ${target.token}` },
            redirect: 'error', cache: 'no-store'
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error('Token 无效或过期 (401)');
            if (res.status === 404) throw new Error('仓库不存在或 Token 无权访问 (404)');
            throw new Error(`仓库检查失败: ${res.status}`);
        }
        const info = await res.json();
        if (info?.private !== true || (info.visibility !== undefined && info.visibility !== 'private')) {
            throw new Error('云端备份需要私有仓库。请在 GitHub 确认仓库可见性为 Private。');
        }
        if (typeof info.full_name !== 'string' || info.full_name.toLowerCase() !== target.repo.toLowerCase()
            || !Number.isSafeInteger(info.id) || info.id <= 0 || (expectedId !== undefined && info.id !== expectedId)) {
            throw new Error('无法确认备份仓库的身份，请重新检查仓库路径');
        }
        if (info.permissions?.push === false) throw new Error('Token 缺少此私有仓库的写入权限');
        return info.id;
    },

    _getFileSha: async (target, repoPath) => {
        const response = await fetch(`${target.url}/contents/${encodeURIComponent(repoPath)}`, {
            headers: { 'Authorization': `token ${target.token}` }, redirect: 'error', cache: 'no-store'
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`无法检查备份文件版本: ${response.status}`);
        const { sha } = await response.json();
        if (typeof sha !== 'string' || !sha) throw new Error('无法确认备份文件版本，请检查目标路径');
        return sha;
    },

    _uploadJsonFile: async (target, repoPath, data, message) => {
        const json = JSON.stringify(data);
        const bytes = new TextEncoder().encode(json);
        const content = GitHubMgr._arrayBufferToBase64(bytes.buffer);
        const sha = await GitHubMgr._getFileSha(target, repoPath);
        return GitHubMgr._uploadOneFile(target, repoPath, content, message, sha);
    },

    _customPointerPath: (fileName) => {
        const customName = fileName && fileName.trim();
        if (!customName) return '';
        const safeName = customName.replace(/\.ee$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
        return `${GitHubMgr._CHUNKS_DIR}/${safeName}_latest.json`;
    },

    _uploadOneFile: async (target, repoPath, base64ContentForApi, message, existingSha) => {
        const url = `${target.url}/contents/${encodeURIComponent(repoPath)}`;
        await GitHubMgr._verifyPrivateRepo(target, target.id);
        const body = { message: message || 'Backup', content: base64ContentForApi };
        if (existingSha) body.sha = existingSha;
        const res = await fetch(url, {
            method: 'PUT', redirect: 'error',
            headers: {
                'Authorization': `token ${target.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const errJson = await res.json();
            throw new Error(errJson.message || 'GitHub API Error');
        }
        return res;
    },

    performUpload: async (onProgress) => {
        const configured = GitHubMgr._backupTarget();
        onProgress('正在检查私有仓库...');
        const id = await GitHubMgr._verifyPrivateRepo(configured);
        const target = Object.freeze({ ...configured, id });

        onProgress('正在打包数据...');
        const compressedBlob = await createCompressedBackupBlob({
            excludeCredentials: true,
            onProgress: progress => {
                if (progress.processedMessages && progress.processedMessages % 500 === 0) {
                    onProgress(`正在打包 ${progress.processedMessages} 条消息...`);
                }
            }
        });

        const useChunked = compressedBlob.size > GitHubMgr._SINGLE_FILE_MAX_BYTES;

        if (!useChunked) {
            // 小文件：单文件上传（兼容原有逻辑）
            onProgress('正在编码...');
            const base64Content = await GitHubMgr._blobToBase64(compressedBlob);
            onProgress('正在上传至 GitHub...');
            let path = '';
            let sha = null;
            const customName = target.fileName;
            
            if (customName && customName.trim()) {
                path = customName.trim();
                if (!path.endsWith('.ee')) path += '.ee';
                sha = await GitHubMgr._getFileSha(target, path);
            } else {
                const dateStr = new Date().toISOString().slice(0, 10);
                path = `AutoBackup_${dateStr}_${Date.now()}.ee`;
            }
            await GitHubMgr._uploadOneFile(target, path, base64Content, 'Auto backup', sha);
            const pointerPath = GitHubMgr._customPointerPath(target.fileName);
            if (pointerPath) {
                await GitHubMgr._uploadJsonFile(target, pointerPath, {
                    format: 'ovo-backup-pointer',
                    mode: 'single',
                    path,
                    timestamp: Date.now()
                }, 'Update backup pointer');
            }
        } else {
            // 大文件：分片上传
            const backupId = Date.now();
            const chunkSize = GitHubMgr._CHUNK_BINARY_SIZE;
            const totalChunks = Math.ceil(compressedBlob.size / chunkSize);
            const chunkPaths = [];
            const chunkHashes = [];
            const dir = GitHubMgr._CHUNKS_DIR;

            for (let i = 0; i < totalChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, compressedBlob.size);
                const chunk = compressedBlob.slice(start, end);
                const chunkPath = `${dir}/BackupChunk_${backupId}_part${i}.ee.chunk`;
                chunkPaths.push(`BackupChunk_${backupId}_part${i}.ee.chunk`);

                onProgress(`正在编码并上传分片 ${i + 1}/${totalChunks}...`);
                const hash = await GitHubMgr._sha256Hex(chunk);
                const contentForApi = await GitHubMgr._blobToBase64(chunk);
                chunkHashes.push(hash);
                await GitHubMgr._uploadOneFile(target, chunkPath, contentForApi, `Backup chunk ${i + 1}/${totalChunks}`);
            }

            const manifest = {
                format: 'ovo-binary-chunks',
                formatRevision: 1,
                backupId,
                totalChunks,
                chunkPaths,
                chunkHashes,
                totalBytes: compressedBlob.size,
                timestamp: backupId
            };
            const customName = target.fileName.trim();
            const manifestName = customName
                ? `${customName.replace(/\.ee$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_')}_manifest.json`
                : `BackupChunk_${backupId}_manifest.json`;
            const manifestPath = `${dir}/${manifestName}`;
            onProgress('正在上传清单...');
            await GitHubMgr._uploadJsonFile(target, manifestPath, manifest, 'Backup manifest');
            const pointerPath = GitHubMgr._customPointerPath(target.fileName);
            if (pointerPath) {
                await GitHubMgr._uploadJsonFile(target, pointerPath, {
                    format: 'ovo-backup-pointer',
                    mode: 'chunks',
                    manifestPath,
                    timestamp: backupId
                }, 'Update backup pointer');
            }
        }

        if (GitHubMgr.config.repo === target.repo && GitHubMgr.config.token === target.token && (GitHubMgr.config.fileName || '') === target.fileName) {
            GitHubMgr.config.lastTime = Date.now();
            localStorage.setItem('gh_config', JSON.stringify(GitHubMgr.config));
            GitHubMgr.updateStatusText();
        }
    },

    checkStatus: async () => {
        try {
            const target = GitHubMgr._backupTarget();
            await GitHubMgr._verifyPrivateRepo(target);
            alert(`已连接私有仓库 ${target.repo}`);
        } catch (error) { alert(error.message); }
    },

    restoreLatest: async (btn = document.getElementById('gh-restore-btn')) => {
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo) return alert('请先在配置中填写 Token 和 仓库路径');
        try {
            await runWithBackupRestoreLock(async restore => {
                if(!confirm('这将用最新的云备份覆盖当前数据，无法撤销。新版云备份不含服务密钥及自定义连接地址，恢复后需要重新填写。\n\n确定要继续吗？')) return;
                const originalText = btn?.innerText;
                if (btn) { btn.innerText = '恢复中...'; btn.disabled = true; }
                try {
                    showToast('正在连接 GitHub...');
                    const archive = await GitHubMgr._downloadLatestBackup();
                    const result = await restoreFullBackupFile(archive, restore, showToast);
                    if (!result.success) throw new Error(result.error);
                    showToast(`恢复成功！${result.message} 应用即将刷新。`);
                    setTimeout(() => window.location.reload(), 1500);
                } finally {
                    if (btn) { btn.innerText = originalText; btn.disabled = false; }
                }
            });
        } catch (error) {
            showBackupRestoreError(error, '恢复失败', alert);
        }
    },

    _downloadLatestBackup: async () => {
        const token = GitHubMgr.config.token;
        const repo = GitHubMgr.config.repo;
        const baseUrl = `https://api.github.com/repos/${repo}/contents`;
        const auth = { 'Authorization': `token ${token}` };

        const customName = GitHubMgr.config.fileName;
        let restoreChunked = false;
        let targetSingle = null;
        let targetManifest = null;

        if (customName && customName.trim()) {
            let path = customName.trim();
            if (!path.endsWith('.ee')) path += '.ee';
            const pointerPath = GitHubMgr._customPointerPath(customName);
            let pointer = null;
            if (pointerPath) {
                const pointerRes = await fetch(`${baseUrl}/${encodeURIComponent(pointerPath)}`, {
                    headers: { ...auth, 'Accept': 'application/vnd.github.v3.raw' }
                });
                if (pointerRes.ok) {
                    try { pointer = await pointerRes.json(); } catch (_) { pointer = null; }
                }
            }
            if (pointer && pointer.format === 'ovo-backup-pointer' && pointer.mode === 'chunks' && pointer.manifestPath) {
                targetManifest = { path: pointer.manifestPath, name: pointer.manifestPath.split('/').pop() };
                restoreChunked = true;
            } else if (pointer && pointer.format === 'ovo-backup-pointer' && pointer.mode === 'single' && pointer.path) {
                targetSingle = { name: pointer.path };
            } else {
                // 兼容此前仅保存固定文件名的备份。
                targetSingle = { name: path };
            }
        } else {
            const rootRes = await fetch(`${baseUrl}/`, { headers: auth });
            if (!rootRes.ok) {
                if (rootRes.status === 404) throw new Error('仓库不存在或路径错误');
                if (rootRes.status === 401) throw new Error('Token 无效或无权限');
                throw new Error('获取列表失败: ' + rootRes.status);
            }
            const rootFiles = await rootRes.json();
            const singleBackups = rootFiles.filter(f => f.name.startsWith('AutoBackup_') && f.name.endsWith('.ee'));
            singleBackups.sort((a, b) => {
                const getTs = (name) => {
                    const match = name.match(/_(\d+)\.ee$/);
                    return match ? parseInt(match[1]) : 0;
                };
                return getTs(b.name) - getTs(a.name);
            });
            if (singleBackups.length > 0) targetSingle = { name: singleBackups[0].name, ts: singleBackups[0].name.match(/_(\d+)\.ee$/)?.[1] || 0 };

            const chunksDirRes = await fetch(`${baseUrl}/${encodeURIComponent(GitHubMgr._CHUNKS_DIR)}`, { headers: auth });
            if (chunksDirRes.ok) {
                const chunkFiles = await chunksDirRes.json();
                const manifests = chunkFiles.filter(f => f.name.endsWith('_manifest.json') && f.name.startsWith('BackupChunk_'));
                if (manifests.length > 0) {
                    manifests.sort((a, b) => {
                        const getId = (name) => {
                            const m = name.match(/BackupChunk_(\d+)_manifest/);
                            return m ? parseInt(m[1]) : 0;
                        };
                        return getId(b.name) - getId(a.name);
                    });
                    targetManifest = { name: manifests[0].name, path: `${GitHubMgr._CHUNKS_DIR}/${manifests[0].name}` };
                }
            }

            if (targetSingle && targetManifest) {
                const singleTs = parseInt(targetSingle.ts, 10) || 0;
                const chunkId = parseInt(targetManifest.name.match(/BackupChunk_(\d+)_manifest/)?.[1], 10) || 0;
                restoreChunked = chunkId > singleTs;
            } else if (targetManifest) {
                restoreChunked = true;
            }
        }

        let archiveBlob;
        if (restoreChunked && targetManifest) {
            showToast('正在下载分片清单...');
            const manifestPath = targetManifest.path || `${GitHubMgr._CHUNKS_DIR}/${targetManifest.name}`;
            const manifestRes = await fetch(`${baseUrl}/${encodeURIComponent(manifestPath)}`, {
                headers: { ...auth, 'Accept': 'application/vnd.github.v3.raw' }
            });
            if (!manifestRes.ok) throw new Error('下载清单失败: ' + manifestRes.status);
            const manifestText = await manifestRes.text();
            const manifest = JSON.parse(manifestText);

            if (manifest.format === 'ovo-binary-chunks') {
                const blobParts = [];
                let downloadedBytes = 0;
                for (let i = 0; i < manifest.totalChunks; i++) {
                    showToast(`正在下载分片 ${i + 1}/${manifest.totalChunks}...`);
                    const chunkFileName = manifest.chunkPaths[i];
                    const chunkPath = `${GitHubMgr._CHUNKS_DIR}/${chunkFileName}`;
                    const chunkRes = await fetch(`${baseUrl}/${encodeURIComponent(chunkPath)}`, {
                        headers: { ...auth, 'Accept': 'application/vnd.github.v3.raw' }
                    });
                    if (!chunkRes.ok) throw new Error('下载分片失败: ' + chunkRes.status);
                    const chunkBlob = await chunkRes.blob();
                    const expectedHash = manifest.chunkHashes && manifest.chunkHashes[i];
                    if (expectedHash) {
                        const actualHash = await GitHubMgr._sha256Hex(chunkBlob);
                        if (actualHash && actualHash !== expectedHash) throw new Error(`分片 ${i + 1} 校验失败`);
                    }
                    downloadedBytes += chunkBlob.size;
                    blobParts.push(chunkBlob);
                }
                if (manifest.totalBytes && downloadedBytes !== manifest.totalBytes) {
                    throw new Error('分片总大小校验失败');
                }
                archiveBlob = new Blob(blobParts, { type: 'application/octet-stream' });
            } else {
                // 兼容此前将 gzip 的 Base64 文本再次分片保存的格式。
                const base64Parts = [];
                for (let i = 0; i < manifest.totalChunks; i++) {
                    showToast(`正在下载分片 ${i + 1}/${manifest.totalChunks}...`);
                    const chunkFileName = manifest.chunkPaths[i];
                    const chunkPath = `${GitHubMgr._CHUNKS_DIR}/${chunkFileName}`;
                    const chunkRes = await fetch(`${baseUrl}/${encodeURIComponent(chunkPath)}`, {
                        headers: { ...auth, 'Accept': 'application/vnd.github.v3.raw' }
                    });
                    if (!chunkRes.ok) throw new Error('下载分片失败: ' + chunkRes.status);
                    base64Parts.push(await chunkRes.text());
                }
                const binStr = atob(base64Parts.join(''));
                const bytes = new Uint8Array(binStr.length);
                for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
                archiveBlob = new Blob([bytes], { type: 'application/octet-stream' });
            }
        } else {
            if (!targetSingle) throw new Error('未找到可恢复的备份文件');
            showToast('正在下载: ' + targetSingle.name);
            const dlRes = await fetch(`${baseUrl}/${encodeURIComponent(targetSingle.name)}`, {
                headers: { ...auth, 'Accept': 'application/vnd.github.v3.raw' }
            });
            if (!dlRes.ok) throw new Error('下载文件失败: ' + dlRes.status);
            showToast('下载完成，正在解压...');
            archiveBlob = await dlRes.blob();
        }

        return archiveBlob;
    }
};
window.GitHubMgr = GitHubMgr;
