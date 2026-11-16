import { permanentRedirect } from "next/navigation";

type Query = Record<string, string | string[] | undefined>;

/**
 * The sprint reports moved to Pilotage → Sprint (`report-sprint`): links
 * kept from before (bookmarks, notifications) land on the same report.
 */
export default async function LegacyReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams?: Promise<Query>;
}) {
  const [{ key }, query = {}] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      search.append(name, entry);
    }
  }
  const suffix = search.size > 0 ? `?${search}` : "";
  permanentRedirect(`/b/${encodeURIComponent(key)}/report-sprint${suffix}`);
}
