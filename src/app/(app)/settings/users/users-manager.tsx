"use client";

import { useTransition } from "react";
import { PowerIcon, PowerOffIcon, ShieldIcon, UserIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setUserActiveAction, setUserRoleAction } from "./actions";

type UserRow = {
  id: number;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: "admin" | "user";
  active: boolean;
  createdAt: string;
};

export function UsersManager({
  users,
  currentUserId,
}: {
  users: UserRow[];
  currentUserId: number;
}) {
  const [pending, startTransition] = useTransition();

  function toggleActive(u: UserRow) {
    const next = !u.active;
    const fd = new FormData();
    fd.set("userId", String(u.id));
    fd.set("active", next ? "true" : "false");
    startTransition(async () => {
      const result = await setUserActiveAction(fd);
      if (result.status === "error") toast.error(result.message);
      else toast.success(next ? `Usuario activado` : `Usuario desactivado`);
    });
  }

  function toggleRole(u: UserRow) {
    const next: "admin" | "user" = u.role === "admin" ? "user" : "admin";
    const fd = new FormData();
    fd.set("userId", String(u.id));
    fd.set("role", next);
    startTransition(async () => {
      const result = await setUserRoleAction(fd);
      if (result.status === "error") toast.error(result.message);
      else toast.success(next === "admin" ? `Promovido a admin` : `Demotado a user`);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {users.map((u) => {
        const isSelf = u.id === currentUserId;
        return (
          <Card key={u.id}>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {u.pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={u.pictureUrl}
                    alt=""
                    className="size-10 rounded-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="bg-muted size-10 rounded-full" />
                )}
                <div className="flex flex-col">
                  <CardTitle className="text-base">
                    {u.name}
                    {isSelf && <span className="text-muted-foreground ml-2 text-xs">(vos)</span>}
                  </CardTitle>
                  <span className="text-muted-foreground text-xs">{u.email}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge>
                <Badge variant={u.active ? "outline" : "destructive"}>
                  {u.active ? "activo" : "inactivo"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                Creado: {new Date(u.createdAt).toLocaleDateString("es-CO")}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => toggleRole(u)}
                >
                  {u.role === "admin" ? (
                    <>
                      <UserIcon className="mr-1 size-4" /> Demotar a user
                    </>
                  ) : (
                    <>
                      <ShieldIcon className="mr-1 size-4" /> Promover a admin
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant={u.active ? "destructive" : "default"}
                  disabled={pending}
                  onClick={() => toggleActive(u)}
                >
                  {u.active ? (
                    <>
                      <PowerOffIcon className="mr-1 size-4" /> Desactivar
                    </>
                  ) : (
                    <>
                      <PowerIcon className="mr-1 size-4" /> Activar
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
