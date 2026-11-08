/**
 * Runs once when the Next.js server starts. The scheduler is started here:
 * published flows run on their schedule regardless of whether a page is open.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getRuntime } = await import("./server/runtime");
  await getRuntime().start();
}
