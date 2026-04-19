"use client";

import { useMemo, useState, useTransition } from "react";
import { ArchiveIcon, PencilIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { archiveCategory, createCategory, updateCategory } from "./actions";

export type CategoryRow = {
  id: number;
  slug: string;
  name: string;
  parentSlug: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
};

type FormState = {
  mode: "create" | "edit";
  slug: string;
  name: string;
  parentSlug: string;
  icon: string;
  color: string;
  sortOrder: string;
  // Whether the slug field is editable. Slugs become immutable after
  // creation to protect composite FKs.
  slugLocked: boolean;
};

const EMPTY_FORM: FormState = {
  mode: "create",
  slug: "",
  name: "",
  parentSlug: "",
  icon: "",
  color: "",
  sortOrder: "500",
  slugLocked: false,
};

// Turn "Salsa de Baile" into "salsa-de-baile". Users can still override.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function CategoriesManager({ rows }: { rows: CategoryRow[] }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const roots = useMemo(() => rows.filter((r) => r.parentSlug === null), [rows]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, CategoryRow[]>();
    for (const r of rows) {
      if (r.parentSlug) {
        const list = map.get(r.parentSlug) ?? [];
        list.push(r);
        map.set(r.parentSlug, list);
      }
    }
    return map;
  }, [rows]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setOpen(true);
  }

  function openEdit(row: CategoryRow) {
    setForm({
      mode: "edit",
      slug: row.slug,
      name: row.name,
      parentSlug: row.parentSlug ?? "",
      icon: row.icon ?? "",
      color: row.color ?? "",
      sortOrder: row.sortOrder.toString(),
      slugLocked: true,
    });
    setOpen(true);
  }

  function submit() {
    const payload = {
      slug: form.slug.trim(),
      name: form.name.trim(),
      parentSlug: form.parentSlug.trim() || null,
      icon: form.icon.trim() || null,
      color: form.color.trim() || null,
      sortOrder: Number(form.sortOrder),
    };

    startTransition(async () => {
      const result =
        form.mode === "create" ? await createCategory(payload) : await updateCategory(payload);
      if (result.status === "error") {
        toast.error(result.message);
      } else {
        toast.success(form.mode === "create" ? "Categoría creada" : "Categoría actualizada");
        setOpen(false);
        setForm(EMPTY_FORM);
      }
    });
  }

  function archive(slug: string) {
    if (!confirm("¿Archivar esta categoría?")) return;
    startTransition(async () => {
      const result = await archiveCategory({ slug });
      if (result.status === "blocked") {
        toast.warning(result.reason);
      } else if (result.status === "error") {
        toast.error(result.message);
      } else {
        toast.success("Categoría archivada");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={openCreate} disabled={pending}>
          <PlusIcon className="mr-1 size-4" /> Nueva categoría
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {roots.map((root) => {
          const children = childrenByParent.get(root.slug) ?? [];
          return (
            <Card key={root.id}>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  {root.color && (
                    <span
                      aria-hidden
                      className="size-5 rounded"
                      style={{ background: root.color }}
                    />
                  )}
                  <CardTitle className="text-base">{root.name}</CardTitle>
                  <Badge variant="outline" className="font-mono text-xs">
                    {root.slug}
                  </Badge>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => openEdit(root)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => archive(root.slug)}
                  >
                    <ArchiveIcon className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              {children.length > 0 && (
                <CardContent className="flex flex-wrap gap-2 border-t pt-3">
                  {children.map((c) => (
                    <div
                      key={c.id}
                      className="bg-muted/40 flex items-center gap-2 rounded-full border px-3 py-1 text-sm"
                    >
                      <span>{c.name}</span>
                      <span className="text-muted-foreground font-mono text-xs">{c.slug}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        disabled={pending}
                        onClick={() => openEdit(c)}
                        aria-label={`Editar ${c.name}`}
                      >
                        <PencilIcon className="size-3" />
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={pending}
                        onClick={() => archive(c.slug)}
                        aria-label={`Archivar ${c.name}`}
                      >
                        <ArchiveIcon className="size-3" />
                      </button>
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.mode === "create" ? "Nueva categoría" : "Editar categoría"}
            </DialogTitle>
            <DialogDescription>
              {form.mode === "create"
                ? "El slug se vuelve inmutable una vez creado. Elegilo bien."
                : "El slug no se puede cambiar — es la llave que vincula transacciones, reglas y presupuestos."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="cat-name">Nombre</Label>
              <Input
                id="cat-name"
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({
                    ...f,
                    name,
                    slug: f.slugLocked ? f.slug : slugify(name),
                  }));
                }}
                placeholder="Salsa de Baile"
              />
            </div>
            <div>
              <Label htmlFor="cat-slug">Slug</Label>
              <Input
                id="cat-slug"
                value={form.slug}
                disabled={form.slugLocked}
                onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))}
                placeholder="salsa-de-baile"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="cat-parent">Categoría padre (opcional)</Label>
              <select
                id="cat-parent"
                value={form.parentSlug}
                onChange={(e) => setForm((f) => ({ ...f, parentSlug: e.target.value }))}
                className="border-input bg-background focus:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus:ring-2"
              >
                <option value="">— Ninguna (categoría raíz)</option>
                {roots
                  .filter((r) => r.slug !== form.slug)
                  .map((r) => (
                    <option key={r.id} value={r.slug}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label htmlFor="cat-color">Color hex</Label>
                <Input
                  id="cat-color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  placeholder="#0ea5e9"
                  className="font-mono"
                />
              </div>
              <div className="flex-1">
                <Label htmlFor="cat-icon">Icono (lucide)</Label>
                <Input
                  id="cat-icon"
                  value={form.icon}
                  onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                  placeholder="home"
                />
              </div>
              <div className="w-24">
                <Label htmlFor="cat-order">Orden</Label>
                <Input
                  id="cat-order"
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={pending}>
              {form.mode === "create" ? "Crear" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
