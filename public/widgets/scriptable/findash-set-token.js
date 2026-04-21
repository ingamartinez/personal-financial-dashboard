// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: teal; icon-glyph: key;

// ============================================================================
// Findash — one-time setup
// ----------------------------------------------------------------------------
// Stores your widget token + base URL in the iOS Keychain under the keys:
//
//   FINDASH_TOKEN     — widget token minted at /settings/widgets
//   FINDASH_BASE_URL  — e.g. https://findash.example.com (no trailing slash)
//
// Run this script ONCE from inside the Scriptable app. The main widget script
// (findash-widget.js) reads from these keys — no need to edit code to change
// the token or URL, just re-run this helper.
//
// Tip: if you rotate the token at /settings/widgets, re-run this script with
// the new plaintext — the old value is overwritten in place.
// ============================================================================

const TOKEN_KEY = "FINDASH_TOKEN";
const BASE_URL_KEY = "FINDASH_BASE_URL";

function keychainGet(key) {
  return Keychain.contains(key) ? Keychain.get(key) : "";
}

async function prompt({ title, message, fields }) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  for (const field of fields) {
    const tf = alert.addTextField(field.placeholder, field.defaultValue ?? "");
    if (field.secure) tf.isSecure = true;
  }
  alert.addAction("Guardar");
  alert.addCancelAction("Cancelar");
  const chosen = await alert.presentAlert();
  if (chosen === -1) return null;
  return fields.map((_, i) => alert.textFieldValue(i));
}

async function main() {
  const existingBase = keychainGet(BASE_URL_KEY) || "https://findash.example.com";
  const existingToken = keychainGet(TOKEN_KEY);

  const values = await prompt({
    title: "Findash — setup",
    message:
      "Pegá la URL base de tu instancia Findash y el widget token (generado en /settings/widgets). Se guardan en el Keychain del dispositivo.",
    fields: [
      { placeholder: "Base URL (https://findash.example.com)", defaultValue: existingBase },
      {
        placeholder: existingToken ? "Token (actual: ••••)" : "Widget token",
        secure: true,
      },
    ],
  });

  if (!values) {
    const cancelled = new Alert();
    cancelled.title = "Cancelado";
    cancelled.message = "No se guardó nada.";
    cancelled.addAction("OK");
    await cancelled.presentAlert();
    return;
  }

  const baseUrl = (values[0] || "").trim().replace(/\/$/, "");
  const token = (values[1] || "").trim() || existingToken; // empty input keeps existing

  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    const err = new Alert();
    err.title = "URL inválida";
    err.message = "La base URL debe empezar con http:// o https://.";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }
  if (!token) {
    const err = new Alert();
    err.title = "Falta el token";
    err.message = "Generá un widget token en /settings/widgets y pegalo aquí.";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }

  Keychain.set(BASE_URL_KEY, baseUrl);
  Keychain.set(TOKEN_KEY, token);

  const ok = new Alert();
  ok.title = "Listo";
  ok.message = "Credenciales guardadas. Ya podés agregar el widget a la pantalla de inicio.";
  ok.addAction("OK");
  await ok.presentAlert();
}

await main();
Script.complete();
