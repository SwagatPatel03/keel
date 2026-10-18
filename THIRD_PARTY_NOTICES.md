# Third-party notices

## Superpowers

`skills/plan/SKILL.md` is adapted from the "brainstorming" and "writing-plans" skills in Superpowers (https://github.com/obra/superpowers).

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The phase-size rule (at most 3 tasks per phase) follows GSD (https://github.com/gsd-build/get-shit-done); no GSD code is included.

## Anthropic explanatory-output-style plugin

Keel's learning notes (`src/learn.mjs`) follow the pattern of Anthropic's explanatory-output-style plugin for Claude Code: instructions are added through a hook instead of switching the output style, so Claude Code's normal engineering instructions stay on. Keel adds them only on tagged turns instead of at session start. No code or text from that plugin is included.

## cc-safety-net

Keel's command parser (`src/guard/shell.mjs`) follows the approach of cc-safety-net (https://github.com/kenryu42/claude-code-safety-net, MIT License, Copyright (c) 2026 J Liew): splitting command chains, unwrapping `bash -c` and similar wrappers, and normalising flags. Keel's parser and rule packs are an independent implementation; no cc-safety-net code is included.

## Bun (the compiled Keel plugins only)

The compiled Keel plugins (keel-windows-x64, keel-macos-arm64, keel-macos-x64, keel-linux-x64 and keel-linux-arm64) are made with `bun build --compile` (https://bun.sh), so each program contains the Bun runtime. The Node.js plugin (`keel`) and Keel's source contain no Bun code.

- Bun itself is MIT-licensed (https://github.com/oven-sh/bun/blob/main/LICENSE.md).
- Bun statically links JavaScriptCore and parts of WebKit, licensed under the GNU Lesser General Public License version 2 (LGPL-2), and tinycc, licensed under LGPL-2.1. Their source is at https://github.com/oven-sh/WebKit and https://github.com/oven-sh/tinycc.
- Bun also statically links libraries under the MIT, BSD, Apache 2.0, zlib, ICU and public-domain licences, listed at https://bun.sh/docs/project/licensing.

To use a modified JavaScriptCore or other LGPL library with Keel, as the LGPL allows: build Bun with your changes (the steps are on Bun's licensing page), then run `node scripts/build-binaries.mjs` from Keel's source with that Bun on your PATH. Keel's source, including that build script, is MIT-licensed and public, so you can always rebuild the compiled program yourself.

## Ruler and rulesync

Earlier versions of `keel rules` ran Ruler (https://github.com/intellectronica/ruler, MIT License) through `npx`. `keel rules` no longer runs or downloads anything; the README mentions Ruler and rulesync for people who want one rules file per agent. No code from either is included in Keel.

## Destructive Command Guard (dcg)

Keel does not use, copy or derive from dcg. Its licence adds a rider that withdraws all rights from anyone acting for or distributing to Anthropic or OpenAI, which is incompatible with distributing Keel through their plugin marketplaces.
