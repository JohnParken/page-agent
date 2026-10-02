# @page-agent/document-export

Form observation, multi-page data aggregation, and document export tools for [Page Agent](https://github.com/alibaba/page-agent).

Allows an in-page Agent to inspect live form fields, summarize structured data across multiple navigation steps, and trigger browser-side document generation (`.docx` or `.xlsx`) through a host-provided converter callback.

---

## ✨ Features

-   **🔎 Form Observation (`extract_form_data`)**

    -   Extracts form controls (`input`, `select`, `textarea`) including labels, values, types, placeholders, and option lists.
    -   Automatically respects security markers: `data-page-agent-sensitive`, `data-page-agent-no-export`, dynamic password/token fields, and configured `contentBlacklist`.
    -   Supports Composed DOM Trees (pierces open Shadow DOM boundaries without leaking sensitive shadow host ancestors).
    -   Enforces scope boundaries: field labels or references outside the configured `root` are never read.

-   **📑 Multi-Step Report Aggregation (`append_to_report`)**

    -   Maintains an in-memory report buffer scoped strictly to the current agent task.
    -   Automatically resets when a new task starts, preventing cross-task data leakage.

-   **📄 Document Generation (`generate_document`)**
    -   Assembles buffered sections and calls a host-provided `DocumentConverter` callback.
    -   Passes the task `AbortSignal` to the converter so user cancellation immediately halts long-running conversions or file downloads.
    -   Keeps the core agent bundle lightweight: zero heavy document libraries (e.g. `docx`, `xlsx`, LibreOffice) bundled into the agent runtime.

---

## 📦 Installation

```bash
npm install @page-agent/document-export
```

Or when using the full `page-agent` package, this capability is accessible directly via configuration:

```bash
npm install page-agent
```

---

## 🚀 Usage

### 1. Integration via `PageAgent`

Pass `experimentalDocumentExport` to the `PageAgent` constructor:

```typescript
import { PageAgent } from 'page-agent'

const agent = new PageAgent({
    // Standard PageAgent configuration...
    experimentalDocumentExport: {
        onConvertDocument: async (markdown, format, signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

            if (format === 'docx') {
                // Use your preferred client-side Markdown-to-DOCX converter
                // (e.g. docx, html-docx-js, or custom renderer)
                await convertMarkdownToDocx(markdown, signal)
                return 'Exported Word document successfully.'
            } else if (format === 'xlsx') {
                // Parse markdown tables and generate spreadsheet via xlsx/exceljs
                await convertMarkdownTablesToXlsx(markdown, signal)
                return 'Exported Excel spreadsheet successfully.'
            }
        },
    },
})
```

### 2. Standalone Tool Creation

If using `@page-agent/core` or custom agent tool registries:

```typescript
import { createDocumentExportTools, DOCUMENT_EXPORT_PROMPT } from '@page-agent/document-export'

const tools = createDocumentExportTools({
    onConvertDocument: async (markdown, format, signal) => {
        // Handle conversion
    },
})

// Register `tools` with your PageAgentCore instance and append `DOCUMENT_EXPORT_PROMPT` to your system prompt.
```

---

## 🔒 Security & Sensitivity Boundaries

To prevent sensitive or internal data from reaching the LLM or being exported:

| Mechanism                          | Description                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-page-agent-no-export`        | Excludes marked elements from `extractFormData` and document exports while allowing normal agent interaction.                                   |
| `data-page-agent-sensitive`        | Completely blocks the element, its subtrees, and its labels from both observation and exports.                                                  |
| `input[type="password"]` / `token` | Dynamically detected and excluded from form extraction at runtime.                                                                              |
| `contentBlacklist`                 | PageController configuration to suppress specific DOM elements or live getters.                                                                 |
| `isContainedInRoot`                | Guarantees that neither fields nor labels referenced via `aria-labelledby` or `<label for>` read DOM nodes outside the configured root element. |

---

## 📄 License

MIT
