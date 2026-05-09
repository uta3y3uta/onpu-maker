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

// メロディ音 (モーラ用) — 木琴っぽいベル音
function playMelodyNote(t, freq) {
  const ctx = state.audioCtx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.4, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.5);
}

// ---------- 4. リズムループ ----------
function startRhythm() {
  ensureAudio();
  state.rhythmPlaying = true;
  state.rhythmStep = 0;
  scheduleNextStep();
  document.getElementById("rhythm-toggle").textContent = "■ リズム ストップ";
  document.getElementById("rhythm-toggle").classList.add("playing");
}
function stopRhythm() {
  state.rhythmPlaying = false;
  if (state.rhythmTimerId) clearTimeout(state.rhythmTimerId);
  state.rhythmTimerId = null;
  document.getElementById("rhythm-toggle").textContent = "▶ リズム スタート";
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

// モーラを音程にマッピング (子音群ごとにペンタトニック)
const PITCH_TABLE = {
  // a, i, u, e, o の母音グループ別に音程
  a: 523.25, i: 587.33, u: 659.25, e: 698.46, o: 783.99
};
function pitchForMora(m) {
  // ひらがな/カタカナ → 母音判定 (ざっくり)
  const VOWEL_MAP = {
    "あいうえお": "aiueo",
    "かきくけこ": "aiueo",
    "がぎぐげご": "aiueo",
    "さしすせそ": "aiueo",
    "ざじずぜぞ": "aiueo",
    "たちつてと": "aiueo",
    "だぢづでど": "aiueo",
    "なにぬねの": "aiueo",
    "はひふへほ": "aiueo",
    "ばびぶべぼ": "aiueo",
    "ぱぴぷぺぽ": "aiueo",
    "まみむめも": "aiueo",
    "やいゆえよ": "aiueo",
    "らりるれろ": "aiueo",
    "わゐうゑを": "aiueo",
    "アイウエオ": "aiueo",
    "カキクケコ": "aiueo",
    "ガギグゲゴ": "aiueo",
    "サシスセソ": "aiueo",
    "ザジズゼゾ": "aiueo",
    "タチツテト": "aiueo",
    "ダヂヅデド": "aiueo",
    "ナニヌネノ": "aiueo",
    "ハヒフヘホ": "aiueo",
    "バビブベボ": "aiueo",
    "パピプペポ": "aiueo",
    "マミムメモ": "aiueo",
    "ヤイユエヨ": "aiueo",
    "ラリルレロ": "aiueo",
    "ワヰウヱヲ": "aiueo",
  };
  const last = m[m.length - 1];
  // ッ や ー は前の音のためここでは特殊
  if (last === "ッ" || last === "っ") return null; // 無音(ポップ)
  if (last === "ー") return "sustain";
  if (last === "ン" || last === "ん") return PITCH_TABLE.u;
  for (const row in VOWEL_MAP) {
    const idx = row.indexOf(last);
    if (idx >= 0) return PITCH_TABLE[VOWEL_MAP[row][idx]];
  }
  // 不明な文字は中央のド
  return PITCH_TABLE.a;
}

// ---------- 6. 音符表示 ----------
function renderNotes() {
  const staff = document.getElementById("staff");
  staff.innerHTML = "";
  if (state.moras.length === 0) {
    staff.innerHTML = '<div class="empty">ことばを はなすと、ここに おんぷが でます</div>';
    return;
  }
  const NOTE_SYMBOLS = ["♩", "♪", "♫", "♬"];
  state.moras.forEach((m, i) => {
    const d = document.createElement("div");
    d.className = "note";
    d.dataset.idx = i;
    let sym;
    if (m === "ッ" || m === "っ") sym = "𝄽"; // 休符
    else if (m === "ー") sym = "♩〜";
    else sym = NOTE_SYMBOLS[i % NOTE_SYMBOLS.length];
    d.innerHTML = `<div class="symbol">${sym}</div><div class="kana">${m}</div>`;
    staff.appendChild(d);
  });
}

// 音符を順に再生
function playNotesSequence() {
  if (state.moras.length === 0) return;
  ensureAudio();
  const ctx = state.audioCtx;
  const beat = 60 / state.bpm; // 1拍 = 1モーラ
  const startTime = ctx.currentTime + 0.1;
  state.moras.forEach((m, i) => {
    const t = startTime + i * beat;
    const pitch = pitchForMora(m);
    if (pitch && pitch !== "sustain") {
      playMelodyNote(t, pitch);
    } else if (pitch === "sustain") {
      // 直前の音を伸ばす表現として、同じ音を弱く再発音
      const prev = pitchForMora(state.moras[i - 1] || "");
      if (typeof prev === "number") playMelodyNote(t, prev);
    }
    // 視覚同期
    const delayMs = (t - ctx.currentTime) * 1000;
    setTimeout(() => {
      document.querySelectorAll(".note").forEach(n => n.classList.remove("active"));
      const el = document.querySelector(`.note[data-idx="${i}"]`);
      if (el) el.classList.add("active");
      if (i === state.moras.length - 1) {
        setTimeout(() => document.querySelectorAll(".note").forEach(n => n.classList.remove("active")), beat * 1000);
      }
    }, Math.max(0, delayMs));
  });
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
    document.getElementById("recognized-text").textContent = `(${ev.error})`;
  };
  recognition.onend = () => {
    document.getElementById("mic-btn").classList.remove("listening");
    document.getElementById("mic-btn").textContent = "🎤 おしてはなす";
  };
}

function handleRecognized(text) {
  document.getElementById("recognized-text").textContent = text;
  state.moras = splitMora(text);
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
      document.getElementById("mic-btn").textContent = "🎤 きいてるよ…";
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
    document.getElementById("recognized-text").textContent = "―";
    renderNotes();
  });

  setupRecognition();
  renderNotes();
}

document.addEventListener("DOMContentLoaded", init);
