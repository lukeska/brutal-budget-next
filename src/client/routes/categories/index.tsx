import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../../components/ui/page";

export const Route = createFileRoute("/categories/")({
  component: () => <Page title="Categories">{null}</Page>,
});
