---
name: create-transportx-module
description: Create or extend a self-contained TransportX Module when a user asks to add a Skill, Pi Extension, Data, Knowledge, template, city dataset, project knowledge base, or other reusable local capability. Use it to turn the user's intent into one installable Module package instead of adding loose files.
---

# Create a TransportX Module

Turn the user's script, CLI program or API documentation into one task-local installable package. Infer a readable name and a non-reserved `local.*` ID from the stated purpose; ask only when missing business behavior, samples or credentials prevent a useful result. The user should not need to understand Manifest, Extension or Host internals.

1. Read the supplied program/docs and expected input/output. Preserve the original program when a small adapter suffices; do not rewrite working business logic.
2. Choose Pi-local execution for an ordinary script/CLI/API client. Use the public Pi `registerTool`, execute signal, `pi.exec` and package-relative files. Do not invent Host endpoints, copy platform tokens or claim platform permission from a Manifest.
3. Check the actual dependency availability using `TAU_PYTHON_COMMAND` and the supplied runtime. Never run pip/npm into the bundled runtime without explicit user instruction. If a dependency or credential is missing, explain the exact requirement and mark execution unverified; still provide the package where useful.
4. Keep API credentials in an explicitly configured environment variable or authorized external configuration. Never embed credentials in source, samples, ZIPs or logs. Do not inspect unrelated authentication files or print environment values.
5. Generate the package under this task, run the supplied sample with expected-output comparison when dependencies permit, then call `tau_module_package` with action `inspect`. This is static validation and does not prove execution.
6. If the user requested installation, call action `install` on that same relative package path. The existing desktop trust confirmation decides whether code may load. Generating or inspecting code is not installation authorization. If the user only requested a package, deliver it without installing.
7. After successful installation, state that new tasks can use it. Do not promise that the current frozen task has acquired new tools. Updates need a version increment; existing tasks retain exact versions.

## Package contract

Use this layout:

```text
<module-id>/
  manifest.json
  skill/SKILL.md                 # when behavior or instructions are needed
  extensions/<name>/index.ts     # only when Pi tools are needed
  assets/<domain-assets>/         # optional domain data or knowledge assets
```

Use `manifestVersion: 2`. Set `type` to `module` for user content; use `capability` only for reusable platform mechanisms. Declare every file the Agent needs in `entrypoints`; declare every content root in `contributes.assets`. Keep all paths relative to the package root.

## Build by intent

- For a **Skill**, write `skill/SKILL.md` with a short trigger description, imperative workflow, input assumptions, and verification steps. Do not create a loose Skill outside a Module.
- Give the asset folder a domain name, such as `assets/databases/`, `assets/policy-library/` or `assets/shanghai-roads/`; do not use a generic `data` or `knowledge` directory name merely to encode its type. The manifest's `kind` is the authoritative type.
- For **Data**, place only data plus schema, coverage, provenance, and quality notes under that domain asset folder. Add an asset with `kind: "data"`. Multiple Data assets are active together; runtime provides `TRANSPORTX_DATA_ASSETS_JSON` as an asset-ID-to-root-directory map. A Skill must select its own declared asset ID from that map, not assume a global Data root or use hard-coded absolute paths.
- Knowledge/Data Skills must own bounded discovery: startup exposes only asset ID, short purpose and browse/search entry. Provide paginated or explicitly truncated directories and candidates, then read a specific original span/result. Preserve resolvable original paths and typed locations; catalog matches are not evidence. Do not scan/load all bodies at startup or rely on Citation to index a library. Multi-source knowledge summaries must retain all original locations.
- For **Knowledge**, preserve original PDFs, HTML, or documents under that domain asset folder. Include the retrieval index and page/section mapping required for precise citations. Add SHA-256 checksums and declare `integrityFile`. Multiple Knowledge assets are active together; runtime provides `TRANSPORTX_KNOWLEDGE_ASSETS_JSON` as an asset-ID-to-root-directory map. A Skill must select its own declared asset ID. Never replace the original source file with extracted Markdown or JSONL alone.
- For an **Extension**, add it only when a deterministic Pi tool or structured bridge is necessary. Keep it narrow, validate inputs, and make it independent of local absolute paths.
- Register every tool during Extension initialization. Runtime late registration is unsupported. In Workbench, tools are discovered/inspected/enabled by Module through `manage_capabilities`; do not reset active tools yourself. No domain/group/catalog declarations are needed. Enable only opens schemas; execution retains its normal input, authorization and cancellation rules. Installed or updated code is assembled in a new task.

## Manifest example

```json
{
  "manifestVersion": 2,
  "id": "com.example.traffic-policy",
  "name": "Traffic Policy Knowledge",
  "version": "1.0.0",
  "type": "module",
  "platformVersion": ">=3.0.0 <4.0.0",
  "dependencies": ["com.transportx.citation"],
  "entrypoints": { "skills": ["skill/SKILL.md"] },
  "contributes": {
    "assets": [{
      "id": "knowledge:example-policy",
      "kind": "knowledge",
      "path": "assets/policy-library",
      "integrityFile": "assets/policy-library/SHA256SUMS.txt"
    }]
  }
}
```

## Common pitfalls (learned from real incidents)

- **`dependencies` is a required manifest field.** Even a package with no dependencies must
  declare `"dependencies": []`. The manifest contract (`parseModuleManifestStructured`)
  rejects a manifest that omits it, so the module is silently dropped and the host logs
  `Modules: N enabled, 1 error(s)`. Symptom: the Skill and its assets never appear in the
  Agent after restart even though the package files are present. Always mirror the full
  required field set from the Manifest example above.
- **Manual copies to the installed modules directory are not enough.** The managed Modules
  directory and settings file are platform-specific and are shown under TransportX Settings →
  Local directories. The module id must also be registered in `tau.enabledModuleIds` (a strict
  allow-list). TransportX only loads ids present there. Prefer installing through TransportX
  settings so package placement and registration happen automatically.
- **A misplaced edit can break JSON integrity.** When patching `settings.json` by hand,
  back it up first and re-validate the JSON afterwards; the host only enables modules that
  pass the `enabledModuleIds` allow-list filter.

### Verification and delivery

Use `tau_module_package({ action: "inspect", packagePath: "<task-relative-package>" })` for package validation. Do not require the user to run repository-internal Registry code or edit settings. Successful inspection confirms paths/manifest only. A real sample call verifies execution; report these separately.

For an update, increment the module version and install through the same tool or capability management. Keep old versions for frozen tasks. Disable affects new tasks; close active users before uninstalling. Existing historical Tool Results remain readable even when code is unavailable.

Deliver the package directory (or ZIP when requested), short usage, sample result and any missing dependencies/configuration. Install only when requested, through the existing installer/trust decision. Never copy files directly into managed module storage.
