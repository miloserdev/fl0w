/**
 * Выполняется один раз при старте сервера Next.js. Здесь поднимается планировщик:
 * опубликованные флоу работают по расписанию независимо от того, открыта ли страница.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getRuntime } = await import("./server/runtime");
  await getRuntime().start();
}
