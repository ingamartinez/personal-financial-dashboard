import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function BudgetsLoading() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </header>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Skeleton className="h-7 w-7" />
          <Skeleton className="mx-2 h-4 w-28" />
          <Skeleton className="h-7 w-7" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      <Card>
        <CardContent className="flex items-center justify-between py-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-40" />
        </CardContent>
      </Card>

      <div className="grid gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-40" />
                <div className="flex gap-1">
                  <Skeleton className="h-7 w-7" />
                  <Skeleton className="h-7 w-7" />
                </div>
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-28" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
