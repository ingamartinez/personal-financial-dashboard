import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CheatsheetRow = {
  widget: string;
  id: string;
  sizes: string;
  example: string;
};

// Setup guide lives at /docs/widgets/README.md (linked from the page header).
const ROWS: readonly CheatsheetRow[] = [
  { widget: "TC Focus", id: "tc-focus", sizes: "S", example: "tc-focus.S|<card_id>" },
  { widget: "Mis TCs", id: "mis-tcs", sizes: "M, L", example: "mis-tcs.M" },
  { widget: "Hoy", id: "hoy", sizes: "S", example: "hoy.S" },
  { widget: "Mes actual", id: "mes-actual", sizes: "M", example: "mes-actual.M" },
  { widget: "Últimas 5", id: "recent-tx", sizes: "M, L", example: "recent-tx.L" },
] as const;

export function WidgetCheatsheet() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Widgets disponibles</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground mb-3 text-sm">
          Pegá el parámetro en Scriptable (iOS) o Tasker (Android) para elegir qué widget mostrar.
          El formato es{" "}
          <code className="bg-muted rounded px-1 font-mono text-xs">&lt;id&gt;.&lt;size&gt;</code> y
          algunos widgets aceptan un argumento extra tras <code className="font-mono">|</code>.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Widget</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Tamaños</TableHead>
              <TableHead>Parámetro de ejemplo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.widget}</TableCell>
                <TableCell>
                  <code className="bg-muted rounded px-1 font-mono text-xs">{row.id}</code>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.sizes}</TableCell>
                <TableCell>
                  <code className="bg-muted rounded px-1 font-mono text-xs">{row.example}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
