import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../../components/ui/page";

export const Route = createFileRoute("/accounts/")({
  component: () => <Page title="Accounts">{null}</Page>,
});
