import { defineConfig } from "vitest/config";

// Много тестов поднимают настоящий процесс-раннер (tsx, ~0.5–1 с в покое); на загруженной машине 5 с по умолчанию мало
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30_000 } });
