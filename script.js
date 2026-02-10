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

const STORAGE_KEYS = {
    markdown: 'md2pdf_content',
    pageNumbers: 'md2pdf_page_numbers',
    customCss: 'md2pdf_custom_css',
    previewZoom: 'md2pdf_preview_zoom'
};

let defaultMarkdownCssText = '';
let currentDocBaseName = 'document';

function normalizeCss(css) {
    return String(css || '').replace(/\r\n/g, '\n').trim();
}

async function initDefaultMarkdownCss() {
    // Prefer fetching the raw file when served over http(s) so formatting/comments are preserved.
    // When opened via file://, fetch(file://...) is blocked; we fall back to cssRules (which is normalized).
    let css = '';

    if (window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
        css = await loadCSS('markdown-styles.css');
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
    return (cssInput && typeof cssInput.value === 'string') ? cssInput.value : '';
}

function setCustomCss(value) {
    if (!cssInput) return;
    cssInput.value = value || '';
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

function wrapOrInsert(textarea, left, right) {
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

function setEditorTab(tab, shouldFocus = true) {
    if (!markdownInput || !cssInput || !tabMarkdown || !tabCss) return;

    const isMarkdown = tab === 'markdown';
    markdownInput.hidden = !isMarkdown;
    cssInput.hidden = isMarkdown;

    tabMarkdown.classList.toggle('active', isMarkdown);
    tabCss.classList.toggle('active', !isMarkdown);
    tabMarkdown.setAttribute('aria-selected', isMarkdown ? 'true' : 'false');
    tabCss.setAttribute('aria-selected', !isMarkdown ? 'true' : 'false');

    // Focus active editor for better UX (but skip on initial load to avoid scroll-to-caret jumps).
    if (shouldFocus) {
        try { (isMarkdown ? markdownInput : cssInput).focus(); } catch { /* ignore */ }
    }
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
    const content = embedCustomCssIntoMarkdown(markdownInput.value, getCustomCss());
    const suggested = (currentDocBaseName || 'document').trim() || 'document';
    const entered = prompt('Save as (without extension):', suggested);
    if (entered === null) return; // cancelled
    const base = guessBaseNameFromFilename(entered);
    currentDocBaseName = base;
    downloadTextFile(`${base}.md`, content);
    showToast('💾 Markdown saved');
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

markdownInput.value = defaultMarkdown;

// ==================== Core Functions ====================

function updatePreview() {
    const markdownText = markdownInput.value;
    const htmlContent = marked.parse(markdownText);
    paginateContent(htmlContent);
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
    // Added a small safety margin (-2px) to prevent rounding errors from triggering extra pages
    const maxBottom = measurePage.clientHeight - paddingBottomPx - 2;

    // Put content into a temporary wrapper to get top-level blocks.
    const tempWrapper = document.createElement('div');
    tempWrapper.innerHTML = htmlContent;
    const elements = Array.from(tempWrapper.children);

    const pages = [];
    let currentPageHTML = [];
    let currentPageElements = [];

    // Helper: check if element is a heading
    const isHeading = (el) => {
        return el && /^H[1-6]$/i.test(el.tagName);
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
        const element = elements[i];
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
        const clone = element.cloneNode(true);
        measurePage.appendChild(clone);

        const used = getUsedHeightPx();
        if (used <= maxBottom || measurePage.children.length === 1) {
            currentPageHTML.push(element.outerHTML);
            currentPageElements.push(element);

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

        // Overflowed: move element to next page.
        measurePage.removeChild(clone);

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

async function loadCSS(filename) {
    // Browsers block `fetch(file://...)` from a page opened via file:// (origin = "null").
    // When running from disk, rely on already-loaded stylesheets instead of fetching.
    if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
        return '';
    }
    try {
        const response = await fetch(filename);
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
    return 'http://127.0.0.1:8000/api/pdf';
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
    if (!markdownInput.value.trim()) {
        showToast('⚠️ Please enter some Markdown content first!');
        return;
    }

    showLoading();

    let pdfContainer = null;

    try {
        // Make sure web fonts have loaded before rendering.
        try {
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
            }
        } catch { /* ignore */ }

        // Styling is always included now (CSS tab controls it).
        const customStyles = getCustomCss();

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
                        min-height: 297mm;
                        padding: 20mm;
                        box-sizing: border-box;
                        background: #ffffff;
                        color: #1a1a1a;
                        box-shadow: none !important;
                        margin: 0 !important;
                        page-break-after: always;
                        break-after: page;
                    }
                    .a4-page:last-child { page-break-after: auto; break-after: auto; }
                    pre, blockquote, table, img { page-break-inside: avoid; break-inside: avoid; }
                    ${pageNumberCss}
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
        <style>${customStyles}</style>
    </head>
    <body>
        ${allContent}
    </body>
</html>`;

        // Try server-side PDF generation first (selectable text).
        try {
            const response = await fetch(getPdfApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: htmlForServer, filename: 'document.pdf' })
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'document.pdf';
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

                        ${customStyles}
                    </style>
                    <div class="pdf-root">${cleanContent}</div>`;

        const opt = {
            margin: 0,
            filename: 'document.pdf',
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
    if (markdownInput.value.trim() && !confirm('Are you sure you want to clear all content?')) {
        return;
    }
    markdownInput.value = '';
    updatePreview();
    showToast('🗑️ Content cleared');
}

function uploadFile() {
    fileInput.click();
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    currentDocBaseName = guessBaseNameFromFilename(file.name);

    const validTypes = ['.md', '.markdown', '.txt'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

    if (!validTypes.includes(fileExtension)) {
        showToast('⚠️ Please upload a Markdown file (.md, .markdown, or .txt)');
        return;
    }

    const reader = new FileReader();

    reader.onload = function (e) {
        const raw = e.target.result;
        const extracted = extractCustomCssFromMarkdown(raw);
        markdownInput.value = extracted.markdown;
        setCustomCss(extracted.css || defaultMarkdownCssText);
        resetTextareaView(markdownInput);
        resetTextareaView(cssInput);
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
    markdownInput.value = exampleMarkdown;
    updatePreview();
    showToast('📄 Example loaded!');
}

function showAbout() {
    const aboutMessage = `MD2PDF - Markdown to PDF Converter

Version: 1.0.0
Built with: HTML, CSS, JavaScript
Libraries: Marked.js, html2pdf.js

This tool converts Markdown to beautifully formatted PDFs entirely in your browser. No data is sent to any server - everything happens locally!

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
        localStorage.setItem(STORAGE_KEYS.markdown, markdownInput.value);
        localStorage.setItem(STORAGE_KEYS.pageNumbers, pageNumbers.checked);

        if (cssInput) {
            const currentCss = getCustomCss();
            const isCustom = normalizeCss(currentCss) && normalizeCss(currentCss) !== normalizeCss(defaultMarkdownCssText);
            if (isCustom) {
                localStorage.setItem(STORAGE_KEYS.customCss, currentCss);
            } else {
                localStorage.removeItem(STORAGE_KEYS.customCss);
            }
        }
    } catch (error) {
        console.warn('Could not save to localStorage:', error);
    }
}

function loadFromStorage() {
    try {
        const savedContent = localStorage.getItem(STORAGE_KEYS.markdown);
        const savedPageNumbers = localStorage.getItem(STORAGE_KEYS.pageNumbers);
        const savedCustomCss = localStorage.getItem(STORAGE_KEYS.customCss);
        const savedZoom = localStorage.getItem(STORAGE_KEYS.previewZoom);

        if (savedContent) markdownInput.value = savedContent;
        if (savedPageNumbers !== null) pageNumbers.checked = savedPageNumbers === 'true';

        if (savedCustomCss !== null) {
            setCustomCss(savedCustomCss);
        } else {
            // Default to the existing markdown-styles.css content in the CSS tab.
            setCustomCss(defaultMarkdownCssText);
        }

        if (savedZoom) {
            const zoomNum = Number(savedZoom);
            if (Number.isFinite(zoomNum) && zoomNum > 0) {
                setPreviewZoom(zoomNum);
            }
        }

        applyPageNumberVisibility();

        // Keep editor viewport at the top on refresh.
        resetTextareaView(markdownInput);
        resetTextareaView(cssInput);
    } catch (error) {
        console.warn('Could not load from localStorage:', error);
    }
}

// ==================== Event Listeners ====================

let debounceTimer;
markdownInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        updatePreview();
        autoSave();
    }, 300);
});

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

fileInput.addEventListener('change', handleFileSelect);

pageNumbers.addEventListener('change', () => {
    applyPageNumberVisibility();
    autoSave();
});

if (cssInput) {
    cssInput.addEventListener('input', () => {
        applyCustomCssToPreview();
        autoSave();
    });
}

if (tabMarkdown && tabCss) {
    tabMarkdown.addEventListener('click', () => setEditorTab('markdown', true));
    tabCss.addEventListener('click', () => setEditorTab('css', true));
}

document.addEventListener('keydown', handleKeyboardShortcuts);

markdownInput.addEventListener('keydown', (e) => {
    // CTRL + ENTER for Page Break
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const snippet = '\n\n<div class="page-break"></div>\n\n';

        // Use execCommand to preserve Undo history
        if (!document.execCommand('insertText', false, snippet)) {
            // Fallback for browsers that don't support execCommand on textarea
            const start = markdownInput.selectionStart;
            const end = markdownInput.selectionEnd;
            const value = markdownInput.value;
            markdownInput.value = value.substring(0, start) + snippet + value.substring(end);
            markdownInput.selectionStart = markdownInput.selectionEnd = start + snippet.length;
        }

        updatePreview();
        autoSave();
        showToast('📑 Page break inserted');
        return;
    }

    // ALT + N for blank line (avoid conflicts with browser/system shortcuts and page-break)
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        const snippet = '<br>\n';
        if (!document.execCommand('insertText', false, snippet)) {
            const start = markdownInput.selectionStart;
            const end = markdownInput.selectionEnd;
            const value = markdownInput.value;
            markdownInput.value = value.substring(0, start) + snippet + value.substring(end);
            markdownInput.selectionStart = markdownInput.selectionEnd = start + snippet.length;
        }
        updatePreview();
        autoSave();
        showToast('↵ <br> inserted');
        return;
    }

    // Basic formatting shortcuts
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        wrapOrInsert(markdownInput, '**', '**');
        updatePreview();
        autoSave();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        wrapOrInsert(markdownInput, '*', '*');
        updatePreview();
        autoSave();
        return;
    }
    // Inline code (common in some editors)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        wrapOrInsert(markdownInput, '`', '`');
        updatePreview();
        autoSave();
        return;
    }

    if (e.key === 'Tab') {
        e.preventDefault();

        // Use execCommand to preserve Undo history
        if (!document.execCommand('insertText', false, '    ')) {
            // Fallback for browsers that don't support execCommand on textarea
            const start = markdownInput.selectionStart;
            const end = markdownInput.selectionEnd;
            const value = markdownInput.value;
            markdownInput.value = value.substring(0, start) + '    ' + value.substring(end);
            markdownInput.selectionStart = markdownInput.selectionEnd = start + 4;
        }
    }
});

// Preview Panel Zoom Listeners
const previewWrapper = document.querySelector('.preview-wrapper');
if (previewWrapper) {
    previewWrapper.addEventListener('wheel', handleWheelZoom, { passive: false });
    previewWrapper.addEventListener('touchmove', handleTouchZoom, { passive: false });
    previewWrapper.addEventListener('touchend', resetTouchDistance);
    previewWrapper.addEventListener('touchcancel', resetTouchDistance);
}

// ==================== Initialization ====================

(async () => {
    await initDefaultMarkdownCss();
    loadFromStorage();
    updatePreview();

    // Default zoom only if nothing was restored.
    if (!previewContent.dataset.zoom) {
        setPreviewZoom(1);
    }

    // Default to Markdown tab.
    setEditorTab('markdown', false);

    // Some browsers scroll to the focused caret after layout; force top once more.
    requestAnimationFrame(() => {
        resetTextareaView(markdownInput);
        resetTextareaView(cssInput);
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
