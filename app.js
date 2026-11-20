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
  const AV = '<svg viewBox="0 0 24 24"><path d="M12.00 11.40 L12.15 11.34 L12.32 11.32 L12.51 11.35 L12.70 11.43 L12.88 11.57 L13.03 11.76 L13.13 11.99 L13.18 12.26 L13.16 12.54 L13.07 12.83 L12.90 13.11 L12.67 13.35 L12.37 13.54 L12.02 13.66 L11.64 13.70 L11.24 13.64 L10.85 13.49 L10.49 13.25 L10.18 12.92 L9.95 12.51 L9.81 12.05 L9.78 11.55 L9.87 11.03 L10.08 10.54 L10.40 10.09 L10.83 9.72 L11.34 9.44 L11.92 9.29 L12.54 9.26 L13.17 9.38 L13.76 9.64 L14.30 10.04 L14.74 10.57 L15.06 11.19 L15.24 11.89 L15.26 12.62 L15.11 13.36 L14.79 14.06 L14.32 14.68 L13.70 15.20 L12.97 15.57 L12.16 15.77 L11.31 15.79 L10.45 15.61 L9.65 15.24 L8.93 14.68 L8.35 13.97 L7.93 13.14 L7.70 12.21 L7.69 11.24 L7.89 10.27 L8.32 9.36 L8.94 8.56 L9.75 7.90 L10.69 7.43 L11.73 7.18 L12.82 7.16 L13.90 7.39 L14.92 7.87 L15.81 8.57 L16.55 9.46 L17.07 10.51 L17.35 11.66 L17.37 12.87 L17.11 14.06 L16.59 15.19 L15.82 16.18 L14.83 16.99 L13.68 17.57 L12.41 17.87 L11.09 17.89 L9.78 17.62 L8.54 17.05 L7.46 16.21 L6.57 15.13 L5.94 13.88 L5.60 12.49 L5.58 11.05 L5.88 9.62 L6.49 8.28 L7.40 7.10 L8.56 6.14 L9.92 5.45 L11.42 5.08 L12.98 5.05 L14.52 5.36 L15.97 6.03 L17.25 7.00 L18.29 8.25 L19.04 9.71" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.querySelectorAll("[data-av]").forEach((el) => (el.innerHTML = AV));
  const hisName = () => esc(S?.him || "그");

  // ───────── 겹쳐 열리는 화면(편지함·일기·정보·편지지): 안드로이드 뒤로가기도 받기
  const layers = [];
  function showLayer(name) {
    if (name === "letters" || name === "diary") setTab(name);
    else if (name === "settings") { $("settings").hidden = false; pushHelp(); }
  }
  function hideLayer(name) {
    if (name === "letters" || name === "diary") { if (tab === name) setTab("chat"); }
    else $(name).hidden = true;
  }
  function openLayer(name, fn) {
    if (fn) fn(); else showLayer(name);
    if (layers[layers.length - 1] === name) return;
    layers.push(name);
    try { history.pushState({ mm: layers.length }, ""); } catch { /* noop */ }
  }
  function goBack(name) {
    if (layers[layers.length - 1] === name) history.back();
    else hideLayer(name);
  }
  window.addEventListener("popstate", () => { const top = layers.pop(); if (top) hideLayer(top); });
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { if (o.dataset.open === "diary" && $("diaryTab").hidden) return; openLayer(o.dataset.open); return; }
    const b = e.target.closest("[data-back]");
    if (b) goBack(b.dataset.back);
  });

  // ───────── 화면 전환
  function show(id) {
    for (const s of ["lock", "onboard", "app"]) $(s).hidden = s !== id;
  }
  function lock() {
    token = null; store.del("mm_token");
    for (const id of ["settings", "paper", "letters", "diary"]) $(id).hidden = true;
    layers.length = 0; tab = "chat";
    show("lock"); setTimeout(() => $("pass").focus(), 50);
  }
  function toast(t, ms = 2400) {
    const el = $("toast"); el.textContent = t; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms);
  }
  function modal(text, buttons) {
    return new Promise((resolve) => {
      $("modalText").textContent = text;
      const box = $("modalBtns"); box.innerHTML = "";
      for (const b of buttons) {
        const el = document.createElement("button");
        el.className = "btn " + (b.primary ? "primary" : "");
        el.textContent = b.label;
        el.onclick = () => { $("modal").hidden = true; resolve(b.value); };
        box.appendChild(el);
      }
      $("modal").hidden = false;
    });
  }

  // ───────── 잠금
  $("lockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("lockErr").textContent = "";
    try {
      const r = await api("login", { passcode: $("pass").value, label: navigator.userAgent.slice(0, 60) });
      token = r.token; store.set("mm_token", token); $("pass").value = "";
      await boot();
    } catch (err) { $("lockErr").textContent = err.message; }
  });

  // ───────── 시작
  $("startBtn").addEventListener("click", async () => {
    const name = $("codename").value.trim();
    if (!name) { $("onbErr").textContent = "가명을 정해 주세요"; return; }
    const ok = await modal(`'${name}'(으)로 시작할까요?\n시작하는 순간부터 30일이 흐릅니다.`, [{ label: "시작", value: true, primary: true }, { label: "조금 더 생각할게요", value: false }]);
    if (!ok) return;
    $("startBtn").disabled = true;
    try {
      await api("start", { codename: name });
      await boot();
      setTab("letters");
      toast("매칭됐어요. 상대의 첫 편지가 곧 도착해요.", 3800);
    } catch (err) { $("onbErr").textContent = err.message; }
    $("startBtn").disabled = false;
  });

  // ───────── 부팅·동기화
  async function boot() {
    if (!CFG.api) { document.body.innerHTML = "<p style='padding:24px'>config.js의 api 주소를 확인하세요.</p>"; return; }
    if (!token) { lock(); return; }
    const r = await api("boot", { visible: !document.hidden, chat_visible: false });
    vapid = r.vapid;
    applyState(r.state);
    if (S.phase === "onboarding") { show("onboard"); return; }
    show("app");
    msgs = []; seen.clear(); $("msgs").innerHTML = "";
    ingest(r);
    const q = new URLSearchParams(location.search).get("tab");
    setTab(q === "letters" ? "letters" : tab);
    schedulePoll(400);
  }

  function applyState(st) {
    S = st;
    $("hisName").textContent = st.him || "";
    $("infoName").textContent = st.him || "";
    $("status").textContent = st.status || "";
    $("infoStatus").textContent = st.status || "";
    $("presence").textContent = st.presence || "";
    $("dday").textContent = st.day ? `${st.day}일째` : "";
    $("dayText").textContent = st.day ? `${st.day}일째` : "";
    $("dayBar").style.width = st.day ? `${Math.min(100, (st.day / 30) * 100)}%` : "0";
    $("myName").textContent = st.her || "";
    const unread = st.unread_letters;
    $("letterBadge").hidden = !unread;
    $("letterBadge").textContent = typeof unread === "number" && unread > 0 ? (unread > 9 ? "9+" : String(unread)) : "";
    $("diaryTab").hidden = !st.diary;
    $("aiBanner").hidden = st.ai_ready !== false;
    const ended = st.phase === "ended";
    $("composer").hidden = ended;
    $("writeBtn").disabled = !!st.wrote_today || ended;
    $("writeLabel").textContent = st.wrote_today ? "오늘은 이미 썼어요" : "편지 쓰기";
    $("writeSub").textContent = ended ? "이제 편지를 쓸 수 없어요" : st.wrote_today ? "내일 또 쓸 수 있어요" : "하루 한 통 · 내일 정오에 도착해요";
    if (st.choice_open && !applyState._asked && Date.now() > (applyState._snooze || 0)) { applyState._asked = true; askChoice(); }
  }

  function ingest(r) {
    if (r.cursor) cursor = r.cursor;
    readUpto = Math.max(readUpto, r.read_upto || 0);
    typing = !!r.typing;
    nextAt = r.next_at ? new Date(r.next_at).getTime() : null;
    let added = false;
    for (const m of r.messages || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id); msgs.push(m); added = true;
    }
    renderMsgs(added);
  }

  async function sync() {
    if (syncing || !token || !S || S.phase === "onboarding") return;
    syncing = true;
    try {
      const r = await api("sync", { cursor, visible: !document.hidden, chat_visible: !document.hidden && tab === "chat" });
      applyState(r.state);
      ingest(r);
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
  const close = (a, b) => a && b && a.s === b.s && a.s !== "system" && dayKey(a.at) === dayKey(b.at) && Math.abs(new Date(b.at) - new Date(a.at)) <= FIVE_MIN;

  function introHTML() {
    const day = S?.day ? ` · ${S.day}일째` : "";
    return `<div class="intro"><span class="ring lg"><span class="av">${AV}</span></span>
      <div class="intro-name">${hisName()}</div>
      <div class="intro-sub">무명${day}</div>
      <div class="intro-sub">이름 모르는 채로, 서른 날.</div>
      <button class="pill" data-open="letters">편지함 보기</button></div>`;
  }

  function rowHTML(side, pos, content, meta, extra = "") {
    return side === "her"
      ? `<div class="row-msg her ${pos}${extra}">${meta}${content}</div>`
      : `<div class="row-msg him ${pos}${extra}"><span class="mini av">${AV}</span>${content}${meta}</div>`;
  }

  function renderMsgs(scroll) {
    const pane = $("chat");
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140;
    const box = $("msgs");
    const parts = [introHTML()];
    let lastDay = null;
    msgs.sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1));
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const dk = dayKey(m.at);
      if (dk !== lastDay) { parts.push(`<div class="day-sep">${fmtDay.format(new Date(m.at))}</div>`); lastDay = dk; }
      if (m.s === "system") { parts.push(`<div class="sys">${esc(m.b)}</div>`); continue; }
      const prev = msgs[i - 1], next = msgs[i + 1];
      const withPrev = close(prev, m), withNext = close(m, next);
      const pos = withPrev ? (withNext ? "mid" : "last") : (withNext ? "first" : "single");
      const sameMinNext = next && next.s === m.s && fmtTime.format(new Date(next.at)) === fmtTime.format(new Date(m.at)) && dayKey(next.at) === dk;
      const meta = sameMinNext ? "" : `<div class="meta"><span>${fmtTime.format(new Date(m.at))}</span></div>`;
      const extra = m.temp ? " temp" : "";
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
    if (last && last.s === "her") {
      const r = last.temp ? "보내는 중…" : last.id <= readUpto ? "읽음" : "전송됨";
      parts.push(`<div class="receipt">${r}</div>`);
    }
    if (!msgs.length) parts.push(`<div class="empty">아직 아무 말도 오가지 않았어요.<br>먼저 편지함을 열어보세요.</div>`);
    box.innerHTML = parts.join("");
    $("typing").hidden = !typing;
    loadPhotos();
    if (scroll || nearBottom) requestAnimationFrame(() => (pane.scrollTop = pane.scrollHeight));
  }

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
    $("letters").hidden = t !== "letters";
    $("diary").hidden = t !== "diary";
    if (t === "letters") loadLetters();
    if (t === "diary") loadDiary();
    if (t === "chat") { renderMsgs(true); sync(); }
  }

  // ───────── 보내기
  const input = $("input");
  function autosize() {
    input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px";
    $("composer").classList.toggle("has-text", !!input.value.trim());
  }
  input.addEventListener("input", autosize);
  const desktop = matchMedia("(pointer: fine)").matches;
  input.addEventListener("keydown", (e) => {
    if (desktop && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("sendBtn").addEventListener("mousedown", (e) => e.preventDefault()); // 키보드 안 내려가게
  $("sendBtn").addEventListener("click", () => { send(); input.focus(); });

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; autosize();
    const temp = { id: -Date.now(), s: "her", k: "text", b: text, at: new Date().toISOString(), temp: true };
    msgs.push(temp); renderMsgs(true);
    try {
      const r = await api("send", { text });
      msgs = msgs.filter((m) => m !== temp);
      if (!seen.has(r.message.id)) { seen.add(r.message.id); msgs.push(r.message); }
      renderMsgs(true);
      schedulePoll(2500);
    } catch (e) {
      msgs = msgs.filter((m) => m !== temp); renderMsgs(true);
      input.value = text; autosize();
      toast(e.message);
    }
  }

  $("photoBtn").addEventListener("click", () => $("photoInput").click());
  $("galleryBtn").addEventListener("click", () => $("photoInput").click());
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
    try {
      const r = await api("letters");
      lettersCache = r.letters;
      renderLetters();
    } catch (e) { toast(e.message); }
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
    const me = esc(Array.from(S?.her || "나")[0] || "나");
    const row = (cls, av, name, prev, time, dot, id) => {
      const tag = id == null ? "div" : "button";
      return `<${tag} class="lrow${cls}"${id == null ? "" : ` data-id="${id}"`}>${av}
        <span class="lrow-main"><span class="lrow-name">${name}</span>
        <span class="lrow-prev"><span class="txt">${prev}</span>${time ? `<span class="when">${time}</span>` : ""}</span></span>
        ${dot ? '<i class="dot"></i>' : ""}</${tag}>`;
    };
    box.innerHTML = lettersCache.map((l) => {
      if (l.pending) {
        return row(" pending", `<span class="ring"><span class="av">${AV}</span></span>`, hisName(),
          "편지가 오고 있어요", `${fmtShort.format(new Date(l.at))} 도착`, false);
      }
      const first = esc(String(l.body || "").split("\n").filter((x) => x.trim()).slice(0, 2).join(" "));
      if (l.s === "him") {
        return row(l.read ? "" : " unread", `<span class="av">${AV}</span>`, hisName(), first, when(l.at), !l.read, l.id);
      }
      const arrived = new Date(l.arrives) <= new Date();
      return row("", `<span class="av me">${me}</span>`, "내가 쓴 편지", first,
        arrived ? "도착함" : `${fmtShort.format(new Date(l.arrives))} 도착 예정`, false, l.id);
    }).join("");
    for (const el of box.querySelectorAll("button.lrow")) el.addEventListener("click", () => openLetter(Number(el.dataset.id)));
  }

  function openLetter(id) {
    const l = lettersCache.find((x) => x.id === id);
    if (!l) return;
    $("paperTitle").textContent = l.s === "him" ? `${S?.him || "그"}의 편지` : "내가 쓴 편지";
    $("paperRead").textContent = l.body;
    $("paperRead").hidden = false;
    $("paperWriteWrap").hidden = true;
    $("paperSend").hidden = true;
    openLayer("paper", () => ($("paper").hidden = false));
    $("paperRead").scrollTop = 0;
    if (l.s === "him" && !l.read) {
      l.read = true;
      api("letter_read", { id }).then(() => sync()).catch(() => {});
      renderLetters();
    }
  }

  $("writeBtn").addEventListener("click", () => {
    $("paperTitle").textContent = "편지 쓰기";
    $("paperRead").hidden = true;
    $("paperWriteWrap").hidden = false;
    $("paperSend").hidden = false;
    $("paperWrite").value = store.get("mm_draft") || "";
    countLetter();
    openLayer("paper", () => ($("paper").hidden = false));
    setTimeout(() => $("paperWrite").focus(), 80);
  });
  function countLetter() { $("paperCount").textContent = `${$("paperWrite").value.length}자`; store.set("mm_draft", $("paperWrite").value); }
  $("paperWrite").addEventListener("input", countLetter);
  $("paperClose").addEventListener("click", () => goBack("paper"));
  $("paperSend").addEventListener("click", async () => {
    const body = $("paperWrite").value.trim();
    if (body.length < 10) { toast("조금만 더 써 주세요"); return; }
    const ok = await modal("이대로 보낼까요?\n내일 정오에 도착하고, 보낸 뒤엔 고칠 수 없어요.", [{ label: "보내기", value: true, primary: true }, { label: "더 쓸게요", value: false }]);
    if (!ok) return;
    try {
      await api("letter_send", { body });
      store.del("mm_draft");
      goBack("paper");
      toast("보냈어요. 내일 정오에 도착해요.", 3000);
      await sync(); loadLetters();
    } catch (e) { toast(e.message, 3200); }
  });

  // ───────── 일기
  async function loadDiary() {
    try {
      const r = await api("diary");
      $("diaryList").innerHTML = r.diary.length
        ? r.diary.map((d) => `<div class="diary-entry">${esc(d.text)}</div>`).join("")
        : `<div class="empty">아직 일기가 없어요.</div>`;
    } catch (e) { $("diaryList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ───────── 30일째 밤
  async function askChoice() {
    const v = await modal("30일째 밤입니다.\n진짜 이름을 교환할까요?\n\n두 사람 모두 원할 때만 이름이 건너갑니다.", [
      { label: "진짜 이름을 알려줄게요", value: "continue", primary: true },
      { label: "여기서 끝낼게요", value: "end" },
      { label: "조금 이따 고를게요", value: null },
    ]);
    if (!v) { applyState._snooze = Date.now() + 10 * 60000; applyState._asked = false; return; }
    const sure = await modal(v === "continue" ? "진짜 이름을 알려주기로 할까요?" : "여기서 끝내기로 할까요?\n그는 끝까지 당신의 진짜 이름을 모릅니다.", [{ label: "네", value: true, primary: true }, { label: "다시 생각할게요", value: false }]);
    if (!sure) { applyState._asked = false; return; }
    try {
      await api("choose", { choice: v });
      toast("그의 편지가 곧 도착해요.", 4000);
      setTab("letters");
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
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "open") setTab(e.data.tab || "chat"); });
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
