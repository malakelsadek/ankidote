# ankidote: progress and to-do

Last updated: 2026-10-17. Nothing below has been pushed to the live site yet (commits are local).

## What's done

### Fixes to the existing app
- [x] Zoom setting is saved (localStorage and the account)
- [x] Walkthrough no longer gets cut off when the interface is zoomed
- [x] Study top bar and bottom bar line up with the question column

### Accounts and setup (Phase 1)
- [x] Supabase project created (Data API on, automatic table exposure off, automatic RLS on)
- [x] Claude API workspace `ankidote` and a key, saved privately (never in the repo)
- [x] Cloudflare site deployed (`ankidote.elsadek-malak.workers.dev`)
- [x] Google login set up (Google Cloud OAuth + Supabase provider)
- [x] Supabase URL and Redirect URLs set

### Backend and app (Phase 2)
- [x] Database tables with per-user security: `supabase/schema.sql`
- [x] Sign-in page (Google, or an emailed link), Sign out in Settings
- [x] Cards, folders, review history and settings now live in the user's account instead of the device
- [x] Slide upload: PDF goes to private storage, each page's text is saved, cover image of page 1 is made
- [x] Generate page with Tiles and List views, week tag per file, remove file
- [x] AI function `generate` (Claude Sonnet 5.5): hard case-study questions, an explanation for every option, source slides recorded per question
- [x] Generate dialog: pick slide files as tiles, week, page range, 10/20/30/40/50 questions (default 30)
- [x] 7-day free trial (2 AI runs, up to 30 pages each), manual features always free
- [x] Paid plan (now named "ankidote Pro"), EGP 500 a month, 400 AI questions a month, Subscription page
- [x] Account (picture and name) in the sidebar above Subscription and Settings

### Changes log
- [x] 2026-10-18: Added the new ideas (question quality, deck creation options, slide links and explainer, community decks, 3 deck options) to "Ideas to plan"
- [x] 2026-10-18: Sound fix in `audioOn`: real silent clip so the mute switch is bypassed, audio unlocks on first tap, restarts after calls/Siri/app switching, rebuilds a stuck audio context, sounds queued one at a time (needs an iPad re-test)
- [x] 2026-10-18: Subtle "pop" sound on button clicks across the interface (respects the Sound effects setting)
- [x] 2026-10-18: App icon now shows next to the "ankidote" title in the sidebar when it is open (it was only shown when minimized)
- [x] 2026-10-18: Sidebar: Account, Subscription, Settings and Minimize are pinned together at the bottom with no gaps between them (the gap was two items both pushing to the bottom)
- [x] 2026-10-18: Planned the Community tab and the three ways to create a deck (AI, community import, manual) in "Ideas to plan" (not built yet)
- [x] 2026-10-21: Added the owner-only dashboard and the slide-before/after/both setting to "Ideas to plan" (not built yet)
- [x] 2026-10-21: Recorded the payments decision (Paymob for the web app, App Store subscriptions later) in the Payments section
- [x] 2026-10-21: Added the motion-graphics idea for the demo video to the Demo video section
- [x] 2026-10-21: Wrote the privacy policy (`privacy.html`) and linked it from the sign-in page; it still has [YOUR FULL NAME] and [CONTACT EMAIL] placeholders to fill in
- [x] 2026-10-21: Added the "add classmates as Google test users" step, and the Supabase free-plan capacity estimate, to the to-do list
- [x] 2026-10-21: Study screen shows the source slide beside the question (AI questions), with a Settings choice: after answering (default), before, both, or off; several source slides get arrows. Needs a test with real AI questions
- [x] 2026-10-21: Plan renamed to "ankidote Pro"; Subscribe now shows the InstaPay payment steps and a link to a form. Still to do: put the real InstaPay address and form link in `INSTAPAY` and `PAY_FORM` in app.js
- [x] 2026-10-21: Redesigned the Subscription page: status pill with a usage bar, one highlighted plan card with a feature list, and an "Always free" card
- [x] 2026-10-21: Fixed the app showing old code after edits: the service worker now always checks the server and takes over straight away (`sw.js`)
- [x] 2026-10-21: Subscription page is now a narrow centered column (max 560px) instead of full width
- [x] 2026-10-21: Sidebar account picture: also reads Google's `picture` field and falls back to the initial letter when the image can't load
- [x] 2026-10-21: Fixed the squeezed question layout: the two-column layout now only applies when a question has a slide (question left, slide right); otherwise it is centered as before
- [x] 2026-10-21: Imported questions with a `slide` page number now link automatically to the PDF uploaded to the same deck (matched by the optional `file` name when a deck has several PDFs); the Guide prompts ask the AI for `slide` and `file`
- [x] 2026-10-21: Added `test-homeostasis-deck.json` (12 questions from the Body Plan and Homeostasis lecture, each with a `slide` page and `file` name) for testing the slide linking
- [x] 2026-10-21: The slide beside the question now also works with PDFs attached on this device (Decks tab, + Slides), not only cloud uploads from the Generate page
- [x] 2026-10-21: Slide beside the question: now sits next to the question from 900px wide (was 1100px), and tapping it opens the same viewer as "View slide" (back / forward through the whole PDF, swipe and arrow keys, X to close)
- [x] 2026-10-21: Small slide beside the question: the ‹ › buttons now page through the whole PDF (they did nothing before), and the "slide appears after you answer" placeholder is gone so nothing shows until you pick a choice (default setting)
- [x] 2026-10-21: Slide number badge in the top-right corner of the small slide beside the question
- [x] 2026-10-21: The question is centered on its own; after you pick a choice it slides to the left and the slide pops in on the right (smooth move where the browser supports it)
- [x] 2026-10-21: More space between the top bar and the "New question" label on the study screen
- [x] 2026-10-21: Guide prompts now ask the AI for an explanation of every wrong option (labelled by letter), and a `slide` number for the correct answer on every question
- [x] 2026-10-21: Removed the Walkthrough button from the sidebar (it is still in Settings)
- [x] 2026-10-21: Guide page rewritten for the cloud app: removed the file-folder setup, added a step for uploading slides, and a detailed "Install it as an app" section (iPad/iPhone, Android, desktop, tips); walkthrough text for the Data step updated
- [x] 2026-10-21: New Slides tab (every uploaded slide file by deck, tiles or list, tap to open in the viewer, upload and remove) and Generate is now its own "Generate with AI" tab (pick a deck, the AI writes the questions into it)
- [x] 2026-10-21: Sidebar order: Stats now sits directly under Study
- [x] 2026-10-21: Generate with AI is only for ankidote Pro subscribers; everyone else sees a message with a button to the Subscription page (the app screen only: the `generate` function still allows free-trial runs until it is changed)
- [x] 2026-10-21: Noted the free trial for Generate with AI as a later task
- [x] 2026-10-21: Generate with AI and the Subscription (ankidote Pro) pages now say "Coming soon". Turn them back on by setting `COMING_SOON` to false in app.js
- [x] 2026-10-21: Slides tab: filter by deck (a dropdown next to Tiles / List)
- [x] 2026-10-21: Slides tab: removed the list view, tiles only (deck filter kept)
- [x] 2026-10-21: Upload slides popup simplified: choose many PDFs, pick one or more existing decks to attach them to (a PDF can sit in several decks; it is stored once), week number removed. Removing a file only deletes the stored PDF when no other deck uses it
- [x] 2026-10-21: Settings tidied into headed sections: Appearance, Studying, Sound, Backups, Help (walkthrough and a Guide link) and Account (shows the signed-in email)
- [x] 2026-10-21: Deleting a deck or folder now also deletes its slide files (they disappear from the Slides tab) and the stored PDF, unless another deck still uses that PDF; the empty deck entry is removed too
- [x] 2026-10-21: Fixed ghost decks ("Test", "Test pdf") in the Upload slides picker: it now lists only decks that have questions, and decks with no questions and no slides are cleaned up automatically on load and when a slide file is removed
- [x] 2026-10-21: Guide: "Install it as an app" is now visual: pick iPad/iPhone, Android or Computer, and see 2-4 picture steps instead of paragraphs (your device is pre-selected)
- [x] 2026-10-21: Guide prompts: replaced the question types with four difficulty levels (Easy, Medium, Difficult, Extremely hard) and rewrote the prompts for each; Medium is the default
- [x] 2026-10-21: A question can refer to several slides: the prompts let the AI give `"slide": [12, 15]`, import keeps the list, and the slide beside the question shows a row of buttons to jump between those slides. Difficult is now the default difficulty in the Guide
- [x] 2026-10-21: Removed the "View slide" button from the answer feedback (the slide beside the question replaces it). Replaced the old test deck with `test-homeostasis-multislide.json` (10 hard questions, 9 using several slides)
- [x] 2026-10-21: Slide beside the question: label now says "This question comes from slides", and the slide-number buttons, back / forward buttons, caption and corner badge are all larger
- [x] 2026-10-21: Explanations are structured: the reason the answer is right, then a tidy list "Why the others are wrong" with a lettered row per option, and the correct letter is no longer repeated. Older single-paragraph explanations are split automatically; the Guide prompts and the multi-slide test deck use the new line-per-option layout
- [x] 2026-10-21: Guide is back to 3 steps: Add a deck now imports the .json and uploads the attached PDFs to your account (cloud) in one go, with progress shown; the separate "Add the slides" step is gone
- [x] 2026-10-21: Filled in the name and contact email in the privacy policy
- [x] 2026-10-21: Added "Managing subscriptions by hand" to this file: columns, how the plan is decided, and SQL to activate, renew, cancel, restart the trial, give back a run, and look people up
- [x] 2026-10-22: Study screen: the reason for the right answer shows under the right option, and the reason for each wrong option under that option, so nothing covers the choices. The popup is now only the verdict and the Again / Hard / Good / Easy buttons
- [x] 2026-10-22: Study screen on a wide screen: after answering, the question slides left and a side panel appears with the slide (when there is one) and the rating buttons under it. On a phone the rating bar stays at the bottom
- [x] 2026-10-22: Study screen: the bottom bar (Back / Next) now stays after you answer; Next does what the main button does (rate Good, or continue after a wrong answer), Back looks at the previous question
- [x] 2026-10-22: After a right answer, a full-width Next button under Again / Hard / Good / Easy (it rates Good), like the Next after a wrong answer
- [x] 2026-10-22: Noted in "Ideas to plan" that the Community tab can share folders and decks
- [x] 2026-10-22: Community tab added under Generate (sidebar and More), showing "Coming soon" for now; shared decks are not built yet
- [x] 2026-10-23: On a wide screen (iPad landscape, desktop) the rating card (Well done, Again / Hard / Good / Easy, Next) is pinned to the bottom-right corner above the Back / Next bar, so a thumb reaches it
- [x] 2026-10-23: The click sound on buttons and toggles is a little louder than the first version but soft, with a gentle start and a lower pitch (not sharp); the correct, wrong and finish sounds are unchanged
- [x] 2026-10-23: Pinned rating card: the animated, sticky slide panel was moved off the card's parent (the animation now sits on the slide only) so nothing can hold the card in the page
- [x] 2026-10-23: Added "vibration on tap" to "Ideas to plan"
- [x] 2026-10-23: The pinned rating card is back to the width of the slide column (it had become narrow and square): the side column now runs the full height and the card sticks to its bottom, instead of a fixed-width box
- [x] 2026-10-23: Pinned rating card moved down a little, closer to the Back / Next bar
- [x] 2026-10-23: When the interface is zoomed in so far that the sidebar no longer fits the screen, the extra tabs (Slides, Generate, Community, Data, Guide, Subscription, Settings and the account) fold into a More tab instead of being cut off
- [x] 2026-10-23: The click sound is quieter again (about 40% lower), still a soft pop
- [x] 2026-10-23: Phone layout pass: the answer bar is slim (a small verdict line plus the buttons, no repeated correct-answer text), and after answering the page scrolls so the right answer and its reason sit above the bar instead of under it
- [x] 2026-10-23: Phone layout pass: Guide step numbers sit above the text so the cards use the full width, shorter folder tiles, tighter deck cards and More rows
- [x] 2026-10-23: Phone: the "questions due" card no longer has an empty space beside the big number; the number sits left with the label and summary beside it
- [x] 2026-10-23: Removed the extra Next button under Again / Hard / Good / Easy after a right answer (you pick one of the four); the bottom bar's Back / Next stays
- [x] 2026-10-23: The pink "questions due" card now fills its full width at any screen or interface size (buttons grow to fit, the hide-choices button spans the card on phones)
- [x] 2026-10-23: Settings, Interface size: the percentage no longer runs off the edge of the card (the slider shrinks to fit, and takes the full row on phones)
- [x] 2026-10-23: Settings on a narrow phone: the colour theme tiles no longer stick out past the card
- [x] 2026-10-23: The pink "due" card has one design per width of the card (it follows the interface size too): wide = number and label on the left and a compact button block (max 460px) on the right; narrow = number with its label beside it and every button spanning the card
- [x] 2026-10-23: Phone: the opening splash screen is just the logo (a bit larger); tablet and desktop keep the logo with the name and tagline
- [x] 2026-10-23: Phone: the line under the page title (for example "the antidote to medical exam stress") uses the full width instead of wrapping onto three lines beside the corner buttons
- [x] 2026-10-23: The full-width Next button is back under Again / Hard / Good / Easy after a right answer; Next rates Good (the default), and you can still pick any of the four
- [x] 2026-10-23: Phone: once a page scrolls, a bar appears behind the pinned top buttons (streak, Edit, +) so content no longer shows through them; the "All folders" back button is pinned in that bar too
- [x] 2026-10-23: Phone: the pinned back button, streak and Edit sit on one line, the bar behind them is thinner, and the study screen's bottom bar (Back / label / Next) no longer squeezes its label onto two lines
- [x] 2026-10-23: Phone: the bottom tab bar no longer collapses into a tiny squashed icon cluster when the sidebar was minimized earlier on a bigger screen (the saved Minimize setting was leaking into the phone layout)
- [x] 2026-10-23: Phone: Edit is a few pixels higher than the streak, with the original space between them
- [x] 2026-10-23: Phone: the status bar / browser bar now takes the app's background colour (follows the colour theme and light / dark, updated live); installed-app splash and bar colour default to dark; iOS installed app uses a black status bar. The white strip at the very bottom (Android gesture bar) is set by the phone, see notes
- [x] 2026-10-22: Slides tab: Select button to pick several slide files (tap tiles, Select all / Clear) and delete them in one go
- [x] 2026-10-22: Slides and decks are one thing: all slides go to the account attached to a deck (the old "+ Slides" device-only route is removed, old device PDFs are moved to the account automatically), and renaming a deck keeps its slides (before, the slides stayed under the old name)
- [x] 2026-10-22: Add a deck (also the Guide's step 3) says so when the slides were not uploaded because the deck did not import
- [x] 2026-10-21: Added the device-only slides badge problem, the Testing vs Publish decision and the launch order to "Before the first real users"

### SQL files, run in this order in Supabase (SQL Editor)
1. `supabase/schema.sql`
2. `supabase/002_storage.sql`
3. `supabase/003_usage_grants.sql`
4. `supabase/004_subscriptions.sql`
5. `supabase/005_usage_questions.sql`

## To do next

### Test the AI (needs a few dollars of credit)
- [ ] Redeploy the `generate` function: paste `supabase/functions/generate/index.ts` into the Supabase editor again (it changed to accept several files)
- [ ] Confirm the `ANTHROPIC_API_KEY` secret exists (Edge Functions, Secrets)
- [ ] Add $5 credit in the Claude Console
- [ ] Re-upload any slide uploaded before covers existed (they show an icon, not a cover)
- [ ] Generate 10 questions from a small PDF; if it fails read Edge Functions, generate, Logs
- [ ] Read 20+ generated questions: hard enough? distractors good? explanations correct?
- [ ] Check real cost per question in the Console Usage page (my estimate: about $0.01-0.015); then fix the price and the 400 cap from real numbers
- [ ] Optional: compare Haiku 5.5 vs Sonnet 5.5 on 3 decks (blind), switch the `MODEL` line if Haiku is good enough
- [ ] Test the trial limits (2 runs) and the 400 cap (set `status` to `active` in the `subscriptions` table to test paid)

### Study screen (feature list)
- [ ] After answering, show the explanation for every option (stored in each card's `why`)
- [ ] "View slide" link on a question that opens the exact source page from the cloud PDF (stored in the card's `sources`)
- [ ] Show which slides / deck a question came from in the deck view

### Ideas to plan (added 2026-10-18)
- [ ] Question quality: correct content and format, a quality check, and editing so a wrong question can be corrected
- [ ] Organized ways to create decks: manually, import, or AI
- [ ] Link to the slide plus a better explanation, maybe voice or a character to help explain
- [ ] Vibrations (later): a light buzz on taps, a stronger one for a wrong answer, a short pattern when a session is done, with an on/off setting. `navigator.vibrate` works on Android but not in iOS Safari, so on iPad it would need the Capacitor app (haptics)
- [ ] Community tab (later): share your decks and import other people's decks. People can share whole folders as well as single decks, and the tab shows both. The tab itself is in the app as "Coming soon"
- [ ] Three ways to create a deck, offered in one place: (1) with AI, (2) import a community-shared deck, (3) make one manually
- [ ] Fix sound sometimes not working/bugging (patched 2026-10-18 in `audioOn`; re-test on the iPad, then tick)
- [ ] Owner-only dashboard (not inside the app): who is subscribed / unsubscribed, money coming in, feature requests, member activity
- [ ] Show the source slide before answering, after answering, or both, as a per-user setting
- [ ] Free trial for Generate with AI (later): let trial users generate again. The tab is locked to ankidote Pro subscribers for now (`locked` in the Generate page code); the 7-day trial, its 2 runs and the server limits are still in place, so it mostly means changing that check to also allow `trial`

### Google sign-in screen shows "supabase.co"
This is cosmetic and safe: Google shows the address that receives the login, which is your own Supabase project (`jfvacwoiwmrbplsodlyk.supabase.co`). You don't need to do anything to continue past it. To improve it:
- [ ] **Free improvement:** in Google Cloud, under Google Auth Platform, Branding, set the app name, logo, home page, and privacy-policy and terms links. Then Publish app (Audience, Publish app) so it's no longer in Testing. Google needs a real home page and privacy policy for this, so it waits until you have a domain and those pages. Until the app is published, only listed test users can sign in and logins expire after about 7 days.
- [ ] **For now (until it is published):** add each classmate's Google email as a test user in Google Cloud (Google Auth Platform, Audience, Test users; up to 100). Without this, Google blocks their sign-in. Remember test-user logins expire after about 7 days
- [ ] **Paid fix:** a Supabase custom auth domain (a paid add-on, check the price). The login address would then be your own domain.
- Not certain how much of the Supabase wording the Branding setup hides on its own. The custom domain is the only fix to count on.
- Needs first: your own domain and the privacy policy and terms pages (below)

### Before the first real users
- [ ] Buy a domain and point it at the site
- [x] Privacy policy page (`privacy.html`), linked from the sign-in page. Name and contact email are filled in. Still to do: write the terms page and link it
- [ ] Terms page (18+; AI can be wrong; not medical advice; you own the right to your slides)
- [ ] "Report a bad question" button
- [ ] Supabase Pro (about $25 a month) before real users; check backups are on. Free plan limits (checked 2026-10-21): 1 GB file storage (about 6-10 students with image-heavy lecture PDFs), 5 GB egress a month (every "View slide" downloads the PDF), 500 MB database (enough for dozens of users), projects pause after 1 week of inactivity, no daily backups. Pro: 100 GB storage, 250 GB egress, 8 GB database
- [ ] Spend limit in the Claude Console (start at $100 a month); alert before it runs out
- [ ] Per-deck and account deletion in the app (Apple needs account deletion)
- [ ] Push to the live site: first save an iPad backup (Data, Backup), confirm the live address is in Supabase Redirect URLs and Google JavaScript origins, then sign in on the iPad and import the backup
- [ ] Test with 5-10 classmates for a week
- [ ] Offline study (the app currently needs a connection)
- [x] 2026-10-22: Slides badge on deck tiles now counts the deck's cloud slide files (it used to count PDFs saved only in that browser). Tapping it opens the Slides tab on that deck, or the upload dialog with the deck picked when it has none
- [ ] Decide launch route: stay in Google Testing (add up to 100 test emails by hand, logins expire after about 7 days) or Publish app (needs domain, privacy and terms pages, Branding filled in). Past 100 people, or to skip adding emails, Publish is required
- [ ] Order: domain, terms page, Branding and Publish app, Supabase Pro, Claude spend limit, account deletion, live-site push, 5-10 classmate test, then payments and the App Store

### Payments (EGP)
- Decision (2026-10-21): the web app uses **Paymob** for payments. App Store in-app subscriptions come later, when the app is wrapped for iOS (Apple requires its own billing inside the iOS app)
- [ ] Apply for a Paymob merchant account (ask: what an individual needs, card and wallet fees, saved-card recurring billing, payout time, refunds by API)
- [ ] Build checkout plus a webhook function that sets `status = 'active'` and `current_period_end` after payment
- [ ] Wire the Subscribe button and a Manage/cancel flow
- [ ] Refund and cancellation policy on the site
- Until then: switch testers to `active` by hand in the `subscriptions` table

### Demo video
- [ ] Script (about 60-90 seconds): problem, upload slides, generate, answer with every option explained, open the source slide, stats
- [ ] Record on iPad and desktop with a demo account and slides you have the right to show
- [ ] Idea: have Claude write the motion graphics (intro, title cards, animated callouts, outro) as code, e.g. with Remotion (renders to MP4), and combine them with real screen recordings of the app
- [ ] Captions, 1080p export, unlisted on YouTube/Vimeo, a 15-30 second cut for the App Store preview

### App Store (later)
- [ ] Apple Developer Program ($99 a year)
- [ ] Sign in with Apple (required because Google login is offered)
- [ ] Wrap the web app with Capacitor, test on devices with TestFlight
- [ ] At least one native touch (for example study reminders)
- [ ] Icon, screenshots, description, privacy nutrition labels, in-app purchase for subscriptions
- [ ] Submit and fix whatever review flags

## Managing subscriptions by hand (until payments are automatic)

Each user has one row in the `subscriptions` table (Supabase, Table Editor, or paste the SQL below into the SQL Editor). Replace `person@example.com` with their sign-in email. People can only read their own row, so only you can change these.

**Columns**
- `status`: `trial`, `active` or `canceled`
- `current_period_end`: paid access lasts until this moment
- `trial_ends_at`: when the 7-day free trial ends
- `trial_generations_used`: free AI runs already used (the trial allows 2)
- `provider`: write `manual` when you set it by hand (later `paymob`)

**How the app decides a user's plan**
- **Active:** `status` is `active` AND `current_period_end` is in the future. After that date they are on the free plan, even if `status` still says `active`
- **Trial:** otherwise, if `trial_ends_at` is in the future
- **Free plan:** anything else (decks, slides, studying and stats are always free)
- Changes show up after the user reloads the app

**Find a user, or see everyone**
```sql
select id, email from auth.users where email = 'person@example.com';

select u.email, s.status, s.trial_ends_at, s.trial_generations_used, s.current_period_end, s.provider
from subscriptions s join auth.users u on u.id = s.user_id order by u.email;
```

**Activate (one month from now)**
```sql
update subscriptions
set status = 'active', current_period_end = now() + interval '1 month', provider = 'manual'
where user_id = (select id from auth.users where email = 'person@example.com');
```

**Renew or extend (adds a month to whatever time they have left)**
```sql
update subscriptions
set status = 'active', current_period_end = greatest(coalesce(current_period_end, now()), now()) + interval '1 month', provider = 'manual'
where user_id = (select id from auth.users where email = 'person@example.com');
```

**Cancel**
- To stop them at once: set `status` to `canceled`. They lose paid access immediately
- To let them finish what they paid for: do nothing. Access ends on `current_period_end`
```sql
update subscriptions set status = 'canceled'
where user_id = (select id from auth.users where email = 'person@example.com');
```

**Restart or extend the free trial**
```sql
update subscriptions
set status = 'trial', trial_ends_at = now() + interval '7 days', trial_generations_used = 0
where user_id = (select id from auth.users where email = 'person@example.com');
```

**Give back one free AI run**
```sql
update subscriptions set trial_generations_used = greatest(trial_generations_used - 1, 0)
where user_id = (select id from auth.users where email = 'person@example.com');
```

**Check one person**
```sql
select s.* from subscriptions s join auth.users u on u.id = s.user_id where u.email = 'person@example.com';
```

Notes
- Subscription and Generate with AI currently say "Coming soon" (`COMING_SOON` in app.js), so a status change has no visible effect until those are switched back on
- When the Paymob webhook exists it will set `status = 'active'` and `current_period_end` itself, with `provider = 'paymob'`

## Known limits and notes
- Slides always live in the account and belong to a deck (the database requires a deck). PDFs left on a device from the old manual way are moved into the account on the next start; one over 50 MB stays on the device
- Folders are stored as one settings row (`fm`), not in the `folders` table yet
- The function writes at most 10 questions per call (time limit); the app calls it repeatedly
- It reads at most 60 slide pages per call; image-only slides have no text and are skipped
- Free Supabase uploads are limited to 50 MB per PDF
- Never put the Claude API key, the Supabase `service_role` key or any `#access_token=` address in the repo or in chat
