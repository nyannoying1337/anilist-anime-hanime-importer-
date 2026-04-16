const STORAGE_KEYS = {
  clientId: "anilistPasteImport.clientId",
  token: "anilistPasteImport.accessToken",
  tokenCreatedAt: "anilistPasteImport.tokenCreatedAt",
  hanimeSessionToken: "anilistPasteImport.hanime.sessionToken",
  hanimeLastPlaylistUrl: "anilistPasteImport.hanime.lastPlaylistUrl",
  hanimeEmail: "anilistPasteImport.hanime.email",
  hideExisting: "anilistPasteImport.preview.hideExisting",
  filterMatched: "anilistPasteImport.preview.filter.matched",
  filterAmbiguous: "anilistPasteImport.preview.filter.ambiguous",
  filterUnmatched: "anilistPasteImport.preview.filter.unmatched",
  draftTitles: "anilistPasteImport.draft.titles",
  previewCache: "anilistPasteImport.preview.cache.v2",
};

const ANILIST = {
  authUrl: "https://anilist.co/api/v2/oauth/authorize",
  graphqlUrl: "https://graphql.anilist.co",
  // Some environments/proxies rewrite/expect a path-based endpoint.
  // We keep a fallback to reduce "POST ... 404" failures.
  graphqlUrlFallback: "https://graphql.anilist.co/graphql",
  // Prefer local proxy (see server.py). Avoid public proxies (often 429).
  graphqlLocalProxyPath: "/graphql",
  graphqlProxyUrl: "https://corsproxy.io/?",
};

const el = {
  settingsBtn: document.getElementById("settingsBtn"),
  sourceBtn: document.getElementById("sourceBtn"),
  logBtn: document.getElementById("logBtn"),
  authBtn: document.getElementById("authBtn"),
  previewBtn: document.getElementById("previewBtn"),
  importBtn: document.getElementById("importBtn"),
  defaultStatus: document.getElementById("defaultStatus"),
  titlesInput: document.getElementById("titlesInput"),
  previewSummary: document.getElementById("previewSummary"),
  previewPager: document.getElementById("previewPager"),
  previewPrevBtn: document.getElementById("previewPrevBtn"),
  previewNextBtn: document.getElementById("previewNextBtn"),
  previewPageLabel: document.getElementById("previewPageLabel"),
  previewPageSizeSelect: document.getElementById("previewPageSizeSelect"),
  previewTableWrap: document.getElementById("previewTableWrap"),
  log: document.getElementById("log"),
  progressWrap: document.getElementById("progressWrap"),
  progressLabel: document.getElementById("progressLabel"),
  progressBarFill: document.getElementById("progressBarFill"),
  progressMeta: document.getElementById("progressMeta"),
  sourceDialog: document.getElementById("sourceDialog"),
  settingsDialog: document.getElementById("settingsDialog"),
  logDialog: document.getElementById("logDialog"),
  clientIdInput: document.getElementById("clientIdInput"),
  hanimeSessionTokenInput: document.getElementById("hanimeSessionTokenInput"),
  hanimeEmailInput: document.getElementById("hanimeEmailInput"),
  hanimePasswordInput: document.getElementById("hanimePasswordInput"),
  hanimeLoginBtn: document.getElementById("hanimeLoginBtn"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  clearTokenBtn: document.getElementById("clearTokenBtn"),
  hanimePlaylistUrlInput: document.getElementById("hanimePlaylistUrlInput"),
  hanimeFillOnlyCheckbox: document.getElementById("hanimeFillOnlyCheckbox"),
  hanimeFetchBtn: document.getElementById("hanimeFetchBtn"),
  sourceTabPaste: document.getElementById("sourceTabPaste"),
  sourceTabHanime: document.getElementById("sourceTabHanime"),
  sourcePanePaste: document.getElementById("sourcePanePaste"),
  sourcePaneHanime: document.getElementById("sourcePaneHanime"),
  settingsTabAnilist: document.getElementById("settingsTabAnilist"),
  settingsTabHanime: document.getElementById("settingsTabHanime"),
  settingsPaneAnilist: document.getElementById("settingsPaneAnilist"),
  settingsPaneHanime: document.getElementById("settingsPaneHanime"),
  copyLogBtn: document.getElementById("copyLogBtn"),
  hideExistingCheckbox: document.getElementById("hideExistingCheckbox"),
  filterMatched: document.getElementById("filterMatched"),
  filterAmbiguous: document.getElementById("filterAmbiguous"),
  filterUnmatched: document.getElementById("filterUnmatched"),
  gdprFileInput: document.getElementById("gdprFileInput"),
  gdprLoadBtn: document.getElementById("gdprLoadBtn"),
  gdprClearBtn: document.getElementById("gdprClearBtn"),
  gdprStatus: document.getElementById("gdprStatus"),
  busyDialog: document.getElementById("busyDialog"),
  runBanner: document.getElementById("runBanner"),
  runBannerText: document.getElementById("runBannerText"),
  runBannerHideBtn: document.getElementById("runBannerHideBtn"),
};

/** @typedef {{id:number,title:{romaji?:string,english?:string,native?:string},seasonYear?:number,format?:string,isAdult?:boolean,synonyms?:string[],siteUrl?:string}} Media */
/** @typedef {{rawTitle:string,normalizedTitle:string,status:'matched'|'ambiguous'|'unmatched',candidates:Media[],selectedMediaId:number|null,episodeNumbers?:number[],reason?:string,existsInAniList?:boolean,existingEntry?:{status?:string,progress?:number}|null}} PreviewRow */

/** @type {PreviewRow[]} */
let previewRows = [];
let previewPage = 1;
let previewPageSize = 100;

/** @type {number|null} */
let cachedViewerId = null;

/** @type {Set<number>} */
let cachedExistingMediaIds = new Set();

// Cache AniList search results during a session (dedup repeated titles / retries).
/** @type {Map<string, Promise<{candidates:any[], usedQuery:string, attempts:number}>>} */
const searchCache = new Map();

// Observability for adaptive pacing (set inside gql()).
let saw429Recently = false;

/** @type {Map<number, {status?:string, progress?:number}>|null} */
let localExistingByMediaId = null;

init();

let currentProgress = null;
let _progressWaitCount = 0;

function setProgressState(state) {
  if (!el.progressWrap) return;
  el.progressWrap.classList.remove("stateOk", "stateWait", "stateErr");
  el.progressWrap.classList.add(state === "wait" ? "stateWait" : state === "err" ? "stateErr" : "stateOk");
}

function init() {
  hydrateSettings();
  maybeConsumeOAuthTokenFromUrl();
  refreshAuthUi();

  setupTabs();

  // Persistent "work running" banner
  el.runBannerHideBtn?.addEventListener("click", () => {
    if (el.runBanner) el.runBanner.style.display = "none";
  });

  // Restore draft titles + last *finished* preview (no resume of in-progress work).
  previewRows = [];
  try {
    const draft = localStorage.getItem(STORAGE_KEYS.draftTitles);
    if (draft && el.titlesInput && !el.titlesInput.value) el.titlesInput.value = draft;
  } catch {}
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.previewCache);
    if (raw) {
      const cached = JSON.parse(raw);
      const titlesKey = String(cached?.titlesKey || "");
      const currentKey = String((el.titlesInput?.value || "").trim());
      if (Array.isArray(cached?.rows) && titlesKey && titlesKey === currentKey) {
        previewRows = cached.rows;
        renderPreviewTable();
        renderSummary();
        refreshImportUi();
      }
    }
  } catch {}
  if (!previewRows?.length) {
    el.previewTableWrap.innerHTML = "";
    el.previewSummary.textContent = "No titles detected yet.";
  }

  // Preview filters
  if (el.hideExistingCheckbox) {
    el.hideExistingCheckbox.checked = getHideExisting();
    el.hideExistingCheckbox.addEventListener("change", () => {
      localStorage.setItem(STORAGE_KEYS.hideExisting, el.hideExistingCheckbox.checked ? "1" : "0");
      previewPage = 1;
      renderPreviewTable();
      renderSummary();
      refreshImportUi();
    });
  }
  const bindFilter = (checkboxEl, key, defaultOn) => {
    if (!checkboxEl) return;
    checkboxEl.checked = (localStorage.getItem(key) ?? (defaultOn ? "1" : "0")) === "1";
    checkboxEl.addEventListener("change", () => {
      localStorage.setItem(key, checkboxEl.checked ? "1" : "0");
      previewPage = 1;
      renderPreviewTable();
      renderSummary();
      refreshImportUi();
    });
  };
  bindFilter(el.filterMatched, STORAGE_KEYS.filterMatched, true);
  bindFilter(el.filterAmbiguous, STORAGE_KEYS.filterAmbiguous, true);
  bindFilter(el.filterUnmatched, STORAGE_KEYS.filterUnmatched, true);

  if (el.previewPrevBtn) {
    el.previewPrevBtn.addEventListener("click", () => {
      previewPage = Math.max(1, previewPage - 1);
      renderPreviewTable();
    });
  }
  if (el.previewNextBtn) {
    el.previewNextBtn.addEventListener("click", () => {
      previewPage += 1;
      renderPreviewTable();
    });
  }
  if (el.previewPageSizeSelect) {
    el.previewPageSizeSelect.value = String(previewPageSize);
    el.previewPageSizeSelect.addEventListener("change", () => {
      const size = Number(el.previewPageSizeSelect.value);
      previewPageSize = Number.isFinite(size) && size > 0 ? size : 100;
      previewPage = 1;
      renderPreviewTable();
    });
  }

  // AniList GDPR export loader (offline "already in list" detection)
  const refreshGdprStatus = () => {
    if (!el.gdprStatus) return;
    const n = localExistingByMediaId ? localExistingByMediaId.size : 0;
    el.gdprStatus.textContent = localExistingByMediaId ? `Loaded ${n} entry/entries.` : "Not loaded.";
  };
  refreshGdprStatus();

  el.gdprLoadBtn?.addEventListener("click", async () => {
    const file = el.gdprFileInput?.files?.[0] || null;
    if (!file) {
      log("Pick your gdpr_data.json file first.");
      return;
    }
    try {
      el.gdprLoadBtn.disabled = true;
      el.gdprLoadBtn.textContent = "Loading…";
      localExistingByMediaId = await parseAniListGdprFile(file);
      refreshGdprStatus();
      log(`Loaded GDPR export (${localExistingByMediaId.size} entries).`);
      // Re-apply offline existing markers if a preview is already present.
      if (previewRows?.length) {
        await markExistingRows();
        renderPreviewTable();
        renderSummary();
        refreshImportUi();
      }
    } catch (e) {
      localExistingByMediaId = null;
      refreshGdprStatus();
      log(`Failed to load GDPR export: ${String(e?.message || e)}`);
    } finally {
      el.gdprLoadBtn.textContent = "Load";
      el.gdprLoadBtn.disabled = false;
    }
  });

  el.gdprClearBtn?.addEventListener("click", async () => {
    localExistingByMediaId = null;
    refreshGdprStatus();
    cachedExistingMediaIds = new Set();
    for (const r of previewRows || []) {
      if (!r) continue;
      r.existsInAniList = false;
      r.existingEntry = null;
    }
    renderPreviewTable();
    renderSummary();
    refreshImportUi();
    log("Cleared GDPR cache.");
  });

  el.sourceBtn?.addEventListener("click", () => el.sourceDialog?.showModal?.());
  el.logBtn?.addEventListener("click", () => el.logDialog?.showModal?.());

  // Auto-cleanup pasted exports (e.g. tabular lists from other sites/apps).
  el.titlesInput.addEventListener("paste", () => {
    // Let the paste happen, then normalize the whole textarea.
    queueMicrotask(() => {
      const cleaned = parseRawTitles(el.titlesInput.value || "").map((x) => x.rawTitle);
      if (cleaned.length) el.titlesInput.value = cleaned.join("\n");
      try { localStorage.setItem(STORAGE_KEYS.draftTitles, el.titlesInput.value || ""); } catch {}
    });
  });

  el.titlesInput.addEventListener("input", () => {
    try { localStorage.setItem(STORAGE_KEYS.draftTitles, el.titlesInput.value || ""); } catch {}
  });

  el.copyLogBtn?.addEventListener("click", async () => {
    const text = el.log?.textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      log("Copied log to clipboard.");
    } catch {
      // Fallback for older permissions contexts
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        log("Copied log to clipboard.");
      } catch {
        log("Could not copy log (clipboard blocked).");
      }
    }
  });

  el.settingsBtn.addEventListener("click", () => {
    el.clientIdInput.value = getClientId() ?? "";
    el.hanimeSessionTokenInput.value = getHanimeSessionToken() ?? "";
    if (el.hanimeEmailInput) el.hanimeEmailInput.value = localStorage.getItem(STORAGE_KEYS.hanimeEmail) || "";
    if (el.hanimePasswordInput) el.hanimePasswordInput.value = "";
    el.settingsDialog.showModal();
  });

  el.hanimeLoginBtn?.addEventListener("click", async () => {
    const email = (el.hanimeEmailInput?.value || "").trim();
    const password = (el.hanimePasswordInput?.value || "").trim();
    if (!email || !password) {
      log("Enter Hanime email and password.");
      return;
    }
    try {
      el.hanimeLoginBtn.disabled = true;
      const sessionToken = await hanimeLogin(email, password);
      localStorage.setItem(STORAGE_KEYS.hanimeSessionToken, sessionToken);
      localStorage.setItem(STORAGE_KEYS.hanimeEmail, email);
      if (el.hanimeSessionTokenInput) el.hanimeSessionTokenInput.value = sessionToken;
      if (el.hanimePasswordInput) el.hanimePasswordInput.value = "";
      log("Signed in to Hanime (session token saved).");
    } catch (e) {
      log(`Hanime login failed: ${String(e?.message || e)}`);
    } finally {
      el.hanimeLoginBtn.disabled = false;
    }
  });

  el.saveSettingsBtn.addEventListener("click", (e) => {
    e.preventDefault?.();
    const v = (el.clientIdInput.value || "").trim();
    if (!/^\d+$/.test(v)) {
      log("Client ID must be a number.");
      return;
    }
    localStorage.setItem(STORAGE_KEYS.clientId, v);
    localStorage.setItem(STORAGE_KEYS.hanimeSessionToken, (el.hanimeSessionTokenInput.value || "").trim());
    if (el.hanimeEmailInput) localStorage.setItem(STORAGE_KEYS.hanimeEmail, (el.hanimeEmailInput.value || "").trim());
    log("Saved Client ID.");
    el.settingsDialog.close?.();
    refreshAuthUi();
  });

  el.clearTokenBtn.addEventListener("click", () => {
    clearToken();
    log("Signed out.");
    refreshAuthUi();
  });

  el.authBtn.addEventListener("click", () => {
    if (hasToken()) {
      el.settingsDialog.showModal();
      return;
    }
    const clientId = getClientId();
    if (!clientId) {
      log("Set your AniList Client ID in Settings first.");
      el.settingsDialog.showModal();
      return;
    }
    startOAuthImplicit(clientId);
  });

  el.previewBtn.addEventListener("click", async () => {
    try {
      el.previewBtn.disabled = true;
      el.importBtn.disabled = true;
      await runPreview();
      refreshImportUi();
    } finally {
      el.previewBtn.disabled = false;
    }
  });

  el.hanimeFetchBtn?.addEventListener("click", async () => {
    const playlistUrl = (el.hanimePlaylistUrlInput?.value || "").trim();
    if (!playlistUrl) {
      log("Paste a hanime.tv playlist URL first.");
      el.hanimePlaylistUrlInput?.focus?.();
      return;
    }
    localStorage.setItem(STORAGE_KEYS.hanimeLastPlaylistUrl, playlistUrl);
    try {
      el.hanimeFetchBtn.disabled = true;
      setProgress({ label: "Fetching from Hanime…", current: 0, total: null, meta: playlistUrl });
      const titles = await fetchHanimePlaylistTitles(playlistUrl);
      if (!titles.length) {
        log("Hanime fetch returned 0 titles.");
        return;
      }
      el.titlesInput.value = titles.join("\n");
      log(`Fetched ${titles.length} title(s) from Hanime.`);
      if (!el.hanimeFillOnlyCheckbox?.checked) {
        el.previewBtn?.click?.();
      }
    } catch (e) {
      log(`Hanime fetch failed: ${String(e?.message || e)}`);
    } finally {
      clearProgress();
      el.hanimeFetchBtn.disabled = false;
    }
  });

  el.importBtn.addEventListener("click", async () => {
    try {
      el.importBtn.disabled = true;
      await runImport();
    } finally {
      refreshImportUi();
    }
  });
}

let _isRunning = false;
function setRunningState(running, text) {
  _isRunning = Boolean(running);
  if (el.runBanner) el.runBanner.style.display = running ? "block" : "none";
  if (el.runBannerText && text) el.runBannerText.textContent = text;

  // Warn on refresh/close while running. Browsers show a generic message.
  window.onbeforeunload = running
    ? (e) => {
        e.preventDefault?.();
        e.returnValue = "";
        return "";
      }
    : null;
}

async function parseAniListGdprFile(file) {
  const text = await file.text();
  const json = JSON.parse(text);
  const rows = Array.isArray(json?.lists) ? json.lists : [];
  /** @type {Map<number, {status?:string, progress?:number}>} */
  const out = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const mediaId = Number(r.series_id ?? r.seriesId ?? r.media_id ?? r.mediaId);
    if (!Number.isFinite(mediaId)) continue;
    out.set(mediaId, {
      status: r.status != null ? String(r.status) : undefined,
      progress: typeof r.progress === "number" ? r.progress : undefined,
    });
  }
  if (!out.size) throw new Error("No list entries found in JSON (expected .lists[].series_id)");
  return out;
}

function getHideExisting() {
  return (localStorage.getItem(STORAGE_KEYS.hideExisting) || "1") === "1";
}

function getStatusFilters() {
  const get = (k, d) => (localStorage.getItem(k) ?? (d ? "1" : "0")) === "1";
  return {
    matched: get(STORAGE_KEYS.filterMatched, true),
    ambiguous: get(STORAGE_KEYS.filterAmbiguous, true),
    unmatched: get(STORAGE_KEYS.filterUnmatched, true),
  };
}

function setupTabs() {
  const setActive = (which, tabA, tabB, paneA, paneB) => {
    const isA = which === "a";
    if (tabA) tabA.classList.toggle("tabActive", isA);
    if (tabB) tabB.classList.toggle("tabActive", !isA);
    if (paneA) paneA.classList.toggle("tabPaneActive", isA);
    if (paneB) paneB.classList.toggle("tabPaneActive", !isA);
  };

  el.sourceTabPaste?.addEventListener("click", () =>
    setActive("a", el.sourceTabPaste, el.sourceTabHanime, el.sourcePanePaste, el.sourcePaneHanime)
  );
  el.sourceTabHanime?.addEventListener("click", () =>
    setActive("b", el.sourceTabPaste, el.sourceTabHanime, el.sourcePanePaste, el.sourcePaneHanime)
  );

  el.settingsTabAnilist?.addEventListener("click", () =>
    setActive("a", el.settingsTabAnilist, el.settingsTabHanime, el.settingsPaneAnilist, el.settingsPaneHanime)
  );
  el.settingsTabHanime?.addEventListener("click", () =>
    setActive("b", el.settingsTabAnilist, el.settingsTabHanime, el.settingsPaneAnilist, el.settingsPaneHanime)
  );
}

function hydrateSettings() {
  const last = localStorage.getItem(STORAGE_KEYS.hanimeLastPlaylistUrl);
  if (last && el.hanimePlaylistUrlInput) el.hanimePlaylistUrlInput.value = last;
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}\n`;
  // Append (easier to read in chronological order). Trim to avoid unbounded growth.
  const next = (el.log.textContent || "") + line;
  const maxChars = 120_000;
  el.log.textContent = next.length > maxChars ? next.slice(next.length - maxChars) : next;
  // Keep view pinned to latest when Log dialog is open.
  try {
    el.log.scrollTop = el.log.scrollHeight;
  } catch {}
}

function persistFinishedPreview() {
  try {
    const titlesText = el.titlesInput?.value || "";
    const titlesKey = String(titlesText).trim();
    const rows = (previewRows || []).filter(Boolean).map((r) => ({
      rawTitle: r.rawTitle,
      normalizedTitle: r.normalizedTitle,
      status: r.status,
      selectedMediaId: r.selectedMediaId ?? null,
      episodeNumbers: Array.isArray(r.episodeNumbers) ? r.episodeNumbers : undefined,
      reason: r.reason,
      existsInAniList: Boolean(r.existsInAniList),
      existingEntry: r.existingEntry ?? null,
      candidates: Array.isArray(r.candidates)
        ? r.candidates.slice(0, 25).map((m) => ({
            id: m.id,
            seasonYear: m.seasonYear,
            format: m.format,
            isAdult: m.isAdult,
            title: m.title,
          }))
        : [],
    }));
    localStorage.setItem(STORAGE_KEYS.previewCache, JSON.stringify({ v: 2, titlesKey, rows }));
  } catch {}
}

function setProgress({ label, current, total, meta }) {
  currentProgress = { label, current, total, meta };
  if (!el.progressWrap) return;
  el.progressWrap.style.display = "block";
  setProgressState(_progressWaitCount > 0 ? "wait" : "ok");
  if (el.progressLabel) el.progressLabel.textContent = label || "";
  const pct =
    typeof total === "number" && total > 0 && typeof current === "number"
      ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
      : null;
  if (el.progressBarFill) el.progressBarFill.style.width = pct == null ? "18%" : `${pct}%`;
  if (el.progressMeta) {
    const left = typeof current === "number" && typeof total === "number" ? `${current}/${total}` : "";
    el.progressMeta.textContent = [left, meta].filter(Boolean).join(" • ");
  }
}

function bumpProgress(current, total, meta) {
  if (!currentProgress) return setProgress({ label: "", current, total, meta });
  setProgress({ label: currentProgress.label, current, total, meta: meta ?? currentProgress.meta });
}

function clearProgress() {
  currentProgress = null;
  if (!el.progressWrap) return;
  el.progressWrap.style.display = "none";
  el.progressWrap.classList.remove("stateOk", "stateWait", "stateErr");
  if (el.progressBarFill) el.progressBarFill.style.width = "0%";
  if (el.progressLabel) el.progressLabel.textContent = "";
  if (el.progressMeta) el.progressMeta.textContent = "";
}

function getClientId() {
  const v = localStorage.getItem(STORAGE_KEYS.clientId);
  return v && /^\d+$/.test(v) ? v : null;
}

function getHanimeSessionToken() {
  const v = (localStorage.getItem(STORAGE_KEYS.hanimeSessionToken) || "").trim();
  return v || null;
}

function hasToken() {
  return Boolean(localStorage.getItem(STORAGE_KEYS.token));
}

function getToken() {
  return localStorage.getItem(STORAGE_KEYS.token);
}

function clearToken() {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.tokenCreatedAt);
}

function refreshAuthUi() {
  if (hasToken()) {
    el.authBtn.textContent = "Signed in";
    el.authBtn.classList.remove("btnPrimary");
    el.authBtn.classList.add("btnSecondary");
  } else {
    el.authBtn.textContent = "Sign in";
    el.authBtn.classList.remove("btnSecondary");
    el.authBtn.classList.add("btnPrimary");
  }
  refreshImportUi();
}

function refreshImportUi() {
  const canImport =
    hasToken() &&
    previewRows.length > 0 &&
    previewRows.some((r) => r.selectedMediaId != null && !r.existsInAniList);
  el.importBtn.disabled = !canImport;
}

function startOAuthImplicit(clientId) {
  const url = new URL(ANILIST.authUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "token");
  // state is optional but good practice; store to validate if you want stronger CSRF protection
  url.searchParams.set("state", cryptoRandomString(24));
  window.location.assign(url.toString());
}

function maybeConsumeOAuthTokenFromUrl() {
  // AniList implicit flow returns access_token in URL fragment
  const hash = window.location.hash || "";
  if (!hash.includes("access_token=")) return;

  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("access_token");
  const tokenType = params.get("token_type");
  if (token && (tokenType?.toLowerCase() === "bearer" || tokenType == null)) {
    localStorage.setItem(STORAGE_KEYS.token, token);
    localStorage.setItem(STORAGE_KEYS.tokenCreatedAt, String(Date.now()));
    log("Signed in with AniList.");
  } else {
    log("OAuth returned no usable token.");
  }

  // Clean URL
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
}

function cryptoRandomString(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

function parseRawTitles(raw) {
  const lines = raw
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(extractTitleFromMessyLine)
    .filter(Boolean)
    .map(stripCommonPrefixes)
    .map((l) => l.trim())
    .filter(Boolean);

  const seen = new Set();
  /** @type {{rawTitle:string, normalizedTitle:string}[]} */
  const out = [];

  for (const rawTitle of lines) {
    const normalizedTitle = normalizeTitle(scrubSourceNoise(rawTitle));
    if (!normalizedTitle) continue;
    const key = normalizedTitle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rawTitle, normalizedTitle });
  }
  return out;
}

function scrubSourceNoise(s) {
  let v = String(s || "");
  // Strip common source/export metadata that hurts AniList search quality.
  v = v.replace(/\[(?:ger(?:man)?|deutsch|eng(?:lish)?|sub|dub|uncensored|censored|omu|raw|bd|bdrip|bluray|dvd|web-?dl|webrip|x264|x265|hevc|h\.?264|1080p|720p|480p|2160p|4k)[^\]]*\]/gi, " ");
  v = v.replace(/\((?:ger(?:man)?|deutsch|eng(?:lish)?|sub|dub|uncensored|censored|omu|raw|bd|bdrip|bluray|dvd|web-?dl|webrip|x264|x265|hevc|h\.?264|1080p|720p|480p|2160p|4k)[^)]*\)/gi, " ");
  v = v.replace(/\b(?:ger(?:man)?|deutsch|eng(?:lish)?)\s*(?:sub|dub)\b/gi, " ");
  v = v.replace(/\b(?:sub(?:bed)?|dub(?:bed)?|uncensored|censored|omu|raw)\b/gi, " ");
  v = v.replace(/\b(?:bd|bdrip|bluray|dvd|web-?dl|webrip|x264|x265|hevc|h\.?264|1080p|720p|480p|2160p|4k)\b/gi, " ");
  v = v.replace(/\s*[-|]\s*(?:ger|eng|de|en)\s*(?:sub|dub)\s*$/i, " ");
  return v.replace(/\s+/g, " ").trim();
}

function extractTitleFromMessyLine(line) {
  const s = (line || "").trim();
  if (!s) return "";

  // Drop obvious non-title rows from tabular exports.
  if (/^\[\s*Detailansicht\s*\]$/i.test(s)) return "";

  // Common "format/episodes" continuation rows in some exports (often on the next line).
  if (/^(TV|OVA|ONA|OAD|Movie|Special)\b/i.test(s) && /\t|-\s*\d+\s*\/\s*\d+/.test(s)) return "";

  // If it looks tab-separated, the title is usually the 2nd column.
  if (s.includes("\t")) {
    const cols = s.split("\t").map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) {
      const first = cols[0];
      const second = cols[1];
      // Status column examples: "Abgeschlossen", "Airing", "Nicht erschienen (Pre-Airing)"
      const looksLikeStatus =
        /\b(abgeschlossen|airing|nicht erschienen|pre-?airing|paused|dropped|planning|completed|watching)\b/i.test(
          first
        ) ||
        first.length <= 32; // status strings are typically short
      if (looksLikeStatus && second) return second;
    }
  }

  // Space-separated fallback: "Abgeschlossen   Title   Movie ..."
  const m = s.match(
    /^(abgeschlossen|airing|nicht erschienen(?:\s*\(pre-?airing\))?)\s+(.+?)\s+(animeserie|movie|hentai|special|tv|ova|ona|oad)\b/i
  );
  if (m?.[2]) return m[2].trim();

  // Remove trailing "[ Detailansicht ]" if it's on the same line.
  return s.replace(/\[\s*Detailansicht\s*\]\s*$/i, "").trim();
}

function stripCommonPrefixes(s) {
  // bullets: - * •
  let v = s.replace(/^[-*•]\s+/, "");
  // numbered lists: "1. Title" or "1) Title"
  v = v.replace(/^\d+\s*[.)]\s+/, "");
  // checkboxes: "[ ] Title" or "[x] Title"
  v = v.replace(/^\[\s*[xX]?\s*\]\s+/, "");
  return v;
}

function normalizeTitle(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/["""]/g, '"')
    .replace(/[']/g, "'")
    .trim();
}

async function fetchHanimePlaylistTitles(playlistUrl) {
  const tokenOrCookie = getHanimeSessionToken();
  if (!tokenOrCookie) {
    log("Set your Hanime session token in Settings first.");
    el.settingsDialog.showModal();
    throw new Error("Missing Hanime session token");
  }

  const call = async (debug) => {
    const res = await fetch("/hanime/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ playlistUrl, sessionToken: tokenOrCookie, debug: Boolean(debug) }),
    });
    const text = await res.text().catch(() => "");
    const json = (() => {
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    })();
    if (!res.ok) {
      throw new Error(json?.error || (text ? `HTTP ${res.status}: ${text.slice(0, 200)}` : `HTTP ${res.status}`));
    }
    return json;
  };

  const json = await call(false);
  const titles = Array.isArray(json?.titles) ? json.titles : [];
  const cleaned = titles.map((t) => normalizeTitle(String(t))).filter(Boolean);

  const totalHint = typeof json?.totalHint === "number" ? json.totalHint : null;
  if (totalHint != null && cleaned.length > 0 && cleaned.length < totalHint) {
    // Automatically request a debug report so we can fix pagination reliably.
    try {
      const dbg = await call(true);
      const attempts = Array.isArray(dbg?.debug?.attempts) ? dbg.debug.attempts : [];
      const cand = Array.isArray(dbg?.debug?.htmlDiscoveredCandidates) ? dbg.debug.htmlDiscoveredCandidates : [];
      log(`Hanime pagination issue: got ${cleaned.length}/${totalHint}. Debug: ${attempts.length} attempt(s), ${cand.length} HTML candidate(s).`);
      if (cand.length) {
        log(`Hanime HTML candidates: ${cand.slice(0, 6).join(" | ")}${cand.length > 6 ? " | …" : ""}`);
      }
      const topAttempts = attempts.slice(0, 8);
      for (const a of topAttempts) {
        const url = a?.url ? String(a.url) : "(no url)";
        const status = a?.status != null ? String(a.status) : "?";
        const note = a?.note ? String(a.note) : "";
        const extra = a?.returnedCount != null ? ` returned=${a.returnedCount}` : "";
        log(`Hanime attempt: ${status} ${note} ${url}${extra}`.trim());
        if (a?.note === "no-titles" && a?.jsonKeys) {
          log(`Hanime jsonKeys: ${Array.isArray(a.jsonKeys) ? a.jsonKeys.join(", ") : String(a.jsonKeys)}`);
        }
        if (a?.note === "no-titles" && a?.shape) {
          try {
            log(`Hanime shape: ${JSON.stringify(a.shape).slice(0, 320)}`);
          } catch {}
        }
      }
      if (attempts.length > topAttempts.length) {
        log(`Hanime attempts: showing ${topAttempts.length}/${attempts.length} (more in console).`);
      }
      console.debug("Hanime pagination debug", dbg?.debug);
    } catch (e) {
      log(`Hanime pagination debug failed: ${String(e?.message || e)}`);
    }
  }

  return cleaned;
}

async function hanimeLogin(email, password) {
  const res = await fetch("/hanime/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text().catch(() => "");
  const json = (() => {
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  })();
  if (!res.ok) {
    throw new Error(json?.error || (text ? `HTTP ${res.status}: ${text.slice(0, 200)}` : `HTTP ${res.status}`));
  }
  const token = json?.sessionToken;
  if (!token) throw new Error("No session token returned");
  return String(token);
}

async function runPreview() {
  setRunningState(true, "Preview is running. Don’t close or refresh this page.");
  previewPage = 1;
  const titlesText = el.titlesInput.value || "";
  const parsedRaw = parseRawTitles(titlesText);
  const parsed = groupEpisodeLikeTitles(parsedRaw);
  if (parsed.length === 0) {
    previewRows = [];
    el.previewSummary.textContent = "No titles detected yet.";
    el.previewTableWrap.innerHTML = "";
    updatePreviewPager(0, 0, 0, 1);
    setRunningState(false);
    return;
  }

  // New run: clear any finished preview cache (avoid stale restore).
  try { localStorage.removeItem(STORAGE_KEYS.previewCache); } catch {}

  log(`Previewing ${parsed.length} title(s)…`);
  setProgress({ label: "Searching AniList…", current: 0, total: parsed.length, meta: "Preview" });
  el.previewSummary.textContent = "Searching AniList…";
  el.previewTableWrap.innerHTML = "";
  cachedExistingMediaIds = new Set();
  saw429Recently = false;

  /** @type {PreviewRow[]} */
  const rows = new Array(parsed.length);
  try { el.busyDialog?.showModal?.(); } catch {}

  // Render early so the table appears immediately.
  previewRows = rows;
  renderPreviewTable();
  renderSummary();

  let lastRenderAt = 0;
  const maybeRender = (force) => {
    const now = Date.now();
    if (!force && now - lastRenderAt < 350) return;
    lastRenderAt = now;
    previewRows = rows;
    renderPreviewTable();
    renderSummary();
    refreshImportUi();
  };

  let done = 0;
  const total = parsed.length;

  const cachedSearchAnimeWithFallback = (title) => {
    const key = normalizeTitle(title).toLowerCase();
    const existing = searchCache.get(key);
    if (existing) return existing;
    const p = searchAnimeWithFallback(title);
    searchCache.set(key, p);
    return p;
  };

  const processOne = async (i) => {
    const { rawTitle, normalizedTitle } = parsed[i];
    const { candidates, usedQuery, attempts } = await cachedSearchAnimeWithFallback(normalizedTitle);
    const resolved = resolveCandidates(normalizedTitle, candidates);
    rows[i] = {
      rawTitle,
      normalizedTitle,
      status: resolved.status,
      candidates,
      selectedMediaId: resolved.selectedMediaId,
      episodeNumbers: parsed[i].episodeNumbers,
      existsInAniList: false,
      existingEntry: null,
      reason:
        (attempts > 1 ? `Searched as “${usedQuery}” (fallback ${attempts}). ` : "") +
        (resolved.reason || ""),
    };
    done++;
    bumpProgress(done, total, rawTitle);
    maybeRender(false);
  };

  // Adaptive concurrency: overlap network latency, but back off if AniList 429s.
  let limit = 2;
  let adjusted = false;
  let next = 0;
  let active = 0;
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();

  const maybeAdjustFor429 = () => {
    if (!saw429Recently || adjusted) return;
    adjusted = true;
    limit = 2;
    // Increase min gap to reduce future 429 bursts.
    RATE.publicMinGapMs = Math.max(RATE.publicMinGapMs, 1100);
    log("AniList rate limit detected (429). Slowing down to avoid long stalls…");
  };

  while (next < total || active > 0) {
    maybeAdjustFor429();
    while (next < total && active < limit) {
      const i = next++;
      active++;
      const p = (async () => {
        try {
          await processOne(i);
        } finally {
          active--;
        }
      })();
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
    }
    if (inFlight.size) {
      await Promise.race(Array.from(inFlight));
    }
  }
  bumpProgress(total, total, "Done");

  previewRows = rows;
  // After we have selected media ids, check which ones already exist in the user's AniList.
  if (hasToken()) {
    try {
      setProgress({ label: "Checking your AniList…", current: 0, total: null, meta: "Existing entries" });
      await markExistingRows();
    } catch (e) {
      log(`Could not check existing AniList entries: ${String(e?.message || e)}`);
    } finally {
      clearProgress();
    }
  }
  renderPreviewTable();
  renderSummary();
  log("Preview ready.");
  persistFinishedPreview();
  clearProgress();
  try { el.busyDialog?.close?.(); } catch {}
  setRunningState(false);

  // Browser notification (optional)
  try {
    if ("Notification" in window) {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
      if (Notification.permission === "granted") {
        new Notification("AniList Paste Import", { body: "Preview finished." });
      }
    }
  } catch {}
}

async function markExistingRows() {
  // Prefer offline GDPR index if available.
  if (localExistingByMediaId) {
    cachedExistingMediaIds = new Set(localExistingByMediaId.keys());
    for (const r of previewRows) {
      if (!r) continue;
      const mid = r.selectedMediaId;
      if (!mid) continue;
      const entry = localExistingByMediaId.get(mid) || null;
      r.existsInAniList = Boolean(entry);
      r.existingEntry = entry;
    }
    return;
  }

  if (!hasToken()) return;
  const viewerId = await getViewerId();
  const ids = Array.from(
    new Set(previewRows.map((r) => r.selectedMediaId).filter((x) => Number.isFinite(x)))
  );
  if (ids.length === 0) return;

  const existingMap = await fetchExistingEntriesByMediaIds(viewerId, ids);
  cachedExistingMediaIds = new Set(existingMap.keys());
  for (const r of previewRows) {
    const mid = r.selectedMediaId;
    if (!mid) continue;
    const entry = existingMap.get(mid) || null;
    r.existsInAniList = Boolean(entry);
    r.existingEntry = entry;
  }
}

async function fetchExistingEntriesByMediaIds(userId, mediaIds) {
  /** @type {Map<number, {status?:string,progress?:number}>} */
  const out = new Map();
  const chunkSize = 25; // keep query size reasonable
  for (let i = 0; i < mediaIds.length; i += chunkSize) {
    const chunk = mediaIds.slice(i, i + chunkSize).filter((n) => Number.isFinite(n));
    if (!chunk.length) continue;

    // AniList filtering args can be finicky across fields; aliases are reliably supported.
    // This is still batched: 1 request per ~25 mediaIds.
    const fields = chunk
      .map(
        (mid, idx) => `
          ml${idx}: MediaList(userId: $userId, mediaId: ${Number(mid)}, type: ANIME) {
            mediaId
            status
            progress
          }`
      )
      .join("\n");

    const q = `query ($userId: Int) { ${fields} }`;
    const data = await gql(q, { userId }, { auth: true });
    for (let idx = 0; idx < chunk.length; idx++) {
      const r = data?.[`ml${idx}`];
      const mid = Number(r?.mediaId);
      if (!Number.isFinite(mid)) continue;
      out.set(mid, { status: r?.status, progress: r?.progress });
    }

    await sleep(220);
  }
  return out;
}

function buildSearchVariants(input) {
  const s = normalizeTitle(input);
  const variants = [];
  const push = (v) => {
    const t = normalizeTitle(v);
    if (!t) return;
    if (!variants.includes(t)) variants.push(t);
  };

  push(s);

  // Common connector variants ("to" vs "and") seen in titles.
  if (/\bto\b/i.test(s)) push(s.replace(/\bto\b/gi, "and"));
  if (/\band\b/i.test(s)) push(s.replace(/\band\b/gi, "to"));

  // Strip trailing "episode + studio" patterns (common from hanime playlist labels)
  const mStudio = s.match(
    /^(.*?)(?:\s+(?:EP|Ep|ep)\s*)?\s*\d+\s+([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,2})\s*$/
  );
  if (mStudio?.[1]) push(mStudio[1]);

  // Strip trailing episode numbers
  push(s.replace(/\s+(?:EP|Ep|ep)?\s*[-–:]?\s*\d+\s*$/g, ""));

  // Remove trailing parenthetical
  push(s.replace(/\s*\(.*?\)\s*$/g, ""));

  // Help titles that have a suffix on AniList (e.g. "...! THE ANIMATION")
  push(`${s} the animation`);

  // If colon-separated title, try left side
  const colon = s.split(":")[0];
  if (colon && colon !== s) push(colon);

  // Looser punctuation version
  push(s.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " "));

  return variants.filter(Boolean);
}

function normForMatch(s) {
  // Strong normalization for scoring (not for display)
  const v = normalizeTitle(String(s || "")).toLowerCase();
  const noDiacritics = v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let cleaned = noDiacritics
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop common "branding" prefixes and noisy suffix phrases in adult titles.
  cleaned = cleaned.replace(/^(?:love me|i love)\s+/i, "");
  cleaned = cleaned.replace(/\bthe\s+animation\b/gi, "");
  cleaned = cleaned.replace(/\banimeserie\b/gi, "");
  cleaned = cleaned.replace(/\b(?:s(?:eason)?\s*\d+|staffel\s*\d+|cour\s*\d+|part\s*\d+)\b/gi, " ");
  // Japanese romanized particle equivalence (common AniList spelling differences)
  cleaned = cleaned.replace(/\bwo\b/gi, "o");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function tokens(s) {
  // Keep this conservative: mostly connectors/particles.
  const stop = new Set(["the", "a", "an", "and", "to", "animation", "wa", "wo", "o"]);
  const base = normForMatch(s)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !stop.has(t));

  // Add concatenated token variants to handle hyphen-splits like "oji-san" vs "ojisan".
  // This improves overlap scoring without being overly aggressive.
  const extra = [];
  for (let i = 0; i < base.length - 1; i++) {
    extra.push(`${base[i]}${base[i + 1]}`);
  }
  return Array.from(new Set([...base, ...extra]));
}

async function searchAnimeWithFallback(title) {
  const variants = buildSearchVariants(title);
  let last = [];
  for (let i = 0; i < variants.length; i++) {
    const q = variants[i];
    const candidates = await searchAnime(q);
    last = candidates;
    if (!candidates?.length) continue;

    // Use the scorer to decide whether we need to try another variant.
    const resolved = resolveCandidates(title, candidates);
    const looksBad =
      resolved.status === "ambiguous" &&
      typeof resolved.reason === "string" &&
      /low-confidence/i.test(resolved.reason);

    if (!looksBad) return { candidates, usedQuery: q, attempts: i + 1 };
  }
  return { candidates: last || [], usedQuery: variants[0] || title, attempts: variants.length || 1 };
}

function extractEpisodeSuffix(title) {
  const s = normalizeTitle(title);
  if (!s) return { baseTitle: "", episodeNumber: null };
  const patterns = [
    /^(.*?)(?:\s+ep|\s+episode|\s+#)?\s+(\d{1,4})\s*$/i, // "Title 3", "Title Ep 3", "Title #3"
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1] && m?.[2]) {
      const n = Number(m[2]);
      if (Number.isFinite(n) && n >= 0) return { baseTitle: normalizeTitle(m[1]), episodeNumber: n };
    }
  }
  return { baseTitle: s, episodeNumber: null };
}

function groupEpisodeLikeTitles(parsedTitles) {
  /** @type {Map<string, {rawTitle:string, normalizedTitle:string, episodeNumbers:number[]}>} */
  const groups = new Map();
  for (const t of parsedTitles) {
    const { baseTitle, episodeNumber } = extractEpisodeSuffix(t.normalizedTitle);
    const key = normalizeTitle(baseTitle).toLowerCase();
    if (!key) continue;
    const g =
      groups.get(key) ??
      { rawTitle: baseTitle, normalizedTitle: baseTitle, episodeNumbers: [] };
    if (episodeNumber != null) g.episodeNumbers.push(episodeNumber);
    groups.set(key, g);
  }
  return Array.from(groups.values()).map((g) => ({
    rawTitle: g.rawTitle,
    normalizedTitle: g.normalizedTitle,
    episodeNumbers: Array.from(new Set(g.episodeNumbers)).sort((a, b) => a - b),
  }));
}

function renderSummary() {
  const defined = previewRows.filter(Boolean);
  const totalAll = defined.length;
  const existingAll = defined.filter((r) => r.existsInAniList).length;
  const rows = getFilteredPreviewRows();
  const total = rows.length;
  const matched = rows.filter((r) => r.status === "matched").length;
  const ambiguous = rows.filter((r) => r.status === "ambiguous").length;
  const unmatched = rows.filter((r) => r.status === "unmatched").length;
  const hidden = totalAll - total;
  const existingHidden = getHideExisting() ? existingAll : 0;
  el.previewSummary.textContent =
    `${total} shown` +
    ` • ${matched} matched • ${ambiguous} ambiguous • ${unmatched} unmatched` +
    (hidden ? ` • ${hidden} hidden` : "") +
    (existingHidden ? ` • ${existingHidden} already in AniList` : "");
}

function renderPreviewTable() {
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width: 180px;">Result</th>
        <th style="width: 260px;">Input title</th>
        <th>Match</th>
        <th style="width: 120px;">Year</th>
        <th style="width: 160px;">Format</th>
        <th style="width: 260px;">Notes</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  const allRows = getFilteredPreviewRows();
  const pageCount = clampPreviewPage(allRows.length);
  const start = (previewPage - 1) * previewPageSize;
  const end = Math.min(start + previewPageSize, allRows.length);
  const rows = allRows.slice(start, end);
  updatePreviewPager(allRows.length, start, end, pageCount);
  rows.forEach(({ row, idx }) => {
    const tr = document.createElement("tr");
    const pill = renderStatusPill(row.status, row.existsInAniList);
    const matchCell = renderMatchCell(row, idx);

    const selected = row.selectedMediaId
      ? row.candidates.find((c) => c.id === row.selectedMediaId) ?? null
      : null;

    tr.appendChild(td(pill));
    tr.appendChild(td(escapeHtml(row.rawTitle)));
    tr.appendChild(matchCell);
    tr.appendChild(td(selected?.seasonYear ? String(selected.seasonYear) : "—"));
    tr.appendChild(td(selected?.format ?? "—"));
    tr.appendChild(td(escapeHtml(row.reason ?? "—")));
    tbody.appendChild(tr);
  });

  el.previewTableWrap.innerHTML = "";
  el.previewTableWrap.appendChild(table);
}

function clampPreviewPage(totalRows) {
  const pageCount = Math.max(1, Math.ceil(totalRows / previewPageSize));
  previewPage = Math.min(Math.max(1, previewPage), pageCount);
  return pageCount;
}

function updatePreviewPager(totalRows, start, end, pageCount) {
  if (!el.previewPageLabel) return;
  const hasRows = totalRows > 0;
  el.previewPageLabel.textContent = hasRows
    ? `Rows ${start + 1}–${end} of ${totalRows} (Page ${previewPage}/${pageCount})`
    : "Rows 0–0 of 0";
  if (el.previewPrevBtn) el.previewPrevBtn.disabled = !hasRows || previewPage <= 1;
  if (el.previewNextBtn) el.previewNextBtn.disabled = !hasRows || previewPage >= pageCount;
}

function renderStatusPill(status, existsInAniList) {
  const wrap = document.createElement("div");
  wrap.className = "pill";
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  if (status === "matched") {
    dot.classList.add("dotOk");
    label.textContent = "Matched";
  } else if (status === "ambiguous") {
    dot.classList.add("dotWarn");
    label.textContent = "Ambiguous";
  } else {
    dot.classList.add("dotBad");
    label.textContent = "Unmatched";
  }
  wrap.appendChild(dot);
  wrap.appendChild(label);
  if (existsInAniList) {
    const tag = document.createElement("span");
    tag.className = "pillTag";
    tag.textContent = "In list";
    wrap.appendChild(tag);
  }
  return wrap;
}

function getFilteredPreviewRows() {
  const hideExisting = getHideExisting();
  const filters = getStatusFilters();
  const out = [];
  for (let idx = 0; idx < previewRows.length; idx++) {
    const row = previewRows[idx];
    if (!row) continue; // parallel preview fills slots incrementally
    if (hideExisting && row.existsInAniList) continue;
    if (row.status === "matched" && !filters.matched) continue;
    if (row.status === "ambiguous" && !filters.ambiguous) continue;
    if (row.status === "unmatched" && !filters.unmatched) continue;
    out.push({ row, idx });
  }
  return out;
}

function renderMatchCell(row, idx) {
  const cell = document.createElement("td");
  if (row.candidates.length === 0) {
    cell.textContent = "No results";
    return cell;
  }

  cell.appendChild(renderMatchPicker(row, idx));
  return cell;
}

function renderMatchPicker(row, idx) {
  const wrap = document.createElement("div");
  wrap.className = "matchPicker";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "matchPickerBtn";

  const selected = row.selectedMediaId
    ? row.candidates.find((c) => c.id === row.selectedMediaId) ?? null
    : null;
  button.textContent = selected ? formatMediaLabel(selected) : "— Select a match —";

  const panel = document.createElement("div");
  panel.className = "matchPickerPanel";
  panel.setAttribute("aria-hidden", "true");

  const search = document.createElement("input");
  search.className = "input matchPickerSearch";
  search.placeholder = "Filter… (or type to search AniList)";
  search.autocomplete = "off";

  const list = document.createElement("div");
  list.className = "matchPickerList";

  const footer = document.createElement("div");
  footer.className = "matchPickerFooter";

  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "btn btnSecondary matchPickerSearchBtn";
  searchBtn.textContent = "Search AniList";
  searchBtn.disabled = true;

  const hint = document.createElement("div");
  hint.className = "matchPickerHint";
  hint.textContent = "Tip: type a new title and press “Search AniList”.";

  footer.appendChild(searchBtn);
  footer.appendChild(hint);

  const closePanel = () => {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  };
  const openPanel = () => {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    search.value = "";
    renderList("");
    queueMicrotask(() => search.focus());
  };

  const choose = (mediaId) => {
    previewRows[idx].selectedMediaId = mediaId;
    previewRows[idx].status = mediaId ? "matched" : (previewRows[idx].candidates.length ? "ambiguous" : "unmatched");
    if (mediaId) previewRows[idx].reason = "Selected manually.";
    closePanel();
    renderPreviewTable();
    renderSummary();
    refreshImportUi();
    persistPreviewCache();
  };

  let liveCandidates = [];
  let liveFor = "";
  let liveReq = 0;

  const renderList = (q) => {
    const query = String(q || "").trim().toLowerCase();
    list.innerHTML = "";

    const addItem = (label, mediaId, isActive) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "matchPickerItem";
      if (isActive) item.classList.add("active");
      item.textContent = label;
      item.addEventListener("click", () => choose(mediaId));
      list.appendChild(item);
    };

    addItem("— Select a match —", null, row.selectedMediaId == null);

    for (const m of row.candidates) {
      const label = formatMediaLabel(m);
      if (query && !label.toLowerCase().includes(query)) continue;
      addItem(label, m.id, row.selectedMediaId === m.id);
    }

    if (liveCandidates.length && liveFor === query) {
      const sep = document.createElement("div");
      sep.className = "matchPickerSep";
      sep.textContent = "AniList results";
      list.appendChild(sep);
      for (const m of liveCandidates) {
        const label = formatMediaLabel(m);
        addItem(label, m.id, row.selectedMediaId === m.id);
      }
    }
  };

  button.addEventListener("click", () => {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });

  search.addEventListener("input", () => renderList(search.value));
  search.addEventListener("input", () => {
    const q = (search.value || "").trim();
    searchBtn.disabled = q.length < 2;
    const qNorm = q.toLowerCase();
    renderList(q);
    // Lightweight live autocomplete: only after 3 chars.
    const myReq = ++liveReq;
    if (qNorm.length < 3) {
      liveCandidates = [];
      liveFor = "";
      return;
    }
    (async () => {
      try {
        await sleep(280);
        if (myReq !== liveReq) return;
        const candidates = await searchAnime(q);
        if (myReq !== liveReq) return;
        liveCandidates = Array.isArray(candidates) ? candidates.slice(0, 10) : [];
        liveFor = qNorm;
        renderList(q);
      } catch {
        // ignore autocomplete failures
      }
    })();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
      button.focus();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!searchBtn.disabled) searchBtn.click();
    }
  });

  searchBtn.addEventListener("click", async () => {
    const q = (search.value || "").trim();
    if (q.length < 2) return;
    try {
      searchBtn.disabled = true;
      searchBtn.textContent = "Searching…";
      const { candidates } = await searchAnimeWithFallback(q);
      // Replace candidates for this row with the search results.
      previewRows[idx].candidates = candidates || [];
      const resolved = resolveCandidates(q, previewRows[idx].candidates);
      previewRows[idx].selectedMediaId = resolved.selectedMediaId;
      previewRows[idx].status = resolved.status;
      previewRows[idx].reason = resolved.reason || "Searched manually.";
      // Re-render the full table so year/format/summary updates.
      renderPreviewTable();
      renderSummary();
      refreshImportUi();
      persistPreviewCache();
    } catch (e) {
      log(`Manual AniList search failed: ${String(e?.message || e)}`);
    } finally {
      searchBtn.textContent = "Search AniList";
      searchBtn.disabled = (search.value || "").trim().length < 2;
    }
  });

  // Click-away close (scoped to this render instance; re-render recreates handlers).
  const onDocPointer = (e) => {
    if (!panel.classList.contains("open")) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (wrap.contains(t)) return;
    closePanel();
  };
  document.addEventListener("pointerdown", onDocPointer, { capture: true });

  panel.appendChild(search);
  panel.appendChild(list);
  panel.appendChild(footer);
  wrap.appendChild(button);
  wrap.appendChild(panel);
  renderList("");
  return wrap;
}

function formatMediaLabel(m) {
  const t = m.title?.english || m.title?.romaji || m.title?.native || `ID ${m.id}`;
  const year = m.seasonYear ? ` (${m.seasonYear})` : "";
  return `${t}${year}`;
}

function td(child) {
  const d = document.createElement("td");
  if (child instanceof Node) d.appendChild(child);
  else d.innerHTML = String(child);
  return d;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resolveCandidates(inputTitle, candidates) {
  if (!candidates || candidates.length === 0) {
    return { status: "unmatched", selectedMediaId: null, reason: "No search results." };
  }

  const inputNorm = normForMatch(inputTitle);
  const inputTokens = tokens(inputTitle);
  const inputTokenSet = new Set(inputTokens);

  const jaccard = (aTokens, bTokens) => {
    const A = new Set(aTokens);
    const B = new Set(bTokens);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
  };

  const prefixBonus = (aTokens, bTokens) => {
    if (!aTokens.length || !bTokens.length) return 0;
    const n = Math.min(aTokens.length, bTokens.length, 5);
    for (let i = 0; i < n; i++) {
      if (aTokens[i] !== bTokens[i]) return 0;
    }
    return 0.04; // small bonus for shared prefix tokens
  };

  const scoreCandidate = (c) => {
    const titleStrings = [
      c.title?.romaji,
      c.title?.english,
      c.title?.native,
      ...(Array.isArray(c.synonyms) ? c.synonyms : []),
    ].filter(Boolean);

    let best = 0;
    let bestTitle = null;
    let bestJac = 0;
    for (const t of titleStrings) {
      const tn = normForMatch(t);
      if (!tn) continue;
      if (tn === inputNorm) return { score: 1, bestTitle: t, exact: true };

      const tTokens = tokens(t);
      const jac = jaccard(inputTokens, tTokens);
      const dice = Math.max(
        similarity(inputNorm, tn),
        similarity(inputNorm.replace(/\s+/g, ""), tn.replace(/\s+/g, ""))
      );
      const bonus = prefixBonus(inputTokens, tTokens);

      // Weighted blend. Dice handles fuzz; Jaccard handles missing suffixes.
      const s = Math.max(dice * 0.72 + jac * 0.28 + bonus, jac * 0.55 + dice * 0.45 + bonus);
      if (s > best) {
        best = s;
        bestTitle = t;
        bestJac = jac;
      }
    }
    return { score: best, bestTitle, exact: false, jac: bestJac };
  };

  const scored = candidates
    .map((c) => {
      const r = scoreCandidate(c);
      return { id: c.id, score: r.score, exact: r.exact, bestTitle: r.bestTitle, jac: r.jac ?? 0 };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const sequelLike = (s) =>
    /\b(?:part|season|staffel|cour)\s*\d+\b|\b(?:2nd|3rd|4th)\b|\bii\b|\biii\b|\biv\b/i.test(String(s || ""));
  const pickLabel = (entry) => {
    if (!entry) return "";
    return (
      entry.bestTitle ||
      candidates.find((c) => c.id === entry.id)?.title?.english ||
      candidates.find((c) => c.id === entry.id)?.title?.romaji ||
      ""
    );
  };

  if (best?.exact) {
    return { status: "matched", selectedMediaId: best.id, reason: "Exact match (title/synonym)." };
  }

  // If the input looks like a base title and AniList returns both base + sequel variants
  // with near-equal scores, prefer the non-sequel entry to reduce noisy ambiguity
  // (example: "86" vs "86 Part 2").
  {
    const bestNonSequel = scored.find((x) => !sequelLike(pickLabel(x)));
    const bestSequel = scored.find((x) => sequelLike(pickLabel(x)));
    const nonSequelLabel = pickLabel(bestNonSequel);
    const inputIsVeryShort = inputTokens.length <= 2 || inputNorm.length <= 6;
    const sharesBase = inputNorm && normForMatch(nonSequelLabel).startsWith(inputNorm);
    if (
      bestNonSequel &&
      bestSequel &&
      inputIsVeryShort &&
      sharesBase &&
      bestNonSequel.score >= 0.84 &&
      bestNonSequel.score + 0.015 >= bestSequel.score
    ) {
      return {
        status: "matched",
        selectedMediaId: bestNonSequel.id,
        reason: `Base title favored over sequel variant (${nonSequelLabel || "best match"}).`,
      };
    }
  }

  // High-confidence auto-select.
  if (best && best.score >= 0.93 && (!second || best.score - second.score >= 0.06)) {
    const hint = best.bestTitle ? ` (${best.bestTitle})` : "";
    return { status: "matched", selectedMediaId: best.id, reason: `High-confidence match${hint}.` };
  }

  // Medium-confidence auto-select for noisy source names (e.g., proxer exports)
  // when one candidate clearly dominates and has solid token overlap.
  if (best && best.score >= 0.88 && best.jac >= 0.55 && (!second || best.score - second.score >= 0.035)) {
    const hint = best.bestTitle ? ` (${best.bestTitle})` : "";
    return { status: "matched", selectedMediaId: best.id, reason: `Dominant match from noisy title${hint}.` };
  }

  // Adult content: AniList often returns many close variants; if the top adult candidate
  // clearly dominates, auto-pick to reduce manual confirmation.
  if (best && second) {
    const bestMedia = candidates.find((c) => c.id === best.id) || null;
    const bestIsAdult = Boolean(bestMedia?.isAdult);
    const gap = best.score - second.score;
    if (bestIsAdult && best.score >= 0.9 && gap >= 0.1 && candidates.length <= 12) {
      const bestTokens = tokens(best.bestTitle || (bestMedia?.title?.english || bestMedia?.title?.romaji || ""));
      const n = Math.min(inputTokens.length, bestTokens.length, 4);
      let prefixMatches = 0;
      for (let i = 0; i < n; i++) {
        if (inputTokens[i] !== bestTokens[i]) break;
        prefixMatches++;
      }
      // Require some shared prefix signal (longer titles benefit more; short titles stay manual).
      if (prefixMatches >= Math.min(2, n)) {
        const hint = best.bestTitle ? ` (${best.bestTitle})` : "";
        return { status: "matched", selectedMediaId: best.id, reason: `Adult dominant match${hint}.` };
      }
    }
  }

  // If AniList only returned a single plausible candidate, auto-select at a lower bar.
  // This avoids annoying manual confirmation for obvious one-result cases.
  if (candidates.length === 1 && best && best.score >= 0.80) {
    const hint = best.bestTitle ? ` (${best.bestTitle})` : "";
    return { status: "matched", selectedMediaId: best.id, reason: `Single result auto-match${hint}.` };
  }

  // Low score: treat as ambiguous or unmatched based on any token overlap.
  const anyOverlap = (() => {
    for (const c of candidates) {
      const titleStrings = [
        c.title?.romaji,
        c.title?.english,
        c.title?.native,
        ...(Array.isArray(c.synonyms) ? c.synonyms : []),
      ].filter(Boolean);
      for (const t of titleStrings) {
        const ts = tokens(t);
        for (const tok of ts) if (inputTokenSet.has(tok)) return true;
      }
    }
    return false;
  })();

  if (!anyOverlap && best && best.score < 0.72) {
    return { status: "ambiguous", selectedMediaId: null, reason: "Low-confidence results (check spelling/suffix)." };
  }

  const suggestion = best?.bestTitle ? ` Top suggestion: ${best.bestTitle}.` : "";
  return { status: "ambiguous", selectedMediaId: null, reason: `Needs confirmation (not exact).${suggestion}` };
}

function similarity(a, b) {
  // Normalized Dice coefficient on bigrams (simple + fast)
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) {
    inter += Math.min(v, B.get(k) || 0);
  }
  const total = (a.length - 1) + (b.length - 1);
  return (2 * inter) / total;
}

async function searchAnime(title) {
  const query = `
    query ($search: String) {
      Page(perPage: 20) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          seasonYear
          format
          isAdult
          synonyms
          siteUrl
          title { romaji english native }
        }
      }
    }
  `;
  const data = await gql(query, { search: title }, { auth: false });
  return data?.Page?.media ?? [];
}

async function runImport() {
  if (!hasToken()) {
    log("Sign in first.");
    return;
  }
  setRunningState(true, "Import is running. Don’t close or refresh this page.");

  const status = el.defaultStatus.value;
  const toImport = previewRows
    .filter((r) => r.selectedMediaId != null && !r.existsInAniList)
    .map((r) => ({
      title: r.rawTitle,
      mediaId: r.selectedMediaId,
      status,
    }));

  if (toImport.length === 0) {
    log("No selected matches to import.");
    return;
  }

  log(`Importing ${toImport.length} entr${toImport.length === 1 ? "y" : "ies"}…`);
  setProgress({ label: "Importing to AniList…", current: 0, total: toImport.length, meta: "Import" });

  let created = 0;
  let updated = 0;
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < toImport.length; i++) {
    const item = toImport[i];
    try {
      bumpProgress(i, toImport.length, item.title);
      await saveMediaListEntry(item.mediaId, item.status);
      ok++;
      // SaveMediaListEntry is create-or-update; we don't need a pre-flight lookup (saves 1 API call per entry).
      log(`Imported: ${item.title}`);
    } catch (e) {
      failed++;
      log(`FAILED: ${item.title} (${String(e?.message || e)})`);
    }
    await sleep(350);
  }
  bumpProgress(toImport.length, toImport.length, "Done");

  const skippedNoMatch = previewRows.filter((r) => r.selectedMediaId == null).length;
  const skippedExisting = previewRows.filter((r) => r.selectedMediaId != null && r.existsInAniList).length;
  const unmatched = previewRows.filter((r) => r.status === "unmatched").length;
  log(
    `Done. Created: ${created}. Updated: ${updated}. Failed: ${failed}. ` +
      `Skipped: ${skippedNoMatch} no-match + ${skippedExisting} already-on-AniList (incl. ${unmatched} unmatched).`
  );
  clearProgress();
  setRunningState(false);
}

async function getViewerId() {
  if (cachedViewerId != null) return cachedViewerId;
  const q = `
    query {
      Viewer { id }
    }
  `;
  const data = await gql(q, {}, { auth: true });
  const id = data?.Viewer?.id;
  if (!id) throw new Error("Could not fetch Viewer id");
  cachedViewerId = id;
  return id;
}

async function saveMediaListEntry(mediaId, status) {
  const mutation = `
    mutation ($mediaId: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status) {
        id
        status
        mediaId
      }
    }
  `;
  await gql(mutation, { mediaId, status }, { auth: true });
}

async function gql(query, variables, { auth }) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (auth) {
    const token = getToken();
    if (!token) throw new Error("No token");
    headers["Authorization"] = `Bearer ${token}`;
  }

  const endpoints = [
    ANILIST.graphqlUrl,
    ANILIST.graphqlUrl.replace(/\/$/, ""), // no trailing slash
    ANILIST.graphqlUrl + "/graphql",
    ANILIST.graphqlUrlFallback,
    ANILIST.graphqlUrlFallback.replace(/\/$/, ""),
  ]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  const hasLocalProxy =
    typeof ANILIST.graphqlLocalProxyPath === "string" && ANILIST.graphqlLocalProxyPath.startsWith("/");

  /** @param {string} url */
  const doFetch = async (url) => {
    await rateLimit(auth ? "auth" : "public");
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
  };

  let res = null;
  let usedUrl = null;

  // If a same-origin proxy is available (server.py), always use it for both public + auth
  // to avoid browser CORS and public proxy 429s.
  if (hasLocalProxy) {
    usedUrl = ANILIST.graphqlLocalProxyPath;
    res = await doFetch(usedUrl);
  } else {
    // Fallback strategy (no local proxy):
    // try direct endpoint(s) first; if blocked (CORS), fall back to public CORS proxy.
    for (const endpoint of endpoints) {
      try {
        const attempt = await doFetch(endpoint);
        if (attempt.status === 404) {
          res = attempt;
          usedUrl = endpoint;
          continue;
        }
        res = attempt;
        usedUrl = endpoint;
        break;
      } catch {
        // ignore (likely CORS)
      }

      try {
        const proxied = await doFetch(ANILIST.graphqlProxyUrl + encodeURIComponent(endpoint));
        if (proxied.status === 404) {
          res = proxied;
          usedUrl = endpoint;
          continue;
        }
        res = proxied;
        usedUrl = endpoint;
        break;
      } catch {
        // ignore
      }
    }
  }

  if (!res) {
    setProgressState("err");
    throw new Error("Network error (request blocked). If this is CORS, try running the app from http://localhost.");
  }

  if (res.status === 429) {
    saw429Recently = true;
    // Rate limited. Respect Retry-After when present, otherwise exponential backoff with jitter.
    let attempt = 0;
    while (attempt < 5 && res.status === 429) {
      const retryAfterHeader = res.headers?.get?.("Retry-After") || null;
      const retryAfterMs = (() => {
        const s = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        if (Number.isFinite(s) && s >= 0) return Math.min(60_000, s * 1000);
        return null;
      })();
      const backoff = Math.min(60_000, 1500 * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 400);
      await sleep((retryAfterMs ?? backoff) + jitter);
      attempt++;

      // Retry the whole gql flow (endpoint selection + proxy fallback)
      return gql(query, variables, { auth });
    }
  }

  const rawText = await res.text().catch(() => "");
  const json = (() => {
    try {
      return rawText ? JSON.parse(rawText) : null;
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    setProgressState("err");
    const snippet = (rawText || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const msg =
      json?.errors?.[0]?.message ||
      (snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
    throw new Error(msg);
  }
  if (json?.errors?.length) {
    setProgressState("err");
    throw new Error(json.errors[0]?.message || "AniList error");
  }
  if (!auth && !hasLocalProxy && usedUrl && usedUrl !== ANILIST.graphqlUrl) {
    log(`Using AniList endpoint: ${usedUrl}`);
  }
  return json?.data;
}

// --- AniList API pacing ---
// AniList rate limits are strict; keep global spacing to avoid 429s on big pastes.
const RATE = {
  // Public search requests: keep to ~1 req/sec.
  publicMinGapMs: 1100,
  // Authenticated mutations/queries: keep to ~1 req/sec.
  authMinGapMs: 1100,
};
let _rlChain = Promise.resolve();
let _lastPublicAt = 0;
let _lastAuthAt = 0;

/** @param {"public"|"auth"} bucket */
function rateLimit(bucket) {
  const minGap = bucket === "auth" ? RATE.authMinGapMs : RATE.publicMinGapMs;
  _rlChain = _rlChain.then(async () => {
    const now = Date.now();
    const last = bucket === "auth" ? _lastAuthAt : _lastPublicAt;
    const wait = Math.max(0, last + minGap - now);
    if (wait) {
      _progressWaitCount++;
      setProgressState("wait");
      try {
        await sleep(wait);
      } finally {
        _progressWaitCount = Math.max(0, _progressWaitCount - 1);
        setProgressState(_progressWaitCount > 0 ? "wait" : "ok");
      }
    }
    const t = Date.now();
    if (bucket === "auth") _lastAuthAt = t;
    else _lastPublicAt = t;
  });
  return _rlChain;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
