"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  confirmOcrImport,
  previewScreenshotOcr,
  type OcrPreviewResult,
} from "@/app/settings/import/actions";
import type { Currency } from "@/lib/types";

type AccountOption = { id: number; name: string; currency: Currency };

type EditableRow = {
  occurredOn: string;
  description: string;
  amountCents: bigint;
  externalId: string;
  duplicate: boolean;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

function toEditable(preview: OcrPreviewResult): EditableRow[] {
  return preview.rows.map((r) => ({
    occurredOn: r.occurredOn,
    description: r.description,
    amountCents: r.amountCents,
    externalId: r.externalId,
    duplicate: r.duplicate,
  }));
}

export function ScreenshotUpload({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id.toString() ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<OcrPreviewResult | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [confirming, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const account = accounts.find((a) => a.id.toString() === accountId);
  const currency = account?.currency ?? "COP";

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pickFile = useCallback((next: File | null) => {
    setFile(next);
    setPreview(null);
    setRows([]);
    setExcluded(new Set());
  }, []);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            pickFile(f);
            toast.success("Image pasted");
            e.preventDefault();
            return;
          }
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pickFile]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) pickFile(f);
    else toast.error("Drop an image file (PNG, JPEG, WebP)");
  }

  async function onParse() {
    if (!file) {
      toast.error("Choose or paste an image first");
      return;
    }
    if (!accountId) {
      toast.error("Pick an account");
      return;
    }
    setParsing(true);
    try {
      const fd = new FormData();
      fd.set("accountId", accountId);
      fd.set("file", file);
      const result = await previewScreenshotOcr(fd);
      setPreview(result);
      setRows(toEditable(result));
      setExcluded(new Set(result.rows.filter((r) => r.duplicate).map((r) => r.externalId)));
      toast.success(
        `Extracted ${result.totals.parsed} · ${result.totals.new} new · ${result.totals.duplicates} duplicates`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "OCR failed");
    } finally {
      setParsing(false);
    }
  }

  function toggleRow(externalId: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }

  function updateRow(idx: number, patch: Partial<EditableRow>) {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function onConfirm() {
    if (!preview) return;
    const payload = rows
      .filter((r) => !excluded.has(r.externalId))
      .filter((r) => r.amountCents !== BigInt(0))
      .map((r) => ({
        occurredOn: r.occurredOn,
        description: r.description,
        amountCents: r.amountCents.toString(),
        externalId: r.externalId,
      }));
    if (payload.length === 0) {
      toast.error("Nothing to import");
      return;
    }
    startTransition(async () => {
      try {
        const res = await confirmOcrImport({
          accountId: preview.accountId,
          rows: payload,
        });
        toast.success(`Imported ${res.inserted} · ${res.duplicated} skipped as duplicate`);
        setFile(null);
        setPreview(null);
        setRows([]);
        setExcluded(new Set());
        router.push("/transactions");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Import failed");
      }
    });
  }

  const includedCount = rows.filter((r) => !excluded.has(r.externalId)).length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Screenshot OCR · Claude Vision</CardTitle>
          <CardDescription>
            Paste (⌘/Ctrl+V), drop, or choose a screenshot of transactions (ARQ, or any bank as
            fallback). Claude Vision will extract the rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ocr-account">Account</Label>
            <select
              id="ocr-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="bg-background chevron-select h-9 rounded-md border text-sm"
              required
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-sm transition",
              isDragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/30 hover:border-muted-foreground/60",
            )}
          >
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Screenshot preview" className="max-h-64 rounded border" />
            ) : (
              <>
                <span className="font-medium">Drop, paste, or click to upload</span>
                <span className="text-muted-foreground text-xs">PNG, JPEG, WebP · up to 8MB</span>
              </>
            )}
            <Input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={onParse} disabled={!file || parsing}>
              {parsing ? "Extracting…" : "Extract with Claude Vision"}
            </Button>
            {file && (
              <Button variant="outline" onClick={() => pickFile(null)} disabled={parsing}>
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>
              Preview · {includedCount} of {rows.length} selected
            </CardTitle>
            <CardDescription>
              Model: {preview.model} · {preview.usage.inputTokens} in / {preview.usage.outputTokens}{" "}
              out tokens. Edit any row before importing.
              {preview.skipped.length > 0
                ? ` ${preview.skipped.length} row(s) skipped during parsing.`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
                  <tr>
                    <th className="w-10 p-2"></th>
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Description</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => {
                    const isExcluded = excluded.has(r.externalId);
                    return (
                      <tr
                        key={r.externalId}
                        className={cn(
                          "border-t",
                          isExcluded && "opacity-50",
                          r.duplicate && "bg-amber-50/40",
                        )}
                      >
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={() => toggleRow(r.externalId)}
                            aria-label={`Include row ${idx}`}
                          />
                        </td>
                        <td className="p-2 tabular-nums">
                          <Input
                            type="date"
                            value={r.occurredOn}
                            onChange={(e) => updateRow(idx, { occurredOn: e.target.value })}
                            className="h-8 w-36"
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            value={r.description}
                            onChange={(e) => updateRow(idx, { description: e.target.value })}
                            className="h-8"
                          />
                        </td>
                        <td className="p-2 text-right">
                          <Input
                            type="number"
                            step="0.01"
                            value={(Number(r.amountCents) / 100).toString()}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (!Number.isFinite(n)) return;
                              updateRow(idx, {
                                amountCents: BigInt(Math.round(n * 100)),
                              });
                            }}
                            className={cn(
                              "h-8 w-32 text-right tabular-nums",
                              r.amountCents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                            )}
                          />
                          <div className="text-muted-foreground text-xs tabular-nums">
                            {formatMoney(r.amountCents, currency)}
                          </div>
                          <div className="text-muted-foreground text-[10px]">
                            {dateFmt.format(new Date(`${r.occurredOn}T12:00:00Z`))}
                          </div>
                        </td>
                        <td className="p-2 text-xs">
                          {r.duplicate ? (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                              duplicate
                            </span>
                          ) : (
                            <span className="text-muted-foreground">new</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setPreview(null);
                  setRows([]);
                  setExcluded(new Set());
                }}
                disabled={confirming}
              >
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={confirming || includedCount === 0}>
                {confirming ? "Importing…" : `Import ${includedCount} row(s)`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
