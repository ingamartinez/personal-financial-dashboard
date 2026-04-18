import NextAuth, { type DefaultSession } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { copyRuleSeedsToUser } from "@/lib/auth/signup";
import { consumeInviteCode } from "@/lib/invite-codes";
import { clearInviteCookie, readInviteCookie } from "@/lib/invite-codes/cookie";

declare module "next-auth" {
  interface Session {
    user: {
      id: number;
      role: "admin" | "user";
      active: boolean;
    } & Omit<NonNullable<DefaultSession["user"]>, "id">;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: number;
    role?: "admin" | "user";
    active?: boolean;
  }
}

// Keep the JWT import referenced so TS treats the augmentation target as used.
export type { JWT };

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    // When signIn returns false (new user without a consumable invite) we want
    // the user to land back on /signup with a friendly error, not on the
    // default NextAuth error screen.
    error: "/signup",
  },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== "google" || !profile?.email || !profile.sub) {
        return false;
      }
      const email = profile.email;
      const sub = profile.sub;
      const name = profile.name ?? email;
      const pictureUrl = typeof profile.picture === "string" ? profile.picture : null;

      const existing = await db
        .select({ id: users.id, googleSub: users.googleSub })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing.length > 0) {
        const row = existing[0];
        if (row.googleSub && row.googleSub !== sub) {
          return false;
        }
        await db
          .update(users)
          .set({ googleSub: sub, name, pictureUrl, updatedAt: new Date() })
          .where(eq(users.id, row.id));
        // Bootstrap users predate the seeds table — top up any missing rules
        // so every user ends up with the full template regardless of signup
        // timing. The unique index + ON CONFLICT makes this a cheap no-op once
        // a user already owns the full set.
        await copyRuleSeedsToUser(row.id);
        // Existing user re-auth — never consume an invite cookie they may have
        // been carrying; issue spec is explicit about not double-spending.
        await clearInviteCookie();
      } else {
        // New user: require a valid, unconsumed invite. Atomic consumption is
        // the real gate — the cookie-validation on /signup is only a UX hint.
        const pendingCode = await readInviteCookie();
        if (!pendingCode) return false;
        const consumed = await consumeInviteCode(pendingCode);
        if (!consumed) return false;
        const [inserted] = await db
          .insert(users)
          .values({ googleSub: sub, email, name, pictureUrl })
          .returning({ id: users.id });
        await copyRuleSeedsToUser(inserted.id);
        await clearInviteCookie();
      }
      return true;
    },
    async jwt({ token }) {
      // Refresh identity + role + active flag on every request. At 5-user
      // scale one SELECT per request is negligible and keeps deactivation /
      // role changes effective without waiting for a new sign-in.
      if (!token.email) return token;
      const row = await db
        .select({ id: users.id, role: users.role, active: users.active })
        .from(users)
        .where(eq(users.email, token.email))
        .limit(1);
      if (row[0]) {
        token.userId = row[0].id;
        token.role = row[0].role === "admin" ? "admin" : "user";
        token.active = row[0].active;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === "number" && session.user) {
        const u = session.user as {
          id: number;
          role: "admin" | "user";
          active: boolean;
        };
        u.id = token.userId;
        u.role = token.role ?? "user";
        u.active = token.active ?? true;
      }
      return session;
    },
  },
});
