---
name: shared-canvas
description: Present, focus, update, or clear an existing authorized resource in the user's shared Canvas.
---

# Shared Canvas

Use `canvas_present` when the user asks to open, show, focus, or navigate an existing document in Canvas. Canvas is the shared presentation foundation: it owns view identity, present/focus/update/clear lifecycle, controlled resource references and explicitly attached contexts. Domain adapters own their payload, navigation and renderer. Document (including Markdown), Geo and Video use this foundation; future formats such as CAD need a platform-reviewed adapter before they can render.

- Pass session files as relative POSIX paths. Never pass absolute paths.
- Use `com.transportx.canvas.document` for Markdown, PDF, CSV, DOCX, XLSX, and PPTX.
- Use `viewId` without a resource only to refocus or navigate a view returned by an earlier `canvas_present` result.
- Do not claim that rendering completed. Tool success means the Host accepted the presentation request.
- Do not use screenshots as a replacement when the requested file type is supported by Canvas.

- Pinned Citation originals use capability references with `moduleId: "com.transportx.citation"` and the registered `sourceVersionId`. Host resolves authorization and bytes. Citation evidence remains independent of Canvas; do not turn Canvas Context into new evidence.

- New file resources currently use the Document adapter. Geo scenes are created/updated with `present_visualization` and publish their own Canvas envelopes; `canvas_present` can focus or clear an existing Geo view by its returned `viewId`. Do not route map calculations or scene mutations through Canvas.
- Use `canvas_inspect_context` only for IDs attached to the current user turn. A successful presentation means Host acceptance, not browser render completion.
