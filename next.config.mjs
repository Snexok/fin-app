export default {
  // NEXT_DIST_DIR позволяет собрать проект, не мешая запущенному `next dev` (по умолчанию .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  outputFileTracingIncludes: { "/api/**": ["./db/migrations/**"] },
};
