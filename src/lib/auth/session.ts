import { auth } from "@/auth";

export type SessionUser = {
  id: number;
  email: string;
  name: string;
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
  };
}
