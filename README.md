# Counter-Rendering TikTok

A small web app that takes the data file TikTok hands you when you ask for an export, and turns it into a readable picture of what the platform was actually keeping on you. Everything runs in your browser; the file never leaves your laptop.

## What this project is trying to show, in plain words

Most of us have a vague sense that apps like TikTok "know" us, but it's hard to feel that in any concrete way. You scroll, the feed gets weirdly accurate, and that's about as far as it goes. This project is an attempt to make that feeling specific.

The idea, borrowed from Shoshana Zuboff, is that platforms don't just record what you do; they *render* it. Your scrolling, pausing, searching, and liking get filtered down into typed, numbered fields a machine can sort. A lot of what made the moment human (why you opened the app, what mood you were in, what you were avoiding) gets dropped on the floor. What's left becomes the raw material for predictions about what you'll do next.

So the app does three things:

1. **Reads your own export.** You drop in the ZIP TikTok gave you. The app parses it locally and pulls out every event it can find: videos watched, searches typed, logins, comments, and so on.
2. **Shows you the rendering happening.** For each row it surfaces what was kept exactly (the text, the timestamp), what got turned into a number (sentiment, intensity), what was inferred from nearby rows (which session it belongs to), and what was thrown away entirely (the *why* of any of it).
3. **Suggests what you can do about it.** Based on the patterns it finds (late-night bursts, repeated searches, drift toward a particular topic), it points you at the actual TikTok settings that would change things. No scrapers, no dark patterns, just the official toggles.

The point isn't to reverse-engineer TikTok's recommender. We can't, and the app is honest about that. The point is to give you a grounded look at the shape of your own archive, so the abstract argument about "surveillance capitalism" has something specific to push against.

## What you'll see in the app

- **Operational rendering**: for each event, a breakdown of which fields were preserved, normalized, inferred, or dropped.
- **Behavioral surplus**: a row-level score that flags interactions where the platform got more out of you than the action seemed to require.
- **Temporal surplus density**: counts of dated events in trailing windows (last hour, last day, last week), so bursts of late-night use or panic-scrolling stand out instead of getting lost in averages.
- **Mitigation suggestions**: concrete pointers to TikTok's own settings, chosen based on what the app actually saw in your data.
- **A downloadable JSON report** of the on-screen interpretation, in case you want to keep a copy or feed it into something else.

## Getting your TikTok data

1. In the TikTok app: **Profile → Menu → Settings and privacy → Account → Download your data**.
2. Pick the categories you want (broader exports give the app more to work with). Choose **JSON** when offered; the nested activity files are easier to parse cleanly.
3. Tap **Request data**, wait for the email, then download the **ZIP** from the same screen.
4. Drop that ZIP into the upload box on the home page.

Official instructions, if you want them straight from TikTok: [Requesting your data](https://support.tiktok.com/en/account-and-privacy/personalized-ads-and-data/requesting-your-data).

A caveat worth keeping in mind: exports vary by region and by how long your account has been active. Treat the results as **partial evidence** of what TikTok stored, not a full window into how its ranking model works.

## Privacy

- Your ZIP is parsed **in the browser**. It is **not** sent to a server in this version.
- The JSON report you can download stays on your machine unless you move it somewhere else.
- For a PDF, use your browser's **Print → Save as PDF** on the results view.

If you fork this and decide to add server-side parsing, please add explicit consent, encryption in transit and at rest, and a real retention policy. The local-only story is the strongest privacy guarantee this codebase offers, and it would be a shame to lose it.

## What it's not doing

- It does **not** claim to know TikTok's actual ranking weights or model internals.
- It does **not** infer your emotional state from your interaction traces. You can self-annotate moods if you want to, but the app won't put feelings in your mouth.
- External datasets (scraped hashtag corpora, public ML training data) are used only as background context or as stress tests for the parser, never as evidence of what *you specifically* were profiled as.

## Research / ML side

The `research/` folder and the Jupyter notebooks (`eda.ipynb`, `preprocessing.ipynb`, `models.ipynb`, `tuning.ipynb`, `ml_notebook.ipynb`) are a parallel track: training and evaluating classifiers on public datasets to study engagement patterns in general. Those models are **not** loaded into the personal-export path of the app, on purpose. The Zuboff framing only stays honest if "what the app shows you about your archive" doesn't get mixed up with "what a learned model guesses about a generic user." See `research/README.md` for more on the split.

## Sources informing the method

- Boeker & Urman (2022), user-centric sock-puppet audit of TikTok personalization factors.
- Zannettou et al. (CHI 2024), data donation analysis of engagement trajectories and recommendation effectiveness proxies.
- Shoshana Zuboff, *The Age of Surveillance Capitalism* (2019), for the theoretical frame.

## Running it locally

Install dependencies, then start the dev server:

```bash
npm run dev
# or yarn dev / pnpm dev / bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The home page is the dashboard; edits to `src/app/page.tsx` and `src/components/DashboardClient.tsx` hot-reload as you save.

## Building for production

```bash
npm run build
```

Deploy to any Next.js host (for example [Vercel](https://vercel.com/new)). Keep parsing on the client unless you have a real reason to move it server-side.
