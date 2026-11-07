import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../../components/ui/page";

export const Route = createFileRoute("/projects/")({
  component: () => <Page title="Projects">{null}</Page>,
});
