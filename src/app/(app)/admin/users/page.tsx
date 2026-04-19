import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { listAllUsers } from "@/lib/users/queries";
import { UsersManager } from "./users-manager";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();
  const rows = await listAllUsers();
  const users = rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    pictureUrl: u.pictureUrl,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt.toISOString(),
  }));
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Usuarios</h1>
        <p className="text-body text-muted-foreground">
          Gestión de usuarios: promoción/democión de rol y activación/desactivación. Las acciones
          destructivas siempre dejan al menos un admin activo.
        </p>
      </header>
      <UsersManager users={users} currentUserId={session.id} />
    </main>
  );
}
