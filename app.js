const DAY = 864e5, MIN = 6e4;
let bkDays = 7;   // backup reminder interval in days, 0 = off
try { const v = localStorage.getItem('bkdays'); if (v !== null) bkDays = +v; } catch {}
const $ = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayKey = t => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// ---- storage (IndexedDB) ----
const db = new Promise((res, rej) => {
  const r = indexedDB.open('ankidote', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('cards', { keyPath: 'id' });
    r.result.createObjectStore('logs', { autoIncrement: true });
    r.result.createObjectStore('meta');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (store, mode, fn) => {
  const d = await db;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result);
    t.onerror = () => rej(t.error);
  });
};
const all = s => tx(s, 'readonly', o => o.getAll());
const putMany = (s, items) => tx(s, 'readwrite', o => items.forEach(i => o.put(i)));
const clear = s => tx(s, 'readwrite', o => o.clear());
const getMeta = k => tx('meta', 'readonly', o => o.get(k));
const setMeta = (k, v) => tx('meta', 'readwrite', o => o.put(v, k));

// ---- scheduling (Anki-style SM-2) ----
// ponytail: SM-2, swap for FSRS if retention tuning matters
function schedule(c, rating, now) {
  if (rating === 'again') {
    c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2); c.interval = 0; c.due = now + 10 * MIN;
  } else if (c.interval === 0) {
    c.interval = rating === 'easy' ? 4 : rating === 'good' ? 1 : 0;
    c.due = now + (c.interval ? c.interval * DAY : 10 * MIN);
  } else {
    const f = { hard: 1.2, good: c.ease, easy: c.ease * 1.3 }[rating];
    c.ease = Math.max(1.3, c.ease + { hard: -0.15, good: 0, easy: 0.15 }[rating]);
    c.interval = Math.max(c.interval + 1, Math.round(c.interval * f));
    c.due = now + c.interval * DAY;
  }
  c.reps++;
}

// ---- import / export ----
const hash = s => { let h = 5381; for (const ch of s) h = (h * 33) ^ ch.charCodeAt(0); return (h >>> 0).toString(36); };

function validateDeck(d) {
  const errs = [];
  if (typeof d.deck !== 'string' || !d.deck.trim()) errs.push('"deck" must be a non-empty string');
  if (!Array.isArray(d.questions) || !d.questions.length) errs.push('"questions" must be a non-empty array');
  else d.questions.forEach((q, i) => {
    const p = `Question ${i + 1}: `;
    if (typeof q.stem !== 'string' || !q.stem.trim()) errs.push(p + 'missing "stem"');
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => typeof o !== 'string')) errs.push(p + '"options" must be 2+ strings');
    else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) errs.push(p + '"answer" must be an index into options (0 = first)');
  });
  return errs;
}

// ---- folders: explicit assignments plus empty folders, kept in meta (and in backups) ----
// a deck with no explicit folder falls back to the part of its name before " - "
let FM = { folders: [], assign: {} };
const loadFM = async () => { FM = (await getMeta('fm')) || { folders: [], assign: {} }; };
const saveFM = () => setMeta('fm', FM);
const folderOf = d => FM.assign[d] || (d.includes(' - ') ? d.split(' - ')[0].trim() : 'Unsorted');
const lectureOf = d => { const i = d.indexOf(' - '); return i > 0 && folderOf(d) === d.slice(0, i).trim() ? d.slice(i + 3).trim() : d; };
const allFolders = cards => [...new Set([...FM.folders, ...cards.map(c => folderOf(c.deck))])].sort((a, b) => a.localeCompare(b));

async function importFile(file, folder = '') {
  let d;
  try { d = JSON.parse((await file.text()).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return 'Not valid JSON.'; }
  if (d.backup) {
    if (!confirm('Restore this backup? It replaces everything currently in the app.')) return;
    await clear('cards'); await clear('logs');
    await putMany('cards', d.cards); await putMany('logs', d.logs);
    if (d.fm) { FM = d.fm; await saveFM(); }
    return `Restored ${d.cards.length} questions.`;
  }
  const errs = validateDeck(d);
  if (errs.length) return 'Import failed:\n' + errs.slice(0, 10).join('\n') + (errs.length > 10 ? `\n...and ${errs.length - 10} more` : '');
  const have = new Map((await all('cards')).map(c => [c.id, c]));
  let added = 0;
  const out = d.questions.map(q => {
    const id = hash(d.deck + '|' + q.stem), old = have.get(id);
    if (!old) added++;
    return { ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0, ...old, id, deck: d.deck, stem: q.stem, options: q.options, answer: q.answer, explanation: q.explanation || '' };
  });
  await putMany('cards', out);
  if (folder) { FM.assign[d.deck] = folder; if (!FM.folders.includes(folder)) FM.folders.push(folder); await saveFM(); }
  return `"${d.deck}" in ${folderOf(d.deck)}: ${added} new, ${out.length - added} updated (progress kept).`;
}

async function exportAll() {
  const json = JSON.stringify({ backup: 1, cards: await all('cards'), logs: await all('logs'), fm: FM });
  const f = new File([json], `ankidote-backup-${dayKey(Date.now())}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f] }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  }
  await setMeta('lastBackup', Date.now());
}

// ---- stats ----
function streak(logs) {
  const days = new Set(logs.map(l => dayKey(l.t)));
  let n = 0, t = Date.now();
  if (!days.has(dayKey(t))) t -= DAY;
  while (days.has(dayKey(t))) { n++; t -= DAY; }
  return n;
}
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';

const FORMAT = `Output ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:

{
  "deck": "<Subject> - <Lecture title>",
  "questions": [
    {
      "stem": "...",
      "options": ["...", "...", "...", "...", "..."],
      "answer": 2,
      "explanation": "..."
    }
  ]
}`;
const COMMON = `- Use only facts from the attached lecture. Do not invent content.
- {{COUNT}}
- Exactly one best answer per question, with plausible distractors.
- "answer" is the zero-based index of the correct option (0 = first option). Vary where the correct answer sits.
- The explanation says why the answer is right and briefly why the main distractors are wrong.`;
const PROMPTS = [
  ['Standard SBA', 'Clinical vignettes that test understanding. The best default for most lectures.',
    `Create single-best-answer (SBA) exam questions from the attached lecture, in the style of UK medical school exams (NGU).

- Each question is a short clinical vignette (age, sex, presentation, key findings) followed by one question.
- Exactly 5 options.
- Test understanding and application, not trivial recall.
${COMMON}`],
  ['Quick recall', 'Short one-line questions on facts, definitions and lists. Good for first-pass memorising.',
    `Create short single-best-answer recall questions from the attached lecture.

- Each stem is one or two lines: a definition, fact, classification, value or "which of the following" question. No long vignettes.
- Exactly 5 options.
- Cover every key fact, definition, number and list in the lecture.
${COMMON}`],
  ['Mechanisms & science', 'Basic science (physiology, pathology, biochemistry) wrapped in a clinical picture.',
    `Create single-best-answer questions from the attached lecture that test the underlying science: mechanisms, physiology, pathophysiology, biochemistry and microbiology.

- Each question is a short clinical vignette, and the question asks WHY it happens (the mechanism, cause or underlying process), not just what it is.
- Exactly 5 options.
${COMMON}`],
  ['Pharmacology', 'Drug class, mechanism, indications, side effects, interactions and contraindications.',
    `Create single-best-answer pharmacology questions from the attached lecture.

- Cover drug classes, mechanisms of action, indications, adverse effects, interactions, contraindications, monitoring and key doses where the lecture gives them.
- Use short clinical vignettes where possible (for example "which drug is most appropriate" or "which adverse effect would you expect").
- Exactly 5 options.
${COMMON}`],
  ['Investigations & management', 'Next best step, first-line treatment, and which test to order.',
    `Create single-best-answer questions from the attached lecture on diagnosis and management.

- Each question is a clinical vignette ending in a question such as "What is the most appropriate next investigation?", "What is the most likely diagnosis?" or "What is the first-line management?".
- Follow UK practice (NICE guidance) when the lecture does.
- Exactly 5 options.
${COMMON}`],
  ['Anatomy', 'Clinical anatomy: relations, nerve and vessel supply, and injuries.',
    `Create single-best-answer anatomy questions from the attached lecture.

- Test relations, innervation, blood supply, lymphatic drainage, surface anatomy and the clinical effects of injury or disease.
- Use short clinical vignettes (for example a nerve injury or an occluded vessel) rather than bare labelling.
- Exactly 5 options.
${COMMON}`],
  ['Interpret the data', 'Lab results, ABGs, ECG and imaging findings described in text.',
    `Create single-best-answer data-interpretation questions from the attached lecture.

- Each stem gives a short case plus results written as text (blood tests with units and reference ranges, ABG, ECG description, imaging report, observations). The question asks for the diagnosis, cause or next step.
- Do not rely on images.
- Exactly 5 options.
${COMMON}`],
  ['Hard (exam level)', 'Multi-step reasoning with very similar options. For when the basics are solid.',
    `Create difficult single-best-answer questions from the attached lecture, harder than a typical exam.

- Each question needs two or more reasoning steps (for example work out the diagnosis, then choose the treatment or complication).
- Distractors must all be reasonable and differ only subtly. Avoid giveaway wording.
- Exactly 5 options.
${COMMON}`],
];
// question count for generated decks: 0 = as many as the lecture needs
let qCount = 0;
try { qCount = +localStorage.getItem('qcount') || 0; } catch {}
const countLine = () => qCount
  ? `Write exactly ${qCount} question${qCount === 1 ? '' : 's'}, spread across the whole lecture, prioritising the most important and most examinable points.`
  : 'Write as many questions as it takes to cover every testable point in the lecture. Do not stop at a fixed number.';
const promptText = i => PROMPTS[i][2].replace('{{COUNT}}', countLine()) + '\n\n' + FORMAT;
let pi = 0;

// ---- settings: sound + theme ----
let sound = true, actx, keep, keepT;
try { sound = localStorage.getItem('sound') !== '0'; } catch {}
const theme = () => document.documentElement.dataset.theme || 'auto';
function setTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
  try { v === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', v); } catch {}
}
// synthesized with WebAudio so there are no sound files to cache
// ok = bright bell arpeggio, no = soft muffled "bonk", done = little fanfare
//
// iOS quirks this works around:
//  - an AudioContext starts suspended and only resumes from a tap, so we wait for resume() before scheduling notes
//  - Web Audio is muted by the silent/mute setting, but a playing <audio> element is not. Playing a silent looping one
//    (and setting the audioSession to "playback") moves the page onto the media channel so the notes are heard.
//    It only runs for ~2s around each sound so it doesn't hold the audio session (or other apps' music) longer than needed.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
async function audioOn() {
  actx ||= new (window.AudioContext || window.webkitAudioContext)();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (!keep) { keep = new Audio(SILENT_WAV); keep.loop = true; }
  keep.play().catch(() => {});
  clearTimeout(keepT);
  keepT = setTimeout(() => { keep.pause(); try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {} }, 2200);
  if (actx.state !== 'running') await actx.resume();
}
async function play(kind) {
  if (!sound) return;
  try {
    await audioOn();
    const out = actx.createGain(); out.gain.value = .9; out.connect(actx.destination);
    const bell = (f, t, len = .55, vol = .5) => {            // sine + 2x + 3x partials, fast attack, long exponential decay
      const at = actx.currentTime + t;
      [[1, 1], [2, .35], [3, .12]].forEach(([m, v]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f * m;
        g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(vol * v, at + .008); g.gain.exponentialRampToValueAtTime(.0001, at + len / m);
        o.connect(g).connect(out); o.start(at); o.stop(at + len);
      });
    };
    const bonk = (f, t) => {                                 // low sine through a lowpass, gentle pitch drop
      const at = actx.currentTime + t, o = actx.createOscillator(), g = actx.createGain(), lp = actx.createBiquadFilter();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, at); o.frequency.exponentialRampToValueAtTime(f * .88, at + .22);
      lp.type = 'lowpass'; lp.frequency.value = 700;
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.7, at + .015); g.gain.exponentialRampToValueAtTime(.0001, at + .3);
      o.connect(lp).connect(g).connect(out); o.start(at); o.stop(at + .32);
    };
    if (kind === 'ok') [[784, 0], [988, .075], [1319, .15]].forEach(([f, t]) => bell(f, t, .6, .45));
    else if (kind === 'done') [[523, 0], [659, .1], [784, .2], [1047, .3], [1319, .42]].forEach(([f, t]) => bell(f, t, .8, .4));
    else { bonk(262, 0); bonk(196, .16); }
  } catch {}
}

// ---- motion helpers ----
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function burst(x, y, n = 26, power = 1) {                 // small confetti burst on a canvas overlay
  if (calm()) return;
  const c = document.createElement('canvas');
  c.className = 'fx'; c.width = innerWidth; c.height = innerHeight;
  document.body.appendChild(c);
  const g = c.getContext('2d'), st = getComputedStyle(document.body);
  const cols = ['#ffc800', st.getPropertyValue('--acc').trim() || '#d9528c', st.getPropertyValue('--blue').trim() || '#4aa3d9', '#ffffff'];
  const ps = Array.from({ length: n }, () => ({ x, y, vx: (Math.random() - .5) * 11 * power, vy: -(Math.random() * 10 + 4) * power, r: 3 + Math.random() * 4, c: cols[Math.floor(Math.random() * cols.length)], a: Math.random() * 6, va: (Math.random() - .5) * .4, t: 0 }));
  let last = performance.now();
  const step = now => {
    const k = Math.min(2, (now - last) / 16.7); last = now;
    g.clearRect(0, 0, c.width, c.height);
    let alive = 0;
    for (const p of ps) {
      p.vy += .35 * k; p.x += p.vx * k; p.y += p.vy * k; p.a += p.va * k; p.t += k;
      if (p.t > 100 || p.y > c.height + 20) continue;
      alive++;
      g.save(); g.globalAlpha = 1 - p.t / 100; g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore();
    }
    alive ? requestAnimationFrame(step) : c.remove();
  };
  requestAnimationFrame(step);
}
function countUp(el) {                                     // "12 days" -> counts the 12 up, keeps the rest
  const m = /^(\d+)(.*)$/.exec(el.textContent.trim());
  if (!m || calm()) return;
  const to = +m[1], tail = m[2], t0 = performance.now();
  if (to < 2) return;
  const f = t => {
    const p = Math.min(1, (t - t0) / 800);
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + tail;
    if (p < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}
let lastScreen = null;   // so re-rendering the same screen (e.g. changing a setting) doesn't replay the entrance

// ---- shell / nav ----
let view = 'today', min = false, folder = null;
try { min = localStorage.getItem('navmin') === '1'; } catch {}
const ICONS = {
  today: '<path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2zM12 6.5v13"/>',
  stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  data: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  decks: '<rect x="7" y="3" width="13" height="14" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  chev: '<path d="m15 6-6 6 6 6"/>',
};
const svg = (p, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const FILL = {
  flame: '<path d="M12 2s5.5 4.6 5.5 10.2a5.5 5.5 0 0 1-11 0c0-2.2 1-3.800 2.200-4.800.300 1.600 1 2.400 1.900 2.800C10.100 7 10.300 4.400 12 2z"/>',
  bolt: '<path d="M13.500 2 4.500 13.500h6.500L10 22l9-11.500h-6.500z"/>',
  star: '<path d="m12 2.500 2.900 5.900 6.500.9-4.700 4.600 1.100 6.500-5.800-3-5.800 3 1.100-6.500L2.600 9.300l6.500-.9z"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m7.500 12.500 3 3 6-6.500" fill="none" stroke="#fff" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>',
};
const fsvg = (k, c, s = 26) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">${FILL[k]}</svg>`;
const NODE_ICONS = [
  '<path d="M12 5v14M5 12h14"/>',
  '<path d="M12 20s-7-4.400-7-10a4 4 0 0 1 7-2.600A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/>',
  '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  '<rect x="3" y="8.500" width="18" height="7" rx="3.500" transform="rotate(-40 12 12)"/><path d="M12 8.500v7" transform="rotate(-40 12 12)"/>',
];
function renderNav() {
  const nav = document.getElementById('nav');
  nav.className = min ? 'min' : '';
  nav.innerHTML = `<div class="brand">${min ? 'a' : 'ankidote'}</div>`
    + [['today', 'Study'], ['folders', 'Folders'], ['decks', 'Decks'], ['stats', 'Stats'], ['data', 'Data', 'wo'], ['guide', 'Guide', 'wo'], ['settings', 'Settings', 'wo']].map(([v, l, c = '']) => `<button class="nv ${c} ${v === view ? 'on' : ''}" data-v="${v}" title="${l}">${svg(ICONS[v])}<span>${l}</span></button>`).join('')
    + `<button class="nv more ${['more', 'data', 'guide', 'settings'].includes(view) ? 'on' : ''}" data-v="more" title="More">${svg(ICONS.more)}<span>More</span></button>`
    + `<button class="nv tog" id="tog" title="${min ? 'Expand' : 'Minimize'}">${svg(ICONS.chev)}<span>Minimize</span></button>`;
  nav.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { view = b.dataset.v; if (view === 'today') folder = null; home(); });
  nav.querySelector('#tog').onclick = () => { min = !min; try { localStorage.setItem('navmin', min ? '1' : '0'); } catch {} renderNav(); };
}

// ---- folders: "Subject - Lecture" decks are grouped by the part before the dash ----
const folderSvg = n => `<svg viewBox="0 0 64 64" width="${n}" height="${n}"><path style="fill:var(--acc-d)" d="M6 16a5 5 0 0 1 5-5h14l6 7h22a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/><path style="fill:var(--acc)" d="M6 27a5 5 0 0 1 5-5h42a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/></svg>`;

// ---- dialogs ----
function modal(html, bind) {
  const o = document.createElement('div');
  o.className = 'ovl';
  o.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(o);
  const close = () => o.remove();
  o.onclick = e => { if (e.target === o) close(); };
  bind(o, close);
  o.querySelector('input:not([hidden]),select')?.focus();
}
function newFolderDialog(done) {
  modal(`<h2>New folder</h2><p>Folders group your decks, for example by subject.</p>
    <input class="inp" id="fn" maxlength="40" placeholder="e.g. Cardiology" autocomplete="off">
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok">Create</button></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s);
    const go = async () => {
      const n = q('#fn').value.trim();
      if (!n) { q('#er').textContent = 'Give the folder a name.'; return; }
      if (allFolders(await all('cards')).some(f => f.toLowerCase() === n.toLowerCase())) { q('#er').textContent = 'That folder already exists.'; return; }
      FM.folders.push(n); await saveFM(); close(); done(n);
    };
    q('#c').onclick = close; q('#ok').onclick = go;
    q('#fn').onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}
async function importDialog(pre = '') {
  const folders = allFolders(await all('cards'));
  modal(`<h2>Add a deck</h2><p>Choose the folder it goes in, then pick the file Claude made.</p>
    <select class="inp" id="fs"><option value="">Auto (from the deck name)</option>${folders.map(f => `<option value="${esc(f)}" ${f === pre ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new">+ New folder…</option></select>
    <input class="inp" id="fn" maxlength="40" placeholder="New folder name" hidden>
    <div class="row end"><button id="c">Cancel</button><label class="btn p">Choose file<input type="file" id="fi" accept=".json,application/json" hidden></label></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s);
    q('#fs').onchange = () => { q('#fn').hidden = q('#fs').value !== '__new'; if (!q('#fn').hidden) q('#fn').focus(); };
    q('#c').onclick = close;
    q('#fi').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      let folder = q('#fs').value;
      if (folder === '__new') {
        folder = q('#fn').value.trim();
        if (!folder) { q('#er').textContent = 'Type a name for the new folder first.'; e.target.value = ''; return; }
        folder = folders.find(x => x.toLowerCase() === folder.toLowerCase()) || folder;
      }
      close();
      home(await importFile(f, folder));
    };
  });
}

// ---- home ----
async function home(msg = '') {
  onkeydown = null;
  document.body.classList.remove('studying');
  renderNav();
  await loadFM();
  const [cards, logs, last] = await Promise.all([all('cards'), all('logs'), getMeta('lastBackup')]);
  const now = Date.now(), today = dayKey(now);
  const dueN = cards.filter(c => c.reps && c.due <= now).length;
  const newN = cards.filter(c => !c.reps).length;
  const reviews = logs.filter(l => !l.isNew);
  const stale = bkDays && logs.length && (!last || now - last > bkDays * DAY);
  const banner = `${stale ? `<div class="banner"><span>No backup ${last ? 'for ' + Math.floor((now - last) / DAY) + ' days' : 'yet'}.</span><button id="bk">Back up</button></div>` : ''}
    ${msg ? `<div class="msg ${/failed|valid JSON/.test(msg) ? 'err' : ''}">${esc(msg)}</div>` : ''}`;
  const tile = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  const todoOf = cs => cs.filter(c => !c.reps || c.due <= now).length;
  const deckCard = (d, withFolder) => {
    const cs = cards.filter(c => c.deck === d), n = cs.length, todo = todoOf(cs), mat = cs.filter(c => c.interval >= 21).length;
    return `<button class="deckcard" data-deck="${esc(d)}" ${todo ? '' : 'data-practice="1"'}>
      ${withFolder ? `<span class="fl">${folderSvg(18)}${esc(folderOf(d))}</span>` : ''}<span class="dn">${esc(lectureOf(d))}</span>
      <span class="dm"><small>${n} question${n === 1 ? '' : 's'}</small>${todo ? `<b class="due">${todo} to do</b>` : '<b class="due done">All done</b>'}</span>
      <span class="bar2"><i style="width:${Math.round(100 * mat / n)}%"></i></span>
      <span class="go">${todo ? 'Study' : 'Practice'} ›</span></button>`;
  };
  let body = '';

  if (view === 'today') {
    const decks = [...new Set(cards.map(c => c.deck))].sort();
        const hp = (k, col, v, t) => `<span class="hp" style="color:${col}" title="${t}">${fsvg(k, 'currentColor', 46)}${v}</span>`;
    if (folder && !allFolders(cards).includes(folder)) folder = null;
    const scope = folder ? cards.filter(c => folderOf(c.deck) === folder) : cards;
    const sDue = scope.filter(c => c.reps && c.due <= now).length, sNew = scope.filter(c => !c.reps).length;
    const left = folder ? 'in this folder' : '';
    const head = folder
      ? `<button class="crumb" id="up">${svg('<path d="m15 6-6 6 6 6"/>', 22)} All folders</button><h1 class="pt">${esc(folder)}</h1><p class="tag">${new Set(scope.map(c => c.deck)).size} deck${new Set(scope.map(c => c.deck)).size === 1 ? '' : 's'} · ${scope.length} questions</p>`
      : '<h1 class="pt">Today</h1><p class="tag">the antidote to medical exam stress</p>';
    let list;
    if (folder) {
      const ds = [...new Set(scope.map(c => c.deck))].sort();
      list = `<h2>Decks</h2><div class="deckgrid">${ds.map(d => deckCard(d)).join('')}<button class="addtile" data-act="adddeck" data-pre="${esc(folder)}">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>Add deck</span></button></div>`;
    } else if (!cards.length && !FM.folders.length) list = '<p class="tag emptynote">No decks yet. Open the Folders or Decks tab and tap + to add one.</p>';
    else list = `<h2>Folders</h2><div class="folders">${allFolders(cards).map(f => {
      const cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size, todo = todoOf(cs), mat = cs.filter(c => c.interval >= 21).length;
      return `<button class="folder" data-folder="${esc(f)}"><span class="fic">${folderSvg(64)}</span>
        <span class="ftx"><span class="nm">${esc(f)}</span><small>${nd} deck${nd === 1 ? '' : 's'} · ${cs.length} questions</small><span class="bar2"><i style="width:${cs.length ? Math.round(100 * mat / cs.length) : 0}%"></i></span></span>${todo ? `<b class="badge2">${todo}</b>` : ''}</button>`;
    }).join('')}</div>`;
    body = `<div class="toprow"><div>${head}</div>
      <div class="hud">${hp('flame', '#ff9600', streak(logs), 'day streak')}</div></div>
    ${banner}
    <section class="hero">
      <div><span class="big">${sDue + sNew}</span><span class="lbl">${sDue + sNew || !scope.length ? 'to study today' : 'all done for today'} ${left}</span><div class="sub">${sDue} due · ${sNew} new · ${streak(logs)} day streak</div></div>
      ${sDue + sNew ? `<button id="all" ${folder ? `data-folder="${esc(folder)}"` : ''}>Study ${folder ? 'folder' : 'all'}</button>` : scope.length ? `<button id="all" data-practice="1" ${folder ? `data-folder="${esc(folder)}"` : ''}>Practice anyway</button>` : ''}
    </section>
    ${list}`;
  } else if (view === 'more') {
    const row = (v, t, d) => `<button class="morerow" data-go="${v}"><span class="mi">${svg(ICONS[v], 28)}</span><span class="mt"><b>${t}</b><small>${d}</small></span><span class="chv">›</span></button>`;
    body = `<h1 class="pt">More</h1><div style="height:20px"></div>${banner}
    <div class="morelist">${row('data', 'Data', 'Import decks and back up your progress')}${row('guide', 'Guide', 'How to make decks with AI')}${row('settings', 'Settings', 'Theme, sounds and reminders')}</div>`;
  } else if (view === 'decks') {
    const names = [...new Set(cards.map(c => c.deck))].sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
    body = `<div class="toprow"><div><h1 class="pt">All decks</h1><p class="tag">${names.length ? names.length + ' deck' + (names.length === 1 ? '' : 's') + ' · tap one to study it' : 'tap + to add your first deck'}</p></div>
      <button class="p plus" data-act="adddeck" aria-label="Add deck">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div>${banner}
    <div class="deckgrid">${names.map(d => deckCard(d, true)).join('')}<button class="addtile" data-act="adddeck">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>Add deck</span></button></div>`;
  } else if (view === 'folders') {
    const names = allFolders(cards);
    body = `<div class="toprow"><div><h1 class="pt">Folders</h1><p class="tag">${names.length ? 'tap a folder to open it' : 'tap + to create your first folder'}</p></div>
      <button class="p plus" data-act="newfolder" aria-label="New folder">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div>${banner}
    <div class="bigf">${names.map(f => {
      const cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size, todo = cs.filter(c => !c.reps || c.due <= now).length, mat = cs.filter(c => c.interval >= 21).length;
      return `<button class="bf" data-folder="${esc(f)}">${todo ? `<b class="badge2">${todo}</b>` : ''}${folderSvg(132)}
        <span class="nm">${esc(f)}</span><small>${nd} deck${nd === 1 ? '' : 's'} · ${cs.length} questions</small><span class="bar2"><i style="width:${cs.length ? Math.round(100 * mat / cs.length) : 0}%"></i></span></button>`;
    }).join('')}<button class="addtile" data-act="newfolder">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>New folder</span></button></div>`;
  } else if (view === 'stats') {
    const nC = cards.length, known = cards.filter(c => c.interval >= 21).length, unseen = cards.filter(c => !c.reps).length, learning = nC - known - unseen;
    const share = x => nC ? 100 * x / nC : 0;
    // one pass over the logs for everything below (per day, per deck, totals)
    const byDay = new Map(), byDeck = new Map();
    let okAll = 0, revOk = 0, revN = 0;
    for (const l of logs) {
      const k = dayKey(l.t);
      let d = byDay.get(k); if (!d) byDay.set(k, d = { total: 0, ok: 0 });
      let dk = byDeck.get(l.deck); if (!dk) byDeck.set(l.deck, dk = { n: 0, ok: 0 });
      d.total++; dk.n++;
      if (!l.isNew) revN++;
      if (l.correct) { d.ok++; dk.ok++; okAll++; if (!l.isNew) revOk++; }
    }
    const td = byDay.get(today) || { total: 0, ok: 0 };
    const days = [...Array(14)].map((_, i) => { const t = now - (13 - i) * DAY; return { t, ...(byDay.get(dayKey(t)) || { total: 0, ok: 0 }) }; });
    const dmax = Math.max(1, ...days.map(d => d.total));
    const sum = (a, k) => a.reduce((s, d) => s + d[k], 0);
    const rate = a => sum(a, 'total') ? Math.round(100 * sum(a, 'ok') / sum(a, 'total')) : null;
    const accW = rate(days.slice(7)), accP = rate(days.slice(0, 7));
    const delta = accW !== null && accP !== null ? accW - accP : 0;
    const trend = accW !== null && accP !== null && delta ? `<span class="chip2 ${delta > 0 ? 'up' : 'dn'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span>` : '';
    const fc = Array(7).fill(0);
    cards.filter(c => c.reps).forEach(c => { fc[Math.min(6, Math.max(0, Math.floor((c.due - now) / DAY)))]++; });
    const fmax = Math.max(1, ...fc), dn = i => ['Today', 'Tmrw'][i] || 'SMTWTFS'[new Date(now + i * DAY).getDay()];
    const weak = [...byDeck].filter(([, v]) => v.n >= 5).map(([d, v]) => ({ d, n: v.n, acc: Math.round(100 * v.ok / v.n) })).sort((a, b) => a.acc - b.acc).slice(0, 4);
    const hard = cards.filter(c => c.lapses).sort((a, b) => b.lapses - a.lapses).slice(0, 4);
    const tone = a => a < 60 ? 'var(--bad)' : a < 80 ? 'var(--acc)' : 'var(--blue)';
    const TI = { bolt: ['bolt', 'var(--blue)'], flame: ['flame', '#ff9600'], star: ['star', '#ffc800'], check: ['check', 'var(--acc)'] };
    const t4 = (ic, h, v, s) => `<div class="tile"><span class="ti">${fsvg(TI[ic][0], TI[ic][1], 34)}</span><div class="tt"><b>${v}</b><span>${h}</span><small>${s}</small></div></div>`;
    const card = (title, right, inner, cls = '') => `<section class="card sc ${cls}"><div class="ch"><h3>${title}</h3>${right ? `<span class="big2">${right}</span>` : ''}</div>${inner}</section>`;

    const progress = card('Your progress', `${Math.round(share(known))}% known`, `
      <div class="stack"><i style="width:${share(known)}%;background:var(--blue)"></i><i style="width:${share(learning)}%;background:var(--acc)"></i></div>
      <div class="legend"><span><u style="background:var(--blue)"></u><b>${known}</b> known</span><span><u style="background:var(--acc)"></u><b>${learning}</b> learning</span><span><u style="background:var(--line)"></u><b>${unseen}</b> not started</span></div>
      <p class="fine">Known means you've remembered it for 3+ weeks.</p>`);

    const inner = logs.length ? `
      <div class="grid">
        ${t4('bolt', 'Today', td.total, td.total ? pct(td.ok, td.total) + ' correct' : 'answered so far')}
        ${t4('flame', 'Streak', streak(logs) + (streak(logs) === 1 ? ' day' : ' days'), 'in a row')}
        ${t4('star', 'Known', Math.round(share(known)) + '%', known + ' of ' + nC)}
        ${t4('check', 'On repeats', pct(revOk, revN), 'answered right')}
      </div>
      ${progress}
      ${card('Last 14 days', accW === null ? '' : `${accW}% correct${trend}`, `
        <div class="act">${days.map((d, i) => `<div title="${d.ok}/${d.total} correct"><i class="w" style="height:${Math.round(80 * (d.total - d.ok) / dmax)}px"></i><i class="r" style="height:${Math.round(80 * d.ok / dmax)}px"></i><span ${i === 13 ? 'class="now"' : ''}>${'SMTWTFS'[new Date(d.t).getDay()]}</span></div>`).join('')}</div>
        <div class="legend"><span><u style="background:var(--blue)"></u>correct</span><span><u style="background:var(--bad)"></u>wrong</span></div>`)}
      <div class="two">
        ${card('Weakest topics', '', weak.length ? weak.map(x => `<div class="wkr"><span>${esc(x.d)}</span><b>${x.acc}%</b><div class="meter"><i style="width:${x.acc}%;background:${tone(x.acc)}"></i></div></div>`).join('') : '<p class="fine">Shows up once a deck has 5 answers.</p>')}
        ${card('Keep missing', '', hard.length ? hard.map(c => `<div class="hard">${esc(c.stem.length > 90 ? c.stem.slice(0, 90) + '…' : c.stem)}<small>missed ${c.lapses}×</small></div>`).join('') : '<p class="fine">Questions you get wrong appear here.</p>')}
      </div>
      ${card('Coming up', fc[0] ? `${fc[0]} due today` : 'nothing due today', `<div class="fc">${fc.map((n, i) => `<div><em>${n || ''}</em><i style="height:${Math.round(70 * n / fmax)}px"></i><span>${dn(i)}</span></div>`).join('')}</div>`)}`
      : `${nC ? progress : ''}<section class="card empty"><div class="ei">${svg(ICONS.stats, 40)}</div><h3>No answers yet</h3><p>Study a few questions and your stats will show up here.</p></section>`;
    body = `<h1 class="pt">Stats</h1><p class="tag">how you're doing, and where to focus</p><div style="height:18px"></div><div class="stats">${inner}</div>`;
  } else if (view === 'guide') {
    const step = (n, t, d) => `<div class="step"><b>${n}</b><div><strong>${t}</strong><p>${d}</p></div></div>`;
    body = `<h1 class="pt">Guide</h1><p class="tag">from lecture to questions in five steps</p><div style="height:20px"></div>${banner}
    <section class="card steps">
      ${step(1, 'Get your lecture', 'Have the lecture slides or notes ready as a PDF, PowerPoint or text.')}
      ${step(2, 'Ask an AI to write the questions', 'Open Claude (or ChatGPT) and attach the lecture. Pick a prompt type below, copy it, paste it in and send.')}
      ${step(3, 'Save the answer as a .json file', 'Ask the AI to give the result as a downloadable file. If it only shows text, copy it into Notes or a text editor and save it with a name ending in <b>.json</b>. Code fences around it are fine.')}
      ${step(4, 'Import it', 'Go to <b>Data</b>, tap <b>Import file</b> and pick the file from Files. A message tells you how many questions were added. Importing the same deck again keeps your progress.')}
      ${step(5, 'Study every day', 'Go to <b>Study</b>. Pick an answer and read the explanation. A wrong answer comes back soon in the same session. For a right answer, rate it: <b>Hard</b> (shaky), <b>Good</b>, or <b>Easy</b>. The better you know it, the longer until you see it again.')}
    </section>
    <h2>Prompts for the AI</h2>
    <section class="card"><p>Pick the kind of questions you want. You can import several decks from one lecture.</p>
      <div class="chips">${PROMPTS.map(p => `<button class="chip">${esc(p[0])}</button>`).join('')}</div>
      <p class="qlbl">How many questions?</p>
      <div class="chips qrow">${[0, 10, 20, 30, 50].map(n => `<button class="chip qn" data-n="${n}">${n || 'As many as needed'}</button>`).join('')}
        <input class="inp qi" id="qcustom" type="number" min="1" max="200" inputmode="numeric" placeholder="Custom" value="${[0, 10, 20, 30, 50].includes(qCount) ? '' : qCount}"></div>
      <p id="pd" style="color:var(--fg)"></p>
      <pre id="pr" class="prompt"></pre>
      <button class="p" id="cp">Copy prompt</button></section>
    <h2>Tips</h2>
    <section class="card tips">
      <p><b>Install it:</b> in Safari tap Share, then Add to Home Screen, and always open ankidote from that icon.</p>
      <p><b>Back up:</b> use Data, then Export backup, and save to Files. Do it weekly. Clearing Safari data erases your progress.</p>
      <p><b>Error on import?</b> The message says which question is wrong. Ask the AI to fix that question and give the full file again.</p>
      <p><b>Mix it up:</b> use "Quick recall" first, then "Standard SBA" and "Hard" on the same lecture as the exam gets closer.</p>
    </section>`;
  } else if (view === 'settings') {
    const t = theme(), seg = (v, l) => `<button data-theme-set="${v}" class="${t === v ? 'on' : ''}">${l}</button>`;
    body = `<h1 class="pt">Settings</h1><div style="height:20px"></div>${banner}
    <h2>Preferences</h2>
    <section class="card" style="padding-top:6px;padding-bottom:6px">
      <div class="set"><div><strong>Appearance</strong><p>Light, dark, or follow the iPad.</p></div>
        <div class="seg2">${seg('light', 'Light')}${seg('dark', 'Dark')}${seg('auto', 'Auto')}</div></div>
      <div class="set col"><div><strong>Color theme</strong><p>Pick a palette for the whole app.</p></div>
        <div class="pals">${PALETTES.map(p => `<button class="pal ${p.id === curPalette() ? 'on' : ''}" data-pal="${p.id}" aria-label="${p.label}"><span class="dots"><i style="background:${p.sw[0]}"></i><i style="background:${p.sw[1]}"></i></span>${p.label}</button>`).join('')}</div></div>
      <div class="set"><div><strong>Backup reminder</strong><p>How often to nudge you to save a backup. Your progress only lives on this iPad.</p></div>
        <select class="inp" id="bkd" aria-label="Backup reminder">${[[0, 'Off'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every month']].map(([v, l]) => `<option value="${v}" ${v === bkDays ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set"><div><strong>Sound effects</strong><p>A bright chime for correct, a soft low tone for wrong, and a short fanfare when you finish.</p></div>
        <input type="checkbox" class="tgl" id="snd" ${sound ? 'checked' : ''} aria-label="Sound effects"></div>
      <div class="set"><div><strong>Try the sounds</strong><p>No sound? Turn the iPad volume up and check it isn't muted (the bell icon in Control Center, or the side switch).</p></div>
        <div class="row"><button id="t-ok">Correct</button><button id="t-no">Wrong</button></div></div>
    </section>`;
  } else {
    body = `<h1 class="pt">Data</h1><div style="height:20px"></div>${banner}
    <div class="two">
      <section class="card"><h2 style="margin-top:0">Import</h2><p>Add a deck file made with Claude, or restore a backup. Re-importing a deck keeps your progress.</p>
        <button class="p" data-act="adddeck">Import file</button></section>
      <section class="card"><h2 style="margin-top:0">Backup</h2><p>${last ? 'Last backup: ' + new Date(last).toLocaleDateString() : 'No backup yet.'} Save the file to Files or iCloud Drive.</p>
        <button id="ex">Export backup</button></section>
    </div>`;
  }
  const screen = view + '|' + folder, still = screen === lastScreen;
  lastScreen = screen;
  $.innerHTML = `<div class="page${still ? ' still' : ''}">${body}</div>`;
  if (!still) {
    $.querySelectorAll('.folders>*,.bigf>*,.deckgrid>*,.grid>*,.two>*,.morelist>*').forEach((el, i) => { el.style.animationDelay = Math.min(i, 10) * 55 + 120 + 'ms'; });
    $.querySelectorAll('.act>div,.fc>div').forEach((el, i) => el.style.setProperty('--d', i * 45 + 200 + 'ms'));
    $.querySelectorAll('.big,.tt b').forEach(countUp);
  }

  const q = s => $.querySelector(s);
  if (q('#all')) q('#all').onclick = e => { const d = e.currentTarget.dataset; study(d.folder ? { folder: d.folder } : undefined, !!d.practice); };
  if (q('#up')) q('#up').onclick = () => { folder = null; home(); };
  $.querySelectorAll('[data-folder]:not(#all)').forEach(b => b.onclick = () => { folder = b.dataset.folder; view = 'today'; home(); });
  $.querySelectorAll('[data-pal]').forEach(b => b.onclick = () => { setPalette(b.dataset.pal); home(); });
  $.querySelectorAll('[data-deck]').forEach(b => b.onclick = () => study({ deck: b.dataset.deck }, !!b.dataset.practice));
  if (q('#pr')) {
    const show = i => {
      pi = i;
      q('#pr').textContent = promptText(i);
      q('#pd').textContent = PROMPTS[i][1];
      $.querySelectorAll('.chip:not(.qn)').forEach((c, j) => c.classList.toggle('on', j === i));
      $.querySelectorAll('.qn').forEach(c => c.classList.toggle('on', +c.dataset.n === qCount));
    };
    $.querySelectorAll('.chip:not(.qn)').forEach((c, j) => c.onclick = () => show(j));
    const setCount = n => { qCount = n; try { localStorage.setItem('qcount', n); } catch {} show(pi); };
    $.querySelectorAll('.qn').forEach(c => c.onclick = () => { q('#qcustom').value = ''; setCount(+c.dataset.n); });
    q('#qcustom').oninput = e => setCount(Math.min(200, Math.max(0, Math.floor(+e.target.value) || 0)));
    show(pi);
  }
  if (q('#cp')) q('#cp').onclick = async e => {
    try { await navigator.clipboard.writeText(promptText(pi)); } catch { const r = document.createRange(); r.selectNodeContents(q('#pr')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy prompt'; }, 1500);
  };
  if (q('#bkd')) q('#bkd').onchange = e => { bkDays = +e.target.value; try { localStorage.setItem('bkdays', bkDays); } catch {} };
  $.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => { setTheme(b.dataset.themeSet); home(); });
  if (q('#snd')) q('#snd').onchange = e => {
    sound = e.target.checked;
    try { localStorage.setItem('sound', sound ? '1' : '0'); } catch {}
    play('ok');
  };
  if (q('#t-ok')) q('#t-ok').onclick = () => play('ok');
  if (q('#t-no')) q('#t-no').onclick = () => play('no');
  if (q('#ex')) q('#ex').onclick = async () => { await exportAll(); home('Backup saved.'); };
  if (q('#bk')) q('#bk').onclick = async () => { await exportAll(); home('Backup saved.'); };
  $.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { view = b.dataset.go; home(); });
  $.querySelectorAll('[data-act=newfolder]').forEach(b => b.onclick = () => newFolderDialog(n => home(`Folder "${n}" created.`)));
  $.querySelectorAll('[data-act=adddeck]').forEach(b => b.onclick = () => importDialog(b.dataset.pre || ''));
}

// ---- study ----
// practice = review everything now; never touches the schedule or stats
async function study(sel, practice = false) {
  document.body.classList.add('studying');
  const [cards, logs] = await Promise.all([all('cards'), all('logs')]);
  const now = Date.now(), pool = sel?.deck ? cards.filter(c => c.deck === sel.deck) : sel?.folder ? cards.filter(c => folderOf(c.deck) === sel.folder) : cards;
  const queue = practice ? pool.map(c => ({ ...c })).sort(() => Math.random() - .5) : [
    ...pool.filter(c => c.reps && c.due <= now).sort((a, b) => a.due - b.due),
    ...pool.filter(c => !c.reps),
  ];
  lastScreen = null;
  const total = queue.length;
  let prevPct = 0;
  const next = () => {
    if (!queue.length) { play('done'); burst(innerWidth / 2, innerHeight * .55, 150, 1.5); return home(`${practice ? 'Practice done' : 'Done'}. ${total} question${total === 1 ? '' : 's'} reviewed.`); };
    const c = queue[0], isNew = !c.reps, t0 = Date.now();
    $.innerHTML = `<div class="page study">
      <div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button>
        <div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">${practice ? 'Practice · ' : ''}${queue.length} left</span></div>
      <div class="kick">${isNew ? 'New question' : practice ? 'Practice' : 'Review'}</div>
      <h2 class="qh">Choose the best answer</h2>
      <p class="stem">${esc(c.stem)}</p>
      <div id="opts">${c.options.map((o, i) => `<button class="opt" data-i="${i}"><b>${'ABCDEFGH'[i] || i + 1}</b><span>${esc(o)}</span></button>`).join('')}</div>
      <p class="kbd">A–E to answer · ${practice ? 'Enter to continue' : '1 Hard · 2 Good · 3 Easy · Enter to continue'}</p>
      <div id="after"></div></div>`;
    const pct = Math.max(0, 100 * (1 - queue.length / total));
    const bar = $.querySelector('.prog i');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = pct + '%'; }));
    prevPct = pct;
    $.querySelector('#back').onclick = e => { e.preventDefault(); home(); };
    onkeydown = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase(), rb = $.querySelectorAll('[data-r]');
      if (rb.length) {
        const r = k === 'enter' || k === ' ' ? $.querySelector('[data-r].p') : rb.length === 3 && '123'.includes(k) && k ? rb['123'.indexOf(k)] : null;
        if (r) { e.preventDefault(); r.click(); }
      } else {
        const i = 'abcdefgh'.indexOf(k), o = $.querySelectorAll('.opt')[k >= '1' && k <= '8' ? +k - 1 : i];
        if (o && k.length === 1) o.click();
      }
    };
    $.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const pick = +b.dataset.i, correct = pick === c.answer, ms = Date.now() - t0;
      play(correct ? 'ok' : 'no');
      if (correct) { const r = b.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 24); }
      $.querySelectorAll('.opt').forEach((x, i) => { x.disabled = true; if (i === c.answer) x.classList.add('ok'); else if (i === pick) x.classList.add('no'); });
      const rate = async rating => {
        if (practice) { queue.shift(); if (!correct) queue.push(c); return next(); }
        const was = c.interval, t = Date.now();
        schedule(c, rating, t);
        await putMany('cards', [c]);
        await putMany('logs', [{ id: c.id, deck: c.deck, t, correct, rating, ms, isNew, interval: was }]);
        queue.shift();
        if (rating === 'again' || (rating === 'hard' && !c.interval)) queue.push(c);
        next();
      };
      const praise = ['Nicely done!', 'Correct!', 'Great job!', 'Spot on!', 'Well done!'][Math.floor(Math.random() * 5)];
      $.querySelector('#after').innerHTML = `<div class="fb ${correct ? 'ok' : 'no'}">
        <div class="fbh"><span class="fbi">${svg(correct ? '<path d="m5 12.500 4.500 4.500L19 7.500"/>' : '<path d="M6 6l12 12M18 6 6 18"/>')}</span>
          <div><strong>${correct ? praise : 'Not quite'}</strong>${correct ? '' : `<small>Correct answer: ${'ABCDEFGH'[c.answer] || c.answer + 1}. ${esc(c.options[c.answer])}</small>`}</div></div>
        ${c.explanation ? `<p class="fbe">${esc(c.explanation)}</p>` : ''}
        <div class="row rate">${correct && !practice
          ? ['hard', 'good', 'easy'].map(r => `<button data-r="${r}" ${r === 'good' ? 'class="p"' : ''}>${r}</button>`).join('')
          : `<button data-r="again" class="p">${correct ? 'Continue' : 'Next'}</button>`}</div>
        ${practice && !correct ? '<p class="hint">Missed ones come back until you get them right.</p>' : ''}</div>`;
      $.querySelector('.fb').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      $.querySelectorAll('[data-r]').forEach(x => x.onclick = () => rate(x.dataset.r));
    });
  };
  next();
}

// iOS ignores user-scalable=no in places, so also swallow pinch gestures (Safari's gesture* events and multi-finger moves)
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
home();
