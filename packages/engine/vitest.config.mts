import { defineConfig } from "vitest/config";

// Many tests spawn a real process runner (tsx, ~0.5–1 s idle); on a loaded machine the default 5 s is too little
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30_000 } });
