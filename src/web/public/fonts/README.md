# Bundled fonts

These unmodified upstream WOFF2 files load from the application itself, without
`local()` or a remote font service. Vite copies this entire directory to
`dist/web/fonts/`, which is included in the npm distribution and every desktop
package. Do not remove the license files from the distributed directory.

Non-code English text and numbers prefer the system's Times New Roman, including
in PDF exports. Times New Roman is not copied or distributed with the app. When
it is unavailable, these characters fall back to the bundled Source Han family
for that surface. Chinese continues to use Source Han; code continues to use
JetBrains Mono with Source Han Sans for CJK. System font versions may differ.

| Typeface | Version | Weight range | Use |
| --- | --- | --- | --- |
| Adobe Source Han Sans SC | 2.005 | 250–900 | Controls, labels, diagrams and CJK fallback in code |
| Adobe Source Han Serif SC | 2.003 | 250–900 | Conversation text, Markdown reports and report PDF export |
| JetBrains Mono | 2.305 | 100–800 | Code, paths and technical values; upright and italic |

`native/` contains upstream regular OTF/TTF files of these same families for
Matplotlib and other native plotting libraries, plus their licenses. They cannot
use the browser WOFF2 files directly. At session launch, the Host injects the
platform-native absolute directory as `TRANSPORTX_FONT_DIR`. In desktop packages,
these files are unpacked and the existing `preferUnpackedPath` helper supplies
their physical directory; development and Web mode use the built static directory.
Python scripts join that environment value and the documented filename with
`pathlib.Path`, without OS-specific paths or a search of installed system fonts.

The two Source Han fonts retain the full Pan-CJK glyph set with Simplified
Chinese as the default glyph forms. They are not subsets generated from current
UI strings. Together with JetBrains Mono, the browser binaries total about
34.3 MiB; the native plotting fonts add about 39.4 MiB.
Characters outside these fonts (for example, emoji) can still use OS fallback.
Rasterization and antialiasing can differ between operating systems.

All three families use the SIL Open Font License 1.1. The original copyright and
license texts are in `LICENSE-SourceHanSans.txt`, `LICENSE-SourceHanSerif.txt` and
`LICENSE-JetBrainsMono.txt`.

`sources.json` records each downloaded file's pinned upstream URL, byte size and
SHA-256. To update, download from an explicit upstream commit, verify the binary
version and variable weight range, update that record and retain the upstream
license text. No network download occurs during build, installation or launch.

Existing PDF, Office and CAD documents keep their own typography. Mathematical
notation continues to use the bundled KaTeX math fonts. The built-in report PDF
exporter embeds these same application font files as data URLs in the rendering
process, after the desktop IPC size check; font data does not occupy the report's
IPC payload budget. Its existing network restriction and desktop JavaScript
restriction remain in place.
