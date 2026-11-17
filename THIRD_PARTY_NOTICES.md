# Third-party source notices

TransportX Agent includes code derived from [Pi Tau Web Server](https://github.com/milanglacier/pi-tau-web-server), which is based on [tau](https://github.com/deflating/tau). Both upstream repositories declare the MIT license in their README and package metadata. Their license terms and attribution remain applicable to the upstream-derived code.

Project-owned changes are licensed under [AGPL-3.0-only](./LICENSE).

The bundled `@earendil-works/pi-coding-agent` 0.80.10 resource loader has a local patch, applied by `scripts/patch-pi-resource-discovery.mjs`: when all automatic resource categories are disabled, it skips package discovery before loading explicit resources. This prevents automatic package-manager commands during TransportX startup/reload. Pi's own license and notices remain in the dependency; its Registry, Agent Loop, RPC and Extension execution are retained.

The same script updates Pi's credential reader for the TransportX ChatGPT subscription provider. Pi reads that credential under its existing lock so running sessions observe sign-in, sign-out, and token renewal performed in another process.

## MIT license for upstream-derived code

MIT License

Copyright (c) deflating and contributors
Copyright (c) Milan Glacier and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

## CAD viewer dependencies

The read-only CAD Canvas uses the following third-party packages:

- `@mlightcad/cad-simple-viewer` 1.7.6 — MIT
- `@mlightcad/data-model` 1.15.10 — MIT
- `@mlightcad/mtext-parser` 1.5.5 — MIT
- `@mlightcad/mtext-renderer` 0.13.4 — MIT
- `@mlightcad/three-renderer` 1.7.6 — MIT
- `three` 0.172.0 — MIT
- `lodash-es` 4.18.1 — MIT
- `@velipso/polybool` 1.1.1 — 0BSD

Their upstream license texts and copyright notices are distributed with the corresponding npm packages.

## PDF.js

PDF previews use Mozilla PDF.js (`pdfjs-dist`, Apache-2.0). Its license is included with the locally bundled runtime assets at `pdfjs/LICENSE`; font and WebAssembly notices are retained in the corresponding asset directories.

## Bundled typefaces

The workbench includes Adobe Source Han Sans SC, Adobe Source Han Serif SC and JetBrains Mono under the SIL Open Font License 1.1. Font binaries, original copyright/license texts and pinned upstream sources are distributed in `dist/web/fonts/`; see `src/web/public/fonts/README.md` in the source tree. These assets load locally without installing fonts or contacting a font service.

## DuckDB count comparison

The count comparison uses `@duckdb/node-api` and `@duckdb/node-bindings` 1.5.6-r.2 with the corresponding platform-specific DuckDB native library (MIT). Their copyright and license notices are included in the installed npm packages. The bundled Seattle public-data provenance is in `data/count-comparison/README.md` and its capture receipts.

## City Service Resilience

The extension bundles these sources under the MIT terms reproduced above:

- [Turf](https://github.com/Turfjs/turf) 7.3.4 modules for spatial intersection and point-to-line distance. Copyright (c) 2017 TurfJS.
- `point-in-polygon-hao` 1.2.4. Copyright (c) 2021 Rowan Winsemius.
- `sweepline-intersections` 1.5.0. Copyright (c) 2019 Rowan Winsemius.
- [fast-json-patch](https://github.com/Starcounter-Jack/JSON-Patch) 3.1.1. Copyright (c) 2013, 2014, 2020 Joachim Wester.

Turf also uses `robust-predicates`, released into the public domain under [the Unlicense](https://unlicense.org/).

[TinyQueue](https://github.com/mourner/tinyqueue) 3.0.0, and 2.0.3 via `sweepline-intersections`, use the ISC License:

Copyright (c) 2017, Vladimir Agafonkin

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
