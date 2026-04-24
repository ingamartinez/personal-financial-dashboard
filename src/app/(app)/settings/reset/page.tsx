import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ResetDangerZone } from "./reset-danger-zone";

export const dynamic = "force-dynamic";

export default async function ResetPage() {
  // Auth gate — the action itself also checks, but this keeps the page from
  // rendering for logged-out users.
  await getSessionUser();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-h1">Reset all transactional data</h1>
        <p className="text-body text-muted-foreground">
          Use this when you want to start over with a clean ledger — for example, to re-test a
          different ingestion path. Your accounts, categories, rules, budgets, and integrations stay
          exactly as they are.
        </p>
      </header>

      <Alert>
        <AlertTitle>A snapshot is created automatically</AlertTitle>
        <AlertDescription>
          Before anything is wiped, Findash takes a full snapshot of your current transactional data
          and saves it under{" "}
          <Link href="/settings/snapshots" className="underline">
            Settings → Snapshots
          </Link>
          . If something goes wrong, or you want the data back, you can restore from there.
        </AlertDescription>
      </Alert>

      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-h2">What gets deleted</h2>
        <ul className="text-body text-muted-foreground list-disc space-y-1 pl-5">
          <li>All transactions, statement imports, and consolidation decisions</li>
          <li>Classification corrections and proposed rules</li>
          <li>Recurring-transaction gaps and skipped consolidation cycles</li>
          <li>Ingestion logs and insights reports</li>
          <li>Email receipts (Gmail message dedup state) and account snapshots</li>
          <li>Parser events, canary events, and per-user health snapshots</li>
          <li>
            Gmail ingestion cursor (<code className="font-mono">last_pull_history_id</code>) — so
            you can re-ingest the same messages
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-h2">What stays</h2>
        <ul className="text-body text-muted-foreground list-disc space-y-1 pl-5">
          <li>Your user profile and preferences</li>
          <li>Accounts (balances reset to zero because they derive from the ledger)</li>
          <li>Categories, classification rules, budgets, recurring transactions</li>
          <li>Counterparties and counterparty aliases</li>
          <li>
            Gmail OAuth tokens, Telegram bots, webhook tokens, widget tokens — no reauth needed
          </li>
          <li>Snapshots (including the one this action creates for you)</li>
        </ul>
      </section>

      <ResetDangerZone />
    </main>
  );
}
