import { methodNotAllowed } from "@/lib/api/http";
export { getSpec as GET, patchSpec as PATCH, deleteSpec as DELETE } from "@/lib/api/spec-routes";
export const runtime = "nodejs";
const allow = "GET, PATCH, DELETE, HEAD, OPTIONS";
export function OPTIONS() { return new Response(null, { status: 204, headers: { Allow: allow, "Cache-Control": "private, no-store" } }); }
export function POST() { return methodNotAllowed(allow); }
export function PUT() { return methodNotAllowed(allow); }
