import { methodNotAllowed } from "@/lib/api/http";
export { getSpecByPath as GET } from "@/lib/api/spec-routes";
export const runtime = "nodejs";
const allow = "GET, HEAD, OPTIONS";
export function OPTIONS() { return new Response(null, { status: 204, headers: { Allow: allow, "Cache-Control": "private, no-store" } }); }
export function POST() { return methodNotAllowed(allow); }
export function PUT() { return methodNotAllowed(allow); }
export function PATCH() { return methodNotAllowed(allow); }
export function DELETE() { return methodNotAllowed(allow); }
