// Why: this stylesheet targets the *exported* PDF document, not the live Botmux
// pane. In-app CSS assumes sticky UI chrome, hover affordances, and app-shell
// spacing that would look wrong when flattened to paper. Keeping export CSS
// separate also means a future UI refactor can move live classes without
// silently breaking PDF output.
export const EXPORT_CSS = `
* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
    sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  font-size: 14px;
  line-height: 1.6;
}

.botmux-export-root {
  padding: 0;
  max-width: 100%;
}

.botmux-export-root h1,
.botmux-export-root h2,
.botmux-export-root h3,
.botmux-export-root h4,
.botmux-export-root h5,
.botmux-export-root h6 {
  font-weight: 600;
  line-height: 1.25;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}

.botmux-export-root h1 { font-size: 1.9em; }
.botmux-export-root h2 { font-size: 1.5em; }
.botmux-export-root h3 { font-size: 1.25em; }
.botmux-export-root h4 { font-size: 1em; }

.botmux-export-root p,
.botmux-export-root blockquote,
.botmux-export-root ul,
.botmux-export-root ol,
.botmux-export-root pre,
.botmux-export-root table {
  margin-top: 0;
  margin-bottom: 1em;
}

.botmux-export-root a {
  color: #0969da;
  text-decoration: underline;
}

.botmux-export-root blockquote {
  padding: 0 1em;
  color: #57606a;
  border-left: 0.25em solid #d0d7de;
}

.botmux-export-root code,
.botmux-export-root pre {
  font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

.botmux-export-root code {
  background: #f6f8fa;
  padding: 0.2em 0.4em;
  border-radius: 4px;
}

.botmux-export-root pre {
  background: #f6f8fa;
  padding: 12px 16px;
  border-radius: 6px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.botmux-export-root pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

.botmux-export-root table {
  border-collapse: collapse;
  width: 100%;
}

.botmux-export-root th,
.botmux-export-root td {
  border: 1px solid #d0d7de;
  padding: 6px 12px;
  text-align: left;
}

.botmux-export-root th { background: #f6f8fa; }

.botmux-export-root img,
.botmux-export-root svg {
  max-width: 100%;
  height: auto;
}

.botmux-export-root ul,
.botmux-export-root ol { padding-left: 2em; }

.botmux-export-root li { margin: 0.25em 0; }

.botmux-export-root input[type="checkbox"] {
  margin-right: 0.4em;
}

.botmux-export-root hr {
  border: 0;
  border-top: 1px solid #d0d7de;
  margin: 1.5em 0;
}

/* Why: the export subtree selection already excludes the big chrome (toolbar,
   search bar, etc.), but in-document affordances like the code-copy button
   can still leak. Hide the well-known offenders as a belt-and-suspenders
   defense on top of DOM scrubbing. */
.code-block-copy-btn,
.markdown-preview-search,
.rich-markdown-toolbar,
[data-botmux-export-hide="true"] {
  display: none !important;
}

.code-block-wrapper { position: static !important; }

@media print {
  pre, code, table, img, svg { page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
}
`
