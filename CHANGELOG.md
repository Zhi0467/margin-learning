# Changelog

All notable changes are documented here. Margin follows semantic versioning
after the initial developer-beta series.

## 0.1.0 - 2026-07-18

Initial GitHub developer beta.

- Native macOS learning-library interface with resizable course and margin panels.
- Chapter and lecture navigation with persistent reading preferences.
- Passage-anchored text and image notes.
- Explicit Claude Code and Codex teacher actions with model and effort selection.
- Runtime teacher icons sourced from locally installed provider apps, with
  redistribution-safe fallbacks.
- Teacher-backed course creation that writes the first real lecture without a
  placeholder artifact.
- Background activity UI without chain-of-thought display.
- Cancellable teacher tasks with bounded process termination, whole-course
  transactional rollback, and crash recovery.
- Durable operation receipts make course creation, revision, and next-lecture
  retries idempotent when a final UI response is interrupted.
- Content-addressed lecture history and restoration.
- Bundled guidance for pedagogical SVG/animation and course-local learner-model
  databases and query tools.
- Relocatable app bundle with a pinned Node.js runtime and bundled teach skill.
- Authenticated loopback service and isolated mutable lecture rendering.
