const DAY = 864e5, MIN = 6e4;
let bkDays = 7;   // backup reminder interval in days, 0 = off
try { const v = localStorage.getItem('bkdays'); if (v !== null) bkDays = +v; } catch {}
const $ = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayKey = t => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// ---- storage (IndexedDB) ----
const db = new Promise((res, rej) => {
  const r = indexedDB.open('ankidote', 2);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('logs')) d.createObjectStore('logs', { autoIncrement: true });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    if (!d.objectStoreNames.contains('pdfs')) d.createObjectStore('pdfs');   // slide PDFs, keyed by deck name
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
const removeCards = ids => tx('cards', 'readwrite', o => ids.forEach(id => o.delete(id)));
// slide PDFs: the bytes live in the "pdfs" store under "deck|id"; the list of files per deck lives in meta under "pdfs:deck".
// They are NOT part of backups because they can be large.
const pdfPut = (key, data) => tx('pdfs', 'readwrite', o => o.put(data, key));
const pdfGet = key => tx('pdfs', 'readonly', o => o.get(key));
const pdfDel = keys => tx('pdfs', 'readwrite', o => keys.forEach(k => o.delete(k)));
const metaKeys = () => tx('meta', 'readonly', o => o.getAllKeys()).then(k => k || []);

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

let lastDeck = null;   // deck created by the most recent successful import (used to attach slides)
async function importFile(file, folder = '') {
  lastDeck = null;
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
    const slide = Number.isInteger(q.slide) && q.slide > 0 ? q.slide : 0;
    return { ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0, ...old, id, deck: d.deck, stem: q.stem, options: q.options, answer: q.answer, explanation: q.explanation || '', ...(slide ? { slide } : {}) };
  });
  await putMany('cards', out);
  lastDeck = d.deck;
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
  "deck": "<Subject> - <Deck title>",
  "questions": [
    {
      "stem": "...",
      "options": ["...", "...", "...", "...", "..."],
      "answer": 2,
      "explanation": "...",
      "slide": 12
    }
  ]
}`;
const COMMON = `- Use only facts from the attached material. Do not invent content.
- {{COUNT}}
- Exactly one best answer per question, with plausible distractors.
- "answer" is the zero-based index of the correct option (0 = first option, 4 = fifth option).
- Spread the correct answers evenly. Across the whole set, each position (0, 1, 2, 3 and 4) must be correct about 20% of the time. AI models tend to favour the first three options, so put the correct answer in the 4th and 5th positions just as often as in the first three. Decide the position of the correct answer BEFORE writing each question, avoid patterns or runs of the same position, and do not make the correct option longer or more detailed than the distractors. Check the spread silently before you reply and rebalance if needed.
- The explanation says why the answer is right and briefly why the main distractors are wrong.
- If the material is a slide deck or PDF, add "slide": the number of the slide/page the question is based on (a whole number). Leave "slide" out if there is no clear one.`;
const DIFF = `- Difficulty: make these hard. The student must reason, not recognise a keyword.
  - Never name the diagnosis, cell, structure, drug class or mechanism in the stem. Describe the case or the defect and make the student work out what it is first.
  - Then ask about a consequence of it (a downstream effect, a mechanism, a complication, what is lost or spared, what happens next). That is two reasoning steps in one question.
  - Every option must be the same kind of thing (all cell types, all mechanisms, all haemodynamic effects) and sound plausible, so only someone who understands the topic can separate them.
  - Do not let the stem or the correct option reuse distinctive words from the explanation of the answer.
  - Style to match, with the options added: "A 4-year-old boy has recurrent opportunistic infections. Genetic testing confirms an inherited defect that completely arrests differentiation at the common lymphoid progenitor stage. Which group of mature cells will be absent while the other haematopoietic lineages are spared?" / "A 62-year-old man with chronic headache, facial plethora and generalised pruritus has an abnormal excess of mature circulating erythrocytes. Which haemodynamic alteration directly results from this?"`;
const PROMPTS = [
  ['Standard SBA', 'Clinical vignettes that test understanding. The best default for most material.',
    `Create single-best-answer (SBA) exam questions from the attached material, in the style of UK medical school exams (NGU).

- Each question is a short clinical vignette (age, sex, presentation, key findings) followed by one question.
- Exactly 5 options.
- Test understanding and application, not trivial recall.
${COMMON}`],
  ['Quick recall', 'Short one-line questions on facts, definitions and lists. Good for first-pass memorising.',
    `Create short single-best-answer recall questions from the attached material.

- Each stem is one or two lines: a definition, fact, classification, value or "which of the following" question. No long vignettes.
- Exactly 5 options.
- Cover every key fact, definition, number and list in the material.
${COMMON}`],
  ['Mechanisms & science', 'Basic science (physiology, pathology, biochemistry) wrapped in a clinical picture.',
    `Create single-best-answer questions from the attached material that test the underlying science: mechanisms, physiology, pathophysiology, biochemistry and microbiology.

- Each question is a short clinical vignette, and the question asks WHY it happens (the mechanism, cause or underlying process), not just what it is.
- Exactly 5 options.
${DIFF}
${COMMON}`],
  ['Pharmacology', 'Drug class, mechanism, indications, side effects, interactions and contraindications.',
    `Create single-best-answer pharmacology questions from the attached material.

- Cover drug classes, mechanisms of action, indications, adverse effects, interactions, contraindications, monitoring and key doses where the material gives them.
- Use short clinical vignettes where possible (for example "which drug is most appropriate" or "which adverse effect would you expect").
- Exactly 5 options.
${DIFF}
${COMMON}`],
  ['Investigations & management', 'Next best step, first-line treatment, and which test to order.',
    `Create single-best-answer questions from the attached material on diagnosis and management.

- Each question is a clinical vignette ending in a question such as "What is the most appropriate next investigation?", "What is the most likely diagnosis?" or "What is the first-line management?".
- Follow UK practice (NICE guidance) when the material does.
- Exactly 5 options.
${DIFF}
${COMMON}`],
  ['Anatomy', 'Clinical anatomy: relations, nerve and vessel supply, and injuries.',
    `Create single-best-answer anatomy questions from the attached material.

- Test relations, innervation, blood supply, lymphatic drainage, surface anatomy and the clinical effects of injury or disease.
- Use short clinical vignettes (for example a nerve injury or an occluded vessel) rather than bare labelling.
- Exactly 5 options.
${DIFF}
${COMMON}`],
  ['Interpret the data', 'Lab results, ABGs, ECG and imaging findings described in text.',
    `Create single-best-answer data-interpretation questions from the attached material.

- Each stem gives a short case plus results written as text (blood tests with units and reference ranges, ABG, ECG description, imaging report, observations). The question asks for the diagnosis, cause or next step.
- Do not rely on images.
- Exactly 5 options.
${DIFF}
${COMMON}`],
  ['Hard (exam level)', 'Multi-step reasoning with very similar options. For when the basics are solid.',
    `Create difficult single-best-answer questions from the attached material, harder than a typical exam.

- Each question needs two or more reasoning steps (for example work out the diagnosis, then choose the treatment or complication).
- Distractors must all be reasonable and differ only subtly. Avoid giveaway wording.
- Exactly 5 options.
${DIFF}
${COMMON}`],
];
// question count for generated decks: 0 = as many as the material needs
let qCount = 0;
try { qCount = +localStorage.getItem('qcount') || 0; } catch {}
let sess = 20, smode = null;   // session size, and which set to study (null = pick automatically)
try { sess = +localStorage.getItem('sess') || 20; } catch {}
const wrongIds = logs => { const last = new Map(); for (const l of logs) if (!last.has(l.id) || l.t >= last.get(l.id).t) last.set(l.id, l); return new Set([...last].filter(([, l]) => !l.correct).map(([id]) => id)); };   // cards whose latest answer was wrong
const zoomNow = () => { try { return localStorage.getItem('zoom') || '1'; } catch { return '1'; } };
let hideCh = false;   // answer from memory first: choices stay hidden until you tap Show choices
try { hideCh = localStorage.getItem('hidech') === '1'; } catch {}
const countLine = () => qCount
  ? `Write exactly ${qCount} question${qCount === 1 ? '' : 's'}, spread across the whole material, prioritising the most important and most examinable points.`
  : 'Write as many questions as it takes to cover every testable point in the material. Do not stop at a fixed number.';
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
    const p = Math.max(0, Math.min(1, (t - t0) / 800));   // rAF timestamps can be a hair earlier than t0
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + tail;
    if (p < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}
let lastScreen = null;   // so re-rendering the same screen (e.g. changing a setting) doesn't replay the entrance

// ---- shell / nav ----
let view = 'today', min = false, folder = null, editing = false;
try { min = localStorage.getItem('navmin') === '1'; } catch {}
const ICONS = {
  today: '<path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2zM12 6.5v13"/>',
  stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  data: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  decks: '<rect x="7" y="3" width="13" height="14" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>',
  tour: '<path d="M8 5v14l11-7z"/>',
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
function renderNav() {
  const nav = document.getElementById('nav');
  nav.className = min ? 'min' : '';
  nav.innerHTML = `<div class="brand">${min ? '<img src="icon-192.png" alt="a" width="36" height="36" style="border-radius:9px;display:block;margin:0 auto">' : 'ankidote'}</div>`
    + [['today', 'Study'], ['folders', 'Folders'], ['decks', 'Decks'], ['stats', 'Stats'], ['data', 'Data', 'wo'], ['guide', 'Guide', 'wo'], ['tour', 'Walkthrough', 'wo'], ['settings', 'Settings', 'wo']].map(([v, l, c = '']) => `<button class="nv ${c} ${v === view ? 'on' : ''}" data-v="${v}" title="${l}">${svg(ICONS[v])}<span>${l}</span></button>`).join('')
    + `<button class="nv more ${['more', 'data', 'guide', 'settings'].includes(view) ? 'on' : ''}" data-v="more" title="More">${svg(ICONS.more)}<span>More</span></button>`
    + `<button class="nv tog" id="tog" title="${min ? 'Expand' : 'Minimize'}">${svg(ICONS.chev)}<span>Minimize</span></button>`;
  nav.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { if (b.dataset.v === 'tour') return walkthrough(); view = b.dataset.v; editing = false; if (view === 'today') folder = null; home(); });
  nav.querySelector('#tog').onclick = () => { min = !min; try { localStorage.setItem('navmin', min ? '1' : '0'); } catch {} renderNav(); };
}

// ---- folders: "Subject - Lecture" decks are grouped by the part before the dash ----
const folderSvg = n => `<svg viewBox="0 0 64 64" width="${n}" height="${n}"><path style="fill:var(--acc-d)" d="M6 16a5 5 0 0 1 5-5h14l6 7h22a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/><path style="fill:var(--acc)" d="M6 27a5 5 0 0 1 5-5h42a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/></svg>`;

// ---- slide PDFs per deck (up to 50 each) ----
const MAX_PDFS = 50, MAX_PDF = 150 * 1024 * 1024;
const TRASH_PATH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>';
const pdfList = async deck => (await getMeta('pdfs:' + deck)) || [];
const pdfKey = (deck, id) => deck + '|' + id;
async function pdfCounts() {                                  // Map of deck -> number of PDFs attached
  const m = new Map();
  for (const k of (await metaKeys()).filter(k => typeof k === 'string' && k.startsWith('pdfs:'))) {
    const l = await getMeta(k);
    if (l && l.length) m.set(k.slice(5), l.length);
  }
  return m;
}
async function removePdf(deck, id) {
  await pdfDel([pdfKey(deck, id)]);
  await setMeta('pdfs:' + deck, (await pdfList(deck)).filter(p => p.id !== id));
}
async function removeDeckPdfs(deck) {
  const l = await pdfList(deck);
  if (!l.length) return;
  await pdfDel(l.map(p => pdfKey(deck, p.id)));
  await setMeta('pdfs:' + deck, []);
}
async function attachSlides(deck, files) {
  const notes = []; let added = 0;
  for (const f of [...files]) {
    const list = await pdfList(deck);
    if (list.length >= MAX_PDFS) { notes.push(`A deck can hold up to ${MAX_PDFS} PDFs.`); break; }
    if (f.size > MAX_PDF) { notes.push(`"${f.name}" is over 150 MB, so it was skipped.`); continue; }
    try {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await pdfPut(pdfKey(deck, id), await f.arrayBuffer());
      await setMeta('pdfs:' + deck, [...list, { id, name: f.name, size: f.size }]);
      added++;
    } catch { notes.push("Couldn't save the slides on this device (storage may be full)."); break; }
  }
  return [added ? `Attached ${added} PDF${added === 1 ? '' : 's'} to "${lectureOf(deck)}".` : '', ...notes].filter(Boolean).join(' ');
}

// ---- slide viewer: renders one slide at a time with PDF.js (bundled, so it works offline) ----
const slidesIco = () => svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>', 18);
let pdfjsReady;
const loadPdfjs = () => pdfjsReady ||= new Promise((res, rej) => {
  const el = document.createElement('script');
  el.src = 'pdf.min.js';
  el.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'; res(); };
  el.onerror = () => { pdfjsReady = null; rej(new Error('viewer')); };
  document.head.appendChild(el);
});
async function openSlides(deck, page = 1, id = null) {
  const list = await pdfList(deck), meta = list.find(p => p.id === id) || list[0];
  if (!meta) { slidesSheet(deck, page); return; }
  const data = await pdfGet(pdfKey(deck, meta.id));
  if (!data) return;
  const o = document.createElement('div');
  o.className = 'pdfv';
  o.innerHTML = `<div class="pbar"><button class="x" id="pc" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button>
      <div class="ptitle">${esc(meta.name.replace(/\.pdf$/i, ''))}</div><button class="pbtn" id="pmg">${list.length > 1 ? 'All slides' : 'Manage'}</button></div>
    <div class="pstage"><canvas id="pcv"></canvas><div class="pmsg" id="pm">Opening slides…</div></div>
    <div class="pnav"><button id="pp" aria-label="Previous slide">‹</button><span id="pn">–</span><button id="pnx" aria-label="Next slide">›</button></div>`;
  document.body.appendChild(o);
  const q = s => o.querySelector(s);
  let doc, cur = 1, tok = 0, task;
  const onKey = e => {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' || e.key === ' ') go(1); else if (e.key === 'ArrowLeft') go(-1);
  };
  const close = () => { document.removeEventListener('keydown', onKey, true); removeEventListener('resize', draw); task?.cancel?.(); o.remove(); doc?.destroy?.(); };
  document.addEventListener('keydown', onKey, true);
  q('#pc').onclick = close;
  q('#pmg').onclick = () => { close(); slidesSheet(deck, page); };
  async function draw() {
    if (!doc) return;
    const my = ++tok, pg = await doc.getPage(cur), stage = q('.pstage');
    if (my !== tok) return;
    const base = pg.getViewport({ scale: 1 });
    const fit = Math.max(.1, Math.min((stage.clientWidth - 24) / base.width, (stage.clientHeight - 24) / base.height));
    const dpr = Math.min(devicePixelRatio || 1, 2.5), vp = pg.getViewport({ scale: fit * dpr }), cv = q('#pcv');
    cv.width = vp.width; cv.height = vp.height; cv.style.width = vp.width / dpr + 'px'; cv.style.height = vp.height / dpr + 'px';
    task?.cancel?.();
    task = pg.render({ canvasContext: cv.getContext('2d'), viewport: vp });
    await task.promise.catch(() => {});
    if (my === tok) { q('#pn').textContent = `${cur} / ${doc.numPages}`; q('#pm').hidden = true; }
  }
  function go(d) { const n = Math.min(doc.numPages, Math.max(1, cur + d)); if (n !== cur) { cur = n; draw(); } }
  q('#pp').onclick = () => go(-1);
  q('#pnx').onclick = () => go(1);
  let x0 = null;
  q('.pstage').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  q('.pstage').addEventListener('touchend', e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }, { passive: true });
  addEventListener('resize', draw);
  try {
    await loadPdfjs();
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    cur = Math.min(doc.numPages, Math.max(1, page));
    await draw();
  } catch {
    q('#pm').textContent = "Couldn't open these slides. Try removing it and adding the PDF again.";
  }
}
let pendingSlides = null, sheetPage = 1, sheetClose = null;
const pdfPick = document.createElement('input');
pdfPick.type = 'file'; pdfPick.accept = 'application/pdf,.pdf'; pdfPick.multiple = true; pdfPick.hidden = true;
document.body.appendChild(pdfPick);
const refreshPage = () => document.body.classList.contains('studying') ? Promise.resolve() : home();
pdfPick.onchange = async () => {
  const files = [...pdfPick.files], d = pendingSlides; pdfPick.value = '';
  if (!files.length || !d) return;
  const note = await attachSlides(d, files);
  sheetClose?.();
  await refreshPage();
  slidesSheet(d, sheetPage, note);
};
// the list of PDFs on a deck: view, remove, add more
async function slidesSheet(deck, page = 1, note = '') {
  const list = await pdfList(deck);
  const mb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  modal(`<h2>Slides</h2><p>${esc(lectureOf(deck))} · ${list.length} of ${MAX_PDFS} PDFs${page > 1 ? ` · opens at slide ${page}` : ''}</p>
    ${note ? `<p class="snote">${esc(note)}</p>` : ''}
    <div class="plist">${list.length ? list.map(p => `<div class="prow"><button class="pview" data-v="${p.id}">${slidesIco()}<span class="pn1">${esc(p.name)}</span><small>${mb(p.size)}</small></button><button class="prm" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">${svg(TRASH_PATH, 20)}</button></div>`).join('') : '<p class="pempty">No slides yet. Add the PDF (or PDFs) the questions came from.</p>'}</div>
    <div class="row end"><button id="c">Close</button><button class="p" id="addp" ${list.length >= MAX_PDFS ? 'disabled' : ''}>Add PDFs</button></div>`, (o, close) => {
    sheetClose = close;
    o.querySelector('#c').onclick = close;
    o.querySelector('#addp').onclick = () => { pendingSlides = deck; sheetPage = page; pdfPick.click(); };
    o.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { close(); openSlides(deck, page, b.dataset.v); });
    o.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const p = list.find(x => x.id === b.dataset.rm);
      confirmDialog('Remove these slides?', `"${p.name}" is deleted from this device. Your questions stay.`, 'Remove', async () => {
        await removePdf(deck, p.id); close(); await refreshPage(); slidesSheet(deck, page);
      });
    });
  });
}

// ---- deleting (progress history in the logs is kept, so streaks and totals survive) ----
async function deleteDeck(d) {
  await removeCards((await all('cards')).filter(c => c.deck === d).map(c => c.id));
  await removeDeckPdfs(d);
  delete FM.assign[d]; await saveFM();
}
async function deleteFolder(f) {
  const inF = (await all('cards')).filter(c => folderOf(c.deck) === f);
  await removeCards(inF.map(c => c.id));
  for (const d of new Set(inF.map(c => c.deck))) await removeDeckPdfs(d);
  FM.folders = FM.folders.filter(x => x !== f);
  for (const k of Object.keys(FM.assign)) if (FM.assign[k] === f) delete FM.assign[k];
  await saveFM();
}

// ---- renaming (card ids stay the same, so progress is kept) ----
async function renameDeck(o, n) {
  await putMany('cards', (await all('cards')).filter(c => c.deck === o).map(c => ({ ...c, deck: n })));
  if (o in FM.assign) { FM.assign[n] = FM.assign[o]; delete FM.assign[o]; await saveFM(); }
  const list = await pdfList(o);
  for (const p of list) {
    const data = await pdfGet(pdfKey(o, p.id));
    if (data) await pdfPut(pdfKey(n, p.id), data);
    await pdfDel([pdfKey(o, p.id)]);
  }
  if (list.length) { await setMeta('pdfs:' + n, list); await setMeta('pdfs:' + o, []); }
}
async function renameFolder(o, n) {
  const decks = new Set((await all('cards')).filter(c => folderOf(c.deck) === o).map(c => c.deck));
  for (const d of decks) {
    const i = d.indexOf(' - ');
    if (FM.assign[d] === o) FM.assign[d] = n;
    else if (!FM.assign[d] && i > 0) await renameDeck(d, n + d.slice(i));   // folder comes from the deck name
    else FM.assign[d] = n;
  }
  FM.folders = [...new Set(FM.folders.map(x => x === o ? n : x))];
  await saveFM();
}
function renameDialog(title, cur, max, check, apply) {
  modal(`<h2>${esc(title)}</h2><input class="inp" id="rn" maxlength="${max}" value="${esc(cur)}" autocomplete="off">
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok">Save</button></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s);
    const go = async () => {
      const n = q('#rn').value.trim();
      if (n === cur) return close();
      const err = !n ? 'Type a name first.' : await check(n);
      if (err) { q('#er').textContent = err; return; }
      close(); await apply(n);
    };
    q('#c').onclick = close; q('#ok').onclick = go;
    q('#rn').onkeydown = e => { if (e.key === 'Enter') go(); };
    q('#rn').select();
  });
}
function renameDeckUI(d) {
  const i = d.indexOf(' - '), pre = lectureOf(d) !== d ? d.slice(0, i) + ' - ' : '';
  renameDialog('Rename deck', lectureOf(d), 80,
    async n => (await all('cards')).some(c => c.deck === pre + n) ? 'A deck with that name already exists.' : '',
    async n => { await renameDeck(d, pre + n); home(`Renamed to "${n}".`); });
}
function renameFolderUI(f) {
  renameDialog('Rename folder', f, 40,
    async n => allFolders(await all('cards')).some(x => x !== f && x.toLowerCase() === n.toLowerCase()) ? 'That folder already exists.' : '',
    async n => { await renameFolder(f, n); if (folder === f) folder = n; home(`Renamed to "${n}".`); });
}

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
function confirmDialog(title, text, yes, onYes) {
  modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row end"><button id="c">Cancel</button><button class="danger" id="ok">${esc(yes)}</button></div>`, (o, close) => {
    o.querySelector('#c').onclick = close;
    o.querySelector('#ok').onclick = async () => { close(); await onYes(); };
  });
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
  modal(`<h2>Add a deck</h2><p>Choose the folder it goes in, then pick the file the AI made.</p>
    <select class="inp" id="fs"><option value="">Auto (from the deck name)</option>${folders.map(f => `<option value="${esc(f)}" ${f === pre ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new">+ New folder…</option></select>
    <input class="inp" id="fn" maxlength="40" placeholder="New folder name" hidden>
    <label class="btn pickpdf">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>', 20)} Attach slides (PDFs)<input type="file" id="pf" accept="application/pdf,.pdf" multiple hidden></label>
    <p class="pname" id="pname">Optional: the slides or PDFs the questions came from.</p>
    <div class="row end"><button id="c">Cancel</button><label class="btn p">Choose deck file<input type="file" id="fi" accept=".json,application/json" hidden></label></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s);
    q('#fs').onchange = () => { q('#fn').hidden = q('#fs').value !== '__new'; if (!q('#fn').hidden) q('#fn').focus(); };
    q('#c').onclick = close;
    q('#pf').onchange = () => { const fs = [...q('#pf').files]; q('#pname').textContent = !fs.length ? 'Optional: the slides or PDFs the questions came from.' : fs.length === 1 ? `${fs[0].name} (${(fs[0].size / 1048576).toFixed(1)} MB)` : `${fs.length} PDFs selected`; };
    q('#fi').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      let folder = q('#fs').value;
      if (folder === '__new') {
        folder = q('#fn').value.trim();
        if (!folder) { q('#er').textContent = 'Type a name for the new folder first.'; e.target.value = ''; return; }
        folder = folders.find(x => x.toLowerCase() === folder.toLowerCase()) || folder;
      }
      const pdfs = [...q('#pf').files];
      close();
      let msg = await importFile(f, folder);
      if (pdfs.length && lastDeck) msg += ' ' + await attachSlides(lastDeck, pdfs);
      home(msg);
    };
  });
}

// ---- home ----
async function home(msg = '') {
  onkeydown = null;
  document.body.classList.remove('studying');
  renderNav();
  await loadFM();
  const [cards, logs, last, pdfN] = await Promise.all([all('cards'), all('logs'), getMeta('lastBackup'), pdfCounts()]);
  const now = Date.now(), today = dayKey(now);
  const stale = bkDays && logs.length && (!last || now - last > bkDays * DAY);
  const banner = `${stale ? `<div class="banner"><span>No backup ${last ? 'for ' + Math.floor((now - last) / DAY) + ' days' : 'yet'}.</span><button id="bk">Back up</button></div>` : ''}
    ${msg ? `<div class="msg ${/failed|valid JSON/.test(msg) ? 'err' : ''}">${esc(msg)}</div>` : ''}`;
  const todoOf = cs => cs.filter(c => !c.reps || c.due <= now).length;
  const trash = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 20);
  const delBadge = (attr, v) => editing ? `<span class="del" data-${attr}="${esc(v)}" role="button" aria-label="Delete">${trash}</span>` : '';
  const renBadge = (attr, v) => editing ? `<span class="ren" data-${attr}="${esc(v)}" role="button" aria-label="Rename">${svg('<path d="M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4"/>', 20)}</span>` : '';
  const editBtn = `<button class="edit${editing ? ' on' : ''}" data-act="edit">${editing ? 'Done' : 'Edit'}</button>`;
  const slidesChip = d => { const n = pdfN.get(d) || 0; return editing ? '' : `<span class="sl${n ? ' on' : ''}" role="button" data-slides="${esc(d)}" data-n="${n}" aria-label="Slides">${slidesIco()}${n > 1 ? 'Slides · ' + n : n ? 'Slides' : '+ Slides'}</span>`; };
  const deckCard = (d, withFolder) => {
    const cs = cards.filter(c => c.deck === d), n = cs.length, todo = todoOf(cs), mat = cs.filter(c => c.interval >= 21).length;
    return `<button class="deckcard${editing ? ' editing' : ''}" data-deck="${esc(d)}" ${todo ? '' : 'data-practice="1"'}>${delBadge('deldeck', d)}${renBadge('rendeck', d)}
      ${withFolder ? `<span class="fl">${folderSvg(18)}${esc(folderOf(d))}</span>` : ''}<span class="dn">${esc(lectureOf(d))}</span>
      <span class="dm"><small>${n} question${n === 1 ? '' : 's'}</small>${todo ? `<b class="due">${todo} to do</b>` : '<b class="due done">All done</b>'}</span>
      <span class="bar2"><i style="width:${Math.round(100 * mat / n)}%"></i></span>
      <span class="dfoot">${slidesChip(d)}<span class="go">${todo ? 'Study' : 'Practice'} ›</span></span></button>`;
  };
  let body = '';

  if (view === 'today') {
    const decks = [...new Set(cards.map(c => c.deck))].sort();
        const hp = (k, col, v, t) => `<span class="hp" style="color:${col}" title="${t}">${fsvg(k, 'currentColor', 46)}${v}</span>`;
    if (folder && !allFolders(cards).includes(folder)) folder = null;
    if (!folder) editing = false;
    const scope = folder ? cards.filter(c => folderOf(c.deck) === folder) : cards;
    const sDue = scope.filter(c => c.reps && c.due <= now).length, sNew = scope.filter(c => !c.reps).length;
    const wr = wrongIds(logs), nWrong = scope.filter(c => wr.has(c.id)).length;
    const mode = smode || (sDue ? 'due' : sNew ? 'new' : nWrong ? 'wrong' : 'due'), cnt = { due: sDue, new: sNew, wrong: nWrong }[mode];
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
      return `<button class="folder${editing ? ' editing' : ''}" data-folder="${esc(f)}">${delBadge('delfolder', f)}${renBadge('renfolder', f)}<span class="fic">${folderSvg(64)}</span>
        <span class="ftx"><span class="nm">${esc(f)}</span><small>${nd} deck${nd === 1 ? '' : 's'} · ${cs.length} questions</small><span class="bar2"><i style="width:${cs.length ? Math.round(100 * mat / cs.length) : 0}%"></i></span></span>${todo ? `<b class="badge2">${todo}</b>` : ''}</button>`;
    }).join('')}</div>`;
    body = `<div class="toprow"><div>${head}</div>
      <div class="hud">${hp('flame', '#ff9600', streak(logs), 'day streak')}${folder && scope.length ? editBtn : ''}</div></div>
    ${banner}
    <section class="hero">
      <div><span class="big">${cnt}</span><span class="lbl">${cnt || !scope.length ? { due: 'questions due', new: 'new questions', wrong: 'to redo' }[mode] : { due: 'all done for today', new: 'no new questions', wrong: 'nothing to redo' }[mode]} ${left}</span><div class="sub">${sDue} due · ${sNew} new · ${streak(logs)} day streak</div>
        <button class="hct${hideCh ? ' on' : ''}" id="hc" aria-pressed="${hideCh}">Hide choices first: ${hideCh ? 'On' : 'Off'}</button></div>
      <div class="sess"><div class="chips">${[['due', 'Due', sDue], ['new', 'New', sNew], ['wrong', 'Wrong', nWrong]].map(([m, l, n]) => `<button class="chip${m === mode ? ' on' : ''}" data-mode="${m}">${l}<small>${n}</small></button>`).join('')}</div>
        <div class="chips">${[10, 20, 30, 40].map(n => `<button class="chip${n === sess ? ' on' : ''}" data-size="${n}">${n}</button>`).join('')}</div>
        ${cnt ? `<button id="all" data-mode="${mode}" data-limit="${sess}" ${folder ? `data-folder="${esc(folder)}"` : ''}>Start ${Math.min(cnt, sess)} question${Math.min(cnt, sess) === 1 ? '' : 's'}</button>` : scope.length ? `<button id="all" data-practice="1" data-limit="${sess}" ${folder ? `data-folder="${esc(folder)}"` : ''}>Practice anyway</button>` : ''}</div>
    </section>
    ${list}`;
  } else if (view === 'more') {
    const row = (v, t, d) => `<button class="morerow" data-go="${v}"><span class="mi">${svg(ICONS[v], 28)}</span><span class="mt"><b>${t}</b><small>${d}</small></span><span class="chv">›</span></button>`;
    body = `<h1 class="pt">More</h1><div style="height:20px"></div>${banner}
    <div class="morelist">${row('data', 'Data', 'Import decks and back up your progress')}${row('guide', 'Guide', 'How to make decks with AI')}${row('settings', 'Settings', 'Theme, sounds and reminders')}</div>`;
  } else if (view === 'decks') {
    const names = [...new Set(cards.map(c => c.deck))].sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
    body = `<div class="toprow"><div><h1 class="pt">All decks</h1><p class="tag">${names.length ? names.length + ' deck' + (names.length === 1 ? '' : 's') + ' · tap one to study it' : 'tap + to add your first deck'}</p></div>
      <div class="tbtns">${names.length ? editBtn : ''}<button class="p plus" data-act="adddeck" aria-label="Add deck">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div></div>${banner}
    <div class="deckgrid">${names.map(d => deckCard(d, true)).join('')}<button class="addtile" data-act="adddeck">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>Add deck</span></button></div>`;
  } else if (view === 'folders') {
    const names = allFolders(cards);
    body = `<div class="toprow"><div><h1 class="pt">Folders</h1><p class="tag">${names.length ? 'tap a folder to open it' : 'tap + to create your first folder'}</p></div>
      <div class="tbtns">${names.length ? editBtn : ''}<button class="p plus" data-act="newfolder" aria-label="New folder">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div></div>${banner}
    <div class="bigf">${names.map(f => {
      const cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size, todo = cs.filter(c => !c.reps || c.due <= now).length, mat = cs.filter(c => c.interval >= 21).length;
      return `<button class="bf${editing ? ' editing' : ''}" data-folder="${esc(f)}">${delBadge('delfolder', f)}${renBadge('renfolder', f)}${todo ? `<b class="badge2">${todo}</b>` : ''}${folderSvg(132)}
        <span class="nm">${esc(f)}</span><small>${nd} deck${nd === 1 ? '' : 's'} · ${cs.length} questions</small><span class="bar2"><i style="width:${cs.length ? Math.round(100 * mat / cs.length) : 0}%"></i></span></button>`;
    }).join('')}<button class="addtile" data-act="newfolder">${svg('<path d="M12 5v14M5 12h14"/>', 44)}<span>New folder</span></button></div>`;
  } else if (view === 'stats') {
    const nC = cards.length, known = cards.filter(c => c.interval >= 21).length, unseen = cards.filter(c => !c.reps).length, learning = nC - known - unseen;
    const share = x => nC ? 100 * x / nC : 0;
    // one pass over the logs for everything below (per day, per deck, totals)
    const byDay = new Map(), byDeck = new Map();
    let revOk = 0, revN = 0;
    for (const l of logs) {
      const k = dayKey(l.t);
      let d = byDay.get(k); if (!d) byDay.set(k, d = { total: 0, ok: 0 });
      let dk = byDeck.get(l.deck); if (!dk) byDeck.set(l.deck, dk = { n: 0, ok: 0 });
      d.total++; dk.n++;
      if (!l.isNew) revN++;
      if (l.correct) { d.ok++; dk.ok++; if (!l.isNew) revOk++; }
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
    const live = new Set(cards.map(c => c.deck));
    const weak = [...byDeck].filter(([d, v]) => live.has(d) && v.n >= 5).map(([d, v]) => ({ d, n: v.n, acc: Math.round(100 * v.ok / v.n) })).sort((a, b) => a.acc - b.acc).slice(0, 4);
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
    const presets = [0, 10, 20, 30, 50], isCustom = !presets.includes(qCount);
    body = `<h1 class="pt">Guide</h1><p class="tag">make a deck from your material in 3 steps</p><div style="height:18px"></div>${banner}
    <div class="gsteps">
      <section class="card gs"><div class="gn">1</div><div class="gb"><h3>Copy a prompt</h3>
        <div class="gsel">
          <label>Question type<select class="inp" id="ptype">${PROMPTS.map((p, i) => `<option value="${i}" ${i === pi ? 'selected' : ''}>${esc(p[0])}</option>`).join('')}</select></label>
          <label>How many<select class="inp" id="qsel">${presets.map(n => `<option value="${n}" ${n === qCount ? 'selected' : ''}>${n || 'As many as needed'}</option>`).join('')}<option value="custom" ${isCustom ? 'selected' : ''}>Custom…</option></select></label>
        </div>
        <input class="inp" id="qcustom" type="number" min="1" max="200" inputmode="numeric" placeholder="Number of questions (1-200)" value="${isCustom ? qCount : ''}" ${isCustom ? '' : 'hidden'}>
        <p class="gdesc" id="pd"></p>
        <button class="p" id="cp">Copy prompt</button>
        <details class="prev"><summary>Preview the prompt</summary><pre id="pr" class="prompt"></pre></details>
      </div></section>
      <section class="card gs"><div class="gn">2</div><div class="gb"><h3>Ask the AI</h3>
        <p>Open Claude or ChatGPT, attach your slides, notes or PDF, paste the prompt and send. Save the reply as a <b>.json</b> file.</p></div></section>
      <section class="card gs"><div class="gn">3</div><div class="gb"><h3>Import it</h3>
        <p>Pick a folder and choose the deck file. You can also attach the slides (up to 50 PDFs per deck), so you can open them while studying. Importing the same deck again keeps your progress.</p>
        <button class="p" data-act="adddeck">Add a deck</button></div></section>
    </div>
    <button id="wt" style="margin:22px 0 18px">Replay the app walkthrough</button>
    <h2>Keep your files organised</h2>
    <section class="card"><p class="gdesc" style="margin:0 0 14px">In the <b>Files</b> app (On My iPad or iCloud Drive), set up this structure once:</p>
      <div class="ftree">
        <div class="fr">${svg(ICONS.folders, 24)}<b>ankidote</b></div>
        <div class="fr l1">${svg(ICONS.folders, 22)}<b>decks</b><span>the .json files the AI gives you</span></div>
        <div class="fr l1">${svg(ICONS.folders, 22)}<b>backups</b><span>exports from the Data tab</span></div>
        <div class="fr l1">${svg(ICONS.folders, 22)}<b>slides</b><em>optional</em><span>your PDFs, to attach to a deck</span></div>
      </div>
      <p class="gdesc" style="margin:14px 0 0">Browsers can't create folders on your iPad for you, so this is a one-time manual setup. When you import or back up, pick files from these folders.</p></section>
    <h2>Add to Home Screen (iPad)</h2>
    <section class="card"><ol style="margin:0;padding-left:20px;line-height:1.6">
      <li>Open this page in <b>Safari</b> (other iPad browsers work too on iPadOS 16.4+).</li>
      <li>Tap the <b>Share</b> button (square with an up arrow) in the toolbar.</li>
      <li>Scroll the menu and tap <b>Add to Home Screen</b>.</li>
      <li>Keep the name, make sure <b>Open as Web App</b> is on if shown, then tap <b>Add</b>.</li>
    </ol><p class="gdesc" style="margin-top:10px">It then opens full-screen like an app. Your data stays on this iPad, so back up from the Data tab.</p></section>
    <p class="fine">Study a little every day, and back up now and then from the Data tab.</p>`;
  } else if (view === 'settings') {
    const t = theme(), seg = (v, l) => `<button data-theme-set="${v}" class="${t === v ? 'on' : ''}">${l}</button>`;
    body = `<h1 class="pt">Settings</h1><div style="height:20px"></div>${banner}
    <h2>Preferences</h2>
    <section class="card" style="padding-top:6px;padding-bottom:6px">
      <div class="set"><div><strong>Appearance</strong><p>Light, dark, or follow the iPad.</p></div>
        <div class="seg2">${seg('light', 'Light')}${seg('dark', 'Dark')}${seg('auto', 'Auto')}</div></div>
      <div class="set"><div><strong>Interface size</strong><p>Zoom the whole app in or out.</p></div>
        <div class="zoomr"><input type="range" id="zm" min="70" max="150" step="5" value="${Math.round(zoomNow() * 100)}" aria-label="Interface size"><b id="zv">${Math.round(zoomNow() * 100)}%</b></div></div>
      <div class="set col"><div><strong>Color theme</strong><p>Pick a palette for the whole app.</p></div>
        <div class="pals">${PALETTES.map(p => `<button class="pal ${p.id === curPalette() ? 'on' : ''}" data-pal="${p.id}" aria-label="${p.label}"><span class="dots"><i style="background:${p.sw[0]}"></i><i style="background:${p.sw[1]}"></i></span>${p.label}</button>`).join('')}</div></div>
      <div class="set"><div><strong>Backup reminder</strong><p>How often to nudge you to save a backup. Your progress only lives on this iPad.</p></div>
        <select class="inp" id="bkd" aria-label="Backup reminder">${[[0, 'Off'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every month']].map(([v, l]) => `<option value="${v}" ${v === bkDays ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set"><div><strong>Sound effects</strong><p>A bright chime for correct, a soft low tone for wrong, and a short fanfare when you finish.</p></div>
        <input type="checkbox" class="tgl" id="snd" ${sound ? 'checked' : ''} aria-label="Sound effects"></div>
      <div class="set"><div><strong>Try the sounds</strong><p>No sound? Turn the iPad volume up and check it isn't muted (the bell icon in Control Center, or the side switch).</p></div>
        <div class="row" style="flex-wrap:nowrap;flex:none"><button id="t-ok">Correct</button><button id="t-no">Wrong</button></div></div>
      <div class="set"><div><strong>App walkthrough</strong><p>A quick tour of what ankidote can do.</p></div>
        <div class="row"><button id="wt">Start</button></div></div>
    </section>`;
  } else {
    body = `<h1 class="pt">Data</h1><div style="height:20px"></div>${banner}
    <div class="two">
      <section class="card"><h2 style="margin-top:0">Import</h2><p>Add a deck file made by an AI, or restore a backup. Re-importing a deck keeps your progress.</p>
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
  if (q('#all')) q('#all').onclick = e => { const d = e.currentTarget.dataset; study({ ...(d.folder && { folder: d.folder }), mode: d.mode, limit: +d.limit || 0 }, !!d.practice); };
  $.querySelectorAll('[data-mode].chip').forEach(b => b.onclick = () => { smode = b.dataset.mode; home(); });
  $.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { sess = +b.dataset.size; try { localStorage.setItem('sess', sess); } catch {} home(); });
  if (q('#up')) q('#up').onclick = () => { folder = null; editing = false; home(); };
  $.querySelectorAll('[data-folder]:not(#all)').forEach(b => b.onclick = () => { if (editing) return renameFolderUI(b.dataset.folder); folder = b.dataset.folder; view = 'today'; home(); });
  $.querySelectorAll('[data-pal]').forEach(b => b.onclick = () => { setPalette(b.dataset.pal); home(); });
  $.querySelectorAll('[data-deck]').forEach(b => b.onclick = () => { if (editing) return renameDeckUI(b.dataset.deck); study({ deck: b.dataset.deck }, !!b.dataset.practice); });
  if (q('#hc')) q('#hc').onclick = () => { hideCh = !hideCh; try { localStorage.setItem('hidech', hideCh ? '1' : '0'); } catch {} home(); };
  $.querySelectorAll('[data-act=edit]').forEach(b => b.onclick = () => { editing = !editing; home(); });
  $.querySelectorAll('[data-slides]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const d = x.dataset.slides;
    if (+x.dataset.n === 1) openSlides(d); else slidesSheet(d);
  });
  $.querySelectorAll('[data-rendeck],[data-renfolder]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    x.dataset.rendeck ? renameDeckUI(x.dataset.rendeck) : renameFolderUI(x.dataset.renfolder);
  });
  $.querySelectorAll('[data-deldeck]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const d = x.dataset.deldeck, n = cards.filter(c => c.deck === d).length;
    confirmDialog(`Delete "${lectureOf(d)}"?`, `This removes the deck and its ${n} question${n === 1 ? '' : 's'}, along with your progress on them. This can't be undone.`, 'Delete', async () => { await deleteDeck(d); home(`Deleted "${lectureOf(d)}".`); });
  });
  $.querySelectorAll('[data-delfolder]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const f = x.dataset.delfolder, cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size;
    confirmDialog(`Delete the "${f}" folder?`, nd ? `This removes the folder, its ${nd} deck${nd === 1 ? '' : 's'} and ${cs.length} question${cs.length === 1 ? '' : 's'}, along with your progress on them. This can't be undone.` : 'This folder is empty, so nothing else is removed.', 'Delete', async () => { await deleteFolder(f); if (folder === f) folder = null; home(`Deleted the "${f}" folder.`); });
  });
  if (q('#pr')) {
    const show = () => { q('#pr').textContent = promptText(pi); q('#pd').textContent = PROMPTS[pi][1]; };
    const setCount = n => { qCount = n; try { localStorage.setItem('qcount', n); } catch {} show(); };
    q('#ptype').onchange = e => { pi = +e.target.value; show(); };
    q('#qsel').onchange = e => {
      const custom = e.target.value === 'custom';
      q('#qcustom').hidden = !custom;
      if (custom) { q('#qcustom').focus(); setCount(Math.min(200, Math.max(1, Math.floor(+q('#qcustom').value) || 20))); q('#qcustom').value = qCount; }
      else { q('#qcustom').value = ''; setCount(+e.target.value); }
    };
    q('#qcustom').oninput = e => setCount(Math.min(200, Math.max(1, Math.floor(+e.target.value) || 1)));
    show();
  }
  if (q('#wt')) q('#wt').onclick = walkthrough;
  if (q('#cp')) q('#cp').onclick = async e => {
    try { await navigator.clipboard.writeText(promptText(pi)); } catch { const r = document.createRange(); r.selectNodeContents(q('#pr')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy prompt'; }, 1500);
  };
  if (q('#bkd')) q('#bkd').onchange = e => { bkDays = +e.target.value; try { localStorage.setItem('bkdays', bkDays); } catch {} };
  if (q('#zm')) {   // applied on release, because zooming while dragging would move the slider out from under the finger
    q('#zm').oninput = e => { q('#zv').textContent = e.target.value + '%'; };
    q('#zm').onchange = e => { const z = e.target.value / 100; try { localStorage.setItem('zoom', z); } catch {} document.documentElement.style.zoom = z; };
  }
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
  const [cards, logs, pdfN] = await Promise.all([all('cards'), all('logs'), pdfCounts()]);
  const now = Date.now(), pool = sel?.deck ? cards.filter(c => c.deck === sel.deck) : sel?.folder ? cards.filter(c => folderOf(c.deck) === sel.folder) : cards;
  const wrong = wrongIds(logs), due = pool.filter(c => c.reps && c.due <= now).sort((a, b) => a.due - b.due), fresh = pool.filter(c => !c.reps);
  let queue = practice ? pool.map(c => ({ ...c })).sort(() => Math.random() - .5)
    : sel?.mode === 'due' ? due : sel?.mode === 'new' ? fresh
    : sel?.mode === 'wrong' ? pool.filter(c => wrong.has(c.id)).sort(() => Math.random() - .5) : [...due, ...fresh];
  if (sel?.limit) queue = queue.slice(0, sel.limit);
  lastScreen = null;
  const total = queue.length;
  let prevPct = 0;
  const hist = [];   // questions answered this session, for looking back at
  const next = () => {
    if (!queue.length) { play('done'); burst(innerWidth / 2, innerHeight * .55, 150, 1.5); return home(`${practice ? 'Practice done' : 'Done'}. ${total} question${total === 1 ? '' : 's'} reviewed.`); };
    const c = queue[0], isNew = !c.reps, t0 = Date.now();
    $.innerHTML = `<div class="page study">
      <div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button>
        <div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">${practice ? 'Practice · ' : ''}${queue.length} left</span></div>
      <div class="kickrow"><div class="kick">${isNew ? 'New question' : practice ? 'Practice' : 'Review'}</div><button class="hct2${hideCh ? ' on' : ''}" id="hq" aria-pressed="${hideCh}">Hide choices: ${hideCh ? 'On' : 'Off'}</button></div>
      <h2 class="qh">Choose the best answer</h2>
      <p class="stem">${esc(c.stem)}</p>
      ${hideCh ? '<button class="p" id="rv" style="width:100%;margin-bottom:14px">Show choices</button>' : ''}
      <div id="opts" ${hideCh ? 'hidden' : ''}>${c.options.map((o, i) => `<button class="opt" data-i="${i}"><b>${'ABCDEFGH'[i] || i + 1}</b><span>${esc(o)}</span></button>`).join('')}</div>
      <p class="kbd">A–E to answer · ${practice ? 'Enter to continue' : '1 Again · 2 Hard · 3 Good · 4 Easy · Enter to continue'}</p>
      <div id="after"></div>
      <div class="snav"><button id="sb" aria-label="Previous question" ${hist.length ? '' : 'disabled'}>‹ Back</button><span>Current question</span><button id="sf" aria-label="Skip question" ${queue.length > 1 ? '' : 'disabled'}>Skip ›</button></div></div>`;
    const pct = Math.max(0, 100 * (1 - queue.length / total));
    const bar = $.querySelector('.prog i');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = pct + '%'; }));
    prevPct = pct;
    $.querySelector('#back').onclick = e => { e.preventDefault(); home(); };
    $.querySelector('#sb').onclick = () => review(hist.length - 1);
    $.querySelector('#sf').onclick = () => { queue.push(queue.shift()); next(); };   // skip: it comes back at the end
    $.querySelector('#hq').onclick = () => { hideCh = !hideCh; try { localStorage.setItem('hidech', hideCh ? '1' : '0'); } catch {} next(); };
    const reveal = () => { $.querySelector('#opts').hidden = false; $.querySelector('#rv')?.remove(); };
    if (hideCh) $.querySelector('#rv').onclick = reveal;
    onkeydown = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase(), rb = $.querySelectorAll('[data-r]');
      if (k === 'arrowleft' || k === 'arrowright') { $.querySelector(k === 'arrowleft' ? '#sb' : '#sf')?.click(); return; }
      if ($.querySelector('#rv')) { if (k === 'enter' || k === ' ' || 'abcdefgh12345678'.includes(k) && k.length === 1) { e.preventDefault(); reveal(); } return; }
      if (rb.length) {
        const r = k === 'enter' || k === ' ' ? $.querySelector('[data-r].p') : rb.length === 4 && '1234'.includes(k) && k ? rb['1234'.indexOf(k)] : null;
        if (r) { e.preventDefault(); r.click(); }
      } else {
        const i = 'abcdefgh'.indexOf(k), o = $.querySelectorAll('.opt')[k >= '1' && k <= '8' ? +k - 1 : i];
        if (o && k.length === 1) o.click();
      }
    };
    $.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const pick = +b.dataset.i, correct = pick === c.answer, ms = Date.now() - t0;
      play(correct ? 'ok' : 'no');
      hist.push({ c, pick, correct }); $.querySelector('.snav').style.display = $.querySelector('#hq').style.display = 'none';   // hide while rating, so it never covers the feedback popup
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
        ${pdfN.get(c.deck) ? `<button class="slbtn" data-slide="${c.slide || 1}">${slidesIco()} ${c.slide ? 'View slide ' + c.slide : 'View slides'}</button>` : ''}
        <div class="row rate">${correct && !practice
          ? ['again', 'hard', 'good', 'easy'].map(r => `<button data-r="${r}" ${r === 'good' ? 'class="p"' : ''}>${r}</button>`).join('')
          : `<button data-r="again" class="p">${correct ? 'Continue' : 'Next'}</button>`}</div>
        ${practice && !correct ? '<p class="hint">Missed ones come back until you get them right.</p>' : ''}</div>`;
      const sb = $.querySelector('.slbtn');
      if (sb) sb.onclick = () => pdfN.get(c.deck) === 1 ? openSlides(c.deck, +sb.dataset.slide) : slidesSheet(c.deck, +sb.dataset.slide);
      $.querySelector('.fb').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      $.querySelectorAll('[data-r]').forEach(x => x.onclick = () => rate(x.dataset.r));
    });
  };
  const review = i => {   // read-only look at an answered question; Forward walks back toward the current one, which starts fresh
    const { c, pick, correct } = hist[i], last = i === hist.length - 1;
    $.innerHTML = `<div class="page study">
      <div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button><div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">Looking back</span></div>
      <div class="kick">${correct ? 'You got this right' : 'You got this wrong'}</div>
      <p class="stem">${esc(c.stem)}</p>
      <div id="opts">${c.options.map((o, j) => `<button class="opt ${j === c.answer ? 'ok' : j === pick ? 'no' : ''}" disabled><b>${'ABCDEFGH'[j] || j + 1}</b><span>${esc(o)}</span></button>`).join('')}</div>
      ${c.explanation ? `<div class="fb ${correct ? 'ok' : 'no'}"><p class="fbe" style="margin:0">${esc(c.explanation)}</p></div>` : ''}
      <div class="snav"><button id="sb" aria-label="Earlier question" ${i ? '' : 'disabled'}>‹ Back</button><span>${i + 1} of ${hist.length} answered</span><button id="sf" aria-label="${last ? 'Back to current question' : 'Later question'}">${last ? 'Current' : 'Forward'} ›</button></div></div>`;
    $.querySelector('#back').onclick = () => home();
    $.querySelector('#sb').onclick = () => review(i - 1);
    $.querySelector('#sf').onclick = () => last ? next() : review(i + 1);
    onkeydown = e => { if (e.key === 'ArrowLeft') $.querySelector('#sb').click(); else if (e.key === 'ArrowRight' || e.key === 'Enter') $.querySelector('#sf').click(); };
  };
  next();
}

// iOS ignores user-scalable=no in places, so also swallow pinch gestures (Safari's gesture* events and multi-finger moves)
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// splash on every launch; the walkthrough only on the first one (or when replayed from the Guide)
const TOUR = [
  { h: 'Welcome to ankidote', t: 'A quick tour of the app. Use Next and Back to move around, or Skip any time.' },
  { s: '[data-v="today"]', v: 'today', h: 'Study', t: 'Your daily questions live here. Missed ones come back sooner, ones you know come back later.' },
  { s: '[data-v="folders"]', v: 'folders', h: 'Folders', t: 'Group your decks by subject. Tap + to create a folder.' },
  { s: '[data-v="decks"]', v: 'decks', h: 'Decks', t: 'Every deck you have imported. Tap one to study it, or tap + to add a new one.' },
  { s: '#cp', v: 'guide', h: 'Make decks with AI', t: 'Pick a question type, copy the prompt, give it your slides or notes in Claude or ChatGPT, then import the .json it makes.' },
  { s: '[data-v="data"]', v: 'data', h: 'Data and backups', t: 'Import decks and back up your progress here. Tip: keep an "ankidote" folder in Files with decks, backups and (optional) slides inside.' },
  { s: '[data-v="stats"]', v: 'stats', h: 'Stats', t: 'See your streak and which topics need the most work.' },
  { s: '[data-v="settings"]', v: 'settings', h: 'Settings', t: 'Theme, sounds and backup reminders. You can replay this tour from here or the Guide.' },
  { h: 'Add to Home Screen', t: 'In Safari tap Share, then Add to Home Screen, and ankidote opens full-screen like an app.' },
];
function walkthrough() {
  if (document.querySelector('.tr')) return;
  const v0 = view, ov = document.createElement('div'); ov.className = 'tr';
  ov.innerHTML = '<div class="trh"></div><div class="trc"></div>'; document.body.append(ov);
  const [hole, card] = ov.children; let i = 0;
  hole.style.transition = card.style.transition = 'none'; // no sliding in from the corner on the first step
  const end = () => {
    try { localStorage.setItem('onboarded', '1'); } catch {}
    ov.remove();
    if (view !== v0) { view = v0; editing = false; home(); }
  };
  const step = () => {
    const S = TOUR[i], last = i === TOUR.length - 1;
    if (S.v && view !== S.v) { view = S.v; editing = false; if (S.v === 'today') folder = null; home(); }
    card.style.opacity = 0; // hidden until positioned, so it never flashes in the wrong spot
    card.innerHTML = `<small style="opacity:.6">${i + 1} / ${TOUR.length}</small><h3 style="margin:2px 0 6px">${S.h}</h3><p style="margin:0 0 14px">${S.t}</p>
      <div class="row">
      ${last ? '' : '<button id="sk">Skip</button>'}${i ? '<button id="bk">Back</button>' : ''}<button class="p" id="nx">${last ? 'Done' : 'Next'}</button></div>`;
    card.querySelector('#nx').onclick = () => last ? end() : (i++, step());
    if (i) card.querySelector('#bk').onclick = () => (i--, step());
    if (!last) card.querySelector('#sk').onclick = end;
    setTimeout(() => { // wait for the view to render
      const t = S.s && document.querySelector(S.s); t?.scrollIntoView({ block: 'nearest' });
      const r = t?.getBoundingClientRect(), ok = r && r.width > 0, W = innerWidth, H = innerHeight, w = card.offsetWidth, h = card.offsetHeight;
      let x = (W - w) / 2, y = (H - h) / 2;
      if (ok) {
        Object.assign(hole.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + (t.matches('button:not(.nv)') ? 4 : 0) + 'px' }); // buttons have a 4px drop shadow below their box
        if (r.right + 14 + w <= W - 12) { x = r.right + 14; y = r.top + r.height / 2 - h / 2; }
        else { x = r.left + r.width / 2 - w / 2; y = r.bottom + 14 + h <= H - 12 ? r.bottom + 14 : r.top - 14 - h; }
      } else Object.assign(hole.style, { left: W / 2 + 'px', top: H / 2 + 'px', width: 0, height: 0 });
      card.style.left = Math.max(12, Math.min(x, W - w - 12)) + 'px';
      card.style.top = Math.max(12, Math.min(y, H - h - 12)) + 'px';
      card.style.opacity = 1;
      requestAnimationFrame(() => requestAnimationFrame(() => hole.style.transition = card.style.transition = ''));
    }, 150);
  };
  step();
}
function splash() {
  const el = document.createElement('div'); el.className = 'ob';
  el.innerHTML = '<div class="lr"><img class="logo" src="icon-192.png" alt=""><div class="tx"><div class="brand">ankidote</div><p>the antidote to medical exam stress</p></div></div>';
  document.body.append(el);
  setTimeout(() => {
    let seen = false; try { seen = localStorage.getItem('onboarded') === '1'; } catch {}
    if (seen) { el.classList.add('out'); setTimeout(() => el.remove(), 400); }
    else { el.remove(); walkthrough(); }
  }, 1600);
}

navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
home();
splash();
