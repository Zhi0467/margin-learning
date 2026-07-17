# Privacy

Margin is local-first. It has no Margin account, hosted database, telemetry,
analytics, advertising SDK, or crash-reporting service.

## Data stored locally

Margin stores:

- course HTML, Markdown, JSON, assets, and references in the learning library
  selected by the user;
- annotations, attached note images, and lecture history under each course's
  `.learn/` directory;
- interface and teacher preferences under `~/Library/Application Support/Margin/`;
- bounded diagnostic logs under `~/Library/Logs/Margin/`.

Deleting or moving the selected library is under the user's control. Removing
Margin does not delete a learning library.

## External AI providers

Margin launches the user's separately installed Claude Code or Codex CLI only
after an explicit teaching or update action. During a teaching action, that CLI
may read course files, learner notes, quoted passages, and attached images and
may send them to its configured external provider under that provider's terms
and privacy policy.

Claude Code and Codex run as separate developer tools under the user's macOS
account. Margin constrains the write access it requests to the selected learning
library, but it is not an outer operating-system sandbox for those tools. A CLI
or one of its tools may be able to read other files that account can read and
send selected content to its provider. The sandbox used for generated lecture
HTML does not restrict the teacher process.

The selected CLI receives write access to the entire chosen learning library.
Do not use a library containing unrelated private files. Margin never sends
course material to both providers automatically; only the provider selected for
the explicit action runs.

Provider authentication, billing, model behavior, retention, and network
traffic belong to the external CLI and provider, not Margin. Teaching actions
allow the selected CLI to perform live source searches so factual lectures can
be grounded; search queries and fetched pages are handled by that provider.

## Updates and network access

Margin checks locally installed CLI capabilities and versions. It runs a
provider-owned update command only when the user explicitly clicks Update.
Links and cited resources open in the system browser.
