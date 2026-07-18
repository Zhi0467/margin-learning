# Changelog

All notable changes are documented here. Margin follows semantic versioning
after the initial developer-beta series.

## 0.1.1 - 2026-07-18

- Explains when another Margin app owns the selected learning library and lets
  the user restart, inspect the log, or choose another library.
- Adds confirmed, recoverable deletion for courses and lectures. Courses move
  to library-level Margin Trash; lectures, notes, images, and a deletion
  version remain in course-local history.
- Keeps teacher work running when its UI stream disconnects, reconnects through
  operation receipts, bounds failed reconnect attempts, and makes cancellation
  an explicit action. Margin warns before quitting, restarting, or changing
  libraries while a teacher is active.
- Recovers completed course drafts after a crash, archives incomplete drafts,
  and clears stale course-name locks without deleting recoverable work.
- Scopes reading positions and pending operations to each learning library and
  transactionally restores any recognized non-selected course a teacher edits.
  Concurrent copies are preserved under Margin Trash, while unguardable courses
  are skipped with a visible warning instead of blocking all teaching.
- Hardens lecture navigation, history previews, image metadata, provider error
  reporting, and browser-session reloads.
- Keeps margin notes writable while a teacher works. Notes on other courses
  save immediately and are folded into the course-integrity guard; notes on the
  course being taught are held as a draft until the action finishes.
- No longer discards a successful teaching result when another course changed
  during the run. The other course is still restored and the displaced copy
  preserved under Margin Trash, and the completion message reports it.
- Stops hiding a library course whose id is `app`.
- Resolves operation receipts whose course was deleted or became unreadable so
  stale receipts can no longer accumulate and block new teacher actions.
- Lists unreadable courses on the library shelf with their error and lets them
  be deleted into Margin Trash; the warning toast now names them.
- Finds provider CLIs installed through nvm, asdf, mise, and fnm when the app
  is launched from Finder.
- Passes proxy, certificate-authority, and provider-specific environment
  variables through to teacher CLIs so proxied and API-key setups work.
- Explains provider incompatibility in terms of updating the CLI or Margin
  instead of listing raw flags as "Update required".
- Ignores a stale library lock whose recorded process id was recycled by an
  unrelated program.
- Serves interface assets without caching so an updated app never runs a stale
  script, and reports malformed request bodies as client errors.

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
