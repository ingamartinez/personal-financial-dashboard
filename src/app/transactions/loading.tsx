import { Skeleton } from "@/components/ui/skeleton";

export default function TransactionsLoading() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
      <header className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-32" />
      </header>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-32" />
        ))}
      </div>

      <div className="overflow-hidden rounded-md border bg-card">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-4 w-full max-w-3xl" />
        </div>
        <div className="flex flex-col divide-y">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[80px_1fr_120px_120px_80px_100px] items-center gap-3 px-4 py-3"
            >
              <Skeleton className="h-3 w-16" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
