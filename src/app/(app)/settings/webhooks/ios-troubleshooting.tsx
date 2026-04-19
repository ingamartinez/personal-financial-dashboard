import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Entry = {
  symptom: string;
  checklist: string[];
  note?: string;
};

const ENTRIES: Entry[] = [
  {
    symptom: "No estoy recibiendo transacciones",
    checklist: [
      "¿La Shortcut está instalada? Shortcuts app → debería aparecer “Findash SMS Prod”.",
      "¿La automatización está habilitada? Shortcuts app → Automation → tu atajo → verificá el toggle.",
      "¿Tocaste “Run Immediately”? Si pide confirmación cada vez, está en manual.",
      "¿Tenés “Bancolombia” como contacto? iOS filtra SMS de contactos — sacá ese contacto.",
      "¿Tu token sigue activo? Revisá la lista de tokens arriba — si lo revocaste, mintá uno nuevo y reemplazá en el Shortcut.",
    ],
    note: "Si el checklist pasa completo y seguís sin captura, mirá `/settings/inbox` — un SMS que llegó sin cuenta asociada aparece ahí como error.",
  },
  {
    symptom: "La automatización me pide confirmación cada vez",
    checklist: [
      "Shortcuts app → Automation → abrí tu atajo.",
      "En la configuración de la automatización, activá Run Immediately.",
      "Guardá. Desde el próximo SMS, corre sin pedir tap.",
    ],
    note: "En iOS 17+ puede requerir también “Notify When Run” = OFF para evitar banners de notificación ruidosos.",
  },
  {
    symptom: "Recibo transacciones duplicadas",
    checklist: [
      "¿Tenés Shortcut Dev y Prod activos al mismo tiempo? Desactivá Dev en producción.",
      "¿Instalaste la Shortcut dos veces? Borrá la vieja desde Shortcuts app.",
      "Si el SMS llegó dos veces real (iMessage + SMS), el pipeline de dedup debería rechazarlo como “duplicated” — mirá en `/settings/inbox` si hay errores.",
    ],
    note: "Findash usa `externalId` determinístico (kind + monto + fecha + cuenta) para dedup. Si el duplicado persiste, reportalo como bug con el raw SMS.",
  },
  {
    symptom: "El Shortcut falla con 401 / 403",
    checklist: [
      "El token venció o fue revocado. Mintá un nuevo token SMS arriba.",
      "Copiá el plaintext (solo se muestra una vez).",
      "Editá el Shortcut → Get Contents of URL → reemplazá `PASTE-TOKEN` con el nuevo.",
    ],
  },
];

export function IosTroubleshooting() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Troubleshooting</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ENTRIES.map((e) => (
          <details
            key={e.symptom}
            className="border-border bg-muted/20 hover:bg-muted/30 group open:bg-muted/40 rounded-md border p-3"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
              <span>{e.symptom}</span>
              <span
                aria-hidden
                className="text-muted-foreground text-xs transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </summary>
            <ol className="text-body mt-3 list-decimal space-y-1 pl-5">
              {e.checklist.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            {e.note ? <p className="text-muted-foreground mt-2 text-xs italic">{e.note}</p> : null}
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
