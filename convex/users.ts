import { v } from "convex/values";
import { internalMutation, query, type QueryCtx } from "./_generated/server";

// Users are synced FROM Clerk (Clerk is the source of truth). The webhook in
// http.ts calls upsertFromClerk / deleteFromClerk; the app reads `me`; and
// admin-only functions call requireAdmin.

/**
 * Require the caller to be a signed-in admin. Looks up the authenticated Clerk
 * user (JWT `sub`) in the users table and checks role === "admin". Throws
 * otherwise. Reusable in both queries and mutations.
 */
export async function requireAdmin(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in.");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
  if (!user || user.role !== "admin") {
    throw new Error("Admin access required.");
  }
  return user;
}

/** The current signed-in user's role for the UI (null when signed out). */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
    return {
      clerkId: identity.subject,
      email: user?.email ?? (identity.email as string | undefined),
      username: user?.username,
      role: user?.role ?? "user",
      // false while the Clerk webhook hasn't created the row yet.
      synced: user !== null,
    };
  },
});

/** Upsert a user from a Clerk user.created / user.updated webhook. */
export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.optional(v.string()),
    username: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("user")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    if (existing) {
      await ctx.db.patch("users", existing._id, {
        email: args.email,
        username: args.username,
        role: args.role,
      });
      return { updated: true };
    }
    await ctx.db.insert("users", args);
    return { inserted: true };
  },
});

/** Remove a user from a Clerk user.deleted webhook. */
export const deleteFromClerk = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    if (existing) await ctx.db.delete("users", existing._id);
    return { deleted: existing !== null };
  },
});
