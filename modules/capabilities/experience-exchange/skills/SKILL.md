---
name: experience-exchange
description: Search published traffic experience and submit evidence-backed corrections when relevant.
---
# Experience Exchange

Use `search_experience` for a transport question involving a business definition, analysis method, or decision. Supply only `query`, phrased as a short question or an intent phrase. The service combines title, body, and published aliases. Match terms explain retrieval. Read applicability, exclusions, and evidence checks before using a rule. Continue the original task if the reply is empty or a rule is out of scope. Use current data to establish conclusions.

When the evidence analysis module is active, you may include the observed release ID and `used` or `skipped` decision in `complete_evidence_analysis`. The run saves that explicit attribution with the data evidence.

If an interpretation is corrected, submit a concise negative feedback record only with a real evidence reference. Include the exact `experience` reference only for an experience actually used; omit it for an independent correction. Never infer use merely from search results. Use a stable unique `submission_id` and the task run identifier; retry an uncertain submission with the same ID and identical payload. A submitted feedback item is for external review and does not publish or update experience. Do not send credentials or unnecessary sensitive information in any field.
