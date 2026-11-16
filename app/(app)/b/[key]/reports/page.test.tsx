import { describe, expect, it, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({ permanentRedirect: vi.fn() }));
vi.mock("next/navigation", () => ({ permanentRedirect }));

import LegacyReportsPage from "@/app/(app)/b/[key]/reports/page";

describe("legacy /reports URL", () => {
  it("sends old links to Pilotage → Sprint with their report and sprint", async () => {
    await LegacyReportsPage({
      params: Promise.resolve({ key: "CASS" }),
      searchParams: Promise.resolve({ report: "sprint", sprint: "s-1" }),
    });
    expect(permanentRedirect).toHaveBeenCalledWith("/b/CASS/report-sprint?report=sprint&sprint=s-1");
  });

  it("keeps a bare link bare", async () => {
    permanentRedirect.mockClear();
    await LegacyReportsPage({ params: Promise.resolve({ key: "A B" }) });
    expect(permanentRedirect).toHaveBeenCalledWith("/b/A%20B/report-sprint");
  });
});
