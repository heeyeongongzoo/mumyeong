/* 무명(無名) — 클라이언트 */
(() => {
  "use strict";
  const CFG = window.MUMYEONG || {};
  const $ = (id) => document.getElementById(id);
  const TZ = "Asia/Seoul";
  const fmtTime = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, month: "long", day: "numeric", weekday: "long" });
  const fmtShort = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const dayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* noop */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
  };

  let token = store.get("mm_token");
  let S = null; // 서버 상태
  let vapid = null;
  let msgs = []; // 화면에 있는 메시지
  let nextLocalMessageId = 0;
  const seen = new Set();
  let cursor = null;
  let readUpto = 0;
  let typing = false;
  let nextAt = null;
  let tab = "chat";
  let pollTimer = null;
  let syncing = false;
  const photoCache = new Map();
  let lettersCache = [];

  // ───────── API
  async function api(action, payload = {}) {
    const res = await fetch(CFG.api, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-device-token": token } : {}) },
      body: JSON.stringify({ action, ...payload }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* noop */ }
    if (res.status === 401 && action !== "login") { lock(); throw new Error("잠김"); }
    if (!res.ok) throw new Error(data.error || "연결이 불안정해요");
    return data;
  }

  // ───────── 아바타
  const hisName = () => !S?.him || S.him === "태엽" ? "이도현" : S.him;
  const partnerInitial = (name = hisName()) => name === "이도현" ? "도" : Array.from(name)[0] || "도";

  // ───────── 화면 탐색
  const views = new Map([["chat", "chatView"], ["letters", "letters"], ["diary", "diary"], ["settings", "settings"]]);
  const navItems = document.querySelectorAll(".nav-item");
  const chatPane = $("chat");
  const jumpButton = $("jumpLatest");
  let readingOffset = null;
  let paperTrigger;
  function availableView(view) {
    return views.has(view) && (view !== "diary" || !$("diaryTab").hidden) ? view : "chat";
  }
  function navigate(view, replace = false) {
    view = availableView(view);
    if (replace || history.state?.paper) history.replaceState({ view }, "");
    else if (history.state?.view !== view) history.pushState({ view }, "");
    hidePaper();
    setTab(view);
  }
  function updateInert() {
    const modalOpen = !$("modal").hidden;
    $("app").inert = modalOpen || !$("paper").hidden;
    $("paper").inert = modalOpen;
    $("onboard").inert = modalOpen;
  }
  function hidePaper() {
    if ($("paper").hidden) return;
    $("paper").hidden = true;
    updateInert();
    const target = paperTrigger?.isConnected && !paperTrigger.disabled
      ? paperTrigger
      : document.querySelector(".nav-item[aria-current]");
    target?.focus({ preventScroll: true });
    paperTrigger = null;
  }
  function closePaper() {
    if (history.state?.paper) history.back();
    else hidePaper();
  }
  window.addEventListener("popstate", ({ state }) => {
    if ($("app").hidden) return;
    const view = availableView(state?.view);
    if (view !== tab) setTab(view);
    if (view === "letters" && state?.paper) showPaper(state.paper);
    else hidePaper();
  });
  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-view]");
    if (button) navigate(button.dataset.view);
  });

  // ───────── 화면 전환
  function show(id) {
    for (const s of ["lock", "onboard", "app"]) $(s).hidden = s !== id;
  }
  function lock() {
    token = null; store.del("mm_token");
    hidePaper();
    history.replaceState({ view: "chat" }, "");
    clearTimeout(pollTimer);
    show("lock"); setTimeout(() => $("pass").focus(), 50);
  }
  function toast(t, ms = 2400) {
    const el = $("toast"); el.textContent = t; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms);
  }
  function modal(text, buttons) {
    return new Promise((resolve) => {
      const trigger = document.activeElement;
      $("modalText").textContent = text;
      const box = $("modalBtns"); box.innerHTML = "";
      for (const b of buttons) {
        const el = document.createElement("button");
        el.className = "btn " + (b.primary ? "primary" : "");
        el.textContent = b.label;
        el.onclick = () => {
          $("modal").hidden = true;
          updateInert();
          trigger?.focus({ preventScroll: true });
          resolve(b.value);
        };
        box.appendChild(el);
      }
      $("modal").hidden = false;
      updateInert();
      box.lastElementChild?.focus();
    });
  }

  // ───────── 잠금
  $("lockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = e.currentTarget.querySelector("button[type=submit]");
    if (submit.disabled) return;
    submit.disabled = true;
    $("lockErr").textContent = "";
    try {
      const r = await api("login", { passcode: $("pass").value, label: navigator.userAgent.slice(0, 60) });
      token = r.token; store.set("mm_token", token); $("pass").value = "";
      await boot();
    } catch (err) { $("lockErr").textContent = err.message; }
    finally { submit.disabled = false; }
  });

  // ───────── 시작
  $("startForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = $("startBtn");
    if (submit.disabled) return;
    $("onbErr").textContent = "";
    const name = $("codename").value.trim();
    if (!name) { $("onbErr").textContent = "이름을 입력해 주세요."; return; }
    if (!CFG.preview) {
      const ok = await modal(`${name} 이름으로 시작할까요?\n오늘부터 30일이에요.`, [{ label: "시작", value: true, primary: true }, { label: "취소", value: false }]);
      if (!ok) return;
    }
    submit.disabled = true;
    try {
      await api("start", { codename: name });
      await boot(CFG.preview ? "chat" : "letters");
      if (!CFG.preview) toast(S.unread_letters ? "첫 편지가 도착했어요." : "첫 편지가 곧 도착해요.");
    } catch (err) { $("onbErr").textContent = err.message; }
    finally { submit.disabled = false; }
  });

  // ───────── 부팅·동기화
  async function boot(initialView) {
    if (!CFG.api) { document.body.innerHTML = "<p style='padding:24px'>config.js의 api 주소를 확인하세요.</p>"; return; }
    if (!token) { lock(); return; }
    const r = await api("boot", { visible: !document.hidden, chat_visible: false });
    vapid = r.vapid;
    applyState(r.state);
    if (S.phase === "onboarding") { show("onboard"); return; }
    show("app");
    msgs = []; seen.clear(); $("msgs").innerHTML = "";
    readingOffset = null;
    readUpto = 0;
    cursor = null;
    ingest(r);
    const q = new URLSearchParams(location.search).get("tab");
    navigate(initialView || (q === "letters" ? "letters" : history.state?.view || "chat"), true);
    schedulePoll(400);
  }

  function applyState(st) {
    S = st;
    const name = hisName();
    for (const avatar of document.querySelectorAll("[data-av]")) avatar.textContent = partnerInitial(name);
    $("hisName").textContent = name;
    $("infoName").textContent = name;
    $("diaryTitle").textContent = `${name}의 일기`;
    $("status").textContent = st.status || "";
    $("infoStatus").textContent = st.status || "";
    $("presence").textContent = st.presence || "";
    const day = st.day ? `${st.day}일째` : "";
    const progress = `${Math.max(0, Math.min(100, (Number(st.day) || 0) / 30 * 100))}%`;
    for (const id of ["dday", "dayText", "sidebarDay"]) $(id).textContent = day;
    for (const id of ["dayBar", "sidebarBar"]) $(id).style.width = progress;
    for (const id of ["profileProgress", "sidebarProgress"]) $(id).hidden = !day;
    $("myName").textContent = st.her || "한윤서";
    const unread = st.unread_letters;
    $("letterBadge").hidden = !unread;
    const lettersButton = $("letterBadge").closest("button");
    const unreadLabel = typeof unread === "number" ? `${unread}통` : "있음";
    lettersButton.setAttribute("aria-label", unread ? `편지함, 읽지 않은 편지 ${unreadLabel}` : "편지함");
    $("diaryTab").hidden = !st.diary;
    $("aiBanner").hidden = st.ai_ready !== false;
    const ended = st.phase === "ended";
    $("composer").hidden = ended;
    $("writeBtn").disabled = !!st.wrote_today || ended;
    $("writeStatus").hidden = !$("writeBtn").disabled;
    $("writeStatus").textContent = ended ? "편지 쓰기가 끝났어요." : st.wrote_today ? "오늘은 이미 편지를 보냈어요." : "";
    if (st.choice_open && !applyState._asked && Date.now() > (applyState._snooze || 0)) { applyState._asked = true; askChoice(); }
  }

  function ingest(r, phaseChanged = false) {
    const previousRead = readUpto;
    const previousTyping = typing;
    if (r.cursor) cursor = r.cursor;
    readUpto = Math.max(readUpto, r.read_upto || 0);
    typing = !!r.typing;
    nextAt = r.next_at ? new Date(r.next_at).getTime() : null;
    let added = false;
    for (const m of r.messages || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id); msgs.push(m); added = true;
    }
    if (added || phaseChanged || previousRead !== readUpto || previousTyping !== typing || !$("msgs").firstElementChild) {
      renderMsgs(false);
    }
  }

  async function sync() {
    if (syncing || !token || !S || S.phase === "onboarding") return;
    syncing = true;
    try {
      const r = await api("sync", { cursor, visible: !document.hidden, chat_visible: !document.hidden && tab === "chat" });
      const phaseChanged = S.phase !== r.state.phase;
      applyState(r.state);
      ingest(r, phaseChanged);
      if (tab === "letters" && r.state.unread_letters !== lettersCache.filter((l) => l.s === "him" && !l.read && !l.pending).length) loadLetters();
    } catch (e) { /* 다음 차례에 */ }
    syncing = false;
  }

  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    if (ms == null) {
      const now = Date.now();
      const waitingMine = msgs.some((m) => m.s === "her" && m.id > readUpto);
      ms = typing ? 1500 : waitingMine ? 4000 : 9000;
      if (nextAt && nextAt > now) ms = Math.min(ms, Math.max(300, nextAt - now + 150));
    }
    pollTimer = setTimeout(async () => { await sync(); schedulePoll(); }, ms);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && token) { sync().then(() => schedulePoll()); }
    else clearTimeout(pollTimer);
  });

  // ───────── 렌더링
  const PHOTO_ICON = '<svg viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="12.5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8.5 6l1.3-2h4.4l1.3 2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  const FIVE_MIN = 5 * 60000;
  const close = (a, b) => a && b && a.delivery !== "failed" && b.delivery !== "failed" &&
    a.s === b.s && a.s !== "system" && dayKey(a.at) === dayKey(b.at) && Math.abs(new Date(b.at) - new Date(a.at)) <= FIVE_MIN;

  function rowHTML(side, pos, content, meta, extra = "") {
    return side === "her"
      ? `<div class="row-msg her ${pos}${extra}">${meta}${content}</div>`
      : `<div class="row-msg him ${pos}${extra}"><span class="mini av" aria-hidden="true">${esc(partnerInitial())}</span>${content}${meta}</div>`;
  }

  function renderMsgs(scroll) {
    const previousTop = chatPane.scrollTop;
    const followLatest = scroll || !awayFromLatest();
    const box = $("msgs");
    const focusedRetry = document.activeElement?.dataset.retryMessage;
    const parts = [];
    let lastDay = null;
    msgs.sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1));
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const dk = dayKey(m.at);
      if (dk !== lastDay) { parts.push(`<div class="day-sep">${fmtDay.format(new Date(m.at))}</div>`); lastDay = dk; }
      if (m.s === "system") { parts.push(`<div class="sys">${esc(m.b)}</div>`); continue; }
      if (m.delivery === "failed") {
        parts.push(rowHTML("her", "single", `<div class="bubble" id="failed-message-${m.id}">${esc(m.b)}</div>`, ""));
        parts.push(`<div class="receipt failed-receipt"><span>전송 실패</span><button type="button" data-retry-message="${m.id}" aria-describedby="failed-message-${m.id}"${S?.phase === "ended" ? " disabled" : ""}>다시 보내기</button></div>`);
        continue;
      }
      const prev = msgs[i - 1], next = msgs[i + 1];
      const withPrev = close(prev, m), withNext = close(m, next);
      const pos = withPrev ? (withNext ? "mid" : "last") : (withNext ? "first" : "single");
      const sameMinNext = next && next.delivery !== "failed" && next.s === m.s && fmtTime.format(new Date(next.at)) === fmtTime.format(new Date(m.at)) && dayKey(next.at) === dk;
      const meta = sameMinNext ? "" : `<div class="meta"><span>${fmtTime.format(new Date(m.at))}</span></div>`;
      const extra = m.delivery === "sending" ? " temp" : "";
      if (m.k === "photo" && m.s === "him") {
        const card = `<div class="photo-card"><div class="ph">${PHOTO_ICON}</div>${m.d ? `<div class="desc">${esc(m.d)}</div>` : ""}</div>`;
        if (m.b) {
          // 사진 + 한마디: 두 줄로 이어 붙이기
          parts.push(rowHTML("him", withPrev ? "mid" : "first", card, ""));
          parts.push(rowHTML("him", withNext ? "mid" : "last", `<div class="bubble">${esc(m.b)}</div>`, meta));
        } else parts.push(rowHTML("him", pos, card, meta));
        continue;
      }
      let content;
      if (m.k === "photo") {
        const src = photoCache.get(m.p);
        content = `<img class="her-photo" data-photo="${m.p}" alt="보낸 사진" ${src ? `src="${src}"` : ""}>`;
      } else content = `<div class="bubble">${esc(m.b)}</div>`;
      parts.push(rowHTML(m.s, pos, content, meta, extra));
    }
    // 마지막 말이 내 것이면 읽음 표시
    const last = [...msgs].reverse().find((m) => m.s !== "system");
    if (last && last.s === "her" && last.delivery !== "failed") {
      const r = last.delivery === "sending" ? "보내는 중…" : last.id <= readUpto ? "읽음" : "전송됨";
      parts.push(`<div class="receipt">${r}</div>`);
    }
    if (!msgs.length) parts.push(`<div class="empty">아직 대화가 없어요.</div>`);
    box.innerHTML = parts.join("");
    if (focusedRetry) box.querySelector(`[data-retry-message="${focusedRetry}"]`)?.focus({ preventScroll: true });
    $("typing").hidden = !typing;
    loadPhotos();
    if ($("chatView").hidden) return;
    if (followLatest) scrollToLatest();
    else { chatPane.scrollTop = previousTop; updateJump(); }
  }

  function awayFromLatest() {
    return chatPane.scrollHeight - chatPane.scrollTop - chatPane.clientHeight > 140;
  }
  function updateJump() {
    if ($("chatView").hidden) return;
    const away = awayFromLatest();
    readingOffset = away ? chatPane.scrollTop : null;
    jumpButton.hidden = !away;
  }
  function scrollToLatest() {
    chatPane.scrollTop = chatPane.scrollHeight;
    updateJump();
  }
  chatPane.addEventListener("scroll", updateJump, { passive: true });
  jumpButton.addEventListener("click", () => {
    chatPane.focus({ preventScroll: true });
    scrollToLatest();
  });

  async function loadPhotos() {
    for (const img of document.querySelectorAll("img[data-photo]:not([src])")) {
      const id = Number(img.dataset.photo);
      if (photoCache.has(id)) { img.src = photoCache.get(id); continue; }
      photoCache.set(id, "");
      try {
        const r = await api("photo", { id });
        const url = `data:${r.mime};base64,${r.data}`;
        photoCache.set(id, url);
        document.querySelectorAll(`img[data-photo="${id}"]`).forEach((x) => (x.src = url));
      } catch { photoCache.delete(id); }
    }
  }

  // ───────── 탭
  function setTab(t) {
    tab = t;
    for (const [view, id] of views) $(id).hidden = view !== t;
    for (const item of navItems) {
      if (item.dataset.view === t) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    if (t === "letters") loadLetters();
    if (t === "diary") loadDiary();
    if (t === "settings") pushHelp();
    if (t === "chat") {
      if (readingOffset == null) scrollToLatest();
      else { chatPane.scrollTop = readingOffset; updateJump(); }
      sync();
    }
  }

  // ───────── 보내기
  const input = $("input");
  function autosize() {
    input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px";
    $("sendBtn").disabled = !input.value.trim();
  }
  input.addEventListener("input", autosize);
  const desktop = matchMedia("(pointer: fine)").matches;
  input.addEventListener("keydown", (e) => {
    if (desktop && e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
  });
  $("sendBtn").addEventListener("mousedown", (e) => e.preventDefault()); // 키보드 안 내려가게
  $("sendBtn").addEventListener("click", () => { send(); input.focus(); });
  $("msgs").addEventListener("click", (e) => {
    const button = e.target.closest("[data-retry-message]");
    if (!button || S?.phase === "ended") return;
    const message = msgs.find((m) => m.id === Number(button.dataset.retryMessage) && m.delivery === "failed");
    if (message) sendMessage(message);
  });

  function send() {
    const text = input.value.trim();
    if (!text || !token || S?.phase === "ended") return;
    input.value = ""; autosize();
    const message = { id: --nextLocalMessageId, s: "her", k: "text", b: text, at: new Date().toISOString() };
    msgs.push(message);
    sendMessage(message, true);
  }

  async function sendMessage(message, scroll = false) {
    const requestToken = token;
    message.delivery = "sending";
    renderMsgs(scroll);
    try {
      const r = await api("send", { text: message.b });
      if (token !== requestToken || !msgs.includes(message)) return;
      if (!seen.has(r.message.id)) { seen.add(r.message.id); msgs.push(r.message); }
      msgs = msgs.filter((m) => m !== message);
    } catch (e) {
      if (token !== requestToken || !msgs.includes(message)) return;
      message.delivery = "failed";
      renderMsgs(false);
      toast(e.message || "메시지를 보내지 못했어요");
      return;
    }
    renderMsgs(false);
    schedulePoll(2500);
  }

  $("photoBtn").addEventListener("click", () => $("photoInput").click());
  $("photoInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      toast("사진을 보내는 중…", 1500);
      const { data, mime, url } = await shrink(f);
      const r = await api("send", { image: data, mime });
      photoCache.set(r.message.p, url);
      if (!seen.has(r.message.id)) { seen.add(r.message.id); msgs.push(r.message); }
      renderMsgs(true); schedulePoll(2500);
    } catch (err) { toast(err.message || "사진을 보내지 못했어요"); }
  });

  async function shrink(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
    let w, h, src;
    if (bmp) { w = bmp.width; h = bmp.height; src = bmp; }
    else {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    const scale = Math.min(1, 1280 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.82);
    return { data: url.split(",")[1], mime: "image/jpeg", url };
  }

  // ───────── 편지
  async function loadLetters() {
    const list = $("letterList");
    if (!list.childElementCount) list.innerHTML = `<div class="empty" role="status">편지를 불러오는 중…</div>`;
    try {
      const r = await api("letters");
      lettersCache = r.letters;
      renderLetters();
    } catch (e) {
      if (lettersCache.length) toast(e.message);
      else list.innerHTML = `<div class="empty" role="status">${esc(e.message)}</div>`;
    }
  }

  const fmtMD = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, month: "long", day: "numeric" });
  function when(iso) {
    const d = new Date(iso);
    const k = dayKey(iso), today = dayKey(new Date().toISOString());
    if (k === today) return fmtTime.format(d);
    if (k === dayKey(new Date(Date.now() - 86400000).toISOString())) return "어제";
    return fmtMD.format(d);
  }

  function renderLetters() {
    const box = $("letterList");
    if (!lettersCache.length) { box.innerHTML = `<div class="empty">아직 편지가 없어요.</div>`; return; }
    const name = esc(hisName());
    const row = (cls, name, prev, time, dot, id) => {
      const previewId = id == null ? "" : `letter-preview-${Number(id)}`;
      const title = id == null
        ? `<span class="lrow-name">${name}</span>`
        : `<button class="lrow-name letter-link" type="button" data-id="${Number(id)}" aria-describedby="${previewId}">${name}</button>`;
      return `<article class="lrow${cls}">
        <div class="lrow-head"><span class="lrow-sender">${title}${dot ? '<i class="dot" role="img" aria-label="읽지 않음"></i>' : ""}</span>
        ${time ? `<span class="when">${time}</span>` : ""}</div>
        <p class="lrow-prev"${previewId ? ` id="${previewId}"` : ""}>${prev}</p></article>`;
    };
    box.innerHTML = lettersCache.map((l) => {
      if (l.pending) {
        return row(" pending", name,
          "편지가 오고 있어요", `${fmtShort.format(new Date(l.at))} 도착`, false);
      }
      const first = esc(String(l.body || "").split("\n").filter((x) => x.trim()).slice(0, 2).join(" "));
      if (l.s === "him") {
        return row(l.read ? "" : " unread", name, first, when(l.at), !l.read, l.id);
      }
      const arrived = new Date(l.arrives) <= new Date();
      return row("", "내가 쓴 편지", first,
        arrived ? "도착함" : `${fmtShort.format(new Date(l.arrives))} 도착 예정`, false, l.id);
    }).join("");
  }

  function showPaper(mode, push = false) {
    const writing = mode === "write";
    const letter = writing ? null : lettersCache.find((item) => item.id === mode);
    if (writing ? $("writeBtn").disabled : !letter) return;
    if (push) history.pushState({ view: "letters", paper: mode }, "");
    $("paperRead").hidden = writing;
    $("paperWriteWrap").hidden = !writing;
    $("paperSend").hidden = !writing;
    $("paper").hidden = false;
    updateInert();
    if (writing) {
      $("paperTitle").textContent = "편지 쓰기";
      $("paperWrite").value = store.get("mm_draft") || "";
      countLetter();
      paperTrigger = $("writeBtn");
      $("paperWrite").focus();
      return;
    }
    $("paperTitle").textContent = letter.s === "him" ? `${hisName()}의 편지` : "내가 쓴 편지";
    $("paperRead").textContent = letter.body;
    $("paperRead").scrollTop = 0;
    if (letter.s === "him" && !letter.read) {
      letter.read = true;
      api("letter_read", { id: letter.id }).then(() => sync()).catch(() => {});
      renderLetters();
    }
    paperTrigger = $("letterList").querySelector(`button[data-id="${mode}"]`);
    $("paperClose").focus();
  }
  $("letterList").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-id]");
    if (button) showPaper(Number(button.dataset.id), true);
  });
  $("writeBtn").addEventListener("click", () => showPaper("write", true));
  function countLetter() { $("paperCount").textContent = `${$("paperWrite").value.length}자`; store.set("mm_draft", $("paperWrite").value); }
  $("paperWrite").addEventListener("input", countLetter);
  $("paperClose").addEventListener("click", closePaper);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("modal").hidden) $("modalBtns").lastElementChild?.click();
    else if (!$("paper").hidden) closePaper();
  });
  $("paperSend").addEventListener("click", async () => {
    const submit = $("paperSend");
    if (submit.disabled) return;
    const body = $("paperWrite").value.trim();
    if (body.length < 10) { toast("편지는 10자 이상 써 주세요."); return; }
    const ok = await modal("이대로 보낼까요?\n내일 정오에 도착하고, 보낸 뒤엔 고칠 수 없어요.", [{ label: "보내기", value: true, primary: true }, { label: "취소", value: false }]);
    if (!ok) return;
    submit.disabled = true;
    try {
      await api("letter_send", { body });
      if ($("paperWrite").value.trim() === body) {
        store.del("mm_draft");
        if (history.state?.paper === "write") closePaper();
      }
      toast("보냈어요. 내일 정오에 도착해요.", 3000);
      await sync(); loadLetters();
    } catch (e) { toast(e.message, 3200); }
    finally { submit.disabled = false; }
  });

  // ───────── 일기
  async function loadDiary() {
    const list = $("diaryList");
    if (!list.firstElementChild) list.innerHTML = `<div class="empty" role="status">일기를 불러오는 중…</div>`;
    try {
      const r = await api("diary");
      list.innerHTML = r.diary.length
        ? r.diary.map((d) => `<article class="diary-entry">${esc(d.text)}</article>`).join("")
        : `<div class="empty">아직 일기가 없어요.</div>`;
    } catch (e) {
      if (list.querySelector(".diary-entry")) toast(e.message);
      else list.innerHTML = `<div class="empty" role="status">${esc(e.message)}</div>`;
    }
  }

  // ───────── 30일째 밤
  async function askChoice() {
    const v = await modal("30일째 밤입니다.\n이름을 교환할까요?\n\n두 사람 모두 원할 때만 이름이 건너갑니다.", [
      { label: "이름 교환", value: "continue", primary: true },
      { label: "종료", value: "end" },
      { label: "나중에", value: null },
    ]);
    if (!v) { applyState._snooze = Date.now() + 10 * 60000; applyState._asked = false; return; }
    const sure = await modal(v === "continue" ? "이름을 알려주기로 할까요?" : "여기서 끝내기로 할까요?\n그는 끝까지 당신의 이름을 몰라요.", [{ label: "확인", value: true, primary: true }, { label: "취소", value: false }]);
    if (!sure) { applyState._asked = false; return; }
    try {
      await api("choose", { choice: v });
      toast("그의 편지가 곧 도착해요.", 4000);
      navigate("letters");
    } catch (e) { toast(e.message); applyState._asked = false; }
  }

  // ───────── 설정·알림
  $("logout").addEventListener("click", async () => {
    const ok = await modal("이 기기를 잠글까요?\n다시 열려면 암호가 필요해요.", [{ label: "잠그기", value: true, primary: true }, { label: "취소", value: false }]);
    if (ok) lock();
  });

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function pushHelp() {
    const help = $("pushHelp");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      help.textContent = isIOS && !standalone
        ? "아이폰은 Safari 공유 버튼 → '홈 화면에 추가' 후, 홈 화면 아이콘으로 열어야 알림을 켤 수 있어요."
        : "이 브라우저는 알림을 지원하지 않아요.";
      $("pushBtn").disabled = true; return;
    }
    $("pushBtn").disabled = false;
    help.textContent = Notification.permission === "granted" ? "알림이 켜져 있어요." : "그가 먼저 톡하거나 편지가 오면 알려드려요.";
    $("pushBtn").textContent = Notification.permission === "granted" ? "다시 연결" : "알림 켜기";
  }

  function b64uToBytes(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }

  $("pushBtn").addEventListener("click", async () => {
    try {
      if (!vapid) throw new Error("서버 알림 키가 없어요");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("알림이 허용되지 않았어요"); pushHelp(); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(vapid) });
      await api("push_subscribe", { subscription: sub.toJSON() });
      toast("알림을 켰어요");
      pushHelp();
    } catch (e) { toast(e.message || "알림을 켜지 못했어요"); }
  });
  $("pushTest").addEventListener("click", async () => {
    try { const r = await api("push_test"); toast(r.results?.length ? "보냈어요. 잠시 뒤 확인해 보세요." : "아직 알림이 연결된 기기가 없어요"); }
    catch (e) { toast(e.message); }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "open" && !$("app").hidden) navigate(e.data.tab || "chat");
    });
  }
  if (navigator.clearAppBadge) document.addEventListener("visibilitychange", () => { if (!document.hidden) navigator.clearAppBadge().catch(() => {}); });

  function start() {
    boot().catch((e) => {
      if (!token) return lock();
      toast(e.message || "연결이 불안정해요");
      setTimeout(start, 5000);
    });
  }
  start();
})();
