const dev = process.env.NODE_ENV !== "production";

// CSP: Next (app router) вставляет inline-скрипты гидрации, поэтому script-src 'unsafe-inline' (nonce — отдельная задача).
// frame-ancestors: приложение можно встраивать только самому себе и веб-клиентам Telegram (Mini App).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://telegram.org${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  // X-Frame-Options не ставим: он запретил бы Mini App в iframe Telegram; встраивание ограничено frame-ancestors.
];

export default {
  // NEXT_DIST_DIR позволяет собрать проект, не мешая запущенному `next dev` (по умолчанию .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  outputFileTracingIncludes: { "/api/**": ["./db/migrations/**"] },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
