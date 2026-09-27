---
name: shared-canvas
description: Present, focus, update, or clear an existing authorized resource in the user's shared Canvas.
---

# Shared Canvas

Use `canvas_present` when the user asks to open, show, focus, or navigate an existing document in Canvas. Canvas is a shared presentation surface, not a content-generation tool.

- Pass session files as relative POSIX paths. Never pass absolute paths.
- Use `com.transportx.canvas.document` for Markdown, PDF, CSV, DOCX, XLSX, and PPTX.
- Use `viewId` without a resource only to refocus or navigate a view returned by an earlier `canvas_present` result.
- Do not claim that rendering completed. Tool success means the Host accepted the presentation request.
- Do not use screenshots as a replacement when the requested file type is supported by Canvas.
