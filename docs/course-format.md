# Margin course format

A Margin learning library contains one or more course directories. Course IDs
are the directory names and use letters, numbers, hyphens, or underscores.

```text
learning-library/
└── example-course/
    ├── COURSE.json
    ├── MISSION.md
    ├── NOTES.md
    ├── RESOURCES.md
    ├── assets/
    ├── learning-records/
    ├── lessons/
    ├── reference/
    └── .learn/              app-owned, created automatically
```

## Required files

### `MISSION.md`

The first heading is the course title:

```md
# Mission: Practical Color
```

Its `## Why` section explains the learner's goal and is used by the teacher to
choose useful scope.

### `COURSE.json`

Version 1 describes chapter order and assigns every lecture to exactly one
chapter:

```json
{
  "version": 1,
  "chapters": [
    {
      "id": "foundations",
      "title": "Foundations",
      "description": "",
      "lectures": ["lessons/0001-first-lecture.html"]
    }
  ]
}
```

Chapter IDs are unique dash-case values. Every chapter contains at least one
lecture. Margin owns syllabus mutation during app-triggered teacher actions.

### `lessons/*.html`

Lectures are complete HTML documents named with a globally increasing numeric
prefix such as `0001-topic.html`. Add stable, semantic `data-learn-block`
attributes to meaningful headings, paragraphs, lists, callouts, figures,
tables, code blocks, and quiz questions so annotations can survive revision.

Lectures may use scripts for local interactive exercises. Margin renders them
in an isolated sandbox without access to application APIs or the network.
Shared code and styles belong under `assets/`.

## Optional course state

- `NOTES.md`: teaching preferences and working notes
- `RESOURCES.md`: trusted primary sources and communities
- `learning-records/*.md`: evidence-backed records of demonstrated learning
- `reference/*.html`: durable glossaries, algorithms, and quick references
- `assets/*`: reusable CSS, JavaScript, images, and interactive components
- domain-specific learner-model data such as vocabulary familiarity, concept
  mastery, books read, quiz encounters, or spaced-retrieval state
- small course-local query/update tools for that data

Teachers may update supporting state when it is directly useful to an explicit
teaching action or margin note. Keep it transparent and portable (for example,
JSON/JSONL/CSV plus a small script, or SQLite when the runtime can inspect and
migrate it reliably). Record evidence separately from inferred mastery.

## App-owned `.learn/` state

Margin creates `.learn/` inside a course for annotations, note images, and
content-addressed lecture history. Teachers and users should not edit it by
hand. Back up `.learn/` together with the course if annotations and version
history matter.
