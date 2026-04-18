export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  entities?: Array<{ type: string; offset: number; length: number }>;
};

export type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  chat_instance: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type SendMessageOptions = {
  chat_id: number;
  text: string;
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  reply_markup?: InlineKeyboardMarkup;
  reply_to_message_id?: number;
};

export type EditMessageOptions = {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  reply_markup?: InlineKeyboardMarkup;
};
