import type { NextConfig } from "next";

/**
 * Next.js config for static-export deployment to GitHub Pages.
 *
 * - `output: 'export'` tells Next.js to generate a fully static site
 *   under ./out on `next build`. There is no server runtime — this is
 *   required for GitHub Pages.
 * - `basePath` and `assetPrefix` are set because the repo is published
 *   at `https://<user>.github.io/tiktok-rendering/` rather than at the
 *   domain root. Both env-gated so `npm run dev` stays at `/`.
 * - `images.unoptimized` because there is no Next image optimizer
 *   available on a static host.
 * - `trailingSlash` keeps asset URLs consistent with GitHub Pages
 *   directory-style routing.
 */
const isProd = process.env.NODE_ENV === "production";
const repoName = "tiktok-rendering";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isProd ? `/${repoName}` : undefined,
  assetPrefix: isProd ? `/${repoName}/` : undefined,
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
