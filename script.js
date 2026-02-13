// ==================== DOM Elements ====================
const markdownInput = document.getElementById('markdown-input');
const previewContent = document.getElementById('preview-content');
const btnDownload = document.getElementById('btn-download');
const btnClear = document.getElementById('btn-clear');
const btnUpload = document.getElementById('btn-upload');
const btnExamples = document.getElementById('btn-examples');
const btnAbout = document.getElementById('btn-about');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnEditorZoomIn = document.getElementById('btn-editor-zoom-in');
const btnEditorZoomOut = document.getElementById('btn-editor-zoom-out');
const btnSaveMd = document.getElementById('btn-save-md');
const btnSaveMdFs = document.getElementById('btn-save-md-fs');
const btnDownloadFs = document.getElementById('btn-download-fs');
const fileInput = document.getElementById('file-input');
const pageNumbers = document.getElementById('page-numbers');
const loadingOverlay = document.getElementById('loading-overlay');
const toast = document.getElementById('toast');

const cssInput = document.getElementById('css-input');
const tabMarkdown = document.getElementById('tab-markdown');
const tabCss = document.getElementById('tab-css');
const editorContainer = document.querySelector('.editor-container');
const editorDivider = document.getElementById('editor-divider');
const editorWrapper = document.querySelector('.editor-wrapper');

const STORAGE_KEYS = {
    markdown: 'md2pdf_content',
    pageNumbers: 'md2pdf_page_numbers',
    customCss: 'md2pdf_custom_css',
    savedDefaultCssHash: 'md2pdf_saved_default_css_hash',
    previewZoom: 'md2pdf_preview_zoom',
    editorZoom: 'md2pdf_editor_zoom',
    editorSplit: 'md2pdf_editor_split'
};

let defaultMarkdownCssText = '';
let currentDocBaseName = 'document';
let markdownEditor = null;
let cssEditor = null;

// CSS tab persistence:
// Only persist CSS when the user actually edits the CSS tab.
// This prevents an old bundled default from getting stuck in localStorage and
// overriding edits made to markdown-styles.css on disk.
let userEditedCss = false;
let suppressCssTracking = false;

function looksLikeBundledDefaultCss(cssText) {
    const t = String(cssText || '').toLowerCase();
    return t.includes('markdown content styles') && t.includes('these styles are applied to the preview and pdf output');
}

function setCustomCssProgrammatic(value) {
    suppressCssTracking = true;
    try {
        setCustomCss(value || '');
    } finally {
        suppressCssTracking = false;
    }
}

function hashText(text) {
    // Non-crypto hash (fast) used only for cache invalidation.
    const s = String(text || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return String(h >>> 0);
}

// ==================== Session Workspace (server-side) ====================
// We keep a per-tab session workspace on the FastAPI server.
// Markdown stores images as relative paths (images/<name>), but preview/PDF need
// absolute URLs to fetch from the server securely.
const SESSION_STORAGE_KEY = 'md2pdf_session_id';
// Persist the most recent session so images continue to resolve after a tab is closed.
// (sessionStorage is per-tab; localStorage survives tab close.)
const SESSION_PERSIST_KEY = 'md2pdf_persist_session_id';
let currentSessionId = null;

function bestEffortDeleteSession(sessionId) {
    const sid = sessionId || currentSessionId;
    if (!sid) return;
    const url = getApiUrl(`/api/session/${sid}/delete`);

    try {
        if (navigator && typeof navigator.sendBeacon === 'function') {
            // sendBeacon is designed for page unload and doesn't block.
            const blob = new Blob([], { type: 'text/plain' });
            navigator.sendBeacon(url, blob);
            return;
        }
    } catch { /* ignore */ }

    try {
        // keepalive allows the request to outlive the page during unload.
        fetch(url, { method: 'POST', keepalive: true }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}

function bestEffortPruneOtherSessions(keepSessionId) {
    const sid = keepSessionId || currentSessionId;
    if (!sid) return;
    const url = getApiUrl('/api/sessions/prune');
    try {
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keep_session_id: sid })
        }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}

function getServerOrigin() {
    const protocol = window.location && window.location.protocol;
    if (protocol === 'http:' || protocol === 'https:') return window.location.origin;
    // When opened from disk (file://), use the default dev server.
    return 'http://127.0.0.1:8010';
}

function getApiUrl(path) {
    const base = getServerOrigin();
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (!path.startsWith('/')) path = '/' + path;
    return base + path;
}

async function ensureSession() {
    const candidates = [];
    const fromSession = sessionStorage.getItem(SESSION_STORAGE_KEY);
    const fromPersist = localStorage.getItem(SESSION_PERSIST_KEY);
    if (fromSession) candidates.push(fromSession);
    if (fromPersist && fromPersist !== fromSession) candidates.push(fromPersist);

    for (const existing of candidates) {
        try {
            const res = await fetch(getApiUrl(`/api/session/${existing}/touch`), { method: 'POST' });
            if (res.ok) {
                currentSessionId = existing;
                sessionStorage.setItem(SESSION_STORAGE_KEY, existing);
                localStorage.setItem(SESSION_PERSIST_KEY, existing);
                bestEffortPruneOtherSessions(existing);
                return existing;
            }
        } catch { /* ignore */ }

        // If the session exists in storage but cannot be touched, it's likely stale.
        // Best-effort delete so we don't accumulate abandoned workspaces.
        bestEffortDeleteSession(existing);
    }

    const res = await fetch(getApiUrl('/api/session/new'), { method: 'POST' });
    if (!res.ok) throw new Error('Could not create session');
    const json = await res.json();
    currentSessionId = json.session_id;
    sessionStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
    localStorage.setItem(SESSION_PERSIST_KEY, currentSessionId);
    bestEffortPruneOtherSessions(currentSessionId);
    return currentSessionId;
}

async function resetSessionWorkspace() {
    const sid = currentSessionId || sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!sid) return ensureSession();
    try {
        const res = await fetch(getApiUrl(`/api/session/${sid}/reset`), { method: 'POST' });
        if (!res.ok) throw new Error('Reset failed');
        const json = await res.json();
        currentSessionId = json.session_id;
        sessionStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
        localStorage.setItem(SESSION_PERSIST_KEY, currentSessionId);
        return currentSessionId;
    } catch {
        // Fall back to a new session.
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        currentSessionId = null;
        return ensureSession();
    }
}

function rewriteSessionImageUrlsInHtml(html, sessionId) {
    const sid = sessionId || currentSessionId;
    if (!sid) return html;
    const origin = getServerOrigin();
    // Convert src="images/foo.png" or src='images/foo.png' into an absolute URL.
    return String(html || '').replace(
        /(<img\b[^>]*?\ssrc=)(["'])(images\/[^"']+)(\2)/gi,
        `$1$2${origin}/s/${sid}/$3$4`
    );
}

function isCodeMirrorInstance(target) {
    return !!(target && typeof target.getDoc === 'function');
}

function getMarkdownValue() {
    return markdownEditor ? markdownEditor.getValue() : markdownInput.value;
}

function setMarkdownValue(value) {
    const nextValue = value || '';
    if (markdownEditor) {
        markdownEditor.setValue(nextValue);
    } else {
        markdownInput.value = nextValue;
    }
}

function getCssValue() {
    if (cssEditor) return cssEditor.getValue();
    return (cssInput && typeof cssInput.value === 'string') ? cssInput.value : '';
}

function setCssValue(value) {
    const nextValue = value || '';
    if (cssEditor) {
        cssEditor.setValue(nextValue);
    } else if (cssInput) {
        cssInput.value = nextValue;
    }
}

function normalizeCss(css) {
    return String(css || '').replace(/\r\n/g, '\n').trim();
}

async function initDefaultMarkdownCss() {
    // Prefer fetching the raw file when served over http(s) so formatting/comments are preserved.
    // When opened via file://, fetch(file://...) is blocked; we fall back to cssRules (which is normalized).
    let css = '';

    if (window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
        // Cache-bust so edits to markdown-styles.css are reflected immediately.
        css = await loadCSS('markdown-styles.css', true);
    }
    if (!css) {
        css = getLoadedStylesheetText('markdown-styles.css');
    }

    defaultMarkdownCssText = css || '';
}

function guessBaseNameFromFilename(filename) {
    const raw = String(filename || '').trim();
    if (!raw) return 'document';
    const justName = raw.split(/[\\/]/).pop() || raw;
    const dotIndex = justName.lastIndexOf('.');
    const base = dotIndex > 0 ? justName.slice(0, dotIndex) : justName;
    return base.trim() || 'document';
}

const EMBED_MARKER_START = '<!-- MD2PDF_CUSTOM_CSS\n';
const EMBED_MARKER_END = '\nMD2PDF_CUSTOM_CSS -->';

function getCustomCss() {
    return getCssValue();
}

function setCustomCss(value) {
    setCssValue(value || '');
    applyCustomCssToPreview();
}

function ensureCustomCssStyleEl() {
    let el = document.getElementById('custom-css-style');
    if (!el) {
        el = document.createElement('style');
        el.id = 'custom-css-style';
        document.head.appendChild(el);
    }
    return el;
}

function applyCustomCssToPreview() {
    const el = ensureCustomCssStyleEl();
    const css = getCustomCss();
    el.textContent = css || '';
}

function resetTextareaView(textarea) {
    if (!textarea) return;
    if (isCodeMirrorInstance(textarea)) {
        const doc = textarea.getDoc();
        doc.setCursor({ line: 0, ch: 0 });
        textarea.scrollTo(0, 0);
        return;
    }
    try {
        textarea.selectionStart = 0;
        textarea.selectionEnd = 0;
        textarea.scrollTop = 0;
        textarea.scrollLeft = 0;
    } catch { /* ignore */ }
}

function applyPageNumberVisibility() {
    if (!previewContent) return;
    previewContent.classList.toggle('show-page-numbers', !!(pageNumbers && pageNumbers.checked));
}

// ==================== Editor Context Menu ====================
const editorContextMenu = document.getElementById('editor-context-menu');
let editorContextMenuBound = false;
let lastContextMenuTarget = null;
let lastMarkdownSelectionState = null;
let lastContextMenuShownAt = 0;
let contextMenuHideTimer = null;

function isMacPlatform() {
    try {
        const p = String(navigator.platform || '').toLowerCase();
        const ua = String(navigator.userAgent || '').toLowerCase();
        return p.includes('mac') || ua.includes('mac os');
    } catch {
        return false;
    }
}

function formatKeyShortcut(key) {
    // Display-only helper.
    return isMacPlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

function editorHasSelection(editorTarget) {
    if (!editorTarget) return false;
    if (isCodeMirrorInstance(editorTarget)) {
        const selected = editorTarget.getDoc().getSelection();
        return !!selected;
    }
    try {
        return editorTarget.selectionStart !== editorTarget.selectionEnd;
    } catch {
        return false;
    }
}

function getSelectionState(editorTarget) {
    if (!editorTarget) return null;
    if (isCodeMirrorInstance(editorTarget)) {
        const doc = editorTarget.getDoc();
        const text = doc.getSelection();
        const ranges = doc.listSelections();
        return {
            kind: 'codemirror',
            text: text || '',
            ranges: Array.isArray(ranges) ? ranges : []
        };
    }
    try {
        const start = Number(editorTarget.selectionStart);
        const end = Number(editorTarget.selectionEnd);
        const value = String(editorTarget.value || '');
        const text = (Number.isFinite(start) && Number.isFinite(end) && end > start) ? value.substring(start, end) : '';
        return { kind: 'textarea', text, start, end };
    } catch {
        return null;
    }
}

function saveLastSelectionFromEditor(editorTarget) {
    const state = getSelectionState(editorTarget);
    if (!state) return;
    if (state.text) lastMarkdownSelectionState = state;
}

function restoreSelection(editorTarget, state) {
    if (!editorTarget || !state) return;
    if (isCodeMirrorInstance(editorTarget) && state.kind === 'codemirror') {
        try {
            const doc = editorTarget.getDoc();
            if (Array.isArray(state.ranges) && state.ranges.length) {
                doc.setSelections(state.ranges);
            }
            editorTarget.focus();
        } catch { /* ignore */ }
        return;
    }
    if (!isCodeMirrorInstance(editorTarget) && state.kind === 'textarea') {
        try {
            if (Number.isFinite(state.start) && Number.isFinite(state.end)) {
                editorTarget.focus();
                editorTarget.selectionStart = state.start;
                editorTarget.selectionEnd = state.end;
            }
        } catch { /* ignore */ }
    }
}

function applyHeadingToSelection(editorTarget, level) {
    const lvl = Math.max(1, Math.min(6, Number(level) || 1));
    const prefix = '#'.repeat(lvl) + ' ';

    const rewriteLines = (text) => {
        const raw = String(text || '');
        const lines = raw.split('\n');
        const allAlready = lines.length > 0 && lines.every(l => l.startsWith(prefix));
        return lines
            .map((line) => {
                if (allAlready) {
                    return line.startsWith(prefix) ? line.slice(prefix.length) : line;
                }
                // Normalize: strip any existing heading prefix then apply.
                const without = line.replace(/^\s{0,3}#{1,6}\s+/, '');
                return prefix + without;
            })
            .join('\n');
    };

    if (isCodeMirrorInstance(editorTarget)) {
        const doc = editorTarget.getDoc();
        const selected = doc.getSelection();
        if (!selected) return;
        doc.replaceSelection(rewriteLines(selected));
        editorTarget.focus();
        return;
    }

    const start = editorTarget.selectionStart;
    const end = editorTarget.selectionEnd;
    const value = editorTarget.value || '';
    const selected = value.substring(start, end);
    if (!selected) return;
    const replacement = rewriteLines(selected);
    if (!document.execCommand('insertText', false, replacement)) {
        editorTarget.value = value.substring(0, start) + replacement + value.substring(end);
    }
    editorTarget.selectionStart = start;
    editorTarget.selectionEnd = start + replacement.length;
}

function toggleLinePrefixOnSelection(editorTarget, prefix) {
    const p = String(prefix || '');
    if (!p) return;

    const rewriteLines = (text) => {
        const raw = String(text || '');
        const lines = raw.split('\n');
        const nonEmpty = lines.filter(l => l.trim().length > 0);
        const allPrefixed = nonEmpty.length > 0 && nonEmpty.every(l => l.startsWith(p));

        return lines
            .map((line) => {
                if (!line.trim()) return line;
                if (allPrefixed) {
                    return line.startsWith(p) ? line.slice(p.length) : line;
                }
                return p + line;
            })
            .join('\n');
    };

    if (isCodeMirrorInstance(editorTarget)) {
        const doc = editorTarget.getDoc();
        const selected = doc.getSelection();
        if (!selected) return;
        doc.replaceSelection(rewriteLines(selected));
        editorTarget.focus();
        return;
    }

    const start = editorTarget.selectionStart;
    const end = editorTarget.selectionEnd;
    const value = editorTarget.value || '';
    const selected = value.substring(start, end);
    if (!selected) return;
    const replacement = rewriteLines(selected);
    if (!document.execCommand('insertText', false, replacement)) {
        editorTarget.value = value.substring(0, start) + replacement + value.substring(end);
    }
    editorTarget.selectionStart = start;
    editorTarget.selectionEnd = start + replacement.length;
}

function wrapSelectionAsLink(editorTarget) {
    const wrap = (sel) => `[${sel || 'text'}](https://example.com)`;

    if (isCodeMirrorInstance(editorTarget)) {
        const doc = editorTarget.getDoc();
        const selected = doc.getSelection();
        if (!selected) return;
        doc.replaceSelection(wrap(selected));
        editorTarget.focus();
        return;
    }

    const start = editorTarget.selectionStart;
    const end = editorTarget.selectionEnd;
    const value = editorTarget.value || '';
    const selected = value.substring(start, end);
    if (!selected) return;
    const replacement = wrap(selected);
    if (!document.execCommand('insertText', false, replacement)) {
        editorTarget.value = value.substring(0, start) + replacement + value.substring(end);
    }
    // Keep just the link text selected.
    editorTarget.selectionStart = start + 1;
    editorTarget.selectionEnd = start + 1 + selected.length;
}

function hideEditorContextMenu() {
    if (!editorContextMenu) return;

    // If already hidden, nothing to do.
    if (editorContextMenu.hidden) {
        lastContextMenuTarget = null;
        return;
    }

    editorContextMenu.setAttribute('aria-hidden', 'true');
    editorContextMenu.classList.remove('is-open');

    if (contextMenuHideTimer) {
        clearTimeout(contextMenuHideTimer);
        contextMenuHideTimer = null;
    }

    // Let CSS transition run, then truly hide and clear content.
    contextMenuHideTimer = setTimeout(() => {
        editorContextMenu.hidden = true;
        editorContextMenu.innerHTML = '';
        lastContextMenuTarget = null;
        contextMenuHideTimer = null;
    }, 180);
}

function clampMenuPosition(x, y, menuEl) {
    const rect = menuEl.getBoundingClientRect();
    const padding = 8;
    const maxX = window.innerWidth - rect.width - padding;
    const maxY = window.innerHeight - rect.height - padding;
    return {
        x: Math.max(padding, Math.min(x, maxX)),
        y: Math.max(padding, Math.min(y, maxY))
    };
}

function showEditorContextMenuAt(x, y, editorTarget) {
    if (!editorContextMenu) return;
    const hasSelection = editorHasSelection(editorTarget);

    if (contextMenuHideTimer) {
        clearTimeout(contextMenuHideTimer);
        contextMenuHideTimer = null;
    }

    lastContextMenuTarget = editorTarget;
    editorContextMenu.innerHTML = '';

    const actions = [];

    // Always show formatting options
    actions.push(
        {
            label: 'Bold',
            shortcut: formatKeyShortcut('B'),
            run: (t) => wrapOrInsert(t, '**', '**')
        },
        {
            label: 'Italic',
            shortcut: formatKeyShortcut('I'),
            run: (t) => wrapOrInsert(t, '*', '*')
        },
        {
            label: 'Inline code',
            shortcut: formatKeyShortcut('E'),
            run: (t) => wrapOrInsert(t, '`', '`')
        },
        {
            label: 'Strikethrough',
            shortcut: '~~ ~~',
            run: (t) => wrapOrInsert(t, '~~', '~~')
        },
        {
            label: 'Link',
            shortcut: '[ ]( )',
            run: (t) => wrapSelectionAsLink(t)
        },
        {
            label: 'Heading 1',
            shortcut: '#',
            run: (t) => applyHeadingToSelection(t, 1)
        },
        {
            label: 'Heading 2',
            shortcut: '##',
            run: (t) => applyHeadingToSelection(t, 2)
        },
        {
            label: 'Heading 3',
            shortcut: '###',
            run: (t) => applyHeadingToSelection(t, 3)
        },
        {
            label: 'Heading 4',
            shortcut: '####',
            run: (t) => applyHeadingToSelection(t, 4)
        },
        {
            label: 'Quote',
            shortcut: '> ',
            run: (t) => toggleLinePrefixOnSelection(t, '> ')
        },
        {
            label: 'Bullet list',
            shortcut: '- ',
            run: (t) => toggleLinePrefixOnSelection(t, '- ')
        },
        {
            label: 'Numbered list',
            shortcut: '1. ',
            run: (t) => toggleLinePrefixOnSelection(t, '1. ')
        },
        {
            label: 'Task list',
            shortcut: '- [ ] ',
            run: (t) => toggleLinePrefixOnSelection(t, '- [ ] ')
        }
    );

    // TOC only when no text is selected
    if (!hasSelection) {
        actions.push({ separator: true });
        actions.push(
            {
                label: 'Table of Contents',
                shortcut: '[TOC]',
                run: (t) => insertTableOfContents(t)
            }
        );
    }

    for (const action of actions) {
        if (action.separator) {
            const sep = document.createElement('div');
            sep.className = 'menu-separator';
            editorContextMenu.appendChild(sep);
            continue;
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.innerHTML = `<span class="menu-label">${action.label}</span><span class="menu-shortcut">${action.shortcut}</span>`;

        // Prevent selection from collapsing before we apply formatting.
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const target = lastContextMenuTarget || editorTarget;
            try {
                action.run(target);
            } finally {
                hideEditorContextMenu();
                updatePreview();
                autoSave();
            }
        });
        editorContextMenu.appendChild(btn);
    }

    editorContextMenu.hidden = false;
    editorContextMenu.setAttribute('aria-hidden', 'false');
    editorContextMenu.classList.remove('is-open');
    editorContextMenu.style.left = `${x}px`;
    editorContextMenu.style.top = `${y}px`;

    // Clamp after render so it doesn't overflow viewport.
    const clamped = clampMenuPosition(x, y, editorContextMenu);
    editorContextMenu.style.left = `${clamped.x}px`;
    editorContextMenu.style.top = `${clamped.y}px`;

    // Animate in on next frame so initial styles apply.
    requestAnimationFrame(() => {
        editorContextMenu.classList.add('is-open');
    });
}

function bindEditorContextMenu() {
    if (editorContextMenuBound) return;
    if (!editorContextMenu) return;

    const getMarkdownContextEl = () => {
        if (markdownEditor) return markdownEditor.getWrapperElement();
        return markdownInput;
    };

    const onContextMenu = (event, editorTarget) => {
        const target = editorTarget || markdownEditor || markdownInput;
        if (!target) return;

        // Touchpad right-click can collapse selection before contextmenu.
        // If selection is empty but we have a cached selection, restore it.
        if (!editorHasSelection(target) && lastMarkdownSelectionState && lastMarkdownSelectionState.text) {
            restoreSelection(target, lastMarkdownSelectionState);
        }
        // Allow context menu even without selection (for TOC, etc.)

        // Prevent browser context menu.
        event.preventDefault();
        event.stopPropagation();

        // Avoid double-open if multiple contextmenu events fire.
        const now = Date.now();
        if (now - lastContextMenuShownAt < 150) return;
        lastContextMenuShownAt = now;

        showEditorContextMenuAt(event.clientX, event.clientY, target);
    };

    const attach = () => {
        const el = getMarkdownContextEl();
        if (!el) return;
        const target = markdownEditor || markdownInput;
        // Cache selection early (helps with touchpad right-click).
        el.addEventListener('pointerdown', () => saveLastSelectionFromEditor(target), true);
        el.addEventListener('mousedown', () => saveLastSelectionFromEditor(target), true);
    };

    attach();

    // Robust: intercept contextmenu at document level so the browser menu never leaks through
    // when our custom menu should be shown.
    document.addEventListener('contextmenu', (e) => {
        const ctxEl = getMarkdownContextEl();
        if (!ctxEl) return;
        if (!e.target || !ctxEl.contains(e.target)) return;
        const target = markdownEditor || markdownInput;
        onContextMenu(e, target);
    }, true);

    // Global dismiss handlers
    document.addEventListener('click', (e) => {
        if (!editorContextMenu || editorContextMenu.hidden) return;
        if (e.target && editorContextMenu.contains(e.target)) return;
        hideEditorContextMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (!editorContextMenu || editorContextMenu.hidden) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            hideEditorContextMenu();
        }
    });

    window.addEventListener('resize', () => {
        if (!editorContextMenu || editorContextMenu.hidden) return;
        hideEditorContextMenu();
    });

    // Hide on scroll (both window scroll and editor-internal scroll).
    window.addEventListener('scroll', () => {
        if (!editorContextMenu || editorContextMenu.hidden) return;
        hideEditorContextMenu();
    }, { passive: true });

    try {
        const target = markdownEditor || markdownInput;
        if (markdownEditor && typeof markdownEditor.getScrollerElement === 'function') {
            const scroller = markdownEditor.getScrollerElement();
            if (scroller) {
                scroller.addEventListener('scroll', () => {
                    if (!editorContextMenu || editorContextMenu.hidden) return;
                    hideEditorContextMenu();
                }, { passive: true });
            }
        } else if (target && typeof target.addEventListener === 'function') {
            target.addEventListener('scroll', () => {
                if (!editorContextMenu || editorContextMenu.hidden) return;
                hideEditorContextMenu();
            }, { passive: true });
        }
    } catch { /* ignore */ }

    editorContextMenuBound = true;
}

function wrapOrInsert(textarea, left, right) {
    if (isCodeMirrorInstance(textarea)) {
        const doc = textarea.getDoc();
        const selected = doc.getSelection();
        if (selected) {
            doc.replaceSelection(`${left}${selected}${right}`);
        } else {
            const cursor = doc.getCursor();
            doc.replaceRange(`${left}${right}`, cursor);
            doc.setCursor({ line: cursor.line, ch: cursor.ch + left.length });
        }
        textarea.focus();
        return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const selected = value.substring(start, end);

    const replacement = `${left}${selected || ''}${right}`;

    // Try execCommand to preserve undo stack.
    if (!document.execCommand('insertText', false, replacement)) {
        textarea.value = value.substring(0, start) + replacement + value.substring(end);
    }

    // Restore selection/caret.
    if (selected) {
        textarea.selectionStart = start + left.length;
        textarea.selectionEnd = start + left.length + selected.length;
    } else {
        const caret = start + left.length;
        textarea.selectionStart = textarea.selectionEnd = caret;
    }
}

function insertSnippet(textarea, snippet) {
    if (isCodeMirrorInstance(textarea)) {
        const doc = textarea.getDoc();
        const cursor = doc.getCursor();
        doc.replaceRange(snippet, cursor);
        return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    textarea.value = value.substring(0, start) + snippet + value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + snippet.length;
    textarea.focus();
}

function slugifyHeading(text) {
    // Approximate the slug generation used by the preview renderer
    // 1. Remove common markdown syntax (links, bold, italic)
    let clean = String(text || '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
    clean = clean.replace(/[*_~`]/g, '');

    // 2. Standard slugify
    let t = clean.trim();
    t = t.replace(/[\s\-_.]+/g, '-');
    t = t.replace(/[^a-z0-9\-]/gi, '').toLowerCase();
    return t.replace(/^-+|-+$/g, '');
}

function insertTableOfContents(editorTarget) {
    insertSnippet(editorTarget, '[TOC]\n\n');
    updatePreview();
    autoSave();
    showToast('📑 Table of Contents marker inserted');
}


function setEditorTab(tab, shouldFocus = true) {
    if (!markdownInput || !cssInput || !tabMarkdown || !tabCss) return;

    const isMarkdown = tab === 'markdown';
    markdownInput.hidden = !isMarkdown;
    cssInput.hidden = isMarkdown;

    if (markdownEditor) {
        const mdWrapper = markdownEditor.getWrapperElement();
        mdWrapper.style.display = isMarkdown ? 'block' : 'none';
        if (isMarkdown) markdownEditor.refresh();
    }

    if (cssEditor) {
        const cssWrapper = cssEditor.getWrapperElement();
        cssWrapper.style.display = isMarkdown ? 'none' : 'block';
        if (!isMarkdown) cssEditor.refresh();
    }

    tabMarkdown.classList.toggle('active', isMarkdown);
    tabCss.classList.toggle('active', !isMarkdown);
    tabMarkdown.setAttribute('aria-selected', isMarkdown ? 'true' : 'false');
    tabCss.setAttribute('aria-selected', !isMarkdown ? 'true' : 'false');

    // Focus active editor for better UX (but skip on initial load to avoid scroll-to-caret jumps).
    if (shouldFocus) {
        try {
            if (isMarkdown) {
                (markdownEditor || markdownInput).focus();
            } else {
                (cssEditor || cssInput).focus();
            }
        } catch { /* ignore */ }
    }
}

function initCodeEditors() {
    if (!window.CodeMirror || !markdownInput || !cssInput) return;

    markdownEditor = CodeMirror.fromTextArea(markdownInput, {
        mode: { name: 'markdown', html: true },
        highlightFormatting: true,
        lineNumbers: true,
        lineWrapping: true,
        theme: 'material-darker',
        placeholder: markdownInput.getAttribute('placeholder') || ''
    });

    cssEditor = CodeMirror.fromTextArea(cssInput, {
        mode: 'css',
        lineNumbers: true,
        lineWrapping: true,
        theme: 'material-darker',
        placeholder: cssInput.getAttribute('placeholder') || ''
    });

    markdownEditor.setOption('indentUnit', 4);
    cssEditor.setOption('indentUnit', 4);

    markdownEditor.addOverlay({
        token: function (stream) {
            if (stream.peek() === '<' && stream.match(/<[^>]+>/)) return 'tag';
            if (stream.match(/\*\*[^*]+?\*\*/)) return 'strong';
            if (stream.match(/__[^_]+?__/)) return 'strong';
            if (stream.match(/\*[^*]+?\*\*/)) return 'em';
            if (stream.match(/_[^_]+?_/)) return 'em';
            stream.next();
            return null;
        }
    });
}

function embedCustomCssIntoMarkdown(markdown, css) {
    const cleanedMarkdown = (markdown || '').replace(/\s+$/, '');
    const cleanedCss = (css || '').trim();
    if (!cleanedCss) return cleanedMarkdown + '\n';

    // If user CSS matches the default stylesheet, don't embed it.
    if (normalizeCss(cleanedCss) && normalizeCss(cleanedCss) === normalizeCss(defaultMarkdownCssText)) {
        return cleanedMarkdown + '\n';
    }

    return `${cleanedMarkdown}\n\n${EMBED_MARKER_START}${cleanedCss}${EMBED_MARKER_END}\n`;
}

function extractCustomCssFromMarkdown(rawMarkdown) {
    const text = rawMarkdown || '';
    const startIndex = text.indexOf(EMBED_MARKER_START);
    if (startIndex === -1) {
        return { markdown: text, css: '' };
    }

    const endIndex = text.indexOf(EMBED_MARKER_END, startIndex + EMBED_MARKER_START.length);
    if (endIndex === -1) {
        // Marker start exists but end doesn't; treat as normal markdown.
        return { markdown: text, css: '' };
    }

    const cssStart = startIndex + EMBED_MARKER_START.length;
    const css = text.slice(cssStart, endIndex);
    const before = text.slice(0, startIndex);
    const after = text.slice(endIndex + EMBED_MARKER_END.length);
    const markdown = (before + after).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    return { markdown, css: (css || '').trim() };
}

function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function saveMarkdownFile() {
    // Export document.
    // Server returns a ZIP only when there are images to bundle; otherwise it returns plain .md.
    const content = embedCustomCssIntoMarkdown(getMarkdownValue(), getCustomCss());
    const suggested = (currentDocBaseName || 'document').trim() || 'document';
    const entered = prompt('Save document as (without extension):', suggested);
    if (entered === null) return; // cancelled
    const base = guessBaseNameFromFilename(entered);
    currentDocBaseName = base;

    (async () => {
        try {
            const sid = await ensureSession();
            const res = await fetch(getApiUrl(`/api/session/${sid}/export-zip`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ markdown: content })
            });
            if (!res.ok) throw new Error('Export failed');

            const contentType = String(res.headers.get('content-type') || '').toLowerCase();
            const isZip = contentType.includes('application/zip');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = isZip ? `${base}.zip` : `${base}.md`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showToast(isZip ? '💾 Document saved (ZIP)' : '💾 Document saved (.md)');
        } catch (e) {
            console.error('ZIP export error:', e);
            showToast('❌ Could not save document. Is server.py running?');
        }
    })();
}

function getPdfFilenameFromUser() {
    const suggested = (currentDocBaseName || 'document').trim() || 'document';
    const entered = prompt('Save PDF as (without extension):', suggested);
    if (entered === null) return null;
    const base = guessBaseNameFromFilename(entered);
    currentDocBaseName = base;
    return `${base}.pdf`;
}

// ==================== Markdown Configuration ====================
marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: true,
    mangle: false,
    sanitize: false,
    smartLists: true,
    smartypants: true,
    xhtml: false
});

// ==================== Initial Content ====================
const defaultMarkdown = `# Welcome to MD2PDF

## Features
- **Real-time preview** - See your changes instantly
- *Beautiful formatting* - Professional PDF output
- Easy to use - No installation required

### Code Support
\`\`\`javascript
console.log('Hello, World!');
\`\`\`

> Create amazing PDFs from Markdown!

---

### Getting Started
1. Write or paste your Markdown content
2. Preview it in real-time
3. Click "Download PDF" to save

**Try it now!** ✨
`;

setMarkdownValue(defaultMarkdown);

// ==================== Core Functions ====================

function updatePreview() {
    const markdownText = getMarkdownValue();
    const htmlContent = marked.parse(markdownText);
    const strictAnchorsHtml = applyStrictHeadingIds(htmlContent);
    const withTOC = replaceTOCMarkers(strictAnchorsHtml);
    const withSessionImages = rewriteSessionImageUrlsInHtml(withTOC, currentSessionId);
    paginateContent(withSessionImages);
}

function replaceTOCMarkers(htmlText) {
    // Find all [TOC] markers (they'll be wrapped in <p> tags by marked.js)
    const tocMarkerRegex = /<p>\[TOC\]<\/p>/gi;

    if (!tocMarkerRegex.test(htmlText)) {
        return htmlText; // No TOC markers found
    }

    // Find the position of the first [TOC] marker
    tocMarkerRegex.lastIndex = 0; // Reset regex
    const tocMatch = tocMarkerRegex.exec(htmlText);
    const tocPosition = tocMatch ? tocMatch.index : 0;

    // Extract all headings from the HTML
    const headingRe = /<h([1-6])([^>]*)id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi;
    const headings = [];
    let match;

    while ((match = headingRe.exec(htmlText)) !== null) {
        const level = parseInt(match[1]);
        const id = match[3];
        const innerHtml = match[4];
        const position = match.index; // Position in HTML

        // Only include headings that appear AFTER the TOC marker
        if (position <= tocPosition) {
            continue;
        }

        // Extract text content from HTML
        const tmp = document.createElement('div');
        tmp.innerHTML = innerHtml;
        const text = tmp.textContent || tmp.innerText || '';

        headings.push({ level, id, text: text.trim(), position });
    }

    if (headings.length === 0) {
        // No headings found after TOC, remove TOC markers
        return htmlText.replace(tocMarkerRegex, '');
    }


    // Calculate page numbers by estimating content height
    const estimatePageNumber = (position) => {
        // Count approximate content before this heading
        const contentBefore = htmlText.substring(0, position);

        // Rough estimate: count major elements
        const paragraphs = (contentBefore.match(/<p>/gi) || []).length;
        const headingsCount = (contentBefore.match(/<h[1-6]/gi) || []).length;
        const images = (contentBefore.match(/<img/gi) || []).length;
        const codeBlocks = (contentBefore.match(/<pre>/gi) || []).length;
        const lists = (contentBefore.match(/<ul>|<ol>/gi) || []).length;
        const tables = (contentBefore.match(/<table>/gi) || []).length;

        // Rough height estimates (in "units" that roughly equal 1 page = 35 units)
        const estimatedHeight =
            paragraphs * 1.5 +      // Each paragraph ~1.5 units
            headingsCount * 2 +     // Each heading ~2 units
            images * 10 +           // Each image ~10 units (200px default height)
            codeBlocks * 6 +        // Each code block ~6 units
            lists * 3 +             // Each list ~3 units
            tables * 5;             // Each table ~5 units

        return Math.max(1, Math.floor(estimatedHeight / 35) + 1);
    };

    // Generate TOC HTML
    let tocHtml = '<div class="toc-wrapper">\n';
    headings.forEach(h => {
        const pageNum = estimatePageNumber(h.position);
        tocHtml += `  <div class="toc-entry toc-level-${h.level}">
    <a href="#${h.id}">
      <span class="toc-text">${h.text}</span>
      <span class="toc-spacer"></span>
      <span class="toc-page">${pageNum}</span>
    </a>
  </div>\n`;
    });
    tocHtml += '</div>';

    // Replace all [TOC] markers with the generated TOC
    return htmlText.replace(tocMarkerRegex, tocHtml);
}

function applyStrictHeadingIds(htmlText) {
    const headingRe = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;

    const slugifyBase = (innerHtml) => {
        try {
            const tmp = document.createElement('div');
            tmp.innerHTML = String(innerHtml || '');
            const text = String(tmp.textContent || '').trim();
            let t = text.replace(/^#+\s*/, '').trim();
            t = t.replace(/[\s\-_.]+/g, '-');
            t = t.replace(/[^a-z0-9\-]/gi, '').toLowerCase();
            return t.replace(/^-+|-+$/g, '');
        } catch {
            return '';
        }
    };

    return String(htmlText || '').replace(headingRe, (full, level, attrs, inner) => {
        const base = slugifyBase(inner);
        if (!base) return full;

        const lvl = String(level);
        const anchor = (lvl === '1') ? base : `h${lvl}-${base}`;

        const attrsNoId = String(attrs || '').replace(/\s+id\s*=\s*(['"]).*?\1/gi, '');
        return `<h${lvl}${attrsNoId} id="${anchor}">${inner}</h${lvl}>`;
    });
}

function paginateContent(htmlContent) {
    // Use a real A4-sized measuring page so the browser decides mm->px.
    const measurePage = document.createElement('div');
    measurePage.className = 'a4-page';
    measurePage.style.position = 'absolute';
    measurePage.style.visibility = 'hidden';
    measurePage.style.left = '0';
    measurePage.style.top = '0';
    measurePage.style.margin = '0';
    measurePage.style.boxShadow = 'none';
    // Ensure we're measuring *exactly* one page tall.
    measurePage.style.height = '297mm';

    document.body.appendChild(measurePage);

    const pageStyle = window.getComputedStyle(measurePage);
    const paddingBottomPx = parseFloat(pageStyle.paddingBottom) || 0;
    // Added a small safety margin to prevent rounding/layout differences (screen vs print)
    // from triggering unexpected overflows (which can yield extra blank pages in the PDF).
    const maxBottom = measurePage.clientHeight - paddingBottomPx - 10;

    // Put content into a temporary wrapper to get top-level blocks.
    const tempWrapper = document.createElement('div');
    tempWrapper.innerHTML = htmlContent;
    const elements = Array.from(tempWrapper.children);

    const pages = [];
    let currentPageHTML = [];
    let currentPageElements = [];

    const isEffectivelyEmptyBlock = (node) => {
        if (!node) return true;
        // If it contains real content elements, it's not empty.
        if (node.querySelector) {
            if (node.querySelector('img, table, pre, blockquote, ul, ol, hr')) return false;
        }
        const text = String(node.textContent || '').replace(/\s+/g, '');
        if (text) return false;

        // Treat <br>-only blocks as empty to avoid blank pages.
        if (node.querySelector) {
            const hasAnyElement = !!node.querySelector('*');
            if (!hasAnyElement) return true;
            const hasOnlyBr = Array.from(node.querySelectorAll('*')).every((el) => (el.tagName || '').toUpperCase() === 'BR');
            if (hasOnlyBr) return true;
        }

        return true;
    };

    const trimLeadingBrOnPageStart = (node) => {
        // When content is pushed to a new page, it can start with many <br> (e.g., user added
        // <br> before an image). Those leading breaks make a page look blank.
        // We remove leading <br> runs only when the element is the first thing on a page.
        if (!node || !node.childNodes || node.childNodes.length === 0) return;

        // Only trim on common wrappers (mostly <p>). Avoid touching headings.
        const tag = (node.tagName || '').toUpperCase();
        if (tag && /^H[1-6]$/.test(tag)) return;

        while (node.firstChild) {
            const first = node.firstChild;
            if (first.nodeType === Node.ELEMENT_NODE && first.tagName && first.tagName.toUpperCase() === 'BR') {
                node.removeChild(first);
                continue;
            }
            // Remove whitespace-only text nodes.
            if (first.nodeType === Node.TEXT_NODE && !String(first.textContent || '').trim()) {
                node.removeChild(first);
                continue;
            }
            break;
        }
    };

    const splitElementBeforeFirstImage = (el) => {
        if (!el || typeof el.querySelector !== 'function') return null;
        const img = el.querySelector('img');
        if (!img) return null;

        // Find the closest direct child of el that contains the image.
        let splitChild = img;
        while (splitChild && splitChild.parentElement && splitChild.parentElement !== el) {
            splitChild = splitChild.parentElement;
        }
        if (!splitChild || splitChild.parentElement !== el) return null;

        const childNodes = Array.from(el.childNodes);
        const splitIndex = childNodes.indexOf(splitChild);
        if (splitIndex <= 0) return null;

        const before = el.cloneNode(false);
        const after = el.cloneNode(false);

        for (let j = 0; j < childNodes.length; j++) {
            const cloned = childNodes[j].cloneNode(true);
            if (j < splitIndex) before.appendChild(cloned);
            else after.appendChild(cloned);
        }

        const parts = [];
        if (!isEffectivelyEmptyBlock(before)) parts.push(before);
        if (!isEffectivelyEmptyBlock(after)) parts.push(after);
        return parts.length >= 2 ? parts : null;
    };

    // Helper: check if element is a heading
    const isHeading = (el) => {
        return el && /^H[1-6]$/i.test(el.tagName);
    };

    // Helper: get heading anchor slug (matches backend)
    const getHeadingAnchor = (el) => {
        if (!isHeading(el)) return null;
        const level = el.tagName.replace(/[^0-9]/g, '');
        let text = el.textContent || '';
        text = text.replace(/^#+\s*/, '').trim();
        text = text.replace(/[\s\-_.]+/g, '-');
        text = text.replace(/[^a-z0-9\-]/gi, '').toLowerCase();
        const slug = text.replace(/^-+|-+$/g, '');
        return `h${level}-${slug}`;
    };

    // Helper: compute used height up to the last child, including its margin-bottom.
    const getUsedHeightPx = () => {
        const children = measurePage.children;
        if (!children.length) return 0;
        const last = children[children.length - 1];
        const pageRect = measurePage.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        const lastStyle = window.getComputedStyle(last);
        const lastMarginBottom = parseFloat(lastStyle.marginBottom) || 0;
        return (lastRect.bottom - pageRect.top) + lastMarginBottom;
    };

    for (let i = 0; i < elements.length; i++) {
        let element = elements[i];
        const nextElement = elements[i + 1];

        // Check for manual page break
        if (element.classList.contains('page-break')) {
            if (currentPageHTML.length) {
                pages.push(currentPageHTML.join(''));
            }
            currentPageHTML = [];
            currentPageElements = [];
            measurePage.innerHTML = '';
            continue; // Skip the div itself to avoid empty pages if it's the only thing there
        }

        // Append a clone into the measuring page.
        const isStartingNewPage = measurePage.children.length === 0;
        const clone = element.cloneNode(true);
        if (isStartingNewPage) {
            trimLeadingBrOnPageStart(clone);
            // If this block is only spacing, skip it entirely so it can't become a blank page.
            if (isEffectivelyEmptyBlock(clone)) {
                continue;
            }
        }
        measurePage.appendChild(clone);

        const used = getUsedHeightPx();
        if (used <= maxBottom) {
            // Keep trimmed HTML when it's the first element on the page.
            currentPageHTML.push(isStartingNewPage ? clone.outerHTML : element.outerHTML);
            currentPageElements.push(isStartingNewPage ? clone : element);

            // Check if this is a heading at the end of the page and if there's a next element
            // If so, try to fit the next element too to avoid orphaned headings
            if (isHeading(element) && nextElement && i < elements.length - 1) {
                const nextClone = nextElement.cloneNode(true);
                measurePage.appendChild(nextClone);
                const usedWithNext = getUsedHeightPx();

                // If next element doesn't fit, move the heading to next page
                if (usedWithNext > maxBottom) {
                    // Remove heading from current page
                    measurePage.removeChild(clone);
                    currentPageHTML.pop();
                    currentPageElements.pop();

                    // Save current page if it has content
                    if (currentPageHTML.length) {
                        pages.push(currentPageHTML.join(''));
                    }

                    // Start new page with the heading
                    currentPageHTML = [element.outerHTML];
                    currentPageElements = [element];
                    measurePage.innerHTML = '';
                    measurePage.appendChild(element.cloneNode(true));
                } else {
                    // Next element fits, remove it from measuring (will be added in next iteration)
                    measurePage.removeChild(nextClone);
                }
            }
            continue;
        }

        // First element on a page overflowed. Try to split it before the first image
        // instead of forcing an oversized block (which can lead to "blank" pages).
        if (measurePage.children.length === 1) {
            measurePage.removeChild(clone);
            const parts = splitElementBeforeFirstImage(element);
            if (parts) {
                elements.splice(i, 1, ...parts);
                i -= 1;
                continue;
            }

            // Fall back to keeping it; it will be clipped by the fixed page height.
            measurePage.appendChild(clone);
            currentPageHTML.push(isStartingNewPage ? clone.outerHTML : element.outerHTML);
            currentPageElements.push(isStartingNewPage ? clone : element);
            continue;
        }

        // Overflowed: move element to next page.
        measurePage.removeChild(clone);

        // If this element would overflow even on an empty page, try to split it before the first image.
        // This fixes the common case: many <br> above an image -> image should move to the next page.
        if (currentPageHTML.length === 0) {
            const parts = splitElementBeforeFirstImage(element);
            if (parts) {
                // Replace current element with the split parts and retry.
                elements.splice(i, 1, ...parts);
                i -= 1;
                continue;
            }
        }

        // Check if the last element on current page is a heading
        if (currentPageElements.length > 0 && isHeading(currentPageElements[currentPageElements.length - 1])) {
            // Move the heading to the next page too
            currentPageHTML.pop();
            const orphanedHeading = currentPageElements.pop();

            if (currentPageHTML.length) {
                pages.push(currentPageHTML.join(''));
            }

            currentPageHTML = [orphanedHeading.outerHTML, element.outerHTML];
            currentPageElements = [orphanedHeading, element];
            measurePage.innerHTML = '';
            measurePage.appendChild(orphanedHeading.cloneNode(true));
            measurePage.appendChild(element.cloneNode(true));
        } else {
            if (currentPageHTML.length) {
                pages.push(currentPageHTML.join(''));
            }

            currentPageHTML = [element.outerHTML];
            currentPageElements = [element];
            measurePage.innerHTML = '';
            measurePage.appendChild(element.cloneNode(true));
        }
    }

    if (currentPageHTML.length) pages.push(currentPageHTML.join(''));

    const isPageHtmlEffectivelyEmpty = (pageHtml) => {
        const html = String(pageHtml || '');
        if (!html.trim()) return true;
        // Remove common whitespace-only constructs.
        const stripped = html
            .replace(/&nbsp;/gi, ' ')
            .replace(/<br\s*\/?\s*>/gi, '')
            .replace(/<\/?(p|div|span)[^>]*>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, '')
            .trim();
        return stripped.length === 0;
    };

    // Guard: never start with an empty page.
    while (pages.length > 1 && isPageHtmlEffectivelyEmpty(pages[0])) {
        pages.shift();
    }

    document.body.removeChild(measurePage);

    previewContent.innerHTML = '';
    if (pages.length === 0) {
        previewContent.innerHTML = '<div class="a4-page" data-page="Page 1"></div>';
        return;
    }

    pages.forEach((pageContent, index) => {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'a4-page';
        pageDiv.setAttribute('data-page', `Page ${index + 1}`);
        pageDiv.innerHTML = pageContent;
        previewContent.appendChild(pageDiv);
    });

    // Update TOC with real page numbers after pagination
    updateTOCPageNumbers();
}

function updateTOCPageNumbers() {
    // Find all TOC entries
    const tocEntries = previewContent.querySelectorAll('.toc-entry a');
    if (tocEntries.length === 0) return;

    // Get all pages
    const pages = previewContent.querySelectorAll('.a4-page');
    if (pages.length === 0) return;

    // For each TOC entry, find which page its target heading is on
    tocEntries.forEach(tocLink => {
        const href = tocLink.getAttribute('href');
        if (!href || !href.startsWith('#')) return;

        const targetId = href.substring(1); // Remove the #

        // Find the heading with this ID across all pages
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const page = pages[pageIndex];
            const heading = page.querySelector(`#${CSS.escape(targetId)}`);

            if (heading) {
                // Found the heading on this page
                const pageNum = pageIndex + 1;
                const pageSpan = tocLink.querySelector('.toc-page');
                if (pageSpan) {
                    pageSpan.textContent = pageNum;
                }
                break;
            }
        }
    });
}

function showToast(message, duration = 3000) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}

function showLoading() {
    loadingOverlay.classList.add('active');
}

function hideLoading() {
    loadingOverlay.classList.remove('active');
}

async function loadCSS(filename, cacheBust = false) {
    // Browsers block `fetch(file://...)` from a page opened via file:// (origin = "null").
    // When running from disk, rely on already-loaded stylesheets instead of fetching.
    if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
        return '';
    }
    try {
        const url = cacheBust ? `${filename}?v=${Date.now()}` : filename;
        const response = await fetch(url, { cache: 'no-store' });
        return await response.text();
    } catch (error) {
        console.warn(`Could not load ${filename}:`, error);
        return '';
    }
}

function getPdfApiUrl() {
    const protocol = (window.location && window.location.protocol) ? window.location.protocol : '';
    if (protocol === 'http:' || protocol === 'https:') return '/api/pdf';

    // If index.html is opened directly from disk, the only workable way to hit the API
    // is to call a local server explicitly (and have it allow CORS).
    return 'http://127.0.0.1:8010/api/pdf';
}

function getLoadedStylesheetText(hrefIncludes) {
    const target = (hrefIncludes || '').toLowerCase();
    if (!target) return '';

    const styleSheets = Array.from(document.styleSheets);
    for (const sheet of styleSheets) {
        const href = (sheet && sheet.href ? String(sheet.href) : '').toLowerCase();
        if (!href || !href.includes(target)) continue;
        try {
            const rules = Array.from(sheet.cssRules || []);
            return rules.map((r) => r.cssText).join('\n');
        } catch (error) {
            // Accessing cssRules can throw for cross-origin sheets; ignore and continue.
            continue;
        }
    }
    return '';
}

function setPreviewZoom(zoomLevel) {
    const minZoom = 0.5;
    const maxZoom = 2;
    const nextZoom = Math.min(maxZoom, Math.max(minZoom, zoomLevel));

    // Prefer the browser's layout zoom (keeps scrollbars correct).
    const supportsZoom = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('zoom', '1');
    if (supportsZoom) {
        previewContent.style.zoom = String(nextZoom);
        previewContent.style.transform = '';
    } else {
        // Fallback (some browsers may ignore `zoom`).
        previewContent.style.zoom = '';
        previewContent.style.transform = `scale(${nextZoom})`;
    }

    previewContent.dataset.zoom = String(nextZoom);

    // Persist across refresh.
    try {
        localStorage.setItem(STORAGE_KEYS.previewZoom, String(nextZoom));
    } catch { /* ignore */ }
}

function getCurrentPreviewZoom() {
    const raw = previewContent.dataset.zoom;
    const parsed = raw ? Number(raw) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function setEditorZoom(fontSizePx) {
    if (!editorWrapper) return;
    const minSize = 12;
    const maxSize = 22;
    const nextSize = Math.min(maxSize, Math.max(minSize, fontSizePx));
    editorWrapper.style.setProperty('--editor-font-size', `${nextSize}px`);

    if (markdownEditor) markdownEditor.refresh();
    if (cssEditor) cssEditor.refresh();

    try {
        localStorage.setItem(STORAGE_KEYS.editorZoom, String(nextSize));
    } catch { /* ignore */ }
}

function getCurrentEditorZoom() {
    const raw = editorWrapper ? getComputedStyle(editorWrapper).getPropertyValue('--editor-font-size') : '';
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;

    const stored = localStorage.getItem(STORAGE_KEYS.editorZoom);
    const storedNum = stored ? Number(stored) : NaN;
    return Number.isFinite(storedNum) && storedNum > 0 ? storedNum : 15;
}

function applySavedEditorZoom() {
    const stored = localStorage.getItem(STORAGE_KEYS.editorZoom);
    const storedNum = stored ? Number(stored) : NaN;
    const nextSize = Number.isFinite(storedNum) && storedNum > 0 ? storedNum : getCurrentEditorZoom();
    setEditorZoom(nextSize);
}

function applySavedEditorSplit() {
    if (!editorContainer) return;
    const stored = localStorage.getItem(STORAGE_KEYS.editorSplit);
    if (stored) {
        editorContainer.style.setProperty('--editor-split', stored);
    }
}

function setupEditorResize() {
    if (!editorDivider || !editorContainer) return;

    const onPointerMove = (event) => {
        const rect = editorContainer.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const percent = Math.max(25, Math.min(75, (x / rect.width) * 100));
        const value = `${percent.toFixed(2)}%`;
        editorContainer.style.setProperty('--editor-split', value);
        try {
            localStorage.setItem(STORAGE_KEYS.editorSplit, value);
        } catch { /* ignore */ }
    };

    const stopDrag = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', stopDrag);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    editorDivider.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', stopDrag, { once: true });
    });
}

// ==================== PDF Generation (html2pdf) ====================
// NOTE: html2pdf/html2canvas produces image-based PDFs (text not selectable).

function getPreviewPagesHTML() {
    const pages = previewContent.querySelectorAll('.a4-page');
    let allContent = '';
    pages.forEach((page) => {
        allContent += page.outerHTML;
    });
    return allContent;
}

async function downloadPDF() {
    if (!getMarkdownValue().trim()) {
        showToast('⚠️ Please enter some Markdown content first!');
        return;
    }

    const pdfFilename = getPdfFilenameFromUser();
    if (!pdfFilename) return;

    showLoading();

    let pdfContainer = null;

    try {
        // Make sure web fonts have loaded before rendering.
        try {
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
            }
        } catch { /* ignore */ }

        // Combine default markdown styles with any custom CSS.
        const customStyles = getCustomCss();
        const baseStyles = defaultMarkdownCssText || '';
        const combinedStyles = (baseStyles && customStyles) ? `${baseStyles}\n\n${customStyles}` : (customStyles || baseStyles);

        const allContent = getPreviewPagesHTML();

        // Build a self-contained HTML document for server-side printing (selectable text PDF).
        const googleFontsHref = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Barlow:wght@300;400;500;600;700&family=Fira+Code:wght@400;500&display=swap';
        const pageNumberCss = (pageNumbers && pageNumbers.checked) ? `
                    .a4-page { position: relative; }
                    .a4-page::after {
                        content: attr(data-page);
                        position: absolute;
                        bottom: 10mm;
                        right: 20mm;
                        font-size: 10px;
                        color: #999;
                    }
                ` : '';

        const printCss = `
                    @page { size: A4; margin: 0; }
                    html, body { margin: 0; padding: 0; background: #ffffff; color: #1a1a1a; }
                    body {
                        font-family: Barlow, sans-serif;
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                    .a4-page {
                        width: 210mm;
                        height: 297mm;
                        padding: 20mm;
                        box-sizing: border-box;
                        background: #ffffff;
                        color: #1a1a1a;
                        box-shadow: none !important;
                        margin: 0 !important;
                        overflow: hidden;
                        page-break-after: always;
                        break-after: page;
                    }
                    .a4-page:last-child { page-break-after: auto; break-after: auto; }
                    pre, blockquote, table, img { page-break-inside: avoid; break-inside: avoid; }
                    ${pageNumberCss}
                    .float-right { float: right; display: inline-block; }
                    .line-split { display: flex; align-items: baseline; gap: 1rem; }
                    .line-split .right { margin-left: auto; text-align: right; }
                `;

        const htmlForServer = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link rel="stylesheet" href="${googleFontsHref}">
        <style>${printCss}</style>
        <style>${combinedStyles}</style>
    </head>
    <body>
        ${allContent}
    </body>
</html>`;

        // Try server-side PDF generation first (selectable text).
        try {
            const sid = await ensureSession();
            const response = await fetch(getPdfApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: htmlForServer, filename: pdfFilename, session_id: sid })
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = pdfFilename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);

                hideLoading();
                showToast('✅ PDF downloaded (selectable text)');
                return;
            }
        } catch (error) {
            // Server not running or unreachable -> fall back below.
            console.warn('PDF server unavailable, falling back to html2pdf:', error);
        }

        // Final cleanup for HTML2PDF container
        const cleanContent = allContent.trim();

        // html2pdf needs a real DOM element; create one off-screen.
        pdfContainer = document.createElement('div');
        pdfContainer.id = 'pdf-container';
        pdfContainer.style.position = 'fixed';
        pdfContainer.style.left = '-100000px';
        pdfContainer.style.top = '0';
        pdfContainer.style.width = '210mm';
        pdfContainer.style.background = '#ffffff';
        document.body.appendChild(pdfContainer);

        pdfContainer.innerHTML = `
                    <style>
                        html, body { margin: 0; padding: 0; background: #ffffff; -webkit-print-color-adjust: exact; }
                        .pdf-root {
                            background: #fff;
                            color: #1a1a1a;
                            font-family: Barlow, sans-serif;
                            display: block;
                            margin: 0;
                            padding: 0;
                            line-height: 0; /* Remove potential whitespace height */
                        }

                        .pdf-root .a4-page {
                            width: 210mm !important;
                            height: 297mm !important;
                            padding: 20mm !important;
                            margin: 0 !important;
                            box-shadow: none !important;
                            box-sizing: border-box !important;
                            background: white !important;
                            position: relative !important;
                            overflow: hidden !important;
                            display: block;
                            line-height: 1.6; /* Restore text line height */
                            page-break-after: always !important;
                            break-after: page !important;
                        }
                        
                        .pdf-root .a4-page:last-child {
                            page-break-after: avoid !important;
                            break-after: avoid !important;
                        }

                        ${pageNumbers && pageNumbers.checked ? `
                            .pdf-root .a4-page { position: relative; }
                            .pdf-root .a4-page::after {
                                content: attr(data-page);
                                position: absolute;
                                bottom: 10mm;
                                right: 20mm;
                                font-size: 10px;
                                color: #999;
                            }
                        ` : ''}

                        ${combinedStyles}
                    </style>
                    <div class="pdf-root">${cleanContent}</div>`;

        const opt = {
            margin: 0,
            filename: pdfFilename,
            image: { type: 'jpeg', quality: 1.0 },
            html2canvas: {
                scale: 2,
                useCORS: true,
                letterRendering: true,
                backgroundColor: '#ffffff',
                logging: false
            },
            jsPDF: {
                unit: 'mm',
                format: 'a4',
                orientation: 'portrait',
                compress: true
            },
            pagebreak: {
                mode: 'css',
                before: '.page-break'
            }
        };

        await html2pdf().set(opt).from(pdfContainer).save();

        hideLoading();
        showToast('✅ PDF downloaded (image-based). Run server.py for selectable text.');
    } catch (error) {
        console.error('PDF generation error:', error);
        hideLoading();
        showToast('❌ Error generating PDF. Please try again.');
    } finally {
        try {
            if (pdfContainer && pdfContainer.parentNode) {
                pdfContainer.parentNode.removeChild(pdfContainer);
            }
        } catch { /* ignore */ }
    }
}

// ==================== Other Functions ====================

function clearEditor() {
    if (getMarkdownValue().trim() && !confirm('Are you sure you want to clear all content?')) {
        return;
    }
    (async () => {
        try {
            await resetSessionWorkspace();
        } catch { /* ignore */ }
        setMarkdownValue('');
        updatePreview();
        showToast('🗑️ Content cleared');
        autoSave();
    })();
}

function uploadFile() {
    fileInput.click();
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    currentDocBaseName = guessBaseNameFromFilename(file.name);

    const validTypes = ['.md', '.markdown', '.txt', '.zip'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

    if (!validTypes.includes(fileExtension)) {
        showToast('⚠️ Please upload a Markdown file or ZIP (.md, .markdown, .txt, or .zip)');
        return;
    }

    if (fileExtension === '.zip') {
        (async () => {
            try {
                // New document creation: delete the previous workspace.
                if (currentSessionId) {
                    try {
                        await fetch(getApiUrl(`/api/session/${currentSessionId}/delete`), { method: 'POST' });
                    } catch { /* ignore */ }
                }
                showToast('📦 Importing ZIP...');
                const form = new FormData();
                form.append('file', file, file.name);
                const res = await fetch(getApiUrl('/api/import-zip'), { method: 'POST', body: form });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Import failed');
                }
                const json = await res.json();
                currentSessionId = json.session_id;
                sessionStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
                localStorage.setItem(SESSION_PERSIST_KEY, currentSessionId);

                const extracted = extractCustomCssFromMarkdown(json.markdown);
                setMarkdownValue(extracted.markdown);
                userEditedCss = !!(extracted.css && normalizeCss(extracted.css) && normalizeCss(extracted.css) !== normalizeCss(defaultMarkdownCssText));
                setCustomCssProgrammatic(extracted.css || defaultMarkdownCssText);
                resetTextareaView(markdownEditor || markdownInput);
                resetTextareaView(cssEditor || cssInput);
                updatePreview();
                autoSave();
                showToast('✅ ZIP imported');
            } catch (e) {
                console.error('ZIP import error:', e);
                showToast('❌ ZIP import failed');
            } finally {
                fileInput.value = '';
            }
        })();
        return;
    }

    // New document creation (opening a new markdown file): reset server workspace.
    (async () => {
        try { await resetSessionWorkspace(); } catch { /* ignore */ }
    })();

    const reader = new FileReader();

    reader.onload = function (e) {
        const raw = e.target.result;
        const extracted = extractCustomCssFromMarkdown(raw);
        setMarkdownValue(extracted.markdown);
        userEditedCss = !!(extracted.css && normalizeCss(extracted.css) && normalizeCss(extracted.css) !== normalizeCss(defaultMarkdownCssText));
        setCustomCssProgrammatic(extracted.css || defaultMarkdownCssText);
        resetTextareaView(markdownEditor || markdownInput);
        resetTextareaView(cssEditor || cssInput);
        updatePreview();
        showToast('✅ File loaded successfully!');
        autoSave();
    };

    reader.onerror = function () {
        showToast('❌ Error reading file. Please try again.');
    };

    reader.readAsText(file);
    fileInput.value = '';
}

// ==================== Image Paste Handling ====================

async function uploadPastedImageBlob(blob) {
    const sid = await ensureSession();
    const form = new FormData();
    // Name doesn't matter server-side; extension inferred from content-type.
    form.append('file', blob, 'pasted-image');
    const res = await fetch(getApiUrl(`/api/session/${sid}/paste-image`), { method: 'POST', body: form });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Image upload failed');
    }
    const json = await res.json();
    return json.relative_path;
}

function getActiveMarkdownEditorTarget() {
    if (markdownEditor) return markdownEditor;
    return markdownInput;
}

function bindImagePasteHandler() {
    const targetEl = markdownEditor ? markdownEditor.getWrapperElement() : markdownInput;
    if (!targetEl) return;

    targetEl.addEventListener('paste', (event) => {
        const clipboard = event.clipboardData;
        if (!clipboard || !clipboard.items) return;

        const items = Array.from(clipboard.items);
        const imageItem = items.find((it) => it && typeof it.type === 'string' && it.type.startsWith('image/'));
        if (!imageItem) return;

        const blob = imageItem.getAsFile();
        if (!blob) return;

        event.preventDefault();

        (async () => {
            try {
                const rel = await uploadPastedImageBlob(blob);
                const snippet = `<img src="${rel}" height="200">`;

                const editorTarget = getActiveMarkdownEditorTarget();
                insertSnippet(editorTarget, snippet);
                updatePreview();
                autoSave();
                showToast('🖼️ Image pasted');
            } catch (e) {
                console.error('Paste image error:', e);
                showToast('❌ Could not paste image. Is server.py running?');
            }
        })();
    });
}

function loadExample() {
    const exampleMarkdown = `# Project Documentation

## Overview
This is a comprehensive guide to our project.

### Table of Contents
1. [Introduction](#introduction)
2. [Installation](#installation)
3. [Usage](#usage)
4. [API Reference](#api-reference)

---

## Introduction

Welcome to our **amazing project**! This tool helps you:

- Convert Markdown to PDF
- Create beautiful documents
- Save time and effort

> "Simplicity is the ultimate sophistication." - Leonardo da Vinci

## Installation

Install the package using npm:

\`\`\`bash
npm install awesome-package
\`\`\`

Or using yarn:

\`\`\`bash
yarn add awesome-package
\`\`\`

## Usage

Here's a simple example:

\`\`\`javascript
const converter = require('awesome-package');

converter.convert('input.md', 'output.pdf', {
    theme: 'modern',
    pageSize: 'A4'
});
\`\`\`

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| theme | string | 'default' | Visual theme |
| pageSize | string | 'A4' | Paper size |
| margins | object | {top: 20} | Page margins |

## API Reference

### \`convert(input, output, options)\`

Converts a Markdown file to PDF.

**Parameters:**
- \`input\` (string): Path to input file
- \`output\` (string): Path to output file
- \`options\` (object): Configuration options

**Returns:** Promise<void>

**Example:**
\`\`\`javascript
await convert('README.md', 'README.pdf', {
    theme: 'dark'
});
\`\`\`

---

## License

MIT © 2026 Your Name

For more information, visit [our website](https://example.com).
`;
    setMarkdownValue(exampleMarkdown);
    updatePreview();
    showToast('📄 Example loaded!');
}

function showAbout() {
    const aboutMessage = `MD2PDF - Markdown to PDF Converter

Version: 1.0.0
Built with: HTML, CSS, JavaScript
Libraries: Marked.js, html2pdf.js

This tool runs locally. For selectable-text PDFs, pasted images, and ZIP import/export, it uses the local FastAPI server (server.py).

Features:
✨ Real-time preview
🎨 Beautiful formatting
🔒 100% private & secure
💾 No installation needed

Created with ❤️ for the community.`;
    alert(aboutMessage);
}

function toggleFullscreen() {
    const previewPanel = previewContent.closest('.editor-panel');
    if (!document.fullscreenElement) {
        previewPanel.requestFullscreen().catch(() => showToast('⚠️ Fullscreen not supported'));
    } else {
        document.exitFullscreen();
    }
}

function handleKeyboardShortcuts(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        downloadPDF();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        clearEditor();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'o') {
        event.preventDefault();
        uploadFile();
    }
}

// ==================== Touchpad Zoom Support ====================
let lastTouchDistance = 0;

function handleWheelZoom(event) {
    if (event.ctrlKey) {
        event.preventDefault();
        const delta = -event.deltaY;
        const zoomFactor = 0.001;
        const currentZoom = getCurrentPreviewZoom();
        setPreviewZoom(currentZoom + delta * zoomFactor);
    }
}

function handleTouchZoom(event) {
    if (event.touches.length === 2) {
        event.preventDefault();
        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const distance = Math.hypot(touch1.pageX - touch2.pageX, touch1.pageY - touch2.pageY);

        if (lastTouchDistance > 0) {
            const delta = distance - lastTouchDistance;
            const zoomFactor = 0.01;
            const currentZoom = getCurrentPreviewZoom();
            setPreviewZoom(currentZoom + delta * zoomFactor);
        }
        lastTouchDistance = distance;
    }
}

function resetTouchDistance() {
    lastTouchDistance = 0;
}

function autoSave() {
    try {
        localStorage.setItem(STORAGE_KEYS.markdown, getMarkdownValue());
        localStorage.setItem(STORAGE_KEYS.pageNumbers, pageNumbers.checked);

        // Intentionally do NOT persist CSS tab contents.
        // Requirement: every page load must reflect markdown-styles.css exactly.
        if (cssInput) {
            localStorage.removeItem(STORAGE_KEYS.customCss);
            localStorage.removeItem(STORAGE_KEYS.savedDefaultCssHash);
        }
    } catch (error) {
        console.warn('Could not save to localStorage:', error);
    }
}

function loadFromStorage() {
    try {
        const savedContent = localStorage.getItem(STORAGE_KEYS.markdown);
        const savedPageNumbers = localStorage.getItem(STORAGE_KEYS.pageNumbers);
        const savedZoom = localStorage.getItem(STORAGE_KEYS.previewZoom);

        if (savedContent) setMarkdownValue(savedContent);
        if (savedPageNumbers !== null) pageNumbers.checked = savedPageNumbers === 'true';

        // Always load the current markdown-styles.css content into the CSS tab.
        // Also clear any previously-saved overrides so disk edits are never masked.
        userEditedCss = false;
        localStorage.removeItem(STORAGE_KEYS.customCss);
        localStorage.removeItem(STORAGE_KEYS.savedDefaultCssHash);
        setCustomCssProgrammatic(defaultMarkdownCssText);

        if (savedZoom) {
            const zoomNum = Number(savedZoom);
            if (Number.isFinite(zoomNum) && zoomNum > 0) {
                setPreviewZoom(zoomNum);
            }
        }

        applyPageNumberVisibility();

        // Keep editor viewport at the top on refresh.
        resetTextareaView(markdownEditor || markdownInput);
        resetTextareaView(cssEditor || cssInput);
    } catch (error) {
        console.warn('Could not load from localStorage:', error);
    }
}

// ==================== Event Listeners ====================

let debounceTimer;
function handleMarkdownInputChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        updatePreview();
        autoSave();
    }, 300);
}

function handleCssInputChange() {
    applyCustomCssToPreview();
    if (suppressCssTracking) return;
    userEditedCss = true;
    autoSave();
}

function handleMarkdownEditorKeydown(event, target) {
    const editorTarget = target || markdownEditor || markdownInput;

    // SHIFT + R wraps the selection in a right-float span
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'R' || event.key === 'r')) {
        event.preventDefault();
        let hasSelection = false;

        if (isCodeMirrorInstance(editorTarget)) {
            const selected = editorTarget.getDoc().getSelection();
            hasSelection = !!selected;
        } else {
            hasSelection = editorTarget.selectionStart !== editorTarget.selectionEnd;
        }

        if (!hasSelection) {
            showToast('Select text to float right');
            return;
        }

        wrapOrInsert(editorTarget, '<span class="float-right">', '</span>');
        updatePreview();
        autoSave();
        return;
    }

    // CTRL + ENTER for Page Break
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        const snippet = '\n\n<div class="page-break"></div>\n\n';
        insertSnippet(editorTarget, snippet);
        updatePreview();
        autoSave();
        showToast('📑 Page break inserted');
        return;
    }

    // ALT + N for blank line (avoid conflicts with browser/system shortcuts and page-break)
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        const snippet = '<br>\n';
        insertSnippet(editorTarget, snippet);
        updatePreview();
        autoSave();
        showToast('↵ <br> inserted');
        return;
    }

    // Basic formatting shortcuts
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        wrapOrInsert(editorTarget, '**', '**');
        updatePreview();
        autoSave();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'i' || event.key === 'I')) {
        event.preventDefault();
        wrapOrInsert(editorTarget, '*', '*');
        updatePreview();
        autoSave();
        return;
    }
    // Inline code (common in some editors)
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        wrapOrInsert(editorTarget, '`', '`');
        updatePreview();
        autoSave();
        return;
    }

    if (event.key === 'Tab') {
        event.preventDefault();
        insertSnippet(editorTarget, '    ');
    }
}

function bindEditorEvents() {
    if (markdownEditor) {
        markdownEditor.on('change', handleMarkdownInputChange);
        markdownEditor.on('keydown', (cm, event) => handleMarkdownEditorKeydown(event, cm));
        // Cache the last non-empty selection so touchpad right-click can still format it.
        markdownEditor.on('cursorActivity', () => saveLastSelectionFromEditor(markdownEditor));

        try {
            const wrapper = markdownEditor.getWrapperElement();
            if (wrapper) {
                wrapper.addEventListener('mouseup', () => saveLastSelectionFromEditor(markdownEditor));
                wrapper.addEventListener('keyup', () => saveLastSelectionFromEditor(markdownEditor));
            }
        } catch { /* ignore */ }
    } else if (markdownInput) {
        markdownInput.addEventListener('input', handleMarkdownInputChange);
        markdownInput.addEventListener('keydown', (event) => handleMarkdownEditorKeydown(event, markdownInput));
        markdownInput.addEventListener('mouseup', () => saveLastSelectionFromEditor(markdownInput));
        markdownInput.addEventListener('keyup', () => saveLastSelectionFromEditor(markdownInput));
        markdownInput.addEventListener('select', () => saveLastSelectionFromEditor(markdownInput));
    }

    if (cssEditor) {
        cssEditor.on('change', handleCssInputChange);
    } else if (cssInput) {
        cssInput.addEventListener('input', handleCssInputChange);
    }

    // Right-click context menu for markdown editor formatting.
    bindEditorContextMenu();
}

btnDownload.addEventListener('click', downloadPDF);
if (btnSaveMd) btnSaveMd.addEventListener('click', saveMarkdownFile);
if (btnSaveMdFs) btnSaveMdFs.addEventListener('click', saveMarkdownFile);
if (btnDownloadFs) btnDownloadFs.addEventListener('click', downloadPDF);
btnClear.addEventListener('click', clearEditor);
btnUpload.addEventListener('click', uploadFile);
btnExamples.addEventListener('click', loadExample);
btnAbout.addEventListener('click', showAbout);
btnFullscreen.addEventListener('click', toggleFullscreen);
if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
        const current = getCurrentPreviewZoom();
        setPreviewZoom(Number((current + 0.1).toFixed(2)));
    });
}
if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
        const current = getCurrentPreviewZoom();
        setPreviewZoom(Number((current - 0.1).toFixed(2)));
    });
}

if (btnEditorZoomIn) {
    btnEditorZoomIn.addEventListener('click', () => {
        const current = getCurrentEditorZoom();
        setEditorZoom(current + 1);
    });
}

if (btnEditorZoomOut) {
    btnEditorZoomOut.addEventListener('click', () => {
        const current = getCurrentEditorZoom();
        setEditorZoom(current - 1);
    });
}

fileInput.addEventListener('change', handleFileSelect);

pageNumbers.addEventListener('change', () => {
    applyPageNumberVisibility();
    autoSave();
});

if (cssInput) {
    // Events are bound in bindEditorEvents to support CodeMirror.
}

if (tabMarkdown && tabCss) {
    tabMarkdown.addEventListener('click', () => setEditorTab('markdown', true));
    tabCss.addEventListener('click', () => setEditorTab('css', true));
}

document.addEventListener('keydown', handleKeyboardShortcuts);

// Note: we intentionally do NOT delete the active session on tab close.
// The latest session is persisted so pasted images keep working after reopening the app.
// Old sessions are cleaned up via explicit reset/new-doc flows and server TTL cleanup.

// Markdown editor key bindings are handled in bindEditorEvents.

// Preview Panel Zoom Listeners
const previewWrapper = document.querySelector('.preview-wrapper');
if (previewWrapper) {
    previewWrapper.addEventListener('wheel', handleWheelZoom, { passive: false });
    previewWrapper.addEventListener('touchmove', handleTouchZoom, { passive: false });
    previewWrapper.addEventListener('touchend', resetTouchDistance);
    previewWrapper.addEventListener('touchcancel', resetTouchDistance);
}

function setupHeaderFadeOnScroll() {
    const header = document.querySelector('.header');
    if (!header) return;

    let ticking = false;
    const update = () => {
        const shouldFade = window.scrollY > 20;
        header.classList.toggle('is-faded', shouldFade);
        ticking = false;
    };

    const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    update();
}

// ==================== Initialization ====================

(async () => {
    await initDefaultMarkdownCss();
    initCodeEditors();
    try {
        await ensureSession();
    } catch { /* ignore: app still works without server */ }
    loadFromStorage();
    updatePreview();
    bindEditorEvents();
    bindImagePasteHandler();
    applySavedEditorZoom();
    applySavedEditorSplit();
    setupEditorResize();

    setupHeaderFadeOnScroll();

    // Default zoom only if nothing was restored.
    if (!previewContent.dataset.zoom) {
        setPreviewZoom(1);
    }

    // Default to Markdown tab.
    setEditorTab('markdown', false);

    // Some browsers scroll to the focused caret after layout; force top once more.
    requestAnimationFrame(() => {
        resetTextareaView(markdownEditor || markdownInput);
        resetTextareaView(cssEditor || cssInput);
    });
})();

setTimeout(() => {
    showToast('👋 Welcome to MD2PDF! Start typing to see the magic ✨', 4000);
}, 500);

console.log('%c MD2PDF Initialized! ', 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 8px 16px; border-radius: 4px; font-weight: bold;');
console.log('Keyboard shortcuts:');
console.log('  Ctrl/Cmd + S: Download PDF');
console.log('  Ctrl/Cmd + K: Clear editor');
console.log('  Ctrl/Cmd + O: Upload file');
console.log('  Ctrl/Cmd + Enter: Insert Page Break');
console.log('  Alt + N: Blank line');
console.log('  Ctrl/Cmd + B: Bold');
console.log('  Ctrl/Cmd + I: Italic');
console.log('  Ctrl/Cmd + E: Inline code');
