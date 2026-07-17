# Course-local learner models and tools

Create course-local state or utilities when the learner requests them or when they materially improve long-term lesson selection. Examples include vocabulary familiarity, concept mastery, books or chapters read, recurring mistakes, quiz encounters, and spaced-retrieval queues.

## Boundaries

- Keep data and tools inside the selected course, outside `lessons/`, `COURSE.json`, and `.learn/`.
- Inspect existing conventions before creating a new directory or schema. Prefer `learner-model/`, `data/`, or `tools/` when no convention exists.
- Never create a background service, upload learner state, store credentials, or make the app depend on an opaque external database.
- Prefer transparent, portable data such as JSON, JSONL, or CSV plus a small deterministic query/update script. SQLite is appropriate when the available runtime can create, inspect, and migrate it reliably.
- If the execution environment cannot run a new utility, do not claim it was tested. Keep the data directly readable and writable by the next teacher.

## Evidence, not guesses

Separate observations from conclusions. A useful record can include:

- stable item id, kind, and display label;
- status appropriate to the domain, such as `introduced`, `familiar`, `retrievable`, or `mastered`;
- confidence and evidence source (`learner-self-report`, `quiz`, `exercise`, `lecture-exposure`);
- attempts, successes, encounters, and last-seen time when those values exist;
- a short note explaining the latest change.

Treat “I already know trabajo and hola” as learner self-report, not a perfect test. Treat seeing `hijo` or `llamar` in a lecture as exposure, not mastery. Update confidence from actual quiz or exercise outcomes; do not infer learning merely because a lecture was opened, a note was left, or time passed.

## Use during teaching

- Query relevant learner state before choosing examples, difficulty, or the next objective.
- Update it only from evidence present in the learner request, supplied notes, or completed work.
- Keep schema and utility changes small, documented in the tool or data file itself, and compatible with future teachers.
- Build domain-specific utilities when useful; do not force every course into one universal mastery model.
