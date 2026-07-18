import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  addAnnotation,
  archiveLecture,
  discoverCourses,
  moveCourseToTrash,
  readAnnotationStore,
  readCourseStructure,
  readLectureHistory,
} from "../lib.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t, { twoLectures = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "margin-deletion-test-"));
  const course = path.join(root, "systems");
  await mkdir(path.join(course, "lessons"), { recursive: true });
  await mkdir(path.join(course, "reference"));
  await writeFile(path.join(course, "MISSION.md"), "# Mission: Systems\n\n## Why\nLearn the machinery.\n", "utf8");
  await writeFile(
    path.join(course, "lessons", "0001-start.html"),
    "<!doctype html><title>Start</title><h1 data-learn-block=\"start\">Start</h1><p>A substantive first lecture.</p>",
    "utf8",
  );
  if (twoLectures) {
    await writeFile(
      path.join(course, "lessons", "0002-follow-up.html"),
      "<!doctype html><title>Follow up</title><h1 data-learn-block=\"follow-up\">Follow up</h1><p>A substantive second lecture.</p>",
      "utf8",
    );
  }
  await writeFile(path.join(course, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [
      { id: "foundations", title: "Foundations", description: "", lectures: ["lessons/0001-start.html"] },
      ...(twoLectures
        ? [{ id: "practice", title: "Practice", description: "", lectures: ["lessons/0002-follow-up.html"] }]
        : []),
    ],
  }, null, 2)}\n`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, course };
}

function requestApp(server, { method = "GET", pathname = "/", body = "" }) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = pathname;
  request.complete = true;
  request.headers = { host: "127.0.0.1", "x-margin-session": server.marginSessionToken };
  return new Promise((resolve) => {
    const chunks = [];
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      headersSent: false,
      status: 0,
      headers: {},
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
        return this;
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({ status: this.status, body: Buffer.concat(chunks) });
      },
    });
    server.emit("request", request, response);
  });
}

test("lecture deletion archives HTML, notes, images, and a deletion version", async (t) => {
  const { root, course } = await fixture(t);
  const kept = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "Start",
    message: "Keep this note.",
    anchor: null,
  });
  const archived = await addAnnotation(root, "systems", {
    lesson: "lessons/0002-follow-up.html",
    quote: "Follow up",
    message: "Archive this note.",
    anchor: null,
    image: { dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}` },
  });

  const result = await archiveLecture(course, "lessons/0002-follow-up.html");
  assert.equal(result.nextLesson, "lessons/0001-start.html");
  assert.equal(result.removedChapter, true);
  assert.match(result.archive, /^\.learn\/trash\/lectures\//);

  const structure = await readCourseStructure(course);
  assert.deepEqual(structure.chapters.map((chapter) => chapter.id), ["foundations"]);
  assert.deepEqual(structure.lectures.map((lecture) => lecture.path), ["lessons/0001-start.html"]);
  await assert.rejects(readFile(path.join(course, "lessons", "0002-follow-up.html")), { code: "ENOENT" });

  const store = await readAnnotationStore(root, "systems");
  assert.deepEqual(store.annotations.map((annotation) => annotation.id), [kept.id]);
  const archiveRoot = path.join(course, result.archive);
  assert.match(await readFile(path.join(archiveRoot, "lecture.html"), "utf8"), /substantive second lecture/);
  const metadata = JSON.parse(await readFile(path.join(archiveRoot, "deletion.json"), "utf8"));
  assert.equal(metadata.lesson, "lessons/0002-follow-up.html");
  assert.deepEqual(metadata.annotations.map((annotation) => annotation.id), [archived.id]);
  assert.deepEqual(
    await readFile(path.join(archiveRoot, "annotation-images", archived.id, "image.png")),
    ONE_PIXEL_PNG,
  );

  const history = await readLectureHistory(course, "lessons/0002-follow-up.html");
  assert.equal(history.lectures[0].commits[0].action, "delete");
  assert.equal(history.lectures[0].commits[0].id, result.lectureVersion.id);
});

test("the last lecture cannot be deleted", async (t) => {
  const { course } = await fixture(t, { twoLectures: false });
  await assert.rejects(
    archiveLecture(course, "lessons/0001-start.html"),
    (error) => error?.status === 409 && /Delete the course instead/.test(error.message),
  );
  assert.equal((await readCourseStructure(course)).lectures.length, 1);
});

test("course deletion moves the complete course into Margin Trash", async (t) => {
  const { root } = await fixture(t);
  const result = await moveCourseToTrash(root, "systems");
  assert.match(result.archive, /^\.margin-trash\/systems--/);
  assert.deepEqual(await discoverCourses(root), []);
  assert.match(await readFile(path.join(root, result.archive, "MISSION.md"), "utf8"), /Mission: Systems/);
});

test("deletion APIs remove a lecture and then its course without permanent erasure", async (t) => {
  const { root } = await fixture(t);
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?deletion=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;
  const server = createAppServer();

  const lectureResponse = await requestApp(server, {
    method: "DELETE",
    pathname: "/api/courses/systems/lectures",
    body: JSON.stringify({ lesson: "lessons/0002-follow-up.html" }),
  });
  assert.equal(lectureResponse.status, 200);
  const lecturePayload = JSON.parse(lectureResponse.body.toString("utf8"));
  assert.equal(lecturePayload.nextLesson, "lessons/0001-start.html");
  assert.equal((await readCourseStructure(path.join(root, "systems"))).lectures.length, 1);
  assert.deepEqual(await readdir(path.join(root, ".margin-course-transactions")), []);

  const courseResponse = await requestApp(server, {
    method: "DELETE",
    pathname: "/api/courses/systems",
  });
  assert.equal(courseResponse.status, 200);
  const coursePayload = JSON.parse(courseResponse.body.toString("utf8"));
  assert.match(coursePayload.archive, /^\.margin-trash\/systems--/);
  assert.deepEqual(await discoverCourses(root), []);
  const archivedInfo = await lstat(path.join(root, coursePayload.archive));
  assert.equal(archivedInfo.isDirectory(), true);
});
