This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## TikTok data export (what this app expects)

1. In the TikTok app: **Profile → Menu → Settings and privacy → Account → Download your data**.
2. Choose the categories you want (broader exports help this tool), and prefer **JSON** when TikTok offers it so nested activity files are easier to parse.
3. Tap **Request data**, wait until the export is ready, then download the **ZIP** from the same screen.
4. Upload that ZIP in the web UI. Parsing runs **in the browser** in this scaffold (no server upload).

Official instructions: [TikTok Support — Requesting your data](https://support.tiktok.com/en/account-and-privacy/personalized-ads-and-data/requesting-your-data).

Exports differ by region and time range; treat results as **partial evidence**, not a complete picture of TikTok’s internal ranking model.

## Privacy / data handling (this scaffold)

- The ZIP is parsed **in the browser**; it is **not** uploaded to an application server in this version.
- You can **download a JSON report** of the on-screen interpretation; that file stays on your machine unless you move it elsewhere.
- For a **PDF**, use your browser’s **Print → Save as PDF** on the results view.

## Features (high level)

- **Operational rendering** and **behavioral surplus** from deterministic row-level feature scoring.
- **Temporal surplus density**: counts how many dated events fall in trailing short windows; surfaces burstiness.
- **Mitigation** suggestions inferred from measured signals and density (official settings first—no scrapers).
- Optional **research/** folder for ML that must stay separate from the personal ZIP story.

## Research methodology boundaries

- Per-user inference outputs rely only on the imported personal export rows plus deterministic feature rules and published thresholds.
- The app does **not** claim access to TikTok proprietary model internals or exact ranking weights.
- External corpora (for example, scraped hashtag datasets) are used only as population/topic context or parser stress tests, not as evidence of what a specific user was inferred to be.
- User mood outcomes can be captured as self-annotations for learning, but the model does not infer emotional state from interaction traces.

## Research references informing the method

- Boeker & Urman (2022), user-centric sock-puppet audit of personalization factors.
- Zannettou et al. (CHI 2024), data donation analysis of engagement trajectories and recommendation effectiveness proxies.

## Shipping

```bash
npm run build
```

Deploy to any Next.js host (for example [Vercel](https://vercel.com/new)). Client-side parsing preserves the strongest privacy story; avoid piping user ZIPs through your server unless you add explicit consent, encryption, and retention policies.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
