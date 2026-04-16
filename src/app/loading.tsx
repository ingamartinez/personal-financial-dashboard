import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-28" />
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-3 w-full" />
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-6 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <Skeleton className="h-6 w-28" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="flex flex-col gap-2 py-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-40" />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
