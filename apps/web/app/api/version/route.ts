export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_KABUTORA_BUILD_ID ?? "development" },
    { headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } },
  );
}
