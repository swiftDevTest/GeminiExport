import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleOAuthCallback } from "../_shared/notion-oauth-callback.ts";

// Gemini Export 的 Notion OAuth 回调。
// Redirect URI: https://acgehhqcgreatcjcefub.supabase.co/functions/v1/notion-oauth-gemini
serve(async (request) => {
  return await handleOAuthCallback(request, "gemini-export");
});
