# Third-party source notices

TransportX Agent includes code derived from [Pi Tau Web Server](https://github.com/milanglacier/pi-tau-web-server), which is based on [tau](https://github.com/deflating/tau). Both upstream repositories declare the MIT license in their README and package metadata. Their license terms and attribution remain applicable to the upstream-derived code.

Project-owned changes are licensed under [AGPL-3.0-only](./LICENSE).

The bundled `@earendil-works/pi-coding-agent` 0.80.10 resource loader has a local patch, applied by `scripts/patch-pi-resource-discovery.mjs`: when all automatic resource categories are disabled, it skips package discovery before loading explicit resources. This prevents automatic package-manager commands during TransportX startup/reload. Pi's own license and notices remain in the dependency; its Registry, Agent Loop, RPC and Extension execution are retained.

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
- `lodash-es` 4.17.21 — MIT
- `@velipso/polybool` 1.1.1 — 0BSD

Their upstream license texts and copyright notices are distributed with the corresponding npm packages.

## PDF.js

PDF previews use Mozilla PDF.js (`pdfjs-dist`, Apache-2.0). Its license is included with the locally bundled runtime assets at `pdfjs/LICENSE`; font and WebAssembly notices are retained in the corresponding asset directories.
