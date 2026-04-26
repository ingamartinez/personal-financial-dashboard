import { StatementUploader } from "@/components/imports/statement-uploader";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Importar extracto — Findash",
};

export default function ImportsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Importar extracto</h1>
        <p className="text-body text-muted-foreground mt-1">
          Subí el PDF mensual de tu cuenta ARQ/DolarApp. Findash parsea las transacciones, verifica
          el balance y las cruza con emails ya ingestados.
        </p>
      </header>

      <StatementUploader />
    </main>
  );
}
