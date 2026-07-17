# Third-party notices

Margin includes or adapts the following open-source work. The corresponding
license texts are preserved in source distributions and packaged application
resources.

## Node.js

The packaged macOS application includes an official Node.js binary runtime.

- Project: https://nodejs.org/
- License: MIT and bundled third-party notices
- Copyright: Node.js contributors

The complete `LICENSE` file from the pinned Node.js binary distribution is
bundled alongside the runtime.

## Provider names and runtime icons

Claude, Claude Code, Anthropic, ChatGPT, Codex, and OpenAI are trademarks of
their respective owners. They identify the external teacher selected by the
user and do not imply endorsement of Margin.

Margin does not redistribute provider artwork. On macOS it may render a small
PNG copy of the icon from the user's locally installed Claude or ChatGPT app in
the teacher picker; the copy remains in Margin's local Application Support
directory.

## `teach` agent skill

Margin includes a modified version of the `teach` skill from
[mattpocock/skills](https://github.com/mattpocock/skills).

- Upstream copyright: Copyright (c) 2026 Matt Pocock
- License: MIT
- Modifications: Margin-specific asynchronous actions, chapters, passage and
  image annotations, supporting course artifacts, and app-owned state rules

MIT License

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
