(function attachReadingParsers(global) {
    'use strict';

    const VERSION = 4;
    const adapters = new Map();
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const PDF_MIME = 'application/pdf';
    const EPUB_MIME = 'application/epub+zip';
    const MAX_DOCX_BYTES = 20 * 1024 * 1024;
    const MAX_PDF_BYTES = 50 * 1024 * 1024;
    const MAX_EPUB_BYTES = 50 * 1024 * 1024;
    const MAX_EPUB_ENTRIES = 2000;
    const MAX_EPUB_ENTRY_CHARS = 2 * 1024 * 1024;
    const MAX_EXTRACTED_CHARS = 5 * 1024 * 1024;

    function clean(value, max = 300) {
        return String(value == null ? '' : value).replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
    }

    function extensionOf(file) {
        const match = String(file?.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        return match ? match[1] : '';
    }

    function normalizeAdapter(format, adapter) {
        const id = clean(format, 24).toLowerCase();
        if (!id || !adapter || typeof adapter.parse !== 'function') throw new Error('阅读解析器配置无效');
        return Object.freeze({
            format: id,
            extensions: [...new Set((adapter.extensions || [id]).map(item => clean(item, 24).toLowerCase()).filter(Boolean))],
            mimeTypes: [...new Set((adapter.mimeTypes || []).map(item => clean(item, 120).toLowerCase()).filter(Boolean))],
            maxBytes: Math.max(1, Number(adapter.maxBytes) || Number.MAX_SAFE_INTEGER),
            parse: adapter.parse,
        });
    }

    function register(format, adapter) {
        const normalized = normalizeAdapter(format, adapter);
        adapters.set(normalized.format, normalized);
        return normalized;
    }

    function adapterFor(file) {
        const extension = extensionOf(file);
        const mime = clean(file?.type, 120).toLowerCase();
        // A visible extension is authoritative. Do not parse a renamed PDF/ZIP as
        // DOCX merely because a caller supplied a misleading MIME type.
        if (extension) return [...adapters.values()].find(adapter => adapter.extensions.includes(extension)) || null;
        return [...adapters.values()].find(adapter => mime && adapter.mimeTypes.includes(mime)) || null;
    }

    function supportedFormats() {
        return [...adapters.values()].map(adapter => ({
            format: adapter.format, extensions: [...adapter.extensions], mimeTypes: [...adapter.mimeTypes], maxBytes: adapter.maxBytes,
        }));
    }

    function decodeXmlEntities(value) {
        return String(value == null ? '' : value).replace(/&(?:amp|lt|gt|quot|apos|#x([0-9a-f]+)|#(\d+));/gi, (match, hex, decimal) => {
            if (hex) {
                const code = Number.parseInt(hex, 16);
                return Number.isFinite(code) ? String.fromCodePoint(Math.min(0x10ffff, code)) : match;
            }
            if (decimal) {
                const code = Number.parseInt(decimal, 10);
                return Number.isFinite(code) ? String.fromCodePoint(Math.min(0x10ffff, code)) : match;
            }
            return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[match.toLowerCase()] || match;
        });
    }

    function xmlAttribute(source, name) {
        const pattern = new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=\\s*(["'])(.*?)\\1`, 'i');
        const match = String(source || '').match(pattern);
        return decodeXmlEntities(match?.[2] || '');
    }

    function xmlTagText(source, tag) {
        const match = String(source || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return decodeXmlEntities(String(match?.[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    }

    function normalizeZipPath(value) {
        const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const segments = [];
        for (const segment of path.split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') {
                if (!segments.length) return '';
                segments.pop();
            } else segments.push(segment);
        }
        return segments.join('/');
    }

    function resolveZipPath(basePath, href) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(href || '').trim())) return '';
        const rawHref = String(href || '').split(/[?#]/, 1)[0];
        let cleanHref = rawHref;
        try { cleanHref = decodeURIComponent(rawHref); } catch (_) { /* Retain malformed URI and let the ZIP lookup fail safely. */ }
        if (!cleanHref) return '';
        return normalizeZipPath(cleanHref.startsWith('/') ? cleanHref : `${basePath ? `${basePath}/` : ''}${cleanHref}`);
    }

    async function zipText(zip, path, maxChars = MAX_EPUB_ENTRY_CHARS) {
        const entry = zip.file(path);
        if (!entry || entry.dir) return '';
        const declaredSize = Number(entry?._data?.uncompressedSize);
        if (Number.isFinite(declaredSize) && declaredSize > maxChars * 4) throw new Error(`EPUB 条目过大：${path}`);
        const text = await entry.async('string');
        if (text.length > maxChars) throw new Error(`EPUB 条目过大：${path}`);
        return text;
    }

    async function parseEpub(file, options = {}) {
        const JSZip = global.JSZip;
        if (!JSZip || typeof JSZip.loadAsync !== 'function') throw new Error('EPUB 解析组件未加载，请重新打开 Mio');
        const sourceBytes = new Uint8Array(await file.arrayBuffer());
        const abort = () => { if (options.signal?.aborted) throw new Error('已取消 EPUB 导入'); };
        abort();
        let zip;
        try {
            zip = await JSZip.loadAsync(sourceBytes, { checkCRC32: false });
        } catch (error) {
            throw new Error(`EPUB 读取失败，文件可能已损坏或不是有效 EPUB：${error?.message || '未知错误'}`);
        }
        const entries = Object.values(zip.files || {}).filter(entry => !entry.dir);
        if (entries.length > MAX_EPUB_ENTRIES) throw new Error(`EPUB 条目过多，已超过 ${MAX_EPUB_ENTRIES} 项安全上限`);
        const expandedSize = entries.reduce((sum, entry) => sum + (Number(entry._data?.uncompressedSize) || 0), 0);
        if (expandedSize > 100 * 1024 * 1024) throw new Error('EPUB 解压内容超过 100 MB，请拆分后导入');
        if (zip.file('META-INF/encryption.xml')) throw new Error('EPUB 含加密或 DRM 资源，Mio 不执行解密');
        const warnings = [];
        if (zip.file('META-INF/rights.xml')) warnings.push('EPUB 包含版权元数据，未执行 DRM 解密');
        const mimetype = (await zipText(zip, 'mimetype', 120)).trim();
        if (mimetype !== EPUB_MIME) warnings.push('EPUB 缺少标准 mimetype，已按容器目录继续解析');
        const container = await zipText(zip, 'META-INF/container.xml', 256 * 1024);
        const rootfileTag = container.match(/<rootfile\b[^>]*>/i)?.[0] || '';
        const rootfilePath = resolveZipPath('', xmlAttribute(rootfileTag, 'full-path'));
        if (!rootfilePath) throw new Error('EPUB 缺少有效的 OPF 目录');
        const opf = await zipText(zip, rootfilePath, MAX_EPUB_ENTRY_CHARS);
        const opfBase = rootfilePath.includes('/') ? rootfilePath.slice(0, rootfilePath.lastIndexOf('/')) : '';
        const manifestBlock = opf.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i)?.[1] || '';
        const manifest = new Map();
        for (const rawTag of manifestBlock.match(/<item\b[^>]*\/?\s*>/gi) || []) {
            const id = xmlAttribute(rawTag, 'id');
            const href = xmlAttribute(rawTag, 'href');
            const mediaType = xmlAttribute(rawTag, 'media-type').toLowerCase();
            if (id && href) manifest.set(id, { id, path: resolveZipPath(opfBase, href), mediaType, properties: xmlAttribute(rawTag, 'properties') });
        }
        const spineBlock = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] || '';
        const spineIds = [...spineBlock.matchAll(/<itemref\b[^>]*>/gi)].map(match => xmlAttribute(match[0], 'idref')).filter(Boolean);
        const chapters = spineIds.map(id => manifest.get(id)).filter(item => item?.path && /^(application\/xhtml\+xml|text\/html)$/i.test(item.mediaType));
        if (!chapters.length) throw new Error('EPUB 没有可读取的正文章节');
        const texts = [], sections = [], resources = new Map();
        let extractedChars = 0;
        for (let index = 0; index < chapters.length; index += 1) {
            abort();
            const chapter = chapters[index];
            const html = await zipText(zip, chapter.path);
            if (!html) throw new Error(`EPUB 正文章节缺失：${chapter.path}`);
            const section = epubSection(html, chapter.path);
            const text = section.blocks.map(block => block.text).filter(Boolean).join('\n\n');
            extractedChars += text.length;
            if (extractedChars > MAX_EXTRACTED_CHARS) throw new Error('解析后的正文过大，请拆分文档后再导入');
            for (const block of section.blocks.filter(block => block.kind === 'image')) {
                abort();
                const image = [...manifest.values()].find(item => item.path && item.path === block.imagePath);
                const entry = image && zip.file(image.path);
                if (!entry || !/^image\/(png|jpeg|gif|webp)$/i.test(image.mediaType)) {
                    block.unavailable = true;
                    warnings.push(`图片未提取（缺失、外部地址或不支持的类型）：${block.imagePath || block.alt || '图片'}`);
                    continue;
                }
                if (!resources.has(image.path)) {
                    if (Number(entry._data?.uncompressedSize) > 20 * 1024 * 1024) throw new Error('EPUB 单张图片超过 20 MB');
                    const bytes = await entry.async('uint8array');
                    if (bytes.length > 20 * 1024 * 1024) throw new Error('EPUB 单张图片超过 20 MB');
                    resources.set(image.path, { path: image.path, mimeType: image.mediaType, bytes });
                }
            }
            if (section.blocks.length) sections.push(section);
            if (text) texts.push(text);
            options.onProgress?.((index + 1) / chapters.length);
        }
        abort();
        const nav = [...manifest.values()].find(item => item.properties.split(/\s+/).includes('nav'));
        const ncx = manifest.get(xmlAttribute(spineBlock ? (opf.match(/<spine\b[^>]*>/i)?.[0] || '') : '', 'toc'))
            || [...manifest.values()].find(item => item.mediaType === 'application/x-dtbncx+xml');
        let toc = [];
        for (const source of [nav, ncx].filter(Boolean)) {
            if (toc.length || !source.path) continue;
            try { toc = epubToc(await zipText(zip, source.path), source.path, source === nav ? 'nav' : 'ncx'); }
            catch (error) { warnings.push(`目录读取失败：${error.message}`); }
        }
        abort();
        return {
            text: texts.join('\n\n'), mimeType: EPUB_MIME, encoding: 'epub', warnings,
            epub: { sourceBytes, sections, toc, resources: [...resources.values()] },
            metadata: { parser: 'jszip-epub-structured', title: xmlTagText(opf, 'dc:title') || xmlTagText(opf, 'title'), rights: xmlTagText(opf, 'dc:rights'), chapterCount: chapters.length, extractedChapters: sections.length },
        };
    }

    const localName = node => String(node?.localName || node?.nodeName || '').split(':').pop().toLowerCase();
    const children = node => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1);
    function descendants(node, name) { return Array.from(node.getElementsByTagName('*')).filter(child => localName(child) === name); }
    function epubDom(source) {
        if (!global.DOMParser) throw new Error('EPUB 文档解析组件未加载');
        if (/<!ENTITY\b/i.test(source)) throw new Error('EPUB 不支持自定义 XML 实体');
        // Detached XML documents do not execute scripts or load remote resources.
        const dom = new global.DOMParser().parseFromString(source, 'application/xml');
        if (descendants(dom, 'parsererror').length) throw new Error('EPUB XML 格式无效');
        return dom;
    }
    function epubTarget(path, href) {
        const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const raw = String(href || '');
        let fragment = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : '';
        try { fragment = decodeURIComponent(fragment); } catch (_) { /* preserve fragment */ }
        return { path: raw.startsWith('#') ? path : resolveZipPath(base, raw), fragment };
    }
    function epubSection(html, path) {
        const dom = epubDom(html), body = descendants(dom, 'body')[0] || dom.documentElement;
        const blocks = [], anchors = {};
        let pending = '';
        const flush = () => {
            const text = global.ReadingCore.normalizeText(pending.replace(/[ \t]+/g, ' '));
            if (text) for (const chunk of global.ReadingCore.chunkText(text)) blocks.push({kind:'text',text:chunk.text,blockId:`block:${blocks.length}`});
            pending = '';
        };
        const walk = (node,depth=0) => {
            if (depth>128) throw new Error('EPUB 正文层级过深');
            if (node.nodeType === 3 || node.nodeType === 4) { pending += node.nodeValue || ''; return; }
            if (node.nodeType !== 1) return;
            const name = localName(node);
            if (['script','style','noscript','iframe','object','embed','form'].includes(name)) return;
            const boundary = /^(p|div|section|article|h[1-6]|li|blockquote|tr|figure|figcaption)$/.test(name);
            if (boundary) flush();
            const id = node.getAttribute('id');
            if (id && !Object.hasOwn(anchors,id)) Object.defineProperty(anchors,id,{value:blocks.length,enumerable:true});
            if (name === 'img' || name === 'image') {
                flush();
                const target = epubTarget(path,node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('xlink:href'));
                const alt = node.getAttribute('alt') || '';
                blocks.push({kind:'image',text:'',alt,imagePath:target.path,blockId:`block:${blocks.length}`});
            } else if (name === 'br') pending += '\n';
            else for (const child of Array.from(node.childNodes || [])) walk(child,depth+1);
            if (boundary) flush();
        };
        walk(body); flush();
        const heading = descendants(dom,'h1')[0] || descendants(dom,'h2')[0] || descendants(dom,'title')[0];
        return { path, title: clean(heading?.textContent,500), blocks, anchors };
    }
    function epubToc(source, path, format) {
        const dom = epubDom(source), output = [];
        const add = (title, href, parentId) => {
            const id = `toc:${output.length}`;
            output.push({id,parentId,title:clean(title,500),...epubTarget(path,href)}); return id;
        };
        if (format === 'nav') {
            const nav = descendants(dom,'nav').find(node => /(^|\s)toc(\s|$)/.test(node.getAttribute('epub:type') || node.getAttribute('type') || '') || node.getAttribute('role') === 'doc-toc');
            const visit = (node,parentId,depth=0) => {
                if (depth>128) throw new Error('EPUB 目录层级过深');
                for (const li of children(node).filter(child => localName(child)==='li')) {
                    const label = children(li).find(child => ['a','span'].includes(localName(child)));
                    const id = add(label?.textContent || '',label?.getAttribute('href') || '',parentId);
                    for (const list of children(li).filter(child => localName(child)==='ol')) visit(list,id,depth+1);
                }
            };
            if (nav) for (const list of children(nav).filter(child => localName(child)==='ol')) visit(list,'');
        } else {
            const visit = (node,parentId,depth=0) => {
                if (depth>128) throw new Error('EPUB 目录层级过深');
                for (const point of children(node).filter(child => localName(child)==='navpoint')) {
                    const label = children(point).find(child => localName(child)==='navlabel');
                    const content = children(point).find(child => localName(child)==='content');
                    const id = add(label?.textContent || '',content?.getAttribute('src') || '',parentId);
                    visit(point,id,depth+1);
                }
            };
            const map = descendants(dom,'navmap')[0]; if (map) visit(map,'');
        }
        return output;
    }

    function pdfItemMetrics(item) {
        const transform = Array.isArray(item?.transform) ? item.transform : [];
        const x = Number.isFinite(Number(transform[4])) ? Number(transform[4]) : undefined;
        const y = Number.isFinite(Number(transform[5])) ? Number(transform[5]) : undefined;
        const height = Number.isFinite(Number(item?.height)) && Number(item.height) > 0
            ? Number(item.height)
            : (Number.isFinite(Number(transform[3])) ? Math.abs(Number(transform[3])) : undefined);
        return { x, y, height };
    }

    function isPdfCjk(value) { return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(String(value || '')); }
    function pdfInlineSeparator(left, right) {
        if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return '';
        if (/^[,.;:!?%。，、；：！？）》】』”’]/.test(right) || /[(（《【『“‘，。、；：！？）》】』”’…]$/.test(left)) return '';
        if (isPdfCjk(left.slice(-1)) && isPdfCjk(right[0])) return '';
        return ' ';
    }

    function pdfItemsToText(items) {
        const lines = [];
        let line = { text: '' };
        const flush = blank => {
            if (line.text.trim() || blank) lines.push({ ...line, text: line.text.trim(), blank: !!blank });
            line = { text: '' };
        };
        for (const item of Array.isArray(items) ? items : []) {
            const value = typeof item?.str === 'string' ? item.str.replace(/\u0000/g, '') : '';
            const metrics = pdfItemMetrics(item);
            if (value && line.text && line.y != null && metrics.y != null) {
                const height = Math.max(line.height || 0, metrics.height || 0, 1);
                if (Math.abs(line.y - metrics.y) > height * 0.55) flush(false);
            }
            if (value) {
                line.x ??= metrics.x;
                line.y ??= metrics.y;
                line.height = Math.max(line.height || 0, metrics.height || 0) || undefined;
                line.text += `${pdfInlineSeparator(line.text, value)}${value}`;
            }
            if (item?.hasEOL) flush(!value && !line.text);
        }
        flush(false);

        const positioned = lines.filter(item => item.text && item.x != null);
        const leftEdge = positioned.length
            ? positioned.map(item => item.x).sort((a, b) => a - b)[Math.floor(positioned.length / 2)]
            : undefined;
        let output = '';
        let previous = null;
        let pendingBlank = false;
        for (const current of lines) {
            if (current.blank || !current.text) { pendingBlank = !!previous; continue; }
            if (!previous) output = current.text;
            else if (pendingBlank || (previous.y != null && current.y != null && Math.abs(previous.y - current.y) > Math.max(previous.height || 0, current.height || 0, 1) * 1.65)
                || (leftEdge != null && current.x != null && current.x - leftEdge > Math.max(previous.height || 0, current.height || 0, 1) * 1.4)) {
                output += `\n\n${current.text}`;
            } else if (/-[A-Za-z]$/.test(output) && /^[a-z]/.test(current.text)) {
                output = `${output.slice(0, -1)}${current.text}`;
            } else output += `${pdfInlineSeparator(output, current.text)}${current.text}`;
            previous = current;
            pendingBlank = false;
        }
        return output.trim();
    }

    async function parsePdf(file, options = {}) {
        const pdfjs = global.pdfjsLib;
        if (!pdfjs || typeof pdfjs.getDocument !== 'function') throw new Error('PDF 解析组件未加载，请重新打开 Mio');
        if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';
        let documentProxy;
        try {
            documentProxy = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
            const pages = [];
            const locatedPages = [];
            for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
                if (options.signal?.aborted) throw new Error('已取消导入');
                const page = await documentProxy.getPage(pageNumber);
                try {
                    const content = await page.getTextContent();
                    const text = pdfItemsToText(content?.items);
                    if (text) pages.push(text);
                    if (options.preservePages) locatedPages.push({ page: pageNumber, text });
                } finally { page.cleanup?.(); }
                options.onProgress?.(pageNumber / documentProxy.numPages);
            }
            return {
                text: pages.join('\n\n'), mimeType: PDF_MIME, encoding: 'pdf',
                metadata: { parser: 'pdfjs', pageCount: documentProxy.numPages, extractedPages: pages.length, ...(options.preservePages ? { pages: locatedPages } : {}) },
            };
        } catch (error) {
            throw new Error(`PDF 读取失败，文件可能已损坏、加密或不含可提取文字：${error?.message || '未知错误'}`);
        } finally { await documentProxy?.destroy?.(); }
    }

    async function parse(file, options = {}) {
        if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择可读取的本地文档');
        const adapter = adapterFor(file);
        if (!adapter) throw new Error('当前仅支持 TXT、DOCX、PDF 和 EPUB 文件');
        const size = Math.max(0, Number(file.size) || 0);
        if (size > adapter.maxBytes) throw new Error(`${adapter.format.toUpperCase()} 文件不能超过 ${Math.floor(adapter.maxBytes / 1024 / 1024)} MB`);
        const result = await adapter.parse(file, options);
        const text = global.ReadingCore.normalizeText(result?.text || '');
        if (!text && !result?.epub?.sections?.some(section => section.blocks.length)) throw new Error(adapter.format === 'pdf'
            ? 'PDF 没有可提取的文字，可能是扫描件或图片 PDF；请先进行 OCR'
            : adapter.format === 'epub'
                ? 'EPUB 没有可读取的正文章节'
                : `${adapter.format.toUpperCase()} 文件没有可读取的正文`);
        if (text.length > MAX_EXTRACTED_CHARS) throw new Error('解析后的正文过大，请拆分文档后再导入');
        return {
            format: adapter.format, text,
            mimeType: clean(result?.mimeType || file.type || adapter.mimeTypes[0], 120),
            encoding: clean(result?.encoding || adapter.format, 40),
            warnings: (Array.isArray(result?.warnings) ? result.warnings : []).map(item => clean(item?.message || item, 300)).filter(Boolean).slice(0, 20),
            metadata: result?.metadata && typeof result.metadata === 'object' ? { ...result.metadata } : {},
            ...(result?.epub ? {epub:result.epub} : {}),
        };
    }

    register('txt', {
        extensions: ['txt'], mimeTypes: ['text/plain'], maxBytes: global.ReadingCore.MAX_TXT_BYTES,
        parse: async file => ({ text: global.ReadingCore.decodeTxt(await file.arrayBuffer()), mimeType: 'text/plain', encoding: 'text' }),
    });
    register('md', {
        extensions: ['md', 'markdown'], mimeTypes: ['text/markdown'], maxBytes: global.ReadingCore.MAX_TXT_BYTES,
        parse: async file => ({ text: global.ReadingCore.decodeTxt(await file.arrayBuffer()), mimeType: 'text/markdown', encoding: 'text' }),
    });
    register('docx', {
        extensions: ['docx'], mimeTypes: [DOCX_MIME], maxBytes: MAX_DOCX_BYTES,
        parse: async file => {
            if (!global.mammoth || typeof global.mammoth.extractRawText !== 'function') throw new Error('DOCX 解析组件未加载，请重新打开 Mio');
            const result = await global.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
            return {
                text: result?.value || '', mimeType: DOCX_MIME, encoding: 'docx',
                warnings: result?.messages || [], metadata: { parser: 'mammoth-extract-raw-text' },
            };
        },
    });
    register('pdf', {
        extensions: ['pdf'], mimeTypes: [PDF_MIME], maxBytes: MAX_PDF_BYTES,
        parse: parsePdf,
    });
    register('epub', {
        extensions: ['epub'], mimeTypes: [EPUB_MIME], maxBytes: MAX_EPUB_BYTES,
        parse: parseEpub,
    });

    global.ReadingParsers = Object.freeze({ VERSION, DOCX_MIME, PDF_MIME, EPUB_MIME, MAX_DOCX_BYTES, MAX_PDF_BYTES, MAX_EPUB_BYTES, MAX_EPUB_ENTRIES, MAX_EXTRACTED_CHARS, register, parse, adapterFor, supportedFormats, extensionOf, pdfItemsToText });
}(typeof window !== 'undefined' ? window : globalThis));
