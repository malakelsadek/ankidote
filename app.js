const DAY = 864e5, MIN = 6e4, NEW_PER_DAY = 20, BACKUP_EVERY = 7 * DAY;
const $ = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayKey = t => new Date(t).toLocaleDateString('en-CA');

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

async function importFile(file) {
  let d;
  try { d = JSON.parse((await file.text()).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return 'Not valid JSON.'; }
  if (d.backup) {
    if (!confirm('Restore this backup? It replaces everything currently in the app.')) return;
    await clear('cards'); await clear('logs');
    await putMany('cards', d.cards); await putMany('logs', d.logs);
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
  return `"${d.deck}": ${added} new, ${out.length - added} updated (progress kept).`;
}

async function exportAll() {
  const json = JSON.stringify({ backup: 1, cards: await all('cards'), logs: await all('logs') });
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

const PROMPT = `Create single-best-answer (SBA) exam questions from the attached lecture, in the style of UK medical school exams (NGU).

Rules:
- Each question is a short clinical vignette followed by one question, with exactly 5 options and exactly one best answer.
- Test understanding and application, not trivial recall. Distractors must be plausible.
- Only use facts from the lecture. Do not invent content.
- Cover the whole lecture evenly. Aim for about 1 question per key learning point.
- The explanation must say why the answer is right and briefly why the main distractors are wrong.
- "answer" is the zero-based index of the correct option (0 = first option, 4 = fifth). Vary the position of correct answers.

Output ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:

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

// ---- shell / nav ----
let view = 'today', min = false;
try { min = localStorage.getItem('navmin') === '1'; } catch {}
const ICONS = {
  today: '<path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2zM12 6.5v13"/>',
  stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  data: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  chev: '<path d="m15 6-6 6 6 6"/>',
};
const svg = p => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
function renderNav() {
  const nav = document.getElementById('nav');
  nav.className = min ? 'min' : '';
  nav.innerHTML = `<div class="brand">${min ? 'a' : 'ankidote'}</div>`
    + [['today', 'Study'], ['stats', 'Stats'], ['data', 'Data'], ['guide', 'Guide']].map(([v, l]) => `<button class="nv ${v === view ? 'on' : ''}" data-v="${v}" title="${l}">${svg(ICONS[v])}<span>${l}</span></button>`).join('')
    + `<button class="nv tog" id="tog" title="${min ? 'Expand' : 'Minimize'}">${svg(ICONS.chev)}<span>Minimize</span></button>`;
  nav.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { view = b.dataset.v; home(); });
  nav.querySelector('#tog').onclick = () => { min = !min; try { localStorage.setItem('navmin', min ? '1' : '0'); } catch {} renderNav(); };
}

// ---- home ----
async function home(msg = '') {
  onkeydown = null;
  renderNav();
  const [cards, logs, last] = await Promise.all([all('cards'), all('logs'), getMeta('lastBackup')]);
  const now = Date.now(), today = dayKey(now);
  const dueN = cards.filter(c => c.reps && c.due <= now).length;
  const newLeft = Math.max(0, NEW_PER_DAY - logs.filter(l => l.isNew && dayKey(l.t) === today).length);
  const newN = Math.min(newLeft, cards.filter(c => !c.reps).length);
  const reviews = logs.filter(l => !l.isNew);
  const stale = logs.length && (!last || now - last > BACKUP_EVERY);
  const banner = `${stale ? `<div class="banner"><span>No backup ${last ? 'for ' + Math.floor((now - last) / DAY) + ' days' : 'yet'}.</span><button id="bk">Back up</button></div>` : ''}
    ${msg ? `<div class="msg ${/failed|valid JSON/.test(msg) ? 'err' : ''}">${esc(msg)}</div>` : ''}`;
  const tile = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  let body = '';

  if (view === 'today') {
    const decks = [...new Set(cards.map(c => c.deck))].sort();
    body = `<h1 class="pt">Today</h1><p class="tag">the antidote to medical exam stress</p>
    <div style="height:20px"></div>${banner}
    <section class="card hero">
      <div><span class="big">${dueN + newN}</span><span class="lbl">to study today</span><div class="sub">${dueN} due · ${newN} new · ${streak(logs)} day streak</div></div>
      <button class="p" id="all" ${dueN + newN ? '' : 'disabled'}>Study all</button>
    </section>
    <h2>Decks</h2>
    ${decks.length ? `<div class="decks">${decks.map(d => {
      const cs = cards.filter(c => c.deck === d), dl = logs.filter(l => l.deck === d), n = cs.length;
      const mat = cs.filter(c => c.interval >= 21).length, young = cs.filter(c => c.reps && c.interval < 21).length;
      return `<div class="card deckc"><div><span class="n">${esc(d)}</span><small>${n} questions · ${cs.filter(c => c.reps && c.due <= now).length} due · ${cs.filter(c => !c.reps).length} new · ${pct(dl.filter(l => l.correct).length, dl.length)} correct</small><div class="seg"><i style="width:${100 * mat / n}%;background:var(--acc)"></i><i style="width:${100 * young / n}%;background:var(--acc);opacity:.4"></i></div></div><div><button data-deck="${esc(d)}">Study</button></div></div>`;
    }).join('')}</div>` : '<p class="tag">No decks yet. Open the Data tab to import one.</p>'}`;
  } else if (view === 'stats') {
    const fc = Array(14).fill(0);
    cards.filter(c => c.reps).forEach(c => { fc[Math.min(13, Math.max(0, Math.floor((c.due - now) / DAY)))]++; });
    const fmax = Math.max(1, ...fc), wd = i => i ? 'SMTWTFS'[new Date(now + i * DAY).getDay()] : 'T';
    const hard = cards.filter(c => c.lapses).sort((a, b) => b.lapses - a.lapses).slice(0, 5);
    body = `<h1 class="pt">Stats</h1><div style="height:20px"></div>${banner}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${tile(logs.filter(l => dayKey(l.t) === today).length, 'reviewed today')}${tile(pct(logs.filter(l => l.correct).length, logs.length), 'accuracy')}${tile(pct(reviews.filter(l => l.correct).length, reviews.length), 'retention')}
      ${tile(streak(logs), 'day streak')}${tile(cards.filter(c => c.interval >= 21).length, 'mature (21d+)')}${tile(cards.length, 'questions')}${tile(logs.length, 'total reviews')}
    </div>
    <div class="two">
      <div><h2>Due, next 14 days</h2><section class="card"><div class="fc">${fc.map((n, i) => `<div title="${n}"><i style="height:${Math.round(70 * n / fmax)}px"></i><span>${wd(i)}</span></div>`).join('')}</div></section></div>
      <div><h2>Hardest questions</h2><section class="card" style="padding:4px 18px">${hard.length ? hard.map(c => `<div class="hard">${esc(c.stem.length > 110 ? c.stem.slice(0, 110) + '…' : c.stem)}<small>${c.lapses} lapse${c.lapses > 1 ? 's' : ''} · ${esc(c.deck)}</small></div>`).join('') : '<p style="padding:14px 0;margin:0">Nothing yet. Questions you get wrong show up here.</p>'}</section></div>
    </div>`;
  } else if (view === 'guide') {
    const step = (n, t, d) => `<div class="step"><b>${n}</b><div><strong>${t}</strong><p>${d}</p></div></div>`;
    body = `<h1 class="pt">Guide</h1><p class="tag">from lecture to questions in five steps</p><div style="height:20px"></div>${banner}
    <section class="card steps">
      ${step(1, 'Get your lecture', 'Have the lecture slides or notes ready as a PDF, PowerPoint or text.')}
      ${step(2, 'Ask an AI to write the questions', 'Open Claude (or ChatGPT), attach the lecture, then paste the prompt below and send it.')}
      ${step(3, 'Save the answer as a .json file', 'Ask the AI to give the result as a downloadable file. If it only shows text, copy it into Notes or a text editor and save it with a name ending in <b>.json</b>. Code fences around it are fine.')}
      ${step(4, 'Import it', 'Go to <b>Data</b>, tap <b>Import file</b> and pick the file from Files. A message tells you how many questions were added. Importing the same deck again keeps your progress.')}
      ${step(5, 'Study every day', 'Go to <b>Study</b>. Pick an answer and read the explanation. A wrong answer comes back soon in the same session. For a right answer, rate it: <b>Hard</b> (shaky), <b>Good</b>, or <b>Easy</b>. The better you know it, the longer until you see it again.')}
    </section>
    <h2>Prompt for the AI</h2>
    <section class="card"><p>Tap Copy, then paste it into the AI together with your lecture.</p>
      <pre id="pr" class="prompt"></pre>
      <button class="p" id="cp">Copy prompt</button></section>
    <h2>Tips</h2>
    <section class="card tips">
      <p><b>Install it:</b> in Safari tap Share, then Add to Home Screen, and always open ankidote from that icon.</p>
      <p><b>Back up:</b> use Data, then Export backup, and save to Files. Do it weekly. Clearing Safari data erases your progress.</p>
      <p><b>Error on import?</b> The message says which question is wrong. Ask the AI to fix that question and give the full file again.</p>
      <p><b>Limits:</b> up to ${NEW_PER_DAY} new questions a day, so the reviews stay manageable.</p>
    </section>`;
  } else {
    body = `<h1 class="pt">Data</h1><div style="height:20px"></div>${banner}
    <div class="two">
      <section class="card"><h2 style="margin-top:0">Import</h2><p>Add a deck file made with Claude, or restore a backup. Re-importing a deck keeps your progress.</p>
        <label class="btn p">Import file<input id="file" type="file" accept=".json,application/json" hidden></label></section>
      <section class="card"><h2 style="margin-top:0">Backup</h2><p>${last ? 'Last backup: ' + new Date(last).toLocaleDateString() : 'No backup yet.'} Save the file to Files or iCloud Drive.</p>
        <button id="ex">Export backup</button></section>
    </div>`;
  }
  $.innerHTML = `<div class="page">${body}</div>`;

  const q = s => $.querySelector(s);
  if (q('#all')) q('#all').onclick = () => study();
  $.querySelectorAll('[data-deck]').forEach(b => b.onclick = () => study(b.dataset.deck));
  if (q('#pr')) q('#pr').textContent = PROMPT;
  if (q('#cp')) q('#cp').onclick = async e => {
    try { await navigator.clipboard.writeText(PROMPT); } catch { const r = document.createRange(); r.selectNodeContents(q('#pr')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy prompt'; }, 1500);
  };
  if (q('#ex')) q('#ex').onclick = async () => { await exportAll(); home('Backup saved.'); };
  if (q('#bk')) q('#bk').onclick = async () => { await exportAll(); home('Backup saved.'); };
  if (q('#file')) q('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    home(await importFile(f));
  };
}

// ---- study ----
async function study(deck) {
  const [cards, logs] = await Promise.all([all('cards'), all('logs')]);
  const now = Date.now(), pool = deck ? cards.filter(c => c.deck === deck) : cards;
  const newLeft = Math.max(0, NEW_PER_DAY - logs.filter(l => l.isNew && dayKey(l.t) === dayKey(now)).length);
  const queue = [
    ...pool.filter(c => c.reps && c.due <= now).sort((a, b) => a.due - b.due),
    ...pool.filter(c => !c.reps).slice(0, newLeft),
  ];
  const total = queue.length;
  const next = () => {
    if (!queue.length) return home(`Done. ${total} question${total === 1 ? '' : 's'} reviewed.`);
    const c = queue[0], isNew = !c.reps, t0 = Date.now();
    $.innerHTML = `<div class="page">
      <div class="top"><a href="#" id="back">‹ Back</a><span>${queue.length} left</span></div>
      <div class="prog"><i style="width:${Math.max(0, 100 * (1 - queue.length / total))}%"></i></div>
      <p class="stem">${esc(c.stem)}</p>
      <div id="opts">${c.options.map((o, i) => `<button class="opt" data-i="${i}"><b>${'ABCDEFGH'[i] || i + 1}</b><span>${esc(o)}</span></button>`).join('')}</div>
      <div id="after"></div>
      <p class="kbd">A–E to answer · 1 Hard · 2 Good · 3 Easy · Enter to continue</p></div>`;
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
      $.querySelectorAll('.opt').forEach((x, i) => { x.disabled = true; if (i === c.answer) x.classList.add('ok'); else if (i === pick) x.classList.add('no'); });
      const rate = async rating => {
        const was = c.interval, t = Date.now();
        schedule(c, rating, t);
        await putMany('cards', [c]);
        await putMany('logs', [{ id: c.id, deck: c.deck, t, correct, rating, ms, isNew, interval: was }]);
        queue.shift();
        if (rating === 'again' || (rating === 'hard' && !c.interval)) queue.push(c);
        next();
      };
      $.querySelector('#after').innerHTML = `
        ${c.explanation ? `<div class="exp"><strong>Explanation</strong>${esc(c.explanation)}</div>` : ''}
        <div class="row rate">${correct
          ? ['hard', 'good', 'easy'].map(r => `<button data-r="${r}" ${r === 'good' ? 'class="p"' : ''}>${r[0].toUpperCase() + r.slice(1)}</button>`).join('')
          : '<button data-r="again" class="p">Next</button>'}</div>`;
      $.querySelectorAll('[data-r]').forEach(x => x.onclick = () => rate(x.dataset.r));
    });
  };
  next();
}

navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
home();
