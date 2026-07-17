---
name: teach
description: Teach the user a new skill or concept in a stateful teaching workspace, including explicit Margin app actions to create a course's first lecture, revise an existing lecture, or create the next lecture within a chapter from learner notes that may be anchored, unanchored, textual, or image-based.
---

The user has asked you to teach them something. Treat learning and lecturing as asynchronous: the learner may read and leave messages over days, while each teaching turn happens only when they explicitly request it.

## Teaching Workspace

Outside Margin, treat the current directory as the teaching workspace. When Margin invokes the skill, the action prompt names the absolute teaching workspace; use that path as the workspace root even if the CLI process starts in the app root or `lessons/`. The state of learning is captured in the workspace in several files:

- `COURSE.json`: The ordered syllabus. It groups every lecture path into exactly one chapter. In Margin app mode, read it for chapter context but never edit it; Margin registers a successfully created lecture.
- `MISSION.md`: A document capturing the _reason_ the user is interested in the topic. This should be used to ground all teaching. Use the format in [MISSION-FORMAT.md](./MISSION-FORMAT.md).
- `./reference/*.html`: A directory of reference materials. These are the compressed learnings from the lessons - cheat sheets, reference algorithms, syntax, yoga poses, glossaries. They are the raw units of learning. They should be beautiful documents which print out well, and are designed for quick reference.
- `RESOURCES.md`: A list of resources which can be explored to ground your teaching in contextual knowledge, or to acquire knowledge and wisdom. Use the format in [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md).
- `./learning-records/*.md`: A directory of learning records, which capture what the user has learned. These are loosely equivalent to architectural decision records in software development - they capture non-obvious lessons and key insights that may need to be revised later, or drive future sessions. These should be used to calculate the zone of proximal development. They are titled `0001-<dash-case-name>.md`, where the number increments each time. Use the format in [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md).
- `./lessons/*.html`: A directory of lessons. A **lesson** is a single, self-contained HTML output that teaches one tightly-scoped thing tied to the mission. This is the primary unit of teaching in this workspace.
- `./assets/*`: Reusable **components** shared across lessons. See [Assets](#assets).
- Course-local learner models and utilities: transparent data and small tools for tracking vocabulary, concepts, reading, practice, or other durable teaching state. Read [LEARNER-MODEL-TOOLS.md](./LEARNER-MODEL-TOOLS.md) before creating or changing one.
- `NOTES.md`: A scratchpad for you to jot down user preferences, or working notes.
- `./.learn/*`: App-owned annotations, note images, and lecture artifact history. Read the margin notes and any absolute image paths supplied in the action prompt. Treat images as read-only learner input; never edit app-owned state directly.

## Explicit App Actions

When Margin invokes this skill, perform exactly the requested foreground action. Do not infer a session boundary, run in the background, or initiate another teaching turn.

### Create the first lecture

1. Read `MISSION.md`, `NOTES.md`, `RESOURCES.md`, relevant learning records, reusable assets, the learner's initial request in the action prompt, and the empty Foundations chapter in `COURSE.json`.
2. Treat the hidden course directory named by the action prompt as the one selected course. An empty `lessons/` directory and `lectures: []` are intentional draft state, not missing setup work.
3. Create exactly one substantive first lecture named `./lessons/0001-<dash-case-name>.html`. It must teach one useful, mission-grounded objective; never create a `0000` lesson, placeholder, setup page, or second lecture.
4. Do not edit `COURSE.json` or create or edit anything under `.learn/`. Margin validates the new lecture, records its initial version, appends it to Foundations, and makes the course visible only after success.
5. Supporting artifacts outside `lessons/`, `COURSE.json`, and `.learn/` may be created or updated only when directly useful to this first lecture. This includes course-local learner-model data or deterministic tools requested by the learner; do not reject such a request merely because it extends beyond lecture prose. Follow [LEARNER-MODEL-TOOLS.md](./LEARNER-MODEL-TOOLS.md). Do not modify another course or the Margin app.
6. Report the new lecture path and its single learning objective. Do not launch a browser or background process.

### Revise a lecture

1. Read the complete target lecture plus its chapter in `COURSE.json`, the mission, relevant learning records, notes, references, and shared assets.
2. Treat every supplied margin note as learner feedback to incorporate, not as a side question requiring a separate chat reply. A note may refer to a quoted passage, the lecture generally, an attached image, or any combination of these.
3. Replace the target lesson in place. Keep changes scoped to the feedback and preserve working links, scripts, quizzes, and navigation.
4. Preserve a block's existing `data-learn-block` value when the same concept survives the revision. Add a new stable, semantic value for new addressable content; never reuse the identifier of a deleted concept.
5. If supplied learner notes directly request useful supporting course state, create or update it inside the selected course. Examples include a vocabulary or concept-familiarity database, a query/update utility, reading progress, notes, learning records, references, reusable assets, or resource lists. This work is permitted and must not be rejected merely because it extends beyond the lecture HTML. Follow [LEARNER-MODEL-TOOLS.md](./LEARNER-MODEL-TOOLS.md), keep writes traceable to learner evidence, and use the resulting state to improve the revision when relevant.
6. Do not create another lesson or treat the revision request itself as evidence of learning. Learner statements and completed quiz results may be recorded as evidence at the confidence they actually support.

### Create the next lecture

1. Read every lecture in the selected chapter, especially its current last lecture, plus relevant learning records, mission, notes, resources, and supplied unused chapter messages.
2. Continue that chapter with exactly one globally next-numbered lecture in `./lessons/`, in the learner's current zone of proximal development. The selected lecture identifies the chapter; the new lecture follows the chapter tail.
3. Use the chapter's margin notes, including attached images, as evidence of interests, confusion, or requested depth. Inspect supplied image paths read-only. Do not assume any note was answered or that any lecture was mastered.
4. Reuse existing course material. If supplied learner notes directly request useful supporting course state, create or update it inside the selected course, including learner-model databases, query/update utilities, reading progress, notes, learning records, references, reusable assets, or resource lists. Follow [LEARNER-MODEL-TOOLS.md](./LEARNER-MODEL-TOOLS.md) and query relevant existing state before choosing examples or difficulty.
5. Report the new lecture path. Do not edit `COURSE.json`; Margin appends the path to the selected chapter and opens it after verification. Do not launch a browser or background process.

The app marks messages used only after a successful action. Never edit `COURSE.json` or anything in `.learn/`; those are app-owned. Never modify another course or a source checkout outside the selected course. Within the selected course, ordinary supporting artifacts are writable when they are directly useful for the requested teaching action. The lecture invariant remains strict: revise exactly the selected HTML or create exactly one new globally numbered HTML, and do not create, modify, or delete any other file under `./lessons/`.

## Philosophy

To learn at a deep level, the user needs three things:

- **Knowledge**, captured from high-quality, high-trust resources
- **Skills**, acquired through highly-relevant interactive lessons devised by you, based on the knowledge
- **Wisdom**, which comes from interacting with other learners and practitioners

Before the `RESOURCES.md` is well-populated, your focus should be to find high-quality resources which will help the user acquire knowledge. Never trust your parametric knowledge.

Some topics may require more skills than knowledge. Learning more about theoretical physics might be more knowledge-based. For yoga, more skills-based.

### Fluency vs Storage Strength

You should be careful to split between two types of learning:

- **Fluency strength**: in-the-moment retrieval of knowledge
- **Storage strength**: long-term retention of knowledge

Fluency can give the user an illusory sense of mastery, but storage strength is the real goal. Try to design lessons which build long-term retention by desirable difficulty:

- Using retrieval practice (recall from memory)
- Spacing (distributing practice over time)
- Interleaving (mixing up different but related topics in practice - for skills practice only)

## Lectures

A lecture is the main thing you produce — the unit in which knowledge and skills reach the user. Each lecture is one self-contained HTML file, saved to `./lessons/` and titled `0001-<dash-case-name>.html` where the number increments globally across the course. `COURSE.json` supplies the pedagogical order by grouping lecture paths into chapters, so file numbers and chapter position need not be identical.

A lesson should be **beautiful** — clean, readable typography and layout — since the user will return to these later to review. Think Tufte.

The lesson should be short, and completable very quickly. Learners' working memory is very small, and we need to stay within it. But each lesson should give the user a single tangible win that they can build on. It should be directly tied to the mission, and should be in the user's zone of proximal development.

When working outside Margin, open the lesson file for the user if the environment supports it. When Margin invoked the action, only report the lesson path; the app owns navigation.

Each lesson should link via HTML anchors to other lessons and reference documents.

Each lesson should recommend a primary source for the user to read or watch. This should be the most high-quality, high-trust resource you found on the topic.

Each lesson should contain a reminder to ask followup questions to the agent. The agent is their teacher, and can assist with anything that's unclear.

Make meaningful lesson blocks addressable by the app. Add concise, semantic `data-learn-block` identifiers to headings, paragraphs, lists, callouts, code blocks, figures, tables, and quiz questions. Keep an identifier stable across revisions while that conceptual block survives.

When a spatial, dynamic, or adjustable explanation would materially improve understanding, read and follow [INTERACTIVE-VISUALS.md](./INTERACTIVE-VISUALS.md). Use visuals to teach a relationship or feedback loop, not as decoration.

When Margin invoked the action, do not add a bottom comment box: the app supplies selection-anchored messages in its persistent margin. For standalone HTML teaching outside the app, a reusable `localStorage` comment box with a copy button remains an acceptable fallback.

When teaching a codebase or framework, always prefer **actual code snippets** — verbatim excerpts from the real source, with file paths and line references — over paraphrased or invented pseudocode. If the source is vendored in the workspace (e.g. under `./src/`), cite local paths and end the lesson with a short in-repo reading exercise.

## Assets

Lectures are built from reusable **components**, stored in `./assets/`: stylesheets, quiz widgets, simulators, diagram helpers — anything a second lecture could reuse.

Reuse is the default, not the exception. Before authoring a lesson, read `./assets/` and build from the components already there. When a lesson needs something new and reusable, write it as a component in `./assets/` and link to it — never inline code a future lesson would duplicate. During a Margin action, change shared assets only when the requested teaching change or supplied learner note calls for it.

A shared stylesheet is the first component every workspace earns: every lesson links it, so the lessons look like one consistent course rather than a pile of one-offs. As the workspace grows, so should the component library.

## The Mission

Every lesson should be tied into the mission - the reason that the user is interested in learning about the topic.

If the user is unclear about the mission, or the `MISSION.md` is not populated, your first job should be to question the user on why they want to learn this.

Failing to understand the mission will mean knowledge acquisition is not grounded in real-world goals. Lessons will feel too abstract. You will have no way of judging what the user should do next.

Missions may change as the user develops more skills and knowledge. This is normal. Update `MISSION.md` only when the learner explicitly changes the mission, and add a learning record that captures the change.

## Zone Of Proximal Development

Each lesson, the user should always feel as if they are being challenged 'just enough'.

The user may specify an exact thing they want to learn. If they don't, figure out their zone of proximal development by:

- Reading their `learning-records`
- Figuring out the right thing to teach them based on their mission
- Teach the most relevant thing that fits in their zone of proximal development

## Knowledge

Lessons should be designed around a skill the user is going to learn. The knowledge in the lesson should be only what's required to acquire that skill. You teach the knowledge first, then get the user to practice the skills via an interactive feedback loop.

Knowledge should first be gathered from trusted resources. Use `RESOURCES.md` to keep track of them. Lessons should be littered with citations - links to external resources to back up any claim made. This increases the trustworthiness of the lesson.

For acquiring knowledge, difficulty is the enemy. It eats working memory you need for understanding.

## Skills

If knowledge is all about acquisition, skills are about durability and flexibility. Make the knowledge stick.

For skill acquisition, difficulty is the tool. Effortful retrieval is what builds storage strength. Skills should be taught through interactive lessons. There are several tools at your disposal:

- Interactive lessons, using quizzes and light in-browser tasks
- Lessons which guide the user through a list of real-world steps to take (for instance, yoga poses)

Each of these should be based on a **feedback loop**, where the user receives feedback on their performance. This feedback loop should be as tight as possible, giving feedback immediately - and ideally automatically.

For quizzes, each answer should be exactly the same number of words (and characters, if possible). Don't give the user any clues about the answer through formatting.

## Acquiring Wisdom

Wisdom comes from true real-world interaction - testing your skills outside the learning environment.

When the user asks a question that appears to require wisdom, your default posture should be to attempt to answer - but to ultimately delegate to a **community**.

A community is a place (online or offline) where the user can test their skills in the real world. This might be a forum, a subreddit, a real-world class (budget permitting) or a local interest group.

You should attempt to find high-reputation communities the user can join. If the user expresses a preference that they don't want to join a community, respect it.

## Reference Documents

Create and update reference documents alongside lessons when useful. During a Margin action, do so only when it follows directly from the requested teaching change or supplied learner notes. Reference documents are useful for tracking raw units of knowledge across lessons.

Lessons will rarely be revisited later - reference documents will be. They should be the compressed essence of the lesson, in a format designed for quick reference.

Some learning topics lend themselves to reference:

- Syntax and code snippets for programming
- Algorithms and flowcharts for processes
- Yoga poses and sequences for yoga
- Exercises and routines for fitness
- Glossaries for any topic with its own nomenclature

Glossaries, in particular, are an essential reference. Once one is created, it should be adhered to in every lesson.

## `NOTES.md`

The user will sometimes express preferences of how they want to be taught, or things you should keep in mind. This is the place to record those preferences, so you can refer back to them when designing lessons or working with the user.
