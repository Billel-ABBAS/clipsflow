import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeading } from "@/components/ui/PageHeading";

describe("PageHeading", () => {
  it("renders the shared title hierarchy, description, and actions", () => {
    const markup = renderToStaticMarkup(
      <PageHeading
        eyebrow="STUDIO SHORTS"
        title="24 moments trouvés"
        description="Des extraits à fort potentiel."
        actions={<button type="button">Nouveau projet</button>}
      />,
    );

    expect(markup).toContain("STUDIO SHORTS");
    expect(markup).toContain('<h1 class="font-heading');
    expect(markup).toContain("Des extraits à fort potentiel.");
    expect(markup).toContain("Nouveau projet");
  });

  it("uses the selected panel and centered variants", () => {
    const markup = renderToStaticMarkup(
      <PageHeading
        title="Tarifs ClipsFlow"
        variant="panel"
        alignment="center"
      />,
    );

    expect(markup).toContain("rounded-2xl");
    expect(markup).toContain("text-center");
  });
});
