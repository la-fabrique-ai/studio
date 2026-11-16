import { methodNotAllowed } from "@/lib/api/http";
export { getSpecs as GET, postSpec as POST } from "@/lib/api/spec-routes";
export const runtime = "nodejs";
const allow = "GET, POST, HEAD, OPTIONS";
export function OPTIONS() { return new Response(null, { status: 204, headers: { Allow: allow, "Cache-Control": "private, no-store" } }); }
export function PUT() { return methodNotAllowed(allow); }
export function PATCH() { return methodNotAllowed(allow); }
export function DELETE() { return methodNotAllowed(allow); }
