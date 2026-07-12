/**
 * Minimal Telegram Bot API client — only the five calls the platform
 * needs. One code path for every environment: production and local dev
 * both receive real webhook pushes (locally via a tunnel, PUBLIC_URL set
 * to the tunnel URL). The base URL is overridable ONLY so tests can point
 * at a stub server; it is read per-call, not at import time.
 */

import type { Card } from '../shared/cards';

export interface TelegramBotInfo {
  id: number;
  username: string;
}

export interface TelegramWebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
  last_error_date?: number;
}

/** A Telegram message — the shape both fresh and edited messages share. */
export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  chat: { id: number; type: string };
  /** Present when this message is a reply (e.g. a ForceReply answer to a card). */
  reply_to_message?: { message_id: number };
}

/** The subset of a Telegram Update the platform handles. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  /** The same message re-sent after the user edited it in their client. */
  edited_message?: TelegramMessage;
  /** An inline-keyboard button press. */
  callback_query?: {
    id: string;
    from: { id: number; is_bot: boolean; first_name?: string; username?: string };
    /** The message the keyboard was attached to. */
    message?: { message_id: number; chat: { id: number; type: string }; text?: string };
    /** Our button id (we set callback_data = button.id). */
    data?: string;
  };
}

function apiBase(): string {
  return (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/$/, '');
}

class TelegramError extends Error {
  constructor(method: string, description: string) {
    super(`telegram ${method}: ${description}`);
  }
}

async function call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: T; description?: string }
    | null;
  if (!json || !json.ok) {
    throw new TelegramError(method, json?.description ?? `HTTP ${res.status}`);
  }
  return json.result as T;
}

export const telegram = {
  /** Validates the bot token and returns the bot's identity. */
  getMe: (token: string) => call<TelegramBotInfo>(token, 'getMe'),

  /**
   * Point the bot's pushes at our inbound route. secret_token comes back
   * on every delivery as x-telegram-bot-api-secret-token — the proof the
   * caller is Telegram and not someone who guessed the URL.
   */
  setWebhook: (token: string, url: string, secretToken: string) =>
    call<boolean>(token, 'setWebhook', {
      url,
      secret_token: secretToken,
      // callback_query = inline-keyboard clicks, edited_message = inbound
      // edits. Connections registered before these existed must re-register
      // to start receiving them.
      allowed_updates: ['message', 'callback_query', 'edited_message'],
    }),

  deleteWebhook: (token: string) => call<boolean>(token, 'deleteWebhook'),

  getWebhookInfo: (token: string) => call<TelegramWebhookInfo>(token, 'getWebhookInfo'),

  sendMessage: (
    token: string,
    chatId: string | number,
    text: string,
    opts?: { buttons?: Array<{ id: string; label: string }>; card?: Card },
  ) => {
    // buttons / select card -> inline keyboard; text_input card -> ForceReply.
    // A reply carries buttons XOR one card, so these branches never collide.
    let reply_markup: Record<string, unknown> | undefined;
    const card = opts?.card;
    if (opts?.buttons?.length) {
      reply_markup = {
        inline_keyboard: opts.buttons.map((b) => [{ text: b.label, callback_data: b.id }]),
      };
    } else if (card?.type === 'select') {
      reply_markup = {
        inline_keyboard: card.options.map((o) => [{ text: o.label, callback_data: o.id }]),
      };
    } else if (card?.type === 'text_input') {
      reply_markup = {
        force_reply: true,
        ...(card.placeholder ? { input_field_placeholder: card.placeholder } : {}),
      };
    }
    return call<{ message_id: number }>(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(reply_markup ? { reply_markup } : {}),
    });
  },

  /** Acks a button press so the client stops showing its spinner. */
  answerCallbackQuery: (token: string, callbackQueryId: string) =>
    call<boolean>(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId }),

  /** Shows the "typing…" indicator in the chat; clears itself after ~5s. */
  sendChatAction: (token: string, chatId: string | number) =>
    call<boolean>(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }),

  /** Removes a sent message from the chat entirely (edits older than 48h reject). */
  deleteMessage: (token: string, chatId: string | number, messageId: number) =>
    call<boolean>(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }),

  /**
   * Rewrites a sent message. Telegram has no disabled-button state, so
   * "buttons retire after a click" is: edit the message to show the choice
   * — omitting reply_markup here is what removes the keyboard. Passing
   * buttons/select opts re-attaches a keyboard; a text_input card is IGNORED
   * here (ForceReply is illegal on edits — slice B handles that case).
   */
  editMessageText: (
    token: string,
    chatId: string | number,
    messageId: number,
    text: string,
    opts?: { buttons?: Array<{ id: string; label: string }>; card?: Card },
  ) => {
    let reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
    if (opts?.buttons?.length) {
      reply_markup = {
        inline_keyboard: opts.buttons.map((b) => [{ text: b.label, callback_data: b.id }]),
      };
    } else if (opts?.card?.type === 'select') {
      reply_markup = {
        inline_keyboard: opts.card.options.map((o) => [{ text: o.label, callback_data: o.id }]),
      };
    }
    return call<unknown>(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(reply_markup ? { reply_markup } : {}),
    });
  },
};
