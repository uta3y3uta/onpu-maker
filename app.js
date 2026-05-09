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

// モーラ列 → 音符列に変換 (リズムだけを表す)
// ・各モーラ      → ♩ 四分音符 (1拍)
// ・ ー が直後に続く → 直前と結合して 𝅗𝅥 二分音符 (2拍)
// ・ ッ            → 𝄽 四分休符 (1拍)
function moraToNotes(moras) {
  const notes = [];
  for (let i = 0; i < moras.length; i++) {
    const m = moras[i];
    if (m === "ー") continue; // 直前のノートに吸収済み
    if (m === "ッ" || m === "っ") {
      notes.push({ kana: m, symbol: "𝄽", beats: 1, type: "rest" });
      continue;
    }
    if (moras[i + 1] === "ー") {
      notes.push({ kana: m + "ー", symbol: "𝅗𝅥", beats: 2, type: "half" });
    } else {
      notes.push({ kana: m, symbol: "♩", beats: 1, type: "quarter" });
    }
  }
  return notes;
}

// ---------- 6. 音符表示 ----------
function renderNotes() {
  const staff = document.getElementById("staff");
  staff.innerHTML = "";
  if (state.notes.length === 0) {
    staff.innerHTML = '<div class="empty">ことばを はなすと、ここに おんぷが でます</div>';
    return;
  }
  state.notes.forEach((n, i) => {
    const d = document.createElement("div");
    d.className = `note note-${n.type}`;
    d.dataset.idx = i;
    d.innerHTML = `<div class="symbol">${n.symbol}</div><div class="kana">${n.kana}</div>`;
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
];

// ---------- 9. UI 配線 ----------
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

  setupRecognition();
  renderNotes();
}

document.addEventListener("DOMContentLoaded", init);
