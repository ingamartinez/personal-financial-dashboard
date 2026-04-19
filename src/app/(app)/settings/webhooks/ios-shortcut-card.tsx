import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const IOS_SHORTCUT_URL = "https://www.icloud.com/shortcuts/84d35cccc9624eca8683a1e2ee1f8eeb";

type Screenshot = {
  src: string;
  alt: string;
  caption: string;
};

const SCREENSHOTS: Screenshot[] = [
  {
    src: "/ios-shortcut/edit-button.jpeg",
    alt: "Long-press the Findash SMS Prod shortcut tile and tap Edit",
    caption: "Step 2 — Long-press the tile (or tap ⋯) and pick Edit",
  },
  {
    src: "/ios-shortcut/paste-location.jpeg",
    alt: "Replace PASTE-TOKEN with your bearer token in the Authorization header",
    caption: "Step 3 — Replace PASTE-TOKEN in the Authorization header",
  },
  {
    src: "/ios-shortcut/set-sender.jpeg",
    alt: "Any Sender + Message Contains 'Bancolombia' + Run Immediately",
    caption: "Step 4a — Any Sender, Message Contains keyword, Run Immediately",
  },
  {
    src: "/ios-shortcut/automation.jpeg",
    alt: "Personal Automation summary: When I Get a Message Containing 'Bancolombia' → Findash SMS Prod",
    caption: "Step 4b — Automation ready",
  },
];

export function IosShortcutCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>iOS Shortcut — SMS ingest</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-body text-muted-foreground">
          Install the <strong>Findash SMS Prod</strong> shortcut on your iPhone so bank SMS messages
          are forwarded to <code className="font-mono">/api/ingest/sms</code>. One-time setup: mint
          an <em>SMS ingest</em> token above, then paste it into the shortcut after install.
        </p>

        <div>
          <Button asChild>
            <a href={IOS_SHORTCUT_URL} target="_blank" rel="noreferrer">
              Install iOS Shortcut
            </a>
          </Button>
        </div>

        <ol className="text-body list-decimal space-y-2 pl-5">
          <li>
            Tap <strong>Install iOS Shortcut</strong> above. iCloud opens it in the Shortcuts app —
            tap <strong>Add Shortcut</strong>.
          </li>
          <li>
            Open the shortcut in edit mode: long-press the <em>Findash SMS Prod</em> tile and pick{" "}
            <strong>Edit</strong>, or tap the <strong>⋯</strong> on the tile.
          </li>
          <li>
            In the <em>Get Contents of URL</em> action, tap the blue arrow to expand it. Find the{" "}
            <code className="font-mono">Authorization</code> header and replace{" "}
            <code className="font-mono">PASTE-TOKEN</code> with your token from the mint step.
          </li>
          <li>
            Create a Personal Automation so the shortcut runs when bank SMS arrive: Shortcuts app →{" "}
            <strong>Automation</strong> tab → <strong>+</strong> → <strong>Message</strong>. Leave{" "}
            <em>Sender</em> as any, then add a <strong>Message contains</strong> filter with your
            bank&apos;s keyword (e.g. <code className="font-mono">Bancolombia</code>). Enable{" "}
            <strong>Run Immediately</strong> and pick <em>Findash SMS Prod</em> as the action.
          </li>
        </ol>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SCREENSHOTS.map((s) => (
            <figure key={s.src} className="flex flex-col gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.src}
                alt={s.alt}
                width={589}
                height={1280}
                className="border-border mx-auto h-auto w-full max-w-[260px] rounded-md border"
              />
              <figcaption className="text-muted-foreground text-center text-xs">
                {s.caption}
              </figcaption>
            </figure>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
