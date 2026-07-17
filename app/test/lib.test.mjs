import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough, Readable, Writable } from "node:stream";

import {
  addAnnotation,
  appendLectureToChapter,
  buildTeacherPrompt,
  createCourseWorkspace,
  deleteAnnotation,
  discoverCourses,
  discoverCoursesDetailed,
  lectureHistoryStoreMatches,
  markAnnotationsUsed,
  normalizeProviderOptions,
  parseProviderLine,
  parseCodexModelCatalog,
  promoteCourseWorkspace,
  providerCommand,
  providerCompatibility,
  providerUpdateCommand,
  readAnnotationImage,
  readAnnotationStore,
  readCourseStructure,
  readLectureHistory,
  readLectureVersionContent,
  recordLectureVersion,
  restoreLectureVersion,
  restoreLectureHistoryStore,
  safeCoursePath,
  snapshotLectureHistoryStore,
} from "../lib.mjs";
import {
  assertCourseIdentity,
  appOwnedLearnerStateMatches,
  boundedEventText,
  captureCourseIdentity,
  courseManifestMatchesSnapshot,
  consumeProviderUpdateRequest,
  launchReadyLine,
  launchToken,
  providerEnvironment,
  providerUpdateCompletionText,
  providerUpdateFailureText,
  restoreAppOwnedLearnerState,
  restoreCourseManifestSnapshot,
  snapshotAppOwnedLearnerState,
  teacherRequestEndedEarly,
  validateFirstLectureDraft,
  validateLectureArtifact,
} from "../server.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function imageDataUrl(type, data) {
  return `data:${type};base64,${data.toString("base64")}`;
}

function requestApp(server, { method = "GET", pathname = "/", body = "", headers = {} }) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = pathname;
  request.complete = true;
  request.headers = { host: "127.0.0.1", "x-margin-session": server.marginSessionToken, ...headers };
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
        resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) });
      },
    });
    server.emit("request", request, response);
  });
}

function disconnectStreamingRequest(server, { pathname, body, disconnectOn = "started" }) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = "POST";
  request.url = pathname;
  request.complete = true;
  request.aborted = false;
  request.headers = { host: "127.0.0.1", "x-margin-session": server.marginSessionToken };
  let resolveDisconnected;
  const disconnected = new Promise((resolve) => { resolveDisconnected = resolve; });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead() {
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      const event = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
      if (event.type === disconnectOn && !this.destroyed) {
        queueMicrotask(() => {
          this.destroyed = true;
          this.emit("close");
          resolveDisconnected();
        });
      }
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  server.emit("request", request, response);
  return disconnected;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "margin-test-"));
  const course = path.join(root, "systems");
  await mkdir(path.join(course, "lessons"), { recursive: true });
  await mkdir(path.join(course, "reference"), { recursive: true });
  await writeFile(path.join(course, "MISSION.md"), "# Mission: Systems\n\n## Why\nLearn the machinery.\n", "utf8");
  await writeFile(path.join(course, "lessons", "0001-start.html"), "<title>Start</title><h1>The first lecture</h1>", "utf8");
  await writeFile(path.join(course, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [{ id: "foundations", title: "Foundations", description: "Start here.", lectures: ["lessons/0001-start.html"] }],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(course, "reference", "terms.html"), "<h1>Terms</h1>", "utf8");
  return { root, course };
}

function fakeProviderSpawner({ writeLesson = true, exitCode = 0, mutate = null } = {}) {
  const calls = [];
  const signals = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = (signal) => {
      signals.push(signal);
      child.killed = true;
      return true;
    };
    let prompt = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += chunk.toString("utf8");
        callback();
      },
      final(callback) {
        Promise.resolve().then(async () => {
          const courseRoot = prompt.match(/^The one selected course for this action is: (.+)$/m)?.[1]?.trim();
          if (writeLesson && courseRoot) {
            await writeFile(
              path.join(courseRoot, "lessons", "0001-first-principle.html"),
              "<!doctype html><html><head><title>First principle</title></head><body><h1 data-learn-block=\"first-principle\">First principle</h1><p>This complete opening lesson explains the central idea with a concrete example.</p></body></html>",
              "utf8",
            );
          }
          if (mutate) await mutate({ prompt, courseRoot, command, args, options });
          calls.push({ prompt, courseRoot, command, args, options });
          if (exitCode === 0) {
            child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First lecture ready." } })}\n`);
            child.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
          } else {
            child.stderr.write("simulated provider failure\n");
          }
          child.stdout.end();
          child.stderr.end();
          child.exitCode = exitCode;
          callback();
          queueMicrotask(() => child.emit("close", exitCode, null));
        }).catch((error) => {
          child.stderr.end(error.message);
          child.stdout.end();
          child.exitCode = 1;
          callback();
          queueMicrotask(() => child.emit("close", 1, null));
        });
      },
    });
    return child;
  };
  return { calls, signals, spawnProcess };
}

const READY_CODEX = {
  id: "codex",
  available: true,
  compatible: true,
  authenticated: true,
  ready: true,
  models: [{ id: "gpt-test", label: "GPT Test", default: true, supportedEfforts: ["high"] }],
};

test("discovers teaching workspaces and lecture metadata", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const courses = await discoverCourses(root);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].id, "systems");
  assert.equal(courses[0].title, "Systems");
  assert.equal(courses[0].mission, "Learn the machinery.");
  assert.deepEqual(courses[0].chapters.map((item) => item.title), ["Foundations"]);
  assert.deepEqual(courses[0].chapters[0].lectures.map((item) => item.title), ["The first lecture"]);
  assert.equal(courses[0].chapters[0].lectures[0].chapterId, "foundations");
});

test("discovers valid courses while reporting malformed course diagnostics through the API", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const broken = path.join(root, "broken-course");
  await mkdir(path.join(broken, "lessons"), { recursive: true });
  await writeFile(path.join(broken, "MISSION.md"), "# Mission: Broken\n", "utf8");
  await writeFile(path.join(broken, "COURSE.json"), "{ not valid json\n", "utf8");

  const discovered = await discoverCoursesDetailed(root);
  assert.deepEqual(discovered.courses.map((course) => course.id), ["systems"]);
  assert.equal(discovered.diagnostics.length, 1);
  assert.equal(discovered.diagnostics[0].id, "broken-course");

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?discovery=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;
  const response = await requestApp(createAppServer(), { pathname: "/api/courses" });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body.toString("utf8"));
  assert.deepEqual(body.courses.map((course) => course.id), ["systems"]);
  assert.deepEqual(body.diagnostics.map((diagnostic) => diagnostic.id), ["broken-course"]);
});

test("creates hidden empty course drafts without a placeholder lecture", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await createCourseWorkspace(root, {
    title: "Café <Systems>",
    initialRequest: "Understand the machinery well enough to build it.",
  });
  assert.equal(first.id, "cafe-systems");
  assert.match(path.basename(first.root), /^\.margin-course-draft-/);
  assert.deepEqual(await readdir(path.join(first.root, "lessons")), []);
  await assert.rejects(() => readCourseStructure(first.root), /must contain at least one lecture/);
  assert.equal((await readCourseStructure(first.root, { allowEmptyChapters: true })).chapters[0].lectures.length, 0);
  assert.equal((await discoverCourses(root)).length, 0);
  assert.doesNotMatch((await readdir(root, { recursive: true })).join("\n"), /0000-begin-here/);

  assert.match(await readFile(path.join(first.root, "MISSION.md"), "utf8"), /Understand the machinery/);
  assert.match(await readFile(path.join(first.root, "assets", "styles.css"), "utf8"), /--accent/);
  await assert.rejects(() => createCourseWorkspace(root, { title: "" }), /Course title is required/);
});

test("course creation API streams, versions, and atomically reveals the first real lecture", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({ mutate: () => new Promise((resolve) => setTimeout(resolve, 50)) });
  const server = createAppServer({
    providerLookup: async () => READY_CODEX,
    spawnProcess: fake.spawnProcess,
  });
  const createBody = {
    title: "Linear algebra",
    initialRequest: "Read modern ML papers.",
    provider: "codex",
    model: "gpt-test",
    effort: "high",
    operationId: "course-create-test-1",
  };
  const [createResponse, concurrentReplay] = await Promise.all([
    requestApp(server, { method: "POST", pathname: "/api/courses/create", body: JSON.stringify(createBody) }),
    requestApp(server, { method: "POST", pathname: "/api/courses/create", body: JSON.stringify(createBody) }),
  ]);
  assert.equal(createResponse.status, 200);
  assert.equal(createResponse.headers["Content-Type"], "application/x-ndjson; charset=utf-8");
  const events = createResponse.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events[0], {
    type: "started",
    operationId: "course-create-test-1",
    provider: "codex",
    action: "create",
    model: "gpt-test",
    effort: "high",
    text: "Codex is writing the first lecture",
  });
  const completed = events.at(-1);
  assert.equal(completed.type, "complete");
  assert.equal(completed.operationId, "course-create-test-1");
  const { course } = completed;
  assert.equal(course.id, "linear-algebra");
  assert.equal(course.title, "Linear algebra");
  assert.equal(course.annotationCount, 0);
  assert.equal(completed.lesson, "lessons/0001-first-principle.html");
  assert.equal(completed.lectureVersion.version, 1);
  assert.equal(completed.lectureVersion.provider, "codex");
  assert.equal(completed.lectureVersion.model, "gpt-test");
  assert.equal(completed.lectureVersion.effort, "high");
  assert.equal(concurrentReplay.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1).type, "complete");
  assert.match(fake.calls[0].prompt, /bundled teach skill is mandatory/i);
  assert.match(fake.calls[0].prompt, /Read modern ML papers/);
  assert.deepEqual(fake.calls[0].args.slice(fake.calls[0].args.indexOf("--model"), fake.calls[0].args.indexOf("--model") + 2), ["--model", "gpt-test"]);
  assert.ok(fake.calls[0].args.includes('model_reasoning_effort="high"'));

  const listResponse = await requestApp(server, { pathname: "/api/courses" });
  assert.equal(listResponse.status, 200);
  assert.deepEqual(JSON.parse(listResponse.body.toString("utf8")).courses.map((item) => item.id), ["linear-algebra"]);
  assert.doesNotMatch((await readdir(root, { recursive: true })).join("\n"), /0000-begin-here/);

  const replayServer = createAppServer({
    providerLookup: async () => { throw new Error("A replay must not inspect the provider"); },
    spawnProcess: () => { throw new Error("A replay must not launch the provider"); },
  });
  const replayResponse = await requestApp(replayServer, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({
      title: "Linear algebra",
      initialRequest: "Read modern ML papers.",
      provider: "codex",
      model: "gpt-test",
      effort: "high",
      operationId: "course-create-test-1",
    }),
  });
  const replayEvents = replayResponse.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replayEvents.length, 1);
  assert.equal(replayEvents[0].type, "complete");
  assert.equal(replayEvents[0].course.id, "linear-algebra");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual((await discoverCourses(root)).map((item) => item.id), ["linear-algebra"]);
  const statusResponse = await requestApp(replayServer, { pathname: "/api/operations/course-create-test-1" });
  assert.equal(JSON.parse(statusResponse.body.toString("utf8")).status, "complete");

  const conflictResponse = await requestApp(replayServer, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({
      title: "Linear algebra",
      initialRequest: "A different request.",
      provider: "codex",
      model: "gpt-test",
      effort: "high",
      operationId: "course-create-test-1",
    }),
  });
  assert.equal(conflictResponse.status, 409);

  await writeFile(path.join(root, "linear-algebra", "COURSE.json"), "{}\n", "utf8");
  const degradedCourseStatus = await requestApp(replayServer, { pathname: "/api/operations/course-create-test-1" });
  const degradedPayload = JSON.parse(degradedCourseStatus.body.toString("utf8"));
  assert.equal(degradedPayload.status, "complete");
  assert.equal(degradedPayload.event.course, "linear-algebra");
});

test("failed first-lecture generation never reveals a course", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-failure=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({ exitCode: 1 });
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Invisible failure", goal: "Legacy goal alias", provider: "codex" }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).text, /exited with code 1/);
  assert.match(fake.calls[0].prompt, /Legacy goal alias/);
  assert.deepEqual(await discoverCourses(root), []);
  assert.deepEqual(await readdir(root), []);
});

test("cancels a hung teacher with TERM then KILL and waits for it to close before releasing the task slot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-cancel=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const signals = [];
  let firstTeacherClosed = false;
  const good = fakeProviderSpawner();
  let launches = 0;
  const spawnProcess = (...args) => {
    launches += 1;
    if (launches > 1) return good.spawnProcess(...args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setTimeout(() => {
          firstTeacherClosed = true;
          child.emit("close", null, signal);
        }, 150);
      }
      return true;
    };
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    return child;
  };
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess });
  await disconnectStreamingRequest(server, {
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Cancelled course", initialRequest: "Teach cancellation.", provider: "codex" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(firstTeacherClosed, false);
  const blocked = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Too-early retry", initialRequest: "Teach task serialization.", provider: "codex" }),
  });
  assert.equal(blocked.status, 409);

  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(firstTeacherClosed, true);
  assert.deepEqual(await discoverCourses(root), []);

  const retry = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Retry course", initialRequest: "Teach retry behavior.", provider: "codex" }),
  });
  const retryEvents = retry.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(retryEvents.at(-1).type, "complete");
});

test("a response close latched during provider finalization prevents course promotion", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-finalize-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-finalize-cancel=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner();
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  await disconnectStreamingRequest(server, {
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Finalization race", initialRequest: "Teach commit boundaries.", provider: "codex" }),
    disconnectOn: "summary",
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(await discoverCourses(root), []);
});

test("course promotion preserves an existing destination and chooses a collision suffix", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupied = path.join(root, "systems");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep.txt"), "existing course", "utf8");
  const draft = await createCourseWorkspace(root, { title: "Systems", initialRequest: "Learn systems." });
  const promoted = await promoteCourseWorkspace(root, draft.root, draft.id);
  assert.equal(promoted.id, "systems-2");
  assert.equal(await readFile(path.join(occupied, "keep.txt"), "utf8"), "existing course");
  await assert.rejects(() => readFile(path.join(draft.root, "MISSION.md")), { code: "ENOENT" });
});

test("validates one substantive 0001 lecture and unchanged app-owned draft state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-first-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const draft = await createCourseWorkspace(root, { title: "Systems", initialRequest: "Learn systems." });
  const courseIdentity = await captureCourseIdentity(draft.root);
  const manifestSnapshot = (await readCourseStructure(draft.root, { allowEmptyChapters: true })).manifestText;
  const learnerStateSnapshot = await snapshotAppOwnedLearnerState(draft.root);
  await writeFile(
    path.join(draft.root, "lessons", "0001-real-lecture.html"),
    "<h1 data-learn-block=\"opening\">A real lecture</h1><p>This is substantive teaching content with enough detail to begin learning.</p>",
    "utf8",
  );
  assert.equal(await validateFirstLectureDraft(draft.root, {
    courseIdentity,
    manifestSnapshot,
    learnerStateSnapshot,
  }), "lessons/0001-real-lecture.html");

  await mkdir(path.join(draft.root, ".learn"));
  await writeFile(path.join(draft.root, ".learn", "annotations.json"), "{}\n", "utf8");
  assert.equal(await appOwnedLearnerStateMatches(draft.root, learnerStateSnapshot), false);
  await assert.rejects(() => validateFirstLectureDraft(draft.root, {
    courseIdentity,
    manifestSnapshot,
    learnerStateSnapshot,
  }), /app-owned \.learn state/);
});

test("rejects placeholder lecture artifacts and non-dash-case numbered filenames", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-artifact-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lessons = path.join(root, "lessons");
  await mkdir(lessons);

  const cases = [
    ["0001-comments-only.html", "<!-- <h1 data-learn-block=\"fake\">Fake</h1> -->", /empty or contains only comments/],
    ["0001-no-heading.html", "<p data-learn-block=\"body\">A detailed paragraph that is long enough but has no heading at all.</p>", /HTML heading/],
    ["0001-no-block.html", "<h1>A heading</h1><p>This detailed paragraph is long enough to otherwise be a valid lecture.</p>", /data-learn-block/],
    ["0001-placeholder.html", "<h1 data-learn-block=\"todo\">Coming soon</h1>", /substantive content/],
  ];
  for (const [filename, source, expected] of cases) {
    await writeFile(path.join(lessons, filename), source, "utf8");
    await assert.rejects(() => validateLectureArtifact(root, `lessons/${filename}`), expected);
  }

  await writeFile(
    path.join(lessons, "0001-Not_Dash_Case.html"),
    "<h1 data-learn-block=\"opening\">A valid heading</h1><p>This body contains enough real teaching detail for artifact validation.</p>",
    "utf8",
  );
  await assert.rejects(
    () => validateLectureArtifact(root, "lessons/0001-Not_Dash_Case.html", { requiredNumber: "0001", requireDashCase: true }),
    /lowercase-dash-case/,
  );
});

test("requires the per-launch session for every API request and persists preferences outside courses", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-session-api-"));
  const stateRoot = await mkdtemp(path.join(tmpdir(), "margin-session-state-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  const previousStateRoot = process.env.MARGIN_STATE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  process.env.MARGIN_STATE_ROOT = stateRoot;
  const { createAppServer: createSecureServer } = await import(`../server.mjs?session=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT; else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;
  if (previousStateRoot === undefined) delete process.env.MARGIN_STATE_ROOT; else process.env.MARGIN_STATE_ROOT = previousStateRoot;

  const server = createSecureServer({ sessionToken: "a-secure-per-launch-session-token", contentOrigin: "http://127.0.0.1:4999" });
  const denied = await requestApp(server, { pathname: "/api/courses", headers: { "x-margin-session": "wrong" } });
  assert.equal(denied.status, 401);
  const bootstrap = await requestApp(server, { pathname: "/api/bootstrap" });
  assert.deepEqual(JSON.parse(bootstrap.body.toString("utf8")), { settings: {}, contentOrigin: "http://127.0.0.1:4999" });
  const saved = await requestApp(server, {
    method: "PATCH", pathname: "/api/settings", body: JSON.stringify({ key: "margin:workspace-scale", value: "1.2" }),
  });
  assert.equal(saved.status, 200);
  const settingsFile = path.join(stateRoot, "settings.json");
  assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), { "margin:workspace-scale": "1.2" });
  assert.equal((await lstat(settingsFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(stateRoot)).filter((name) => name.startsWith(".settings-")), []);
});

test("uses the native launch token exactly and removes secret or state environment from providers", () => {
  assert.equal(launchToken("native-token"), "native-token");
  const directReady = launchReadyLine("127.0.0.1", 4177, "http://127.0.0.1:4999", "browser-token");
  assert.equal(
    directReady,
    "MARGIN_READY http://127.0.0.1:4177/?contentOrigin=http%3A%2F%2F127.0.0.1%3A4999&session=browser-token",
  );
  assert.doesNotMatch(launchReadyLine("127.0.0.1", 4177, "http://127.0.0.1:4999"), /session=/);
  const environment = providerEnvironment({
    PATH: "/bin", HOME: "/tmp/home", LANG: "en_US.UTF-8", API_TOKEN: "secret", MARGIN_STATE_ROOT: "/private", AWS_SECRET_ACCESS_KEY: "secret",
  });
  assert.deepEqual(environment, { PATH: "/bin", HOME: "/tmp/home", LANG: "en_US.UTF-8", NO_COLOR: "1", FORCE_COLOR: "0" });
});

test("rejects a replaced course root before app-owned rollback can follow it", async (t) => {
  const { root, course } = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "margin-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await mkdir(path.join(outside, "lessons"));
  await writeFile(path.join(outside, "lessons", "keep.html"), "do not delete", "utf8");
  const identity = await captureCourseIdentity(course);
  await rename(course, `${course}.moved`);
  await symlink(outside, course, "dir");
  await assert.rejects(() => assertCourseIdentity(identity.root.path, identity), /replaced|redirected/);
  assert.equal(await readFile(path.join(outside, "lessons", "keep.html"), "utf8"), "do not delete");
});

test("content server isolates generated documents and only exposes approved course files", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(course, "assets"));
  await writeFile(path.join(course, "assets", "lecture.css"), "body { color: #241f1a; }\n", "utf8");
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer: createIsolatedAppServer, createContentServer } = await import(`../server.mjs?content=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT; else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;
  const server = createContentServer({ appOrigin: "http://127.0.0.1:4177" });
  const contentHeaders = { host: "127.0.0.1:4999" };
  const lecture = await requestApp(server, {
    pathname: "/course/systems/lessons/0001-start.html?bridge=opaque-reader-bridge&parent=http%3A%2F%2F127.0.0.1%3A4177",
    headers: contentHeaders,
  });
  assert.equal(lecture.status, 200);
  const lecturePolicy = lecture.headers["Content-Security-Policy"];
  assert.match(lecturePolicy, /connect-src 'none'/);
  assert.match(lecturePolicy, /^sandbox allow-scripts;/);
  assert.match(lecturePolicy, /frame-ancestors http:\/\/127\.0\.0\.1:4177/);
  assert.match(lecturePolicy, /style-src http:\/\/127\.0\.0\.1:4999 'unsafe-inline'/);
  assert.match(lecturePolicy, /script-src http:\/\/127\.0\.0\.1:4999 'unsafe-inline'/);
  assert.match(lecturePolicy, /img-src http:\/\/127\.0\.0\.1:4999 data: blob:/);
  assert.doesNotMatch(lecturePolicy, /'self'/);
  assert.match(lecture.body.toString("utf8"), /marginBridge/);
  const asset = await requestApp(server, { pathname: "/course/systems/assets/lecture.css", headers: contentHeaders });
  assert.equal(asset.status, 200);
  assert.match(asset.headers["Content-Security-Policy"], /style-src http:\/\/127\.0\.0\.1:4999 'unsafe-inline'/);
  assert.match(asset.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.doesNotMatch(asset.headers["Content-Security-Policy"], /'self'/);
  assert.equal((await requestApp(server, { pathname: "/course/systems/.learn/annotations.json" })).status, 404);
  const appServer = createIsolatedAppServer({ sessionToken: "reader-session" });
  assert.equal((await requestApp(appServer, { pathname: "/course/systems/lessons/0001-start.html" })).status, 404);
});

test("does not mistake a fully read request stream for a closed teacher request", () => {
  const completedRequest = { aborted: false, complete: true, destroyed: true };
  assert.equal(teacherRequestEndedEarly(completedRequest, { destroyed: false }), false);
  assert.equal(teacherRequestEndedEarly({ ...completedRequest, aborted: true }, { destroyed: false }), true);
  assert.equal(teacherRequestEndedEarly({ ...completedRequest, complete: false }, { destroyed: false }), true);
  assert.equal(teacherRequestEndedEarly(completedRequest, { destroyed: true }), true);
});

test("consumes an update POST before checking request completion", async () => {
  const request = Readable.from([Buffer.from("{}")]);
  request.aborted = false;
  request.complete = false;
  request.once("end", () => {
    request.complete = true;
  });
  await consumeProviderUpdateRequest(request);
  assert.equal(request.complete, true);
  assert.equal(teacherRequestEndedEarly(request, { destroyed: false }), false);
});

test("a dropped update stream does not force-kill the provider installer", async () => {
  const { createAppServer: createUpdateServer } = await import(`../server.mjs?update-noncancel=${Date.now()}`);
  let launches = 0;
  let spawnOptions;
  const signals = [];
  const spawnProcess = (_command, _args, options) => {
    launches += 1;
    spawnOptions = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    setTimeout(() => {
      child.stdout.end("provider update complete\n");
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0, null);
    }, 40);
    return child;
  };
  const server = createUpdateServer({
    providerLookup: async (_provider, options = {}) => ({ ...READY_CODEX, version: options.refresh ? "2.0.0" : "1.0.0" }),
    spawnProcess,
  });

  await disconnectStreamingRequest(server, {
    pathname: "/api/providers/codex/update",
    body: "{}",
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(launches, 1);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal(spawnOptions.detached, process.platform !== "win32");
  assert.deepEqual(signals, []);

  const retry = await requestApp(server, {
    method: "POST",
    pathname: "/api/providers/codex/update",
    body: "{}",
  });
  assert.equal(retry.status, 200);
  const events = retry.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "complete");
  assert.equal(launches, 2);
  assert.deepEqual(signals, []);
});

test("validates and atomically extends chapter manifests", async (t) => {
  const { course } = await fixture();
  t.after(() => rm(path.dirname(course), { recursive: true, force: true }));
  const structure = await readCourseStructure(course);
  await writeFile(path.join(course, "lessons", "0002-next.html"), "<h1>The next lecture</h1>", "utf8");
  await appendLectureToChapter(course, "foundations", "lessons/0002-next.html", structure.manifestText);
  const updated = await readCourseStructure(course);
  assert.deepEqual(updated.chapters[0].lectures.map((item) => item.path), [
    "lessons/0001-start.html",
    "lessons/0002-next.html",
  ]);

  await writeFile(path.join(course, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [{ id: "foundations", title: "Foundations", lectures: ["lessons/0001-start.html"] }],
  })}\n`, "utf8");
  await assert.rejects(() => readCourseStructure(course), /does not assign every lecture/);
});

test("rejects hidden paths and traversal", async () => {
  assert.throws(() => safeCoursePath("/tmp/work", "systems", "../secret"), /Hidden|escapes/);
  assert.throws(() => safeCoursePath("/tmp/work", "systems", ".learn/annotations.json"), /Hidden/);
  assert.equal(safeCoursePath("/tmp/work", "systems", "lessons/0001.html"), "/tmp/work/systems/lessons/0001.html");
});

test("persists, consumes, and deletes margin messages", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const annotation = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "first lecture",
    message: "Make this concrete.",
    anchor: { prefix: "The ", suffix: "", startPath: [0], startOffset: 0, endPath: [0], endOffset: 5 },
  });
  let store = await readAnnotationStore(root, "systems");
  assert.equal(store.annotations.length, 1);
  assert.deepEqual(store.annotations[0].uses, []);

  await markAnnotationsUsed(root, "systems", [annotation.id], { action: "revise", provider: "codex", target: "lessons/0001-start.html" });
  store = await readAnnotationStore(root, "systems");
  assert.equal(store.annotations[0].uses[0].provider, "codex");
  assert.match(await readFile(path.join(root, "systems", ".learn", "annotations.json"), "utf8"), /Make this concrete/);

  assert.equal(await deleteAnnotation(root, "systems", annotation.id), true);
  assert.equal((await readAnnotationStore(root, "systems")).annotations.length, 0);
});

test("persists image-only annotations as metadata and removes their files", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const annotation = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "",
    message: "",
    anchor: null,
    image: { dataUrl: imageDataUrl("image/png", ONE_PIXEL_PNG) },
  });

  assert.deepEqual(annotation.image, { type: "image/png", bytes: ONE_PIXEL_PNG.length });
  assert.equal(annotation.anchor, null);
  assert.ok(!Object.hasOwn(annotation.image, "dataUrl"));
  const storedText = await readFile(path.join(root, "systems", ".learn", "annotations.json"), "utf8");
  assert.doesNotMatch(storedText, new RegExp(ONE_PIXEL_PNG.toString("base64")));

  const image = await readAnnotationImage(root, "systems", annotation.id);
  assert.equal(image.type, "image/png");
  assert.deepEqual(image.data, ONE_PIXEL_PNG);
  const filename = path.join(root, "systems", ".learn", "annotation-images", annotation.id, "image.png");
  assert.deepEqual(await readFile(filename), ONE_PIXEL_PNG);

  assert.equal(await deleteAnnotation(root, "systems", annotation.id), true);
  await assert.rejects(() => readFile(filename), (error) => error?.code === "ENOENT");
  assert.equal((await readAnnotationStore(root, "systems")).annotations.length, 0);
});

test("detects teacher tampering with private annotation metadata or image bytes", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const annotation = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "",
    message: "Private learner context",
    anchor: null,
    image: { dataUrl: imageDataUrl("image/png", ONE_PIXEL_PNG) },
  });
  const snapshot = await snapshotAppOwnedLearnerState(course);
  const identity = await captureCourseIdentity(course);
  assert.equal(await appOwnedLearnerStateMatches(course, snapshot), true);

  const image = path.join(course, ".learn", "annotation-images", annotation.id, "image.png");
  await writeFile(image, Buffer.concat([ONE_PIXEL_PNG, Buffer.from("tamper")]));
  assert.equal(await appOwnedLearnerStateMatches(course, snapshot), false);
  const restored = await restoreAppOwnedLearnerState(course, snapshot, identity);
  assert.match(path.basename(restored.quarantine), /^\.margin-learn-quarantine-/);
  await assert.rejects(() => readdir(restored.quarantine), (error) => error?.code === "ENOENT");
  assert.deepEqual(await readFile(image), ONE_PIXEL_PNG);
});

test("teacher rollback restores the complete course after malformed lesson and supporting-artifact changes", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const annotation = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "first lecture",
    message: "Keep this learner note intact.",
    anchor: null,
  });
  const originalManifest = await readFile(path.join(course, "COURSE.json"), "utf8");
  await writeFile(path.join(course, "vocabulary.json"), "{\"known\":[\"original\"]}\n", "utf8");
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?rollback=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({
    writeLesson: false,
    mutate: async ({ courseRoot }) => {
      await mkdir(path.join(courseRoot, "lessons", "unsafe-directory"));
      await writeFile(path.join(courseRoot, "COURSE.json"), "{}\n", "utf8");
      await writeFile(path.join(courseRoot, ".learn", "annotations.json"), "{\"tampered\":true}\n", "utf8");
      await writeFile(path.join(courseRoot, ".learn", "lecture-history.json"), "{}\n", "utf8");
      await writeFile(path.join(courseRoot, "vocabulary.json"), "{\"known\":[\"partial\"]}\n", "utf8");
      await writeFile(path.join(courseRoot, "partial-tool.mjs"), "throw new Error('partial');\n", "utf8");
    },
  });
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({
      course: "systems",
      action: "next",
      lesson: "lessons/0001-start.html",
      chapter: "foundations",
      provider: "codex",
    }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).text, /modified app-owned learner notes, images, or history/);
  assert.equal(await readFile(path.join(course, "COURSE.json"), "utf8"), originalManifest);
  assert.equal(await readFile(path.join(course, "vocabulary.json"), "utf8"), "{\"known\":[\"original\"]}\n");
  await assert.rejects(readFile(path.join(course, "partial-tool.mjs")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(course, "lessons", "unsafe-directory")), { code: "ENOENT" });
  assert.deepEqual((await readAnnotationStore(root, "systems")).annotations.map((item) => item.id), [annotation.id]);
  const restoredHistory = JSON.parse(await readFile(path.join(course, ".learn", "lecture-history.json"), "utf8"));
  assert.ok(restoredHistory.lectures["lessons/0001-start.html"]);
});

test("replaying a completed next-lecture operation does not launch a teacher or add another lecture", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?next-replay=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({
    writeLesson: false,
    mutate: async ({ courseRoot }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(
        path.join(courseRoot, "lessons", "0002-follow-up.html"),
        "<!doctype html><html><head><title>Follow up</title></head><body><h1 data-learn-block=\"follow-up\">Follow up</h1><p>This substantive second lecture extends the first idea with a concrete worked example.</p></body></html>",
        "utf8",
      );
    },
  });
  const body = {
    action: "next",
    course: "systems",
    chapter: "foundations",
    lesson: "lessons/0001-start.html",
    provider: "codex",
    model: "gpt-test",
    effort: "high",
    annotationIds: [],
    operationId: "next-lecture-test-1",
  };
  let providerLookups = 0;
  const server = createAppServer({
    providerLookup: async () => {
      providerLookups += 1;
      return READY_CODEX;
    },
    spawnProcess: fake.spawnProcess,
  });
  const [first, concurrentReplay] = await Promise.all([
    requestApp(server, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(body) }),
    requestApp(server, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(body) }),
  ]);
  const firstEvents = first.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(firstEvents.at(-1).type, "complete");
  assert.equal(firstEvents.at(-1).lesson, "lessons/0002-follow-up.html");
  assert.equal(concurrentReplay.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1).type, "complete");

  const replayServer = createAppServer({
    providerLookup: async () => { throw new Error("A replay must not inspect the provider"); },
    spawnProcess: () => { throw new Error("A replay must not launch the provider"); },
  });
  const replay = await requestApp(replayServer, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(body) });
  const replayEvents = replay.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replayEvents.length, 1);
  assert.equal(replayEvents[0].type, "complete");
  assert.equal(replayEvents[0].lesson, "lessons/0002-follow-up.html");
  const scopedStatus = await requestApp(replayServer, { pathname: "/api/operations/next-lecture-test-1?course=systems" });
  assert.equal(JSON.parse(scopedStatus.body.toString("utf8")).status, "complete");
  assert.equal(providerLookups, 1);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual((await readCourseStructure(course)).chapters[0].lectures.map((item) => item.path), [
    "lessons/0001-start.html",
    "lessons/0002-follow-up.html",
  ]);
});

test("replaying a completed revision reuses its receipt and annotation use", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const annotation = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "The first lecture",
    message: "Add a concrete worked example.",
    anchor: null,
  });
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?revision-replay=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({
    writeLesson: false,
    mutate: async ({ courseRoot }) => {
      await writeFile(
        path.join(courseRoot, "lessons", "0001-start.html"),
        "<!doctype html><html><head><title>Start revised</title></head><body><h1 data-learn-block=\"start\">The first lecture</h1><p>This revised lecture now includes a concrete worked example with enough detail to teach the idea.</p></body></html>",
        "utf8",
      );
    },
  });
  const body = {
    action: "revise",
    course: "systems",
    chapter: "foundations",
    lesson: "lessons/0001-start.html",
    provider: "codex",
    model: "gpt-test",
    effort: "high",
    annotationIds: [annotation.id],
    operationId: "revision-test-1",
  };
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  const first = await requestApp(server, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(body) });
  assert.equal(first.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1).type, "complete");

  const replayServer = createAppServer({
    providerLookup: async () => { throw new Error("A replay must not inspect the provider"); },
    spawnProcess: () => { throw new Error("A replay must not launch the provider"); },
  });
  const replay = await requestApp(replayServer, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(body) });
  const replayEvents = replay.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replayEvents.length, 1);
  assert.equal(replayEvents[0].type, "complete");
  assert.equal(replayEvents[0].lesson, "lessons/0001-start.html");
  assert.equal(fake.calls.length, 1);
  assert.equal((await readLectureHistory(course, "lessons/0001-start.html")).lectures[0].commits.length, 2);
  const stored = (await readAnnotationStore(root, "systems")).annotations.find((item) => item.id === annotation.id);
  assert.equal(stored.uses.length, 1);

  const newAnnotation = await addAnnotation(root, "systems", {
    lesson: "lessons/0001-start.html",
    quote: "concrete worked example",
    message: "Now contrast it with a counterexample.",
    anchor: null,
  });
  const staleReplay = await requestApp(replayServer, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({ ...body, annotationIds: [newAnnotation.id] }),
  });
  assert.equal(staleReplay.status, 409);
  assert.equal(fake.calls.length, 1);
  const afterStaleReplay = (await readAnnotationStore(root, "systems")).annotations.find((item) => item.id === newAnnotation.id);
  assert.equal(afterStaleReplay.uses?.length || 0, 0);
  const invalidAnnotations = await requestApp(replayServer, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({ ...body, operationId: "invalid-annotation-test", annotationIds: ["bad/id"] }),
  });
  assert.equal(invalidAnnotations.status, 400);
  assert.equal(fake.calls.length, 1);
});

test("rejects unsafe or oversized annotation images", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { lesson: "lessons/0001-start.html", quote: "", message: "", anchor: null };

  await assert.rejects(
    () => addAnnotation(root, "systems", { ...base, image: { dataUrl: imageDataUrl("image/gif", Buffer.from("GIF89a")) } }),
    /PNG, JPEG, or WebP|Invalid image data URL/,
  );
  await assert.rejects(
    () => addAnnotation(root, "systems", { ...base, image: { dataUrl: imageDataUrl("image/png", Buffer.from([0xff, 0xd8, 0xff, 0xd9])) } }),
    /does not match/,
  );
  await assert.rejects(
    () => addAnnotation(root, "systems", { ...base, image: { dataUrl: "data:image/png;base64,not-valid***" } }),
    /Invalid image data URL/,
  );
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  Buffer.from("89504e470d0a1a0a", "hex").copy(oversized);
  await assert.rejects(
    () => addAnnotation(root, "systems", { ...base, image: { dataUrl: imageDataUrl("image/png", oversized) } }),
    /maximum 5 MiB/,
  );
  await assert.rejects(() => addAnnotation(root, "systems", base), /Message or image is required/);
});

test("annotation image API creates, serves, and deletes local images", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?fixture=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const server = createAppServer();
  const largePng = Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(1024 * 1024)]);
  const createResponse = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/systems/annotations",
    body: JSON.stringify({
      lesson: "lessons/0001-start.html",
      quote: "",
      message: "Image context",
      anchor: null,
      image: { dataUrl: imageDataUrl("image/png", largePng) },
    }),
  });
  assert.equal(createResponse.status, 201);
  const { annotation } = JSON.parse(createResponse.body.toString("utf8"));

  const imageResponse = await requestApp(server, { pathname: `/api/courses/systems/annotations/${annotation.id}/image` });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers["Content-Type"], "image/png");
  assert.deepEqual(imageResponse.body, largePng);
  const queryTokenOnly = await requestApp(server, {
    pathname: `/api/courses/systems/annotations/${annotation.id}/image?session=${server.marginSessionToken}`,
    headers: { "x-margin-session": "" },
  });
  assert.equal(queryTokenOnly.status, 401);

  const normalBodyResponse = await requestApp(server, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
  });
  assert.equal(normalBodyResponse.status, 413);

  const deleteResponse = await requestApp(server, {
    method: "DELETE",
    pathname: `/api/courses/systems/annotations/${annotation.id}`,
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await requestApp(server, { pathname: `/api/courses/systems/annotations/${annotation.id}/image` })).status, 404);
});

test("teacher prompts preserve asynchronous app semantics", () => {
  const annotation = { id: "a1", quote: "A subtle claim", message: "Show why.", uses: [] };
  const chapter = {
    id: "foundations",
    title: "Foundations",
    lectures: [{ path: "lessons/0001-start.html" }],
  };
  const first = buildTeacherPrompt({
    action: "first",
    workspaceRoot: "/tmp/learn",
    courseRoot: "/tmp/learn/.margin-course-draft-test",
    chapter: { id: "foundations", title: "Foundations", lectures: [] },
    initialRequest: "Teach me enough linear algebra to read transformer papers.",
    teachSkillPath: "/tmp/teach/SKILL.md",
  });
  assert.match(first, /bundled teach skill is mandatory/i);
  assert.match(first, /lessons\/0001-<dash-case-name>\.html/);
  assert.match(first, /COURSE\.json intentionally lists no lectures/);
  assert.match(first, /Do not edit COURSE\.json or create or edit anything in \.learn/);
  assert.match(first, /Teach me enough linear algebra/);
  assert.throws(() => buildTeacherPrompt({
    action: "first",
    workspaceRoot: "/tmp/learn",
    courseRoot: "/tmp/learn/.margin-course-draft-test",
    chapter: { id: "foundations", title: "Foundations", lectures: [] },
    initialRequest: "",
    teachSkillPath: "/tmp/teach/SKILL.md",
  }), /Initial request is required/);
  const revise = buildTeacherPrompt({
    action: "revise",
    workspaceRoot: "/tmp/learn",
    courseRoot: "/tmp/course",
    lesson: "lessons/0001-start.html",
    chapter,
    annotations: [annotation],
    teachSkillPath: "/tmp/teach/SKILL.md",
  });
  assert.match(revise, /Read it completely before editing/);
  assert.match(revise, /Use the teach skill for this task/);
  assert.match(revise, /absolute source path: \/tmp\/teach\/SKILL\.md/);
  assert.match(revise, /Do not answer them as chat side questions/);
  assert.match(revise, /Replace lessons\/0001-start\.html in place/);
  assert.match(revise, /supporting course artifact.*anywhere inside the selected course/);
  assert.match(revise, /concept-familiarity databases.*small query\/update tools/);
  assert.match(revise, /Do not reject such work merely because it extends beyond lecture prose/);
  assert.match(revise, /COURSE\.json and \.learn\/ are app-owned/);
  assert.match(revise, /Do not edit another course/);

  const imageOnly = buildTeacherPrompt({
    action: "revise",
    workspaceRoot: "/tmp/learn",
    courseRoot: "/tmp/course",
    lesson: "lessons/0001-start.html",
    chapter,
    annotations: [{ id: "image-note", quote: "", message: "", image: { type: "image/webp", bytes: 42 }, uses: [] }],
    teachSkillPath: "/tmp/teach/SKILL.md",
  });
  assert.match(imageOnly, /Selected passage: \(none; this is a lecture-level note\)/);
  assert.match(imageOnly, /Learner message: \(image only\)/);
  assert.match(imageOnly, /Learner image \(read-only\): \/tmp\/course\/\.learn\/annotation-images\/image-note\/image\.webp/);
  assert.match(imageOnly, /inspect that local image as read-only input/);

  const next = buildTeacherPrompt({
    action: "next",
    workspaceRoot: "/tmp/learn",
    courseRoot: "/tmp/course",
    lesson: "lessons/0001-start.html",
    chapter,
    annotations: [annotation],
    teachSkillPath: "/tmp/teach/SKILL.md",
  });
  assert.match(next, /Create exactly one globally next-numbered lecture/);
  assert.match(next, /CLI working root is: \/tmp\/learn/);
  assert.match(next, /one selected course for this action is: \/tmp\/course/);
  assert.match(next, /Do not choose or modify another course/);
  assert.match(next, /Continue chapter "Foundations"/);
  assert.match(next, /Margin will register the new lecture/);
  assert.match(next, /Do not assume.*answered/);
  assert.match(next, /Do not add the legacy bottom comment box/);
});

test("migrates legacy backups into a content-addressed lecture history", async (t) => {
  const { course } = await fixture();
  t.after(() => rm(path.dirname(course), { recursive: true, force: true }));
  const lesson = "lessons/0001-start.html";
  const original = await readFile(path.join(course, lesson));
  const legacyDirectory = path.join(course, ".learn", "history", "0001-start");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(path.join(legacyDirectory, "2026-01-01T00-00-00-000Z.html"), original);
  const revised = Buffer.from("<title>Revised</title><h1>A clearer lecture</h1>");
  await writeFile(path.join(course, lesson), revised);

  let history = await readLectureHistory(course, lesson);
  assert.equal(history.lectures.length, 1);
  assert.deepEqual(history.lectures[0].commits.map((commit) => commit.version), [2, 1]);
  assert.deepEqual(history.lectures[0].commits.map((commit) => commit.action), ["import", "import"]);
  assert.deepEqual(await readLectureVersionContent(course, lesson, history.lectures[0].commits[0].id), revised);
  assert.deepEqual(await readLectureVersionContent(course, lesson, history.lectures[0].commits[1].id), original);

  const latest = Buffer.from("<title>Latest</title><h1>Worked examples</h1>");
  await writeFile(path.join(course, lesson), latest);
  const recorded = await recordLectureVersion(course, lesson, {
    action: "revise",
    provider: "codex",
    model: "gpt-test",
    effort: "high",
  });
  assert.equal(recorded.version, 3);
  assert.equal(recorded.provider, "codex");
  assert.equal(recorded.model, "gpt-test");
  assert.equal(recorded.effort, "high");

  history = await readLectureHistory(course, lesson);
  const baseline = history.lectures[0].commits.at(-1);
  const restored = await restoreLectureVersion(course, lesson, baseline.id);
  assert.equal(restored.current.version, 4);
  assert.equal(restored.current.action, "restore");
  assert.equal(restored.current.parent, recorded.id);
  assert.equal(restored.current.restoredFrom, baseline.id);
  assert.deepEqual(await readFile(path.join(course, lesson)), original);
  assert.equal(restored.current.hash, baseline.hash);
});

test("lecture history API serves snapshots and restores as a new version", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lesson = "lessons/0001-start.html";
  const original = await readFile(path.join(course, lesson));
  await readLectureHistory(course, lesson);
  await writeFile(path.join(course, lesson), "<h1>Changed</h1>");
  await recordLectureVersion(course, lesson, { action: "revise", provider: "claude", model: "sonnet", effort: "high" });

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?history=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;
  const server = createAppServer();

  const response = await requestApp(server, {
    pathname: "/api/courses/systems/history?lesson=lessons%2F0001-start.html",
  });
  assert.equal(response.status, 200);
  const history = JSON.parse(response.body.toString("utf8")).history.lectures[0];
  assert.deepEqual(history.commits.map((commit) => commit.version), [2, 1]);
  const baseline = history.commits.at(-1);

  const content = await requestApp(server, {
    pathname: `/api/courses/systems/history/content?lesson=lessons%2F0001-start.html&commit=${baseline.id}`,
  });
  assert.equal(content.status, 200);
  assert.equal(content.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(content.headers["Content-Security-Policy"], /^sandbox/);
  assert.deepEqual(content.body, original);

  const restore = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/systems/history/restore",
    body: JSON.stringify({ lesson, commit: baseline.id }),
  });
  assert.equal(restore.status, 200);
  const restored = JSON.parse(restore.body.toString("utf8")).history;
  assert.equal(restored.current.version, 3);
  assert.equal(restored.current.restoredFrom, baseline.id);
  assert.deepEqual(await readFile(path.join(course, lesson)), original);
});

test("detects and restores app-owned COURSE.json changes", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestFile = path.join(course, "COURSE.json");
  const original = await readFile(manifestFile, "utf8");
  assert.equal(await courseManifestMatchesSnapshot(course, original), true);
  await writeFile(manifestFile, "{}\n");
  assert.equal(await courseManifestMatchesSnapshot(course, original), false);
  await restoreCourseManifestSnapshot(course, original);
  assert.equal(await readFile(manifestFile, "utf8"), original);

  await rm(manifestFile);
  assert.equal(await courseManifestMatchesSnapshot(course, ""), true);
  await writeFile(manifestFile, "teacher change\n");
  await restoreCourseManifestSnapshot(course, "");
  await assert.rejects(() => readFile(manifestFile), { code: "ENOENT" });
});

test("reconciles manual edits and restores a tampered app-owned history store", async (t) => {
  const { course } = await fixture();
  t.after(() => rm(path.dirname(course), { recursive: true, force: true }));
  const lesson = "lessons/0001-start.html";
  await readLectureHistory(course, lesson);
  await writeFile(path.join(course, lesson), "<h1>Manual edit</h1>");
  const reconciled = await readLectureHistory(course, lesson);
  assert.equal(reconciled.lectures[0].current.version, 2);
  assert.equal(reconciled.lectures[0].current.action, "import");

  const snapshot = await snapshotLectureHistoryStore(course);
  const [referencedObject] = snapshot.objects.keys();
  await rm(path.join(course, ".learn", "objects", referencedObject));
  await assert.rejects(() => readLectureHistory(course, lesson), /missing object/);
  await assert.rejects(() => snapshotLectureHistoryStore(course), /missing object/);
  await restoreLectureHistoryStore(course, snapshot);
  await writeFile(path.join(course, ".learn", "lecture-history.json"), "{}\n");
  assert.equal(await lectureHistoryStoreMatches(course, snapshot), false);
  await restoreLectureHistoryStore(course, snapshot);
  assert.equal(await lectureHistoryStoreMatches(course, snapshot), true);
  assert.equal((await readLectureHistory(course, lesson)).lectures[0].current.version, 2);
});

test("provider commands are foreground, ephemeral, and workspace-bound", () => {
  const course = "/Users/example/learn/infra";
  const claude = providerCommand("claude", course, "/Users/example/learn");
  assert.equal(claude.cwd, "/Users/example/learn");
  assert.ok(claude.args.includes("dontAsk"));
  assert.ok(claude.args.includes("--verbose"));
  assert.ok(claude.args.includes("--no-session-persistence"));
  assert.ok(claude.args.includes("--safe-mode"));
  assert.ok(claude.args.some((value) => value.includes("WebSearch,WebFetch")));
  assert.ok(!claude.args.includes("--setting-sources"));
  assert.ok(claude.args.some((value) => value.includes("Edit(//Users/example/learn/**)")));
  assert.ok(!claude.args.includes("--dangerously-skip-permissions"));

  const codex = providerCommand("codex", course, "/Users/example/learn");
  assert.equal(codex.cwd, "/Users/example/learn");
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--cd"), codex.args.indexOf("--cd") + 2), ["--cd", "/Users/example/learn"]);
  assert.ok(codex.args.includes("workspace-write"));
  assert.ok(codex.args.includes("--search"));
  assert.ok(codex.args.includes("--ignore-user-config"));
  assert.ok(codex.args.includes("--ignore-rules"));
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--disable"), codex.args.indexOf("--disable") + 2), ["--disable", "hooks"]);
  assert.ok(codex.args.includes("--skip-git-repo-check"));
  assert.ok(!codex.args.includes("danger-full-access"));

  const configuredClaude = providerCommand("claude", course, "/Users/example/learn", { model: "sonnet", effort: "high" });
  assert.deepEqual(
    configuredClaude.args.slice(configuredClaude.args.indexOf("--model"), configuredClaude.args.indexOf("--model") + 4),
    ["--model", "sonnet", "--effort", "high"],
  );
  const configuredCodex = providerCommand("codex", course, "/Users/example/learn", { model: "gpt-5.6-sol", effort: "xhigh" });
  const execIndex = configuredCodex.args.indexOf("exec");
  assert.ok(configuredCodex.args.indexOf("--model") < execIndex);
  assert.ok(configuredCodex.args.indexOf("-c") < execIndex);
  assert.deepEqual(configuredCodex.args.slice(configuredCodex.args.indexOf("--model"), configuredCodex.args.indexOf("--model") + 2), ["--model", "gpt-5.6-sol"]);
  assert.deepEqual(configuredCodex.args.slice(configuredCodex.args.indexOf("-c"), configuredCodex.args.indexOf("-c") + 2), ["-c", 'model_reasoning_effort="xhigh"']);
  assert.equal(claude.args.includes("--model"), false);
  assert.equal(claude.args.includes("--effort"), false);
  assert.equal(codex.args.includes("--model"), false);
  assert.equal(codex.args.includes("-c"), false);
});

test("validates provider model and thinking options", () => {
  assert.deepEqual(normalizeProviderOptions("claude", { model: " claude/sonnet-4.5 ", effort: "high" }), {
    model: "claude/sonnet-4.5",
    effort: "high",
  });
  assert.deepEqual(normalizeProviderOptions("codex", { model: "", effort: "ultra" }), { model: "", effort: "ultra" });
  assert.throws(() => normalizeProviderOptions("claude", { model: "-danger" }), /Invalid teacher model/);
  assert.throws(() => normalizeProviderOptions("claude", { model: "bad model" }), /Invalid teacher model/);
  assert.throws(() => normalizeProviderOptions("codex", { model: "x".repeat(121) }), /too long/);
  assert.throws(() => normalizeProviderOptions("claude", { effort: "ultra" }), /Invalid thinking effort for Claude Code/);
  assert.throws(() => normalizeProviderOptions("codex", { effort: "fast" }), /Invalid thinking effort for Codex/);
  assert.throws(() => normalizeProviderOptions("codex", { model: "gpt-small", effort: "max" }, [
    { id: "gpt-small", label: "GPT Small", default: true, supportedEfforts: ["low", "medium"] },
  ]), /Invalid thinking effort for GPT Small/);
});

test("strips the bundled Codex catalog to safe model metadata", () => {
  const models = parseCodexModelCatalog(JSON.stringify({
    models: [
      {
        slug: "gpt-test",
        display_name: "GPT Test",
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        visibility: "list",
        base_instructions: "large field that must not escape",
      },
      {
        slug: "hidden-model",
        display_name: "Hidden",
        supported_reasoning_levels: [{ effort: "medium" }],
        visibility: "hide",
      },
    ],
  }));
  assert.deepEqual(models, [
    { id: "", label: "Default", default: false, defaultEffort: "", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-test", label: "GPT Test", default: true, defaultEffort: "high", supportedEfforts: ["low", "high"] },
  ]);
  assert.equal(JSON.stringify(models).includes("base_instructions"), false);
  assert.deepEqual(parseCodexModelCatalog("not json"), [
    { id: "", label: "Default", default: false, defaultEffort: "", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  ]);
});

test("checks provider command capabilities without pinning versions", () => {
  const claudeHelp = [
    "--print", "--verbose", "--input-format", "--output-format", "--include-partial-messages",
    "--no-session-persistence", "--permission-mode", "--tools", "--allowed-tools", "--safe-mode",
    "--strict-mcp-config", "--no-chrome", "--model", "--effort",
  ].join(" ");
  assert.deepEqual(providerCompatibility("claude", claudeHelp), { compatible: true, missing: [] });
  assert.deepEqual(providerCompatibility("codex", "--ask-for-approval --sandbox --cd --disable --model --config --search", "--json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules"), {
    compatible: true,
    missing: [],
  });
  assert.deepEqual(providerCompatibility("claude", claudeHelp.replace("--verbose", "")), {
    compatible: false,
    missing: ["--verbose"],
  });
  assert.deepEqual(providerUpdateCommand("claude"), { command: "claude", args: ["update"] });
  assert.deepEqual(providerUpdateCommand("codex"), { command: "codex", args: ["update"] });
});

test("bounds streamed activity by UTF-8 byte size", () => {
  const bounded = boundedEventText("你".repeat(20), 20);
  assert.ok(Buffer.byteLength(bounded) <= 20);
  assert.ok(bounded.endsWith("…"));
  assert.equal(boundedEventText("short", 20), "short");
});

test("describes provider update transitions and bounded failures honestly", () => {
  assert.equal(providerUpdateCompletionText("claude", "2.1.0", "2.1.0"), "Claude Code is already current (2.1.0).");
  assert.equal(providerUpdateCompletionText("codex", "1.0.0", "1.1.0"), "Codex updated from 1.0.0 to 1.1.0.");
  const failure = providerUpdateFailureText("codex", 1, null, "x".repeat(3000));
  assert.match(failure, /^Codex check and update exited with code 1\./);
  assert.ok(Buffer.byteLength(failure) < 1100);
  assert.ok(failure.endsWith("…"));
});

test("normalizes provider JSONL into UI events", () => {
  assert.deepEqual(
    parseProviderLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } })),
    { kind: "summary", text: "Done" },
  );
  assert.deepEqual(
    parseProviderLine("claude", JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "Now I will update the tracker." },
        { type: "tool_use", name: "Write", input: { file_path: "/Users/example/research/learn/spanish/vocabulary.json" } },
      ] },
    })),
    { kind: "activity", text: "Wrote spanish/vocabulary.json" },
  );
  assert.deepEqual(
    parseProviderLine("claude", JSON.stringify({ type: "system", subtype: "init" })),
    { kind: "status", text: "Teacher started" },
  );
  assert.equal(parseProviderLine("claude", JSON.stringify({ type: "system", subtype: "hook_started" })), null);
  assert.deepEqual(
    parseProviderLine("codex", JSON.stringify({ type: "turn.completed" })),
    { kind: "terminal", text: "", terminal: "success" },
  );
  assert.deepEqual(
    parseProviderLine("codex", JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "/Users/example/research/learn/spanish/lessons/0004-next.html", kind: "add" }] },
    })),
    { kind: "activity", text: "Created spanish/lessons/0004-next.html" },
  );
  assert.equal(parseProviderLine("claude", "not json"), null);
  assert.deepEqual(
    parseProviderLine("claude", JSON.stringify({ type: "result", is_error: true, result: "Nope" })),
    { kind: "error", text: "Nope", terminal: "failure" },
  );
  const longSummary = "a".repeat(4500);
  for (const event of [
    parseProviderLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: longSummary } })),
    parseProviderLine("claude", JSON.stringify({ type: "result", result: longSummary })),
  ]) {
    assert.equal(event.text.length, 3000);
    assert.ok(event.text.endsWith("…"));
  }
});
