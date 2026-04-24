import { createCipher } from "./symmetric";

export const telegramCipher = createCipher("TELEGRAM_TOKEN_ENCRYPTION_KEY");
