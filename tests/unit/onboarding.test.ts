/**
 * Phase 17 onboarding pure-logic units (no I/O): the BotFather token parser,
 * the Slack manifest builder + YAML serializer, and the OAuth-state signer.
 * These are the building blocks the quick-setup / handoff / install routes
 * lean on; testing them here keeps the integration suites focused on wiring.
 */
import { describe, expect, test, vi } from 'vitest';
import { parseBotFatherToken } from '../../src/shared/botfather';
import {
  buildSlackManifest,
  manifestToYaml,
  SLACK_BOT_SCOPES,
} from '../../src/channels/slack-manifest';
import { mintOauthState, verifyOauthState } from '../../src/auth/oauth-state';

// A token-shaped run: <6-12 digits>:<30+ of [A-Za-z0-9_-]>.
const TOKEN_A = '7000001:AAitest-telegram-token_0123456789AB';
const TOKEN_B = '8123456:BBanother-real-shaped-token_ABCDEFGHIJ';

describe('parseBotFatherToken', () => {
  test('pulls the token out of a real BotFather "Done!" message', () => {
    const msg = [
      'Done! Congratulations on your new bot. You will find it at t.me/my_bot.',
      '',
      'Use this token to access the HTTP API:',
      TOKEN_A,
      '',
      'Keep your token secure and store it safely, it can be used by anyone to control your bot.',
    ].join('\n');
    const out = parseBotFatherToken(msg);
    expect(out).toEqual({ token: TOKEN_A });
  });

  test('finds the token inside whole-screen noise', () => {
    const noise = `random header\nlots of UI chrome 12:34 not a token 999\n${TOKEN_A}\nfooter junk`;
    expect(parseBotFatherToken(noise)).toEqual({ token: TOKEN_A });
  });

  test('two DISTINCT tokens is ambiguous', () => {
    expect(parseBotFatherToken(`${TOKEN_A}\nand also\n${TOKEN_B}`)).toEqual({ error: 'ambiguous' });
  });

  test('no token at all is not-found', () => {
    expect(parseBotFatherToken('just a friendly hello, no secrets here')).toEqual({
      error: 'not-found',
    });
    expect(parseBotFatherToken('')).toEqual({ error: 'not-found' });
    // A too-short suffix does not match the token shape.
    expect(parseBotFatherToken('123456:short')).toEqual({ error: 'not-found' });
  });

  test('the SAME token echoed twice dedupes to one (not ambiguous)', () => {
    expect(parseBotFatherToken(`${TOKEN_A} ... ${TOKEN_A}`)).toEqual({ token: TOKEN_A });
  });
});

describe('buildSlackManifest', () => {
  const publicUrl = 'https://tunnel.example.test';
  const connectionId = 'c0ffee00-0000-4000-8000-000000000001';

  test('carries the exact 14 bot scopes and 5 bot events', () => {
    const m = buildSlackManifest({ agentName: 'Helper', publicUrl, connectionId });
    const scopes = (m.oauth_config as { scopes: { bot: string[] } }).scopes.bot;
    expect(scopes).toEqual([...SLACK_BOT_SCOPES]);
    // The exact set (order-insensitive): users:read.email rides along because
    // the email auto-match's users.info call returns no profile email without it;
    // assistant:write rides along because agent_view's prompts don't render without it.
    expect([...scopes].sort()).toEqual(
      [
        'app_mentions:read',
        'assistant:write',
        'channels:history',
        'channels:read',
        'chat:write',
        'groups:history',
        'groups:read',
        'im:history',
        'im:read',
        'im:write',
        'mpim:history',
        'mpim:read',
        'users:read',
        'users:read.email',
      ].sort(),
    );
    expect(scopes).toHaveLength(14);

    const events = (
      m.settings as { event_subscriptions: { bot_events: string[] } }
    ).event_subscriptions.bot_events;
    expect(events).toEqual([
      'app_mention',
      'message.channels',
      'message.groups',
      'message.im',
      'message.mpim',
    ]);
    expect(events).toHaveLength(5);
  });

  test('sanitizes a name containing "slack" and collapses the doubled space', () => {
    const m = buildSlackManifest({ agentName: 'My Slack Bot', publicUrl, connectionId });
    expect((m.display_information as { name: string }).name).toBe('My Bot');
    const botUser = (m.features as { bot_user: { display_name: string } }).bot_user;
    expect(botUser.display_name).toBe('My Bot');
  });

  test('falls back to "Agent" when the name is only "Slack"', () => {
    const m = buildSlackManifest({ agentName: 'Slack', publicUrl, connectionId });
    expect((m.display_information as { name: string }).name).toBe('Agent');
  });

  test('agent_view appears ONLY when suggested prompts exist, sliced to 4', () => {
    const bare = buildSlackManifest({ agentName: 'Helper', publicUrl, connectionId });
    expect((bare.features as { agent_view?: unknown }).agent_view).toBeUndefined();

    const prompts = Array.from({ length: 6 }, (_, i) => ({
      title: `Prompt ${i}`,
      message: `Do thing ${i}`,
    }));
    const withPrompts = buildSlackManifest({
      agentName: 'Helper',
      suggestedPrompts: prompts,
      publicUrl,
      connectionId,
    });
    const view = (withPrompts.features as { agent_view: { suggested_prompts: unknown[] } })
      .agent_view;
    expect(view).toBeDefined();
    expect(view.suggested_prompts).toHaveLength(4);
    expect(view.suggested_prompts[0]).toEqual({ title: 'Prompt 0', message: 'Do thing 0' });
  });

  test('URLs embed the connection id + public url, and the redirect url is fixed', () => {
    const m = buildSlackManifest({ agentName: 'Helper', publicUrl, connectionId });
    const settings = m.settings as {
      event_subscriptions: { request_url: string };
      interactivity: { request_url: string };
    };
    expect(settings.event_subscriptions.request_url).toBe(
      `${publicUrl}/webhooks/slack/${connectionId}/events`,
    );
    expect(settings.interactivity.request_url).toBe(
      `${publicUrl}/webhooks/slack/${connectionId}/interactivity`,
    );
    const redirects = (m.oauth_config as { redirect_urls: string[] }).redirect_urls;
    expect(redirects).toEqual([`${publicUrl}/webhooks/slack/oauth/callback`]);
  });
});

describe('manifestToYaml', () => {
  test('serializes the fixed manifest shape to plausible block-style YAML', () => {
    const yaml = manifestToYaml(
      buildSlackManifest({
        agentName: 'Helper',
        agentDescription: 'A helpful assistant',
        suggestedPrompts: [{ title: 'Start', message: 'Kick things off' }],
        publicUrl: 'https://tunnel.example.test',
        connectionId: 'c0ffee00-0000-4000-8000-000000000002',
      }),
    );
    // Top-level maps present, indented children, scopes as a list, no undefineds.
    expect(yaml).toContain('display_information:');
    expect(yaml).toContain('name: "Helper"');
    expect(yaml).toContain('oauth_config:');
    expect(yaml).toContain('- "app_mentions:read"');
    expect(yaml).toContain('redirect_urls:');
    expect(yaml).toContain('event_subscriptions:');
    expect(yaml).toContain('- "app_mention"');
    // agent_view rides along when prompts exist; each prompt is a list item.
    expect(yaml).toContain('suggested_prompts:');
    expect(yaml).toContain('title: "Start"');
    expect(yaml).not.toContain('undefined');
    expect(yaml.endsWith('\n')).toBe(true);
  });
});

describe('oauth-state mint/verify', () => {
  const payload = {
    connectionId: 'c0ffee00-0000-4000-8000-000000000003',
    tenantId: 'tenant-abc-0000-4000-8000-000000000004',
  };

  test('round-trips a freshly minted state', () => {
    const state = mintOauthState(payload);
    expect(verifyOauthState(state)).toEqual(payload);
  });

  test('a tampered signature verifies to null', () => {
    const state = mintOauthState(payload);
    const [body, mac] = state.split('.');
    // Flip the last char of the MAC (still base64url-legal, but wrong).
    const flipped = mac.slice(0, -1) + (mac.at(-1) === 'A' ? 'B' : 'A');
    expect(verifyOauthState(`${body}.${flipped}`)).toBeNull();
    // A tampered body (payload swap) also fails the MAC check.
    const other = mintOauthState({ ...payload, tenantId: 'someone-else' });
    expect(verifyOauthState(`${other.split('.')[0]}.${mac}`)).toBeNull();
    // Structurally broken states are null, never a throw.
    expect(verifyOauthState('garbage')).toBeNull();
    expect(verifyOauthState('')).toBeNull();
  });

  test('an expired state verifies to null', () => {
    // Mint 10 minutes in the past (exp is now-5min once the clock advances).
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 10 * 60 * 1000);
    const state = mintOauthState(payload);
    spy.mockRestore();
    expect(verifyOauthState(state)).toBeNull();
  });
});
