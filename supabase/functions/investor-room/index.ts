// JSH Investor Room — one private link per investor (11/4)
// Deployed to the jsh-expenses Supabase project as `investor-room` (verify_jwt off: it checks its own access).
//
// Investor actions (by link token, from /investors/#k=<token>):
//   open   { token }                              → the room's content + a visit id; logs the visit
//   event  { token, visit_id, kind, detail? }     → accept | section | doc | video | call | heartbeat
// Owner actions (signed in to JSH with the owner account, Bearer token):
//   admin_list · admin_create · admin_update · admin_detail · admin_content_get · admin_content_save · admin_preview
//
// The room's words and numbers live in public.investor_room, never in the site's public repo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const ORIGINS = [/^https:\/\/(www\.)?jshinnovations\.com$/, /^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/, /^https:\/\/[a-z0-9-]+\.netlify\.app$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.some((r) => r.test(o)) ? o : "https://jshinnovations.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const KINDS = new Set(["accept", "section", "doc", "video", "call", "heartbeat"]);
const HEARTBEAT_MAX = 60; // seconds credited per heartbeat, at most

function newToken(len = 24) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const out: string[] = [];
  const buf = new Uint8Array(len * 2);
  crypto.getRandomValues(buf);
  for (const b of buf) { if (b < 224) out.push(abc[b % 56]); if (out.length === len) break; } // 224 = 4 × 56: no bias
  return out.join("");
}

async function owner(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: m } = await db.from("members").select("role").eq("user_id", data.user.id).maybeSingle();
  return m?.role === "owner" ? data.user : null;
}

function linkState(l: any) {
  if (!l.active) return "off";
  if (l.expires_at && new Date(l.expires_at).getTime() < Date.now()) return "expired";
  return "active";
}

async function content() {
  const { data } = await db.from("investor_room").select("content, updated_at").eq("id", 1).maybeSingle();
  return data?.content || {};
}

Deno.serve(async (req) => {
  const H = cors(req);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = String(b.action || "");

  try {
    // ---------- investor ----------
    if (action === "open" || action === "event") {
      const token = String(b.token || "");
      if (!/^[A-Za-z0-9]{16,64}$/.test(token)) return json({ error: "not_found" }, 404);
      const { data: link } = await db.from("investor_links").select("*").eq("token", token).maybeSingle();
      if (!link) return json({ error: "not_found" }, 404);
      const state = linkState(link);
      if (state !== "active") return json({ error: state }, 410);

      if (action === "open") {
        const ua = (req.headers.get("user-agent") || "").slice(0, 300);
        const { data: v, error } = await db.from("investor_visits").insert({ link_id: link.id, user_agent: ua }).select("id").single();
        if (error) throw error;
        await db.from("investor_events").insert({ link_id: link.id, visit_id: v.id, kind: "open" });
        return json({
          visit_id: v.id,
          investor: { first_name: String(link.name).trim().split(/\s+/)[0], name: link.name, firm: link.firm },
          expires_at: link.expires_at,
          content: await content(),
        });
      }

      const kind = String(b.kind || "");
      if (!KINDS.has(kind)) return json({ error: "Bad event" }, 400);
      const visitId = String(b.visit_id || "");
      const { data: v } = await db.from("investor_visits").select("id, seconds").eq("id", visitId).eq("link_id", link.id).maybeSingle();
      if (!v) return json({ error: "Bad visit" }, 400);
      const now = new Date().toISOString();
      if (kind === "heartbeat") {
        const add = Math.max(0, Math.min(HEARTBEAT_MAX, Math.round(Number(b.detail) || 0)));
        const { error } = await db.rpc("investor_add_seconds", { p_visit: v.id, p_add: add }); // atomic: parallel beats can't overwrite each other
        if (error) throw error;
        return json({ ok: true });
      }
      const detail = b.detail == null ? null : String(b.detail).slice(0, 120);
      if (kind === "section" || kind === "accept") {
        const { data: dup } = await db.from("investor_events").select("id").eq("visit_id", v.id).eq("kind", kind).eq("detail", detail ?? "").limit(1);
        if (dup?.length) return json({ ok: true });
      }
      await db.from("investor_events").insert({ link_id: link.id, visit_id: v.id, kind, detail: detail ?? "" });
      await db.from("investor_visits").update({ last_seen_at: now }).eq("id", v.id);
      if (kind === "call" && !link.call_requested_at) await db.from("investor_links").update({ call_requested_at: now }).eq("id", link.id);
      return json({ ok: true });
    }

    // ---------- owner ----------
    if (!action.startsWith("admin_")) return json({ error: "Not found" }, 404);
    const me = await owner(req);
    if (!me) return json({ error: "Sign in with the JSH owner account" }, 401);

    if (action === "admin_list") {
      const [{ data: links }, { data: visits }, { data: events }] = await Promise.all([
        db.from("investor_links").select("*").order("created_at", { ascending: false }),
        db.from("investor_visits").select("link_id, started_at, last_seen_at, seconds"),
        db.from("investor_events").select("link_id, kind, detail").in("kind", ["section", "doc", "call", "video"]),
      ]);
      const rows = (links || []).map((l: any) => {
        const vs = (visits || []).filter((v: any) => v.link_id === l.id);
        const ev = (events || []).filter((e: any) => e.link_id === l.id);
        return {
          id: l.id, token: l.token, name: l.name, firm: l.firm, email: l.email, note: l.note,
          created_at: l.created_at, expires_at: l.expires_at, state: linkState(l), call_requested_at: l.call_requested_at,
          visits: vs.length,
          seconds: vs.reduce((s: number, v: any) => s + (v.seconds || 0), 0),
          last_seen_at: vs.reduce((m: string | null, v: any) => (!m || v.last_seen_at > m ? v.last_seen_at : m), null),
          sections: [...new Set(ev.filter((e: any) => e.kind === "section").map((e: any) => e.detail))],
          docs: [...new Set(ev.filter((e: any) => e.kind === "doc").map((e: any) => e.detail))],
        };
      });
      return json({ links: rows });
    }

    if (action === "admin_create") {
      const name = String(b.name || "").trim();
      if (!name) return json({ error: "Name is required" }, 400);
      const days = b.expires_days == null || b.expires_days === "" ? null : Number(b.expires_days);
      const expires_at = days && days > 0 ? new Date(Date.now() + days * 864e5).toISOString() : null;
      const { data, error } = await db.from("investor_links").insert({
        token: newToken(), name: name.slice(0, 120),
        firm: b.firm ? String(b.firm).trim().slice(0, 120) : null,
        email: b.email ? String(b.email).trim().slice(0, 200) : null,
        note: b.note ? String(b.note).slice(0, 500) : null,
        expires_at,
      }).select("*").single();
      if (error) throw error;
      return json({ link: data });
    }

    if (action === "admin_update") {
      const patch: Record<string, unknown> = {};
      if (typeof b.active === "boolean") patch.active = b.active;
      if ("expires_days" in b) {
        const days = b.expires_days == null || b.expires_days === "" ? null : Number(b.expires_days);
        patch.expires_at = days && days > 0 ? new Date(Date.now() + days * 864e5).toISOString() : null;
      }
      if (!Object.keys(patch).length) return json({ error: "Nothing to change" }, 400);
      const { data, error } = await db.from("investor_links").update(patch).eq("id", String(b.id || "")).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Not found" }, 404);
      return json({ link: data });
    }

    if (action === "admin_detail") {
      const id = String(b.id || "");
      const [{ data: visits }, { data: events }] = await Promise.all([
        db.from("investor_visits").select("id, started_at, last_seen_at, seconds, user_agent").eq("link_id", id).order("started_at", { ascending: false }).limit(50),
        db.from("investor_events").select("visit_id, kind, detail, at").eq("link_id", id).order("at", { ascending: false }).limit(300),
      ]);
      return json({ visits: visits || [], events: events || [] });
    }

    if (action === "admin_content_get" || action === "admin_preview") {
      const { data } = await db.from("investor_room").select("content, updated_at").eq("id", 1).maybeSingle();
      return json({ content: data?.content || {}, updated_at: data?.updated_at || null });
    }

    if (action === "admin_content_save") {
      const c = b.content;
      if (!c || typeof c !== "object" || Array.isArray(c)) return json({ error: "Content must be a JSON object" }, 400);
      const s = JSON.stringify(c);
      if (s.length > 200_000) return json({ error: "Content is too large" }, 400);
      const { error } = await db.from("investor_room").upsert({ id: 1, content: c, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong" }, 500);
  }
});
