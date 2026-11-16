import { methodNotAllowed } from "@/lib/api/http";
export { putItemLabel as PUT, deleteItemLabel as DELETE } from "@/lib/api/routes";
export const runtime = "nodejs";
const allow = "PUT, DELETE, OPTIONS";
export function OPTIONS() { return new Response(null, { status: 204, headers: { Allow: allow, "Cache-Control": "private, no-store" } }); }
export function GET() { return methodNotAllowed(allow); }
export function HEAD() { return methodNotAllowed(allow); }
export function POST() { return methodNotAllowed(allow); }
export function PATCH() { return methodNotAllowed(allow); }
