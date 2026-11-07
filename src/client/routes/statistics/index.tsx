import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../../components/ui/page";

export const Route = createFileRoute("/statistics/")({
  component: () => <Page title="Statistics">{null}</Page>,
});
