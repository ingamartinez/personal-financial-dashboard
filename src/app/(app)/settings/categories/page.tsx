import { getSessionUser } from "@/lib/auth/session";
import { listUserCategories } from "@/lib/categories/queries";
import { CategoriesManager } from "./categories-manager";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const session = await getSessionUser();
  const rows = await listUserCategories(session.id);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Categorías</h1>
        <p className="text-body text-muted-foreground">
          Tu taxonomía personal. Agregá subcategorías para granularidad, o renombrá las del seed a
          tu gusto. Las categorías archivadas siguen resolviendo transacciones históricas pero salen
          del selector.
        </p>
      </header>
      <CategoriesManager rows={rows} />
    </main>
  );
}
