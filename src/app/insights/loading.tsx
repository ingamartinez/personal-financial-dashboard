import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function InsightsLoading() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
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
        <Skeleton className="h-8 w-40" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-1 py-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
