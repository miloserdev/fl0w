import { ArrowRightLeft, Box, Clock, Code, Database, Flag, GitFork, GitMerge, Globe, type LucideIcon } from "lucide-react";

// Имена иконок в классах блоков — tabler; здесь сопоставляем с доступными в lucide.
const icons: Record<string, LucideIcon> = {
  database: Database,
  flag: Flag,
  "arrows-shuffle": ArrowRightLeft,
  "git-fork": GitFork,
  "git-merge": GitMerge,
  "world-www": Globe,
  code: Code,
  clock: Clock,
};

export function BlockIcon({ name, className }: { name: string; className?: string }) {
  const Icon = icons[name] ?? Box;
  return <Icon className={className} />;
}
