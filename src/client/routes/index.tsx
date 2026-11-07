import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main className="p-6 font-numbers text-4xl">Brutal Budget</main>,
});
