"use client";

import { useState } from "react";
import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { signOutAction } from "@/lib/auth/actions";

type UserMenuProps = {
  user: {
    email: string;
    name: string;
    pictureUrl?: string | null;
  };
};

function initialsFrom(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UserMenu({ user }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const initials = initialsFrom(user.name, user.email);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="User menu"
          className="size-9 cursor-pointer rounded-full"
        >
          {user.pictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.pictureUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="size-8 rounded-full object-cover"
            />
          ) : (
            <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-full text-xs font-medium">
              {initials}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-0">
        <div className="flex items-center gap-3 border-b p-3">
          {user.pictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.pictureUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="size-10 rounded-full object-cover"
            />
          ) : (
            <span className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-full text-sm font-medium">
              {initials}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="text-muted-foreground truncate text-xs">{user.email}</p>
          </div>
        </div>

        <form action={signOutAction}>
          <Button
            type="submit"
            variant="ghost"
            className="h-10 w-full cursor-pointer justify-start gap-2 rounded-none"
          >
            <LogOutIcon className="size-4" />
            Cerrar sesión
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
