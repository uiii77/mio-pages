(function attachReadingCore(global) {
    'use strict';

    const VERSION = 9;
    const FORMAT = 'txt';
    const FORMATS = Object.freeze(['txt', 'docx', 'pdf', 'epub']);
    const DEFAULT_SEGMENT_CHARS = 1200;
    const MAX_TXT_BYTES = 20 * 1024 * 1024;

    function clean(value, max = 240) {
        return String(value == null ? '' : value).replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
    }

    function normalizeText(raw) {
        return String(raw == null ? '' : raw)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n?/g, '\n')
            .replace(/\n{4,}/g, '\n\n\n')
            .trim();
    }

    function decodeTxt(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
        if (bytes.byteLength > MAX_TXT_BYTES) throw new Error('TXT 文件不能超过 20 MB');
        if (bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8))) {
            throw new Error('文件内容是 ZIP/DOCX/EPUB 压缩包，不能作为纯文本读取；请恢复正确扩展名后重新导入');
        }
        let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const replacementCount = (text.match(/\uFFFD/g) || []).length;
        if (replacementCount > Math.max(2, text.length * 0.002)) {
            try {
                const alternative = new TextDecoder('gb18030', { fatal: false }).decode(bytes);
                if ((alternative.match(/\uFFFD/g) || []).length < replacementCount) text = alternative;
            } catch (_) { /* Runtime has no GB18030 decoder; retain UTF-8 result. */ }
        }
        return normalizeText(text);
    }

    function chunkText(raw, targetChars = DEFAULT_SEGMENT_CHARS) {
        const text = normalizeText(raw);
        if (!text) return [];
        const target = Math.max(300, Math.min(4000, Number(targetChars) || DEFAULT_SEGMENT_CHARS));
        const paragraphs = text.split(/\n\s*\n|\n/).map(item => item.trim()).filter(Boolean);
        const chunks = [];
        let buffer = '';
        const flush = () => {
            const value = buffer.trim();
            if (value) chunks.push({ index: chunks.length, text: value, chars: value.length });
            buffer = '';
        };
        for (const paragraph of paragraphs) {
            if (paragraph.length > target * 2) {
                flush();
                for (let offset = 0; offset < paragraph.length; offset += target) {
                    const value = paragraph.slice(offset, offset + target);
                    chunks.push({ index: chunks.length, text: value, chars: value.length });
                }
                continue;
            }
            if (buffer && buffer.length + paragraph.length + 1 > target) flush();
            buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
        }
        flush();
        return chunks;
    }

    async function chunkTextAsync(raw, options = {}) {
        const text = normalizeText(raw);
        if (!text) return [];
        const paragraphs = text.split(/\n\s*\n|\n/);
        const target = Math.max(300, Math.min(4000, Number(options.targetChars) || DEFAULT_SEGMENT_CHARS));
        const chunks = [];
        let buffer = '';
        const flush = () => {
            const value = buffer.trim();
            if (value) chunks.push({ index: chunks.length, text: value, chars: value.length });
            buffer = '';
        };
        for (let index = 0; index < paragraphs.length; index += 1) {
            const paragraph = paragraphs[index].trim();
            if (paragraph.length > target * 2) {
                flush();
                for (let offset = 0; offset < paragraph.length; offset += target) {
                    const value = paragraph.slice(offset, offset + target);
                    chunks.push({ index: chunks.length, text: value, chars: value.length });
                }
            } else if (paragraph) {
                if (buffer && buffer.length + paragraph.length + 1 > target) flush();
                buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
            }
            if (index % 1000 === 0) {
                options.onProgress?.(paragraphs.length ? index / paragraphs.length : 1);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        flush();
        options.onProgress?.(1);
        return chunks;
    }

    function makeDocumentId(contentHash) { return `reading:${clean(contentHash, 160)}`; }
    function makeSessionId(characterId, documentId) { return `reading-session:${clean(characterId, 160)}:${clean(documentId, 180)}`; }
    function makeLibraryEntryId(characterId, documentId) { return `reading-library:${clean(characterId, 160)}:${clean(documentId, 180)}`; }

    // Chapter ranges use the existing segment index: inclusive start, exclusive end.
    // Legacy text stays in its original order; no inferred EPUB TOC is persisted.
    function normalizeChapters(value, segmentCount) {
        if (value == null) return [];
        if (!Array.isArray(value)) throw new Error('阅读章节列表格式无效');
        const chapters = value.map(item => {
            if (!item || !clean(item.id, 220)) throw new Error('阅读章节 ID 无效');
            const startIndex = Number(item.startIndex), endIndex = Number(item.endIndex);
            if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex > segmentCount) throw new Error('阅读章节范围无效');
            return { id: clean(item.id, 220), parentId: clean(item.parentId, 220), title: clean(item.title, 500),
                href: clean(item.href, 1000), startIndex, endIndex };
        });
        const byId = new Map(chapters.map(item => [item.id, item]));
        if (byId.size !== chapters.length) throw new Error('阅读章节 ID 重复');
        let end = 0;
        for (const chapter of chapters) {
            if (chapter.startIndex !== end) throw new Error('阅读章节范围不连续或重叠');
            end = chapter.endIndex;
            const visited = new Set([chapter.id]);
            let parent = chapter.parentId;
            while (parent) {
                if (!byId.has(parent) || visited.has(parent)) throw new Error('阅读章节层级无效');
                visited.add(parent); parent = byId.get(parent).parentId;
            }
        }
        if (chapters.length && end !== segmentCount) throw new Error('阅读章节未覆盖全部正文');
        return chapters;
    }

    function chapterForSegment(document, index) {
        return (document?.chapters || []).find(item => index >= item.startIndex && index < item.endIndex)?.id || '';
    }

    function normalizeChunk(value, document) {
        if (!value || !document || value.documentId !== document.id || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= document.segmentCount) throw new Error('阅读内容块位置无效');
        const versionId = clean(value.versionId || document.versionId || document.contentHash, 220);
        const chapterId = chapterForSegment(document, value.index);
        if (versionId !== (document.versionId || document.contentHash) || (value.chapterId != null && value.chapterId !== chapterId)) throw new Error('阅读内容块版本或章节不匹配');
        const text = String(value.text ?? '');
        return { ...value, id: `${document.id}:${value.index}`, documentId: document.id, index: value.index,
            versionId, chapterId, blockId: clean(value.blockId || `segment:${value.index}`, 220), text, chars: text.length };
    }

    const LIBRARY_STATUSES = Object.freeze(['want-to-read', 'reading', 'finished']);
    const ANNOTATION_KINDS = Object.freeze(['highlight', 'user-note', 'character-annotation', 'discussion-user', 'discussion-character', 'study-summary', 'study-explanation']);
    const ANNOTATION_VISIBILITIES = Object.freeze(['private', 'shared']);

    function normalizeLibraryEntry(value, document) {
        const source = value && typeof value === 'object' ? value : {};
        const now = Date.now();
        const status = LIBRARY_STATUSES.includes(source.status) ? source.status : 'want-to-read';
        return {
            id: clean(source.id || makeLibraryEntryId(source.characterId, source.documentId), 380),
            characterId: clean(source.characterId, 160), documentId: clean(source.documentId, 220),
            assetId: clean(source.assetId || document?.assetId, 220), status,
            favorite: source.favorite === true,
            recommendation: clean(source.recommendation, 500),
            recommendationSource: source.recommendationSource === 'character' ? 'character' : 'user',
            recommendedAt: Math.max(0, Number(source.recommendedAt) || 0),
            lastOpenedAt: Math.max(0, Number(source.lastOpenedAt) || 0),
            createdAt: Number(source.createdAt) || now, updatedAt: Number(source.updatedAt) || now,
        };
    }

    function hashQuote(value) {
        const input = String(value == null ? '' : value);
        let hash = 2166136261;
        for (let index = 0; index < input.length; index += 1) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `q-${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function normalizeImageSignature(value) {
        const signature = clean(value, 64).toLowerCase();
        if (!/^[0-9a-f]{16}$/.test(signature)) throw new Error('图片感知签名无效');
        return signature;
    }

    function imageSignatureDistance(left, right) {
        const a = normalizeImageSignature(left), b = normalizeImageSignature(right);
        let distance = 0;
        for (let index = 0; index < a.length; index += 1) {
            let value = parseInt(a[index], 16) ^ parseInt(b[index], 16);
            while (value) { distance += value & 1; value >>>= 1; }
        }
        return distance;
    }

    function findSimilarImages(values, threshold = 8) {
        const normalized = (Array.isArray(values) ? values : []).map(value => ({
            assetId: clean(value?.assetId, 220),
            signature: normalizeImageSignature(value?.signature),
        })).filter(value => value.assetId);
        const rows = [...new Map(normalized.map(value => [value.assetId, value])).values()];
        const limit = Math.max(0, Math.min(16, Math.floor(Number(threshold) || 0)));
        const pairs = [];
        for (let left = 0; left < rows.length; left += 1) {
            for (let right = left + 1; right < rows.length; right += 1) {
                if (rows[left].assetId === rows[right].assetId) continue;
                const distance = imageSignatureDistance(rows[left].signature, rows[right].signature);
                if (distance <= limit) pairs.push({
                    leftAssetId: rows[left].assetId, rightAssetId: rows[right].assetId,
                    distance, similarity: Math.round((1 - distance / 64) * 100),
                });
            }
        }
        return pairs.sort((a, b) => a.distance - b.distance || a.leftAssetId.localeCompare(b.leftAssetId) || a.rightAssetId.localeCompare(b.rightAssetId));
    }

    function makeAnchor(document, segmentIndex, startOffset, endOffset, quote, chunk) {
        const start = Math.max(0, Number(startOffset) || 0);
        const end = Math.max(start, Number(endOffset) || start);
        return {
            documentId: clean(document?.id, 220), contentHash: clean(document?.contentHash, 160),
            versionId: clean(document?.versionId || document?.contentHash, 220),
            chapterId: chapterForSegment(document, segmentIndex), blockId: clean(chunk?.blockId || `segment:${segmentIndex}`, 220),
            segmentIndex: Math.max(0, Number(segmentIndex) || 0), startOffset: start, endOffset: end,
            quoteHash: hashQuote(quote), status: 'valid',
        };
    }

    function validateAnchor(anchor, document, chunk) {
        const normalized = { ...makeAnchor(document, anchor?.segmentIndex, anchor?.startOffset, anchor?.endOffset, ''), ...anchor };
        if (!anchor?.versionId) normalized.versionId = anchor?.contentHash || '';
        // Missing version fields are upgraded only for a matching legacy text revision.
        const index = normalized.segmentIndex;
        const valid = !!anchor?.documentId && !!anchor?.contentHash && normalized.documentId === document?.id && normalized.contentHash === document?.contentHash
            && normalized.versionId === (document?.versionId || document?.contentHash)
            && Number.isSafeInteger(index) && index >= 0 && index < document?.segmentCount
            && normalized.chapterId === chapterForSegment(document, index)
            && Number.isSafeInteger(normalized.startOffset) && Number.isSafeInteger(normalized.endOffset)
            && normalized.startOffset >= 0 && normalized.endOffset >= normalized.startOffset
            && (!chunk || (chunk.documentId === document.id && chunk.index === index && chunk.versionId === normalized.versionId
                && chunk.blockId === normalized.blockId && normalized.endOffset <= chunk.text.length
                && (normalized.endOffset === normalized.startOffset || hashQuote(chunk.text.slice(normalized.startOffset, normalized.endOffset)) === normalized.quoteHash)));
        normalized.status = valid ? 'valid' : 'needs-relocation';
        return normalized;
    }

    function makeAnnotationId() {
        const suffix = global.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        return `reading-annotation:${suffix}`;
    }

    function normalizeAnnotation(value, document) {
        const source = value && typeof value === 'object' ? value : {};
        const now = Date.now();
        const kind = ANNOTATION_KINDS.includes(source.kind) ? source.kind : 'user-note';
        const characterAuthored = kind === 'character-annotation' || kind === 'discussion-character' || kind === 'study-summary' || kind === 'study-explanation';
        const discussion = kind === 'discussion-user' || kind === 'discussion-character';
        const visibility = ANNOTATION_VISIBILITIES.includes(source.visibility) ? source.visibility : (characterAuthored || discussion ? 'shared' : 'private');
        const anchor = validateAnchor(source.anchor || {}, document);
        return {
            id: clean(source.id || makeAnnotationId(), 220),
            characterId: clean(source.characterId, 160), documentId: clean(source.documentId || document?.id, 220),
            assetId: clean(source.assetId || document?.assetId, 220), kind,
            authorType: characterAuthored ? 'character' : 'user',
            authorId: clean(source.authorId || (characterAuthored ? source.characterId : 'user'), 160),
            authorName: clean(source.authorName || (characterAuthored ? '角色' : '我'), 120),
            visibility, source: source.source === 'ai' ? 'ai' : 'manual',
            content: clean(source.content, 4000),
            quote: String(source.quote == null ? '' : source.quote).replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1200),
            anchor,
            threadId: clean(source.threadId, 220), replyToId: clean(source.replyToId, 220),
            studyScope: source.studyScope === 'chapter' ? 'chapter' : (source.studyScope === 'selection' ? 'selection' : ''),
            studyChapterId: clean(source.studyChapterId, 220),
            contextStartIndex: Math.max(0, Math.floor(Number(source.contextStartIndex) || 0)),
            contextEndIndex: Math.max(0, Math.floor(Number(source.contextEndIndex) || 0)),
            inputChars: Math.max(0, Math.floor(Number(source.inputChars) || 0)),
            requestCount: Math.max(0, Math.floor(Number(source.requestCount) || 0)),
            status: source.status === 'deleted' ? 'deleted' : 'active', anchorStatus: anchor.status,
            createdAt: Number(source.createdAt) || now, updatedAt: Number(source.updatedAt) || now,
        };
    }

    function buildAiMessages(mode, input = {}) {
        const roleName = clean(input.roleName || '角色', 120);
        const persona = clean(input.persona, 4000);
        const title = clean(input.title || '未命名读物', 240);
        const segmentIndex = Math.max(0, Number(input.segmentIndex) || 0);
        const segmentText = String(input.segmentText || '').slice(0, 6000);
        const system = [
            `你正在以“${roleName}”的身份与用户共读。`,
            persona ? `角色设定：${persona}` : '',
            '只能依据本次提供的当前段落作答，不得声称读过其他段落或整本书，不得补写原书内容。',
            '输出纯文本，不要 JSON、Markdown 标题、思考过程或标签；保持角色口吻，最多 500 字。',
        ].filter(Boolean).join('\n');
        const common = `书名：《${title}》\n当前位置：第 ${segmentIndex + 1} 段\n当前段落原文：\n${segmentText}`;
        if (mode === 'annotation') {
            const quote = String(input.quote || '').slice(0, 1200);
            return [{ role: 'system', content: system }, { role: 'user', content: `${common}\n\n用户明确选中的原文：\n${quote}\n\n请只针对这处选文留下一条真实、具体的页边批注。` }];
        }
        const question = clean(input.question, 1200);
        return [{ role: 'system', content: system }, { role: 'user', content: `${common}\n\n用户的共读问题：\n${question}\n\n请直接回应这个问题，可以引用当前段落，但不要扩展到未提供的内容。` }];
    }

    function buildStudyMessages(mode, input = {}) {
        const roleName = clean(input.roleName || '学习导师', 120);
        const persona = clean(input.persona, 4000);
        const title = clean(input.title || '未命名读物', 240);
        const scopeLabel = clean(input.scopeLabel || '用户明确选择的内容', 500);
        const sourceText = String(input.sourceText || '').slice(0, 16000);
        if (!sourceText.trim()) throw new Error('学习范围没有可读取的文字');
        const system = [
            `你是“${roleName}”，正在协助用户学习《${title}》。`,
            persona ? `角色设定：${persona}` : '',
            `本次只允许使用“${scopeLabel}”中的材料。不得调用聊天历史、其他章节或整本书知识，也不得把推测写成原文事实。`,
            '输入中的图片引用只表示位置和替代文字；没有提供图片像素时，不得推断画面内容。',
            '输出纯文本，不要思考过程或代码围栏。',
        ].filter(Boolean).join('\n');
        if(['study-tutor','study-synthesis-tutor','study-lecture','study-synthesis-lecture'].includes(mode)){
            const lecture=mode.includes('lecture'),question=clean(input.question,2000),style=input.style==='socratic'?'先询问一个诊断问题，以启发式追问帮助理解，不直接代做全部答案。':input.style==='structured'?'按概念、依据、例子、易错点和自测组织回应。':'以导师口吻清楚回答，区分材料事实与解释。';
            const history=(input.history||[]).slice(-6).flatMap(row=>[{role:'user',content:String(row.question||'').slice(0,1200)},{role:'assistant',content:String(row.content||'').slice(0,1800)}]);
            return [{role:'system',content:system+'\n'+style+'\n不要披露未经授权的剧情知识，不自行更新角色状态。'},...history,{role:'user',content:`${mode.includes('synthesis')?'以下为同一范围的分片摘记':'授权学习材料'}：\n${sourceText}\n\n${lecture?'生成可保存的讲课稿，包括学习目标、分节讲解、材料内例子、适用限制和自测问题。没有依据的示例必须标明为假设，不伪造引文或页码。':'学习者的问题：'+question}\n最多 1800 字。`}];
        }
        if (mode === 'study-extract') {
            return [{role:'system',content:system},{role:'user',content:`材料分片：\n${sourceText}\n\n提取这部分的事实、概念、论证推进和必要引用位置，最多 350 字。不要写总章结论。`}];
        }
        if (mode === 'study-synthesis-summary') {
            return [{role:'system',content:system},{role:'user',content:`以下是同一学习范围各分片的忠实摘记：\n${sourceText}\n\n合成为章节总结：先用一段概括，再列出关键观点、结构脉络和仍需回看之处。最多 800 字。`}];
        }
        if (mode === 'study-synthesis-explanation') {
            return [{role:'system',content:system},{role:'user',content:`以下是同一学习范围各分片的忠实摘记：\n${sourceText}\n\n分三层讲解：①一句话入门；②关键概念与关系；③深入理解、限制与可自测问题。最多 1000 字。`}];
        }
        if (mode === 'study-explanation') {
            return [{role:'system',content:system},{role:'user',content:`学习材料：\n${sourceText}\n\n分三层讲解：①一句话入门；②关键概念与关系；③深入理解、限制与可自测问题。最多 1000 字。`}];
        }
        return [{role:'system',content:system},{role:'user',content:`学习材料：\n${sourceText}\n\n请总结这段材料：先用一段概括，再列出关键观点、结构脉络和仍需回看之处。最多 800 字。`}];
    }

    function normalizeAiText(value,max=4000) {
        const normalized=String(value==null?'':value).replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^```(?:text)?\s*|\s*```$/gi,'');
        if(max>4000&&normalized.length>max)throw Error('AI 返回内容过长，请缩小学习范围后重试');
        return clean(normalized,max);
    }

    function normalizeDocument(value) {
        const source = value && typeof value === 'object' ? value : {};
        const now = Date.now();
        if (source.schemaVersion != null && ![1, 2].includes(source.schemaVersion)) throw new Error('阅读文档版本不兼容，请保留原文件');
        const segmentCount = Math.max(0, Math.floor(Number(source.segmentCount) || 0));
        const chapters = normalizeChapters(source.chapters, segmentCount);
        return {
            id: clean(source.id || makeDocumentId(source.contentHash || now), 220),
            schemaVersion: 2, versionId: clean(source.versionId || source.contentHash, 220),
            sourceHash: clean(source.sourceHash, 160), structure: chapters.length ? 'chapters' : 'text', chapters,
            sourceAssetId: clean(source.sourceAssetId, 180), rights: clean(source.rights, 4000),
            resources: (Array.isArray(source.resources) ? source.resources : []).map(item => ({path:clean(item.path,1000),assetId:clean(item.assetId,180),mimeType:clean(item.mimeType,120)})),
            toc: (Array.isArray(source.toc) ? source.toc : []).map(item => ({id:clean(item.id,220),parentId:clean(item.parentId,220),title:clean(item.title,500),
                path:clean(item.path,1000),fragment:clean(item.fragment,500),chapterId:clean(item.chapterId,220),blockId:clean(item.blockId,220),
                segmentIndex:Number.isSafeInteger(item.segmentIndex) && item.segmentIndex>=0 && item.segmentIndex<segmentCount ? item.segmentIndex : null})),
            assetId: clean(source.assetId, 220), contentHash: clean(source.contentHash, 160),
            format: FORMATS.includes(source.format) ? source.format : FORMAT,
            title: clean(source.title || source.fileName || '未命名文本', 240),
            fileName: clean(source.fileName || '', 240), encoding: clean(source.encoding || (source.format === 'docx' ? 'docx' : (source.format === 'pdf' || source.format === 'epub' ? source.format : 'text')), 40),
            totalChars: Math.max(0, Number(source.totalChars) || 0),
            segmentCount,
            createdAt: Number(source.createdAt) || now, updatedAt: Number(source.updatedAt) || now,
        };
    }

    function normalizePreferences(value) {
        const source = value && typeof value === 'object' ? value : {};
        const size = Number(source.fontSize);
        return {
            font: ['system', 'serif', 'sans'].includes(source.font) ? source.font : 'system',
            fontSize: Number.isFinite(size) && size > 0 ? Math.max(14, Math.min(32, Math.round(size))) : 16,
            theme: ['day', 'eye', 'night'].includes(source.theme) ? source.theme : 'day',
        };
    }

    const PLAY_MODES=Object.freeze(['reading','trpg','free-chat']);
    function normalizeWorkspace(value={}){
        if(value==null)value={};if(typeof value!=='object'||Array.isArray(value))throw Error('阅读玩法设置无效');
        if(value.schemaVersion!==undefined&&![1,2].includes(value.schemaVersion))throw Error('阅读玩法版本不兼容');
        const next={schemaVersion:value.schemaVersion||1,version:value.version??0,mode:value.mode??'reading',advancePolicy:value.advancePolicy??'manual',unit:value.unit??'paragraph'};
        if(!Number.isSafeInteger(next.version)||next.version<0||!PLAY_MODES.includes(next.mode)||!['manual','after_reply'].includes(next.advancePolicy)||!['paragraph','chapter'].includes(next.unit))throw Error('阅读玩法设置无效');
        const tutor=value.tutor||{enabled:false,scope:'paragraph',style:'dialogue'};
        if(typeof tutor.enabled!=='boolean'||!['paragraph','selection','chapter'].includes(tutor.scope)||!['dialogue','socratic','structured'].includes(tutor.style))throw Error('导师设置无效');
        next.tutor={enabled:tutor.enabled,scope:tutor.scope,style:tutor.style};
        return next;
    }
    function normalizeTrpgLinks(value){
        if(!value||value.version!==1||!value.links||typeof value.links!=='object'||Array.isArray(value.links))throw Error('阅读知识关联版本或格式无效');
        for(const [key,row] of Object.entries(value.links)){
            if(!row||typeof row.characterId!=='string'||!row.characterId||typeof row.documentId!=='string'||!row.documentId||typeof row.campaignId!=='string'||!row.campaignId||row.campaignId.length>180||key!==makeSessionId(row.characterId,row.documentId)||!Number.isSafeInteger(row.version)||row.version<1)throw Error('阅读知识关联记录无效');
        }
        return value;
    }
    function normalizeSession(value, document, chunk) {
        const source = value && typeof value === 'object' ? value : {};
        const count = Math.max(0, Number(document?.segmentCount ?? source.segmentCount) || 0);
        const segmentIndex = Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(Number(source.segmentIndex) || 0)));
        const segmentOffset = Math.max(0, Math.floor(Number(source.segmentOffset) || 0));
        const anchor = makeAnchor(document, segmentIndex, segmentOffset, segmentOffset, '', chunk);
        if (source.anchor?.documentId) anchor.documentId = source.anchor.documentId;
        if (source.anchor?.contentHash) anchor.contentHash = source.anchor.contentHash;
        if (source.anchor?.versionId) anchor.versionId = source.anchor.versionId;
        if (source.anchor?.segmentIndex === segmentIndex) {
            if (source.anchor.blockId) anchor.blockId = source.anchor.blockId;
            if (source.anchor.chapterId) anchor.chapterId = source.anchor.chapterId;
        }
        const now = Date.now();
        return {
            id: clean(source.id || makeSessionId(source.characterId, source.documentId), 360),
            characterId: clean(source.characterId, 160), documentId: clean(source.documentId, 220),
            workspace:normalizeWorkspace(source.workspace),positionVersion:Number.isSafeInteger(source.positionVersion)?source.positionVersion:0,
            trpgCampaignId:clean(source.trpgCampaignId,180), trpgBindingRevision:Number.isSafeInteger(source.trpgBindingRevision)?source.trpgBindingRevision:0,
            assetId: clean(source.assetId || document?.assetId, 220), mode: source.mode === 'study' ? 'study' : 'reading',
            segmentIndex, segmentOffset, preferences: normalizePreferences(source.preferences),
            hiddenImageBlocks: [...new Set((Array.isArray(source.hiddenImageBlocks) ? source.hiddenImageBlocks : []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 360))],
            anchor: validateAnchor(anchor, document, chunk),
            createdAt: Number(source.createdAt) || now, updatedAt: Number(source.updatedAt) || now,
        };
    }

    function progress(session, document) {
        const count = Math.max(0, Number(document?.segmentCount) || 0);
        if (!count) return 0;
        return Math.min(100, Math.round(((Number(session?.segmentIndex) || 0) + 1) / count * 100));
    }

    function speechText(value) {
        return String(value == null ? '' : value)
            .replace(/\u0000/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function makeSpeechKey(characterId, documentId, segmentIndex) {
        return `reading:${clean(characterId, 160)}:${clean(documentId, 220)}:${Math.max(0, Number(segmentIndex) || 0)}`;
    }

    global.ReadingCore = Object.freeze({ VERSION, FORMAT, FORMATS, LIBRARY_STATUSES, ANNOTATION_KINDS, ANNOTATION_VISIBILITIES, DEFAULT_SEGMENT_CHARS, MAX_TXT_BYTES, clean, normalizeText, decodeTxt, chunkText, chunkTextAsync, makeDocumentId, makeSessionId, makeLibraryEntryId, normalizeDocument, normalizeChunk, chapterForSegment, normalizePreferences, PLAY_MODES, normalizeWorkspace,normalizeTrpgLinks, normalizeSession, normalizeLibraryEntry, hashQuote, normalizeImageSignature, imageSignatureDistance, findSimilarImages, makeAnchor, validateAnchor, makeAnnotationId, normalizeAnnotation, buildAiMessages, buildStudyMessages, normalizeAiText, progress, speechText, makeSpeechKey });
}(typeof window !== 'undefined' ? window : globalThis));
