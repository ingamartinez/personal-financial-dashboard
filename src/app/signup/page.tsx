import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { GoogleIcon } from "@/components/icons/google";
import { validateInviteCode } from "@/lib/invite-codes";
import { setInviteCookie } from "@/lib/invite-codes/cookie";

type SignupPageProps = {
  searchParams: Promise<{ code?: string; error?: string }>;
};

type ErrorState = {
  title: string;
  body: string;
};

const ERRORS: Record<string, ErrorState> = {
  missing: {
    title: "Necesitás un link de invitación",
    body: "El registro en Findash es cerrado. Pedile a quien ya usa la app que te genere un código desde /admin/invites.",
  },
  unknown: {
    title: "Código inválido",
    body: "Este código no existe o fue removido. Verificá el link que te pasaron.",
  },
  expired: {
    title: "Código vencido",
    body: "Este código de invitación ya venció. Pedí uno nuevo a quien te lo haya dado.",
  },
  exhausted: {
    title: "Código ya usado",
    body: "Este código de invitación fue consumido en su totalidad. Pedí uno nuevo.",
  },
  disabled: {
    title: "Código desactivado",
    body: "Este código fue desactivado por quien lo creó. Pedí uno nuevo.",
  },
  "code-exhausted": {
    title: "Código agotado",
    body: "Alguien más acaba de usar este código antes que vos. Pedí uno nuevo para registrarte.",
  },
  AccessDenied: {
    title: "No pudimos completar el registro",
    body: "Tu invitación pudo haberse agotado mientras iniciabas sesión, o el intento de registro fue rechazado. Probá de nuevo con un código válido.",
  },
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/");
  }

  const params = await searchParams;
  const code = params.code?.trim();

  let errorState: ErrorState | null = null;
  let validCode: string | null = null;

  if (params.error && ERRORS[params.error]) {
    errorState = ERRORS[params.error];
  } else if (!code) {
    errorState = ERRORS.missing;
  } else {
    const validation = await validateInviteCode(code);
    if (validation.ok) {
      validCode = code;
    } else {
      errorState = ERRORS[validation.reason] ?? ERRORS.unknown;
    }
  }

  async function signUpWithGoogle(formData: FormData) {
    "use server";
    const submittedCode = formData.get("code");
    if (typeof submittedCode !== "string" || !submittedCode) {
      redirect("/signup?error=missing");
    }
    // Re-check at submission time to avoid setting a cookie for a code that
    // just got exhausted. The atomic consume in the signIn callback is the
    // real gate; this is only to shorten the feedback loop for the user.
    const validation = await validateInviteCode(submittedCode);
    if (!validation.ok) {
      redirect(`/signup?code=${encodeURIComponent(submittedCode)}&error=${validation.reason}`);
    }
    await setInviteCookie(submittedCode);
    await signIn("google", { redirectTo: "/" });
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
            Registro por invitación. Si tenés un código, podés crear tu cuenta con Google.
          </p>
        </div>

        <div className="bg-card space-y-5 rounded-2xl border p-6 shadow-sm">
          {errorState ? (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/10 text-destructive space-y-1 rounded-md border px-3 py-3 text-sm"
            >
              <p className="font-medium">{errorState.title}</p>
              <p className="text-destructive/80">{errorState.body}</p>
            </div>
          ) : null}

          {validCode ? (
            <>
              <div className="bg-muted/60 rounded-md border px-3 py-2 text-xs">
                <p className="text-muted-foreground">Código de invitación</p>
                <p className="font-mono text-sm break-all">{validCode}</p>
              </div>
              <form action={signUpWithGoogle}>
                <input type="hidden" name="code" value={validCode} />
                <Button
                  type="submit"
                  variant="outline"
                  size="lg"
                  className="h-12 w-full gap-3 text-base font-medium"
                >
                  <GoogleIcon size={20} />
                  Crear cuenta con Google
                </Button>
              </form>
            </>
          ) : (
            <p className="text-muted-foreground text-center text-sm">
              <Link href="/login" className="underline-offset-4 hover:underline">
                ¿Ya tenés cuenta? Iniciar sesión
              </Link>
            </p>
          )}
        </div>

        <p className="text-muted-foreground text-center text-xs">
          © {new Date().getFullYear()} Findash
        </p>
      </div>
    </main>
  );
}
