/**
 * Phase A3, slice B — the eval CLI's env-credential judge wiring.
 *
 * scripts/eval.ts calls main() at import, so it is never imported here; the
 * logic under test is the pure factory it delegates to (core/eval-judge-env.ts).
 *
 * Three things are pinned:
 *   1. the env contract — which vars turn judging on, ASYNCIFY_JUDGE_* winning
 *      over EVAL_LLM_*, and a key WITHOUT a model failing loudly instead of
 *      quietly degrading to an assertions-only run;
 *   2. the temperature rule — the model id decides whether `temperature` is sent
 *      at all (modern Claude families 400 on it), via the single predicate now
 *      living in eval-judge.ts;
 *   3. the wire shape — the client this factory builds, driven by the real
 *      judgeReply against a local Anthropic-compatible HTTP server: the key,
 *      base URL, model, temperature and forced tool actually leave the process
 *      the way the judge expects, and real verdicts come back.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildEnvJudgeOptions,
  readEnvJudgeCreds,
  buildEnvJudgeClient,
} from '../../src/core/eval-judge-env';
import { judgeReply, type JudgeSpec } from '../../src/core/eval-judge';
import { EvalError } from '../../src/core/eval-runner';
import type { ConversationMessage } from '../../src/db/conversations.repo';

/** Only the vars the factory reads — never the ambient process.env. */
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  over as NodeJS.ProcessEnv;

describe('A3 env judge — the env contract', () => {
  test('no creds: undefined, i.e. exactly the pre-A3 assertions-only run', () => {
    expect(buildEnvJudgeOptions(env())).toBeUndefined();
    // A model alone is not a judge — without a key nothing is turned on.
    expect(buildEnvJudgeOptions(env({ EVAL_LLM_MODEL: 'glm-4.6' }))).toBeUndefined();
    // Blank/whitespace env vars are how CI passes "unset"; treat them as absent.
    expect(buildEnvJudgeOptions(env({ EVAL_LLM_API_KEY: '   ' }))).toBeUndefined();
  });

  test('EVAL_LLM_* creds build the full wiring (client, model, no persona)', () => {
    const opts = buildEnvJudgeOptions(
      env({ EVAL_LLM_API_KEY: 'sk-judge', EVAL_LLM_MODEL: 'glm-4.6' }),
    );
    expect(opts).toBeDefined();
    expect(opts!.model).toBe('glm-4.6');
    expect(opts!.client).toBeDefined();
    // The CLI holds an api key, not the agent row: passing a persona would be
    // inventing one, so tone falls back to the judge's generic-tone rubric.
    expect(opts!.systemPrompt).toBeNull();
  });

  test('ASYNCIFY_JUDGE_* takes precedence over the EVAL_LLM_* aliases', () => {
    const creds = readEnvJudgeCreds(
      env({
        ASYNCIFY_JUDGE_API_KEY: 'sk-asyncify',
        ASYNCIFY_JUDGE_MODEL: 'claude-fable-5',
        ASYNCIFY_JUDGE_BASE_URL: 'https://judge.example',
        EVAL_LLM_API_KEY: 'sk-eval',
        EVAL_LLM_MODEL: 'glm-4.6',
        EVAL_LLM_BASE_URL: 'https://other.example',
      }),
    );
    expect(creds).toEqual({
      apiKey: 'sk-asyncify',
      model: 'claude-fable-5',
      baseUrl: 'https://judge.example',
    });
  });

  test('base url is optional; the aliases can be mixed', () => {
    expect(
      readEnvJudgeCreds(env({ ASYNCIFY_JUDGE_API_KEY: 'sk-a', EVAL_LLM_MODEL: 'glm-4.6' })),
    ).toEqual({ apiKey: 'sk-a', model: 'glm-4.6' });
  });

  test('a key with NO model is a loud EvalError, never a silent default model', () => {
    const call = () => buildEnvJudgeOptions(env({ EVAL_LLM_API_KEY: 'sk-judge' }));
    expect(call).toThrow(EvalError);
    // The message has to name the var to set — this is the operator's only clue.
    expect(call).toThrow(/EVAL_LLM_MODEL/);
    expect(call).toThrow(/no default model/i);
  });
});

describe('A3 env judge — the temperature rule', () => {
  const tempFor = (model: string) =>
    buildEnvJudgeOptions(env({ EVAL_LLM_API_KEY: 'sk', EVAL_LLM_MODEL: model }))!.temperature;

  test('modern Claude families omit temperature (null); everything else keeps 0', () => {
    // Hyphenated ids are the REAL Anthropic form (claude-opus-4-8 is
    // managed-brain's DEFAULT_MODEL); dotted ids appear on compat endpoints.
    // Both must match — the dotted-only A2 regex sent temperature:0 to
    // claude-opus-4-8, a guaranteed 400.
    for (const m of [
      'claude-fable-5',
      'claude-opus-4.7',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
    ]) {
      expect(tempFor(m)).toBeNull();
    }
    for (const m of [
      'glm-4.6',
      'claude-3-5-sonnet-20241022',
      'claude-opus-4.5',
      'claude-opus-4-5',
      'gpt-4o-mini',
    ]) {
      expect(tempFor(m)).toBe(0);
    }
  });
});

// ---- the wire: the real client against a local Anthropic-compatible server ---

interface SeenRequest {
  url: string | undefined;
  apiKey: string | undefined;
  body: {
    model: string;
    temperature?: number;
    system: string;
    tools: Array<{ name: string }>;
    tool_choice: { type: string; name: string };
    messages: Array<{ role: string; content: string }>;
  };
}

describe('A3 env judge — wire shape end to end', () => {
  let server: Server;
  let baseUrl = '';
  const seen: SeenRequest[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({
          url: req.url,
          apiKey: req.headers['x-api-key'] as string | undefined,
          body: JSON.parse(raw) as SeenRequest['body'],
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'msg_judge_1',
            type: 'message',
            role: 'assistant',
            model: 'glm-4.6',
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'report_verdicts',
                input: {
                  verdicts: [
                    {
                      dim: 'groundedness',
                      score: 5,
                      verdict: 'pass',
                      rationale: 'Every claim traces to the refund-policy source.',
                    },
                  ],
                },
              },
            ],
            usage: { input_tokens: 20, output_tokens: 8 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const rows: ConversationMessage[] = [
    {
      id: 'r1',
      conversation_id: 'conv-a3',
      tenant_id: 't1',
      role: 'system',
      content: 'searched knowledge',
      dedupe_key: 'dk',
      raw: {
        action: {
          tool: 'search_knowledge',
          input: { query: 'refund window' },
          result: '1. [source: refund-policy] Refunds are available within 30 days.',
        },
      },
      created_at: '2026-08-21T10:00:00.000Z',
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
    },
  ];

  test('judgeReply over the built client: creds+model+forced tool go out, verdicts come back', async () => {
    const opts = buildEnvJudgeOptions(
      env({
        EVAL_LLM_API_KEY: 'sk-wire',
        EVAL_LLM_MODEL: 'glm-4.6',
        EVAL_LLM_BASE_URL: baseUrl,
      }),
    )!;

    const spec = { groundedness: true } as JudgeSpec;
    const verdicts = await judgeReply({
      client: opts.client,
      model: opts.model,
      transcript: rows,
      reply: 'You can request a refund within 30 days.',
      systemPrompt: opts.systemPrompt,
      spec,
      temperature: opts.temperature,
    });

    expect(verdicts).toEqual([
      {
        dim: 'groundedness',
        score: 5,
        verdict: 'pass',
        rationale: 'Every claim traces to the refund-policy source.',
      },
    ]);

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    // Anthropic-compatible surface: the standard non-beta Messages endpoint,
    // key on x-api-key, and the base URL honoured (this server IS the proof).
    expect(req.url).toBe('/v1/messages');
    expect(req.apiKey).toBe('sk-wire');
    expect(req.body.model).toBe('glm-4.6');
    // glm keeps the repeatable 0 — and it survives the client, not just the object.
    expect(req.body.temperature).toBe(0);
    expect(req.body.tool_choice).toEqual({ type: 'tool', name: 'report_verdicts' });
    expect(req.body.tools[0]!.name).toBe('report_verdicts');
    // No persona configured -> the judge's generic-tone fallback, and the
    // transcript rides as fenced untrusted data.
    expect(req.body.messages[0]!.content).toContain('BEGIN_UNTRUSTED_TRANSCRIPT_DATA');
  });

  test('a model that rejects sampling params sends no temperature field at all', async () => {
    seen.length = 0;
    const opts = buildEnvJudgeOptions(
      env({
        EVAL_LLM_API_KEY: 'sk-wire',
        EVAL_LLM_MODEL: 'claude-fable-5',
        EVAL_LLM_BASE_URL: baseUrl,
      }),
    )!;
    await judgeReply({
      client: opts.client,
      model: opts.model,
      transcript: rows,
      reply: 'You can request a refund within 30 days.',
      systemPrompt: opts.systemPrompt,
      spec: { groundedness: true } as JudgeSpec,
      temperature: opts.temperature,
    });
    expect(seen[0]!.body.model).toBe('claude-fable-5');
    expect('temperature' in seen[0]!.body).toBe(false);
  });

  test('buildEnvJudgeClient is usable on its own (no base url = the real API host)', () => {
    // Nothing is dialled here — constructing the SDK client opens no socket.
    expect(buildEnvJudgeClient({ apiKey: 'sk', model: 'glm-4.6' })).toBeDefined();
  });
});
