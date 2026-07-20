import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";

import {
  addAnnotation,
  archiveLecture,
  appendLectureToChapter,
  assertCourseId,
  assertLessonPath,
  buildTeacherPrompt,
  createCourseWorkspace,
  deleteAnnotation,
  discoverCoursesDetailed,
  fileExists,
  findLectureOperation,
  markAnnotationsUsed,
  moveCourseToTrash,
  normalizeProviderOptions,
  parseProviderLine,
  promoteCourseWorkspace,
  lectureHistoryStoreMatches,
  providerCommand,
  providerEnvironment,
  providerInfo,
  providerUpdateCommand,
  recoverCourseCreationArtifacts,
  readAnnotationImage,
  readAnnotationStore,
  readCourseStructure,
  readLectureHistory,
  readLectureVersionContent,
  recordLectureVersion,
  restoreCourseManifest,
  restoreLectureHistoryStore,
  restoreLectureVersion,
  safeCoursePath,
  seedLectureHistory,
  snapshotLectureHistoryStore,
} from "./lib.mjs";
import { acquireLibraryLock } from "./library-lock.mjs";
import {
  beginCourseTransaction,
  commitCourseTransaction,
  courseTransactionMatchesSnapshot,
  recoverCourseTransactions,
  rollbackCourseTransaction,
} from "./course-transaction.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(process.env.MARGIN_WORKSPACE_ROOT || path.resolve(APP_DIR, ".."));
const PUBLIC_DIR = path.join(APP_DIR, "public");
const TEACH_SKILL_PATH = path.resolve(
  process.env.MARGIN_TEACH_SKILL_PATH || path.join(WORKSPACE_ROOT, ".agents", "skills", "teach", "SKILL.md"),
);
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4177);
const CONTENT_PORT = Number(process.env.MARGIN_CONTENT_PORT || 0);
const STATE_ROOT = path.resolve(process.env.MARGIN_STATE_ROOT || path.join(WORKSPACE_ROOT, ".margin-state"));
const ACTIVE_TEACHER_TASK_FILE = path.join(STATE_ROOT, ".active-teacher-task.json");
const BODY_LIMIT = 1024 * 1024;
const ANNOTATION_BODY_LIMIT = 8 * 1024 * 1024;
const RUN_EVENT_TEXT_LIMIT = 16 * 1024;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const OPERATION_ANNOTATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

let activeTask = null;
let annotationMutation = Promise.resolve();

const TASK_TERMINATION_GRACE_MS = 100;
const TASK_FORCE_STOP_WAIT_MS = 1000;

function operationId(value = "") {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return randomUUID();
  if (!OPERATION_ID.test(normalized)) throw new Error("Invalid teacher operation id");
  return normalized;
}

function requestHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function createOperationRequest(body, provider, id) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const initialRequest = typeof body.initialRequest === "string"
    ? body.initialRequest.trim()
    : typeof body.goal === "string" ? body.goal.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  return {
    operationId: id,
    requestHash: requestHash(["course-create", title, initialRequest, provider, model, effort]),
  };
}

function operationAnnotationIds(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid teacher annotation ids");
  const ids = value.map((item) => {
    if (typeof item !== "string" || !OPERATION_ANNOTATION_ID.test(item)) throw new Error("Invalid teacher annotation ids");
    return item;
  }).sort();
  if (new Set(ids).size !== ids.length) throw new Error("Invalid teacher annotation ids");
  return ids;
}

function teacherOperationRequest(body, provider, action, courseId, chapterId, lesson, id) {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  const annotationIds = operationAnnotationIds(body.annotationIds);
  return {
    operationId: id,
    requestHash: requestHash([action, courseId, chapterId, lesson, provider, model, effort, annotationIds]),
    annotationIds,
  };
}

function waitForChildClose(child, timeoutMilliseconds = TASK_FORCE_STOP_WAIT_MS) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("close", finish);
      child.removeListener("error", finish);
      resolve();
    };
    child.once("close", finish);
    child.once("error", finish);
    timer = setTimeout(finish, timeoutMilliseconds);
  });
}

function terminateTaskProcessGroup(task, signal = "SIGTERM") {
  const child = task?.child;
  if (!child) return false;
  if (process.platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") return false;
    }
  }
  if (child.exitCode == null) return child.kill(signal);
  return false;
}

async function quiesceTaskProcessGroup(task, graceMilliseconds = TASK_TERMINATION_GRACE_MS) {
  if (!task?.child) return;
  if (!task.stopPromise) {
    task.stopPromise = (async () => {
      const child = task.child;
      const closed = waitForChildClose(child);
      const target = { child };
      terminateTaskProcessGroup(target, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, graceMilliseconds));
      terminateTaskProcessGroup(target, "SIGKILL");
      await closed;
    })();
  }
  await task.stopPromise;
}

function reserveTeacherTask(request, response, details) {
  let resolveCancelled;
  let resolveSettled;
  const task = {
    ...details,
    child: null,
    cancelled: false,
    cancelReason: "",
    responseEnding: false,
    released: false,
    markerOwned: false,
    stopPromise: null,
    startedAt: new Date().toISOString(),
    cancelledPromise: new Promise((resolve) => { resolveCancelled = resolve; }),
    settled: new Promise((resolve) => { resolveSettled = resolve; }),
  };

  const cancel = (reason = "Teacher action was cancelled.") => {
    if (task.cancellable === false || task.cancelled || task.released) return false;
    task.cancelled = true;
    task.cancelReason = reason;
    resolveCancelled();
    void quiesceTaskProcessGroup(task);
    return true;
  };
  task.cancel = cancel;
  task.setChild = (child) => {
    task.child = child;
    if (task.cancelled) void quiesceTaskProcessGroup(task);
  };
  task.throwIfCancelled = (message = "Teacher action was cancelled.") => {
    if (task.cancelled) throw new Error(task.cancelReason || message);
  };
  task.release = async () => {
    if (task.released) return;
    task.released = true;
    if (task.markerOwned) {
      await clearActiveTeacherMarker().catch((error) => {
        console.error(`Could not clear the active teacher marker: ${error.message}`);
      });
      task.markerOwned = false;
    }
    if (activeTask === task) activeTask = null;
    resolveSettled();
  };
  task.endResponse = () => {
    task.responseEnding = true;
    if (response.headersSent && !response.destroyed && !response.writableEnded) response.end();
  };
  return task;
}

async function claimOperationTask(request, response, details) {
  while (true) {
    const running = activeTask;
    if (!running) {
      const task = reserveTeacherTask(request, response, details);
      activeTask = task;
      try {
        await writeActiveTeacherMarker(task);
        task.markerOwned = true;
      } catch (error) {
        await task.release();
        throw error;
      }
      return task;
    }
    if (running.operationId !== details.operationId) {
      sendJson(response, 409, { error: "Another teacher action is already running." });
      return null;
    }
    await running.settled;
    if (teacherRequestEndedEarly(request, response)) return null;
  }
}

async function waitForTeacherProcess(child, task, { terminateProcessGroup = true } = {}) {
  let settleProcess;
  const processResult = new Promise((resolve) => { settleProcess = resolve; });
  child.once("error", (error) => settleProcess({ error }));
  child.once("close", (code, signal) => settleProcess({ code, signal }));
  if (terminateProcessGroup) child.once("exit", () => { void quiesceTaskProcessGroup(task); });

  const result = await Promise.race([
    processResult,
    task.cancelledPromise.then(async () => {
      if (terminateProcessGroup) await quiesceTaskProcessGroup(task);
      return { cancelled: true };
    }),
  ]);
  if (terminateProcessGroup) await quiesceTaskProcessGroup(task);
  return result;
}

export function launchToken(value = process.env.MARGIN_SESSION_TOKEN) {
  // Native owns this value. The random fallback keeps direct `node app/server.mjs`
  // usable during development, while every API request still requires it.
  return typeof value === "string" && value.length > 0 ? value : randomBytes(32).toString("base64url");
}

export function launchReadyLine(host, port, contentOrigin, sessionToken = "") {
  const url = new URL(`http://${host}:${port}/`);
  url.searchParams.set("contentOrigin", contentOrigin);
  if (sessionToken) url.searchParams.set("session", sessionToken);
  return `MARGIN_READY ${url.href}`;
}

export function startupExitStatus(error) {
  // EX_TEMPFAIL gives the native shell a stable, non-private signal that the
  // selected library is healthy but already owned by another Margin process.
  return error?.code === "MARGIN_LIBRARY_LOCKED" ? 75 : 1;
}

function isLoopbackHost(value) {
  try {
    const hostname = new URL(`http://${value}`).hostname;
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function requestHasLoopbackHost(request) {
  return typeof request.headers.host === "string" && isLoopbackHost(request.headers.host);
}

function tokenMatches(request, token) {
  const supplied = request.headers["x-margin-session"] || "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(Array.isArray(supplied) ? supplied[0] : supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export { providerEnvironment };

function libraryScopedSetting(key) {
  return key === "margin:pending-operations" || key === "margin:course" || key.startsWith("margin:document:");
}

async function librarySettingsFile() {
  const canonicalRoot = await realpath(WORKSPACE_ROOT);
  const libraryId = createHash("sha256").update(canonicalRoot).digest("hex");
  return path.join(STATE_ROOT, "libraries", libraryId, "settings.json");
}

async function readSettingsFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) return {};
    const parsed = JSON.parse(await readFile(filename, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeSettingsFile(filename, value) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.settings-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
    return value;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readSettings() {
  const globalFile = path.join(STATE_ROOT, "settings.json");
  const libraryFile = await librarySettingsFile();
  const [globalSettings, librarySettings] = await Promise.all([
    readSettingsFile(globalFile),
    readSettingsFile(libraryFile),
  ]);
  const legacyEntries = Object.entries(globalSettings).filter(([key]) => libraryScopedSetting(key));
  if (legacyEntries.length) {
    const migratedLibrary = { ...Object.fromEntries(legacyEntries), ...librarySettings };
    const migratedGlobal = Object.fromEntries(
      Object.entries(globalSettings).filter(([key]) => !libraryScopedSetting(key)),
    );
    await writeSettingsFile(libraryFile, migratedLibrary);
    await writeSettingsFile(globalFile, migratedGlobal);
    return { ...migratedGlobal, ...migratedLibrary };
  }
  return { ...globalSettings, ...librarySettings };
}

async function writeSetting(key, value) {
  const filename = libraryScopedSetting(key)
    ? await librarySettingsFile()
    : path.join(STATE_ROOT, "settings.json");
  const settings = await readSettingsFile(filename);
  settings[key] = value;
  await writeSettingsFile(filename, settings);
  return readSettings();
}

function activeTeacherDetails(task) {
  return {
    version: 1,
    operationId: task.operationId,
    action: task.action,
    provider: task.provider,
    courseId: task.courseId || "",
    chapterId: task.chapterId || "",
    lesson: task.lesson || "",
    startedAt: task.startedAt,
    notice: task.guardNotice || "",
  };
}

async function writeActiveTeacherMarker(task) {
  await mkdir(STATE_ROOT, { recursive: true });
  const temporary = path.join(STATE_ROOT, `.active-teacher-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(activeTeacherDetails(task), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, ACTIVE_TEACHER_TASK_FILE);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function clearActiveTeacherMarker() {
  await unlink(ACTIVE_TEACHER_TASK_FILE).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function readProviderIcon(provider) {
  const filename = path.join(STATE_ROOT, "provider-icons", `${provider}.png`);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return "";
    const data = await readFile(filename);
    const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
    if (data.length < pngSignature.length || !data.subarray(0, pngSignature.length).equals(pngSignature)) return "";
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function mutateAnnotations(task) {
  const queued = annotationMutation.then(task, task);
  annotationMutation = queued.then(() => undefined, () => undefined);
  return queued;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request, limit = BODY_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw Object.assign(new Error("The request body must be valid JSON"), { status: 400, cause: error });
  }
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!requestHasLoopbackHost(request)) return false;
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const destination = new URL(`http://${request.headers.host || `${HOST}:${PORT}`}`);
    return isLoopbackHost(source.host) && source.origin === destination.origin;
  } catch {
    return false;
  }
}

function publicPath(relativePath) {
  const target = path.resolve(PUBLIC_DIR, relativePath);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) throw new Error("Invalid public path");
  return target;
}

async function serveFile(response, filename) {
  const info = await stat(filename);
  if (!info.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
  const type = MIME.get(path.extname(filename).toLowerCase()) || "application/octet-stream";
  // Interface assets are tiny loopback responses. no-store keeps a restarted or
  // updated app from pairing a fresh server with stale cached scripts.
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(await readFile(filename));
}

function contentSecurityPolicy(contentOrigin, frameAncestor = "'none'") {
  return `sandbox allow-scripts; default-src 'none'; base-uri 'none'; object-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors ${frameAncestor}; img-src ${contentOrigin} data: blob:; media-src ${contentOrigin} data: blob:; font-src ${contentOrigin} data: blob:; style-src ${contentOrigin} 'unsafe-inline'; script-src ${contentOrigin} 'unsafe-inline'`;
}

function lessonBridge(nonce, courseId) {
  // This runs in an opaque-origin iframe. It deliberately exposes only reader affordances,
  // never the application API or its launch session.
  return `<script>(function(){
const nonce=${JSON.stringify(nonce)}, course=${JSON.stringify(courseId)};
const send=(type,value={})=>parent.postMessage({marginBridge:nonce,type,...value},'*');
const nodePath=(node)=>{const p=[];for(let n=node;n&&n!==document.body;n=n.parentNode){if(!n.parentNode)return [];p.unshift([...n.parentNode.childNodes].indexOf(n));}return p;};
const nodeAt=(p)=>Array.isArray(p)?p.reduce((n,i)=>n&&n.childNodes[i],document.body):null;
const textNodes=()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const out=[];while(w.nextNode())out.push(w.currentNode);return out;};
const boundaryAt=(nodes,offset)=>{let cursor=0;for(const node of nodes){const next=cursor+node.data.length;if(offset<=next)return {node,offset:Math.max(0,offset-cursor)};cursor=next;}return null;};
const resolve=(a)=>{if(!a||!a.quote)return null;try{const s=nodeAt(a.anchor&&a.anchor.startPath),e=nodeAt(a.anchor&&a.anchor.endPath);if(s&&e){const r=document.createRange();r.setStart(s,a.anchor.startOffset);r.setEnd(e,a.anchor.endOffset);if(r.toString()===a.quote)return r;}}catch{}const nodes=textNodes(),full=nodes.map(n=>n.data).join('');const at=full.indexOf(a.quote);if(at<0||full.indexOf(a.quote,at+1)>=0)return null;const s=boundaryAt(nodes,at),e=boundaryAt(nodes,at+a.quote.length);if(!s||!e)return null;const r=document.createRange();r.setStart(s.node,s.offset);r.setEnd(e.node,e.offset);return r;};
let highlight;
const paint=(annotations)=>{document.querySelectorAll('.learn-annotation-block').forEach(e=>e.classList.remove('learn-annotation-block'));const ranges=(annotations||[]).map(resolve).filter(Boolean);if(CSS.highlights&&window.Highlight){CSS.highlights.delete('margin-message');if(ranges.length)CSS.highlights.set('margin-message',new Highlight(...ranges));}else ranges.forEach(r=>r.startContainer.parentElement?.closest('p,h1,h2,h3,h4,li,pre,figure,table')?.classList.add('learn-annotation-block'));};
const style=document.createElement('style');style.textContent='body{zoom:var(--margin-reader-scale,1)!important}.comments{display:none!important}::highlight(margin-message){background:rgba(232,200,106,.62);text-decoration:underline 1px rgba(154,52,31,.5)}.learn-annotation-block{box-shadow:inset 4px 0 0 rgba(232,200,106,.92)}.learn-annotation-focus{outline:2px solid #9a341f}';document.head.append(style);
window.addEventListener('message',(event)=>{const d=event.data;if(event.source!==parent||!d||d.marginBridge!==nonce)return;if(d.type==='paint')paint(d.annotations);if(d.type==='scale')document.documentElement.style.setProperty('--margin-reader-scale',String(d.scale));if(d.type==='focus'){const r=resolve(d.annotation);const el=r&&r.startContainer.parentElement;if(!el){send('focus-missed');return;}el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('learn-annotation-focus');setTimeout(()=>el.classList.remove('learn-annotation-focus'),1600);}});
document.addEventListener('pointerup',()=>setTimeout(()=>{const s=getSelection();if(!s||s.rangeCount!==1||s.isCollapsed)return send('selection-clear');const r=s.getRangeAt(0);if(!document.body.contains(r.commonAncestorContainer))return;const q=r.toString();if(!q.trim())return send('selection-clear');const rect=r.getBoundingClientRect(),all=document.body.textContent||'',start=all.indexOf(q);send('selection',{quote:q,anchor:{prefix:start<0?'':all.slice(Math.max(0,start-160),start),suffix:start<0?'':all.slice(start+q.length,start+q.length+160),startPath:nodePath(r.startContainer),startOffset:r.startOffset,endPath:nodePath(r.endContainer),endOffset:r.endOffset},rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}});},0));
document.addEventListener('click',(event)=>{const a=event.target.closest('a[href]');if(!a)return;let u;try{u=new URL(a.href,location.href)}catch{return}const prefix='/course/'+encodeURIComponent(course)+'/';if(u.pathname.startsWith(prefix)){event.preventDefault();send('navigate',{path:decodeURIComponent(u.pathname.slice(prefix.length)),hash:u.hash});}});
addEventListener('scroll',()=>send('selection-clear'),{passive:true});send('loaded');
})();</script>`;
}

function injectLessonBridge(source, nonce, courseId) {
  const bridge = lessonBridge(nonce, courseId);
  return /<\/head\s*>/i.test(source) ? source.replace(/<\/head\s*>/i, `${bridge}</head>`) : `${bridge}${source}`;
}

async function serveContentHtml(response, source, nonce, courseId, contentOrigin, frameAncestor) {
  const content = Buffer.from(injectLessonBridge(source.toString("utf8"), nonce, courseId));
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Content-Length": content.length,
    "Cache-Control": "no-store", "Content-Security-Policy": contentSecurityPolicy(contentOrigin, frameAncestor), "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

async function handleContentRequest(request, response, { appOrigin = "" } = {}) {
  if (!requestHasLoopbackHost(request)) { sendJson(response, 403, { error: "Loopback only" }); return; }
  const contentOrigin = new URL(`http://${request.headers.host}`).origin;
  const url = new URL(request.url, contentOrigin);
  const pathname = decodeURIComponent(url.pathname);
  let frameAncestor = "'none'";
  try {
    const parent = new URL(url.searchParams.get("parent") || "");
    if (parent.origin === appOrigin && isLoopbackHost(parent.host)) frameAncestor = parent.origin;
  } catch {
    // Documents without a valid loopback parent remain unframeable.
  }
  const match = pathname.match(/^\/course\/([^/]+)\/(lessons\/[^/]+\.html|reference\/[^/]+\.html|assets\/.+)$/);
  if (request.method === "GET" && match) {
    const courseRoot = await verifiedCourseRoot(match[1]);
    const filename = await confinedRealPath(courseRoot, safeCoursePath(WORKSPACE_ROOT, match[1], match[2]));
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    if (match[2].endsWith(".html")) await serveContentHtml(response, await readFile(filename), url.searchParams.get("bridge") || "", match[1], contentOrigin, frameAncestor);
    else {
      const type = MIME.get(path.extname(filename).toLowerCase()) || "application/octet-stream";
      response.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Cache-Control": "no-store", "Content-Security-Policy": contentSecurityPolicy(contentOrigin), "X-Content-Type-Options": "nosniff" });
      response.end(await readFile(filename));
    }
    return;
  }
  const history = pathname.match(/^\/history\/([^/]+)$/);
  if (request.method === "GET" && history) {
    const courseRoot = await verifiedCourseRoot(history[1]);
    const lesson = url.searchParams.get("lesson") || "";
    const commit = url.searchParams.get("commit") || "";
    if (!lesson || !commit) throw new Error("Lecture and commit are required");
    await serveContentHtml(response, await readLectureVersionContent(courseRoot, lesson, commit), url.searchParams.get("bridge") || "", history[1], contentOrigin, frameAncestor);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

export function createContentServer({ appOrigin = "" } = {}) {
  let allowedAppOrigin = appOrigin;
  const server = createServer((request, response) => handleContentRequest(request, response, { appOrigin: allowedAppOrigin }).catch((error) => {
    sendJson(response, error?.code === "ENOENT" ? 404 : 400, { error: error.message || "Unexpected error" });
  }));
  server.setAppOrigin = (value) => { allowedAppOrigin = value; };
  return server;
}

async function listLessonPaths(courseRoot) {
  const entries = await readdir(path.join(courseRoot, "lessons"), { withFileTypes: true });
  if (entries.some((item) => !item.isFile() || !item.name.endsWith(".html"))) {
    throw new Error("The lessons directory may contain only regular HTML lesson files");
  }
  return entries.map((item) => `lessons/${item.name}`).sort();
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function confinedRealPath(root, filename) {
  const candidate = await realpath(filename);
  if (!isWithin(root, candidate)) throw new Error("Path escapes the course workspace");
  return candidate;
}

async function verifiedCourseRoot(courseId) {
  const workspaceRoot = await realpath(WORKSPACE_ROOT);
  const courseRoot = await realpath(safeCoursePath(WORKSPACE_ROOT, assertCourseId(courseId)));
  if (!isWithin(workspaceRoot, courseRoot)) throw new Error("Unknown teaching workspace");
  const mission = await confinedRealPath(courseRoot, path.join(courseRoot, "MISSION.md")).catch(() => "");
  if (!mission || !(await fileExists(mission))) throw new Error("Unknown teaching workspace");
  try {
    const lessons = await confinedRealPath(courseRoot, path.join(courseRoot, "lessons"));
    if (!(await stat(lessons)).isDirectory()) throw new Error("Unknown teaching workspace");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Unknown teaching workspace");
    throw error;
  }
  return courseRoot;
}

async function protectedCourseIds() {
  const { courses, diagnostics } = await discoverCoursesDetailed(WORKSPACE_ROOT);
  const ids = new Set();
  for (const candidate of [...courses, ...diagnostics]) {
    try {
      ids.add(assertCourseId(candidate.id));
    } catch {
      // Non-course application directories and malformed names are outside the
      // course integrity boundary. Valid course ids, including unreadable
      // courses reported as diagnostics, remain protected.
    }
  }
  return ids;
}

async function beginOtherCourseGuard(selectedCourseId = "") {
  const initialIds = await protectedCourseIds();
  const transactions = [];
  const skipped = [];
  for (const courseId of [...initialIds].sort()) {
    if (courseId === selectedCourseId) continue;
    const courseRoot = path.join(WORKSPACE_ROOT, courseId);
    try {
      transactions.push({
        courseId,
        transaction: await beginCourseTransaction(WORKSPACE_ROOT, courseId, courseRoot, { preserveDisplaced: true }),
      });
    } catch (error) {
      skipped.push({ courseId, reason: boundedEventText(error.message, 300) });
    }
  }
  return { selectedCourseId, initialIds, transactions, skipped, closing: false, closed: false };
}

async function refreshOtherCourseGuardEntry(guard, courseId, mutation) {
  const entry = guard && !guard.closing && !guard.closed
    ? guard.transactions.find((item) => item.courseId === courseId)
    : null;
  if (!entry) return mutation();
  if (!(await courseTransactionMatchesSnapshot(entry.transaction))) {
    throw operationConflict("This course changed while the teacher is working; try again after the action finishes.");
  }
  const result = await mutation();
  // Fold the app's own write into the protected snapshot so the guard does not
  // later mistake it for teacher tampering and revert it.
  const previous = entry.transaction;
  entry.transaction = await beginCourseTransaction(WORKSPACE_ROOT, courseId, path.join(WORKSPACE_ROOT, courseId), {
    preserveDisplaced: true,
  });
  await commitCourseTransaction(previous);
  return result;
}

function annotationsLockedByActiveTask(courseId) {
  return Boolean(activeTask && activeTask.courseId === courseId);
}

function guardedAnnotationMutation(courseId, mutation) {
  return mutateAnnotations(() => refreshOtherCourseGuardEntry(activeTask?.otherCourseGuard, courseId, mutation));
}

function otherCourseGuardNotice(guard) {
  if (!guard?.skipped?.length) return "";
  const courses = guard.skipped.map((entry) => `${entry.courseId} (${entry.reason})`).join(", ");
  const target = guard.skipped.length === 1 ? "that course" : "those courses";
  return `Margin could not transactionally protect ${courses}. Teaching will continue, but changes to ${target} cannot be restored automatically.`;
}

function otherCourseChangeNotice(result) {
  const courseIds = [
    ...result.changed.map((entry) => entry.courseId),
    ...result.quarantined.map((entry) => entry.courseId),
  ].sort();
  if (!courseIds.length) return "";
  const archives = [
    ...result.changed.map((entry) => entry.archive),
    ...result.quarantined.map((entry) => entry.archive),
  ].filter(Boolean);
  const archiveText = archives.length ? ` Recoverable changed copies are in ${archives.join(", ")}.` : "";
  return `Another recognized course changed while teaching was running (${courseIds.join(", ")}). Margin restored its protected state.${archiveText}`;
}

async function closeOtherCourseGuard(guard) {
  if (!guard || guard.closed) return { changed: [], quarantined: [] };
  guard.closing = true;
  const changed = [];
  const quarantined = [];
  const errors = [];
  const remainingTransactions = [];

  const currentIds = await protectedCourseIds();
  const addedIds = [...currentIds]
    .filter((courseId) => !guard.initialIds.has(courseId) && courseId !== guard.selectedCourseId)
    .sort();
  for (const courseId of addedIds) {
    try {
      const result = await moveCourseToTrash(WORKSPACE_ROOT, courseId);
      quarantined.push({ courseId, archive: result.archive });
    } catch (error) {
      errors.push(error);
    }
  }

  for (const entry of guard.transactions) {
    try {
      if (await courseTransactionMatchesSnapshot(entry.transaction)) {
        await commitCourseTransaction(entry.transaction);
      } else {
        const rollback = await rollbackCourseTransaction(entry.transaction);
        changed.push({ courseId: entry.courseId, archive: rollback.archived || "" });
      }
    } catch (error) {
      errors.push(error);
      remainingTransactions.push(entry);
    }
  }
  guard.transactions = remainingTransactions;
  guard.closed = errors.length === 0;

  if (errors.length) throw new AggregateError(errors, "Could not close the other-course integrity guard");
  return { changed, quarantined, skipped: guard.skipped };
}

async function regularDirectoryIdentity(directory, label) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`The teacher replaced the ${label} directory`);
  const canonical = await realpath(directory);
  if (canonical !== directory) throw new Error(`The teacher redirected the ${label} directory`);
  return { path: canonical, device: String(info.dev), inode: String(info.ino) };
}

export async function captureCourseIdentity(courseRoot) {
  const root = await realpath(path.resolve(courseRoot));
  return {
    root: await regularDirectoryIdentity(root, "course"),
    lessons: await regularDirectoryIdentity(path.join(root, "lessons"), "lessons"),
  };
}

export async function assertCourseIdentity(courseRoot, expected) {
  if (!expected?.root || !expected?.lessons) throw new Error("Course identity is unavailable");
  const current = await captureCourseIdentity(courseRoot);
  for (const key of ["root", "lessons"]) {
    if (current[key].path !== expected[key].path
      || current[key].device !== expected[key].device
      || current[key].inode !== expected[key].inode) {
      throw new Error(`The teacher replaced the ${key === "root" ? "course" : "lessons"} directory`);
    }
  }
  return true;
}

async function snapshotDirectoryContents(directory, label) {
  const entries = new Map();
  const walk = async (current, relative = "") => {
    const children = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const filename = path.join(current, child.name);
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error(`Invalid ${label}: symbolic links are not allowed`);
      if (info.isDirectory()) {
        entries.set(childRelative, { kind: "directory" });
        await walk(filename, childRelative);
      } else if (info.isFile()) {
        const content = await readFile(filename);
        entries.set(childRelative, {
          kind: "file",
          size: content.length,
          hash: createHash("sha256").update(content).digest("hex"),
          content,
        });
      } else {
        throw new Error(`Invalid ${label}: only regular files and directories are allowed`);
      }
    }
  };
  await walk(directory);
  return entries;
}

export async function snapshotAppOwnedLearnerState(courseRoot) {
  const directory = path.join(path.resolve(courseRoot), ".learn");
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invalid app-owned learner state directory");
    return {
      exists: true,
      identity: { device: String(info.dev), inode: String(info.ino) },
      entries: await snapshotDirectoryContents(directory, "app-owned learner state"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, identity: null, entries: new Map() };
    throw error;
  }
}

export async function appOwnedLearnerStateMatches(courseRoot, snapshot) {
  try {
    const current = await snapshotAppOwnedLearnerState(courseRoot);
    if (current.exists !== snapshot.exists) return false;
    if (!current.exists) return true;
    if (current.identity.device !== snapshot.identity.device || current.identity.inode !== snapshot.identity.inode) return false;
    if (current.entries.size !== snapshot.entries.size) return false;
    for (const [name, expected] of snapshot.entries) {
      const actual = current.entries.get(name);
      if (!actual || actual.kind !== expected.kind) return false;
      if (expected.kind === "file" && (actual.size !== expected.size || actual.hash !== expected.hash)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function restoreAppOwnedLearnerState(courseRoot, snapshot, courseIdentity) {
  await assertCourseIdentity(courseRoot, courseIdentity);
  const root = path.resolve(courseRoot);
  const learn = path.join(root, ".learn");
  const libraryRoot = path.dirname(root);
  const nonce = randomUUID();
  const quarantine = path.join(libraryRoot, `.margin-learn-quarantine-${nonce}`);
  let staging = "";

  if (snapshot.exists) {
    staging = path.join(root, `.learn-restore-${nonce}`);
    await mkdir(staging, { mode: 0o700 });
    const directories = [...snapshot.entries]
      .filter(([, entry]) => entry.kind === "directory")
      .map(([name]) => name)
      .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
    for (const relative of directories) await mkdir(path.join(staging, relative));
    for (const [relative, entry] of snapshot.entries) {
      if (entry.kind === "file") await writeFile(path.join(staging, relative), entry.content, { flag: "wx" });
    }
  }

  await assertCourseIdentity(courseRoot, courseIdentity);
  let movedCurrent = false;
  try {
    await lstat(learn);
    await rename(learn, quarantine);
    movedCurrent = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    if (snapshot.exists) await rename(staging, learn);
  } catch (error) {
    if (movedCurrent) await rename(quarantine, learn).catch(() => {});
    throw error;
  }
  if (movedCurrent) await rm(quarantine, { recursive: true, force: true });
  return { restored: true, quarantine: movedCurrent ? quarantine : "" };
}

async function snapshotLessons(courseRoot) {
  const snapshot = new Map();
  for (const lesson of await listLessonPaths(courseRoot)) {
    snapshot.set(lesson, await readFile(path.join(courseRoot, lesson)));
  }
  return snapshot;
}

async function restoreLessons(courseRoot, snapshot, identity) {
  await assertCourseIdentity(courseRoot, identity);
  const lessonsDirectory = path.join(courseRoot, "lessons");
  const entries = await readdir(lessonsDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("The lessons directory contains an unsafe entry; automatic cleanup stopped");
  }
  for (const entry of entries) await unlink(path.join(lessonsDirectory, entry.name));
  for (const [lesson, contents] of snapshot) await writeFile(path.join(courseRoot, lesson), contents);
}

async function changedLessons(courseRoot, snapshot) {
  const current = await listLessonPaths(courseRoot);
  const created = current.filter((lesson) => !snapshot.has(lesson));
  const removed = [...snapshot.keys()].filter((lesson) => !current.includes(lesson));
  const modified = [];
  for (const lesson of current.filter((item) => snapshot.has(item))) {
    const before = snapshot.get(lesson);
    const after = await readFile(path.join(courseRoot, lesson));
    if (!before.equals(after)) modified.push(lesson);
  }
  return { current, created, removed, modified };
}

function nextLessonNumber(existingLessons) {
  const prefixes = existingLessons.map((lesson) => path.basename(lesson).match(/^(\d+)/)?.[1]).filter(Boolean);
  if (!prefixes.length) return "0001";
  const width = Math.max(4, ...prefixes.map((prefix) => prefix.length));
  return String(Math.max(...prefixes.map(Number)) + 1).padStart(width, "0");
}

export function boundedEventText(value, limit = RUN_EVENT_TEXT_LIMIT) {
  const text = String(value || "");
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const ellipsis = Buffer.from("…");
  let end = Math.max(0, limit - ellipsis.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function writeStreamEvent(response, event) {
  const bounded = typeof event.text === "string" ? { ...event, text: boundedEventText(event.text) } : event;
  if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(bounded)}\n`);
}

function attachLineParser(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
  });
}

export function teacherRequestEndedEarly(request, response) {
  return Boolean(request.aborted || !request.complete || response.destroyed);
}

export async function courseManifestMatchesSnapshot(courseRoot, snapshot) {
  const filename = path.join(courseRoot, "COURSE.json");
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    return (await readFile(filename, "utf8")) === snapshot;
  } catch (error) {
    if (error?.code === "ENOENT") return snapshot === "";
    throw error;
  }
}

export async function restoreCourseManifestSnapshot(courseRoot, snapshot) {
  if (await courseManifestMatchesSnapshot(courseRoot, snapshot)) return;
  const filename = path.join(courseRoot, "COURSE.json");
  if (snapshot) await restoreCourseManifest(courseRoot, snapshot);
  else {
    try {
      const info = await lstat(filename);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Unsafe COURSE.json cleanup stopped");
      await unlink(filename);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function visibleLectureText(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:[a-z][a-z0-9]+|#\d+|#x[a-f0-9]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function validateLectureArtifact(courseRoot, lesson, {
  requiredNumber = "",
  requireDashCase = false,
} = {}) {
  const normalizedLesson = assertLessonPath(lesson);
  if (requireDashCase) {
    if (!/^\d{4,}$/.test(requiredNumber)) throw new Error("A numbered lecture filename is required");
    const escapedNumber = requiredNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expected = new RegExp(`^lessons/${escapedNumber}-[a-z0-9]+(?:-[a-z0-9]+)*\\.html$`);
    if (!expected.test(normalizedLesson)) {
      throw new Error(`The lecture must be named lessons/${requiredNumber}-<lowercase-dash-case-name>.html`);
    }
  }

  const source = await readFile(path.join(courseRoot, normalizedLesson), "utf8");
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, " ");
  if (!withoutComments.trim()) throw new Error("The lecture is empty or contains only comments");
  const heading = withoutComments.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i);
  if (!heading || !visibleLectureText(heading[2])) throw new Error("The lecture must contain an HTML heading");
  if (!/\bdata-learn-block(?:\s*=|\s|>)/i.test(withoutComments)) {
    throw new Error("The lecture must contain at least one data-learn-block");
  }
  const visibleText = visibleLectureText(withoutComments);
  const placeholderOnly = /^(?:todo|tbd|placeholder|coming soon|lecture coming soon)[.!\s-]*$/i.test(visibleText);
  if (placeholderOnly || visibleText.length < 40) {
    throw new Error("The lecture must contain substantive content, not a placeholder");
  }
  return normalizedLesson;
}

export async function validateFirstLectureDraft(courseRoot, {
  courseIdentity,
  manifestSnapshot,
  learnerStateSnapshot,
} = {}) {
  await assertCourseIdentity(courseRoot, courseIdentity);
  if (!(await courseManifestMatchesSnapshot(courseRoot, manifestSnapshot))) {
    throw new Error("The teacher modified app-owned COURSE.json");
  }
  if (!(await appOwnedLearnerStateMatches(courseRoot, learnerStateSnapshot))) {
    throw new Error("The teacher modified app-owned .learn state");
  }
  const changes = await changedLessons(courseRoot, new Map());
  if (changes.created.length !== 1 || changes.removed.length || changes.modified.length) {
    throw new Error("The teacher did not create exactly one first lecture");
  }
  const lesson = changes.created[0];
  return validateLectureArtifact(courseRoot, lesson, { requiredNumber: "0001", requireDashCase: true });
}

async function rollbackTeacherMutation({
  courseRoot,
  courseIdentity,
  lessonSnapshot,
  manifestSnapshot,
  learnerStateSnapshot,
  lectureHistorySnapshot,
}) {
  const failures = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(new Error(`${label}: ${error.message}`, { cause: error }));
    }
  };

  if (courseRoot && lessonSnapshot) {
    await attempt("lessons", () => restoreLessons(courseRoot, lessonSnapshot, courseIdentity));
  }
  if (courseRoot && manifestSnapshot !== null) {
    await attempt("COURSE.json", async () => {
      await assertCourseIdentity(courseRoot, courseIdentity);
      await restoreCourseManifestSnapshot(courseRoot, manifestSnapshot);
    });
  }
  if (courseRoot && learnerStateSnapshot) {
    await attempt(".learn", async () => {
      if (!(await appOwnedLearnerStateMatches(courseRoot, learnerStateSnapshot))) {
        await restoreAppOwnedLearnerState(courseRoot, learnerStateSnapshot, courseIdentity);
      }
    });
  }
  if (courseRoot && lectureHistorySnapshot) {
    await attempt("lecture history", async () => {
      await assertCourseIdentity(courseRoot, courseIdentity);
      if (!(await lectureHistoryStoreMatches(courseRoot, lectureHistorySnapshot))) {
        await restoreLectureHistoryStore(courseRoot, lectureHistorySnapshot);
      }
    });
  }
  if (failures.length) {
    throw new AggregateError(failures, `Course rollback failed: ${failures.map((error) => error.message).join("; ")}`);
  }
}

export async function consumeProviderUpdateRequest(request) {
  await readJson(request);
}

function providerName(provider) {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function operationConflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function operationCompleteEvent(found) {
  const operationAction = found.commit.operationAction;
  const text = operationAction === "course-create"
    ? "Course and first lecture created."
    : operationAction === "revise" ? "Lecture revised." : "Next lecture created.";
  return {
    type: "complete",
    operationId: found.commit.operationId,
    ...(operationAction === "course-create" ? { course: found.course } : {}),
    lesson: found.lesson,
    lectureVersion: found.commit,
    text,
  };
}

async function findWorkspaceOperation(id) {
  const { courses } = await discoverCoursesDetailed(WORKSPACE_ROOT);
  const courseById = new Map(courses.map((course) => [course.id, course]));
  const entries = await readdir(WORKSPACE_ROOT, { withFileTypes: true });
  let found = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      assertCourseId(entry.name);
    } catch {
      // The learning library may also contain the local app bundle or other
      // user files. They are not course candidates for operation recovery.
      continue;
    }
    let courseRoot;
    try {
      courseRoot = await verifiedCourseRoot(entry.name);
    } catch (error) {
      if (error.message === "Unknown teaching workspace") continue;
      throw error;
    }
    const operation = await findLectureOperation(courseRoot, id);
    if (!operation) continue;
    if (found) throw new Error("Teacher operation history is ambiguous");
    found = { ...operation, course: courseById.get(entry.name) || entry.name };
  }
  return found;
}

function assertOperationReplay(found, expectedAction, expectedHash) {
  if (!found) return null;
  if (found.commit.operationAction !== expectedAction || found.commit.requestHash !== expectedHash) {
    throw operationConflict("This teacher operation id belongs to a different request");
  }
  return operationCompleteEvent(found);
}

function streamOperationComplete(response, event) {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeStreamEvent(response, event);
  if (!response.destroyed && !response.writableEnded) response.end();
}

async function operationStatus(id, courseId = "") {
  if (activeTask) {
    if (activeTask.operationId === id) {
      if (activeTask.completeEvent) return { status: "complete", event: activeTask.completeEvent };
      return { status: "running", task: activeTeacherDetails(activeTask) };
    }
    return { status: "deferred", task: activeTeacherDetails(activeTask) };
  }
  let courseRoot = "";
  if (courseId) {
    try {
      courseRoot = await verifiedCourseRoot(assertCourseId(courseId));
    } catch (error) {
      // A receipt whose course was deleted or is unreadable must still resolve,
      // otherwise it can never be cleared. Fall back to the workspace search.
      if (error?.code !== "ENOENT" && error.message !== "Unknown teaching workspace") throw error;
    }
  }
  let found;
  if (courseRoot) {
    found = await findLectureOperation(courseRoot, id);
  } else {
    await recoverCourseCreationArtifacts(WORKSPACE_ROOT, { operationId: id, archiveIncomplete: false });
    found = await findWorkspaceOperation(id);
  }
  return found
    ? { status: "complete", event: operationCompleteEvent(found) }
    : { status: "unknown" };
}

export function providerUpdateCompletionText(provider, beforeVersion, afterVersion) {
  const before = String(beforeVersion || "").trim();
  const after = String(afterVersion || "").trim();
  if (before && after && before === after) return `${providerName(provider)} is already current (${after}).`;
  if (before && after) return `${providerName(provider)} updated from ${before} to ${after}.`;
  if (after) return `${providerName(provider)} is now ${after}.`;
  return `${providerName(provider)} check and update completed.`;
}

export function providerUpdateFailureText(provider, code, signal, lastOutput = "") {
  const summary = signal
    ? "Update cancelled."
    : `${providerName(provider)} check and update exited with code ${code}.`;
  const detail = boundedEventText(String(lastOutput || "").trim(), 1000);
  return detail ? `${summary} ${detail}` : summary;
}

async function runProviderUpdate(request, response, provider, {
  providerLookup = providerInfo,
  spawnProcess = spawn,
} = {}) {
  if (activeTask) {
    sendJson(response, 409, { error: "Another teacher task is already running." });
    return;
  }
  // Provider-owned installers must not be force-killed through an ordinary UI
  // cancellation or a dropped activity stream. They finish in the background.
  const task = reserveTeacherTask(request, response, { provider, action: "update", cancellable: false });
  activeTask = task;
  let throwAfterCleanup = null;
  try {
    const installed = await providerLookup(provider);
    if (!installed.available) throw new Error(`${provider === "claude" ? "Claude Code" : "Codex"} is not installed`);
    task.throwIfCancelled("Update was cancelled before it started");
    const spec = providerUpdateCommand(provider);

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    writeStreamEvent(response, {
      type: "started",
      text: `Checking and updating ${providerName(provider)}`,
    });

    const child = spawnProcess(spec.command, spec.args, {
      cwd: WORKSPACE_ROOT,
      env: providerEnvironment(),
      detached: process.platform !== "win32",
      // An updater may outlive Margin if the app quits. Inheriting no output
      // pipes prevents a closed parent from sending SIGPIPE into an installer.
      stdio: ["ignore", "ignore", "ignore"],
    });
    task.setChild(child);
    const outcome = await waitForTeacherProcess(child, task, { terminateProcessGroup: false });
    task.throwIfCancelled("Update cancelled.");
    if (outcome.error) throw new Error(`Could not start the update: ${outcome.error.message}`);
    if (outcome.code !== 0) throw new Error(providerUpdateFailureText(provider, outcome.code, outcome.signal));

    const refreshed = await providerLookup(provider, { refresh: true });
    task.throwIfCancelled("Update cancelled.");
    task.responseEnding = true;
    writeStreamEvent(response, {
      type: "complete",
      info: refreshed,
      text: providerUpdateCompletionText(provider, installed.version, refreshed.version),
    });
  } catch (error) {
    if (response.headersSent) {
      if (!response.destroyed) writeStreamEvent(response, { type: "error", text: error.message });
    } else {
      throwAfterCleanup = error;
    }
  } finally {
    task.endResponse();
    await task.release();
  }
  if (throwAfterCleanup) throw throwAfterCleanup;
}

async function runCourseCreation(request, response, body, {
  providerLookup = providerInfo,
  spawnProcess = spawn,
} = {}) {
  const provider = body.provider === "claude" || body.provider === "codex" ? body.provider : "";
  if (!provider) throw new Error("Choose Claude Code or Codex");
  const operation = createOperationRequest(body, provider, operationId(body.operationId));
  const task = await claimOperationTask(request, response, {
    provider,
    action: "create",
    courseId: "",
    ...operation,
  });
  if (!task) return;
  let draft = null;
  let draftIdentity = null;
  let promoted = null;
  let draftComplete = false;
  let otherCourseGuard = null;
  let throwAfterCleanup = null;
  try {
    const replay = assertOperationReplay(
      await findWorkspaceOperation(operation.operationId),
      "course-create",
      operation.requestHash,
    );
    if (replay) {
      task.cancellable = false;
      task.completeEvent = replay;
      task.responseEnding = true;
      streamOperationComplete(response, replay);
      return;
    }
    const installed = await providerLookup(provider);
    if (!installed.available) throw new Error(`${providerName(provider)} is not available on PATH`);
    if (!installed.compatible || !installed.authenticated) throw new Error(installed.error || "The selected teacher is not ready");
    const providerOptions = normalizeProviderOptions(provider, { model: body.model, effort: body.effort }, installed.models);
    task.throwIfCancelled("Course creation was cancelled before it started");

    draft = await createCourseWorkspace(WORKSPACE_ROOT, body);
    task.courseId = draft.id;
    task.courseRoot = draft.root;
    otherCourseGuard = await mutateAnnotations(() => beginOtherCourseGuard());
    task.otherCourseGuard = otherCourseGuard;
    task.guardNotice = otherCourseGuardNotice(otherCourseGuard);
    if (task.guardNotice) console.error(task.guardNotice);
    const courseIdentity = await captureCourseIdentity(draft.root);
    draftIdentity = courseIdentity;
    const structure = await readCourseStructure(draft.root, { allowEmptyChapters: true });
    const chapter = structure.chapters.find((item) => item.id === "foundations");
    if (!chapter || chapter.lectures.length) throw new Error("The course draft must begin with an empty Foundations chapter");
    const manifestSnapshot = structure.manifestText;
    const learnerStateSnapshot = await snapshotAppOwnedLearnerState(draft.root);
    const prompt = buildTeacherPrompt({
      action: "first",
      workspaceRoot: WORKSPACE_ROOT,
      courseRoot: draft.root,
      chapter,
      annotations: [],
      teachSkillPath: TEACH_SKILL_PATH,
      initialRequest: draft.initialRequest,
    });
    const spec = providerCommand(provider, draft.root, WORKSPACE_ROOT, providerOptions);
    task.throwIfCancelled("Course creation was cancelled.");

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    writeStreamEvent(response, {
      type: "started",
      operationId: operation.operationId,
      provider,
      action: "create",
      model: providerOptions.model,
      effort: providerOptions.effort,
      text: `${providerName(provider)} is writing the first lecture`,
    });
    if (task.guardNotice) writeStreamEvent(response, { type: "status", text: task.guardNotice });

    const child = spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: providerEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    task.setChild(child);
    let lastMessage = "";
    let lastDiagnostic = "";
    let terminalState = "pending";

    attachLineParser(child.stdout, (line) => {
      const event = parseProviderLine(provider, line);
      if (!event) return;
      if (event.terminal) terminalState = event.terminal;
      if (event.kind === "summary" || event.kind === "message") lastMessage = event.text;
      if (event.kind === "terminal") return;
      writeStreamEvent(response, { type: event.kind, text: event.text });
    });
    attachLineParser(child.stderr, (line) => {
      const text = line.trim();
      if (text && !text.startsWith("WARNING: proceeding")) lastDiagnostic = boundedEventText(text, 1000);
    });
    let inputError = null;
    child.stdin.once("error", (error) => { inputError = error; });
    child.stdin.end(prompt);
    const outcome = await waitForTeacherProcess(child, task);
    task.throwIfCancelled("Course creation was cancelled.");
    if (outcome.error) throw new Error(`Could not start the teacher: ${outcome.error.message}`);
    if (outcome.code !== 0) {
      const failure = outcome.signal ? "Course creation was cancelled." : `${providerName(provider)} exited with code ${outcome.code}.`;
      throw new Error(lastDiagnostic ? `${failure} ${lastDiagnostic}` : failure);
    }
    if (inputError) throw new Error(`The teacher did not accept its input: ${inputError.message}`);
    if (terminalState !== "success") {
      throw new Error(`${providerName(provider)} ended without confirming a successful turn`);
    }
    const guardResult = await mutateAnnotations(() => closeOtherCourseGuard(otherCourseGuard));
    otherCourseGuard = null;
    task.otherCourseGuard = null;
    const otherCoursesNotice = otherCourseChangeNotice(guardResult);
    if (otherCoursesNotice) writeStreamEvent(response, { type: "status", text: otherCoursesNotice });

    const lesson = await validateFirstLectureDraft(draft.root, {
      courseIdentity,
      manifestSnapshot,
      learnerStateSnapshot,
    });
    task.throwIfCancelled("Course creation was cancelled.");
    await appendLectureToChapter(draft.root, "foundations", lesson, manifestSnapshot);
    task.throwIfCancelled("Course creation was cancelled.");
    task.cancellable = false;
    const lectureVersion = await recordLectureVersion(draft.root, lesson, {
      action: "create",
      provider,
      model: providerOptions.model,
      effort: providerOptions.effort,
      operationId: operation.operationId,
      operationAction: "course-create",
      requestHash: operation.requestHash,
    });
    draftComplete = true;
    task.lesson = lesson;
    const finalStructure = await readCourseStructure(draft.root);
    const referenceEntries = await readdir(path.join(draft.root, "reference"), { withFileTypes: true });
    const course = {
      id: "",
      title: draft.title,
      mission: draft.initialRequest,
      chapters: finalStructure.chapters,
      references: referenceEntries
        .filter((item) => item.isFile() && item.name.endsWith(".html"))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((item) => ({ path: `reference/${item.name}`, title: item.name.replace(/\.html$/, "").replace(/-/g, " ") })),
      annotationCount: 0,
    };
    await assertCourseIdentity(draft.root, courseIdentity);
    task.throwIfCancelled("Course creation was cancelled.");
    promoted = await promoteCourseWorkspace(WORKSPACE_ROOT, draft.root, draft.id);
    course.id = promoted.id;
    task.courseId = promoted.id;
    task.responseEnding = true;
    task.completeEvent = {
      type: "complete",
      operationId: operation.operationId,
      course,
      lesson,
      lectureVersion,
      text: [lastMessage || "Course and first lecture created.", otherCoursesNotice].filter(Boolean).join(" "),
    };
    writeStreamEvent(response, task.completeEvent);
  } catch (error) {
    let text = error.message;
    if (otherCourseGuard) {
      try {
        const guardResult = await mutateAnnotations(() => closeOtherCourseGuard(otherCourseGuard));
        const changeNotice = otherCourseChangeNotice(guardResult);
        if (changeNotice) text += ` ${changeNotice}`;
        otherCourseGuard = null;
      } catch (guardError) {
        text += ` Other-course cleanup also failed: ${guardError.message}`;
      }
    }
    if (!promoted && !draftComplete && draft && draftIdentity) {
      try {
        await assertCourseIdentity(draft.root, draftIdentity);
        if (path.dirname(draft.root) !== WORKSPACE_ROOT || !path.basename(draft.root).startsWith(".margin-course-draft-")) {
          throw new Error("Invalid hidden course draft cleanup path");
        }
        await rm(draft.root, { recursive: true, force: false });
      } catch (cleanupError) {
        text += ` Unfinished course cleanup also failed: ${cleanupError.message}`;
      }
    }
    if (response.headersSent) {
      if (!response.destroyed) writeStreamEvent(response, { type: "error", text });
    } else {
      throwAfterCleanup = Object.assign(new Error(text, { cause: error }), Number.isInteger(error.status) ? { status: error.status } : {});
    }
  } finally {
    task.endResponse();
    await task.release();
  }
  if (throwAfterCleanup) throw throwAfterCleanup;
}

async function runTeacher(request, response, body, {
  providerLookup = providerInfo,
  spawnProcess = spawn,
} = {}) {
  const courseId = assertCourseId(body.course);
  const action = body.action === "revise" || body.action === "next" ? body.action : "";
  if (!action) throw new Error("Unknown teacher action");
  const provider = body.provider === "claude" || body.provider === "codex" ? body.provider : "";
  if (!provider) throw new Error("Choose Claude Code or Codex");
  const lesson = assertLessonPath(body.lesson);
  const chapterId = typeof body.chapter === "string" ? body.chapter : "";
  if (!chapterId) throw new Error("Choose a chapter");
  const operation = teacherOperationRequest(
    body,
    provider,
    action,
    courseId,
    chapterId,
    lesson,
    operationId(body.operationId),
  );
  const task = await claimOperationTask(request, response, {
    provider,
    action,
    courseId,
    chapterId,
    ...operation,
  });
  if (!task) return;
  let providerOptions = null;
  let courseRoot = null;
  let courseIdentity = null;
  let lessonSnapshot = null;
  let manifestSnapshot = null;
  let lectureHistorySnapshot = null;
  let learnerStateSnapshot = null;
  let courseTransaction = null;
  let otherCourseGuard = null;

  const rollback = async () => {
    if (courseTransaction) {
      const transaction = courseTransaction;
      courseTransaction = null;
      await rollbackCourseTransaction(transaction);
      return;
    }
    if (!courseRoot || !courseIdentity) return;
    await rollbackTeacherMutation({
      courseRoot,
      courseIdentity,
      lessonSnapshot,
      manifestSnapshot,
      learnerStateSnapshot,
      lectureHistorySnapshot,
    });
  };
  let throwAfterCleanup = null;

  try {
    courseRoot = await verifiedCourseRoot(courseId);
    const replay = assertOperationReplay(
      await findLectureOperation(courseRoot, operation.operationId),
      action,
      operation.requestHash,
    );
    if (replay) {
      task.cancellable = false;
      task.completeEvent = replay;
      task.responseEnding = true;
      streamOperationComplete(response, replay);
      return;
    }
    const installed = await providerLookup(provider);
    if (!installed.available) throw new Error(`${provider === "claude" ? "Claude Code" : "Codex"} is not available on PATH`);
    if (!installed.compatible || !installed.authenticated) throw new Error(installed.error || "The selected teacher is not ready");
    providerOptions = normalizeProviderOptions(provider, { model: body.model, effort: body.effort }, installed.models);
    courseIdentity = await captureCourseIdentity(courseRoot);
    const lessonFile = await confinedRealPath(courseRoot, path.join(courseRoot, lesson)).catch(() => "");
    if (!lessonFile || !(await fileExists(lessonFile))) throw new Error("The selected lesson no longer exists");

    const structure = await readCourseStructure(courseRoot);
    const chapter = structure.chapters.find((item) => item.id === chapterId);
    if (!chapter) throw new Error("The selected chapter no longer exists");
    if (!chapter.lectures.some((lecture) => lecture.path === lesson)) throw new Error("The selected lecture is not in that chapter");
    if (action === "next" && !structure.manifestText) throw new Error("COURSE.json is required before extending a chapter");
    manifestSnapshot = structure.manifestText;

    await annotationMutation;
    const store = await readAnnotationStore(WORKSPACE_ROOT, courseId);
    const unused = store.annotations.filter((annotation) => !annotation.uses?.length);
    const chapterLectures = new Set(chapter.lectures.map((lecture) => lecture.path));
    const annotations = action === "revise"
      ? unused.filter((annotation) => annotation.lesson === lesson)
      : unused.filter((annotation) => chapterLectures.has(annotation.lesson));
    if (operation.annotationIds) {
      const selectedIds = annotations.map((annotation) => annotation.id).sort();
      if (selectedIds.length !== operation.annotationIds.length
        || selectedIds.some((id, index) => id !== operation.annotationIds[index])) {
        throw operationConflict("The margin messages changed before this teacher action started");
      }
    }
    if (action === "revise" && !annotations.length) {
      throw new Error("Leave a margin message on this lecture before revising it");
    }

    lessonSnapshot = await snapshotLessons(courseRoot);
    await seedLectureHistory(courseRoot, lessonSnapshot);
    lectureHistorySnapshot = await snapshotLectureHistoryStore(courseRoot);
    learnerStateSnapshot = await snapshotAppOwnedLearnerState(courseRoot);
    task.throwIfCancelled("Teacher action was cancelled before it started");
    otherCourseGuard = await mutateAnnotations(() => beginOtherCourseGuard(courseId));
    task.otherCourseGuard = otherCourseGuard;
    task.guardNotice = otherCourseGuardNotice(otherCourseGuard);
    if (task.guardNotice) console.error(task.guardNotice);
    courseTransaction = await beginCourseTransaction(WORKSPACE_ROOT, courseId, courseRoot);
    task.throwIfCancelled("Teacher action was cancelled before it started");

    const prompt = buildTeacherPrompt({
      action,
      workspaceRoot: WORKSPACE_ROOT,
      courseRoot,
      lesson,
      chapter,
      annotations,
      teachSkillPath: TEACH_SKILL_PATH,
    });
    const spec = providerCommand(provider, courseRoot, WORKSPACE_ROOT, providerOptions);
    task.throwIfCancelled("Teacher action was cancelled.");

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    writeStreamEvent(response, {
      type: "started",
      operationId: operation.operationId,
      provider,
      action,
      model: providerOptions.model,
      effort: providerOptions.effort,
      annotationCount: annotations.length,
      text: `${provider === "claude" ? "Claude Code" : "Codex"} is ${action === "revise" ? "revising this lecture" : "writing the next lecture"}`,
    });
    if (task.guardNotice) writeStreamEvent(response, { type: "status", text: task.guardNotice });

    const child = spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: providerEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    task.setChild(child);
    let lastMessage = "";
    let lastDiagnostic = "";
    let terminalState = "pending";

    const handleStdoutLine = (line) => {
      const event = parseProviderLine(provider, line);
      if (!event) return;
      if (event.terminal) terminalState = event.terminal;
      if (event.kind === "summary" || event.kind === "message") lastMessage = event.text;
      if (event.kind === "terminal") return;
      writeStreamEvent(response, { type: event.kind, text: event.text });
    };
    attachLineParser(child.stdout, handleStdoutLine);
    attachLineParser(child.stderr, (line) => {
      const text = line.trim();
      if (text && !text.startsWith("WARNING: proceeding")) {
        lastDiagnostic = boundedEventText(text, 1000);
      }
    });
    let inputError = null;
    child.stdin.once("error", (error) => { inputError = error; });
    child.stdin.end(prompt);
    const outcome = await waitForTeacherProcess(child, task);
    task.throwIfCancelled("Teacher action was cancelled.");
    if (outcome.error) throw new Error(`Could not start the teacher: ${outcome.error.message}`);
    if (outcome.code !== 0) {
      const failure = outcome.signal ? "Teacher action was cancelled." : `${providerName(provider)} exited with code ${outcome.code}.`;
      throw new Error(lastDiagnostic ? `${failure} ${lastDiagnostic}` : failure);
    }
    if (inputError) throw new Error(`The teacher did not accept its input: ${inputError.message}`);
    if (terminalState !== "success") {
      throw new Error(`${providerName(provider)} ended without confirming a successful turn`);
    }
    const guardResult = await mutateAnnotations(() => closeOtherCourseGuard(otherCourseGuard));
    otherCourseGuard = null;
    task.otherCourseGuard = null;
    const otherCoursesNotice = otherCourseChangeNotice(guardResult);
    if (otherCoursesNotice) writeStreamEvent(response, { type: "status", text: otherCoursesNotice });
    await assertCourseIdentity(courseRoot, courseIdentity);
    if (!(await appOwnedLearnerStateMatches(courseRoot, learnerStateSnapshot))) {
      throw new Error("The teacher modified app-owned learner notes, images, or history");
    }
    if (!(await lectureHistoryStoreMatches(courseRoot, lectureHistorySnapshot))) {
      throw new Error("The teacher modified app-owned lecture history");
    }
    if (!(await courseManifestMatchesSnapshot(courseRoot, manifestSnapshot))) {
      throw new Error("The teacher modified app-owned COURSE.json");
    }

    let resultLesson = lesson;
    const changes = await changedLessons(courseRoot, lessonSnapshot);
    if (action === "revise") {
      const exactRevision = !changes.created.length && !changes.removed.length
        && changes.modified.length === 1 && changes.modified[0] === lesson;
      if (!exactRevision) throw new Error("The teacher did not replace exactly the selected lecture");
      await validateLectureArtifact(courseRoot, resultLesson);
    } else {
      const exactNextLesson = changes.created.length === 1 && !changes.removed.length && !changes.modified.length;
      if (!exactNextLesson) throw new Error("The teacher did not create exactly one new lecture without changing existing lectures");
      resultLesson = changes.created[0];
      const requiredNumber = nextLessonNumber([...lessonSnapshot.keys()]);
      await validateLectureArtifact(courseRoot, resultLesson, { requiredNumber, requireDashCase: true });
      task.throwIfCancelled("Teacher action was cancelled.");
      await appendLectureToChapter(courseRoot, chapterId, resultLesson, manifestSnapshot);
    }

    task.throwIfCancelled("Teacher action was cancelled.");
    task.cancellable = false;
    const lectureVersion = await recordLectureVersion(courseRoot, resultLesson, {
      action: action === "next" ? "create" : action,
      provider,
      model: providerOptions.model,
      effort: providerOptions.effort,
      operationId: operation.operationId,
      operationAction: action,
      requestHash: operation.requestHash,
    });
    task.throwIfCancelled("Teacher action was cancelled.");
    await mutateAnnotations(() => markAnnotationsUsed(
      WORKSPACE_ROOT,
      courseId,
      annotations.map((annotation) => annotation.id),
      { action, provider, target: resultLesson },
    ));
    task.throwIfCancelled("Teacher action was cancelled.");
    await commitCourseTransaction(courseTransaction);
    courseTransaction = null;
    lectureHistorySnapshot = null;
    learnerStateSnapshot = null;
    task.responseEnding = true;
    task.completeEvent = {
      type: "complete",
      operationId: operation.operationId,
      lesson: resultLesson,
      lectureVersion,
      text: [
        lastMessage || (action === "revise" ? "Lecture revised." : "Next lecture created."),
        otherCoursesNotice,
      ].filter(Boolean).join(" "),
    };
    writeStreamEvent(response, task.completeEvent);
  } catch (error) {
    let text = error.message;
    if (otherCourseGuard) {
      try {
        const guardResult = await mutateAnnotations(() => closeOtherCourseGuard(otherCourseGuard));
        const changeNotice = otherCourseChangeNotice(guardResult);
        if (changeNotice) text += ` ${changeNotice}`;
        otherCourseGuard = null;
      } catch (guardError) {
        text += ` Other-course cleanup also failed: ${guardError.message}`;
      }
    }
    try {
      await rollback();
    } catch (rollbackError) {
      text += ` Course cleanup also failed: ${rollbackError.message}`;
    }
    if (response.headersSent) {
      if (!response.destroyed) writeStreamEvent(response, { type: "error", text });
    } else {
      throwAfterCleanup = Object.assign(new Error(text, { cause: error }), Number.isInteger(error.status) ? { status: error.status } : {});
    }
  } finally {
    task.endResponse();
    await task.release();
  }
  if (throwAfterCleanup) throw throwAfterCleanup;
}

function isLibraryMutation(request, pathname) {
  // Annotation routes are deliberately absent: notes stay writable while a
  // teacher works, guarded per course in their handlers.
  if (request.method === "POST" && (pathname === "/api/courses" || pathname === "/api/courses/create")) return true;
  if (request.method === "POST" && /^\/api\/courses\/[^/]+\/history\/restore$/.test(pathname)) return true;
  if (request.method !== "DELETE") return false;
  return /^\/api\/courses\/[^/]+(?:\/lectures)?$/.test(pathname);
}

async function handleRequest(request, response, {
  sessionToken,
  contentOrigin = "",
  providerLookup = providerInfo,
  spawnProcess = spawn,
} = {}) {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);

  if (!originAllowed(request)) {
    sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
    return;
  }

  if (pathname.startsWith("/api/")) {
    if (!sessionToken || !tokenMatches(request, sessionToken)) {
      sendJson(response, 401, { error: "A valid Margin session is required" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      sendJson(response, 200, { settings: await readSettings(), contentOrigin });
      return;
    }
    const operationMatch = request.method === "GET" && pathname.match(/^\/api\/operations\/([^/]+)$/);
    if (operationMatch) {
      sendJson(response, 200, await operationStatus(operationId(operationMatch[1]), url.searchParams.get("course") || ""));
      return;
    }
    const operationCancelMatch = request.method === "POST" && pathname.match(/^\/api\/operations\/([^/]+)\/cancel$/);
    if (operationCancelMatch) {
      const id = operationId(operationCancelMatch[1]);
      if (activeTask?.operationId === id) {
        if (activeTask.completeEvent) {
          sendJson(response, 200, { status: "complete", event: activeTask.completeEvent });
          return;
        }
        const cancelled = activeTask.cancel?.("Teacher action was cancelled by the learner.") || false;
        sendJson(response, 202, { ok: cancelled, status: cancelled ? "cancelling" : "finishing" });
        return;
      }
      const status = await operationStatus(id, url.searchParams.get("course") || "");
      sendJson(response, status.status === "unknown" ? 404 : 200, status);
      return;
    }
    if (pathname === "/api/settings" && request.method === "PATCH") {
      const body = await readJson(request);
      if (typeof body.key !== "string" || !body.key.startsWith("margin:")
        || !["string", "number", "boolean"].includes(typeof body.value)) {
        throw new Error("A valid preference is required");
      }
      sendJson(response, 200, { settings: await writeSetting(body.key, body.value) });
      return;
    }
    if (activeTask && isLibraryMutation(request, pathname)) {
      sendJson(response, 409, { error: "Course changes wait until the current action finishes." });
      return;
    }
  }

  if (request.method === "GET" && pathname === "/api/courses") {
    const { courses, diagnostics } = await discoverCoursesDetailed(WORKSPACE_ROOT);
    for (const course of courses) {
      const store = await readAnnotationStore(WORKSPACE_ROOT, course.id);
      course.annotationCount = store.annotations.filter((item) => !item.uses?.length).length;
    }
    sendJson(response, 200, { courses, diagnostics });
    return;
  }

  if (request.method === "POST" && pathname === "/api/courses/create") {
    await runCourseCreation(request, response, await readJson(request), { providerLookup, spawnProcess });
    return;
  }

  if (request.method === "GET" && pathname === "/api/providers") {
    const providers = await Promise.all([providerInfo("claude"), providerInfo("codex")]);
    await Promise.all(providers.map(async (provider) => {
      provider.icon = await readProviderIcon(provider.id);
    }));
    sendJson(response, 200, { providers });
    return;
  }

  const providerUpdateMatch = pathname.match(/^\/api\/providers\/(claude|codex)\/update$/);
  if (providerUpdateMatch && request.method === "POST") {
    await consumeProviderUpdateRequest(request);
    await runProviderUpdate(request, response, providerUpdateMatch[1], { providerLookup, spawnProcess });
    return;
  }

  const lectureDeleteMatch = pathname.match(/^\/api\/courses\/([^/]+)\/lectures$/);
  if (lectureDeleteMatch && request.method === "DELETE") {
    const body = await readJson(request);
    if (activeTask) {
      sendJson(response, 409, { error: "Another course action is already running." });
      return;
    }
    const courseId = assertCourseId(lectureDeleteMatch[1]);
    const reservation = { child: null, action: "delete-lecture", courseId };
    activeTask = reservation;
    let transaction = null;
    try {
      await annotationMutation;
      const courseRoot = await verifiedCourseRoot(courseId);
      transaction = await beginCourseTransaction(WORKSPACE_ROOT, courseId, courseRoot);
      const result = await archiveLecture(courseRoot, body.lesson);
      await commitCourseTransaction(transaction);
      transaction = null;
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      if (transaction) {
        try {
          await rollbackCourseTransaction(transaction);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Lecture deletion failed and rollback also failed: ${rollbackError.message}`);
        }
      }
      throw error;
    } finally {
      if (activeTask === reservation) activeTask = null;
    }
    return;
  }

  const courseDeleteMatch = pathname.match(/^\/api\/courses\/([^/]+)$/);
  if (courseDeleteMatch && request.method === "DELETE") {
    if (activeTask) {
      sendJson(response, 409, { error: "Another course action is already running." });
      return;
    }
    const courseId = assertCourseId(courseDeleteMatch[1]);
    const reservation = { child: null, action: "delete-course", courseId };
    activeTask = reservation;
    try {
      await annotationMutation;
      try {
        await verifiedCourseRoot(courseId);
      } catch (error) {
        // An unreadable course cannot pass full verification, yet deleting it
        // is exactly how the learner recovers. Diagnosed courses stay deletable.
        if (error.message !== "Unknown teaching workspace") throw error;
        const { diagnostics } = await discoverCoursesDetailed(WORKSPACE_ROOT);
        if (!diagnostics.some((item) => item.id === courseId)) throw error;
      }
      const result = await moveCourseToTrash(WORKSPACE_ROOT, courseId);
      sendJson(response, 200, { ok: true, ...result });
    } finally {
      if (activeTask === reservation) activeTask = null;
    }
    return;
  }

  const historyRestoreMatch = pathname.match(/^\/api\/courses\/([^/]+)\/history\/restore$/);
  if (historyRestoreMatch && request.method === "POST") {
    const body = await readJson(request);
    if (activeTask) {
      sendJson(response, 409, { error: "Another teacher task is already running." });
      return;
    }
    const reservation = { child: null, action: "restore", courseId: historyRestoreMatch[1] };
    activeTask = reservation;
    try {
      const courseRoot = await verifiedCourseRoot(historyRestoreMatch[1]);
      const history = await restoreLectureVersion(courseRoot, body.lesson, body.commit);
      sendJson(response, 200, { history });
    } finally {
      if (activeTask === reservation) activeTask = null;
    }
    return;
  }

  const historyMatch = pathname.match(/^\/api\/courses\/([^/]+)\/history$/);
  if (historyMatch && request.method === "GET") {
    if (activeTask?.courseId === historyMatch[1]) {
      sendJson(response, 409, { error: "Lecture history is unavailable while a teacher task is running." });
      return;
    }
    const courseRoot = await verifiedCourseRoot(historyMatch[1]);
    const history = await readLectureHistory(courseRoot, url.searchParams.get("lesson") || "");
    sendJson(response, 200, { history });
    return;
  }

  const annotationListMatch = pathname.match(/^\/api\/courses\/([^/]+)\/annotations$/);
  if (annotationListMatch && request.method === "GET") {
    const courseId = assertCourseId(annotationListMatch[1]);
    await verifiedCourseRoot(courseId);
    const store = await readAnnotationStore(WORKSPACE_ROOT, courseId);
    const lesson = url.searchParams.get("lesson");
    sendJson(response, 200, {
      annotations: lesson ? store.annotations.filter((item) => item.lesson === lesson) : store.annotations,
    });
    return;
  }

  if (annotationListMatch && request.method === "POST") {
    const courseId = assertCourseId(annotationListMatch[1]);
    if (annotationsLockedByActiveTask(courseId)) {
      sendJson(response, 409, { error: "This course is busy with the current teacher action. Your note can be saved when it finishes." });
      return;
    }
    const courseRoot = await verifiedCourseRoot(courseId);
    const body = await readJson(request, ANNOTATION_BODY_LIMIT);
    const lesson = assertLessonPath(body.lesson);
    const lessonFile = await confinedRealPath(courseRoot, path.join(courseRoot, lesson)).catch(() => "");
    if (!lessonFile || !(await fileExists(lessonFile))) throw new Error("The selected lesson no longer exists");
    const annotation = await guardedAnnotationMutation(courseId, () => addAnnotation(WORKSPACE_ROOT, courseId, body));
    sendJson(response, 201, { annotation });
    return;
  }

  const annotationImageMatch = pathname.match(/^\/api\/courses\/([^/]+)\/annotations\/([^/]+)\/image$/);
  if (annotationImageMatch && request.method === "GET") {
    await verifiedCourseRoot(annotationImageMatch[1]);
    const image = await readAnnotationImage(WORKSPACE_ROOT, annotationImageMatch[1], annotationImageMatch[2]);
    response.writeHead(200, {
      "Content-Type": image.type,
      "Content-Length": image.data.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(image.data);
    return;
  }

  const annotationItemMatch = pathname.match(/^\/api\/courses\/([^/]+)\/annotations\/([^/]+)$/);
  if (annotationItemMatch && request.method === "DELETE") {
    const courseId = assertCourseId(annotationItemMatch[1]);
    if (annotationsLockedByActiveTask(courseId)) {
      sendJson(response, 409, { error: "This course is busy with the current teacher action. The note can be deleted when it finishes." });
      return;
    }
    await verifiedCourseRoot(courseId);
    const removed = await guardedAnnotationMutation(courseId, () => deleteAnnotation(WORKSPACE_ROOT, courseId, annotationItemMatch[2]));
    sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Message not found" });
    return;
  }

  if (pathname === "/api/teacher" && request.method === "POST") {
    await runTeacher(request, response, await readJson(request), { providerLookup, spawnProcess });
    return;
  }

  if (request.method === "GET") {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    await serveFile(response, publicPath(relative));
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export function createAppServer({
  sessionToken = launchToken(),
  contentOrigin = "",
  providerLookup = providerInfo,
  spawnProcess = spawn,
} = {}) {
  const server = createServer((request, response) => {
    handleRequest(request, response, { sessionToken, contentOrigin, providerLookup, spawnProcess }).catch((error) => {
      if (response.headersSent) {
        writeStreamEvent(response, { type: "error", text: error.message });
        response.end();
        return;
      }
      const status = Number.isInteger(error?.status) ? error.status : error?.code === "BODY_TOO_LARGE"
        ? 413
        : error?.code === "ENOENT"
          ? 404
          : /Invalid|Unknown|required|long|large|exists|available|installed|sign in|update required|margin message|image/i.test(error.message)
            ? 400
            : 500;
      sendJson(response, status, { error: error.message || "Unexpected error" });
    });
  });
  // Test and native launch plumbing need the token without putting it in an API response.
  server.marginSessionToken = sessionToken;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const libraryLock = await acquireLibraryLock(WORKSPACE_ROOT).catch((error) => {
    console.error(`Margin could not lock the learning library: ${error.message}`);
    process.exit(startupExitStatus(error));
  });
  await recoverCourseTransactions(WORKSPACE_ROOT).catch(async (error) => {
    await libraryLock.release().catch(() => {});
    console.error(`Margin could not recover an unfinished course action: ${error.message}`);
    process.exit(1);
  });
  await clearActiveTeacherMarker().catch((error) => {
    console.error(`Margin could not clear stale teacher state: ${error.message}`);
  });
  const courseCreationRecovery = await recoverCourseCreationArtifacts(WORKSPACE_ROOT).catch(async (error) => {
    await libraryLock.release().catch(() => {});
    console.error(`Margin could not recover unfinished course creation: ${error.message}`);
    process.exit(1);
  });
  if (courseCreationRecovery.recoveredCourses.length || courseCreationRecovery.archivedDrafts.length) {
    console.error(
      `Margin recovered ${courseCreationRecovery.recoveredCourses.length} completed course draft(s) and archived ${courseCreationRecovery.archivedDrafts.length} unfinished draft(s).`,
    );
  }
  const sessionToken = launchToken();
  const contentServer = createContentServer();
  contentServer.listen(CONTENT_PORT, HOST, () => {
    const contentAddress = contentServer.address();
    const contentPort = typeof contentAddress === "object" && contentAddress ? contentAddress.port : CONTENT_PORT;
    const contentOrigin = `http://${HOST}:${contentPort}`;
    const server = createAppServer({ sessionToken, contentOrigin });
    server.listen(PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : PORT;
      contentServer.setAppOrigin(`http://${HOST}:${port}`);
      const readyFile = process.env.MARGIN_READY_FILE;
      const readyLine = launchReadyLine(HOST, port, contentOrigin);
      if (readyFile) {
        writeFile(readyFile, `${readyLine}\n`, { flag: "wx", mode: 0o600 })
          .catch((error) => console.error(`Could not publish native readiness: ${error.message}`));
      }
      // The native shell injects its token without logging it. A direct
      // `npm run dev` launch needs the token in the printed URL so a normal
      // browser can authenticate its API requests.
      console.log(readyFile ? readyLine : launchReadyLine(HOST, port, contentOrigin, sessionToken));
    });

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const forcedExit = setTimeout(() => process.exit(1), 4500);
      forcedExit.unref();
      void (async () => {
        const task = activeTask;
        if (task?.action === "update") {
          // Provider updates are detached, non-cancellable external mutations.
          // End the UI stream and let the installer finish independently.
          task.endResponse?.();
          task.child?.unref?.();
          await task.release?.();
        } else if (task?.cancel) {
          task.cancel("Margin is shutting down.");
          await task.settled;
        } else if (task) {
          await quiesceTaskProcessGroup(task);
        }
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await new Promise((resolve, reject) => contentServer.close((error) => (error ? reject(error) : resolve())));
        await libraryLock.release();
        clearTimeout(forcedExit);
        process.exit(0);
      })().catch((error) => {
        console.error(`Margin shutdown failed: ${error.message}`);
        process.exit(1);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
