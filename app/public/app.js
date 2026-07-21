const sessionUrl = new URL(window.location.href);
const incomingSessionToken = sessionUrl.searchParams.get("session") || "";
if (incomingSessionToken) sessionStorage.setItem("margin:session", incomingSessionToken);
const sessionToken = incomingSessionToken || sessionStorage.getItem("margin:session") || "";
sessionUrl.searchParams.delete("session");
sessionUrl.searchParams.delete("contentOrigin");
window.history.replaceState({}, "", `${sessionUrl.pathname}${sessionUrl.search}${sessionUrl.hash}`);
let preferences = {};
let contentOrigin = "";
let preferenceWrite = Promise.resolve();

function preference(key, fallback = "") {
  return Object.hasOwn(preferences, key) ? preferences[key] : fallback;
}

function authenticatedHeaders(headers = {}) {
  return { "X-Margin-Session": sessionToken, ...headers };
}

function persistPreference(key, value) {
  preferences[key] = value;
  preferenceWrite = preferenceWrite
    .catch(() => undefined)
    .then(() => api("/api/settings", { method: "PATCH", body: JSON.stringify({ key, value }) }))
    .catch((error) => showToast(`Could not save this preference: ${error.message}`, { error: true }));
  return preferenceWrite;
}

const state = {
  courses: [],
  diagnostics: [],
  providers: [],
  course: null,
  documentPath: null,
  annotations: [],
  selectionCandidate: null,
  pendingSelection: null,
  pendingImage: null,
  view: "library",
  expandedChapterId: null,
  teacherMenuOpen: false,
  selectedTeacher: preference("margin:teacher", "claude"),
  teacherSettings: {
    claude: {
      model: preference("margin:teacher:claude:model"),
      effort: preference("margin:teacher:claude:effort"),
    },
    codex: {
      model: preference("margin:teacher:codex:model"),
      effort: preference("margin:teacher:codex:effort"),
    },
  },
  newCourseRun: null,
  pendingDeletion: null,
  leftPanelCollapsed: preference("margin:panel:left") === "true",
  rightPanelCollapsed: preference("margin:panel:right") === "true",
  coursePanelWidth: Number(preference("margin:panel:course-width")) || null,
  marginPanelWidth: Number(preference("margin:panel:margin-width")) || null,
  resizingPanel: null,
  resizePointerId: null,
  workspaceScale: Math.min(1.4, Math.max(0.8, Number(preference("margin:workspace-scale")) || 1)),
  lectureHistory: null,
  historyRequestKey: "",
  historyPreviewCommit: "",
  activeRun: null,
  interruptedRun: null,
  navigationGeneration: 0,
  courseDiagnosticsSignature: "",
  staleLectures: new Set(),
  runLogBytes: 0,
  lastRunLogText: "",
  lastRunLogKind: "",
  lastRunLogCount: 0,
};

const elements = Object.fromEntries([
  "app", "library-view", "library-task-host", "course-shelf", "new-course-dialog", "new-course-form", "new-course-name",
  "new-course-request", "new-course-teacher-slip", "new-course-teacher-select", "new-course-model-select",
  "new-course-effort-select", "new-course-teacher-status", "new-course-config-hint", "new-course-progress",
  "new-course-progress-title", "new-course-progress-activity", "cancel-new-course", "create-new-course",
  "delete-dialog", "delete-form", "delete-title", "delete-detail", "delete-recovery", "delete-error",
  "cancel-delete", "confirm-delete",
  "back-to-library", "current-course-title", "chapter-list",
  "reference-list", "course-panel-content", "margin-panel-content", "left-panel-resizer", "right-panel-resizer",
  "toggle-left-panel", "toggle-right-panel", "decrease-font-size", "reset-font-size",
  "increase-font-size", "font-size-value", "lesson-frame", "selection-popover",
  "leave-message-button", "composer", "cancel-message", "selected-context", "selected-quote", "message-input",
  "image-input", "attach-image", "image-preview", "image-preview-img", "image-preview-name", "image-preview-size", "remove-image",
  "save-message", "unused-count", "lecture-history-button", "message-count", "message-list", "teacher-menu-button", "teacher-current-glyph",
  "teacher-current-name", "teacher-current-config", "provider-picker", "teacher-model-input",
  "teacher-effort-select", "teacher-config-hint",
  "revise-button", "revise-detail", "next-button", "next-detail", "teacher-run", "teacher-dock", "run-title",
  "run-activity", "open-run-details", "run-details-view", "close-run-details", "run-detail-title",
  "run-detail-activity", "run-log", "cancel-run", "run-recovery-actions", "resume-run", "switch-run", "abandon-run",
  "history-view", "close-history", "history-title", "history-summary",
  "history-list", "history-preview-empty", "history-preview-frame", "toast",
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

const MAX_RUN_LOG_BYTES = 16 * 1024;
const PANEL_LIMITS = {
  left: { min: 170, max: 420, stateKey: "coursePanelWidth", cssProperty: "--course-user-width", storageKey: "margin:panel:course-width" },
  right: { min: 270, max: 560, stateKey: "marginPanelWidth", cssProperty: "--margin-user-width", storageKey: "margin:panel:margin-width" },
};
const MIN_READER_WIDTH = 360;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authenticatedHeaders(options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function freshOperationId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PENDING_OPERATIONS_KEY = "margin:pending-operations";
const MAX_PENDING_OPERATIONS = 8;
const OPERATION_RECONNECT_LIMIT_MS = 60 * 1000;
let pendingReconciliationTimer = 0;

function pendingOperations() {
  try {
    const parsed = JSON.parse(String(preference(PENDING_OPERATIONS_KEY, "[]") || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item
      && typeof item.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(item.id)
      && typeof item.signature === "string" && /^[a-f0-9]{64}$/.test(item.signature)
      && (item.kind === "course-create" || item.kind === "teacher"));
  } catch {
    return [];
  }
}

async function persistCriticalPreference(key, value) {
  const previous = preference(key, "");
  preferences[key] = value;
  const write = preferenceWrite
    .catch(() => undefined)
    .then(() => api("/api/settings", { method: "PATCH", body: JSON.stringify({ key, value }) }));
  preferenceWrite = write.catch(() => undefined);
  try {
    await write;
  } catch (error) {
    if (preferences[key] === value) preferences[key] = previous;
    throw error;
  }
}

async function operationSignature(parts) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function operationForRequest(signature, context) {
  const entries = pendingOperations();
  const previous = entries.find((item) => item.signature === signature);
  if (previous) return previous.id;
  if (entries.length >= MAX_PENDING_OPERATIONS) {
    throw new Error("Resolve the pending teacher results before starting another action");
  }
  const operation = { id: freshOperationId(), signature, createdAt: new Date().toISOString(), ...context };
  await persistCriticalPreference(PENDING_OPERATIONS_KEY, JSON.stringify([...entries, operation]));
  return operation.id;
}

async function clearOperation(operationId) {
  const entries = pendingOperations();
  if (!entries.some((item) => item.id === operationId)) return;
  try {
    await persistCriticalPreference(PENDING_OPERATIONS_KEY, JSON.stringify(entries.filter((item) => item.id !== operationId)));
  } catch (error) {
    showToast(`The completed operation receipt could not be cleared: ${error.message}`, { error: true });
  }
}

async function clearRunReceipts(operationId, handoffId = "") {
  await clearOperation(operationId);
  if (handoffId && handoffId !== operationId) await clearOperation(handoffId);
}

async function reconcileOperation(operationId, { courseId = "", timeoutMilliseconds = 10000 } = {}) {
  const deadline = Date.now() + timeoutMilliseconds;
  try {
    while (true) {
      const query = courseId ? `?course=${encodeURIComponent(courseId)}` : "";
      const result = await api(`/api/operations/${encodeURIComponent(operationId)}${query}`);
      if (result.status === "complete" && result.event?.type === "complete") {
        return { status: "complete", event: result.event };
      }
      if (result.status === "failed" && result.failure) {
        return { status: "failed", failure: result.failure, handoff: result.handoff || null };
      }
      if (result.status === "unknown") return { status: "unknown" };
      if (result.status === "deferred") return { status: "deferred", task: result.task };
      if (result.status !== "running") return { status: "unconfirmed" };
      if (Date.now() >= deadline) return { status: "running", task: result.task };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    return { status: "unconfirmed", error };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForOperationTerminal(operationId, { courseId = "", onRunning = () => {} } = {}) {
  let connectionFailures = 0;
  let disconnectedAt = 0;
  while (true) {
    const result = await reconcileOperation(operationId, { courseId, timeoutMilliseconds: 0 });
    if (result.status === "running") {
      connectionFailures = 0;
      disconnectedAt = 0;
      onRunning(result.task, null);
      await delay(750);
      continue;
    }
    if (result.status === "unconfirmed" && result.error) {
      connectionFailures += 1;
      disconnectedAt ||= Date.now();
      onRunning(null, result.error);
      if (Date.now() - disconnectedAt >= OPERATION_RECONNECT_LIMIT_MS) {
        return {
          status: "unconfirmed",
          error: new Error("Margin's local service has been unreachable for one minute. Restart Margin to check the saved teacher receipt."),
        };
      }
      await delay(Math.min(5000, 750 * connectionFailures));
      continue;
    }
    return result;
  }
}

function schedulePendingOperationReconciliation() {
  clearTimeout(pendingReconciliationTimer);
  if (!pendingOperations().length) return;
  pendingReconciliationTimer = setTimeout(() => {
    pendingReconciliationTimer = 0;
    if (!state.activeRun && !state.newCourseRun && !state.interruptedRun) void reconcilePendingOperationsAtStartup();
  }, 1000);
}

async function requestOperationCancellation(run, { courseId = "", mode = "cancel" } = {}) {
  run.cancelRequested = true;
  if (!run.operationId) {
    run.controller?.abort();
    return { status: "cancelling" };
  }
  const query = courseId ? `?course=${encodeURIComponent(courseId)}` : "";
  return api(`/api/operations/${encodeURIComponent(run.operationId)}/cancel${query}`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clip(text, length = 160) {
  const compact = compactText(text);
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

let toastTimer;
function showToast(message, { error = false, taskComplete = false } = {}) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.toggle("task-complete", taskComplete);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, error ? 6500 : taskComplete ? 5000 : 3200);
}

function showTaskCompletion(message) {
  showToast(message, { taskComplete: true });
}

function panelIsCollapsed(side) {
  return side === "left" ? state.leftPanelCollapsed : state.rightPanelCollapsed;
}

function panelBaseWidth(side) {
  const property = side === "left" ? "--course-base-width" : "--margin-base-width";
  return Number.parseFloat(getComputedStyle(elements.app).getPropertyValue(property)) || PANEL_LIMITS[side].min;
}

function configuredPanelWidth(side) {
  const value = state[PANEL_LIMITS[side].stateKey];
  return Number.isFinite(value) ? value : panelBaseWidth(side);
}

function panelMaximum(side) {
  const otherSide = side === "left" ? "right" : "left";
  const otherWidth = panelIsCollapsed(otherSide) ? 0 : configuredPanelWidth(otherSide);
  const appWidth = elements.app.getBoundingClientRect().width || window.innerWidth;
  return Math.max(PANEL_LIMITS[side].min, Math.min(PANEL_LIMITS[side].max, appWidth - otherWidth - MIN_READER_WIDTH));
}

function updatePanelResizerAccessibility() {
  const stacked = window.matchMedia("(max-width: 900px)").matches;
  for (const side of ["left", "right"]) {
    const handle = side === "left" ? elements.leftPanelResizer : elements.rightPanelResizer;
    const enabled = state.view === "reader" && !stacked && !panelIsCollapsed(side);
    handle.hidden = !enabled;
    handle.tabIndex = enabled ? 0 : -1;
    handle.setAttribute("aria-valuemin", String(PANEL_LIMITS[side].min));
    handle.setAttribute("aria-valuemax", String(Math.round(panelMaximum(side))));
    handle.setAttribute("aria-valuenow", String(Math.round(configuredPanelWidth(side))));
  }
}

function renderPanelWidths() {
  for (const side of ["left", "right"]) {
    const limit = PANEL_LIMITS[side];
    const width = state[limit.stateKey];
    if (Number.isFinite(width)) elements.app.style.setProperty(limit.cssProperty, `${Math.round(width)}px`);
    else elements.app.style.removeProperty(limit.cssProperty);
  }
  updatePanelResizerAccessibility();
}

function setPanelWidth(side, requestedWidth, { persist = true } = {}) {
  const limit = PANEL_LIMITS[side];
  const width = Math.round(Math.min(panelMaximum(side), Math.max(limit.min, requestedWidth)));
  state[limit.stateKey] = width;
  elements.app.style.setProperty(limit.cssProperty, `${width}px`);
  if (persist) persistPreference(limit.storageKey, String(width));
  updatePanelResizerAccessibility();
}

function normalizePanelWidths() {
  if (window.matchMedia("(max-width: 900px)").matches) {
    updatePanelResizerAccessibility();
    return;
  }
  for (const side of ["left", "right"]) {
    const limit = PANEL_LIMITS[side];
    if (Number.isFinite(state[limit.stateKey])) setPanelWidth(side, state[limit.stateKey], { persist: false });
  }
  updatePanelResizerAccessibility();
}

function resizePanelFromPointer(side, event) {
  const rect = elements.app.getBoundingClientRect();
  const requestedWidth = side === "left" ? event.clientX - rect.left : rect.right - event.clientX;
  setPanelWidth(side, requestedWidth, { persist: false });
  hideSelectionPopover();
}

function beginPanelResize(side, event) {
  if (event.button !== 0 || window.matchMedia("(max-width: 900px)").matches) return;
  event.preventDefault();
  const handle = side === "left" ? elements.leftPanelResizer : elements.rightPanelResizer;
  state.resizingPanel = side;
  state.resizePointerId = event.pointerId;
  elements.app.dataset.resizing = "true";
  handle.dataset.active = "true";
  document.body.classList.add("panel-resizing");
  handle.setPointerCapture(event.pointerId);
  closeTeacherMenu();
  resizePanelFromPointer(side, event);
}

function movePanelResize(side, event) {
  if (state.resizingPanel !== side || state.resizePointerId !== event.pointerId) return;
  resizePanelFromPointer(side, event);
}

function endPanelResize(side, event) {
  if (state.resizingPanel !== side || state.resizePointerId !== event.pointerId) return;
  const handle = side === "left" ? elements.leftPanelResizer : elements.rightPanelResizer;
  const limit = PANEL_LIMITS[side];
  persistPreference(limit.storageKey, String(Math.round(configuredPanelWidth(side))));
  state.resizingPanel = null;
  state.resizePointerId = null;
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  delete elements.app.dataset.resizing;
  delete handle.dataset.active;
  document.body.classList.remove("panel-resizing");
}

function resizePanelFromKeyboard(side, event) {
  const step = event.shiftKey ? 24 : 12;
  let next = configuredPanelWidth(side);
  if (event.key === "Home") next = PANEL_LIMITS[side].min;
  else if (event.key === "End") next = panelMaximum(side);
  else if (event.key === "ArrowLeft") next += side === "left" ? -step : step;
  else if (event.key === "ArrowRight") next += side === "left" ? step : -step;
  else return;
  event.preventDefault();
  setPanelWidth(side, next);
}

function attachPanelResizer(side, handle) {
  handle.addEventListener("pointerdown", (event) => beginPanelResize(side, event));
  handle.addEventListener("pointermove", (event) => movePanelResize(side, event));
  handle.addEventListener("pointerup", (event) => endPanelResize(side, event));
  handle.addEventListener("pointercancel", (event) => endPanelResize(side, event));
  handle.addEventListener("lostpointercapture", (event) => endPanelResize(side, event));
  handle.addEventListener("keydown", (event) => resizePanelFromKeyboard(side, event));
}

function renderPanelState() {
  const leftExpanded = !state.leftPanelCollapsed;
  const rightExpanded = !state.rightPanelCollapsed;
  elements.app.dataset.leftCollapsed = String(!leftExpanded);
  elements.app.dataset.rightCollapsed = String(!rightExpanded);
  elements.toggleLeftPanel.setAttribute("aria-expanded", String(leftExpanded));
  elements.toggleRightPanel.setAttribute("aria-expanded", String(rightExpanded));
  elements.toggleLeftPanel.setAttribute("aria-label", `${leftExpanded ? "Hide" : "Show"} course panel`);
  elements.toggleRightPanel.setAttribute("aria-label", `${rightExpanded ? "Hide" : "Show"} margin panel`);
  elements.toggleLeftPanel.title = `${leftExpanded ? "Hide" : "Show"} course panel (⌘B)`;
  elements.toggleRightPanel.title = `${rightExpanded ? "Hide" : "Show"} margin panel`;
  elements.toggleLeftPanel.querySelector(".panel-toggle-arrow").textContent = leftExpanded ? "‹" : "›";
  elements.toggleRightPanel.querySelector(".panel-toggle-arrow").textContent = rightExpanded ? "›" : "‹";
  updatePanelResizerAccessibility();
}

function setPanelState({ left = state.leftPanelCollapsed, right = state.rightPanelCollapsed }) {
  state.leftPanelCollapsed = left;
  state.rightPanelCollapsed = right;
  persistPreference("margin:panel:left", String(left));
  persistPreference("margin:panel:right", String(right));
  if (right) closeTeacherMenu();
  renderPanelState();
  normalizePanelWidths();
  hideSelectionPopover();
}

function togglePanel(side) {
  if (side === "left") setPanelState({ left: !state.leftPanelCollapsed });
  if (side === "right") setPanelState({ right: !state.rightPanelCollapsed });
}

function toggleCoursePanel() {
  if (state.view !== "reader") return;
  togglePanel("left");
}

function renderWorkspaceScale() {
  const percent = Math.round(state.workspaceScale * 100);
  elements.fontSizeValue.textContent = `${percent}%`;
  elements.resetFontSize.disabled = percent === 100;
  elements.decreaseFontSize.disabled = state.workspaceScale <= 0.8;
  elements.increaseFontSize.disabled = state.workspaceScale >= 1.4;
}

function applyWorkspaceScale() {
  elements.app.style.removeProperty("zoom");
  elements.app.style.removeProperty("width");
  elements.app.style.removeProperty("height");
  elements.app.style.removeProperty("min-height");
  for (const panel of [elements.coursePanelContent, elements.marginPanelContent]) {
    panel.style.zoom = String(state.workspaceScale);
    panel.style.removeProperty("width");
    panel.style.removeProperty("height");
  }
  postReader("scale", { scale: state.workspaceScale });
}

function setWorkspaceScale(value) {
  state.workspaceScale = Math.min(1.4, Math.max(0.8, Math.round(value * 10) / 10));
  persistPreference("margin:workspace-scale", String(state.workspaceScale));
  renderWorkspaceScale();
  applyWorkspaceScale();
  hideSelectionPopover();
}

function currentLesson() {
  return allLectures().find((lecture) => lecture.path === state.documentPath) || null;
}

function allLectures(course = state.course) {
  return course?.chapters?.flatMap((chapter) => chapter.lectures) || [];
}

function currentChapter() {
  const lesson = currentLesson();
  return lesson ? state.course?.chapters.find((chapter) => chapter.id === lesson.chapterId) || null : null;
}

function isUnused(annotation) {
  return !annotation.uses?.length;
}

function providerReady(provider) {
  return Boolean(provider?.available && provider?.compatible && provider?.authenticated && provider?.ready);
}

function providerName(providerId) {
  return providerId === "claude" ? "Claude Code"
    : providerId === "codex" ? "Codex"
      : providerId === "margin" ? "Margin"
        : "";
}

function renderProviderGlyph(element, provider) {
  if (!element) return;
  const providerId = provider?.id || "unavailable";
  const fallback = providerId === "codex" ? "O" : providerId === "claude" ? "A" : "?";
  element.className = `provider-glyph ${providerId}`;
  element.textContent = fallback;
  const icon = typeof provider?.icon === "string" ? provider.icon : "";
  if (!icon.startsWith("data:image/png;base64,")) return;
  const image = document.createElement("img");
  image.alt = "";
  image.src = icon;
  image.addEventListener("error", () => renderProviderGlyph(element, { id: providerId }), { once: true });
  element.replaceChildren(image);
  element.classList.add("has-icon");
}

function providerStatus(provider) {
  if (!provider?.available) return "not installed";
  if (!provider.compatible) return `${provider.version} · update required`;
  if (!provider.authenticated) return `${provider.version} · sign in required`;
  return provider.version;
}

function teacherSettings(providerId = state.selectedTeacher) {
  return state.teacherSettings[providerId] || { model: "", effort: "" };
}

function modelMetadata(provider, modelId) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return models.find((model) => model.id === modelId)
    || (!modelId ? models.find((model) => model.default) : null)
    || null;
}

function supportedTeacherEfforts(provider, modelId) {
  const model = modelMetadata(provider, modelId);
  const efforts = model?.supportedEfforts?.length ? model.supportedEfforts : provider?.efforts;
  return Array.isArray(efforts) ? efforts : [];
}

function teacherConfigSummary(provider) {
  const settings = teacherSettings(provider?.id);
  const model = modelMetadata(provider, settings.model);
  const modelLabel = settings.model ? (model?.label || settings.model) : "Default model";
  const effortLabel = settings.effort ? `${settings.effort} thinking` : "default thinking";
  return `${modelLabel} · ${effortLabel}`;
}

function persistTeacherSetting(providerId, field, value) {
  if (!state.teacherSettings[providerId]) state.teacherSettings[providerId] = { model: "", effort: "" };
  state.teacherSettings[providerId][field] = value;
  persistPreference(`margin:teacher:${providerId}:${field}`, value);
}

function teacherConfigHint(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const defaultModel = models.find((model) => model.default);
  return defaultModel
    ? `CLI default: ${defaultModel.label || defaultModel.id}${defaultModel.defaultEffort ? ` · ${defaultModel.defaultEffort} thinking` : ""}.`
    : "Blank values use the CLI defaults.";
}

function setNewCourseProgress(kind, title, activity) {
  elements.newCourseProgress.hidden = false;
  elements.newCourseProgress.dataset.state = kind;
  elements.newCourseProgressTitle.textContent = title;
  elements.newCourseProgressActivity.textContent = activity;
  if (kind === "error" || kind === "cancelled") {
    requestAnimationFrame(() => elements.newCourseProgress.focus({ preventScroll: true }));
  }
}

function resetNewCourseProgress() {
  elements.newCourseProgress.hidden = true;
  elements.newCourseProgress.dataset.state = "running";
  elements.newCourseProgressTitle.textContent = "Preparing lecture 1";
  elements.newCourseProgressActivity.textContent = "Starting the teacher…";
}

function selectedTeacherStatus(provider) {
  if (!provider) return "No teacher is available. Install Claude Code or Codex, then reopen Margin.";
  if (!provider.available) return `${providerName(provider.id)} is not installed. Install it, then reopen Margin.`;
  if (!provider.compatible) return provider.error || `${providerName(provider.id)} needs an update before it can teach.`;
  if (!provider.authenticated) return provider.error || `Sign in to ${providerName(provider.id)} before creating a course.`;
  if (!provider.ready) return provider.error || `${providerName(provider.id)} is not ready to teach.`;
  return `${providerName(provider.id)} is ready${provider.version ? ` · ${provider.version}` : ""}.`;
}

function renderNewCourseFormState() {
  const run = state.newCourseRun;
  const busy = Boolean(run);
  const cancelling = run?.phase === "cancelling";
  const opening = run?.phase === "opening";
  const finishing = run?.phase === "committed";
  const provider = state.providers.find((item) => item.id === state.selectedTeacher);
  const anotherTaskRunning = Boolean(state.activeRun || state.interruptedRun);
  elements.newCourseForm.setAttribute("aria-busy", String(busy));
  elements.newCourseName.disabled = busy;
  elements.newCourseRequest.disabled = busy;
  elements.newCourseTeacherSlip.disabled = busy;
  elements.newCourseTeacherSelect.disabled = busy || !state.providers.some((item) => item.available);
  elements.newCourseModelSelect.disabled = busy || !provider?.available;
  elements.newCourseEffortSelect.disabled = busy || !provider?.available;
  elements.createNewCourse.disabled = busy || anotherTaskRunning || !providerReady(provider);
  elements.cancelNewCourse.disabled = cancelling || opening || finishing;
  elements.cancelNewCourse.textContent = cancelling
    ? "Cancelling…"
    : finishing
      ? "Finishing…"
    : opening
      ? "Opening…"
      : busy
        ? "Cancel teaching"
        : "Cancel";
  const retrying = !elements.newCourseProgress.hidden
    && (elements.newCourseProgress.dataset.state === "error" || elements.newCourseProgress.dataset.state === "cancelled");
  elements.createNewCourse.textContent = busy
    ? (opening ? "Opening lecture…" : cancelling ? "Cancelling…" : finishing ? "Finishing…" : "Creating lecture…")
    : (retrying ? "Try again" : "Create first lecture");
}

function renderNewCourseTeacherFields(selectedProvider) {
  elements.newCourseTeacherSelect.innerHTML = state.providers.length
    ? state.providers.map((provider) => `
      <option value="${escapeHtml(provider.id)}" ${provider.available ? "" : "disabled"}>
        ${escapeHtml(providerName(provider.id))} · ${escapeHtml(providerStatus(provider))}
      </option>
    `).join("")
    : '<option value="">No teacher available</option>';
  elements.newCourseTeacherSelect.value = state.selectedTeacher;

  const settings = teacherSettings();
  const models = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
  elements.newCourseModelSelect.innerHTML = [
    '<option value="">CLI default</option>',
    ...models
      .filter((model) => model.id)
      .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`),
  ].join("");
  elements.newCourseModelSelect.value = settings.model;

  const efforts = supportedTeacherEfforts(selectedProvider, settings.model);
  elements.newCourseEffortSelect.innerHTML = [
    '<option value="">CLI default</option>',
    ...efforts.map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`),
  ].join("");
  elements.newCourseEffortSelect.value = settings.effort;
  elements.newCourseTeacherStatus.textContent = state.activeRun
    ? "Another teacher task is already running. You can create this course when it finishes."
    : state.interruptedRun
      ? "Resolve the paused or interrupted teacher checkpoint before starting another course."
    : selectedTeacherStatus(selectedProvider);
  elements.newCourseTeacherStatus.dataset.state = providerReady(selectedProvider) && !state.activeRun && !state.interruptedRun
    ? "ready"
    : "attention";
  elements.newCourseConfigHint.textContent = teacherConfigHint(selectedProvider);
  renderNewCourseFormState();
}

function renderLibrary() {
  const courseCards = state.courses.map((course, index) => {
    const lectures = allLectures(course).length;
    return `
      <div class="course-card-shell">
        <button class="course-card course-tone-${index % 4}" type="button" data-course-id="${escapeHtml(course.id)}">
          <span class="course-spine" aria-hidden="true"></span>
          <strong>${escapeHtml(course.title)}</strong>
          <small>${course.chapters.length} ${course.chapters.length === 1 ? "chapter" : "chapters"} · ${lectures} ${lectures === 1 ? "lecture" : "lectures"}</small>
          <span class="course-open" aria-hidden="true">Open →</span>
        </button>
        <button class="course-delete-trigger" type="button" data-delete-course="${escapeHtml(course.id)}"
          aria-label="Delete ${escapeHtml(course.title)}" title="Delete course">Delete</button>
      </div>
    `;
  }).join("");
  const brokenCards = state.diagnostics.map((diagnostic) => `
    <div class="course-card-shell">
      <div class="course-card course-card-broken">
        <span class="course-spine" aria-hidden="true"></span>
        <strong>${escapeHtml(diagnostic.id)}</strong>
        <small>${escapeHtml(clip(diagnostic.error || "This course could not be read", 140))}</small>
        <span class="course-open" aria-hidden="true">Unreadable</span>
      </div>
      <button class="course-delete-trigger" type="button" data-delete-course="${escapeHtml(diagnostic.id)}"
        aria-label="Delete ${escapeHtml(diagnostic.id)}" title="Delete course">Delete</button>
    </div>
  `).join("");
  elements.courseShelf.innerHTML = `${courseCards}${brokenCards}
    <button class="course-card new-course-card" type="button" data-new-course>
      <span class="new-course-card-plus" aria-hidden="true">+</span>
      <strong>New course</strong>
      <small>Start a learning workspace</small>
      <span class="course-open" aria-hidden="true">Create →</span>
    </button>
  `;
  for (const button of elements.courseShelf.querySelectorAll("[data-course-id]")) {
    button.addEventListener("click", () => openCourse(button.dataset.courseId));
  }
  for (const button of elements.courseShelf.querySelectorAll("[data-delete-course]")) {
    button.addEventListener("click", () => requestCourseDeletion(button.dataset.deleteCourse));
  }
  elements.courseShelf.querySelector("[data-new-course]").addEventListener("click", openNewCourseDialog);
}

function deletionBlocked() {
  if (!state.activeRun && !state.newCourseRun && !state.interruptedRun) return false;
  showToast(
    state.interruptedRun
      ? "Resume, switch, or abandon the interrupted teacher checkpoint before deleting course material."
      : "Wait for the current teacher action to finish before deleting course material.",
    { error: true },
  );
  return true;
}

function showDeleteDialog(deletion) {
  if (deletionBlocked()) return;
  state.pendingDeletion = { ...deletion, busy: false };
  elements.deleteError.hidden = true;
  elements.deleteError.textContent = "";
  elements.confirmDelete.disabled = false;
  elements.cancelDelete.disabled = false;

  if (deletion.kind === "course") {
    elements.deleteTitle.textContent = `Delete ${deletion.title}?`;
    elements.deleteDetail.textContent = "The course will disappear from your library, including every lecture and learning record.";
    elements.deleteRecovery.textContent = "Margin moves the complete course folder into Margin Trash inside the library. Its files remain recoverable.";
    elements.confirmDelete.textContent = "Delete course";
  } else {
    elements.deleteTitle.textContent = `Delete “${deletion.title}”?`;
    elements.deleteDetail.textContent = "The lecture will be removed from its chapter together with its active margin notes.";
    elements.deleteRecovery.textContent = "Margin archives the lecture HTML, its notes, and a deletion version inside the course’s private history.";
    elements.confirmDelete.textContent = "Delete lecture";
  }
  elements.deleteDialog.showModal();
  requestAnimationFrame(() => elements.cancelDelete.focus());
}

function requestCourseDeletion(courseId) {
  const course = state.courses.find((candidate) => candidate.id === courseId);
  const diagnostic = course ? null : state.diagnostics.find((candidate) => candidate.id === courseId);
  if (!course && !diagnostic) return;
  showDeleteDialog({ kind: "course", courseId, title: course?.title || courseId });
}

function requestLectureDeletion(lessonPath) {
  const course = state.course;
  const lectures = allLectures(course);
  const lecture = lectures.find((candidate) => candidate.path === lessonPath);
  if (!course || !lecture) return;
  if (lectures.length <= 1) {
    showToast("A course must keep one lecture. Delete the course instead.", { error: true });
    return;
  }
  const index = lectures.findIndex((candidate) => candidate.path === lessonPath);
  showDeleteDialog({
    kind: "lecture",
    courseId: course.id,
    lesson: lessonPath,
    title: lecture.title,
    fallbackNextLesson: lectures[index + 1]?.path || lectures[index - 1]?.path || "",
  });
}

function closeDeleteDialog({ force = false } = {}) {
  if (state.pendingDeletion?.busy && !force) return;
  if (elements.deleteDialog.open) elements.deleteDialog.close();
  state.pendingDeletion = null;
}

async function performDeletion(event) {
  event.preventDefault();
  const deletion = state.pendingDeletion;
  if (!deletion || deletion.busy) return;
  deletion.busy = true;
  elements.confirmDelete.disabled = true;
  elements.cancelDelete.disabled = true;
  elements.confirmDelete.textContent = "Moving…";
  elements.deleteError.hidden = true;

  try {
    let result = null;
    let requestError = null;
    try {
      result = deletion.kind === "course"
        ? await api(`/api/courses/${encodeURIComponent(deletion.courseId)}`, { method: "DELETE" })
        : await api(`/api/courses/${encodeURIComponent(deletion.courseId)}/lectures`, {
          method: "DELETE",
          body: JSON.stringify({ lesson: deletion.lesson }),
        });
    } catch (error) {
      requestError = error;
    }

    const previousDocument = state.documentPath;
    await refreshCourses();
    const survivingCourse = state.courses.find((course) => course.id === deletion.courseId);
    const survivingDiagnostic = state.diagnostics.some((diagnostic) => diagnostic.id === deletion.courseId);
    const deletionConfirmed = deletion.kind === "course"
      ? !survivingCourse && !survivingDiagnostic
      : !survivingCourse || !allLectures(survivingCourse).some((lecture) => lecture.path === deletion.lesson);
    if (requestError && !deletionConfirmed) throw requestError;

    closeDeleteDialog({ force: true });
    if (deletion.kind === "course") {
      showLibrary();
      showToast("Course moved to Margin Trash.");
      return;
    }

    if (!survivingCourse) {
      showLibrary();
    } else {
      const nextDocument = previousDocument === deletion.lesson
        ? result?.nextLesson || deletion.fallbackNextLesson
        : previousDocument;
      await openCourse(deletion.courseId, nextDocument);
    }
    showToast("Lecture moved to course history.");
  } catch (error) {
    deletion.busy = false;
    elements.confirmDelete.disabled = false;
    elements.cancelDelete.disabled = false;
    elements.confirmDelete.textContent = deletion.kind === "course" ? "Delete course" : "Delete lecture";
    elements.deleteError.textContent = error.message;
    elements.deleteError.hidden = false;
  }
}

function openNewCourseDialog() {
  if (state.newCourseRun) {
    openRunDetails();
    return;
  }
  if (state.interruptedRun) {
    openRunDetails();
    return;
  }
  elements.newCourseForm.reset();
  resetNewCourseProgress();
  renderProviders();
  elements.newCourseDialog.showModal();
  requestAnimationFrame(() => elements.newCourseName.focus());
}

function closeNewCourseDialog({ force = false } = {}) {
  if (state.newCourseRun && !force) {
    cancelNewCourseCreation();
    return;
  }
  if (elements.newCourseDialog.open) elements.newCourseDialog.close();
}

async function cancelNewCourseCreation({ mode = "cancel" } = {}) {
  const run = state.newCourseRun;
  if (!run || !["creating", "running"].includes(run.phase)) return;
  run.phase = "cancelling";
  setRunState("running", mode === "pause" ? "Saving a checkpoint and pausing the teacher…" : "Stopping the teacher and rolling back unfinished work…");
  try {
    const result = await requestOperationCancellation(run, { mode });
    if (state.newCourseRun !== run) return;
    if (result.status === "finishing" || result.status === "complete") {
      run.phase = "committed";
      setRunState("running", "Final validation has begun; Margin will keep the result if it completes.");
    }
  } catch (error) {
    if (state.newCourseRun === run) {
      run.cancelRequested = false;
      run.phase = "creating";
      setRunState("running", "Teaching continues in the background.");
    }
    showToast(`Could not request cancellation: ${error.message}`, { error: true });
  }
}

async function applyCourseCreationCompletion(completedEvent, run) {
  const completedCourse = completedEvent.course;
  const courseId = typeof completedCourse === "string" ? completedCourse : completedCourse?.id;
  if (!courseId || !completedEvent.lesson) throw new Error("The teacher finished, but did not identify the new course and lecture");

  const shouldOpen = state.view === "library" && state.navigationGeneration === run.navigationGeneration;
  if (state.newCourseRun === run) state.newCourseRun.phase = "committed";
  setRunState("done", "Course and first lecture created.");
  if (completedCourse && typeof completedCourse === "object") {
    state.courses = [...state.courses.filter((course) => course.id !== courseId), completedCourse];
    renderLibrary();
  } else {
    await refreshCourses();
  }
  if (shouldOpen) {
    if (state.newCourseRun === run) state.newCourseRun.phase = "opening";
    const opened = await openCourse(courseId, completedEvent.lesson);
    if (!opened) throw new Error("Margin could not open the new lecture");
  }
  closeNewCourseDialog({ force: true });
  showTaskCompletion(shouldOpen ? "Course and first lecture created." : "Course and first lecture created in the background.");
}

async function createNewCourse(event, { recovery = null, providerOverride = "" } = {}) {
  event?.preventDefault?.();
  if (state.activeRun || state.newCourseRun) return;
  if (!recovery && state.interruptedRun) {
    openRunDetails();
    return;
  }
  if (recovery && state.interruptedRun?.handoffId !== recovery.handoffId) return;
  const previousRecovery = recovery
    ? { ...recovery, annotationIds: [...(recovery.annotationIds || [])] }
    : null;
  const title = recovery?.title || elements.newCourseName.value.trim();
  const initialRequest = recovery?.initialRequest || elements.newCourseRequest.value.trim();
  if (!title || !initialRequest) {
    elements.newCourseForm.reportValidity();
    return;
  }
  const provider = providerOverride || recovery?.provider || state.selectedTeacher;
  const providerInfo = state.providers.find((item) => item.id === provider);
  if (!providerReady(providerInfo)) {
    setNewCourseProgress(
      "error",
      "Teacher setup needs attention",
      providerInfo?.error || "Choose an installed, signed-in teacher before creating the first lecture.",
    );
    renderNewCourseFormState();
    return;
  }

  const sameTeacherResume = Boolean(recovery && provider === recovery.provider && recovery.sessionId);
  const settings = sameTeacherResume
    ? { model: recovery.model || "", effort: recovery.effort || "" }
    : { ...teacherSettings(provider) };
  const { model, effort } = settings;
  const handoffId = recovery?.handoffId || "";
  const resumeSessionId = sameTeacherResume ? recovery.sessionId : "";
  state.selectedTeacher = provider;
  persistPreference("margin:teacher", provider);
  state.interruptedRun = null;
  const controller = new AbortController();
  const run = {
    controller,
    phase: "creating",
    action: "create",
    provider,
    model,
    effort,
    title,
    initialRequest,
    handoffId,
    resumeSessionId,
    operationId: "",
    cancelRequested: false,
    navigationGeneration: state.navigationGeneration,
  };
  state.newCourseRun = run;
  const configuration = [model || "default model", effort ? `${effort} thinking` : "default thinking"].join(" · ");
  resetRunLog();
  elements.runTitle.textContent = `${providerName(provider)} · new course`;
  setRunState("running", `Starting with ${configuration}…`);
  renderProviders();
  closeNewCourseDialog({ force: true });
  showToast("Starting course creation in the background.");
  let completedEvent = null;
  let committed = false;
  let operationId = "";

  try {
    const signature = await operationSignature([title, initialRequest, provider, model, effort, handoffId, resumeSessionId]);
    operationId = await operationForRequest(signature, {
      kind: "course-create",
      provider,
      model,
      effort,
      title,
      initialRequest,
      handoffId,
    });
    run.operationId = operationId;
    elements.cancelRun.disabled = false;
    const response = await fetch("/api/courses/create", {
      method: "POST",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({ title, initialRequest, provider, model, effort, operationId, handoffId, resumeSessionId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Course creation failed (${response.status})`);
    }
    run.phase = "running";
    await readNdjson(response, (teacherEvent) => {
      if (teacherEvent.type === "error") {
        const teacherError = new Error(teacherEvent.text || "The teacher could not create the first lecture");
        teacherError.interruption = teacherEvent.interruption || null;
        throw teacherError;
      }
      if (teacherEvent.type === "complete") {
        completedEvent = teacherEvent;
        committed = true;
        run.phase = "committed";
        if (teacherEvent.text && (state.lastRunLogKind !== "summary" || state.lastRunLogText !== teacherEvent.text)) {
          appendRunLog(teacherEvent.text, "summary");
        }
        return;
      }
      if (teacherEvent.type === "started") {
        setRunState("running", teacherEvent.text || `${providerName(provider)} is preparing lecture 1`);
        return;
      }
      if (["status", "activity", "summary", "message"].includes(teacherEvent.type) && teacherEvent.text) {
        elements.runDetailActivity.textContent = teacherEvent.text;
        appendRunLog(teacherEvent.text, teacherEvent.type);
      }
    });
    if (!completedEvent) throw new Error("The teacher stopped without completing the first lecture");
    await clearRunReceipts(operationId, handoffId);
    await applyCourseCreationCompletion(completedEvent, run);
  } catch (error) {
    if (!committed && operationId) {
      const resolution = await reconcileOperation(operationId);
      if (resolution.status === "complete") {
        completedEvent = resolution.event;
        committed = true;
        await clearRunReceipts(operationId, handoffId);
        try {
          await applyCourseCreationCompletion(completedEvent, run);
          return;
        } catch (openError) {
          error = openError;
        }
      } else if (resolution.status === "failed") {
        await adoptTeacherInterruption(run, resolution.failure, previousRecovery, error.message);
        return;
      } else if (resolution.status === "running") {
        setRunState("running", "The activity stream changed, but teaching continues safely in the background.");
        const terminal = await waitForOperationTerminal(operationId, {
          onRunning: (_task, connectionError) => {
            if (connectionError) {
              setRunState("running", "Reconnecting to the background teacher…");
            }
          },
        });
        if (terminal.status === "complete") {
          completedEvent = terminal.event;
          committed = true;
          await clearRunReceipts(operationId, handoffId);
          try {
            await applyCourseCreationCompletion(completedEvent, run);
            return;
          } catch (openError) {
            error = openError;
          }
        } else if (terminal.status === "failed") {
          await adoptTeacherInterruption(run, terminal.failure, previousRecovery, error.message);
          return;
        } else if (terminal.status === "unknown") {
          await clearOperation(operationId);
        } else {
          const detail = terminal.error ? ` ${terminal.error.message}` : "";
          const message = `Margin could not confirm whether lecture 1 was saved.${detail}`;
          appendRunLog(message, "error");
          setRunState("error", message);
          showToast(message, { error: true });
          return;
        }
      } else if (resolution.status === "unknown") {
        await clearOperation(operationId);
      } else {
        const detail = resolution.error ? ` ${resolution.error.message}` : "";
        const message = `Margin could not confirm whether lecture 1 was saved.${detail} Reopen the library before trying again; the same form will reuse this operation safely.`;
        appendRunLog(message, "error");
        setRunState("error", message);
        showToast(message, { error: true });
        return;
      }
    }
    if (committed) {
      const message = `Course was saved, but Margin could not open or refresh it: ${error.message}. Do not create it again; open it from the library or restart Margin.`;
      appendRunLog(message, "error");
      setRunState("done", message);
      closeNewCourseDialog({ force: true });
      showToast(message, { error: true });
      return;
    }
    if (error.interruption) {
      await adoptTeacherInterruption(run, error.interruption, previousRecovery, error.message);
      return;
    }
    if (restoreTeacherInterruption(previousRecovery, error.message)) return;
    if (!controller.signal.aborted) controller.abort();
    const cancelled = run.cancelRequested || error.name === "AbortError";
    const message = cancelled ? "Course creation cancelled." : error.message;
    appendRunLog(message, cancelled ? "status" : "error");
    setRunState("error", message);
    showToast(message, { error: !cancelled });
  } finally {
    if (state.newCourseRun?.controller === controller) state.newCourseRun = null;
    elements.cancelRun.disabled = false;
    if (elements.teacherRun.dataset.state !== "running") elements.cancelRun.textContent = "Dismiss";
    renderProviders();
    schedulePendingOperationReconciliation();
  }
}

function showLibrary() {
  state.navigationGeneration += 1;
  state.view = "library";
  placeTeacherRun();
  updatePanelResizerAccessibility();
  closeTeacherMenu();
  hideSelectionPopover();
  elements.app.hidden = true;
  elements.libraryView.hidden = false;
  document.title = "Margin";
}

async function openCourse(courseId, preferredDocument = null) {
  const navigationGeneration = ++state.navigationGeneration;
  try {
    state.view = "reader";
    placeTeacherRun();
    elements.libraryView.hidden = true;
    elements.app.hidden = false;
    normalizePanelWidths();
    if (state.course?.id !== courseId || !state.documentPath || preferredDocument) {
      const selected = await selectCourse(courseId, preferredDocument, navigationGeneration);
      if (!selected || state.navigationGeneration !== navigationGeneration) return false;
    }
    else {
      renderCourseRail();
      renderMessages();
      updateReaderMetadata();
      await refreshStaleCurrentLecture();
      if (state.navigationGeneration !== navigationGeneration) return false;
    }
    return true;
  } catch (error) {
    if (state.navigationGeneration !== navigationGeneration) return false;
    showToast(error.message, { error: true });
    showLibrary();
    return false;
  }
}

function toggleChapter(chapterId) {
  state.expandedChapterId = state.expandedChapterId === chapterId ? null : chapterId;
  renderCourseRail();
}

function renderCourseRail() {
  const course = state.course;
  if (!course) return;
  const canDeleteLecture = allLectures(course).length > 1;
  elements.currentCourseTitle.textContent = course.title;
  elements.chapterList.innerHTML = course.chapters.map((chapter, chapterIndex) => `
    <section class="chapter-group" ${chapter.id === currentChapter()?.id ? 'data-current="true"' : ""}>
      <button class="chapter-toggle" type="button" data-chapter-id="${escapeHtml(chapter.id)}"
        aria-expanded="${state.expandedChapterId === chapter.id}">
        <span class="chapter-number">${String(chapterIndex + 1).padStart(2, "0")}</span>
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-chevron" aria-hidden="true">${state.expandedChapterId === chapter.id ? "−" : "+"}</span>
      </button>
      <div class="chapter-lectures" ${state.expandedChapterId === chapter.id ? "" : "hidden"}>
        ${chapter.lectures.map((lecture, lectureIndex) => `
          <div class="lesson-row">
            <button class="lesson-link" type="button" data-document-path="${escapeHtml(lecture.path)}"
              ${lecture.path === state.documentPath ? 'aria-current="page"' : ""}>
              <span class="lesson-number">${String(lectureIndex + 1).padStart(2, "0")}</span>
              <span class="lesson-name">${escapeHtml(lecture.title)}</span>
            </button>
            ${canDeleteLecture ? `<button class="lecture-delete-trigger" type="button"
              data-delete-lecture="${escapeHtml(lecture.path)}" aria-label="Delete ${escapeHtml(lecture.title)}"
              title="Delete lecture">×</button>` : ""}
          </div>
        `).join("")}
      </div>
    </section>
  `).join("");
  elements.referenceList.innerHTML = course.references.map((reference) => `
    <button class="reference-link" type="button" data-document-path="${escapeHtml(reference.path)}"
      ${reference.path === state.documentPath ? 'aria-current="page"' : ""}>${escapeHtml(reference.title)}</button>
  `).join("");

  for (const button of elements.chapterList.querySelectorAll("[data-chapter-id]")) {
    button.addEventListener("click", () => toggleChapter(button.dataset.chapterId));
  }
  for (const button of elements.chapterList.querySelectorAll("[data-document-path]")) {
    button.addEventListener("click", () => loadDocument(button.dataset.documentPath));
  }
  for (const button of elements.chapterList.querySelectorAll("[data-delete-lecture]")) {
    button.addEventListener("click", () => requestLectureDeletion(button.dataset.deleteLecture));
  }
  for (const button of elements.referenceList.querySelectorAll("[data-document-path]")) {
    button.addEventListener("click", () => loadDocument(button.dataset.documentPath));
  }
}

function updateReaderMetadata() {
  const lesson = currentLesson();
  if (lesson) {
    const chapter = currentChapter();
    elements.lessonFrame.title = chapter ? `${lesson.title} — ${chapter.title}` : lesson.title;
    document.title = `${lesson.title} · Margin`;
    renderLectureHistoryButton();
    return;
  }
  const reference = state.course?.references.find((item) => item.path === state.documentPath);
  const title = reference?.title || "Course document";
  elements.lessonFrame.title = title;
  document.title = `${title} · Margin`;
  renderLectureHistoryButton();
}

function annotationUseLabel(annotation) {
  const use = annotation.uses?.at(-1);
  if (!use) return `Unused · ${new Date(annotation.createdAt).toLocaleDateString()}`;
  if (use.action === "revise") return `Used to revise ${use.target.split("/").at(-1)}`;
  return `Used to write ${use.target.split("/").at(-1)}`;
}

async function hydrateAnnotationImages() {
  const courseId = state.course?.id;
  if (!courseId) return;
  for (const image of elements.messageList.querySelectorAll("[data-annotation-image-id]")) {
    const annotationId = image.dataset.annotationImageId;
    try {
      const response = await fetch(
        `/api/courses/${encodeURIComponent(courseId)}/annotations/${encodeURIComponent(annotationId)}/image`,
        { headers: authenticatedHeaders() },
      );
      if (!response.ok) throw new Error(`Image request failed (${response.status})`);
      const objectUrl = URL.createObjectURL(await response.blob());
      if (!image.isConnected || state.course?.id !== courseId) {
        URL.revokeObjectURL(objectUrl);
        continue;
      }
      const release = () => URL.revokeObjectURL(objectUrl);
      image.addEventListener("load", release, { once: true });
      image.addEventListener("error", release, { once: true });
      image.src = objectUrl;
    } catch {
      image.alt = "Attached image unavailable";
    }
  }
}

function renderMessages() {
  const lessonAnnotations = state.annotations.filter((annotation) => annotation.lesson === state.documentPath);
  const unusedCourse = state.annotations.filter(isUnused);
  const unusedLesson = lessonAnnotations.filter(isUnused);
  const chapter = currentChapter();
  const chapterLectures = new Set(chapter?.lectures.map((lecture) => lecture.path) || []);
  const unusedChapter = unusedCourse.filter((annotation) => chapterLectures.has(annotation.lesson));
  elements.unusedCount.textContent = `${unusedCourse.length} unused`;
  elements.messageCount.textContent = `${lessonAnnotations.length}`;

  if (!currentLesson()) {
    elements.messageList.innerHTML = '<div class="empty-margin"><div>Open a lecture to annotate.</div></div>';
  } else if (!lessonAnnotations.length) {
    elements.messageList.innerHTML = '<div class="empty-margin"><div>No notes yet.</div></div>';
  } else {
    const ordered = [...lessonAnnotations].sort((a, b) => Number(isUnused(b)) - Number(isUnused(a)) || b.createdAt.localeCompare(a.createdAt));
    elements.messageList.innerHTML = ordered.map((annotation) => {
      const body = `
        ${annotation.image ? `<img class="message-image" data-annotation-image-id="${escapeHtml(annotation.id)}" alt="Attached image: ${escapeHtml(annotation.image.name || "note image")}">` : ""}
        ${annotation.quote ? `<blockquote>${escapeHtml(clip(annotation.quote, 190))}</blockquote>` : ""}
        ${annotation.message ? `<p class="message-copy">${escapeHtml(annotation.message)}</p>` : ""}
        <span class="message-meta">${escapeHtml(annotationUseLabel(annotation))}</span>
      `;
      return `
        <article class="message-card ${isUnused(annotation) ? "" : "used"}" data-annotation-id="${escapeHtml(annotation.id)}">
          ${annotation.quote
            ? `<button class="message-card-button" type="button" data-focus-annotation="${escapeHtml(annotation.id)}">${body}</button>`
            : `<div class="message-card-body">${body}</div>`}
          <button class="delete-message" type="button" data-delete-annotation="${escapeHtml(annotation.id)}" aria-label="Delete note">×</button>
        </article>
      `;
    }).join("");
    for (const button of elements.messageList.querySelectorAll("[data-focus-annotation]")) {
      button.addEventListener("click", () => focusAnnotation(button.dataset.focusAnnotation));
    }
    for (const button of elements.messageList.querySelectorAll("[data-delete-annotation]")) {
      button.addEventListener("click", () => removeAnnotation(button.dataset.deleteAnnotation));
    }
    hydrateAnnotationImages();
  }

  const provider = state.providers.find((item) => item.id === state.selectedTeacher);
  const running = Boolean(state.activeRun || state.newCourseRun || state.interruptedRun);
  const runBlocksNotes = Boolean(state.activeRun?.courseId) && state.activeRun.courseId === state.course?.id;
  elements.saveMessage.disabled = runBlocksNotes;
  elements.saveMessage.title = runBlocksNotes
    ? "The teacher is working on this course. Your draft stays here and can be saved when it finishes."
    : "";
  elements.reviseButton.disabled = running || !currentLesson() || !unusedLesson.length || !providerReady(provider);
  elements.nextButton.disabled = running || !currentLesson() || !providerReady(provider);
  elements.reviseDetail.textContent = unusedLesson.length === 1 ? "Uses 1 unused note" : `Uses ${unusedLesson.length} unused notes`;
  const messageCount = unusedChapter.length === 1 ? "1 unused note" : `${unusedChapter.length} unused notes`;
  elements.nextDetail.textContent = chapter ? `${chapter.title} · ${messageCount}` : messageCount;
}

function renderProviders() {
  const available = state.providers.filter((provider) => provider.available);
  if (!state.providers.find((provider) => provider.id === state.selectedTeacher)) {
    state.selectedTeacher = state.providers.find(providerReady)?.id || available[0]?.id || "";
  }
  const selectedProvider = state.providers.find((provider) => provider.id === state.selectedTeacher);
  const selectedName = selectedProvider ? providerName(state.selectedTeacher) : "No teacher available";
  elements.teacherCurrentName.textContent = selectedName;
  elements.teacherCurrentConfig.textContent = selectedProvider ? teacherConfigSummary(selectedProvider) : "No CLI available";
  renderProviderGlyph(elements.teacherCurrentGlyph, selectedProvider);
  const busy = Boolean(state.activeRun || state.newCourseRun || state.interruptedRun);
  const updating = state.activeRun?.action === "update";
  elements.teacherMenuButton.disabled = !state.providers.length;
  elements.teacherMenuButton.title = selectedProvider?.error || providerStatus(selectedProvider);
  elements.teacherMenuButton.setAttribute("aria-expanded", String(state.teacherMenuOpen));
  elements.providerPicker.hidden = !state.teacherMenuOpen;
  for (const button of elements.providerPicker.querySelectorAll("[data-provider]")) {
    const provider = state.providers.find((item) => item.id === button.dataset.provider);
    const selected = button.dataset.provider === state.selectedTeacher;
    button.disabled = !provider?.available || updating;
    button.setAttribute("aria-pressed", String(selected));
    button.title = provider?.error || providerStatus(provider);
    renderProviderGlyph(button.querySelector(".provider-glyph"), provider);
    const version = button.querySelector(`[data-provider-version="${button.dataset.provider}"]`);
    version.textContent = providerStatus(provider);
  }
  for (const button of elements.providerPicker.querySelectorAll("[data-update-provider]")) {
    const provider = state.providers.find((item) => item.id === button.dataset.updateProvider);
    button.disabled = !provider?.available || busy;
  }

  const settings = teacherSettings();
  const models = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
  elements.teacherModelInput.innerHTML = [
    '<option value="">CLI default</option>',
    ...models
      .filter((model) => model.id)
      .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`),
  ].join("");
  if (settings.model && !models.some((model) => model.id === settings.model)) {
    persistTeacherSetting(state.selectedTeacher, "model", "");
  }
  elements.teacherModelInput.value = teacherSettings().model;
  elements.teacherModelInput.disabled = !selectedProvider?.available || updating;
  const efforts = supportedTeacherEfforts(selectedProvider, settings.model);
  if (settings.effort && efforts.length && !efforts.includes(settings.effort)) {
    persistTeacherSetting(state.selectedTeacher, "effort", "");
  }
  elements.teacherEffortSelect.innerHTML = [
    '<option value="">CLI default</option>',
    ...efforts.map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`),
  ].join("");
  elements.teacherEffortSelect.value = teacherSettings().effort;
  elements.teacherEffortSelect.disabled = !selectedProvider?.available || updating;
  elements.teacherConfigHint.textContent = teacherConfigHint(selectedProvider);
  renderNewCourseTeacherFields(selectedProvider);
  elements.backToLibrary.disabled = false;
  renderMessages();
  renderRunRecoveryActions();
}

async function loadAnnotations({
  courseId = state.course?.id,
  navigationGeneration = state.navigationGeneration,
} = {}) {
  if (!courseId) return false;
  const payload = await api(`/api/courses/${encodeURIComponent(courseId)}/annotations`);
  if (state.navigationGeneration !== navigationGeneration || state.course?.id !== courseId) return false;
  state.annotations = payload.annotations;
  renderMessages();
  paintAnnotations();
  return true;
}

async function selectCourse(courseId, preferredDocument = null, navigationGeneration = state.navigationGeneration) {
  if (state.navigationGeneration !== navigationGeneration) return false;
  const changingCourse = state.course?.id !== courseId;
  const selectedCourse = state.courses.find((course) => course.id === courseId) || state.courses[0] || null;
  if (!selectedCourse) throw new Error("No teaching workspaces were found");
  state.course = selectedCourse;
  if (changingCourse) {
    state.expandedChapterId = null;
    state.documentPath = null;
    state.annotations = [];
    renderMessages();
  }
  persistPreference("margin:course", selectedCourse.id);
  const annotationsLoaded = await loadAnnotations({ courseId: selectedCourse.id, navigationGeneration });
  if (!annotationsLoaded || state.navigationGeneration !== navigationGeneration) return false;
  const saved = preference(`margin:document:${selectedCourse.id}`);
  const lectures = allLectures(selectedCourse);
  const candidates = [...lectures, ...selectedCourse.references].map((item) => item.path);
  const documentPath = [preferredDocument, saved].find((item) => item && candidates.includes(item)) || lectures.at(-1)?.path;
  return loadDocument(documentPath, { courseId: selectedCourse.id, navigationGeneration });
}

function reportCourseDiagnostics(diagnostics) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];
  const signature = items
    .map((item) => `${item?.id || "unknown"}:${item?.error || "unreadable"}`)
    .sort()
    .join("\n");
  if (!signature) {
    state.courseDiagnosticsSignature = "";
    return;
  }
  if (signature === state.courseDiagnosticsSignature) return;
  state.courseDiagnosticsSignature = signature;
  const names = items.map((item) => item?.id).filter(Boolean);
  showToast(
    names.length === 1
      ? `Course “${names[0]}” could not be opened. It stays listed in the library so it can be deleted.`
      : `${names.length} courses could not be opened: ${names.join(", ")}.`,
    { error: true },
  );
}

async function refreshCourses() {
  const payload = await api("/api/courses");
  state.courses = payload.courses;
  state.diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
  state.course = state.courses.find((course) => course.id === state.course?.id) || state.courses[0] || null;
  renderLibrary();
  reportCourseDiagnostics(payload.diagnostics);
}

async function loadDocument(documentPath, {
  hash = "",
  courseId = state.course?.id,
  navigationGeneration = state.navigationGeneration,
} = {}) {
  if (!state.course || !documentPath) return false;
  if (state.navigationGeneration !== navigationGeneration || state.course.id !== courseId) return false;
  const allowedDocuments = new Set([
    ...allLectures(state.course).map((item) => item.path),
    ...(state.course.references || []).map((item) => item.path),
  ]);
  if (!allowedDocuments.has(documentPath)) {
    showToast("This lecture link is not part of the selected course.", { error: true });
    return false;
  }
  hideSelectionPopover();
  closeComposer({ refreshLecture: false });
  state.documentPath = documentPath;
  state.staleLectures.delete(`${state.course.id}:${documentPath}`);
  const lecture = allLectures().find((item) => item.path === documentPath);
  if (lecture) state.expandedChapterId = lecture.chapterId;
  persistPreference(`margin:document:${state.course.id}`, documentPath);
  renderCourseRail();
  updateReaderMetadata();
  renderMessages();
  state.readerBridge = crypto.randomUUID();
  const encodedDocumentPath = documentPath.split("/").map(encodeURIComponent).join("/");
  const frameUrl = new URL(`/course/${encodeURIComponent(state.course.id)}/${encodedDocumentPath}`, contentOrigin);
  frameUrl.searchParams.set("bridge", state.readerBridge);
  frameUrl.searchParams.set("parent", window.location.origin);
  frameUrl.searchParams.set("v", String(Date.now()));
  if (typeof hash === "string" && hash.startsWith("#") && hash.length <= 2048) frameUrl.hash = hash.slice(1);
  elements.lessonFrame.src = frameUrl.href;
  refreshLectureHistory();
  return true;
}

function historyCommits() {
  return Array.isArray(state.lectureHistory?.commits) ? state.lectureHistory.commits : [];
}

function renderLectureHistoryButton() {
  const lesson = currentLesson();
  const key = lesson && state.course ? `${state.course.id}:${lesson.path}` : "";
  const history = key && state.historyRequestKey === key ? state.lectureHistory : null;
  const commits = history ? historyCommits() : [];
  const head = commits.find((commit) => commit.id === history?.head) || commits[0];
  elements.lectureHistoryButton.disabled = !lesson;
  elements.lectureHistoryButton.textContent = lesson ? `v${head?.version || commits.length || "…"}` : "v—";
  elements.lectureHistoryButton.title = lesson ? "Open lecture artifact history" : "History is available for lectures";
}

async function refreshLectureHistory() {
  const lesson = currentLesson();
  if (!state.course || !lesson) {
    state.lectureHistory = null;
    state.historyRequestKey = "";
    renderLectureHistoryButton();
    return null;
  }
  const courseId = state.course.id;
  const lessonPath = lesson.path;
  const requestKey = `${courseId}:${lessonPath}`;
  state.historyRequestKey = requestKey;
  state.lectureHistory = null;
  renderLectureHistoryButton();
  try {
    const payload = await api(`/api/courses/${encodeURIComponent(courseId)}/history?lesson=${encodeURIComponent(lessonPath)}`);
    const history = payload.history?.lectures?.find((item) => item.lesson === lessonPath) || payload.history || payload;
    if (state.course?.id !== courseId || state.documentPath !== lessonPath || state.historyRequestKey !== requestKey) return history;
    state.lectureHistory = history;
    renderLectureHistoryButton();
    if (!elements.historyView.hidden) renderHistoryView();
    return history;
  } catch (error) {
    if (state.historyRequestKey === requestKey) {
      elements.lectureHistoryButton.textContent = "v?";
      elements.lectureHistoryButton.title = error.message;
    }
    return null;
  }
}

function historyActionLabel(action) {
  return action === "create" || action === "next" ? "Created"
    : action === "revise" ? "Revised"
      : action === "restore" ? "Restored"
        : "Imported";
}

function historyProviderLabel(provider) {
  if (!provider) return "Margin import";
  return providerName(provider) || provider;
}

function renderHistoryView() {
  const lesson = currentLesson();
  const commits = [...historyCommits()].sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
  elements.historyTitle.textContent = lesson?.title || "Lecture history";
  elements.historySummary.textContent = commits.length
    ? `${commits.length} ${commits.length === 1 ? "version" : "versions"} · lecture HTML only`
    : "No tracked versions yet.";
  elements.historyList.innerHTML = commits.map((commit) => {
    const current = commit.id === state.lectureHistory?.head;
    const date = new Date(commit.timestamp || commit.at || Date.now());
    const configuration = [historyProviderLabel(commit.provider), commit.model, commit.effort].filter(Boolean).join(" · ");
    return `
      <li class="history-commit" ${current ? 'data-current="true"' : ""}>
        <button class="history-commit-main" type="button" data-history-preview="${escapeHtml(commit.id)}">
          <span class="history-version">v${escapeHtml(commit.version || "?")}</span>
          <span><strong>${escapeHtml(historyActionLabel(commit.action))}${current ? " · Current" : ""}</strong>
            <small>${escapeHtml(date.toLocaleString())}</small></span>
          <code>${escapeHtml(String(commit.hash || "").slice(0, 10))}</code>
        </button>
        <div class="history-commit-meta">
          <span>${escapeHtml(configuration)}</span>
          <button type="button" data-history-restore="${escapeHtml(commit.id)}" ${current || state.activeRun ? "disabled" : ""}>Restore</button>
        </div>
      </li>
    `;
  }).join("");
}

async function previewHistoryCommit(commitId) {
  const lesson = currentLesson();
  if (!state.course || !lesson) return;
  const bridge = crypto.randomUUID();
  elements.historyPreviewFrame.src = `${contentOrigin}/history/${encodeURIComponent(state.course.id)}?lesson=${encodeURIComponent(lesson.path)}&commit=${encodeURIComponent(commitId)}&bridge=${encodeURIComponent(bridge)}&parent=${encodeURIComponent(window.location.origin)}`;
  elements.historyPreviewFrame.hidden = false;
  elements.historyPreviewEmpty.hidden = true;
  state.historyPreviewCommit = commitId;
  for (const item of elements.historyList.querySelectorAll("[data-history-preview]")) {
    item.closest(".history-commit")?.toggleAttribute("data-previewing", item.dataset.historyPreview === commitId);
  }
}

async function openHistoryView() {
  if (!currentLesson()) return;
  if (!state.lectureHistory) await refreshLectureHistory();
  elements.historyView.hidden = false;
  document.body.classList.add("history-open");
  renderHistoryView();
  const head = historyCommits().find((commit) => commit.id === state.lectureHistory?.head) || historyCommits()[0];
  if (head) previewHistoryCommit(head.id).catch((error) => showToast(error.message, { error: true }));
  elements.closeHistory.focus();
}

function closeHistoryView() {
  if (elements.historyView.hidden) return;
  elements.historyView.hidden = true;
  elements.historyPreviewFrame.removeAttribute("src");
  elements.historyPreviewFrame.hidden = true;
  elements.historyPreviewEmpty.hidden = false;
  state.historyPreviewCommit = "";
  document.body.classList.remove("history-open");
  elements.lectureHistoryButton.focus();
}

async function restoreHistoryCommit(commitId) {
  const lesson = currentLesson();
  if (!state.course || !lesson || state.activeRun || state.newCourseRun || state.interruptedRun) return;
  const courseId = state.course.id;
  const navigationGeneration = state.navigationGeneration;
  try {
    await api(`/api/courses/${encodeURIComponent(courseId)}/history/restore`, {
      method: "POST",
      body: JSON.stringify({ lesson: lesson.path, commit: commitId }),
    });
    await refreshCourses();
    if (state.navigationGeneration !== navigationGeneration || state.course?.id !== courseId) {
      showToast("Lecture restored in the background.");
      return;
    }
    await loadAnnotations();
    await loadDocument(lesson.path);
    await refreshLectureHistory();
    renderHistoryView();
    showToast("Lecture restored as a new version.");
  } catch (error) {
    showToast(error.message, { error: true });
  }
}

function showSelectionPopover(capture) {
  if (!capture) return hideSelectionPopover();
  state.selectionCandidate = capture;
  const frameRect = elements.lessonFrame.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 100, Math.max(100, frameRect.left + capture.rect.left + capture.rect.width / 2));
  const top = Math.max(56, frameRect.top + capture.rect.top - 8);
  elements.selectionPopover.style.left = `${left}px`;
  elements.selectionPopover.style.top = `${top}px`;
  elements.selectionPopover.hidden = false;
}

function hideSelectionPopover() {
  elements.selectionPopover.hidden = true;
  state.selectionCandidate = null;
}

function openComposer() {
  const pending = state.selectionCandidate;
  if (!pending) return;
  if (state.rightPanelCollapsed) setPanelState({ right: false });
  state.pendingSelection = pending;
  elements.selectionPopover.hidden = true;
  state.selectionCandidate = null;
  elements.selectedQuote.textContent = clip(pending.quote, 440);
  elements.selectedContext.hidden = false;
  elements.messageInput.focus();
}

function clearImage() {
  state.pendingImage = null;
  elements.imageInput.value = "";
  elements.imagePreview.hidden = true;
  elements.imagePreviewImg.removeAttribute("src");
  elements.imagePreviewName.textContent = "";
  elements.imagePreviewSize.textContent = "";
}

function closeComposer({ refreshLecture = true } = {}) {
  elements.messageInput.value = "";
  elements.selectedContext.hidden = true;
  elements.selectedQuote.textContent = "";
  clearImage();
  state.pendingSelection = null;
  if (refreshLecture) {
    queueMicrotask(() => refreshStaleCurrentLecture().catch((error) => showToast(error.message, { error: true })));
  }
}

async function refreshStaleCurrentLecture() {
  if (state.view !== "reader" || !state.course || !state.documentPath) return false;
  if (state.pendingSelection || state.pendingImage || elements.messageInput.value.trim()) return false;
  const key = `${state.course.id}:${state.documentPath}`;
  if (!state.staleLectures.has(key)) return false;
  await loadDocument(state.documentPath);
  return true;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function attachImageFile(file) {
  const acceptedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!file || !acceptedTypes.has(file.type)) {
    showToast("Choose a PNG, JPEG, or WebP image.", { error: true });
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast("Images must be 5 MB or smaller.", { error: true });
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(new Error("The image could not be read.")), { once: true });
    reader.readAsDataURL(file);
  });
  state.pendingImage = { dataUrl, name: file.name || "Pasted image", size: file.size };
  elements.imagePreviewImg.src = dataUrl;
  elements.imagePreviewName.textContent = state.pendingImage.name;
  elements.imagePreviewSize.textContent = formatBytes(file.size);
  elements.imagePreview.hidden = false;
}

async function saveMessage() {
  const pending = state.pendingSelection;
  const message = elements.messageInput.value.trim();
  const image = state.pendingImage;
  if (!currentLesson()) {
    showToast("Open a lecture before adding a note.", { error: true });
    return;
  }
  if (!message && !image) {
    showToast("Write a note or attach an image before saving.", { error: true });
    return;
  }
  const courseId = state.course.id;
  const lessonPath = state.documentPath;
  const navigationGeneration = state.navigationGeneration;
  elements.saveMessage.disabled = true;
  try {
    await api(`/api/courses/${encodeURIComponent(courseId)}/annotations`, {
      method: "POST",
      body: JSON.stringify({
        lesson: lessonPath,
        quote: pending?.quote || "",
        message,
        anchor: pending?.anchor || null,
        image: image ? { dataUrl: image.dataUrl, name: image.name } : undefined,
      }),
    });
    if (state.navigationGeneration !== navigationGeneration || state.course?.id !== courseId || state.documentPath !== lessonPath) {
      showToast("Saved in the previous lecture's margin.");
      return;
    }
    closeComposer({ refreshLecture: false });
    await loadAnnotations();
    await refreshStaleCurrentLecture();
    showToast("Saved in the margin.");
  } catch (error) {
    showToast(error.message, { error: true });
  } finally {
    elements.saveMessage.disabled = false;
  }
}

async function removeAnnotation(annotationId) {
  if (!window.confirm("Delete this note?")) return;
  try {
    await api(`/api/courses/${encodeURIComponent(state.course.id)}/annotations/${encodeURIComponent(annotationId)}`, { method: "DELETE" });
    await loadAnnotations();
    showToast("Note deleted.");
  } catch (error) {
    showToast(error.message, { error: true });
  }
}

function paintAnnotations() {
  const annotations = state.annotations
    .filter((item) => item.lesson === state.documentPath && compactText(item.quote))
    .map(readerAnnotation);
  postReader("paint", { annotations });
}

function readerAnnotation(annotation) {
  const anchor = annotation?.anchor;
  return {
    quote: String(annotation?.quote || ""),
    anchor: anchor ? {
      startPath: anchor.startPath,
      startOffset: anchor.startOffset,
      endPath: anchor.endPath,
      endOffset: anchor.endOffset,
    } : null,
  };
}

function focusAnnotation(annotationId) {
  const annotation = state.annotations.find((item) => item.id === annotationId);
  if (!annotation?.quote) return;
  postReader("focus", { annotation: readerAnnotation(annotation) });
}

function postReader(type, value = {}) {
  if (!state.readerBridge || !contentOrigin || !elements.lessonFrame.contentWindow) return;
  // A sandboxed reader has an opaque origin, so targetOrigin cannot name it.
  // Authenticate with the exact contentWindow and per-load nonce, and only send
  // reader-safe payloads because lecture scripts share the frame.
  elements.lessonFrame.contentWindow.postMessage({ marginBridge: state.readerBridge, type, ...value }, "*");
}

function receiveReaderMessage(event) {
  const data = event.data;
  if (event.source !== elements.lessonFrame.contentWindow || !data || data.marginBridge !== state.readerBridge) return;
  if (data.type === "selection") showSelectionPopover(data.selection);
  if (data.type === "selection-clear") hideSelectionPopover();
  if (data.type === "focus-missed") showToast("This passage changed and could not be reattached. The message is still safe in the margin.", { error: true });
  if (data.type === "navigate" && typeof data.path === "string") loadDocument(data.path, { hash: data.hash || "" });
  if (data.type === "loaded") {
    applyWorkspaceScale();
    paintAnnotations();
  }
}

function chooseProvider(providerId) {
  if (!state.providers.find((provider) => provider.id === providerId)?.available || state.activeRun?.action === "update") return;
  state.selectedTeacher = providerId;
  persistPreference("margin:teacher", providerId);
  renderProviders();
}

function chooseTeacherModel(model) {
  const provider = state.providers.find((item) => item.id === state.selectedTeacher);
  persistTeacherSetting(state.selectedTeacher, "model", model);
  const efforts = supportedTeacherEfforts(provider, model);
  if (teacherSettings().effort && efforts.length && !efforts.includes(teacherSettings().effort)) {
    persistTeacherSetting(state.selectedTeacher, "effort", "");
  }
  renderProviders();
}

function chooseTeacherEffort(effort) {
  persistTeacherSetting(state.selectedTeacher, "effort", effort);
  renderProviders();
}

function updateTeacherModel() {
  chooseTeacherModel(elements.teacherModelInput.value.trim());
}

function updateTeacherEffort() {
  chooseTeacherEffort(elements.teacherEffortSelect.value);
}

function toggleTeacherMenu() {
  if (elements.teacherMenuButton.disabled) return;
  if (state.teacherMenuOpen) {
    closeTeacherMenu({ restoreFocus: true });
    return;
  }
  state.teacherMenuOpen = true;
  renderProviders();
}

function closeTeacherMenu({ restoreFocus = false } = {}) {
  if (!state.teacherMenuOpen) return;
  if (elements.providerPicker.contains(document.activeElement)) document.activeElement.blur();
  state.teacherMenuOpen = false;
  renderProviders();
  if (restoreFocus) elements.teacherMenuButton.focus({ preventScroll: true });
}

function backgroundRun() {
  return state.activeRun || state.newCourseRun;
}

function runTitle(run) {
  if (run.action === "create") return `${providerName(run.provider)} · new course`;
  return `${providerName(run.provider)} · ${run.action === "revise" ? "revision" : "next lecture"}`;
}

function renderRunRecoveryActions() {
  const run = state.interruptedRun;
  elements.runRecoveryActions.hidden = !run;
  if (!run) return;
  const sameProvider = state.providers.find((provider) => provider.id === run.provider);
  const alternateId = run.provider === "claude" ? "codex" : "claude";
  const alternateProvider = state.providers.find((provider) => provider.id === alternateId);
  elements.resumeRun.textContent = `${run.sessionId ? "Resume" : "Retry"} ${providerName(run.provider)}`;
  elements.resumeRun.disabled = run.abandoning || !run.handoffId || !providerReady(sameProvider);
  elements.resumeRun.title = sameProvider?.error || "Continue the saved teacher session and filesystem checkpoint";
  elements.switchRun.textContent = `Switch to ${providerName(alternateId)}`;
  elements.switchRun.dataset.provider = alternateId;
  elements.switchRun.disabled = run.abandoning || !run.handoffId || !providerReady(alternateProvider);
  elements.switchRun.title = alternateProvider?.error || "Start the other teacher with the saved filesystem checkpoint";
  elements.abandonRun.disabled = run.abandoning || !run.handoffId;
  elements.abandonRun.textContent = run.abandoning ? "Abandoning…" : "Abandon";
}

function placeTeacherRun() {
  if (state.view === "library") {
    if (elements.teacherRun.parentElement !== elements.libraryTaskHost) {
      elements.libraryTaskHost.append(elements.teacherRun);
    }
    elements.libraryTaskHost.hidden = elements.teacherRun.hidden;
    return;
  }
  if (elements.teacherRun.nextElementSibling !== elements.teacherDock) {
    elements.teacherDock.before(elements.teacherRun);
  }
  elements.libraryTaskHost.hidden = true;
}

function setRunState(kind, text) {
  const run = backgroundRun();
  const interrupted = state.interruptedRun;
  const cancelling = run?.phase === "cancelling";
  const finishing = run?.phase === "committed" || run?.phase === "opening";
  const awaitingReceipt = kind === "running" && run && ["create", "revise", "next"].includes(run.action) && !run.operationId;
  const updateInProgress = kind === "running" && run?.action === "update";
  const checkpointSummary = interrupted?.hasPartialWork ? "partial work saved" : "a checkpoint saved";
  elements.teacherRun.hidden = false;
  placeTeacherRun();
  elements.teacherRun.dataset.state = kind;
  elements.runDetailsView.dataset.state = kind;
  elements.cancelRun.hidden = updateInProgress || Boolean(interrupted);
  elements.cancelRun.disabled = cancelling || finishing || awaitingReceipt;
  elements.cancelRun.textContent = cancelling ? "Pausing…" : finishing ? "Finishing…" : kind === "running" || run ? "Pause" : "Dismiss";
  elements.runActivity.textContent = updateInProgress
    ? "Update in progress."
    : cancelling
    ? "Saving a checkpoint and stopping…"
    : kind === "running"
    ? "Working in the background…"
    : kind === "done"
    ? "Finished in the background."
    : kind === "paused"
    ? `Paused with ${checkpointSummary}.`
    : interrupted ? `Interrupted with ${checkpointSummary}.` : "Teacher stopped.";
  elements.runDetailTitle.textContent = elements.runTitle.textContent;
  elements.runDetailActivity.textContent = updateInProgress
    ? `Update in progress${text ? ` · ${text}` : "."}`
    : text;
  renderRunRecoveryActions();
}

function openRunDetails() {
  elements.runDetailTitle.textContent = elements.runTitle.textContent;
  elements.runDetailsView.hidden = false;
  document.body.classList.add("run-details-open");
  elements.closeRunDetails.focus();
}

function closeRunDetails() {
  if (elements.runDetailsView.hidden) return;
  elements.runDetailsView.hidden = true;
  document.body.classList.remove("run-details-open");
  elements.openRunDetails.focus();
}

function boundedLogText(value) {
  const bytes = textEncoder.encode(String(value || "").trim());
  if (bytes.length <= MAX_RUN_LOG_BYTES) return textDecoder.decode(bytes);
  const ellipsisBytes = textEncoder.encode("…").length;
  let end = MAX_RUN_LOG_BYTES - ellipsisBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${textDecoder.decode(bytes.subarray(0, end))}…`;
}

function resetRunLog() {
  elements.runLog.innerHTML = "";
  state.runLogBytes = 0;
  state.lastRunLogText = "";
  state.lastRunLogKind = "";
  state.lastRunLogCount = 0;
}

function trimRunLog() {
  while (state.runLogBytes > MAX_RUN_LOG_BYTES && elements.runLog.children.length > 1) {
    const oldest = elements.runLog.firstElementChild;
    state.runLogBytes -= Number(oldest.dataset.bytes || 0);
    oldest.remove();
  }
}

function appendRunLog(text, kind = "activity") {
  if (!text) return;
  const value = boundedLogText(text);
  const entryKind = kind === "message" ? "summary" : kind;
  const last = elements.runLog.lastElementChild;
  if (last && value === state.lastRunLogText && entryKind === state.lastRunLogKind) {
    state.lastRunLogCount += 1;
    const previousBytes = Number(last.dataset.bytes || 0);
    const rendered = boundedLogText(`${value} ×${state.lastRunLogCount}`);
    const byteLength = textEncoder.encode(rendered).length;
    last.querySelector(".run-log-text").textContent = rendered;
    last.dataset.bytes = String(byteLength);
    state.runLogBytes += byteLength - previousBytes;
    trimRunLog();
    elements.runLog.scrollTop = elements.runLog.scrollHeight;
    return;
  }

  state.lastRunLogText = value;
  state.lastRunLogKind = entryKind;
  state.lastRunLogCount = 1;
  const byteLength = textEncoder.encode(value).length;
  const line = document.createElement("div");
  line.className = "run-log-entry";
  line.dataset.kind = entryKind;
  line.dataset.bytes = String(byteLength);
  const marker = document.createElement("span");
  marker.className = "run-log-marker";
  marker.setAttribute("aria-hidden", "true");
  const content = document.createElement("span");
  content.className = "run-log-text";
  content.textContent = value;
  line.append(marker, content);
  elements.runLog.appendChild(line);
  state.runLogBytes += byteLength;
  trimRunLog();
  elements.runLog.scrollTop = elements.runLog.scrollHeight;
}

async function refreshProviders() {
  const payload = await api("/api/providers");
  state.providers = payload.providers;
  renderProviders();
  return state.providers;
}

async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function applyTeacherCompletion({ action, courseId, lesson }, completedEvent) {
  const stayedWithTask = state.view === "reader" && state.course?.id === courseId && state.documentPath === lesson;
  const preserveMarginDraft = Boolean(state.pendingSelection || state.pendingImage || elements.messageInput.value.trim());
  if (action === "revise") state.staleLectures.add(`${courseId}:${completedEvent.lesson}`);
  await refreshCourses();
  if (state.view === "reader" && state.course) await loadAnnotations();
  if (stayedWithTask && state.course?.id === courseId && !preserveMarginDraft) {
    await loadDocument(completedEvent.lesson);
    showTaskCompletion(action === "revise" ? "Lecture revised." : "Next lecture created.");
  } else if (state.view === "reader" && state.course) {
    renderCourseRail();
    updateReaderMetadata();
    renderMessages();
    showTaskCompletion(preserveMarginDraft ? "Teacher finished. Your open margin draft was kept." : "Teacher finished in the background.");
  } else {
    showTaskCompletion("Teacher finished in the background.");
  }
}

function applyTeacherInterruption(run, failure, fallbackMessage = "Teacher stopped before completing the task.") {
  const message = failure?.message || fallbackMessage;
  if (!failure?.handoffId) {
    appendRunLog(message, "error");
    setRunState("error", message);
    showToast(message, { error: true });
    return false;
  }
  run.phase = "interrupted";
  state.interruptedRun = {
    action: run.action,
    courseId: run.courseId || "",
    chapterId: run.chapterId || "",
    lesson: run.lesson || "",
    annotationIds: [...(run.annotationIds || [])],
    title: run.title || "",
    initialRequest: run.initialRequest || "",
    provider: failure.provider || run.provider,
    model: run.model || "",
    effort: run.effort || "",
    handoffId: failure.handoffId,
    sessionId: failure.sessionId || "",
    kind: failure.kind || "failed",
    hasPartialWork: Boolean(failure.hasPartialWork),
    message,
  };
  elements.runTitle.textContent = runTitle(state.interruptedRun);
  appendRunLog(message, failure.kind === "paused" ? "status" : "error");
  setRunState(failure.kind === "paused" ? "paused" : "error", message);
  showToast(message, { error: failure.kind !== "paused" });
  return true;
}

async function adoptTeacherInterruption(run, failure, previousRecovery = null, fallbackMessage = "") {
  if (!failure?.handoffId && previousRecovery?.handoffId) {
    return restoreTeacherInterruption(previousRecovery, failure?.message || fallbackMessage);
  }
  if (previousRecovery?.handoffId && previousRecovery.handoffId !== failure?.handoffId) {
    await clearOperation(previousRecovery.handoffId);
  }
  return applyTeacherInterruption(run, failure, fallbackMessage);
}

function restoreTeacherInterruption(recovery, reason) {
  if (!recovery?.handoffId) return false;
  state.interruptedRun = { ...recovery, annotationIds: [...(recovery.annotationIds || [])] };
  elements.runTitle.textContent = runTitle(state.interruptedRun);
  const message = `${reason} The saved checkpoint is still available.`;
  appendRunLog(message, "error");
  setRunState(recovery.kind === "paused" ? "paused" : "error", message);
  showToast(message, { error: true });
  return true;
}

async function continueInterruptedRun(provider) {
  const recovery = state.interruptedRun;
  if (!recovery || recovery.abandoning) return;
  if (recovery.action === "create") {
    await createNewCourse(null, { recovery, providerOverride: provider });
  } else {
    await runTeacher(recovery.action, { recovery, providerOverride: provider });
  }
}

async function abandonInterruptedRun() {
  const recovery = state.interruptedRun;
  if (!recovery?.handoffId || recovery.abandoning) return;
  recovery.abandoning = true;
  renderRunRecoveryActions();
  try {
    const response = await fetch(`/api/teacher-handoffs/${encodeURIComponent(recovery.handoffId)}`, {
      method: "DELETE",
      headers: authenticatedHeaders(),
    });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Checkpoint removal failed (${response.status})`);
    }
    await clearOperation(recovery.handoffId);
    if (state.interruptedRun !== recovery) return;
    state.interruptedRun = null;
    closeRunDetails();
    elements.teacherRun.hidden = true;
    placeTeacherRun();
    resetRunLog();
    renderProviders();
    schedulePendingOperationReconciliation();
    showToast(recovery.hasPartialWork ? "Partial teacher progress abandoned." : "Teacher checkpoint abandoned.");
  } catch (error) {
    recovery.abandoning = false;
    renderRunRecoveryActions();
    showToast(`Could not abandon the checkpoint: ${error.message}`, { error: true });
  }
}

function selectedTeacherAnnotationIds(action, chapter, lesson) {
  const chapterLessons = new Set(chapter.lectures.map((item) => item.path));
  return state.annotations
    .filter((annotation) => !annotation.uses?.length)
    .filter((annotation) => action === "revise" ? annotation.lesson === lesson : chapterLessons.has(annotation.lesson))
    .map((annotation) => annotation.id)
    .sort();
}

async function runTeacher(action, { recovery = null, providerOverride = "" } = {}) {
  if (state.activeRun || state.newCourseRun) return;
  if (!recovery && state.interruptedRun) {
    openRunDetails();
    return;
  }
  if (!recovery && !currentLesson()) return;
  if (recovery && state.interruptedRun?.handoffId !== recovery.handoffId) return;
  const previousRecovery = recovery
    ? { ...recovery, annotationIds: [...(recovery.annotationIds || [])] }
    : null;
  const provider = providerOverride || recovery?.provider || state.selectedTeacher;
  const checkedProvider = state.providers.find((item) => item.id === provider);
  if (!providerReady(checkedProvider)) {
    showToast(checkedProvider?.error || "The selected teacher is not ready.", { error: true });
    return;
  }
  const controller = new AbortController();
  const chapter = recovery ? null : currentChapter();
  if (!recovery && !chapter) return;
  const courseId = recovery?.courseId || state.course.id;
  const lesson = recovery?.lesson || state.documentPath;
  const chapterId = recovery?.chapterId || chapter.id;
  const sameTeacherResume = Boolean(recovery && provider === recovery.provider && recovery.sessionId);
  const settings = sameTeacherResume
    ? { model: recovery.model || "", effort: recovery.effort || "" }
    : { ...teacherSettings(provider) };
  const { model, effort } = settings;
  const annotationIds = recovery ? [...(recovery.annotationIds || [])] : selectedTeacherAnnotationIds(action, chapter, lesson);
  const handoffId = recovery?.handoffId || "";
  const resumeSessionId = sameTeacherResume ? recovery.sessionId : "";
  state.selectedTeacher = provider;
  persistPreference("margin:teacher", provider);
  state.interruptedRun = null;
  closeTeacherMenu();
  const run = {
    controller,
    phase: "running",
    action,
    courseId,
    chapterId,
    lesson,
    annotationIds,
    provider,
    model,
    effort,
    operationId: "",
    cancelRequested: false,
    handoffId,
    resumeSessionId,
  };
  state.activeRun = run;
  resetRunLog();
  elements.runTitle.textContent = `${providerName(provider)} · ${action === "revise" ? "revision" : "next lecture"}`;
  const runConfiguration = [model || "default model", effort ? `${effort} thinking` : "default thinking"].join(" · ");
  setRunState("running", `Starting with ${runConfiguration}…`);
  renderProviders();
  let completedEvent = null;
  let committed = false;
  let operationId = "";

  try {
    const signature = await operationSignature([action, courseId, chapterId, lesson, provider, model, effort, annotationIds, handoffId, resumeSessionId]);
    operationId = await operationForRequest(signature, {
      kind: "teacher",
      action,
      courseId,
      chapterId,
      lesson,
      provider,
      model,
      effort,
      annotationIds,
      handoffId,
    });
    run.operationId = operationId;
    elements.cancelRun.disabled = false;
    const response = await fetch("/api/teacher", {
      method: "POST",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({
        provider,
        action,
        course: courseId,
        chapter: chapterId,
        lesson,
        model,
        effort,
        annotationIds,
        operationId,
        handoffId,
        resumeSessionId,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Teacher action failed (${response.status})`);
    }
    await readNdjson(response, (event) => {
      if (event.type === "error") {
        const teacherError = new Error(event.text);
        teacherError.interruption = event.interruption || null;
        throw teacherError;
      }
      if (event.type === "complete") {
        completedEvent = event;
        committed = true;
        if (state.activeRun?.controller === controller) state.activeRun.phase = "committed";
        if (event.text && (state.lastRunLogKind !== "summary" || state.lastRunLogText !== event.text)) {
          appendRunLog(event.text, "summary");
        }
        setRunState("done", action === "revise" ? "Lecture revised." : "Next lecture created.");
        return;
      }
      if (event.type === "started") setRunState("running", event.text);
      if (event.type === "status" || event.type === "activity") {
        elements.runDetailActivity.textContent = event.text;
        appendRunLog(event.text, event.type);
      }
      if (event.type === "summary" || event.type === "message") appendRunLog(event.text, "summary");
    });
    if (!completedEvent) throw new Error("The teacher stopped without completing the action");
    await clearRunReceipts(operationId, handoffId);
    await applyTeacherCompletion(run, completedEvent);
  } catch (error) {
    if (!committed && operationId) {
      const resolution = await reconcileOperation(operationId, { courseId });
      if (resolution.status === "complete") {
        completedEvent = resolution.event;
        committed = true;
        if (state.activeRun?.controller === controller) state.activeRun.phase = "committed";
        appendRunLog(completedEvent.text || "Teacher action completed.", "summary");
        setRunState("done", action === "revise" ? "Lecture revised." : "Next lecture created.");
        await clearRunReceipts(operationId, handoffId);
        try {
          await applyTeacherCompletion(run, completedEvent);
          return;
        } catch (refreshError) {
          error = refreshError;
        }
      } else if (resolution.status === "failed") {
        await adoptTeacherInterruption(run, resolution.failure, previousRecovery, error.message);
        return;
      } else if (resolution.status === "running") {
        setRunState("running", "The activity stream changed; teaching continues safely in the background.");
        const terminal = await waitForOperationTerminal(operationId, {
          courseId,
          onRunning: (_task, connectionError) => {
            if (connectionError) setRunState("running", "Reconnecting to the background teacher…");
          },
        });
        if (terminal.status === "complete") {
          completedEvent = terminal.event;
          committed = true;
          if (state.activeRun?.controller === controller) state.activeRun.phase = "committed";
          appendRunLog(completedEvent.text || "Teacher action completed.", "summary");
          setRunState("done", action === "revise" ? "Lecture revised." : "Next lecture created.");
          await clearRunReceipts(operationId, handoffId);
          try {
            await applyTeacherCompletion(run, completedEvent);
            return;
          } catch (refreshError) {
            error = refreshError;
          }
        } else if (terminal.status === "failed") {
          await adoptTeacherInterruption(run, terminal.failure, previousRecovery, error.message);
          return;
        } else if (terminal.status === "unknown") {
          await clearOperation(operationId);
        } else {
          const detail = terminal.error ? ` ${terminal.error.message}` : "";
          const message = `Margin could not confirm whether the teacher saved its work.${detail}`;
          appendRunLog(message, "summary");
          setRunState("error", message);
          showToast(message, { error: true });
          return;
        }
      } else if (resolution.status === "unknown") {
        await clearOperation(operationId);
      } else {
        const detail = resolution.error ? ` ${resolution.error.message}` : "";
        const message = `Margin could not confirm whether the teacher saved its work.${detail} Reopen this course before trying again; the same action will reuse its operation safely.`;
        appendRunLog(message, "summary");
        setRunState("error", message);
        showToast(message, { error: true });
        return;
      }
    }
    if (committed) {
      const message = `${action === "revise" ? "The revision" : "The next lecture"} was saved, but Margin could not open or refresh it: ${error.message}. Do not run the teacher again; reopen the course or restart Margin.`;
      appendRunLog(message, "summary");
      setRunState("done", message);
      showToast(message, { error: true });
      return;
    }
    if (error.interruption) {
      await adoptTeacherInterruption(run, error.interruption, previousRecovery, error.message);
      return;
    }
    if (restoreTeacherInterruption(previousRecovery, error.message)) return;
    if (!controller.signal.aborted) controller.abort();
    const message = run.cancelRequested || error.name === "AbortError" ? "Teacher action cancelled." : error.message;
    if (state.activeRun?.controller === controller) state.activeRun.phase = "settled";
    setRunState("error", message);
    showToast(message, { error: true });
  } finally {
    state.activeRun = null;
    elements.cancelRun.disabled = false;
    if (elements.teacherRun.dataset.state !== "running") elements.cancelRun.textContent = "Dismiss";
    renderProviders();
    schedulePendingOperationReconciliation();
  }
}

async function runProviderUpdate(provider) {
  if (state.activeRun || state.newCourseRun) return;
  if (state.interruptedRun) {
    openRunDetails();
    return;
  }
  const installed = state.providers.find((item) => item.id === provider);
  if (!installed?.available) {
    showToast(`${providerName(provider)} is not installed.`, { error: true });
    return;
  }

  const controller = new AbortController();
  closeTeacherMenu();
  state.activeRun = { controller, phase: "running", action: "update", provider };
  resetRunLog();
  elements.runTitle.textContent = `${providerName(provider)} · check & update`;
  setRunState("running", "Checking the installed CLI…");
  renderProviders();
  let completedEvent = null;

  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(provider)}/update`, {
      method: "POST",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Update failed (${response.status})`);
    }
    await readNdjson(response, (event) => {
      if (event.type === "error") throw new Error(event.text);
      if (event.type === "complete") {
        completedEvent = event;
        if (state.activeRun?.controller === controller) state.activeRun.phase = "committed";
        if (event.text && (state.lastRunLogKind !== "summary" || state.lastRunLogText !== event.text)) {
          appendRunLog(event.text, "summary");
        }
        setRunState("done", event.text || "Update complete.");
        return;
      }
      if (event.type === "started") setRunState("running", event.text);
      if (event.type === "activity" || event.type === "status" || event.type === "message" || event.type === "summary") {
        elements.runDetailActivity.textContent = `Update in progress${event.text ? ` · ${event.text}` : "."}`;
        appendRunLog(event.text, event.type);
      }
    });
    if (!completedEvent) throw new Error("The update stopped without completing");
    await refreshProviders();
    showTaskCompletion(completedEvent.text || `${providerName(provider)} update complete.`);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort();
    const message = error.name === "AbortError" ? "Update cancelled." : error.message;
    if (state.activeRun?.controller === controller) state.activeRun.phase = "settled";
    setRunState("error", message);
    showToast(message, { error: true });
  } finally {
    state.activeRun = null;
    elements.cancelRun.disabled = false;
    if (elements.teacherRun.dataset.state !== "running") elements.cancelRun.textContent = "Dismiss";
    renderProviders();
    schedulePendingOperationReconciliation();
  }
}

async function cancelRun() {
  if (state.newCourseRun) {
    await cancelNewCourseCreation({ mode: "pause" });
    return;
  }
  if (state.activeRun?.action === "update") return;
  if (state.activeRun?.phase === "running") {
    const run = state.activeRun;
    run.phase = "cancelling";
    setRunState("running", "Saving a checkpoint and pausing the teacher…");
    try {
      const result = await requestOperationCancellation(run, { courseId: run.courseId || "", mode: "pause" });
      if (state.activeRun !== run) return;
      if (result.status === "finishing" || result.status === "complete") {
        run.phase = "committed";
        setRunState("running", "Final validation has begun; Margin will keep the result if it completes.");
      }
    } catch (error) {
      if (state.activeRun === run) {
        run.cancelRequested = false;
        run.phase = "running";
        setRunState("running", "Teaching continues in the background.");
      }
      showToast(`Could not request cancellation: ${error.message}`, { error: true });
    }
  }
  else if (!state.activeRun) {
    closeRunDetails();
    elements.teacherRun.hidden = true;
    placeTeacherRun();
  }
}

function applyPreferences(settings) {
  preferences = settings && typeof settings === "object" ? settings : {};
  state.selectedTeacher = preference("margin:teacher", "claude");
  for (const provider of ["claude", "codex"]) {
    state.teacherSettings[provider].model = preference(`margin:teacher:${provider}:model`);
    state.teacherSettings[provider].effort = preference(`margin:teacher:${provider}:effort`);
  }
  state.leftPanelCollapsed = preference("margin:panel:left") === "true";
  state.rightPanelCollapsed = preference("margin:panel:right") === "true";
  state.coursePanelWidth = Number(preference("margin:panel:course-width")) || null;
  state.marginPanelWidth = Number(preference("margin:panel:margin-width")) || null;
  state.workspaceScale = Math.min(1.4, Math.max(0.8, Number(preference("margin:workspace-scale")) || 1));
  renderPanelWidths();
  renderPanelState();
  renderWorkspaceScale();
}

async function resumePendingTeacherOperation(entry, task = {}) {
  const controller = new AbortController();
  const provider = task.provider || entry.provider || state.selectedTeacher;
  const run = {
    controller,
    phase: "running",
    action: entry.action,
    courseId: entry.courseId,
    chapterId: entry.chapterId || "",
    lesson: entry.lesson,
    annotationIds: [...(entry.annotationIds || [])],
    provider,
    model: entry.model || "",
    effort: entry.effort || "",
    handoffId: entry.handoffId || "",
    operationId: entry.id,
    cancelRequested: false,
    resumed: true,
  };
  state.activeRun = run;
  await openCourse(entry.courseId, entry.lesson).catch((error) => {
    showToast(`The teacher is still running, but its course could not be opened yet: ${error.message}`, { error: true });
  });
  resetRunLog();
  elements.runTitle.textContent = `${providerName(provider)} · ${entry.action === "revise" ? "revision" : "next lecture"}`;
  setRunState("running", task.notice || "Reconnected to a teacher already working in the background.");
  if (task.notice) appendRunLog(task.notice, "status");
  renderProviders();

  try {
    const result = await waitForOperationTerminal(entry.id, {
      courseId: entry.courseId,
      onRunning: (activeTask, connectionError) => {
        if (connectionError) setRunState("running", "Reconnecting to the background teacher…");
        else if (activeTask?.notice) {
          setRunState("running", activeTask.notice);
          appendRunLog(activeTask.notice, "status");
        }
      },
    });
    if (result.status === "complete") {
      run.phase = "committed";
      appendRunLog(result.event.text || "Teacher action completed.", "summary");
      setRunState("done", entry.action === "revise" ? "Lecture revised." : "Next lecture created.");
      await clearRunReceipts(entry.id, run.handoffId);
      await applyTeacherCompletion(run, result.event);
      return;
    }
    if (result.status === "failed") {
      await adoptTeacherInterruption(run, result.failure, run.handoffId ? { handoffId: run.handoffId } : null);
      return;
    }
    if (result.status === "unknown") {
      await clearOperation(entry.id);
      const message = run.cancelRequested ? "Teacher action cancelled." : "The unfinished teacher action stopped without saving a lecture.";
      appendRunLog(message, "summary");
      setRunState("error", message);
    }
  } catch (error) {
    appendRunLog(error.message, "summary");
    setRunState("error", error.message);
    showToast(error.message, { error: true });
  } finally {
    if (state.activeRun === run) state.activeRun = null;
    renderProviders();
    schedulePendingOperationReconciliation();
  }
}

async function resumePendingCourseCreation(entry, task = {}) {
  const controller = new AbortController();
  const provider = task.provider || entry.provider || state.selectedTeacher;
  const run = {
    controller,
    phase: "running",
    action: "create",
    provider,
    model: entry.model || "",
    effort: entry.effort || "",
    title: entry.title || "",
    initialRequest: entry.initialRequest || "",
    handoffId: entry.handoffId || "",
    operationId: entry.id,
    cancelRequested: false,
    resumed: true,
    navigationGeneration: state.navigationGeneration,
  };
  state.newCourseRun = run;
  resetRunLog();
  elements.runTitle.textContent = `${providerName(provider)} · new course`;
  setRunState("running", task.notice || "Reconnected to course creation already running in the background.");
  if (task.notice) appendRunLog(task.notice, "status");
  renderProviders();

  try {
    const result = await waitForOperationTerminal(entry.id, {
      onRunning: (activeTask, connectionError) => {
        if (connectionError) {
          setRunState("running", "Reconnecting to the background teacher…");
        } else if (activeTask?.notice) {
          setRunState("running", activeTask.notice);
          appendRunLog(activeTask.notice, "status");
        }
      },
    });
    if (result.status === "complete") {
      run.phase = "committed";
      await clearRunReceipts(entry.id, run.handoffId);
      await applyCourseCreationCompletion(result.event, run);
      return;
    }
    if (result.status === "failed") {
      await adoptTeacherInterruption(run, result.failure, run.handoffId ? { handoffId: run.handoffId } : null);
      return;
    }
    if (result.status === "unknown") {
      await clearOperation(entry.id);
      const message = run.cancelRequested
        ? "Course creation cancelled; the unfinished course was rolled back."
        : "The background teacher stopped without saving a lecture.";
      appendRunLog(message, run.cancelRequested ? "status" : "error");
      setRunState("error", message);
      return;
    }
    const detail = result.error ? ` ${result.error.message}` : "";
    const message = `Margin could not confirm whether lecture 1 was saved.${detail}`;
    appendRunLog(message, "error");
    setRunState("error", message);
    showToast(message, { error: true });
  } catch (error) {
    appendRunLog(error.message, "error");
    setRunState("error", error.message);
    showToast(error.message, { error: true });
  } finally {
    if (state.newCourseRun === run) state.newCourseRun = null;
    elements.cancelRun.disabled = false;
    if (elements.teacherRun.dataset.state !== "running") elements.cancelRun.textContent = "Dismiss";
    renderProviders();
    schedulePendingOperationReconciliation();
  }
}

async function reconcilePendingOperationsAtStartup() {
  const entries = pendingOperations();
  if (!entries.length) return;
  const remaining = [];
  const running = [];
  const failed = [];
  let completed = 0;
  let deferred = 0;
  let unconfirmed = 0;
  for (const entry of entries) {
    const result = await reconcileOperation(entry.id, {
      courseId: entry.kind === "teacher" ? entry.courseId : "",
      timeoutMilliseconds: 0,
    });
    if (result.status === "complete") {
      completed += 1;
      if (entry.kind === "teacher" && entry.action === "revise" && entry.courseId && result.event?.lesson) {
        state.staleLectures.add(`${entry.courseId}:${result.event.lesson}`);
      }
      continue;
    }
    if (result.status === "unknown") continue;
    if (result.status === "failed") {
      failed.push({ entry, result });
      remaining.push(entry);
      continue;
    }
    remaining.push(entry);
    if (result.status === "running") running.push({ entry, task: result.task });
    else if (result.status === "deferred") deferred += 1;
    else unconfirmed += 1;
  }
  const interrupted = running.length ? null : failed[0] || null;
  if (remaining.length !== entries.length) {
    try {
      await persistCriticalPreference(PENDING_OPERATIONS_KEY, JSON.stringify(remaining));
    } catch (error) {
      showToast(`Pending teacher receipts could not be updated: ${error.message}`, { error: true });
      return;
    }
  }
  if (completed) {
    await refreshCourses();
    showTaskCompletion(`${completed} completed background teacher ${completed === 1 ? "result was" : "results were"} recovered.`);
  }
  if (interrupted) {
    const { entry, result } = interrupted;
    const handoff = result.handoff || {};
    resetRunLog();
    applyTeacherInterruption({
      action: handoff.action || entry.action || (entry.kind === "course-create" ? "create" : ""),
      courseId: handoff.courseId || entry.courseId || "",
      chapterId: handoff.chapterId || entry.chapterId || "",
      lesson: handoff.lesson || entry.lesson || "",
      annotationIds: [...(entry.annotationIds || [])],
      title: handoff.title || entry.title || "",
      initialRequest: handoff.initialRequest || entry.initialRequest || "",
      provider: result.failure.provider || handoff.provider || entry.provider || state.selectedTeacher,
      model: entry.model || "",
      effort: entry.effort || "",
    }, result.failure);
  } else if (running.length) {
    const [{ entry, task }] = running;
    showToast("Reconnected to the teacher working in the background.");
    if (entry.kind === "course-create") void resumePendingCourseCreation(entry, task);
    else void resumePendingTeacherOperation(entry, task);
  } else if (deferred) {
    showToast(`${deferred} pending teacher ${deferred === 1 ? "receipt will" : "receipts will"} be checked after the current task finishes.`);
    schedulePendingOperationReconciliation();
  } else if (unconfirmed) {
    showToast(`${unconfirmed} teacher ${unconfirmed === 1 ? "result is" : "results are"} still unconfirmed; Margin kept the retry receipt.`, { error: true });
  }
}

async function init() {
  try {
    if (!sessionToken) throw new Error("This Margin launch does not include a session token.");
    const bootstrap = await api("/api/bootstrap");
    contentOrigin = bootstrap.contentOrigin;
    if (!contentOrigin) throw new Error("The isolated lecture server is unavailable.");
    applyPreferences(bootstrap.settings);
    const [coursePayload, providerPayload] = await Promise.all([api("/api/courses"), api("/api/providers")]);
    state.courses = coursePayload.courses;
    state.diagnostics = Array.isArray(coursePayload.diagnostics) ? coursePayload.diagnostics : [];
    state.providers = providerPayload.providers;
    renderLibrary();
    renderProviders();
    showLibrary();
    await reconcilePendingOperationsAtStartup();
    reportCourseDiagnostics(coursePayload.diagnostics);
  } catch (error) {
    showToast(error.message, { error: true });
    document.title = "Margin could not load the workspace";
  } finally {
    elements.app.dataset.ready = "true";
    elements.libraryView.dataset.ready = "true";
  }
}

elements.backToLibrary.addEventListener("click", showLibrary);
elements.newCourseForm.addEventListener("submit", createNewCourse);
elements.cancelNewCourse.addEventListener("click", closeNewCourseDialog);
elements.newCourseDialog.addEventListener("cancel", (event) => {
  if (!state.newCourseRun) return;
  event.preventDefault();
  cancelNewCourseCreation();
});
elements.deleteForm.addEventListener("submit", performDeletion);
elements.cancelDelete.addEventListener("click", closeDeleteDialog);
elements.deleteDialog.addEventListener("cancel", (event) => {
  if (state.pendingDeletion?.busy) {
    event.preventDefault();
    return;
  }
  state.pendingDeletion = null;
});
elements.newCourseTeacherSelect.addEventListener("change", () => chooseProvider(elements.newCourseTeacherSelect.value));
elements.newCourseModelSelect.addEventListener("change", () => chooseTeacherModel(elements.newCourseModelSelect.value.trim()));
elements.newCourseEffortSelect.addEventListener("change", () => chooseTeacherEffort(elements.newCourseEffortSelect.value));
elements.toggleLeftPanel.addEventListener("click", () => togglePanel("left"));
elements.toggleRightPanel.addEventListener("click", () => togglePanel("right"));
attachPanelResizer("left", elements.leftPanelResizer);
attachPanelResizer("right", elements.rightPanelResizer);
elements.decreaseFontSize.addEventListener("click", () => setWorkspaceScale(state.workspaceScale - 0.1));
elements.resetFontSize.addEventListener("click", () => setWorkspaceScale(1));
elements.increaseFontSize.addEventListener("click", () => setWorkspaceScale(state.workspaceScale + 0.1));
window.addEventListener("message", receiveReaderMessage);
elements.leaveMessageButton.addEventListener("click", openComposer);
elements.cancelMessage.addEventListener("click", closeComposer);
elements.saveMessage.addEventListener("click", saveMessage);
elements.attachImage.addEventListener("click", () => elements.imageInput.click());
elements.imageInput.addEventListener("change", () => {
  const [file] = elements.imageInput.files;
  attachImageFile(file).catch((error) => showToast(error.message, { error: true }));
});
elements.removeImage.addEventListener("click", clearImage);
elements.composer.addEventListener("paste", (event) => {
  const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  attachImageFile(file).catch((error) => showToast(error.message, { error: true }));
});
elements.composer.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.composer.classList.add("is-dragging");
});
elements.composer.addEventListener("dragleave", () => elements.composer.classList.remove("is-dragging"));
elements.composer.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.composer.classList.remove("is-dragging");
  const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("image/"));
  if (file) attachImageFile(file).catch((error) => showToast(error.message, { error: true }));
});
elements.messageInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveMessage();
  if (event.key === "Escape") closeComposer();
});
elements.teacherMenuButton.addEventListener("click", toggleTeacherMenu);
elements.teacherModelInput.addEventListener("change", updateTeacherModel);
elements.teacherEffortSelect.addEventListener("change", updateTeacherEffort);
elements.providerPicker.addEventListener("click", (event) => {
  const updateButton = event.target.closest("[data-update-provider]");
  if (updateButton) {
    runProviderUpdate(updateButton.dataset.updateProvider);
    return;
  }
  const button = event.target.closest("[data-provider]");
  if (button) chooseProvider(button.dataset.provider);
});
elements.reviseButton.addEventListener("click", () => runTeacher("revise"));
elements.nextButton.addEventListener("click", () => runTeacher("next"));
elements.lectureHistoryButton.addEventListener("click", openHistoryView);
elements.closeHistory.addEventListener("click", closeHistoryView);
elements.historyList.addEventListener("click", (event) => {
  const restoreButton = event.target.closest("[data-history-restore]");
  if (restoreButton) {
    restoreHistoryCommit(restoreButton.dataset.historyRestore);
    return;
  }
  const previewButton = event.target.closest("[data-history-preview]");
  if (previewButton) previewHistoryCommit(previewButton.dataset.historyPreview).catch((error) => showToast(error.message, { error: true }));
});
elements.openRunDetails.addEventListener("click", openRunDetails);
elements.closeRunDetails.addEventListener("click", closeRunDetails);
elements.cancelRun.addEventListener("click", cancelRun);
elements.resumeRun.addEventListener("click", () => continueInterruptedRun(state.interruptedRun?.provider));
elements.switchRun.addEventListener("click", () => continueInterruptedRun(elements.switchRun.dataset.provider));
elements.abandonRun.addEventListener("click", abandonInterruptedRun);
window.addEventListener("resize", () => {
  hideSelectionPopover();
  normalizePanelWidths();
});
window.addEventListener("margin:toggle-course-panel", toggleCoursePanel);
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".teacher-picker")) closeTeacherMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.historyView.hidden) {
    closeHistoryView();
    return;
  }
  if (event.key === "Escape" && !elements.runDetailsView.hidden) {
    closeRunDetails();
    return;
  }
  if (event.key === "Escape" && state.teacherMenuOpen) closeTeacherMenu({ restoreFocus: true });
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleCoursePanel();
  }
});

renderPanelWidths();
renderPanelState();
renderWorkspaceScale();
applyWorkspaceScale();
init();
