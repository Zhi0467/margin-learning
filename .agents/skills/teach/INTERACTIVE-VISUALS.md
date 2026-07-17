# Interactive visuals in lectures

Use a visual only when it makes a relationship, process, or change easier to understand than prose. Prefer one strong teaching interaction over decorative motion or several small widgets.

## Choose the smallest useful form

- Use semantic HTML and CSS for simple structure or comparison.
- Use inline SVG for a compact diagram, plot, spatial relationship, or state transition. Include a concise `<title>` and `<desc>`, and do not make meaning depend on color alone.
- Use local JavaScript when the learner benefits from changing an input, stepping through a process, testing a prediction, or receiving immediate feedback.
- Put reusable styles, simulators, quiz helpers, or diagram code under `assets/`; keep one-off lecture-specific markup in the lecture.

## Interaction and motion

- Make the first render useful before the learner touches a control.
- Prefer native buttons, sliders, selects, and inputs with visible labels and keyboard access.
- Let motion explain a transition between meaningful states. Do not loop motion, animate decoration, or use motion merely to make the page feel busy.
- Honor `prefers-reduced-motion`; replace spatial animation with an instant state change when reduction is requested.
- Keep feedback immediate and local to the interaction. Preserve the learner's place in the lecture.

## Lecture constraints

- Keep the visual responsive without fixed viewport sizing, clipped labels, or horizontal page overflow.
- Use local or inline assets. Do not depend on `fetch`, CDNs, remote scripts, or a background service; Margin lectures run with network connections blocked.
- Give the visual, its controls, and its explanatory fallback stable `data-learn-block` identifiers.
- Provide a concise text explanation or table when the same information would otherwise be unavailable to a screen reader.
- Verify that every queried element exists, the primary interaction changes the intended state, and the lecture still explains its objective if JavaScript is unavailable.
