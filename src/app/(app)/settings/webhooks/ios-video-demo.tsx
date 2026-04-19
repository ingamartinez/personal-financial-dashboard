import { PlayCircleIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Renders the embedded onboarding walkthrough. Pass `videoUrl=null` to show a
 * styled placeholder until the recording is dropped into /public/ios-shortcut/.
 * Kept as a pure presentational component so the page decides whether the
 * asset exists (server-side `existsSync` check in the page).
 */
export function IosVideoDemo({
  videoUrl,
  posterUrl,
}: {
  videoUrl: string | null;
  posterUrl?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Video demo — setup en 45 segundos</CardTitle>
      </CardHeader>
      <CardContent>
        {videoUrl ? (
          <video
            src={videoUrl}
            poster={posterUrl}
            controls
            playsInline
            preload="metadata"
            className="border-border w-full rounded-md border"
          >
            Tu navegador no soporta video embebido. Usá el link directo:{" "}
            <a href={videoUrl}>{videoUrl}</a>.
          </video>
        ) : (
          <div className="border-border/60 bg-muted/40 flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center">
            <PlayCircleIcon className="text-muted-foreground size-10" />
            <p className="text-muted-foreground text-sm font-medium">Video demo en producción</p>
            <p className="text-muted-foreground max-w-sm text-xs">
              Mientras tanto, seguí los pasos escritos abajo. Los screenshots cubren los 4 pasos
              críticos.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
