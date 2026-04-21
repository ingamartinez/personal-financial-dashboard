/**
 * Central registration point for all widget handlers.
 *
 * Each handler lives in its own file and is registered here — the widget
 * route imports this module for its side effects so that by the time a
 * request hits `GET /api/widget/v1/[id]`, every real handler is already in
 * the registry. Tests continue to register stub handlers directly against
 * the registry to simulate dispatch without running real SQL.
 *
 * Keep this file thin — logic belongs in the individual handler modules.
 */

import { registerWidgetHandler } from "@/app/api/widget/v1/[id]/registry";
import { misTcsHandler } from "./mis-tcs";
import { tcFocusHandler } from "./tc-focus";

registerWidgetHandler("mis-tcs", misTcsHandler);
registerWidgetHandler("tc-focus", tcFocusHandler);
