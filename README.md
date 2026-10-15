# ankidote

**The antidote to medical exam stress.**

ankidote is a small study app that turns lectures into exam-style multiple-choice questions and then makes sure you actually remember them, using the same spaced repetition idea as Anki.

<p align="center">
  <img src="screenshots/today.png" alt="The Today page: questions to study, streak, and folders" width="820">
</p>

## Why I built it

I built this for my sister, who is a medical student. She was using a question bank for her exams and wanted the same thing for her *own* lectures: questions written from the slides she is actually being taught, with the questions she keeps getting wrong coming back until they stick.

So the idea is simple:

1. An AI (Claude or ChatGPT) writes single-best-answer questions from a lecture.
2. ankidote imports them and schedules every question for review.
3. The questions she finds hard come back sooner. The ones she knows come back later.

It started as a test for one person, so it is deliberately small: no accounts, no server, no subscription. Everything is stored on her iPad.

## How it works

### 1. Make questions from a lecture

The **Guide** tab has ready-made prompts (standard SBAs, quick recall, pharmacology, anatomy, hard exam-level, and more). Pick one, choose how many questions you want, copy it, and paste it into an AI together with the lecture. The AI replies with a small file of questions.

### 2. Import them into a folder

Tap **+**, choose a folder, and pick the file. Folders keep decks tidy, for example one folder per subject and one deck per lecture.

<p align="center">
  <img src="screenshots/decks.png" alt="A folder open, showing its decks as stacks of cards" width="820">
</p>

### 3. Study

Pick an answer and you get instant feedback with an explanation. A wrong answer comes back later in the same session. For a right answer you say how it felt (Hard, Good, Easy), and the next review is scheduled accordingly: the better you know it, the longer until you see it again.

<p align="center">
  <img src="screenshots/study.png" alt="Answering a question and seeing the explanation" width="820">
</p>

### 4. See what to focus on

The **Stats** tab shows how much you know, how the last two weeks went, which topics are weakest, which questions you keep missing, and how many reviews are due in the coming days.

<p align="center">
  <img src="screenshots/stats.png" alt="The Stats page" width="820">
</p>

## Works on iPad and iPhone

It is a web app you add to the home screen, so it opens full screen like a normal app and works offline. It adapts to the screen: a sidebar on iPad, a tab bar on iPhone.

<p align="center">
  <img src="screenshots/phone.png" alt="ankidote on an iPhone" width="640">
</p>

## Make it yours

Eight colour themes, light and dark mode, optional sound effects, and a backup reminder, all in **Settings**.

<p align="center">
  <img src="screenshots/themes.png" alt="The Settings page with colour themes" width="820">
</p>

## Features

- Questions generated from your own lectures, with a prompt library and a question-count setting
- Anki-style spaced repetition (SM-2) with Hard, Good and Easy ratings
- Folders and decks, with a plus button to add either
- Practice mode to drill everything again without affecting your schedule
- Stats focused on what to do next: progress, accuracy, weak topics, upcoming reviews
- Streak counter, sound effects, 8 colour themes, light and dark mode
- Backup and restore, with a reminder on a schedule you choose (weekly by default)
- Works offline. No account, no server, no tracking.

## Your data

Everything lives in the browser storage on the device, so nothing is sent anywhere. That also means it is only on that device: use **Data → Export backup** now and then and save the file to Files or iCloud Drive. Importing a backup restores everything.

## Install on an iPad or iPhone

1. Open the app link in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open it from the new icon from then on.

## Running it yourself

It is plain HTML, CSS and JavaScript with no build step. To try it locally, serve the folder with any static server, for example `python -m http.server`, and open `http://localhost:8000`.

To publish it, turn on **GitHub Pages** for this repository (Settings → Pages → Deploy from branch → `main` / root).

## Built with

Plain JavaScript, IndexedDB for storage, a service worker for offline use, and the Web Audio API for the sound effects. No frameworks and no dependencies.
