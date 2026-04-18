import NextAuth, { type DefaultSession } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: number;
    } & Omit<NonNullable<DefaultSession["user"]>, "id">;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: number;
  }
}

// Keep the JWT import referenced so TS treats the augmentation target as used.
export type { JWT };

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
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
      } else {
        await db.insert(users).values({ googleSub: sub, email, name, pictureUrl });
      }
      return true;
    },
    async jwt({ token, trigger }) {
      if ((trigger === "signIn" || !token.userId) && token.email) {
        const row = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, token.email))
          .limit(1);
        if (row[0]) {
          token.userId = row[0].id;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === "number" && session.user) {
        (session.user as { id: number }).id = token.userId;
      }
      return session;
    },
  },
});
