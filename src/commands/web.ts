import type { Command, CommandGenerator, CommandOptions } from '../types.ts';
import type { Config } from '../config.ts';
import { loadConfig, loadEnv } from '../config.ts';
import { createEventSource } from 'eventsource-client';

const MAX_RETRIES = 3;

export class WebCommand implements Command {
  private config: Config;

  constructor() {
    loadEnv();
    this.config = loadConfig();
  }

  private async *fetchPerplexityResponse(
    query: string,
    options?: CommandOptions
  ): AsyncGenerator<string, void, unknown> {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY environment variable is not set');
    }

    let fetchAttempts = 0;
    const es = createEventSource({
      url: 'https://api.perplexity.ai/chat/completions',
      fetch: async (url, init) => {
        if (fetchAttempts++ > MAX_RETRIES) {
          throw new Error('Max retries reached');
        }
        const response = await fetch(url, {
          ...init,
          method: 'POST',
          headers: {
            ...(init?.headers || {}),
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: options?.model || this.config.perplexity.model,
            messages: [
              {
                role: 'system',
                content:
                  'Search the web to produce answers to questions. Your responses are for an automated system and should be precise, specific and concise. Avoid unnecessary chat and formatting. Include code and examples.',
              },
              {
                role: 'user',
                content: query,
              },
            ],
            stream: true,
            max_tokens: options?.maxTokens || this.config.perplexity.maxTokens,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API Error (${response.status}): ${errorText}`);
        }

        return response;
      },
    });

    try {
      for await (const { data } of es) {
        try {
          const json = JSON.parse(data);
          const content = json.choices[0]?.delta?.content;
          if (content !== undefined) {
            yield content;
          }
          if ('finish_reason' in json.choices[0] && !!json.choices[0].finish_reason) {
            if (json.citations && json.citations.length > 0) {
              yield '\n\ncitations:\n' +
                json.citations?.map((c: any, i: number) => `${i + 1}. ${c}`).join('\n');
            }
            break;
          }
        } catch (e) {
          console.error('Error parsing event data:', e);
          throw e;
        }
      }
    } finally {
      es.close();
    }
  }

  async *execute(query: string, options?: CommandOptions): CommandGenerator {
    try {
      const model = options?.model || this.config.perplexity.model;
      yield `Querying Perplexity AI using ${model} for: ${query}\n`;
      yield* this.fetchPerplexityResponse(query, options);
    } catch (error) {
      if (error instanceof Error) {
        yield `Error: ${error.message}`;
      } else {
        yield 'An unknown error occurred';
      }
    }
  }
}
