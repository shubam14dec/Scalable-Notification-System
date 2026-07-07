import { describe, expect, test } from 'vitest';
import { parsePostmarkInbound, stripQuotedReply } from '../../src/channels/email-inbound';

describe('stripQuotedReply', () => {
  test('cuts at "On ... wrote:"', () => {
    const text = 'my order never arrived\n\nOn Tue, Jul 8, 2026 at 9:00 AM Asyncify <a@b.c> wrote:\n> your order shipped';
    expect(stripQuotedReply(text)).toBe('my order never arrived');
  });

  test('cuts at ">"-quoted lines', () => {
    expect(stripQuotedReply('thanks!\n> earlier message\n> more quote')).toBe('thanks!');
  });

  test('cuts at "-----Original Message-----"', () => {
    expect(stripQuotedReply('got it\n-----Original Message-----\nFrom: x')).toBe('got it');
  });

  test('uses the earliest marker when several appear', () => {
    const text = 'hi\nFrom: someone@x.com\nOn Mon wrote:\n> q';
    expect(stripQuotedReply(text)).toBe('hi');
  });

  test('leaves unquoted text alone', () => {
    expect(stripQuotedReply('just a plain message')).toBe('just a plain message');
  });
});

describe('parsePostmarkInbound', () => {
  const base = {
    FromFull: { Email: 'Ana@Example.com', Name: 'Ana' },
    Subject: 'Where is my order?',
    TextBody: 'it never arrived\n> your order shipped',
    MessageID: 'pm-123',
    Headers: [{ Name: 'Message-ID', Value: '<abc@mail.example.com>' }],
  };

  test('normalizes sender, prefers StrippedTextReply, extracts Message-ID', () => {
    const parsed = parsePostmarkInbound({ ...base, StrippedTextReply: 'it never arrived' });
    expect(parsed).toEqual({
      fromEmail: 'ana@example.com',
      subject: 'Where is my order?',
      text: 'it never arrived',
      providerMessageId: 'pm-123',
      rfcMessageId: '<abc@mail.example.com>',
    });
  });

  test('falls back to stripping TextBody itself', () => {
    expect(parsePostmarkInbound(base)?.text).toBe('it never arrived');
  });

  test('rejects payloads without sender, id, or any text', () => {
    expect(parsePostmarkInbound({ ...base, FromFull: {} })).toBeNull();
    expect(parsePostmarkInbound({ ...base, MessageID: undefined })).toBeNull();
    expect(parsePostmarkInbound({ ...base, TextBody: '> all quote', StrippedTextReply: '' })).toBeNull();
  });
});
