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
  htmlText,
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
  recoverCourseCreationArtifacts,
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
  startupExitStatus,
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

test("decodes nested HTML entities without turning encoded markup into tags", () => {
  assert.equal(htmlText("Fish &amp; Chips &lt; Basics"), "Fish & Chips < Basics");
  assert.equal(htmlText("Show &amp;lt;code&amp;gt; literally"), "Show &lt;code&gt; literally");
});

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

test("does not hide a library course whose id is app", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const appCourse = path.join(root, "app");
  await mkdir(path.join(appCourse, "lessons"), { recursive: true });
  await writeFile(path.join(appCourse, "MISSION.md"), "# Mission: App\n\n## Why\nShip a real app.\n", "utf8");
  await writeFile(path.join(appCourse, "lessons", "0001-shipping.html"), "<title>Shipping</title><h1>Shipping</h1>", "utf8");
  await writeFile(path.join(appCourse, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [{ id: "foundations", title: "Foundations", description: "", lectures: ["lessons/0001-shipping.html"] }],
  }, null, 2)}\n`, "utf8");
  assert.deepEqual((await discoverCourses(root)).map((course) => course.id).sort(), ["app", "systems"]);
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

  const plain = path.join(root, "plain-directory");
  await mkdir(plain);
  const rejectedDelete = await requestApp(createAppServer(), { method: "DELETE", pathname: "/api/courses/plain-directory" });
  assert.equal(rejectedDelete.status, 400);
  assert.equal((await lstat(plain)).isDirectory(), true);

  const brokenDelete = await requestApp(createAppServer(), { method: "DELETE", pathname: "/api/courses/broken-course" });
  assert.equal(brokenDelete.status, 200);
  await assert.rejects(lstat(broken), { code: "ENOENT" });
  const trashed = await readdir(path.join(root, ".margin-trash"));
  assert.equal(trashed.filter((entry) => entry.startsWith("broken-course--")).length, 1);
  const refreshed = JSON.parse((await requestApp(createAppServer(), { pathname: "/api/courses" })).body.toString("utf8"));
  assert.deepEqual(refreshed.diagnostics, []);
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

test("startup recovery removes stale id locks, promotes completed drafts, and archives incomplete drafts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-create-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const completed = await createCourseWorkspace(root, {
    title: "Recovered course",
    initialRequest: "Teach recovery behavior.",
  });
  const manifestSnapshot = (await readCourseStructure(completed.root, { allowEmptyChapters: true })).manifestText;
  const lesson = "lessons/0001-recovered.html";
  await writeFile(
    path.join(completed.root, lesson),
    "<!doctype html><html><head><title>Recovered</title></head><body><h1 data-learn-block=\"recovered\">Recovered</h1><p>This complete recovered lecture explains why durable creation receipts preserve finished work.</p></body></html>",
    "utf8",
  );
  await appendLectureToChapter(completed.root, "foundations", lesson, manifestSnapshot);
  await recordLectureVersion(completed.root, lesson, {
    action: "create",
    provider: "codex",
    operationId: "recovered-course-test-1",
    operationAction: "course-create",
    requestHash: "a".repeat(64),
  });
  await createCourseWorkspace(root, { title: "Incomplete course", initialRequest: "This draft never finished." });
  await writeFile(path.join(root, ".margin-course-id-stale.lock"), "stale\n", "utf8");

  const recovery = await recoverCourseCreationArtifacts(root);
  assert.deepEqual(recovery.removedLocks, [".margin-course-id-stale.lock"]);
  assert.equal(recovery.recoveredCourses.length, 1);
  assert.equal(recovery.recoveredCourses[0].id, "recovered-course");
  assert.equal(recovery.recoveredCourses[0].operationId, "recovered-course-test-1");
  assert.equal(recovery.archivedDrafts.length, 1);
  assert.match(recovery.archivedDrafts[0], /^\.margin-trash\/recovered-drafts\//);
  assert.deepEqual((await discoverCourses(root)).map((course) => course.id), ["recovered-course"]);
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
  assert.equal(events.at(-1).interruption.kind, "crashed");
  assert.equal(events.at(-1).interruption.hasPartialWork, true);
  assert.ok(events.at(-1).interruption.handoffId);
  assert.match(fake.calls[0].prompt, /Legacy goal alias/);
  assert.deepEqual(await discoverCourses(root), []);
  const handoffId = events.at(-1).interruption.handoffId;
  assert.equal(
    (await lstat(path.join(root, ".margin-teacher-handoffs", handoffId, "partial-course"))).isDirectory(),
    true,
  );
  const handoffResponse = await requestApp(server, { pathname: `/api/teacher-handoffs/${handoffId}` });
  assert.equal(handoffResponse.status, 200);
  assert.equal(JSON.parse(handoffResponse.body.toString("utf8")).handoff.title, "Invisible failure");
});

test("a spawn failure is reported even when the teacher stdin also closes early", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-spawn-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-spawn-failure=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      if (child.exitCode == null) {
        child.exitCode = 1;
        queueMicrotask(() => child.emit("close", 1, null));
      }
      return true;
    };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        const inputError = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        queueMicrotask(() => child.emit("error", Object.assign(new Error("teacher executable missing"), { code: "ENOENT" })));
        callback(inputError);
      },
    });
    return child;
  };
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Spawn failure", initialRequest: "Teach error reporting.", provider: "codex" }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).text, /Could not start the teacher: teacher executable missing/);
  assert.doesNotMatch(events.at(-1).text, /did not accept its input/);
});

test("an explicit cancel stops a hung teacher with TERM then KILL before releasing the task slot", async (t) => {
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
    body: JSON.stringify({
      title: "Cancelled course",
      initialRequest: "Teach cancellation.",
      provider: "codex",
      operationId: "explicit-cancel-test-1",
    }),
  });
  assert.deepEqual(signals, []);
  assert.equal((await lstat(path.join(root, ".margin-state", ".active-teacher-task.json"))).isFile(), true);
  const unrelatedPromotionLock = path.join(root, ".margin-course-id-keep.lock");
  await writeFile(unrelatedPromotionLock, "do not recover while another task is active\n", "utf8");
  const deferred = await requestApp(server, { pathname: "/api/operations/stale-operation-test-1" });
  assert.equal(JSON.parse(deferred.body.toString("utf8")).status, "deferred");
  assert.equal((await lstat(unrelatedPromotionLock)).isFile(), true);
  const running = await requestApp(server, { pathname: "/api/operations/explicit-cancel-test-1" });
  assert.equal(JSON.parse(running.body.toString("utf8")).status, "running");
  const cancel = await requestApp(server, {
    method: "POST",
    pathname: "/api/operations/explicit-cancel-test-1/cancel",
    body: "{}",
  });
  assert.equal(cancel.status, 202);
  assert.equal(JSON.parse(cancel.body.toString("utf8")).status, "cancelling");
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
  await assert.rejects(lstat(path.join(root, ".margin-state", ".active-teacher-task.json")), { code: "ENOENT" });

  const retry = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({ title: "Retry course", initialRequest: "Teach retry behavior.", provider: "codex" }),
  });
  const retryEvents = retry.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(retryEvents.at(-1).type, "complete");
});

test("pausing a background course checkpoints partial files and releases the task slot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-pause-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-pause=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const sessionId = "12345678-1234-4123-8123-123456789abc";
  const signals = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM" && child.exitCode == null) {
        child.exitCode = 143;
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit("close", null, signal));
      }
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
          await writeFile(
            path.join(courseRoot, "lessons", "0001-partial.html"),
            "<!doctype html><html><head><title>Partial</title></head><body><h1>Partial draft</h1></body></html>",
          );
          child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`);
          callback();
        }).catch(callback);
      },
    });
    return child;
  };
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess });
  const operationId = "pause-course-test-1";
  await disconnectStreamingRequest(server, {
    pathname: "/api/courses/create",
    disconnectOn: "status",
    body: JSON.stringify({
      title: "Paused course",
      initialRequest: "Teach checkpointing.",
      provider: "codex",
      operationId,
    }),
  });
  const pause = await requestApp(server, {
    method: "POST",
    pathname: `/api/operations/${operationId}/cancel`,
    body: JSON.stringify({ mode: "pause" }),
  });
  assert.equal(pause.status, 202);
  assert.equal(JSON.parse(pause.body.toString("utf8")).status, "pausing");

  let status;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await requestApp(server, { pathname: `/api/operations/${operationId}` });
    status = JSON.parse(response.body.toString("utf8"));
    if (status.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status.status, "failed");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(status.failure.kind, "paused");
  assert.equal(status.failure.sessionId, sessionId);
  assert.equal(status.failure.hasPartialWork, true);
  assert.deepEqual(await discoverCourses(root), []);
  assert.equal(
    (await lstat(path.join(root, ".margin-teacher-handoffs", operationId, "partial-course", "lessons", "0001-partial.html"))).isFile(),
    true,
  );

  const abandoned = await requestApp(server, {
    method: "DELETE",
    pathname: `/api/teacher-handoffs/${operationId}`,
  });
  assert.equal(abandoned.status, 200);
  await assert.rejects(lstat(path.join(root, ".margin-teacher-handoffs", operationId)), { code: "ENOENT" });
});

test("pausing during provider preflight creates a resumable metadata checkpoint", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-preflight-pause-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-preflight-pause=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  let releaseLookup;
  let announceLookup;
  const lookupStarted = new Promise((resolve) => { announceLookup = resolve; });
  const lookupReleased = new Promise((resolve) => { releaseLookup = resolve; });
  let launches = 0;
  const operationId = "preflight-pause-test-1";
  const server = createAppServer({
    providerLookup: async () => {
      announceLookup();
      await lookupReleased;
      return READY_CODEX;
    },
    spawnProcess: () => {
      launches += 1;
      throw new Error("The paused teacher must not launch");
    },
  });
  const creation = requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({
      title: "Preflight pause",
      initialRequest: "Teach resumable preflight.",
      provider: "codex",
      operationId,
    }),
  });
  await lookupStarted;
  const pause = await requestApp(server, {
    method: "POST",
    pathname: `/api/operations/${operationId}/cancel`,
    body: JSON.stringify({ mode: "pause" }),
  });
  assert.equal(JSON.parse(pause.body.toString("utf8")).status, "pausing");
  releaseLookup();
  await creation;

  const statusResponse = await requestApp(server, { pathname: `/api/operations/${operationId}` });
  const status = JSON.parse(statusResponse.body.toString("utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.failure.kind, "paused");
  assert.equal(status.failure.hasPartialWork, false);
  assert.equal(status.failure.sessionId, "");
  assert.equal(launches, 0);
});

test("an inactive CLI is stopped by the watchdog and reported as stalled", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "margin-course-stall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?course-stall=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const signals = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM" && child.exitCode == null) {
        child.exitCode = 143;
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit("close", null, signal));
      }
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
          await writeFile(path.join(courseRoot, "lessons", "0001-stalled.html"), "<h1>Unfinished</h1>");
          callback();
        }).catch(callback);
      },
    });
    return child;
  };
  const operationId = "stalled-course-test-1";
  const server = createAppServer({
    providerLookup: async () => READY_CODEX,
    spawnProcess,
    teacherStallMilliseconds: 25,
  });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/courses/create",
    body: JSON.stringify({
      title: "Stalled course",
      initialRequest: "Teach watchdog behavior.",
      provider: "codex",
      operationId,
    }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).interruption.kind, "stalled");
  assert.match(events.at(-1).text, /stopped producing activity/);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(
    (await lstat(path.join(root, ".margin-teacher-handoffs", operationId, "partial-course", "lessons", "0001-stalled.html"))).isFile(),
    true,
  );
});

test("a response close during provider finalization does not discard a completed course", async (t) => {
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
    body: JSON.stringify({
      title: "Finalization race",
      initialRequest: "Teach commit boundaries.",
      provider: "codex",
      operationId: "durable-finalization-test-1",
    }),
    disconnectOn: "summary",
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual((await discoverCourses(root)).map((course) => course.id), ["finalization-race"]);
  const status = await requestApp(server, { pathname: "/api/operations/durable-finalization-test-1" });
  assert.equal(JSON.parse(status.body.toString("utf8")).status, "complete");
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
  const savedDocument = await requestApp(server, {
    method: "PATCH", pathname: "/api/settings", body: JSON.stringify({ key: "margin:document:systems", value: "lessons/0001-start.html" }),
  });
  assert.equal(savedDocument.status, 200);
  const settingsFile = path.join(stateRoot, "settings.json");
  assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), { "margin:workspace-scale": "1.2" });
  assert.equal((await lstat(settingsFile)).mode & 0o777, 0o600);
  const libraryIds = await readdir(path.join(stateRoot, "libraries"));
  assert.equal(libraryIds.length, 1);
  const librarySettingsFile = path.join(stateRoot, "libraries", libraryIds[0], "settings.json");
  assert.deepEqual(JSON.parse(await readFile(librarySettingsFile, "utf8")), {
    "margin:document:systems": "lessons/0001-start.html",
  });
  assert.equal((await lstat(librarySettingsFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(stateRoot)).filter((name) => name.startsWith(".settings-")), []);
});

test("document and pending-operation settings stay scoped to their learning library", async (t) => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), "margin-library-a-"));
  const secondRoot = await mkdtemp(path.join(tmpdir(), "margin-library-b-"));
  const stateRoot = await mkdtemp(path.join(tmpdir(), "margin-shared-state-"));
  t.after(() => Promise.all([
    rm(firstRoot, { recursive: true, force: true }),
    rm(secondRoot, { recursive: true, force: true }),
    rm(stateRoot, { recursive: true, force: true }),
  ]));

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  const previousStateRoot = process.env.MARGIN_STATE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = firstRoot;
  process.env.MARGIN_STATE_ROOT = stateRoot;
  const { createAppServer: createFirstServer } = await import(`../server.mjs?library-a=${Date.now()}`);
  process.env.MARGIN_WORKSPACE_ROOT = secondRoot;
  const { createAppServer: createSecondServer } = await import(`../server.mjs?library-b=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT; else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;
  if (previousStateRoot === undefined) delete process.env.MARGIN_STATE_ROOT; else process.env.MARGIN_STATE_ROOT = previousStateRoot;

  const first = createFirstServer();
  const second = createSecondServer();
  await requestApp(first, {
    method: "PATCH",
    pathname: "/api/settings",
    body: JSON.stringify({ key: "margin:workspace-scale", value: "1.25" }),
  });
  await requestApp(first, {
    method: "PATCH",
    pathname: "/api/settings",
    body: JSON.stringify({ key: "margin:document:systems", value: "lessons/0001-a.html" }),
  });
  await requestApp(first, {
    method: "PATCH",
    pathname: "/api/settings",
    body: JSON.stringify({ key: "margin:pending-operations", value: "first-library-receipt" }),
  });

  const secondBootstrap = JSON.parse((await requestApp(second, { pathname: "/api/bootstrap" })).body.toString("utf8"));
  assert.equal(secondBootstrap.settings["margin:workspace-scale"], "1.25");
  assert.equal(secondBootstrap.settings["margin:document:systems"], undefined);
  assert.equal(secondBootstrap.settings["margin:pending-operations"], undefined);
  await requestApp(second, {
    method: "PATCH",
    pathname: "/api/settings",
    body: JSON.stringify({ key: "margin:document:systems", value: "lessons/0001-b.html" }),
  });
  const firstBootstrap = JSON.parse((await requestApp(first, { pathname: "/api/bootstrap" })).body.toString("utf8"));
  assert.equal(firstBootstrap.settings["margin:document:systems"], "lessons/0001-a.html");
  assert.equal(firstBootstrap.settings["margin:pending-operations"], "first-library-receipt");
  assert.equal((await readdir(path.join(stateRoot, "libraries"))).length, 2);
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
    HTTPS_PROXY: "http://proxy.internal:3128", no_proxy: "localhost", ANTHROPIC_API_KEY: "sk-provider-owned",
  });
  assert.deepEqual(environment, {
    PATH: "/bin", HOME: "/tmp/home", LANG: "en_US.UTF-8",
    HTTPS_PROXY: "http://proxy.internal:3128", no_proxy: "localhost", ANTHROPIC_API_KEY: "sk-provider-owned",
    NO_COLOR: "1", FORCE_COLOR: "0",
  });
});

test("maps an occupied library to the native actionable startup status", () => {
  assert.equal(startupExitStatus({ code: "MARGIN_LIBRARY_LOCKED" }), 75);
  assert.equal(startupExitStatus({ code: "MARGIN_LIBRARY_LOCK_UNSAFE" }), 1);
  assert.equal(startupExitStatus(new Error("startup failed")), 1);
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
    image: { dataUrl: imageDataUrl("image/png", ONE_PIXEL_PNG), name: "pronunciation chart.png" },
  });

  assert.deepEqual(annotation.image, { type: "image/png", bytes: ONE_PIXEL_PNG.length, name: "pronunciation chart.png" });
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

test("a switched teacher receives the prior teacher's partial filesystem work", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lesson = "lessons/0001-start.html";
  const originalLesson = await readFile(path.join(course, lesson), "utf8");
  const annotation = await addAnnotation(root, "systems", {
    lesson,
    quote: "The first lecture",
    message: "Add a concrete transfer example.",
    anchor: null,
  });
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?teacher-switch=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const firstSessionId = "12345678-1234-4123-8123-123456789abc";
  const secondSessionId = "87654321-4321-4321-8321-cba987654321";
  const calls = [];
  let transferredPartial = "";
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => true;
    let prompt = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += chunk.toString("utf8");
        callback();
      },
      final(callback) {
        Promise.resolve().then(async () => {
          const courseRoot = prompt.match(/^The one selected course for this action is: (.+)$/m)?.[1]?.trim();
          calls.push({ command, args, prompt });
          if (calls.length === 1) {
            await writeFile(
              path.join(courseRoot, lesson),
              "<!doctype html><html><head><title>Partial revision</title></head><body><h1>Partial idea from Codex</h1></body></html>",
            );
            child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: firstSessionId })}\n`);
            child.stdout.write(`${JSON.stringify({ type: "error", message: "You have hit your usage limit; resets at 5pm" })}\n`);
            child.exitCode = 1;
            child.stdout.end();
            child.stderr.end();
            callback();
            queueMicrotask(() => child.emit("close", 1, null));
            return;
          }

          const partialRoot = prompt.match(/^Partial filesystem work from this and any earlier attempts is preserved at:\n- (.+)$/m)?.[1]?.trim();
          transferredPartial = await readFile(path.join(partialRoot, lesson), "utf8");
          if (!transferredPartial.includes("Partial idea from Codex")) throw new Error("The checkpoint did not contain the prior teacher's partial idea");
          await writeFile(
            path.join(courseRoot, lesson),
            "<!doctype html><html><head><title>Start revised</title></head><body><h1 data-learn-block=\"start\">The first lecture</h1><p>This complete revision carries forward the partial idea from Codex and adds a concrete transfer example.</p></body></html>",
          );
          child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: secondSessionId })}\n`);
          child.stdout.write(`${JSON.stringify({ type: "result", result: "Revision transferred and completed." })}\n`);
          child.exitCode = 0;
          child.stdout.end();
          child.stderr.end();
          callback();
          queueMicrotask(() => child.emit("close", 0, null));
        }).catch((error) => {
          child.exitCode = 1;
          child.stderr.end(error.message);
          child.stdout.end();
          callback();
          queueMicrotask(() => child.emit("close", 1, null));
        });
      },
    });
    return child;
  };
  const providers = {
    codex: READY_CODEX,
    claude: {
      id: "claude",
      available: true,
      compatible: true,
      authenticated: true,
      ready: true,
      models: [],
    },
  };
  const server = createAppServer({ providerLookup: async (provider) => providers[provider], spawnProcess });
  const failedBody = {
    action: "revise",
    course: "systems",
    chapter: "foundations",
    lesson,
    provider: "codex",
    annotationIds: [annotation.id],
    operationId: "switch-source-test-1",
  };
  const first = await requestApp(server, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(failedBody) });
  const firstEvents = first.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const interruption = firstEvents.at(-1).interruption;
  assert.equal(interruption.kind, "session-limit");
  assert.equal(interruption.sessionId, firstSessionId);
  assert.equal(interruption.hasPartialWork, true);
  assert.equal(await readFile(path.join(course, lesson), "utf8"), originalLesson);

  const replay = await requestApp(server, { method: "POST", pathname: "/api/teacher", body: JSON.stringify(failedBody) });
  const replayEvents = replay.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replayEvents.length, 1);
  assert.equal(replayEvents[0].interruption.handoffId, interruption.handoffId);
  assert.equal(calls.length, 1);

  const switched = await requestApp(server, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({
      ...failedBody,
      provider: "claude",
      operationId: "switch-target-test-1",
      handoffId: interruption.handoffId,
    }),
  });
  const switchedEvents = switched.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(switchedEvents.at(-1).type, "complete", switched.body.toString("utf8"));
  assert.match(calls[1].prompt, /Previous teacher checkpoint/);
  assert.match(transferredPartial, /Partial idea from Codex/);
  assert.match(await readFile(path.join(course, lesson), "utf8"), /carries forward the partial idea from Codex/);
  await assert.rejects(lstat(path.join(root, ".margin-teacher-handoffs", interruption.handoffId)), { code: "ENOENT" });
});

test("a teacher may build utilities in the selected course but cannot leave changes in another course", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = path.join(root, "spanish");
  await mkdir(path.join(other, "lessons"), { recursive: true });
  await mkdir(path.join(other, "reference"));
  await writeFile(path.join(other, "MISSION.md"), "# Mission: Spanish\n\nLearn Spanish.\n", "utf8");
  await writeFile(
    path.join(other, "lessons", "0001-hola.html"),
    "<!doctype html><html><head><title>Hola</title></head><body><h1 data-learn-block=\"hola\">Hola</h1><p>A complete introductory Spanish lesson.</p></body></html>",
    "utf8",
  );
  await writeFile(path.join(other, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [{ id: "foundations", title: "Foundations", lectures: ["lessons/0001-hola.html"] }],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(other, "vocabulary.json"), "{\"known\":[\"hola\"]}\n", "utf8");

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?other-course-guard=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({
    writeLesson: false,
    mutate: async ({ courseRoot }) => {
      await writeFile(
        path.join(courseRoot, "lessons", "0002-utility.html"),
        "<!doctype html><html><head><title>Utility</title></head><body><h1 data-learn-block=\"utility\">Utility</h1><p>This substantive follow-up also creates a course-local learner utility.</p></body></html>",
        "utf8",
      );
      await writeFile(path.join(courseRoot, "concept-database.json"), "{\"known\":[\"first principle\"]}\n", "utf8");
      await writeFile(path.join(other, "vocabulary.json"), "{\"known\":[\"tampered\"]}\n", "utf8");
    },
  });
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({
      action: "next",
      course: "systems",
      chapter: "foundations",
      lesson: "lessons/0001-start.html",
      provider: "codex",
      operationId: "other-course-guard-test-1",
    }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const completed = events.at(-1);
  assert.equal(completed.type, "complete");
  assert.match(completed.text, /Another recognized course changed while teaching was running \(spanish\)/);
  assert.ok(events.some((event) => event.type === "status"
    && /Another recognized course changed while teaching was running \(spanish\)/.test(event.text)
    && /\.margin-trash\/guard-conflicts\/spanish--/.test(event.text)));
  assert.equal(await readFile(path.join(other, "vocabulary.json"), "utf8"), "{\"known\":[\"hola\"]}\n");
  const conflicts = await readdir(path.join(root, ".margin-trash", "guard-conflicts"));
  assert.equal(conflicts.length, 1);
  assert.equal(
    await readFile(path.join(root, ".margin-trash", "guard-conflicts", conflicts[0], "vocabulary.json"), "utf8"),
    "{\"known\":[\"tampered\"]}\n",
  );
  // The successful work in the selected course survives the other-course restore.
  assert.equal(
    await readFile(path.join(course, "concept-database.json"), "utf8"),
    "{\"known\":[\"first principle\"]}\n",
  );
  assert.equal((await readCourseStructure(course)).lectures.at(-1).path, "lessons/0002-utility.html");
});

test("margin notes stay writable on other courses while a teacher works", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = path.join(root, "spanish");
  await mkdir(path.join(other, "lessons"), { recursive: true });
  await writeFile(path.join(other, "MISSION.md"), "# Mission: Spanish\n\nLearn Spanish.\n", "utf8");
  await writeFile(
    path.join(other, "lessons", "0001-hola.html"),
    "<!doctype html><html><head><title>Hola</title></head><body><h1 data-learn-block=\"hola\">Hola</h1><p>A complete introductory Spanish lesson.</p></body></html>",
    "utf8",
  );
  await writeFile(path.join(other, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [{ id: "foundations", title: "Foundations", lectures: ["lessons/0001-hola.html"] }],
  }, null, 2)}\n`, "utf8");

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?notes-during-run=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  let server;
  let otherCourseNote = null;
  let taughtCourseNote = null;
  const fake = fakeProviderSpawner({
    writeLesson: false,
    mutate: async ({ courseRoot }) => {
      await writeFile(
        path.join(courseRoot, "lessons", "0002-followup.html"),
        "<!doctype html><html><head><title>Follow up</title></head><body><h1 data-learn-block=\"follow-up\">Follow up</h1><p>This substantive second lecture proves notes stay writable during teaching.</p></body></html>",
        "utf8",
      );
      otherCourseNote = await requestApp(server, {
        method: "POST",
        pathname: "/api/courses/spanish/annotations",
        body: JSON.stringify({ lesson: "lessons/0001-hola.html", quote: "", message: "Reminder while the teacher works.", anchor: null }),
      });
      taughtCourseNote = await requestApp(server, {
        method: "POST",
        pathname: "/api/courses/systems/annotations",
        body: JSON.stringify({ lesson: "lessons/0001-start.html", quote: "", message: "Blocked on the taught course.", anchor: null }),
      });
    },
  });
  server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({
      action: "next",
      course: "systems",
      chapter: "foundations",
      lesson: "lessons/0001-start.html",
      provider: "codex",
    }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "complete");
  assert.equal(otherCourseNote.status, 201);
  assert.equal(taughtCourseNote.status, 409);
  assert.ok(!events.some((event) => event.type === "status" && /Another recognized course changed/.test(event.text)));
  assert.deepEqual(
    (await readAnnotationStore(root, "spanish")).annotations.map((item) => item.message),
    ["Reminder while the teacher works."],
  );
  assert.deepEqual((await readAnnotationStore(root, "systems")).annotations, []);
  await assert.rejects(lstat(path.join(root, ".margin-trash")), { code: "ENOENT" });
});

test("an operation receipt whose course disappeared resolves to unknown instead of failing forever", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?missing-course-status=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const response = await requestApp(createAppServer(), {
    pathname: "/api/operations/orphan-operation-1?course=deleted-course",
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body.toString("utf8")).status, "unknown");
});

test("operation recovery ignores non-course directories in the learning library", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Margin Dev.app"), { recursive: true });
  await recordLectureVersion(course, "lessons/0001-start.html", {
    action: "create",
    provider: "codex",
    operationId: "course-create-bundle-1",
    operationAction: "course-create",
    requestHash: "a".repeat(64),
  });

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?bundle-operation-recovery=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const response = await requestApp(createAppServer(), {
    pathname: "/api/operations/course-create-bundle-1",
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body.toString("utf8"));
  assert.equal(payload.status, "complete");
  assert.equal(payload.event.course.id, "systems");
});

test("an unrelated unguardable course is reported without blocking teaching", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = path.join(root, "linked-course");
  await mkdir(path.join(other, "lessons"), { recursive: true });
  await mkdir(path.join(other, "reference"));
  await writeFile(path.join(other, "MISSION.md"), "# Mission: Linked course\n\nUse shared assets.\n", "utf8");
  await writeFile(
    path.join(other, "lessons", "0001-linked.html"),
    "<!doctype html><html><head><title>Linked</title></head><body><h1 data-learn-block=\"linked\">Linked</h1><p>A complete course with a user-managed shared link.</p></body></html>",
    "utf8",
  );
  await writeFile(path.join(other, "COURSE.json"), `${JSON.stringify({
    version: 1,
    chapters: [{ id: "foundations", title: "Foundations", lectures: ["lessons/0001-linked.html"] }],
  }, null, 2)}\n`, "utf8");
  const shared = path.join(root, "shared-assets");
  await mkdir(shared);
  await symlink(shared, path.join(other, "shared-assets"));

  const previousRoot = process.env.MARGIN_WORKSPACE_ROOT;
  process.env.MARGIN_WORKSPACE_ROOT = root;
  const { createAppServer } = await import(`../server.mjs?unguardable-course=${Date.now()}`);
  if (previousRoot === undefined) delete process.env.MARGIN_WORKSPACE_ROOT;
  else process.env.MARGIN_WORKSPACE_ROOT = previousRoot;

  const fake = fakeProviderSpawner({
    writeLesson: false,
    mutate: async ({ courseRoot }) => {
      await writeFile(
        path.join(courseRoot, "lessons", "0002-continues.html"),
        "<!doctype html><html><head><title>Continues</title></head><body><h1 data-learn-block=\"continues\">Continues</h1><p>This substantive follow-up proves an unrelated linked course does not block teaching.</p></body></html>",
        "utf8",
      );
    },
  });
  const server = createAppServer({ providerLookup: async () => READY_CODEX, spawnProcess: fake.spawnProcess });
  const response = await requestApp(server, {
    method: "POST",
    pathname: "/api/teacher",
    body: JSON.stringify({
      action: "next",
      course: "systems",
      chapter: "foundations",
      lesson: "lessons/0001-start.html",
      provider: "codex",
      operationId: "unguardable-course-test-1",
    }),
  });
  const events = response.body.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "complete");
  assert.ok(events.some((event) => event.type === "status" && /could not transactionally protect linked-course/.test(event.text)));
  assert.equal((await readCourseStructure(course)).lectures.at(-1).path, "lessons/0002-continues.html");
  assert.equal((await lstat(path.join(other, "shared-assets"))).isSymbolicLink(), true);
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
  const { createAppServer, createContentServer } = await import(`../server.mjs?history=${Date.now()}`);
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

  const contentServer = createContentServer({ appOrigin: "http://127.0.0.1:4177" });
  const content = await requestApp(contentServer, {
    pathname: `/history/systems?lesson=lessons%2F0001-start.html&commit=${baseline.id}&bridge=history-test`,
  });
  assert.equal(content.status, 200);
  assert.equal(content.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(content.headers["Content-Security-Policy"], /^sandbox/);
  assert.match(content.body.toString("utf8"), /The first lecture/);
  assert.match(content.body.toString("utf8"), /history-test/);

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

test("provider commands persist resumable sessions and stay workspace-bound", () => {
  const course = "/Users/example/learn/infra";
  const claude = providerCommand("claude", course, "/Users/example/learn");
  assert.equal(claude.cwd, "/Users/example/learn");
  assert.ok(claude.args.includes("dontAsk"));
  assert.ok(claude.args.includes("--verbose"));
  assert.ok(!claude.args.includes("--no-session-persistence"));
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
  assert.ok(!codex.args.includes("--ephemeral"));
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

  const sessionId = "12345678-1234-4123-8123-123456789abc";
  const newClaudeSession = providerCommand("claude", course, "/Users/example/learn", { sessionId });
  assert.deepEqual(
    newClaudeSession.args.slice(newClaudeSession.args.indexOf("--session-id"), newClaudeSession.args.indexOf("--session-id") + 2),
    ["--session-id", sessionId],
  );
  const resumedClaude = providerCommand("claude", course, "/Users/example/learn", { resumeSessionId: sessionId });
  assert.deepEqual(
    resumedClaude.args.slice(resumedClaude.args.indexOf("--resume"), resumedClaude.args.indexOf("--resume") + 2),
    ["--resume", sessionId],
  );
  const resumedCodex = providerCommand("codex", course, "/Users/example/learn", { resumeSessionId: sessionId });
  assert.deepEqual(resumedCodex.args.slice(resumedCodex.args.indexOf("exec"), resumedCodex.args.indexOf("exec") + 3), ["exec", "resume", "--json"]);
  assert.ok(resumedCodex.args.includes(sessionId));
  assert.throws(() => providerCommand("claude", course, "/Users/example/learn", { sessionId: "not-a-session" }), /Invalid teacher session id/);
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
    "--resume", "--session-id", "--permission-mode", "--tools", "--allowed-tools", "--safe-mode",
    "--strict-mcp-config", "--no-chrome", "--model", "--effort",
  ].join(" ");
  assert.deepEqual(providerCompatibility("claude", claudeHelp), { compatible: true, missing: [] });
  assert.deepEqual(providerCompatibility("codex", "--ask-for-approval --sandbox --cd --disable --model --config --search", "resume --json --skip-git-repo-check --ignore-user-config --ignore-rules"), {
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
  const sessionId = "12345678-1234-4123-8123-123456789abc";
  assert.deepEqual(
    parseProviderLine("codex", JSON.stringify({ type: "thread.started", thread_id: sessionId })),
    { kind: "status", text: "Teacher started", sessionId },
  );
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
    parseProviderLine("claude", JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })),
    { kind: "status", text: "Teacher started", sessionId },
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
  assert.deepEqual(
    parseProviderLine("claude", JSON.stringify({
      type: "assistant",
      error: "authentication_failed",
      message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
    })),
    { kind: "error", text: "Not logged in · Please run /login", terminal: "failure" },
  );
  assert.deepEqual(
    parseProviderLine("claude", JSON.stringify({ type: "result", is_error: true, terminal_reason: "api_error" })),
    { kind: "terminal", text: "", terminal: "failure" },
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
