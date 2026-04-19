"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArchiveIcon, GripVerticalIcon, PencilIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { ColorPicker } from "@/components/categories/color-picker";
import { CategoryIcon, IconPicker } from "@/components/categories/icon-picker";
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
import { cn } from "@/lib/utils";
import { archiveCategory, createCategory, reorderCategories, updateCategory } from "./actions";

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

  // Server-ordered root slugs. Local state so drag-and-drop can reorder
  // optimistically; we re-sync when the server sends new props.
  const serverRootSlugs = useMemo(
    () => rows.filter((r) => r.parentSlug === null).map((r) => r.slug),
    [rows],
  );
  const [rootOrder, setRootOrder] = useState<string[]>(serverRootSlugs);
  useEffect(() => {
    setRootOrder(serverRootSlugs);
  }, [serverRootSlugs]);

  const rowBySlug = useMemo(() => {
    const map = new Map<string, CategoryRow>();
    for (const r of rows) map.set(r.slug, r);
    return map;
  }, [rows]);

  const orderedRoots = useMemo(
    () => rootOrder.map((slug) => rowBySlug.get(slug)).filter((r): r is CategoryRow => !!r),
    [rootOrder, rowBySlug],
  );

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = rootOrder.indexOf(String(active.id));
    const newIndex = rootOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const next = arrayMove(rootOrder, oldIndex, newIndex);
    setRootOrder(next);

    startTransition(async () => {
      const result = await reorderCategories({ parentSlug: null, slugs: next });
      if (result.status === "error") {
        toast.error(result.message);
        // Revert optimistic order — server rejected the change.
        setRootOrder(rootOrder);
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

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={rootOrder} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-3">
            {orderedRoots.map((root) => (
              <SortableRootCard
                key={root.slug}
                root={root}
                childRows={childrenByParent.get(root.slug) ?? []}
                pending={pending}
                onEdit={openEdit}
                onArchive={archive}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

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
                {orderedRoots
                  .filter((r) => r.slug !== form.slug)
                  .map((r) => (
                    <option key={r.id} value={r.slug}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <Label htmlFor="cat-color">Color</Label>
                <ColorPicker
                  id="cat-color"
                  value={form.color}
                  onChange={(color) => setForm((f) => ({ ...f, color }))}
                />
              </div>
              <div className="flex-1">
                <Label htmlFor="cat-icon">Icono</Label>
                <IconPicker
                  id="cat-icon"
                  value={form.icon}
                  onChange={(icon) => setForm((f) => ({ ...f, icon }))}
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

function SortableRootCard({
  root,
  childRows,
  pending,
  onEdit,
  onArchive,
}: {
  root: CategoryRow;
  childRows: CategoryRow[];
  pending: boolean;
  onEdit: (row: CategoryRow) => void;
  onArchive: (slug: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: root.slug,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "z-10 opacity-80")}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label={`Arrastrar ${root.name}`}
              className="text-muted-foreground hover:text-foreground cursor-grab touch-none active:cursor-grabbing"
              // dnd-kit generates aria-describedby="DndDescribedBy-N" via an
              // internal counter that can differ between SSR and hydration
              // (upstream issue). The attribute is otherwise stable, so we
              // silence the hydration warning on this one element only.
              suppressHydrationWarning
              {...attributes}
              {...listeners}
            >
              <GripVerticalIcon className="size-4" />
            </button>
            {root.color && (
              <span aria-hidden className="size-5 rounded" style={{ background: root.color }} />
            )}
            {root.icon && <CategoryIcon name={root.icon} className="text-muted-foreground" />}
            <CardTitle className="text-base">{root.name}</CardTitle>
            <Badge variant="outline" className="font-mono text-xs">
              {root.slug}
            </Badge>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onEdit(root)}>
              <PencilIcon className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onArchive(root.slug)}
            >
              <ArchiveIcon className="size-4" />
            </Button>
          </div>
        </CardHeader>
        {childRows.length > 0 && (
          <CardContent className="flex flex-wrap gap-2 border-t pt-3">
            {childRows.map((c) => (
              <div
                key={c.id}
                className="bg-muted/40 flex items-center gap-2 rounded-full border px-3 py-1 text-sm"
              >
                {c.icon && <CategoryIcon name={c.icon} className="text-muted-foreground size-3" />}
                <span>{c.name}</span>
                <span className="text-muted-foreground font-mono text-xs">{c.slug}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={pending}
                  onClick={() => onEdit(c)}
                  aria-label={`Editar ${c.name}`}
                >
                  <PencilIcon className="size-3" />
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={pending}
                  onClick={() => onArchive(c.slug)}
                  aria-label={`Archivar ${c.name}`}
                >
                  <ArchiveIcon className="size-3" />
                </button>
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
