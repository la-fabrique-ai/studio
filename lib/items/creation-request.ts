import { createHash } from "node:crypto";
import { z } from "zod";

export const idempotencyKeySchema = z.string().min(1).max(128);

/** Hash the validated, supplied client fields, before resolution or defaults. */
export function creationRequestHash(input: Record<string, unknown>): string {
  const fields = Object.entries(input)
    .filter(([key, value]) => key !== "idempotencyKey" && value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => [key, key === "labelIds" ? [...new Set(value as string[])].sort() : value]);
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(fields))).digest("hex");
}

export function restIdempotencyKey(header: string | null, body: string | undefined): string | undefined {
  const key = header === null ? body : idempotencyKeySchema.parse(header);
  if (header !== null && body !== undefined && key !== body) {
    throw new z.ZodError([{ code: "custom", path: ["idempotencyKey"], message: "L’en-tête Idempotency-Key et le champ idempotencyKey doivent être identiques." }]);
  }
  return key;
}
