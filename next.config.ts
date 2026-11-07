import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" removed for Netlify compatibility.
  // Netlify's Next.js Runtime handles routing via serverless functions;
  // standalone output (a single server.js for self-hosting) conflicts with
  // that model. The standard Next.js build output (.next/) works on Netlify,
  // Vercel, and self-hosting (via `next start`).
  reactStrictMode: false,
  // Baseline security headers. CSP allows YouTube embeds (landing-page
  // preview + student videos) and the inline styles/scripts Next.js needs.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://s.ytimg.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' https:",
      "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
