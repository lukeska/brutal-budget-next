import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../../components/ui/page";

export const Route = createFileRoute("/settings/")({
  component: () => <Page title="Settings">{null}</Page>,
});
