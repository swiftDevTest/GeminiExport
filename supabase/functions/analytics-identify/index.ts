import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { PRODUCT_SLUG } from "../_shared/plans.ts";
import { ensureProfile, getUserFromRequest, supabaseRest } from "../_shared/supabase.ts";

const GUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return emptyResponseForRequest(request, isAllowedBrowserOrigin(request) ? 204 : 403);
  }
  if (request.method !== "POST") {
    return errorResponseForRequest(request, "Method not allowed.", 405);
  }
  if (!isAllowedBrowserOrigin(request)) {
    return errorResponseForRequest(request, "Origin is not allowed.", 403);
  }

  try {
    const user = await getUserFromRequest(request);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const guestId = String(body.guest_id || "").trim();
    if (!GUEST_ID_PATTERN.test(guestId)) {
      return errorResponseForRequest(request, "guest_id is invalid.", 400);
    }

    await ensureProfile(user);

    // 检查 guest_id 是否已绑定到其他 user_id
    const existingIdentity = await supabaseRest<Record<string, unknown>[]>(
      `analytics_identities?guest_id=eq.${encodeURIComponent(guestId)}&user_id=not.eq.${encodeURIComponent(user.id)}&limit=1`
    );
    if (existingIdentity && Array.isArray(existingIdentity) && existingIdentity.length > 0) {
      return errorResponseForRequest(request, "guest_id already bound to another user", 409);
    }

    await supabaseRest("analytics_identities?on_conflict=guest_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        guest_id: guestId,
        user_id: user.id,
        product_slug: PRODUCT_SLUG
      }
    });

    return jsonResponseForRequest(request, { ok: true });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Analytics identify failed.", 500);
  }
});
