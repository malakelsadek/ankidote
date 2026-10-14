# Prompt for generating Ankidote decks

Attach the lecture (slides/PDF/notes) and paste this:

---

Create single-best-answer (SBA) exam questions from the attached lecture, in the style of UK medical school exams (NGU).

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
}

---

Save the output as a `.json` file, then in Ankidote tap **Import file**.
Re-importing the same deck is safe: existing questions keep their progress.
