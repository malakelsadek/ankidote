const DAY = 864e5, MIN = 6e4;
// the publishable key is meant to sit in browser code; row level security decides what it can reach
const sb = supabase.createClient('https://jfvacwoiwmrbplsodlyk.supabase.co', 'sb_publishable_CFT3niRj-XoY0bLLBw_4Pg_gt66zraO');
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
// ---- cloud storage (Supabase) ----
// Cards, review logs and settings live in the user's account. Everything is loaded once after sign-in and kept in memory;
// writes go to the database before they resolve. Slide PDFs and their file lists stay on this device for now (IndexedDB below).
// ponytail: whole account loaded at startup, switch to per-deck loading if accounts get very large
let cache, ready;
const chk = r => { if (r.error) throw r.error; return r.data; };
const chunks = (a, n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const fetchAll = async (table, cols, order) => {   // the API returns at most 1000 rows per request
  const out = [];
  for (let i = 0; ; i += 1000) { const d = chk(await sb.from(table).select(cols).order(order).range(i, i + 999)); out.push(...d); if (d.length < 1000) return out; }
};
const loadAll = async () => {
  const [decks, qs, logs, meta] = await Promise.all([fetchAll('decks', 'id,name', 'id'), fetchAll('questions', '*', 'id'), fetchAll('review_logs', 'data', 'id'), fetchAll('meta', 'key,value', 'key')]);
  const name = new Map(decks.map(d => [d.id, d.name]));
  cache = {
    deckId: new Map(decks.map(d => [d.name, d.id])),
    cards: new Map(qs.map(r => [r.key, { ...r.extra, id: r.key, deck: name.get(r.deck_id), stem: r.stem, options: r.options, answer: r.answer, explanation: r.explanation, ease: r.ease, interval: r.interval, due: Number(r.due), reps: r.reps, lapses: r.lapses }])),
    logs: logs.map(l => l.data),
    meta: new Map(meta.map(m => [m.key, m.value])),
  };
  await pruneDecks().catch(() => {});
};
const pruneDecks = async () => {   // decks with no questions and no slides are invisible leftovers (e.g. from test uploads): remove them
  const withCards = new Set([...cache.cards.values()].map(c => c.deck));
  const used = new Set(chk(await sb.from('slide_files').select('deck_id')).map(f => f.deck_id));
  for (const [n, id] of [...cache.deckId]) if (!withCards.has(n) && !used.has(id)) { chk(await sb.from('decks').delete().eq('id', id)); cache.deckId.delete(n); }
};
const ensureDecks = async names => {
  const miss = [...new Set(names)].filter(n => !cache.deckId.has(n));
  if (!miss.length) return;
  for (const d of chk(await sb.from('decks').upsert(miss.map(name => ({ name })), { onConflict: 'user_id,name' }).select('id,name'))) cache.deckId.set(d.name, d.id);
};
const toRow = c => { const { id, deck, stem, options, answer, explanation, ease, interval, due, reps, lapses, ...extra } = c; return { key: id, deck_id: cache.deckId.get(deck), stem, options, answer, explanation, ease, interval, due, reps, lapses, extra }; };
const all = async s => { await ready; return s === 'cards' ? [...cache.cards.values()] : [...cache.logs]; };
async function putMany(s, items) {
  await ready;
  if (s === 'cards') {
    items = [...new Map(items.map(c => [c.id, c])).values()];   // one row per card per request
    await ensureDecks(items.map(c => c.deck));
    for (const part of chunks(items)) chk(await sb.from('questions').upsert(part.map(toRow), { onConflict: 'user_id,key' }));
    items.forEach(c => cache.cards.set(c.id, c));
  } else {
    for (const part of chunks(items)) chk(await sb.from('review_logs').insert(part.map(l => ({ at: l.t, data: l }))));
    cache.logs.push(...items);
  }
}
async function clear(s) {
  await ready;
  if (s === 'cards') { chk(await sb.from('questions').delete().neq('key', '')); cache.cards.clear(); }
  else { chk(await sb.from('review_logs').delete().gte('id', 0)); cache.logs = []; }
}
async function removeCards(ids) {
  await ready;
  for (const part of chunks(ids, 100)) chk(await sb.from('questions').delete().in('key', part));
  ids.forEach(id => cache.cards.delete(id));
}
// slides used to be kept only in this browser (the "pdfs" store plus a "pdfs:deck" list in meta); migrateDevicePdfs() moves any left into the account
const pdfKey = (deck, id) => deck + '|' + id;
const pdfGet = key => tx('pdfs', 'readonly', o => o.get(key));
const pdfDel = keys => tx('pdfs', 'readwrite', o => keys.forEach(k => o.delete(k)));
const metaKeys = () => tx('meta', 'readonly', o => o.getAllKeys()).then(k => k || []);
const deviceMeta = (k, del) => tx('meta', del ? 'readwrite' : 'readonly', o => del ? o.delete(k) : o.get(k));   // read the on-device list, or delete it

const getMeta = async k => { await ready; return cache.meta.get(k); };
const setMeta = async (k, v) => { await ready; chk(await sb.from('meta').upsert({ key: k, value: v }, { onConflict: 'user_id,key' })); cache.meta.set(k, v); };

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
    const slides = [...new Set([].concat(q.slide ?? q.slides ?? []).filter(n => Number.isInteger(n) && n > 0))], slide = slides[0] || 0;   // one slide, or several for a question that needs more
    return { ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0, ...old, id, deck: d.deck, stem: q.stem, options: q.options, answer: q.answer, explanation: q.explanation || '', ...(slide ? { slide } : {}), ...(slides.length > 1 ? { slides } : {}), ...(slide && typeof q.file === 'string' && q.file.trim() ? { file: q.file.trim() } : {}) };
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
- The "explanation" is a single string with line breaks (
). Line 1 is one or two sentences on why the correct answer is right. Do NOT repeat the correct letter or its text, and do not write "X is correct". Then one line for EACH wrong option, in this exact form: the letter, a colon, then a short reason it is wrong (for example "A: Glucagon is released when glucose falls, not rises."). Cover every wrong option and never the correct one.
- If the material is a slide deck or PDF, every question must have "slide": the number of the slide/page (a whole number) that supports the CORRECT answer. If a question genuinely combines ideas from more than one slide, give a list of all of those slide numbers instead, for example "slide": [12, 15, 18] (in the order the reasoning uses them). Only the correct answer is linked to slides; the wrong options are not. Leave "slide" out only if no slide supports it.
- If more than one file is attached, also add "file": the exact file name of the slide deck or PDF that slide is in.`;
const DIFF = `- Difficulty: make these hard. The student must reason, not recognise a keyword.
  - Never name the diagnosis, cell, structure, drug class or mechanism in the stem. Describe the case or the defect and make the student work out what it is first.
  - Then ask about a consequence of it (a downstream effect, a mechanism, a complication, what is lost or spared, what happens next). That is two reasoning steps in one question.
  - Every option must be the same kind of thing (all cell types, all mechanisms, all haemodynamic effects) and sound plausible, so only someone who understands the topic can separate them.
  - Do not let the stem or the correct option reuse distinctive words from the explanation of the answer.
  - Style to match, with the options added: "A 4-year-old boy has recurrent opportunistic infections. Genetic testing confirms an inherited defect that completely arrests differentiation at the common lymphoid progenitor stage. Which group of mature cells will be absent while the other haematopoietic lineages are spared?" / "A 62-year-old man with chronic headache, facial plethora and generalised pruritus has an abnormal excess of mature circulating erythrocytes. Which haemodynamic alteration directly results from this?"`;
const PROMPTS = [   // difficulty levels: [name, description, prompt]
  ['Easy', 'Short, direct questions on facts, definitions and key terms. Good for a first pass through new material.',
    `Create EASY single-best-answer exam questions from the attached material.

- Each stem is one or two lines testing a single fact: a definition, term, value, classification, list or "which of the following" question. No long vignettes.
- One idea per question. The correct answer should be clear to someone who has read the material once.
- Exactly 5 options. The wrong options must be clearly different from the right one and from each other, but still belong to the same category.
- Cover every key fact, definition, number and list in the material.
${COMMON}`],
  ['Medium', 'Short clinical vignettes that apply one concept. A good default for most revision.',
    `Create MEDIUM-difficulty single-best-answer exam questions from the attached material, in the style of UK medical school exams (NGU).

- Each question is a short clinical vignette (age, sex, presentation, key findings) followed by one question.
- The student must apply one concept from the material to the case, not just recall it.
- Exactly 5 options. Every option is plausible and of the same kind, so the student has to think rather than guess.
- Name the topic or structure only where it is natural to do so.
${COMMON}`],
  ['Difficult', 'Two reasoning steps per question, with plausible options. For when the basics are solid.',
    `Create DIFFICULT single-best-answer exam questions from the attached material.

- Each question is a clinical vignette ending in a question that needs two reasoning steps.
- Exactly 5 options.
${DIFF}
${COMMON}`],
  ['Extremely hard', 'Multi-step reasoning, integrating several slides, with near-identical options. Harder than the real exam.',
    `Create EXTREMELY HARD single-best-answer questions from the attached material, much harder than a typical exam. These are for a student who already knows the basics and wants to be stretched.

- Each question needs three or more reasoning steps. For example: work out the underlying condition from the clues, work out the mechanism, then ask about a consequence, an exception or a complication.
- Where the material allows it, combine ideas from more than one slide or topic in a single question, and list every slide the question draws on in "slide" as a list of numbers.
- Test the edges of the material: exceptions, limits, what changes when a variable is altered, what is spared and what is lost, and the difference between two similar concepts.
- Exactly 5 options. All five must be reasonable and differ only subtly, so that a student with a surface understanding is likely to choose a distractor. Avoid any giveaway wording, and never make the correct option the longest or most detailed.
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
let pi = 2;   // Difficult

// ---- settings: sound + theme ----
let sound = true, actx, keep, keepT;
try { sound = localStorage.getItem('sound') !== '0'; } catch {}
const theme = () => document.documentElement.dataset.theme || 'auto';
function setTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
  try { v === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', v); } catch {}
}
// synthesized with WebAudio so there are no sound files to cache
// tap = soft pop, ok = bright bell arpeggio, no = soft muffled "bonk", done = little fanfare
//
// iOS quirks this works around:
//  - an AudioContext starts suspended and only resumes from a tap, so we wait for resume() before scheduling notes
//  - Web Audio is muted by the silent/mute setting, but a playing <audio> element is not. Playing a silent looping one
//    (and setting the audioSession to "playback") moves the page onto the media channel so the notes are heard.
//    It only runs for ~2s around each sound so it doesn't hold the audio session (or other apps' music) longer than needed.
//  - the silent clip needs real samples (an empty one never counts as "playing"), so it's 0.5s of 8-bit silence built here
//  - after a call/Siri/backgrounding the context can go "interrupted"/"closed" and resume() can hang, so we time it out and rebuild
const SILENT_WAV = (() => {
  const n = 4000, b = new Uint8Array(44 + n).fill(128), v = new DataView(b.buffer), s = (o, t) => [...t].forEach((c, i) => b[o + i] = c.charCodeAt(0));
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
  let bin = ''; b.forEach(x => bin += String.fromCharCode(x));
  return 'data:audio/wav;base64,' + btoa(bin);
})();
const mkCtx = () => {
  const c = new (window.AudioContext || window.webkitAudioContext)();
  c.onstatechange = () => { if (c.state !== 'running' && c === actx && sound) c.resume().catch(() => {}); };   // iOS "interrupted" after a call/Siri
  return c;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let audioQ = Promise.resolve();                           // one audioOn at a time so two quick sounds can't swap the context under each other
const audioOn = () => audioQ = audioQ.then(async () => {
  if (actx && actx.state === 'closed') actx = null;
  actx ||= mkCtx();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (!keep) { keep = new Audio(SILENT_WAV); keep.loop = true; keep.preload = 'auto'; }
  keep.play().catch(() => {});
  clearTimeout(keepT);
  keepT = setTimeout(() => { keep.pause(); try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {} }, 2200);
  if (actx.state !== 'running') {
    await Promise.race([actx.resume().catch(() => {}), wait(400)]);
    if (actx.state !== 'running') {                       // stuck: throw it away and make a fresh one
      try { actx.close(); } catch {}
      actx = mkCtx();
      await Promise.race([actx.resume().catch(() => {}), wait(400)]);
    }
  }
}).catch(() => {});
// unlock on the first touch (iOS only allows starting audio from a tap), and wake up again when the app returns to the foreground
// ponytail: we resume on every tap/return rather than tracking exactly which events iOS killed audio on; it's cheap and idempotent
const wake = () => { if (sound && actx && actx.state !== 'running') audioOn(); };
['pointerdown', 'touchend', 'keydown'].forEach(e => addEventListener(e, () => { if (sound && !actx) audioOn(); else wake(); }, { passive: true, capture: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
addEventListener('pageshow', wake);
// soft pop on any button/toggle; answer choices and the right/wrong buttons have their own sounds
addEventListener('click', e => {
  const b = e.target.closest('button, .btn, .tgl, [role=button]');
  if (b && !b.disabled && !b.matches('.opt, #t-ok, #t-no')) play('tap');
}, true);
async function play(kind) {
  if (!sound) return;
  try {
    await audioOn();
    const out = actx.createGain(); out.gain.value = .9; out.connect(actx.destination);
    const bell = (f, t, len = .55, vol = .5) => {            // sine + 2x + 3x partials, fast attack, long exponential decay
      const at = actx.currentTime + t + .03;
      [[1, 1], [2, .35], [3, .12]].forEach(([m, v]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f * m;
        g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(vol * v, at + .008); g.gain.exponentialRampToValueAtTime(.0001, at + len / m);
        o.connect(g).connect(out); o.start(at); o.stop(at + len);
      });
    };
    const tick = () => {                                     // soft "pop": sine with a gentle attack and a low glide down, ~140ms; a little above the very first, quiet version
      const at = actx.currentTime + .03, o = actx.createOscillator(), g = actx.createGain();
      o.frequency.setValueAtTime(680, at); o.frequency.exponentialRampToValueAtTime(430, at + .11);
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.2, at + .014); g.gain.exponentialRampToValueAtTime(.0001, at + .15);
      o.connect(g).connect(out); o.start(at); o.stop(at + .16);
    };
    const bonk = (f, t) => {                                 // low sine through a lowpass, gentle pitch drop
      const at = actx.currentTime + t + .03, o = actx.createOscillator(), g = actx.createGain(), lp = actx.createBiquadFilter();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, at); o.frequency.exponentialRampToValueAtTime(f * .88, at + .22);
      lp.type = 'lowpass'; lp.frequency.value = 700;
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.7, at + .015); g.gain.exponentialRampToValueAtTime(.0001, at + .3);
      o.connect(lp).connect(g).connect(out); o.start(at); o.stop(at + .32);
    };
    if (kind === 'tap') tick();
    else if (kind === 'ok') [[784, 0], [988, .075], [1319, .15]].forEach(([f, t]) => bell(f, t, .6, .45));
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
  subscription: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  generate: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  community: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.500a3 3 0 0 1 0 5.500M18 20a5 5 0 0 0-3-4.600"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  chev: '<path d="m15 6-6 6 6 6"/>',
};
const ICONS_I = {   // pictures for the install steps in the Guide
  safari: '<circle cx="12" cy="12" r="9"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M6 12H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1"/>',
  plus: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  tick: '<circle cx="12" cy="12" r="9"/><path d="m8 12.500 3 3 5-6"/>',
  dots: '<circle cx="12" cy="5" r="1.600"/><circle cx="12" cy="12" r="1.600"/><circle cx="12" cy="19" r="1.600"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 7v5m0 0-2-2m2 2 2-2M8 20h8"/>',
};
const svg = (p, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const FILL = {
  flame: '<path d="M12 2s5.5 4.6 5.5 10.2a5.5 5.5 0 0 1-11 0c0-2.2 1-3.800 2.200-4.800.300 1.600 1 2.400 1.900 2.800C10.100 7 10.300 4.400 12 2z"/>',
  bolt: '<path d="M13.500 2 4.500 13.500h6.500L10 22l9-11.500h-6.500z"/>',
  star: '<path d="m12 2.500 2.900 5.900 6.500.9-4.700 4.600 1.100 6.500-5.800-3-5.800 3 1.100-6.500L2.600 9.300l6.500-.9z"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m7.500 12.500 3 3 6-6.500" fill="none" stroke="#fff" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>',
};
const fsvg = (k, c, s = 26) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">${FILL[k]}</svg>`;
// signed-in account shown above Settings: profile picture (or an initial) and first name; tapping it opens Settings, where Sign out is
let me = null;
const accountBtn = () => {
  const u = me?.user_metadata || {}, name = u.full_name || u.name || me?.email || 'Account', pic = u.avatar_url || u.picture, ini = esc(name[0].toUpperCase());
  // if Google's picture won't load (blocked, rate-limited, offline) swap in the initial instead of a broken image
  return `<button class="nv wo acct" data-v="settings" title="${esc(name)}">${pic ? `<img class="av" src="${esc(pic)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<i class=&quot;av&quot;>${ini}</i>'">` : `<i class="av">${ini}</i>`}<span>${esc(name.split(' ')[0])}</span></button>`;
};
const fitNav = () => {   // sidebar too tall for the screen (zoomed in a lot): hide the extra tabs and show More instead
  const n = document.getElementById('nav');
  n.classList.remove('crowd');
  if (getComputedStyle(n).flexDirection === 'column' && n.scrollHeight > n.clientHeight + 1) n.classList.add('crowd');
};
addEventListener('resize', fitNav);
function renderNav() {
  const nav = document.getElementById('nav');
  nav.className = min ? 'min' : '';
  nav.innerHTML = `<div class="brand"><img src="icon-192.png" alt="" width="36" height="36" style="border-radius:9px;display:block;flex:none">${min ? '' : '<span>ankidote</span>'}</div>`
    + [['today', 'Study'], ['stats', 'Stats'], ['folders', 'Folders'], ['decks', 'Decks'], ['slides', 'Slides', 'wo'], ['generate', 'Generate', 'wo'], ['community', 'Community', 'wo'], ['data', 'Data', 'wo'], ['guide', 'Guide', 'wo'], ['subscription', 'Subscription', 'wo'], ['settings', 'Settings', 'wo']].map(([v, l, c = '']) => (v === 'subscription' ? accountBtn() : '') +`<button class="nv ${c} ${v === view ? 'on' : ''}" data-v="${v}" title="${l}">${svg(ICONS[v])}<span>${l}</span></button>`).join('')
    + `<button class="nv more ${['more', 'slides', 'generate', 'community', 'subscription', 'data', 'guide', 'settings'].includes(view) ? 'on' : ''}" data-v="more" title="More">${svg(ICONS.more)}<span>More</span></button>`
    + `<button class="nv tog" id="tog" title="${min ? 'Expand' : 'Minimize'}">${svg(ICONS.chev)}<span>Minimize</span></button>`;
  nav.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { if (b.dataset.v === 'tour') return walkthrough(); view = b.dataset.v; editing = false; if (view === 'today') folder = null; home(); });
  nav.querySelector('#tog').onclick = () => { min = !min; try { localStorage.setItem('navmin', min ? '1' : '0'); } catch {} renderNav(); };
  fitNav();
}

// ---- folders: "Subject - Lecture" decks are grouped by the part before the dash ----
const folderSvg = n => `<svg viewBox="0 0 64 64" width="${n}" height="${n}"><path style="fill:var(--acc-d)" d="M6 16a5 5 0 0 1 5-5h14l6 7h22a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/><path style="fill:var(--acc)" d="M6 27a5 5 0 0 1 5-5h42a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z"/></svg>`;

const TRASH_PATH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>';

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
// ---- deleting (progress history in the logs is kept, so streaks and totals survive) ----
async function removeCloudSlides(d) {   // the deck's slide files and the deck itself; a stored PDF goes too unless another deck still uses it
  const id = cache.deckId.get(d);
  if (!id) return;
  const files = chk(await sb.from('slide_files').select('storage_path').eq('deck_id', id));
  chk(await sb.from('decks').delete().eq('id', id));   // its slide_files and page text are removed with it
  cache.deckId.delete(d);
  for (const p of new Set(files.map(f => f.storage_path))) {
    const { count } = await sb.from('slide_files').select('id', { count: 'exact', head: true }).eq('storage_path', p);
    if (!count) await sb.storage.from('slides').remove([p, coverPath(p)]);
  }
}
async function deleteDeck(d) {
  await removeCards((await all('cards')).filter(c => c.deck === d).map(c => c.id));
  await removeCloudSlides(d);
  delete FM.assign[d]; await saveFM();
}
async function deleteFolder(f) {
  const inF = (await all('cards')).filter(c => folderOf(c.deck) === f);
  await removeCards(inF.map(c => c.id));
  for (const d of new Set(inF.map(c => c.deck))) await removeCloudSlides(d);
  FM.folders = FM.folders.filter(x => x !== f);
  for (const k of Object.keys(FM.assign)) if (FM.assign[k] === f) delete FM.assign[k];
  await saveFM();
}

// ---- renaming (card ids stay the same, so progress is kept) ----
async function renameDeck(o, n) {
  await ready;
  const id = cache.deckId.get(o);   // rename the deck row, not just the cards, so its slides stay attached
  if (id) { chk(await sb.from('decks').update({ name: n }).eq('id', id)); cache.deckId.delete(o); cache.deckId.set(n, id); }
  await putMany('cards', (await all('cards')).filter(c => c.deck === o).map(c => ({ ...c, deck: n })));
  if (o in FM.assign) { FM.assign[n] = FM.assign[o]; delete FM.assign[o]; await saveFM(); }
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
// ---- plans: 7-day trial with a small AI allowance, then a paid plan (the server enforces this; the app only displays it) ----
// features switched off for now: their pages just say "coming soon" (set to false to turn the real page back on)
const COMING_SOON = { generate: true, subscription: true };
const soon = title => `<h1 class="pt">${title}</h1><p class="tag">Coming soon</p>`;
// manual payment until online payments exist: fill these in (InstaPay address to pay, and the form people complete after paying)
const INSTAPAY = 'YOUR_INSTAPAY_ADDRESS', PAY_FORM = 'YOUR_FORM_LINK';
const PLAN = { name: 'ankidote Pro', price: 'EGP 500', questions: 400 }, TRIAL_GENS = 2, TRIAL_PAGES = 30;
const planOf = s => {
  const now = Date.now();
  if (s?.status === 'active' && s.current_period_end && new Date(s.current_period_end) > now) return { k: 'active', until: new Date(s.current_period_end) };
  if (s && new Date(s.trial_ends_at) > now) return { k: 'trial', left: Math.ceil((new Date(s.trial_ends_at) - now) / DAY), gens: TRIAL_GENS - s.trial_generations_used };
  return { k: 'free' };
};

const coverPath = p => p.replace(/\.pdf$/, '.jpg');
const signedCovers = async files => {   // file id -> temporary image address ('' when a file has no cover)
  if (!files.length) return new Map();
  const { data } = await sb.storage.from('slides').createSignedUrls(files.map(f => coverPath(f.storage_path)), 3600);
  return new Map(files.map((f, i) => [f.id, data?.[i]?.signedUrl || '']));
};
const tileBody = (f, cover) => `<span class="scover">${cover ? `<img src="${esc(cover)}" alt="">` : slidesIco()}</span><span class="sname">${esc(f.file_name.replace(/\.pdf$/i, ''))}</span><small>${f.week ? 'Week ' + f.week + ' · ' : ''}${f.page_count} page${f.page_count === 1 ? '' : 's'}</small>`;
let slideDeck = '';   // slideDeck: the deck picked in the Slides tab filter ('' = all)
let slideSel = null;   // Slides tab: a Set of selected file ids while selecting, otherwise null
async function slideCounts() {   // deck name -> number of slide files attached to it
  await ready;
  const name = new Map([...cache.deckId].map(([n, id]) => [id, n])), m = new Map();
  for (const f of chk(await sb.from('slide_files').select('deck_id'))) { const n = name.get(f.deck_id); m.set(n, (m.get(n) || 0) + 1); }
  return m;
}
async function removeSlideFiles(fs) {   // fs: [{ id, path }]; a stored PDF goes too once no deck uses it
  chk(await sb.from('slide_files').delete().in('id', fs.map(f => f.id)));
  for (const p of new Set(fs.map(f => f.path))) {
    const { count } = await sb.from('slide_files').select('id', { count: 'exact', head: true }).eq('storage_path', p);
    if (!count) await sb.storage.from('slides').remove([p, coverPath(p)]);
  }
  await pruneDecks();
}

// explanation: the reason the answer is right, then one line per wrong option. Accepts the new layout (a line per option: "A: ...")
// and older single-paragraph explanations ("B is correct: ... A is wrong because ...")
const explainParts = text => {
  let t = String(text || '').trim(), wrong = [];
  const line = /^\s*([A-H])\s*[:.)]\s+(.+)$/;
  if (/\n/.test(t)) {
    const why = [];
    for (const l of t.split(/\n+/)) { const m = l.match(line); if (m) wrong.push([m[1], m[2].trim().replace(/^./, c => c.toUpperCase())]); else if (l.trim()) why.push(l.trim()); }
    t = why.join(' ');
  } else {
    const bits = t.split(/\s+(?=[A-H] is (?:wrong|incorrect)\b)/);
    if (bits.length > 1) {
      t = bits.shift();
      for (const b of bits) { const m = b.match(/^([A-H]) is (?:wrong|incorrect)\s*(?:because|as|since|:)?\s*(.+)$/is); if (m) wrong.push([m[1], m[2].charAt(0).toUpperCase() + m[2].slice(1)]); else t += ' ' + b; }
    }
  }
  t = t.replace(/^\s*(?:the\s+)?(?:correct\s+answer\s+is\s+)?[A-H]\s+is\s+correct\s*[:,.\-–]?\s*/i, '').replace(/^\s*correct\s*[:\-–]\s*/i, '');
  return { why: t.charAt(0).toUpperCase() + t.slice(1), wrong };
};
const oexHtml = (c, i) => {   // shown under an option once answered: why the right one is right, why each other one is wrong
  if (!c.explanation) return '';
  const { why, wrong } = explainParts(c.explanation), t = i === c.answer ? why : wrong.find(([k]) => k === 'ABCDEFGH'[i])?.[1];
  return t ? `<div class="fbe oex">${esc(t)}</div>` : '';
};

// ---- the source slide next to a question (AI questions keep card.sources = [{ file_id, page }]) ----
let slideMode = 'after';   // off | before (until you answer) | after (once you have answered) | both
try { slideMode = localStorage.getItem('slidemode') || 'after'; } catch {}
let slideFileMap;
const loadSlideFiles = async () => slideFileMap = new Map(chk(await sb.from('slide_files').select('id,file_name,storage_path,deck_id')).map(f => [f.id, f]));
const slideFile = async id => (slideFileMap?.has(id) ? slideFileMap : await loadSlideFiles()).get(id);
const slideDocs = new Map();   // file id -> opened pdf, kept for the session; pdf.js fetches only the pages it needs
const slideDoc = id => {
  if (!slideDocs.has(id)) slideDocs.set(id, (async () => {
    const f = await slideFile(id);
    if (!f) throw new Error('missing file');
    const { data, error } = await sb.storage.from('slides').createSignedUrl(f.storage_path, 3600);
    if (error) throw error;
    await loadPdfjs();
    return pdfjsLib.getDocument({ url: data.signedUrl }).promise;
  })().catch(e => { slideDocs.delete(id); throw e; }));
  return slideDocs.get(id);
};
const cardSlides = c => {
  const own = (Array.isArray(c.sources) ? c.sources : []).filter(x => x?.file_id && x.page > 0);
  const pages = c.slides?.length ? c.slides : c.slide > 0 ? [c.slide] : [];
  if (own.length || !pages.length) return own;
  // imported JSON has only "slide" (a page number) and maybe "file": link it to the PDF attached to the same deck
  const name = String(c.file || '').toLowerCase().replace(/\.pdf$/, '');
  const pick = (list, nm) => (name && list.find(x => nm(x).toLowerCase().includes(name))) || (list.length === 1 ? list[0] : null);
  const did = cache.deckId.get(c.deck), f = pick([...(slideFileMap?.values() || [])].filter(f => f.deck_id === did), f => f.file_name);
  return f ? pages.map(page => ({ file_id: f.id, page })) : [];
};
async function enlargeSlide(x, title) {   // tap the slide beside a question: the same viewer as "View slide", opened at that page, with back / forward through the whole PDF
  const o = document.createElement('div');
  o.className = 'pdfv';
  o.innerHTML = `<div class="pbar"><button class="x" id="pc" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button><div class="ptitle"></div></div>
    <div class="pstage"><canvas id="pcv"></canvas><div class="pmsg" id="pm">Opening slides…</div></div>
    <div class="pnav"><button id="pp" aria-label="Previous slide">‹</button><span id="pn">–</span><button id="pnx" aria-label="Next slide">›</button></div>`;
  o.querySelector('.ptitle').textContent = title || '';
  document.body.appendChild(o);
  const q = s => o.querySelector(s);
  let doc, cur = x.page, tok = 0, task;
  const onKey = e => {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' || e.key === ' ') go(1); else if (e.key === 'ArrowLeft') go(-1);
  };
  const close = () => { document.removeEventListener('keydown', onKey, true); removeEventListener('resize', draw); task?.cancel?.(); o.remove(); };   // the pdf stays open: it is shared with the question panel
  document.addEventListener('keydown', onKey, true);
  q('#pc').onclick = close;
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
    doc = await slideDoc(x.file_id);
    cur = Math.min(doc.numPages, Math.max(1, cur));
    await draw();
  } catch {
    q('#pm').textContent = "Couldn't open these slides.";
  }
}
function showSlide(el, c) {   // the card's source slide beside the question; the arrows page through the whole PDF, tapping opens the full viewer
  const refs = cardSlides(c), x = refs[0], pages = refs.filter(r => r.file_id === x.file_id).map(r => r.page);
  el.innerHTML = `<div class="spbox"><canvas></canvas><span class="spbadge" hidden></span><div class="spmsg">Loading slide…</div></div>
    ${pages.length > 1 ? `<div class="sprefs"><span>This question comes from slides</span>${pages.map(p => `<button type="button" class="dchip" data-p="${p}">${p}</button>`).join('')}</div>` : ''}
    <div class="spnav"><button class="spp" aria-label="Previous slide">‹</button><span class="splab"></span><button class="spn" aria-label="Next slide">›</button></div>`;
  const cv = el.querySelector('canvas'), msg = el.querySelector('.spmsg'), lab = el.querySelector('.splab'), badge = el.querySelector('.spbadge');
  let page = x.page, tok = 0, task, doc, name = '';
  const draw = async () => {
    const my = ++tok;
    msg.hidden = false; msg.textContent = 'Loading slide…';
    try {
      if (!doc) [name, doc] = await Promise.all([slideFile(x.file_id).then(f => f.file_name), slideDoc(x.file_id)]);
      page = Math.min(doc.numPages, Math.max(1, page));
      const pg = await doc.getPage(page);
      if (my !== tok) return;
      name = name.replace(/\.pdf$/i, '');
      lab.textContent = `${name} · ${page} / ${doc.numPages}`;
      badge.textContent = page; badge.hidden = false;
      el.querySelectorAll('[data-p]').forEach(b => b.classList.toggle('on', +b.dataset.p === page));
      const base = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: (el.clientWidth || 400) / base.width * Math.min(devicePixelRatio || 1, 2) });
      cv.width = vp.width; cv.height = vp.height;
      task?.cancel?.();
      task = pg.render({ canvasContext: cv.getContext('2d'), viewport: vp });
      await task.promise;
      if (my === tok) msg.hidden = true;
    } catch (e) { if (my === tok && e?.name !== 'RenderingCancelledException') msg.textContent = "Couldn't load this slide."; }
  };
  const go = d => { if (!doc) return; const n = Math.min(doc.numPages, Math.max(1, page + d)); if (n !== page) { page = n; draw(); } };
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { page = +b.dataset.p; draw(); });
  el.querySelector('.spp').onclick = () => go(-1);
  el.querySelector('.spn').onclick = () => go(1);
  cv.onclick = () => { if (doc && msg.hidden) enlargeSlide({ ...x, page }, name); };
  draw();
}

// ---- slides in the cloud: PDF goes to private storage, each page's text to the "slides" table (questions are generated from that text) ----
const MAX_CLOUD_PDF = 50 * 1024 * 1024;   // Supabase free-plan upload limit
async function uploadSlides(deckNames, files, say) {
  await loadPdfjs();
  await ensureDecks(deckNames);
  const uid = (await sb.auth.getUser()).data.user.id, notes = [];
  for (const f of files) {
    if (f.size > MAX_CLOUD_PDF) { notes.push(`"${f.name}" is over 50 MB, so it was skipped.`); continue; }
    const doc = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise, pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      say(`${f.name}: reading page ${p} of ${doc.numPages}…`);
      const t = await (await doc.getPage(p)).getTextContent();
      pages.push(t.items.map(i => i.str).join(' ').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim());
    }
    say(`${f.name}: saving…`);
    const path = `${uid}/${crypto.randomUUID()}.pdf`;   // stored once, however many decks it is attached to
    chk(await sb.storage.from('slides').upload(path, f, { contentType: 'application/pdf' }));
    try {   // cover image = first page, stored next to the PDF under the same name with .jpg
      const pg = await doc.getPage(1), w = pg.getViewport({ scale: 1 }).width, vp = pg.getViewport({ scale: 480 / w });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      chk(await sb.storage.from('slides').upload(coverPath(path), await new Promise(r => cv.toBlob(r, 'image/jpeg', .8)), { contentType: 'image/jpeg' }));
    } catch {}   // no cover is fine, the tile shows an icon
    for (const deckName of deckNames) {   // each deck gets its own file row and page text, so each can be read and generated from separately
      const id = crypto.randomUUID();
      chk(await sb.from('slide_files').insert({ id, deck_id: cache.deckId.get(deckName), file_name: f.name, storage_path: path, page_count: doc.numPages }));
      for (const part of chunks(pages.map((body, i) => ({ file_id: id, page: i + 1, body })), 200)) chk(await sb.from('slides').insert(part));
    }
    const blank = pages.filter(t => t.length < 20).length;
    if (blank) notes.push(`${blank} page${blank === 1 ? '' : 's'} in "${f.name}" have almost no text (images only).`);
  }
  return notes;
}
// slides used to be saved only in this browser: move any left over into the account, attached to their deck, then clear them from the device
// ponytail: runs on every start until the device is empty; two tabs open at once could upload a file twice
async function migrateDevicePdfs() {
  let moved = 0;
  for (const k of (await metaKeys()).filter(k => typeof k === 'string' && k.startsWith('pdfs:'))) {
    const deck = k.slice(5);
    let keep = false;
    for (const p of (await deviceMeta(k)) || []) {
      try {
        const data = await pdfGet(pdfKey(deck, p.id));
        if (data && !cache.deckId.has(deck)) { keep = true; continue; }   // its deck is not in the account: leave it
        if (data) {
          const f = new File([data], p.name, { type: 'application/pdf' });
          if (f.size > MAX_CLOUD_PDF) { keep = true; continue; }   // too big for the account: leave it on the device rather than lose it
          await uploadSlides([deck], [f], () => {});
          moved++;
        }
        await pdfDel([pdfKey(deck, p.id)]);
      } catch { return moved; }   // offline or out of space: try again next start
    }
    if (!keep) await deviceMeta(k, true);
  }
  return moved;
}
function uploadDialog(pre = '') {
  const decks = [...new Set([...cache.cards.values()].map(c => c.deck))].sort();   // the decks you see in the Decks tab
  modal(`<h2>Upload slides</h2>
    <label class="btn pickpdf">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/>', 20)} Choose PDFs<input type="file" id="pf" accept="application/pdf,.pdf" multiple hidden></label>
    <p class="pname" id="pname">Pick as many as you like. Up to 50 MB each.</p>
    ${decks.length ? `<p style="margin:14px 0 8px"><b>Attach to which decks?</b> Pick one or more.</p>
      <div class="dpick">${decks.map(d => `<button type="button" class="dchip${d === pre ? ' on' : ''}" data-d="${esc(d)}">${esc(d)}</button>`).join('')}</div>`
      : '<p style="margin:14px 0 0">You have no decks yet. Add a deck first (Decks tab, then +), then come back to attach slides to it.</p>'}
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok" ${decks.length ? '' : 'disabled'}>Upload</button></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s);
    q('#c').onclick = close;
    o.querySelectorAll('.dchip').forEach(b => b.onclick = () => b.classList.toggle('on'));
    q('#pf').onchange = () => { const fs = [...q('#pf').files]; q('#pname').textContent = !fs.length ? 'Pick as many as you like. Up to 50 MB each.' : fs.length === 1 ? `${fs[0].name} (${(fs[0].size / 1048576).toFixed(1)} MB)` : `${fs.length} PDFs selected`; };
    q('#ok').onclick = async () => {
      const picked = [...o.querySelectorAll('.dchip.on')].map(b => b.dataset.d), files = [...q('#pf').files];
      if (!files.length) { q('#er').textContent = 'Choose at least one PDF.'; return; }
      if (!picked.length) { q('#er').textContent = 'Pick at least one deck to attach them to.'; return; }
      q('#ok').disabled = q('#c').disabled = true;
      try {
        const notes = await uploadSlides(picked, files, t => q('#er').textContent = t);
        close(); home(['Slides uploaded.', ...notes].join(' '));
      } catch (e) { q('#ok').disabled = q('#c').disabled = false; q('#er').textContent = 'Upload failed: ' + (e.message || e); }
    };
  });
}
// ---- AI generation: the "generate" Edge Function writes up to 10 questions per call; we call it until we have enough ----
async function callGenerate(body) {
  const { data, error } = await sb.functions.invoke('generate', { body });
  if (!error) return data;
  let m = {}; try { m = await error.context.json(); } catch {}
  throw Object.assign(new Error(m.error || 'Something went wrong. Try again.'), { code: m.code });
}
async function generateDialog(deck) {
  const files = chk(await sb.from('slide_files').select('id,file_name,week,page_count,storage_path').eq('deck_id', cache.deckId.get(deck)).order('file_name'));
  const covers = await signedCovers(files);
  const weeks = [...new Set(files.map(f => f.week).filter(Boolean))].sort((a, b) => a - b);
  modal(`<h2>Generate questions</h2><p>${esc(deck)}. Tap the slides to read. The AI writes hard case-study questions from them, with an explanation for every option.</p>
    <div class="sgrid gfiles">${files.map(f => `<button type="button" class="stile sel" data-fid="${f.id}">${tileBody(f, covers.get(f.id))}</button>`).join('')}</div>
    <div class="gctl">
      ${weeks.length ? `<select class="inp" id="gw"><option value="">Any week</option>${weeks.map(w => `<option value="${w}">Week ${w}</option>`).join('')}</select>` : ''}
      <input class="inp" id="gp1" type="number" min="1" placeholder="From page" disabled><input class="inp" id="gp2" type="number" min="1" placeholder="To page" disabled>
      <select class="inp" id="gn">${[10, 20, 30, 40, 50].map(n => `<option value="${n}" ${n === 30 ? 'selected' : ''}>${n} questions</option>`).join('')}</select>
    </div>
    <p class="pname" style="margin-bottom:12px!important">It reads up to 60 slide pages at a time. For a long deck, pick a week or a page range.</p>
    <div class="row end"><button id="c">Cancel</button><button class="p" id="ok">Generate</button></div><p class="err" id="er"></p>`, (o, close) => {
    const q = s => o.querySelector(s);
    q('#c').onclick = close;
    const picked = () => [...o.querySelectorAll('[data-fid].sel')].map(b => b.dataset.fid);
    const syncRange = () => { const one = picked().length === 1; q('#gp1').disabled = q('#gp2').disabled = !one; if (!one) q('#gp1').value = q('#gp2').value = ''; };
    o.querySelectorAll('[data-fid]').forEach(b => b.onclick = () => { b.classList.toggle('sel'); syncRange(); });
    syncRange();
    q('#ok').onclick = async () => {
      const ids = picked();
      if (!ids.length) { q('#er').textContent = 'Tap at least one slide file.'; return; }
      const count = +q('#gn').value, body = { deck, fileIds: ids, week: +q('#gw')?.value || undefined, fromPage: +q('#gp1').value || undefined, toPage: +q('#gp2').value || undefined };
      q('#ok').disabled = q('#c').disabled = true;
      let added = 0, err = null;
      try {
        while (added < count) {
          q('#er').textContent = added ? `Wrote ${added} of ${count}…` : 'Writing questions… this can take a minute.';
          const n = Math.min(10, count - added), r = await callGenerate({ ...body, count: n });
          added += r.added;
          if (r.added < n) break;   // the slides are used up, or the monthly limit was reached
        }
      } catch (e) { err = e; }
      if (added) { ready = loadAll(); await ready; }   // the function saved them straight to the database; reload so the app sees them
      if (err && !added) {
        q('#ok').disabled = q('#c').disabled = false;
        q('#er').textContent = err.message;
        if (err.code === 'subscribe') { close(); view = 'subscription'; home(err.message); }
        return;
      }
      close();
      home(added ? `Added ${added} question${added === 1 ? '' : 's'} to "${deck}".${err ? ' ' + err.message : ''}` : 'No new questions were written. The slides may not have enough new material.');
    };
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
      q('#c').disabled = true; q('#er').textContent = 'Importing…';
      let msg = await importFile(f, folder);
      if (pdfs.length && lastDeck) {   // the slides go to the account and are attached to this deck
        try { msg += ' ' + ['Slides uploaded.', ...await uploadSlides([lastDeck], pdfs, t => q('#er').textContent = t)].join(' '); }
        catch (err) { msg += ' The slides did not upload: ' + (err.message || err); }
      } else if (pdfs.length) msg += ' The slides were not uploaded because no deck was added. Try again.';
      close();
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
  if (view !== 'slides') slideSel = null;
  const [cards, logs, last, slideN] = await Promise.all([all('cards'), all('logs'), getMeta('lastBackup'), view === 'decks' || view === 'today' ? slideCounts() : new Map()]);
  const now = Date.now(), today = dayKey(now);
  const stale = bkDays && logs.length && (!last || now - last > bkDays * DAY);
  const banner = `${stale ? `<div class="banner"><span>No backup ${last ? 'for ' + Math.floor((now - last) / DAY) + ' days' : 'yet'}.</span><button id="bk">Back up</button></div>` : ''}
    ${msg ? `<div class="msg ${/failed|valid JSON/.test(msg) ? 'err' : ''}">${esc(msg)}</div>` : ''}`;
  const todoOf = cs => cs.filter(c => !c.reps || c.due <= now).length;
  const trash = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 20);
  const delBadge = (attr, v) => editing ? `<span class="del" data-${attr}="${esc(v)}" role="button" aria-label="Delete">${trash}</span>` : '';
  const renBadge = (attr, v) => editing ? `<span class="ren" data-${attr}="${esc(v)}" role="button" aria-label="Rename">${svg('<path d="M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4"/>', 20)}</span>` : '';
  const editBtn = `<button class="edit${editing ? ' on' : ''}" data-act="edit">${editing ? 'Done' : 'Edit'}</button>`;
  const slidesChip = d => { const n = slideN.get(d) || 0; return editing ? '' : `<span class="sl${n ? ' on' : ''}" role="button" data-slides="${esc(d)}" data-n="${n}" aria-label="Slides">${slidesIco()}${n > 1 ? 'Slides · ' + n : n ? 'Slides' : '+ Slides'}</span>`; };
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
    <div class="herow"><section class="hero">
      <div><span class="big">${cnt}</span><span class="lbl">${cnt || !scope.length ? { due: 'questions due', new: 'new questions', wrong: 'to redo' }[mode] : { due: 'all done for today', new: 'no new questions', wrong: 'nothing to redo' }[mode]} ${left}</span><div class="sub">${sDue} due · ${sNew} new · ${streak(logs)} day streak</div>
        <button class="hct${hideCh ? ' on' : ''}" id="hc" aria-pressed="${hideCh}">Hide choices first: ${hideCh ? 'On' : 'Off'}</button></div>
      <div class="sess"><div class="chips">${[['due', 'Due', sDue], ['new', 'New', sNew], ['wrong', 'Wrong', nWrong]].map(([m, l, n]) => `<button class="chip${m === mode ? ' on' : ''}" data-mode="${m}">${l}<small>${n}</small></button>`).join('')}</div>
        <div class="chips">${[10, 20, 30, 40].map(n => `<button class="chip${n === sess ? ' on' : ''}" data-size="${n}">${n}</button>`).join('')}</div>
        ${cnt ? `<button id="all" data-mode="${mode}" data-limit="${sess}" ${folder ? `data-folder="${esc(folder)}"` : ''}>Start ${Math.min(cnt, sess)} question${Math.min(cnt, sess) === 1 ? '' : 's'}</button>` : scope.length ? `<button id="all" data-practice="1" data-limit="${sess}" ${folder ? `data-folder="${esc(folder)}"` : ''}>Practice anyway</button>` : ''}</div>
    </section></div>
    ${list}`;
  } else if (view === 'more') {
    const row = (v, t, d) => `<button class="morerow" data-go="${v}"><span class="mi">${svg(ICONS[v], 28)}</span><span class="mt"><b>${t}</b><small>${d}</small></span><span class="chv">›</span></button>`;
    body = `<h1 class="pt">More</h1><div style="height:20px"></div>${banner}
    <div class="morelist">${row('slides', 'Slides', 'Your uploaded slides, by deck')}${row('generate', 'Generate', 'Write questions from your slides with AI')}${row('community', 'Community', 'Decks shared by other students')}${row('subscription', 'Subscription', 'Your plan and AI usage')}${row('data', 'Data', 'Import decks and back up your progress')}${row('guide', 'Guide', 'How to make decks with AI')}${row('settings', 'Settings', 'Theme, sounds and reminders')}</div>`;
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
    const plat = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop';
    const presets = [0, 10, 20, 30, 50], isCustom = !presets.includes(qCount);
    body = `<h1 class="pt">Guide</h1><p class="tag">make a deck from your material in 3 steps</p><div style="height:18px"></div>${banner}
    <div class="gsteps">
      <section class="card gs"><div class="gn">1</div><div class="gb"><h3>Copy a prompt</h3>
        <div class="gsel">
          <label>Difficulty<select class="inp" id="ptype">${PROMPTS.map((p, i) => `<option value="${i}" ${i === pi ? 'selected' : ''}>${esc(p[0])}</option>`).join('')}</select></label>
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
        <p>Tap <b>Add a deck</b>, choose the .json file and attach your PDF slides in the same window. The deck and its slides are saved to your account, and each question's slide shows beside it after you answer. Importing the same deck again keeps your progress.</p>
        <button class="p" data-act="adddeck">Add a deck</button></div></section>
    </div>
    <p class="gdesc" style="margin:18px 0 0">Everything lives in your account, so there are no folders to set up and no files to keep track of. Sign in on any device and your decks, slides and progress are there.</p>
    <button id="wt" style="margin:22px 0 18px">Replay the app walkthrough</button>
    <h2>Install it as an app</h2>
    <p class="gdesc" style="margin:0 0 14px">Puts ankidote on your home screen and opens it full screen, like any other app. Free, and about a minute.</p>
    <div class="seg2 vtog" style="margin-bottom:14px">${[['ios', 'iPad / iPhone'], ['android', 'Android'], ['desktop', 'Computer']].map(([k, l]) => `<button data-inst="${k}" class="${k === plat ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${[
      ['ios', [[ICONS_I.safari, 'Open in Safari', 'Sign in first'], [ICONS_I.share, 'Tap Share', 'Square with an arrow, by the address bar (or ••• first)'], [ICONS_I.plus, 'Add to Home Screen', 'Scroll the menu to find it'], [ICONS_I.tick, 'Tap Add', 'The ankidote icon is on your home screen']]],
      ['android', [[ICONS_I.safari, 'Open in Chrome', 'Sign in first'], [ICONS_I.dots, 'Tap the ⋮ menu', 'Top corner'], [ICONS_I.plus, 'Install app', 'Or Add to Home screen'], [ICONS_I.tick, 'Confirm', 'The icon appears on your home screen']]],
      ['desktop', [[ICONS_I.safari, 'Open in Chrome or Edge', 'Sign in first'], [ICONS_I.screen, 'Click the install icon', 'Right end of the address bar'], [ICONS_I.tick, 'Install', 'It opens in its own window']]],
    ].map(([k, steps]) => `<div class="istepgrid" data-ipanel="${k}" ${k === plat ? '' : 'hidden'}>${steps.map(([ic, t, d], i) => `<div class="istep"><span class="inum">${i + 1}</span><span class="iico">${svg(ic, 34)}</span><b>${t}</b><small>${d}</small></div>`).join('')}</div>`).join('')}
    <p class="fine" style="margin:14px 0 0">Open it from the new icon. It needs internet, and updates itself when you close it fully and reopen it. To remove it, press and hold the icon.</p>
    <p class="fine">Study a little every day.</p>`;
  } else if (view === 'slides' || view === 'generate') {
    const gen = view === 'generate', locked = gen && !COMING_SOON.generate && planOf((await sb.from('subscriptions').select('*').maybeSingle()).data).k !== 'active';   // AI is for ankidote Pro subscribers
    const files = chk(await sb.from('slide_files').select('id,file_name,week,page_count,storage_path,deck_id').order('file_name'));
    const dn = new Map([...cache.deckId].map(([n, id]) => [id, n])), by = new Map(), covers = await signedCovers(files);
    files.forEach(f => { const n = dn.get(f.deck_id); by.set(n, [...(by.get(n) || []), f]); });
    const del = f => `data-delfile="${f.id}" data-path="${esc(f.storage_path)}" data-name="${esc(f.file_name)}"`;
    const open = f => `data-open="${f.id}" data-path="${esc(f.storage_path)}" data-oname="${esc(f.file_name.replace(/\.pdf$/i, ''))}"`;
    const tiles = fs => `<div class="sgrid">${fs.map(f => `<div class="stile${slideSel?.has(f.id) ? ' sel' : ''}" ${open(f)} role="button" tabindex="0">${tileBody(f, covers.get(f.id))}${slideSel ? '' : `<button class="sx" ${del(f)} aria-label="Remove ${esc(f.file_name)}">${svg(TRASH_PATH, 18)}</button>`}</div>`).join('')}</div>`;
    if (!by.has(slideDeck)) slideDeck = '';   // that deck has no slides any more
    if (!gen) body = `<div class="toprow"><div><h1 class="pt">Slides</h1><p class="tag">${files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') + (slideSel ? ' · tap slides to select them' : ' · tap one to open it') : 'all your uploaded slides, by deck'}</p></div>
      <div class="tbtns">${files.length ? `<button class="edit${slideSel ? ' on' : ''}" data-act="selslides">${slideSel ? 'Done' : 'Select'}</button>` : ''}<button class="p plus" data-act="uploadslides" aria-label="Upload slides">${svg('<path d="M12 5v14M5 12h14"/>', 30)}</button></div></div>${banner}
    ${slideSel ? `<div class="selbar"><span id="selcount"></span><button id="selall">Select all</button><button class="p" id="seldel" disabled>Delete</button></div>` : ''}
    ${by.size ? `<select class="inp" id="sdf" aria-label="Filter by deck" style="margin-bottom:18px"><option value="">All decks</option>${[...by.keys()].map(n => `<option value="${esc(n)}" ${n === slideDeck ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
    ${by.size ? [...by].filter(([n]) => !slideDeck || n === slideDeck).map(([n, fs]) => `<h2 style="margin:18px 0 10px">${esc(n)}</h2>${tiles(fs)}`).join('')
      : '<p class="tag emptynote" style="font-size:18px;max-width:46ch">No slides yet. Tap + to upload a PDF and choose the deck it belongs to.</p>'}`;
    else body = COMING_SOON.generate ? soon('Generate with AI') : locked ? `<div class="toprow"><div><h1 class="pt">Generate with AI</h1><p class="tag">the AI writes the questions for you, right here</p></div></div>${banner}
    <section class="card lockcard"><h2 style="margin:0 0 6px">Subscribe to ${PLAN.name}</h2>
      <p style="margin:0 0 14px">Generating questions with AI is part of ${PLAN.name} (${PLAN.price} a month). Subscribe and the AI will write hard case-study questions from your slides, with an explanation for every option.</p>
      <button class="p" data-go="subscription">See ${PLAN.name}</button>
      <p class="fine" style="margin:14px 0 0">Everything else is free: uploading slides, making decks by hand or importing them, and studying.</p></section>` : `<div class="toprow"><div><h1 class="pt">Generate with AI</h1><p class="tag">the AI writes the questions for you, right here</p></div></div>${banner}
    <section class="card"><p class="gdesc" style="margin:0">Pick a deck, choose which slides to read, and the AI writes hard case-study questions with an explanation for every option. They are added to that deck, ready to study. Nothing to copy, paste or import.</p></section>
    <div style="height:14px"></div>
    ${by.size ? [...by].map(([n, fs]) => `<section class="card gdeck"><div><h2 style="margin:0 0 4px">${esc(n)}</h2><p style="margin:0">${fs.length} file${fs.length === 1 ? '' : 's'} · ${fs.reduce((t, f) => t + (f.page_count || 0), 0)} pages</p></div><button class="p" data-gen="${esc(n)}">Generate questions</button></section>`).join('')
      : '<section class="card"><p style="margin:0 0 14px">No slides yet. Upload your lecture slides first, then come back here.</p><button class="p" data-go="slides">Go to Slides</button></section>'}`;
  } else if (view === 'community') {
    body = `${soon('Community')}<p class="tag" style="font-size:18px;max-width:46ch">Decks shared by other students, ready to add and study.</p>`;
  } else if (view === 'subscription') {
    if (COMING_SOON.subscription) body = soon('Subscription');
    else {
    const [{ data: sub }, { data: us }] = await Promise.all([sb.from('subscriptions').select('*').maybeSingle(), sb.from('usage').select('questions').eq('month', new Date().toISOString().slice(0, 7)).maybeSingle()]);
    const p = planOf(sub), used = us?.questions || 0;
    const status = p.k === 'active' ? `Active until ${p.until.toLocaleDateString()}` : p.k === 'trial' ? `Free trial · ${p.left} day${p.left === 1 ? '' : 's'} left` : 'Free plan';
    const note = p.k === 'active' ? `${used} of ${PLAN.questions} AI questions used this month.`
      : p.k === 'trial' ? `${Math.max(0, p.gens)} of ${TRIAL_GENS} free AI runs left, up to ${TRIAL_PAGES} slide pages each.`
      : 'Your trial has ended. Creating, importing and studying decks is still free. Subscribe to write questions with AI.';
    const tick = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.500 4.500 4.500L19 7.500"/></svg>';
    const pill = p.k === 'active' ? ['Active', 'on'] : p.k === 'trial' ? ['Free trial', 'on'] : ['Free plan', ''];
    const frac = p.k === 'active' ? used / PLAN.questions : p.k === 'trial' ? 1 - Math.max(0, p.gens) / TRIAL_GENS : 0;
    body = `<div class="subpage"><h1 class="pt">Subscription</h1><p class="tag">Pay only for the AI. Everything else is free.</p><div style="height:20px"></div>${banner}
    <section class="card subst"><div class="subrow"><span class="pill ${pill[1]}">${pill[0]}</span><b>${status}</b></div>
      ${p.k === 'free' ? '' : `<div class="meter"><i style="width:${Math.min(100, Math.round(frac * 100))}%;background:var(--acc)"></i></div>`}
      <p>${note}</p></section>
    <section class="card plan"><div class="planh"><div><h2>${PLAN.name}</h2><p>Questions from your own slides, written by AI.</p></div>
        <div class="price"><b>${PLAN.price}</b><small>per month</small></div></div>
      <ul class="feat">${[`Up to ${PLAN.questions} AI questions a month`, 'Hard case-study questions in exam style', 'An explanation for every answer option', 'A link back to the exact slide each question came from'].map(t => `<li>${tick}<span>${t}</span></li>`).join('')}</ul>
      <button class="p" id="subscribe">${p.k === 'active' ? 'Renew or manage' : 'Subscribe'}</button></section>
    <section class="card freecard"><h2>Always free</h2><p>Creating and importing decks, attaching slides, studying, stats and backups never need a plan.</p></section></div>`;
    }
  } else if (view === 'settings') {
    const t = theme(), seg = (v, l) => `<button data-theme-set="${v}" class="${t === v ? 'on' : ''}">${l}</button>`;
    const card = (title, rows) => `<h2>${title}</h2><section class="card" style="padding-top:6px;padding-bottom:6px">${rows}</section>`;
    body = `<h1 class="pt">Settings</h1><div style="height:20px"></div>${banner}
    ${card('Appearance', `
      <div class="set"><div><strong>Mode</strong><p>Light, dark, or follow the iPad.</p></div>
        <div class="seg2">${seg('light', 'Light')}${seg('dark', 'Dark')}${seg('auto', 'Auto')}</div></div>
      <div class="set col"><div><strong>Color theme</strong><p>Pick a palette for the whole app.</p></div>
        <div class="pals">${PALETTES.map(p => `<button class="pal ${p.id === curPalette() ? 'on' : ''}" data-pal="${p.id}" aria-label="${p.label}"><span class="dots"><i style="background:${p.sw[0]}"></i><i style="background:${p.sw[1]}"></i></span>${p.label}</button>`).join('')}</div></div>
      <div class="set"><div><strong>Interface size</strong><p>Zoom the whole app in or out.</p></div>
        <div class="zoomr"><input type="range" id="zm" min="70" max="150" step="5" value="${Math.round(zoomNow() * 100)}" aria-label="Interface size"><b id="zv">${Math.round(zoomNow() * 100)}%</b></div></div>`)}
    ${card('Studying', `
      <div class="set"><div><strong>Slide next to the question</strong><p>Show the slide a question came from, beside the question.</p></div>
        <select class="inp" id="slm" aria-label="Slide next to the question">${[['after', 'After answering'], ['before', 'Before answering'], ['both', 'Before and after'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${v === slideMode ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`)}
    ${card('Sound', `
      <div class="set"><div><strong>Sound effects</strong><p>A soft tick on buttons, a bright chime for correct, a low tone for wrong, and a short fanfare when you finish.</p></div>
        <input type="checkbox" class="tgl" id="snd" ${sound ? 'checked' : ''} aria-label="Sound effects"></div>
      <div class="set"><div><strong>Try the sounds</strong><p>No sound? Turn the volume up and check the device isn't muted (the bell icon in Control Center, or the side switch).</p></div>
        <div class="row" style="flex-wrap:nowrap;flex:none"><button id="t-ok">Correct</button><button id="t-no">Wrong</button></div></div>`)}
    ${card('Backups', `
      <div class="set"><div><strong>Backup reminder</strong><p>How often to nudge you to save a backup copy. Your decks and progress are already saved in your account.</p></div>
        <select class="inp" id="bkd" aria-label="Backup reminder">${[[0, 'Off'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every month']].map(([v, l]) => `<option value="${v}" ${v === bkDays ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`)}
    ${card('Help', `
      <div class="set"><div><strong>App walkthrough</strong><p>A quick tour of what ankidote can do.</p></div>
        <div class="row"><button id="wt">Start</button></div></div>
      <div class="set"><div><strong>Guide</strong><p>How to make decks, add slides and install the app.</p></div>
        <div class="row"><button data-go="guide">Open</button></div></div>`)}
    ${card('Account', `
      <div class="set"><div><strong>Signed in</strong><p>${esc(me?.email || 'Your account')}</p></div>
        <div class="row"><button id="so">Sign out</button></div></div>`)}`;
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
  document.body.classList.toggle('scrolled', $.scrollTop > 6);
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
    if (+x.dataset.n) { slideDeck = d; view = 'slides'; home(); } else uploadDialog(d);   // a deck's slides are listed in the Slides tab; a deck with none gets the upload dialog with the deck picked
  });
  $.querySelectorAll('[data-rendeck],[data-renfolder]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    x.dataset.rendeck ? renameDeckUI(x.dataset.rendeck) : renameFolderUI(x.dataset.renfolder);
  });
  $.querySelectorAll('[data-deldeck]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const d = x.dataset.deldeck, n = cards.filter(c => c.deck === d).length;
    confirmDialog(`Delete "${lectureOf(d)}"?`, `This removes the deck, its ${n} question${n === 1 ? '' : 's'} and its slides, along with your progress on them. A PDF that another deck also uses stays there. This can't be undone.`, 'Delete', async () => { await deleteDeck(d); home(`Deleted "${lectureOf(d)}".`); });
  });
  $.querySelectorAll('[data-delfolder]').forEach(x => x.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const f = x.dataset.delfolder, cs = cards.filter(c => folderOf(c.deck) === f), nd = new Set(cs.map(c => c.deck)).size;
    confirmDialog(`Delete the "${f}" folder?`, nd ? `This removes the folder, its ${nd} deck${nd === 1 ? '' : 's'} and ${cs.length} question${cs.length === 1 ? '' : 's'} and their slides, along with your progress on them. A PDF that another deck also uses stays there. This can't be undone.` : 'This folder is empty, so nothing else is removed.', 'Delete', async () => { await deleteFolder(f); if (folder === f) folder = null; home(`Deleted the "${f}" folder.`); });
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
  if (q('#so')) q('#so').onclick = () => sb.auth.signOut().then(() => location.reload());
  if (q('#cp')) q('#cp').onclick = async e => {
    try { await navigator.clipboard.writeText(promptText(pi)); } catch { const r = document.createRange(); r.selectNodeContents(q('#pr')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy prompt'; }, 1500);
  };
  $.querySelectorAll('[data-inst]').forEach(b => b.onclick = () => { $.querySelectorAll('[data-inst]').forEach(x => x.classList.toggle('on', x === b)); $.querySelectorAll('[data-ipanel]').forEach(p => p.hidden = p.dataset.ipanel !== b.dataset.inst); });
  if (q('#slm')) q('#slm').onchange = e => { slideMode = e.target.value; try { localStorage.setItem('slidemode', slideMode); } catch {} };
  if (q('#bkd')) q('#bkd').onchange = e => { bkDays = +e.target.value; try { localStorage.setItem('bkdays', bkDays); } catch {} };
  if (q('#zm')) {   // applied on release, because zooming while dragging would move the slider out from under the finger
    q('#zm').oninput = e => { q('#zv').textContent = e.target.value + '%'; };
    q('#zm').onchange = e => { const z = e.target.value / 100; try { localStorage.setItem('zoom', z); } catch {} setMeta('zoom', String(z)); document.documentElement.style.zoom = z; fitNav(); };
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
  $.querySelectorAll('[data-act=uploadslides]').forEach(b => b.onclick = uploadDialog);
  if (q('#sdf')) q('#sdf').onchange = e => { slideDeck = e.target.value; slideSel?.clear(); home(); };
  $.querySelectorAll('[data-act=selslides]').forEach(b => b.onclick = () => { slideSel = slideSel ? null : new Set(); home(); });
  const tilesNow = () => [...$.querySelectorAll('[data-open]')];
  const syncSel = () => {
    if (!slideSel) return;
    const n = slideSel.size;
    q('#selcount').textContent = n ? `${n} selected` : 'Nothing selected';
    q('#seldel').disabled = !n; q('#seldel').textContent = n ? `Delete ${n}` : 'Delete';
    q('#selall').textContent = n && n === tilesNow().length ? 'Clear' : 'Select all';
  };
  syncSel();
  if (q('#selall')) q('#selall').onclick = () => { const every = tilesNow().length === slideSel.size; slideSel.clear(); tilesNow().forEach(b => { b.classList.toggle('sel', !every); if (!every) slideSel.add(b.dataset.open); }); syncSel(); };
  if (q('#seldel')) q('#seldel').onclick = () => {
    const picked = tilesNow().filter(b => slideSel.has(b.dataset.open)), n = picked.length;
    confirmDialog(`Remove ${n} slide file${n === 1 ? '' : 's'}?`, 'They are removed from their decks. If another deck uses the same PDF, that deck keeps it. Questions already made from them stay.', 'Remove', async () => {
      await removeSlideFiles(picked.map(b => ({ id: b.dataset.open, path: b.dataset.path })));
      slideSel = null; home(`Removed ${n} slide file${n === 1 ? '' : 's'}.`);
    });
  };
  $.querySelectorAll('[data-open]').forEach(b => b.onclick = e => {
    if (slideSel) { const id = b.dataset.open; slideSel.has(id) ? slideSel.delete(id) : slideSel.add(id); b.classList.toggle('sel'); syncSel(); return; }
    if (!e.target.closest('[data-delfile]')) enlargeSlide({ file_id: b.dataset.open, page: 1 }, b.dataset.oname);
  });
  $.querySelectorAll('[data-gen]').forEach(b => b.onclick = () => generateDialog(b.dataset.gen));
  if (q('#subscribe')) q('#subscribe').onclick = () => modal(`<h2>Subscribe to ${PLAN.name}</h2>
    <p>Online payment isn't ready yet, so for now it's two steps:</p>
    <p><b>1.</b> Send <b>${PLAN.price}</b> by InstaPay to <b>${esc(INSTAPAY)}</b>.</p>
    <p><b>2.</b> Fill in the form so we can find your payment and switch on your plan. Use the same email you sign in with${me?.email ? ` (<b>${esc(me.email)}</b>)` : ''}.</p>
    <div class="row end"><button id="c">Close</button><a class="btn p" href="${esc(PAY_FORM)}" target="_blank" rel="noopener">Open the form</a></div>
    <p class="fine">We switch your plan on by hand after checking the payment, usually within a day.</p>`, (o, close) => o.querySelector('#c').onclick = close);
  $.querySelectorAll('[data-delfile]').forEach(b => b.onclick = () => confirmDialog('Remove these slides?', `"${b.dataset.name}" is removed from this deck. If other decks use it, they keep it. Questions already made from it stay.`, 'Remove', async () => {
    await removeSlideFiles([{ id: b.dataset.delfile, path: b.dataset.path }]);   // attached to other decks too? the stored PDF stays
    home('Slides removed.');
  }));
}

// ---- study ----
// practice = review everything now; never touches the schedule or stats
async function study(sel, practice = false) {
  document.body.classList.add('studying');
  const [cards, logs] = await Promise.all([all('cards'), all('logs'), slideMode === 'off' ? 0 : loadSlideFiles().catch(() => {})]);
  const now = Date.now(), pool = sel?.deck ? cards.filter(c => c.deck === sel.deck) : sel?.folder ? cards.filter(c => folderOf(c.deck) === sel.folder) : cards;
  const wrong = wrongIds(logs), due = pool.filter(c => c.reps && c.due <= now).sort((a, b) => a.due - b.due), fresh = pool.filter(c => !c.reps);
  let queue = practice ? pool.map(c => ({ ...c })).sort(() => Math.random() - .5)
    : sel?.mode === 'due' ? due : sel?.mode === 'new' ? fresh
    : sel?.mode === 'wrong' ? pool.filter(c => wrong.has(c.id)).sort(() => Math.random() - .5) : [...due, ...fresh];
  if (sel?.limit) queue = queue.slice(0, sel.limit);
  lastScreen = null;
  const total = queue.length;
  let prevPct = 0;
  const pinBar = () => $.querySelectorAll('.snav,.sbar').forEach(b => {   // fixed to the screen top/bottom, beside the sidebar; content lines up with the question column (900px at .85 zoom)
    b.style.left = document.getElementById('nav').offsetWidth + 'px'; b.style.paddingInline = '0';
    b.style.paddingInline = Math.max(24, (b.clientWidth - (innerWidth >= 900 && $.querySelector('.split') ? 1275 : 765)) / 2) + 'px';
  });
  window.onresize = pinBar;
  const hist = [];   // questions answered this session, for looking back at
  const next = () => {
    if (!queue.length) { play('done'); burst(innerWidth / 2, innerHeight * .55, 150, 1.5); return home(`${practice ? 'Practice done' : 'Done'}. ${total} question${total === 1 ? '' : 's'} reviewed.`); };
    const c = queue[0], isNew = !c.reps, t0 = Date.now(), hasSlide = slideMode !== 'off' && cardSlides(c).length > 0;
    $.innerHTML = `<div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button>
        <div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">${practice ? 'Practice · ' : ''}${queue.length} left</span><button class="hct2${hideCh ? ' on' : ''}" id="hq" aria-pressed="${hideCh}">Hide choices: ${hideCh ? 'On' : 'Off'}</button></div>
      <div class="page study withslide">
      <div class="kick">${isNew ? 'New question' : practice ? 'Practice' : 'Review'}</div>
      <h2 class="qh">Choose the best answer</h2>
      <div class="qgrid"><div class="qcol"><p class="stem">${esc(c.stem)}</p>
      ${hideCh ? '<button class="p" id="rv" style="width:100%;margin-bottom:14px">Show choices</button>' : ''}
      <div id="opts" ${hideCh ? 'hidden' : ''}>${c.options.map((o, i) => `<button class="opt" data-i="${i}"><b>${'ABCDEFGH'[i] || i + 1}</b><span>${esc(o)}</span></button>`).join('')}</div>
      <p class="kbd">A–E to answer · ${practice ? 'Enter to continue' : '1 Again · 2 Hard · 3 Good · 4 Easy · Enter to continue'}</p></div>
      <aside class="sp"><div id="slot"></div><div id="after"></div></aside></div></div>
      <div class="snav"><button id="sb" aria-label="Previous question" ${hist.length ? '' : 'disabled'}>‹ Back</button><span>Current question</span><button id="sf" aria-label="Skip question" ${queue.length > 1 ? '' : 'disabled'}>Skip ›</button></div>`;
    pinBar();
    const slot = $.querySelector('#slot');
    const setSlide = answered => {
      const study = $.querySelector('.study'), show = hasSlide && (slideMode === 'both' || slideMode === (answered ? 'after' : 'before'));
      // the question sits centered on its own; once answered it slides left and the side panel pops in on the right (the slide, if shown, with the rating buttons under it)
      const toggle = () => { study.classList.toggle('split', show || answered); pinBar(); };
      if (answered && innerWidth >= 900 && document.startViewTransition && !calm()) document.startViewTransition(toggle); else toggle();
      if (!show) slot.innerHTML = ''; else if (!slot.firstChild) showSlide(slot, c);
    };
    setSlide(false);
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
      setSlide(true);
      hist.push({ c, pick, correct }); $.querySelector('#hq').style.display = 'none';
      const bk = $.querySelector('#sb'), nx = $.querySelector('#sf');   // the bottom bar stays: Back looks at the previous question, Next does what the main button does (rate Good / continue)
      bk.disabled = hist.length < 2; bk.onclick = () => review(hist.length - 2);
      nx.textContent = 'Next ›'; nx.setAttribute('aria-label', 'Next question'); nx.disabled = false; nx.onclick = () => $.querySelector('[data-r].p').click();
      if (correct) { const r = b.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 24); }
      $.querySelectorAll('.opt').forEach((x, i) => { x.disabled = true; if (i === c.answer) x.classList.add('ok'); else if (i === pick) x.classList.add('no'); x.insertAdjacentHTML('afterend', oexHtml(c, i)); });
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
        <div class="row rate">${correct && !practice
          ? ['again', 'hard', 'good', 'easy'].map(r => `<button data-r="${r}" ${r === 'good' ? 'class="p"' : ''}>${r}</button>`).join('')
          : `<button data-r="again" class="p">${correct ? 'Continue' : 'Next'}</button>`}</div>
        ${correct && !practice ? '<div class="row"><button id="nxt" class="p" style="width:100%">Next</button></div>' : ''}
        ${practice && !correct ? '<p class="hint">Missed ones come back until you get them right.</p>' : ''}</div>`;
      ($.querySelector('.opt.ok + .oex') || $.querySelector('.fb')).scrollIntoView({ block: 'nearest', behavior: 'smooth' });   // bring the right answer's reason into view (it keeps clear of the bars via scroll-margin)
      $.querySelectorAll('[data-r]').forEach(x => x.onclick = () => rate(x.dataset.r));
      const nxt = $.querySelector('#nxt'); if (nxt) nxt.onclick = () => rate('good');   // Next = Good, the default
    });
  };
  const review = i => {   // read-only look at an answered question; Forward walks back toward the current one, which starts fresh
    const { c, pick, correct } = hist[i], last = i === hist.length - 1;
    $.innerHTML = `<div class="sbar"><button class="x" id="back" aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 28)}</button><div class="prog"><i style="width:${prevPct}%"></i></div><span class="cnt">Looking back</span></div>
      <div class="page study">
      <div class="kick">${correct ? 'You got this right' : 'You got this wrong'}</div>
      <p class="stem">${esc(c.stem)}</p>
      <div id="opts">${c.options.map((o, j) => `<button class="opt ${j === c.answer ? 'ok' : j === pick ? 'no' : ''}" disabled><b>${'ABCDEFGH'[j] || j + 1}</b><span>${esc(o)}</span></button>${oexHtml(c, j)}`).join('')}</div></div>
      <div class="snav"><button id="sb" aria-label="Earlier question" ${i ? '' : 'disabled'}>‹ Back</button><span>${i + 1} of ${hist.length} answered</span><button id="sf" aria-label="${last ? 'Back to current question' : 'Later question'}">${last ? 'Current' : 'Forward'} ›</button></div>`;
    pinBar();
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
  { s: '#cp', v: 'guide', h: 'Make decks with AI', t: 'Pick a difficulty, copy the prompt, give it your slides or notes in Claude or ChatGPT, then import the .json it makes.' },
  { s: '[data-v="data"]', v: 'data', h: 'Data and backups', t: 'Import decks here, and download a backup copy of your progress if you want one. Your decks and progress are already saved in your account.' },
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
      // interface zoom: rects and fixed-position styles can use different units, so measure the ratio with a probe
      const pr = document.createElement('div'); pr.style.cssText = 'position:fixed;left:100px;top:0;width:1px;height:1px'; ov.append(pr);
      const f = pr.getBoundingClientRect().left / 100 || 1; pr.remove();
      const r0 = t?.getBoundingClientRect(), ok = r0 && r0.width > 0, W = innerWidth / f, H = innerHeight / f, w = card.offsetWidth, h = card.offsetHeight;
      const r = ok && { left: r0.left / f, right: r0.right / f, top: r0.top / f, bottom: r0.bottom / f, width: r0.width / f, height: r0.height / f };
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
function signIn() {
  document.getElementById('nav').style.display = 'none';
  $.innerHTML = `<div class="auth">
    <div class="lr" style="margin-bottom:30px"><img class="logo" src="icon-192.png" alt=""><div class="tx"><div class="brand">ankidote</div><p>the antidote to medical exam stress</p></div></div>
    <section class="card acard">
      <h1>Welcome</h1><p class="asub">Sign in to turn your slides into exam-ready questions.</p>
      <button class="gbtn" id="g"><svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.5 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.100 0 24s.9 7.600 2.600 10.800l7.900-6.100z"/><path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.600-5.900c-2.100 1.400-4.900 2.300-8.300 2.300-6.300 0-11.600-4-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z"/></svg>Continue with Google</button>
      <div class="adiv"><span>or</span></div>
      <input class="inp" id="em" type="email" placeholder="Email address" autocomplete="email">
      <button class="p" id="ml" style="width:100%">Email me a sign-in link</button>
      <p id="msg" class="amsg" role="status"></p>
    </section>
    <p class="fine">By continuing you agree to the terms and <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a>. You must be 18 or older.</p></div>`;
  const msg = t => $.querySelector('#msg').textContent = t;
  $.querySelector('#g').onclick = () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
  $.querySelector('#ml').onclick = async () => {
    const email = $.querySelector('#em').value.trim();
    if (!email) return msg('Type your email first.');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    msg(error ? error.message : 'Check your email for the sign-in link.');
  };
}
$.addEventListener('scroll', () => document.body.classList.toggle('scrolled', $.scrollTop > 6), { passive: true });   // phone: shows the bar behind the pinned top buttons
sb.auth.getSession().then(({ data }) => {
  if (!data.session) return signIn();
  me = data.session.user;
  ready = loadAll();
  ready.catch(e => $.innerHTML = `<div class="page"><p>Couldn't load your data: ${esc(e.message)}</p><button onclick="location.reload()">Try again</button></div>`);
  // zoom follows the account; theme.js only reads localStorage, so mirror it there
  ready.then(() => getMeta('zoom')).then(z => { if (z && z !== zoomNow()) { document.documentElement.style.zoom = z; try { localStorage.setItem('zoom', z); } catch {} fitNav(); } }).catch(() => {});
  home(); splash();
  ready.then(migrateDevicePdfs).then(n => { if (n && !document.body.classList.contains('studying')) home(`Moved ${n} slide file${n === 1 ? '' : 's'} from this device into your account.`); }).catch(() => {});
});
