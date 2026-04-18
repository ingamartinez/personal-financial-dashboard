import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";

type LoginPageProps = {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const params = await searchParams;

  if (session?.user?.id) {
    redirect(params.callbackUrl ?? "/");
  }

  const callbackUrl = params.callbackUrl ?? "/";

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="bg-card w-full max-w-sm space-y-6 rounded-lg border p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Bienvenido</h1>
          <p className="text-muted-foreground text-sm">
            Entrá con tu cuenta de Google para acceder a Findash.
          </p>
        </div>

        {params.error ? (
          <p className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            No pudimos iniciar sesión. Intentá de nuevo.
          </p>
        ) : null}

        <form action={signInWithGoogle}>
          <Button type="submit" className="w-full" size="lg">
            Continuar con Google
          </Button>
        </form>
      </div>
    </main>
  );
}
