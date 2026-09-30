---
name: create-transportx-module
description: Create or extend a self-contained TransportX Module when a user asks to add a Skill, Pi Extension, Data, Knowledge, template, city dataset, project knowledge base, or other reusable local capability. Use it to turn the user's intent into one installable Module package instead of adding loose files.
---

# Create a TransportX Module

Create one self-contained Module package. Ask only for missing choices that change the package: package name/ID, whether it needs executable Pi tools, and the source of any Data or Knowledge files.

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
- For **Knowledge**, preserve original PDFs, HTML, or documents under that domain asset folder. Include the retrieval index and page/section mapping required for precise citations. Add SHA-256 checksums and declare `integrityFile`. Multiple Knowledge assets are active together; runtime provides `TRANSPORTX_KNOWLEDGE_ASSETS_JSON` as an asset-ID-to-root-directory map. A Skill must select its own declared asset ID. Never replace the original source file with extracted Markdown or JSONL alone.
- For an **Extension**, add it only when a deterministic Pi tool or structured bridge is necessary. Keep it narrow, validate inputs, and make it independent of local absolute paths.

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

### Verification recipe

Before telling the user to restart, reproduce the load path with the compiled modules:

```js
const { ModuleRegistry } = require('./bin/module-registry.js');
const { ModuleInstaller } = require('./bin/module-installer.js');
const { parseModuleManifestStructured } = require('./bin/contracts/module.js');
```

1. Parse the package manifest with `parseModuleManifestStructured` and require `ok: true`.
2. Build `ModuleRegistry(platformVersion).load([...builtinSources, ...installer.sources()])`
   with `enabled` derived from `settings.json`'s `tau.enabledModuleIds`.
3. Assert `registry.errors.length === 0` and `registry.get(id)?.enabled === true`.

If any check fails, fix the manifest or registration and re-run until the module is both
parsed and enabled with zero errors.

## Finish safely

Validate that the manifest paths exist, no package path escapes its root, and every cited Knowledge record resolves to its original source. Keep the package in the user's chosen working directory; then tell the user to install that package through TransportX settings. Do not copy content directly into the application's installed Modules directory.
