import { auth } from "@/auth";

export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "user";
  active: boolean;
};

export async function getSessionUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    throw new Error("UNAUTHENTICATED");
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? session.user.email,
    role: session.user.role ?? "user",
    active: session.user.active ?? true,
  };
}

export async function getSessionUserOrNull(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return null;
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? session.user.email,
    role: session.user.role ?? "user",
    active: session.user.active ?? true,
  };
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user.role !== "admin") {
    throw new Error("FORBIDDEN");
  }
  return user;
}
