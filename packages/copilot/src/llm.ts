/** Provider-agnostic client for any OpenAI-compatible endpoint (OpenAI, Azure OpenAI gateways, vLLM, Ollama...). */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type LlmConfig = { url?: string; apiKey?: string; model: string; embeddingModel: string; fetch?: typeof fetch; timeoutMs?: number };

export type Llm = {
  readonly configured: boolean;
  readonly model: string;
  chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
  embed(texts: string[]): Promise<number[][]>;
};

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function createLlm(cfg: LlmConfig): Llm {
  const base = cfg.url?.replace(/\/+$/, "");
  const f = cfg.fetch ?? fetch;
  async function post<T>(path: string, body: unknown): Promise<T> {
    if (!base) throw new LlmError("No language model is configured");
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new LlmError(`The language model is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) throw new LlmError(`The language model answered ${res.status}`, res.status);
    return (await res.json()) as T;
  }
  return {
    configured: Boolean(base),
    model: cfg.model,
    async chat(messages, tools) {
      const r = await post<{ choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] }>("/chat/completions", {
        model: cfg.model, messages, temperature: 0.1, ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      });
      const m = r.choices?.[0]?.message;
      if (!m) throw new LlmError("The language model returned no answer");
      return { content: m.content ?? null, toolCalls: m.tool_calls ?? [] };
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      const r = await post<{ data?: { embedding: number[]; index: number }[] }>("/embeddings", { model: cfg.embeddingModel, input: texts });
      const out = [...(r.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (out.length !== texts.length) throw new LlmError("The embedding service returned an unexpected number of vectors");
      return out;
    },
  };
}
