# Contributing

Margin is intentionally small. Prefer narrow changes that preserve the plain
HTML/CSS/JavaScript interface, dependency-free Node service, and thin native
shell unless a larger change has a demonstrated product need.

## Development setup

1. Install the Xcode Command Line Tools and Node.js 20 or newer.
2. Fork and clone the repository.
3. Run `npm test`.
4. Run `npm run dev` for browser development, `npm run build:dev` for a native
   bundle backed by the live checkout, or `npm run build:app` for the
   self-contained release bundle.

Use a disposable learning library or `examples/demo-course` while testing.
Never commit personal annotations, images, learning records, provider logs,
credentials, or `.learn/` directories.

## Pull requests

- Keep the diff scoped to one behavior or release concern.
- Add tests at the boundary that proves the behavior.
- For interface changes, include macOS screenshots and test keyboard, pointer,
  selection, resizing, and narrow-window behavior.
- For teacher integration changes, test both provider transcript formats when
  possible and never expose hidden reasoning in the activity UI.
- For storage changes, include migration, interruption, and rollback coverage.
- Explain any new dependency and why the existing stack cannot solve the need.

Run before opening a pull request:

```sh
npm test
npm run build:app
```

Security issues belong in private vulnerability reporting, not pull requests or
public issues. See [SECURITY.md](SECURITY.md).
