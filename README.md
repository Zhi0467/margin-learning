# Margin

Margin is a local, agentic learning app for macOS. Read short HTML lectures,
select any passage, leave text or image notes in the margin, and explicitly ask
Claude Code or Codex to revise the lecture or write the next lecture in its
chapter.

Learning and teaching are asynchronous. Reading never starts a background
agent, and leaving a note never claims that something was learned. A teacher
runs only when you click a teaching action.

> **Developer beta:** Margin 0.1.0 is an unsigned, Apple Silicon-only build for
> macOS 13 or newer. Expect rough edges and read the permissions section before
> using a teacher.

## What it does

- Organizes local courses into chapters and lectures.
- Creates a real first lecture from a teaching brief instead of a placeholder.
- Renders self-contained HTML lectures in a warm native macOS interface.
- Anchors text and image notes to lecture passages.
- Supports Claude Code and Codex, including model and reasoning-effort choices.
- Runs teacher work in the background while the library remains usable.
- Tracks content-addressed lecture versions and supports restoration.
- Commits each teaching action transactionally across the lecture and any
  supporting course-local data, with crash recovery for unfinished actions.
- Reconciles interrupted responses through durable operation receipts so a
  retry cannot silently duplicate a course or next lecture.
- Lets teachers build course-local learner models and utilities for durable
  state such as vocabulary, concepts, reading progress, and retrieval evidence.
- Guides teachers to use accessible SVG, animation, and interactive exercises
  when they materially improve an explanation.
- Keeps courses as ordinary HTML, Markdown, JSON, JavaScript, CSS, and image
  files that remain useful without Margin.

## Install the GitHub beta

1. Download `Margin-0.1.0-macos-arm64.zip` and `SHA256SUMS` from the latest
   GitHub Release.
2. Optionally verify the download:

   ```sh
   shasum -a 256 -c SHA256SUMS
   ```

3. Unzip Margin and move `Margin.app` to `/Applications`.
4. Try to open Margin once. Because this beta is not notarized, macOS will
   block the first launch.
5. Open **System Settings → Privacy & Security**, scroll to Security, choose
   **Open Anyway**, and confirm.

Apple documents this one-time override in
[Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).
Do not bypass Gatekeeper for a binary whose source or checksum you do not trust.

On first launch, choose or create a learning-library folder. Margin remembers
the folder and can change it later from the application menu.

## Teachers

Margin does not bundle an AI service. Install and authenticate at least one
supported command-line teacher:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI](https://github.com/openai/codex)

Margin discovers installed CLIs, their compatible models, authentication
state, and supported reasoning efforts. Checking for an available update does
not update anything; running `claude update` or `codex update` remains an
explicit button action.

Teaching actions enable the selected CLI's live source-search capability so a
lecture can cite material it actually checked. Network requests and provider
retention remain governed by the selected CLI and provider.

### Filesystem permission

When you start a teaching action, the selected CLI receives write access to the
entire learning library you chose, not just the visible lecture. This is
intentional: a teacher may update directly requested supporting course state
such as vocabulary databases, notes, learning records, references, assets, or
resource lists. The prompt confines the action to the selected course, while
Margin verifies the strict lecture invariant and protects app-owned
`COURSE.json` and `.learn/` history.

Use a dedicated learning-library folder. Do not select a directory containing
unrelated private or valuable files.

The provider CLI is a separate developer tool, not a container managed by
Margin. Margin limits the write paths it requests to the selected learning
library, but the CLI process and its own tools may still be able to read other
files your macOS account can read. Generated lecture isolation protects the app
interface; it does not sandbox Claude Code or Codex. Only run teachers on course
material you trust, and review the selected CLI's permissions and privacy terms.

## Course format

Each course is a directory containing `MISSION.md`, `COURSE.json`, `lessons/`,
and related optional material. See [docs/course-format.md](docs/course-format.md)
and [examples/demo-course](examples/demo-course) for a complete minimal course.

Margin stores annotations and lecture history under each course's ignored
`.learn/` directory. Those files are learner data, not application source.

## Development

Requirements:

- macOS 13 or newer
- Xcode Command Line Tools
- Node.js 20 or newer for development and tests
- `rsvg-convert` from librsvg, or ImageMagick, for the application icon

Run the browser development server against the current directory:

```sh
npm run dev
```

Build `Margin Dev.app`, a clearly labeled local shell that loads the backend,
interface, and teach skill directly from this checkout whenever it starts:

```sh
npm run build:dev
```

The development bundle intentionally records this checkout's absolute path and
the absolute `node` executable used to build it. At startup it prefers that
recorded executable, then falls back to searching a safe `PATH` if the recorded
path is no longer valid. It is for local iteration only and is never included in
release archives. Its preferences and logs use separate `Margin Dev`
directories. A shared library lock prevents Margin Dev and a release build from
mutating the same learning library concurrently.

Run the test suite:

```sh
npm test
```

Build the relocatable application:

```sh
npm run build:app
```

Create the unsigned GitHub release ZIP and checksum:

```sh
npm run package
```

The packaging script downloads and verifies a pinned official Apple Silicon
Node.js runtime. Set `MARGIN_NODE_RUNTIME=/absolute/path/to/node-distribution`
to use an already downloaded official distribution while developing offline.

## Architecture

Margin deliberately uses a small stack:

- Objective-C, Cocoa, and WKWebView for the native window and lifecycle
- plain HTML, CSS, and browser JavaScript for the interface
- a dependency-free Node.js HTTP service for course files and teacher processes
- external Claude Code and Codex subprocesses for explicit teaching actions

The installed app is read-only. Courses live in the user-selected library. The
app service binds only to loopback, uses a fresh authenticated session, and
renders mutable lecture HTML on an isolated origin.

## Local data and privacy

Margin has no account, telemetry, analytics, or hosted backend. See
[PRIVACY.md](PRIVACY.md) for the important distinction between Margin's local
storage and the external provider selected through Claude Code or Codex.

Default local state:

- course data and `.learn/` history: inside the selected learning library
- UI preferences: `~/Library/Application Support/Margin/`
- bounded service logs: `~/Library/Logs/Margin/`

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. The project is
available under the [MIT License](LICENSE); bundled third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
