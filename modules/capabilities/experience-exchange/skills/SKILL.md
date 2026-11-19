---
name: experience-exchange
description: Search published domain experience and submit evidence-backed corrections when relevant.
---
# Experience Exchange

Use `search_experience` once before deciding a consequential unstated population, measurement, comparison, denominator, time basis, or method. Reading a schema first is fine. A source name alone does not establish the intended scope. When scope and method are supplied, proceed with the task. Use only `query`, phrased as a short intent in the user's language. Read each candidate's applicability and exclusions. Use current data to establish conclusions.

A search records what was retrieved, not whether it was used. When you use or deliberately skip a returned experience, call `record_experience_use` in the same turn with its exact `releaseId`, `disposition` (`used` or `skipped`), and a concise `reason`. Forward the returned `receiptId` in `relatedToolCallIds` when submitting through a compatible tool. An empty search has no candidate to mark used or skipped.

If an interpretation is corrected, submit a concise negative feedback record only with a real evidence reference. Include the exact `experience` reference only for an experience actually used; omit it for an independent correction. Never infer use merely from search results. Use a stable unique `submission_id` and the task run identifier; retry an uncertain submission with the same ID and identical payload. A submitted feedback item is for external review and does not publish or update experience. Do not send credentials or unnecessary sensitive information in any field.
