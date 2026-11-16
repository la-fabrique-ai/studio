import type { db } from "@/lib/db";
import { specNodes } from "@/lib/db/schema/domain";
import { DEFAULT_SPEC_FOLDERS } from "@/lib/specs/tree";
import { rankLast } from "@/lib/tree/rank";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Creates the BMAD folders of a new backlog, inside its creation
 * transaction. Free of server-only imports: `pnpm db:seed` runs it too.
 */
export async function seedDefaultSpecFolders(tx: Tx, backlogId: string) {
  let rank: string | null = null;
  const rows = DEFAULT_SPEC_FOLDERS.map((folder) => {
    rank = rankLast(rank);
    return { backlogId, kind: "folder" as const, title: folder, rank };
  });
  await tx.insert(specNodes).values(rows);
}
