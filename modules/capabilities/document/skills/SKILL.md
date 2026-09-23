---
name: document-canvas
description: Open and navigate Markdown, PDF, CSV, DOCX, XLSX, and PPTX resources in the shared Canvas.
---

# Document Canvas

Call `canvas_present` with `adapterId: "com.transportx.canvas.document"` and a controlled resource.

CSV files open as read-only tables in Canvas. They do not use the XLSX Viewer or Sheet targets.

Supported targets:

- DOCX or PDF page: `{ "kind": "page", "number": 3 }`
- PPTX slide: `{ "kind": "slide", "number": 8 }`
- XLSX sheet: `{ "kind": "sheet", "name": "早高峰" }`
- XLSX cell: `{ "kind": "sheet-cell", "sheet": "早高峰", "cell": "D27" }`
- Search: `{ "kind": "search", "query": "排队长度" }`

When the user asks for the last page or slide, inspect the file to determine its count, then pass the concrete one-based number. Do not convert supported documents to images just to display them.
