---
name: document-canvas
description: Open and navigate Markdown, PDF, CSV, DOCX, XLSX, and PPTX resources in the shared Canvas.
---

# Document Canvas

Document is a domain adapter on the Canvas foundation, not the Canvas runtime. Markdown is a supported Document format alongside PDF, CSV and Office; it is not a separate runtime or module. The adapter owns format detection, navigation targets and document rendering.

Call `canvas_present` with `adapterId: "com.transportx.canvas.document"` and a controlled resource.

CSV files open as read-only tables in Canvas. They do not use the XLSX Viewer or Sheet targets.

Supported targets:

- DOCX or PDF page: `{ "kind": "page", "number": 3 }`
- PPTX slide: `{ "kind": "slide", "number": 8 }`
- XLSX sheet: `{ "kind": "sheet", "name": "早高峰" }`
- XLSX cell: `{ "kind": "sheet-cell", "sheet": "早高峰", "cell": "D27" }`
- Search: `{ "kind": "search", "query": "排队长度" }`

When the user asks for the last page or slide, inspect the file to determine its count, then pass the concrete one-based number. Do not convert supported documents to images just to display them.

Pinned Citation sources use `{ "scope": "capability", "moduleId": "com.transportx.citation", "resourceId": "<sourceVersionId>" }`. Do not pass Evidence IDs as resource IDs. Host verifies the fixed source version. Inline evidence stays in Citation details. CSV data rows (excluding the header) use `{ "kind": "rows", "start": 2, "end": 5, "columns": ["flow"] }`. Markdown sections use `{ "kind": "locator", "section": "结论" }`. A missing precise target means opening the original only, not verified exact navigation.
