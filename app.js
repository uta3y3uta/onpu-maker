// =============================================================
// おんぷメーカー — 音声→モーラ→音符化アプリ
// =============================================================

// ---------- 1. 状態 ----------
const state = {
  audioCtx: null,
  rhythmPlaying: false,
  rhythmTimerId: null,
  rhythmStep: 0,
  bpm: 100,
  patternIndex: 0,
  moras: [],            // 例: ["バ","ナ","ナ"]
  notes: [],            // 例: [{kana:"バ", symbol:"♩", beats:1, type:"quarter"}]
  notesPlaying: false,
};

// ---------- 2. リズムパターン (16分音符グリッド × 16ステップ) ----------
// 各セルは {k:キック, s:スネア, h:ハイハット, c:クラップ} の何れか
// 1=鳴らす, 0=鳴らさない
const PATTERNS = [
  { name: "シンプル ♩×4", grid:
    "k...k...k...k...|" +
    "....s.......s...|" +
    "h.h.h.h.h.h.h.h." },
  { name: "ロック", grid:
    "k.......k...k...|" +
    "....s.......s...|" +
    "h.h.h.h.h.h.h.h." },
  { name: "ディスコ", grid:
    "k...k...k...k...|" +
    "..s...s...s...s.|" +
    "hhhhhhhhhhhhhhhh" },
  { name: "マーチ", grid:
    "k...k...k...k...|" +
    "....s.......s...|" +
    "h...h...h...h..." },
  { name: "ワルツ (3/4)", grid:
    "k.....s.....s...|" +
    "................|" +
    "h.h.h.h.h.h....." },
  { name: "サンバ", grid:
    "k..k...kk..k....|" +
    "....s.......s...|" +
    "hhhhhhhhhhhhhhhh" },
  { name: "ボサノバ", grid:
    "k.....k...k.....|" +
    "...s.....s...s..|" +
    "h.h.h.h.h.h.h.h." },
  { name: "ヒップホップ", grid:
    "k.....k...k.k...|" +
    "....s.......s...|" +
    "h.h.h.h.h.h.h.h." },
  { name: "シャッフル", grid:
    "k.....k.....k...|" +
    "....s.......s...|" +
    "h..h..h..h..h..." },
  { name: "レゲエ", grid:
    "....k.......k...|" +
    "....s.......s...|" +
    ".h.h.h.h.h.h.h.h" },
];

// 16ステップ展開
function parsePattern(p) {
  const lines = p.grid.split("|");
  const tracks = { k: [], s: [], h: [] };
  const keys = ["k", "s", "h"];
  lines.forEach((line, i) => {
    const k = keys[i];
    for (let n = 0; n < 16; n++) tracks[k][n] = line[n] === k ? 1 : 0;
  });
  return tracks;
}

// ---------- 3. オーディオ初期化 ----------
function ensureAudio() {
  if (!state.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();
  }
  if (state.audioCtx.state === "suspended") state.audioCtx.resume();
  return state.audioCtx;
}

// ドラム音シンセ
function playKick(t) {
  const ctx = state.audioCtx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.3);
}
function playSnare(t) {
  const ctx = state.audioCtx;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass"; filt.frequency.value = 1500;
  src.buffer = buf;
  g.gain.setValueAtTime(0.6, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(filt).connect(g).connect(ctx.destination);
  src.start(t);
}
function playHat(t) {
  const ctx = state.audioCtx;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass"; filt.frequency.value = 7000;
  src.buffer = buf;
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  src.connect(filt).connect(g).connect(ctx.destination);
  src.start(t);
}

// 音符の再生音 — 単一音程のウッドブロック/木琴風 (リズムを刻むだけ)
function playClick(t, beats, beatLength) {
  const ctx = state.audioCtx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(880, t);
  o.frequency.exponentialRampToValueAtTime(660, t + 0.04);
  // 二分音符など長い音符は減衰も長く
  const decay = Math.min(1.2, Math.max(0.18, beatLength * beats * 0.85));
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + decay + 0.1);
}

// ---------- 4. リズムループ ----------
function startRhythm() {
  ensureAudio();
  state.rhythmPlaying = true;
  state.rhythmStep = 0;
  scheduleNextStep();
  document.getElementById("rhythm-toggle").textContent = "■";
  document.getElementById("rhythm-toggle").classList.add("playing");
}
function stopRhythm() {
  state.rhythmPlaying = false;
  if (state.rhythmTimerId) clearTimeout(state.rhythmTimerId);
  state.rhythmTimerId = null;
  document.getElementById("rhythm-toggle").textContent = "▶";
  document.getElementById("rhythm-toggle").classList.remove("playing");
  document.querySelectorAll("#beat-indicator span").forEach(s => s.classList.remove("active"));
}
function scheduleNextStep() {
  if (!state.rhythmPlaying) return;
  const ctx = state.audioCtx;
  const t = ctx.currentTime + 0.02;
  const stepDur = 60 / state.bpm / 4; // 16分音符の長さ
  const tracks = parsePattern(PATTERNS[state.patternIndex]);
  const step = state.rhythmStep % 16;
  if (tracks.k[step]) playKick(t);
  if (tracks.s[step]) playSnare(t);
  if (tracks.h[step]) playHat(t);

  // ビート表示 (4分音符の頭で点灯)
  if (step % 4 === 0) {
    const idx = step / 4;
    const dots = document.querySelectorAll("#beat-indicator span");
    dots.forEach((d, i) => d.classList.toggle("active", i === idx));
  }

  state.rhythmStep++;
  state.rhythmTimerId = setTimeout(scheduleNextStep, stepDur * 1000);
}

// ---------- 5. モーラ分割 ----------
// 日本語のモーラ単位に分割する
// - 小書き仮名 (ゃゅょぁぃぅぇぉゎ等) は前の文字に結合
// - ッ ー ン は独立した1モーラ
function splitMora(text) {
  const SMALL = "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ";
  const KANA_RANGE = /[぀-ヿー]/; // ひらがな・カタカナ・長音符
  const moras = [];
  // 仮名以外（漢字・英字など）はざっくり1文字=1モーラとする
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!c.trim()) continue;
    const next = chars[i + 1];
    if (next && SMALL.includes(next)) {
      moras.push(c + next);
      i++;
    } else {
      moras.push(c);
    }
  }
  return moras;
}

// 音符・休符の定義（記号・名前・拍数）
const NOTE_INFO = {
  whole:        { symbol: "𝅝",   name: "全音ぷ",       beats: 4 },
  "dotted-half":{ symbol: "𝅗𝅥.",  name: "付点2分音ぷ",  beats: 3 },
  half:         { symbol: "𝅗𝅥",   name: "2分音ぷ",      beats: 2 },
  quarter:      { symbol: "♩",   name: "4分音ぷ",      beats: 1 },
};
const REST_INFO = {
  rest: { symbol: "𝄽", name: "4分休ふ", beats: 1 },
};

// モーラ列 → 音符列に変換 (リズムだけを表す)
// ・各モーラ          → ♩  4分音ぷ (1拍)
// ・モーラ + ー        → 𝅗𝅥  2分音ぷ (2拍)
// ・モーラ + ーー      → 𝅗𝅥. 付点2分音ぷ (3拍)
// ・モーラ + ーーー以上 → 𝅝  全音ぷ (4拍)
// ・ ッ                → 𝄽  4分休ふ (1拍)
function moraToNotes(moras) {
  const notes = [];
  for (let i = 0; i < moras.length; i++) {
    const m = moras[i];
    if (m === "ー") continue;
    if (m === "ッ" || m === "っ") {
      const r = REST_INFO.rest;
      notes.push({ kana: m, symbol: r.symbol, name: r.name, beats: r.beats, type: "rest" });
      continue;
    }
    let extra = 0;
    while (moras[i + 1 + extra] === "ー") extra++;
    let key = "quarter";
    if (extra === 1) key = "half";
    else if (extra === 2) key = "dotted-half";
    else if (extra >= 3) key = "whole";
    const info = NOTE_INFO[key];
    notes.push({
      kana: m + "ー".repeat(extra),
      symbol: info.symbol,
      name: info.name,
      beats: info.beats,
      type: key,
    });
    i += extra;
  }
  return notes;
}

// 音声合成 (記号の名前を よみあげる)
function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = 1.0;
  u.pitch = 1.15;
  speechSynthesis.speak(u);
}

// 一時的なツールチップ
function showNoteTooltip(parent, text) {
  parent.querySelectorAll(".note-tooltip").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "note-tooltip";
  t.textContent = text;
  parent.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------- 6. 音符表示 ----------
function renderNotes() {
  const staff = document.getElementById("staff");
  staff.innerHTML = "";

  // ト音記号 + 4/4拍子記号 を常に表示 (タップで名前を読み上げ)
  const prefix = document.createElement("div");
  prefix.className = "staff-prefix";
  prefix.innerHTML = `
    <button class="clef" data-name="ト音記号" aria-label="ト音記号">𝄞</button>
    <button class="time-sig" data-name="4分の4拍子" aria-label="4分の4拍子"><span>4</span><span>4</span></button>
  `;
  prefix.querySelectorAll("[data-name]").forEach(el => {
    el.addEventListener("click", () => {
      showNoteTooltip(el, el.dataset.name);
      speak(el.dataset.name);
    });
  });
  staff.appendChild(prefix);

  if (state.notes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "ことばを はなすと ここに おんぷが でます";
    staff.appendChild(empty);
    return;
  }
  state.notes.forEach((n, i) => {
    const d = document.createElement("div");
    d.className = `note note-${n.type}`;
    d.dataset.idx = i;
    d.innerHTML = `<div class="symbol">${n.symbol}</div><div class="kana">${n.kana}</div>`;
    d.addEventListener("click", () => {
      showNoteTooltip(d, n.name);
      speak(n.name);
      ensureAudio();
      if (n.type !== "rest") {
        playClick(state.audioCtx.currentTime + 0.05, n.beats, 60 / state.bpm);
      }
    });
    staff.appendChild(d);
  });
}

// 音符を順に再生 (リズムのみ。すべて同じ音色・同じ音程)
function playNotesSequence() {
  if (state.notes.length === 0) return;
  ensureAudio();
  const ctx = state.audioCtx;
  const beat = 60 / state.bpm; // 1拍の長さ (秒)
  const startTime = ctx.currentTime + 0.1;
  let cursor = 0; // 累積拍数
  state.notes.forEach((n, i) => {
    const t = startTime + cursor * beat;
    if (n.type !== "rest") {
      playClick(t, n.beats, beat);
    }
    // 視覚同期
    const delayMs = (t - ctx.currentTime) * 1000;
    setTimeout(() => {
      document.querySelectorAll(".note").forEach(el => el.classList.remove("active"));
      const el = document.querySelector(`.note[data-idx="${i}"]`);
      if (el) el.classList.add("active");
    }, Math.max(0, delayMs));
    cursor += n.beats;
  });
  const totalMs = (cursor * beat + 0.3) * 1000;
  setTimeout(() => document.querySelectorAll(".note").forEach(el => el.classList.remove("active")), totalMs);
}

// ---------- 7. 音声認識 ----------
let recognition = null;
function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById("mic-btn").disabled = true;
    document.getElementById("mic-btn").textContent = "🎤 (このブラウザは非対応)";
    return;
  }
  recognition = new SR();
  recognition.lang = "ja-JP";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (ev) => {
    const text = ev.results[0][0].transcript.trim();
    handleRecognized(text);
  };
  recognition.onerror = (ev) => {
    console.warn("recognition error", ev.error);
    document.getElementById("recognized-text").textContent = "❌";
  };
  recognition.onend = () => {
    document.getElementById("mic-btn").classList.remove("listening");
    document.getElementById("mic-btn").textContent = "🎤";
  };
}

function handleRecognized(text) {
  document.getElementById("recognized-text").textContent = text;
  state.moras = splitMora(text);
  state.notes = moraToNotes(state.moras);
  renderNotes();
}

// ---------- 8. プリセット ----------
const PRESETS = [
  "バナナ", "りんご", "スパゲッティ", "ぶどう", "とうもろこし",
  "オムライス", "おにぎり", "ハンバーガー", "アイスクリーム", "おすし",
  "メロンパン", "クッキー", "チョコレート", "プリン", "ピザ",
  "ケーキ", "コーヒー", "チーズ", "ラーメン",
];

// ---------- 9. ずかん (音符・休符・記号の一覧) ----------
const ZUKAN_SECTIONS = [
  { title: "音ぷ", items: [
    { sym: "𝅝",  name: "全音ぷ",       desc: "4はく" },
    { sym: "𝅗𝅥.", name: "付点2分音ぷ", desc: "3はく" },
    { sym: "𝅗𝅥",  name: "2分音ぷ",     desc: "2はく" },
    { sym: "♩.", name: "付点4分音ぷ", desc: "1.5はく" },
    { sym: "♩",  name: "4分音ぷ",     desc: "1はく" },
    { sym: "♪.", name: "付点8分音ぷ", desc: "0.75はく" },
    { sym: "♪",  name: "8分音ぷ",     desc: "0.5はく" },
    { sym: "𝅘𝅥𝅯",  name: "16分音ぷ",    desc: "0.25はく" },
  ]},
  { title: "休ふ", items: [
    { sym: "𝄻", name: "全休ふ",  desc: "4はく やすむ" },
    { sym: "𝄼", name: "2分休ふ", desc: "2はく やすむ" },
    { sym: "𝄽", name: "4分休ふ", desc: "1はく やすむ" },
    { sym: "𝄾", name: "8分休ふ", desc: "0.5はく やすむ" },
  ]},
  { title: "音部記号", items: [
    { sym: "𝄞", name: "ト音記号" },
    { sym: "𝄢", name: "ヘ音記号" },
  ]},
  { title: "変化記号", items: [
    { sym: "♯", name: "シャープ", desc: "半音 上げる" },
    { sym: "♭", name: "フラット", desc: "半音 下げる" },
    { sym: "♮", name: "ナチュラル", desc: "もとの たかさ" },
  ]},
  { title: "強弱記号", italic: true, items: [
    { sym: "p",  name: "ピアノ",          desc: "弱く" },
    { sym: "mp", name: "メッゾ・ピアノ",   desc: "すこし弱く" },
    { sym: "mf", name: "メッゾ・フォルテ", desc: "すこし強く" },
    { sym: "f",  name: "フォルテ",        desc: "強く" },
  ]},
  { title: "強弱の変化", items: [
    { svg: "cresc", name: "クレシェンド", desc: "だんだん強く" },
    { svg: "decresc", name: "デクレシェンド", desc: "だんだん弱く" },
  ]},
  { title: "えんそう記号", items: [
    { sym: ">", name: "アクセント",   desc: "音を めだたせて" },
    { sym: "・", name: "スタッカート", desc: "音を 短く きる" },
    { sym: "V", name: "ブレス",       desc: "いきつぎ" },
    { svg: "tie",   name: "タイ",     desc: "おなじ高さの音をつなぐ" },
    { svg: "slur",  name: "スラー",   desc: "なめらかに" },
  ]},
  { title: "拍子記号", items: [
    { stack: ["2","4"], name: "4分の2拍子" },
    { stack: ["3","4"], name: "4分の3拍子" },
    { stack: ["4","4"], name: "4分の4拍子" },
    { stack: ["6","8"], name: "8分の6拍子" },
  ]},
  { title: "速度記号", items: [
    { sym: "♩=88", name: "速度記号", desc: "1分間に 4分音ぷが はいる かず" },
  ]},
];

function zukanCardHTML(it, italic) {
  let symHTML = "";
  if (it.svg === "cresc") {
    symHTML = `<svg class="zukan-svg" viewBox="0 0 60 20"><line x1="2" y1="10" x2="58" y2="2" stroke="#1a237e" stroke-width="2"/><line x1="2" y1="10" x2="58" y2="18" stroke="#1a237e" stroke-width="2"/></svg>`;
  } else if (it.svg === "decresc") {
    symHTML = `<svg class="zukan-svg" viewBox="0 0 60 20"><line x1="2" y1="2" x2="58" y2="10" stroke="#1a237e" stroke-width="2"/><line x1="2" y1="18" x2="58" y2="10" stroke="#1a237e" stroke-width="2"/></svg>`;
  } else if (it.svg === "tie" || it.svg === "slur") {
    symHTML = `<svg class="zukan-svg" viewBox="0 0 60 20"><path d="M5 18 Q 30 2 55 18" fill="none" stroke="#1a237e" stroke-width="2"/></svg>`;
  } else if (it.stack) {
    symHTML = `<span class="zukan-stack"><span>${it.stack[0]}</span><span>${it.stack[1]}</span></span>`;
  } else {
    symHTML = `<span class="zukan-sym${italic ? " italic" : ""}">${it.sym}</span>`;
  }
  return `${symHTML}<span class="zukan-name">${it.name}</span>${it.desc ? `<span class="zukan-desc">${it.desc}</span>` : ""}`;
}

function buildZukan() {
  const container = document.getElementById("zukan-content");
  if (!container) return;
  container.innerHTML = "";
  ZUKAN_SECTIONS.forEach(sec => {
    const s = document.createElement("section");
    s.className = "zukan-section";
    const h = document.createElement("h3");
    h.textContent = sec.title;
    s.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "zukan-grid";
    sec.items.forEach(it => {
      const card = document.createElement("button");
      card.className = "zukan-card";
      card.innerHTML = zukanCardHTML(it, sec.italic);
      card.addEventListener("click", () => {
        speak(it.name + (it.desc ? "。" + it.desc : ""));
      });
      grid.appendChild(card);
    });
    s.appendChild(grid);
    container.appendChild(s);
  });
}

// ---------- 10. UI 配線 ----------
function init() {
  // パターン選択
  const sel = document.getElementById("pattern-select");
  PATTERNS.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = `${i + 1}. ${p.name}`;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => state.patternIndex = parseInt(sel.value, 10));

  // BPM
  const slider = document.getElementById("bpm-slider");
  const label = document.getElementById("bpm-label");
  slider.addEventListener("input", () => {
    state.bpm = parseInt(slider.value, 10);
    label.textContent = state.bpm;
  });

  // リズムボタン
  document.getElementById("rhythm-toggle").addEventListener("click", () => {
    if (state.rhythmPlaying) stopRhythm(); else startRhythm();
  });

  // マイク
  document.getElementById("mic-btn").addEventListener("click", () => {
    if (!recognition) return;
    ensureAudio();
    try {
      recognition.start();
      document.getElementById("mic-btn").classList.add("listening");
    } catch (e) {
      console.warn(e);
    }
  });

  // プリセット
  const pb = document.getElementById("preset-buttons");
  PRESETS.forEach(w => {
    const b = document.createElement("button");
    b.textContent = w;
    b.addEventListener("click", () => handleRecognized(w));
    pb.appendChild(b);
  });

  // 音符再生 / クリア
  document.getElementById("play-notes-btn").addEventListener("click", playNotesSequence);
  document.getElementById("clear-btn").addEventListener("click", () => {
    state.moras = [];
    state.notes = [];
    document.getElementById("recognized-text").textContent = "―";
    renderNotes();
  });

  // ずかん (音楽記号 図鑑) の開閉
  const zukan = document.getElementById("zukan");
  document.getElementById("zukan-btn").addEventListener("click", () => {
    zukan.classList.remove("hidden");
    speak("おんがくの きごう ずかん");
  });
  document.getElementById("zukan-close").addEventListener("click", () => {
    zukan.classList.add("hidden");
    speechSynthesis.cancel();
  });
  zukan.addEventListener("click", (e) => {
    if (e.target === zukan) {
      zukan.classList.add("hidden");
      speechSynthesis.cancel();
    }
  });
  buildZukan();

  // 速度記号エリアをタップすると名前を読み上げ
  const tempo = document.getElementById("tempo-mark");
  if (tempo) tempo.addEventListener("click", () => speak("速度記号"));

  setupRecognition();
  renderNotes();
}

document.addEventListener("DOMContentLoaded", init);
