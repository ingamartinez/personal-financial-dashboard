import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { GoogleIcon } from "@/components/icons/google";

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
    <main className="bg-muted/20 relative flex flex-1 items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.9_0.08_260/.25),transparent_70%)] dark:bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.5_0.2_260/.25),transparent_70%)]"
      />

      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary size-10 rounded-xl" aria-hidden />
          <h1 className="text-3xl font-semibold tracking-tight">Findash</h1>
          <p className="text-muted-foreground max-w-xs text-sm">
            Tu dashboard financiero personal. Entrá con tu cuenta de Google para continuar.
          </p>
        </div>

        <div className="bg-card space-y-5 rounded-2xl border p-6 shadow-sm">
          {params.error ? (
            <p
              role="alert"
              className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
            >
              No pudimos iniciar sesión. Intentá de nuevo.
            </p>
          ) : null}

          <form action={signInWithGoogle}>
            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="h-12 w-full gap-3 text-base font-medium"
            >
              <GoogleIcon size={20} />
              Continuar con Google
            </Button>
          </form>

          <p className="text-muted-foreground text-center text-xs">
            Solo usuarios con invitación pueden acceder.
          </p>
        </div>

        <p className="text-muted-foreground text-center text-xs">
          © {new Date().getFullYear()} Findash
        </p>
      </div>
    </main>
  );
}
