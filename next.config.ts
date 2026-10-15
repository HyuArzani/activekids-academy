import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" removed for Netlify compatibility.
  // Netlify's Next.js Runtime handles routing via serverless functions;
  // standalone output (a single server.js for self-hosting) conflicts with
  // that model. The standard Next.js build output (.next/) works on Netlify,
  // Vercel, and self-hosting (via `next start`).
  reactStrictMode: false,
};

export default nextConfig;
