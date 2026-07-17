# Security policy

## Supported versions

Margin is currently a developer beta. Security fixes are made on the latest
release and the `main` branch; older beta builds are not maintained.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** flow under the repository Security tab.
Do not include secrets, private course material, learner notes, or an exploit in
a public issue. If private vulnerability reporting is temporarily unavailable,
contact the maintainer through the repository owner's GitHub profile and wait
for a private channel before sharing details.

Include the affected version, macOS version, reproduction steps, impact, and a
minimal sanitized proof of concept when possible.

## Security model

- The native app launches a loopback-only local service with a new authenticated
  session for every launch.
- Mutable lecture HTML is treated as untrusted active content. It renders in a
  sandboxed, isolated origin and communicates with the app through a narrow
  selection and navigation bridge.
- Claude Code and Codex are external trusted executables chosen by the user.
  A teacher receives write access to the chosen learning library while its task
  is running. Margin does not provide an outer read sandbox for the CLI: it may
  be able to read other files available to the user's macOS account. The prompt
  and requested write roots are task boundaries, not a containment guarantee.
- Course files may contain private material. They must never be attached to an
  issue unless deliberately sanitized.
- The GitHub beta is unsigned and unnotarized. Verify the published SHA-256
  checksum before overriding Gatekeeper.

Notarization, if introduced later, will improve binary provenance but will not
replace application-level security review.
