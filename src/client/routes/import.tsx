import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../components/ui/page";
import { ImportWizard } from "../features/import/ImportWizard";

export const Route = createFileRoute("/import")({
  component: ImportPage,
});

function ImportPage() {
  return (
    <Page title="Import">
      <ImportWizard />
    </Page>
  );
}
