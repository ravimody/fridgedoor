# Choosing an AI provider

Fridgedoor uses an AI model to read email, understand what you type or photograph, and
write the morning brief. You bring the model. The household owner pastes an API key in
Settings → AI (or during setup), picks a model, and presses Test connection. You can
switch providers at any time.

## Which one?

| Provider | Why pick it | Key |
| --- | --- | --- |
| Anthropic (Claude) | Good at careful reading and following instructions. | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI (GPT) | Strong all-rounder; supports web lookups for the planner and voice transcription. | [platform.openai.com](https://platform.openai.com/api-keys) |
| Google Gemini | Generous free tier for light use. | [aistudio.google.com](https://aistudio.google.com/apikey) |
| OpenRouter | One key for hundreds of models from many companies, so it's easy to compare them. | [openrouter.ai](https://openrouter.ai/settings/keys) |
| Groq, Mistral, DeepSeek, xAI, Together, Fireworks | Fast or inexpensive alternatives. Groq also supports voice transcription. | Each provider's console |
| Azure OpenAI | Your organization already uses Azure. | Azure portal |
| Ollama, LM Studio, llama.cpp, vLLM | Nothing leaves your network. Needs a capable computer, and small models miss details. Use the computer's address, or `host.docker.internal` when it runs on the same machine as Fridgedoor. | None |
| Other | Anything that speaks the OpenAI Chat Completions API (LiteLLM, LocalAI, a gateway). | Depends |

The main model handles the planner, the morning brief and household facts. You can
also choose a cheaper, faster email model for reading incoming mail, which is where
most of the volume is. And you can add a stronger review model: the email model then
only screens each message, and the review model reads the ones it flags.

The model must return structured JSON (every listed provider supports this) and, for
the planner, call tools. Models that can read images and PDFs give the best results with
flyers and attachments. When a model can't read an attachment, Fridgedoor tells it the
attachment was skipped.

## Costs

You pay the provider directly, per use. Most of the cost is reading email. Fridgedoor
makes one model call per inbox email, or two with a review model. Each call sends the
email's text (up to 24,000 characters, about 6,000 tokens), its attachments, the
instructions and your saved facts, so expect roughly 3,000 to 10,000 input tokens per
email. A household that gets 50 emails a day uses about 5 to 15 million input tokens a
month. Multiply that by your model's price per million input tokens: it comes to a few
dollars with a small model and tens of dollars with a large one. That is why "Use a
separate, cheaper model for reading emails" is worth turning on. Asking the planner
costs less, because people ask a few times a day.

Fridgedoor limits background email reading to 500 model calls an hour and 3,000 a day
per person. Set a monthly budget in your provider's console as well.

## Features that depend on the provider

| Feature | Works with |
| --- | --- |
| Reading email text, the planner, the morning brief | Every provider |
| Reading photos and images | Every provider except DeepSeek, with a vision-capable model |
| Reading PDF attachments | OpenAI, Azure OpenAI, Anthropic, OpenRouter |
| Looking up places and recipes on the web for the planner | OpenAI, Azure OpenAI, Anthropic |
| Voice transcription on the server for the web app | OpenAI, Groq (the iPhone app transcribes on the phone when it can) |

## Setting it with environment variables instead

For scripted installs, set these in `.env`. The web app then shows the AI settings as
read-only:

```sh
AI_PROVIDER=anthropic            # openai, anthropic, gemini, openrouter, groq, mistral, deepseek,
                                 # xai, together, fireworks, azure-openai, ollama, lmstudio, llamacpp, vllm, custom
AI_API_KEY=...
AI_MODEL=claude-sonnet-5-5
AI_MODEL_EMAIL=claude-haiku-5-5  # optional
AI_BASE_URL=                     # local servers, custom, azure-openai
AI_STRUCTURED_OUTPUT=json_schema # json_object or prompt for servers without JSON Schema support
```

`AI_ENABLED=false` turns off background email reading and `ASSISTANT_ENABLED=false`
turns off the planner, even when a model is configured. Every setting is listed in
[configuration.md](configuration.md#ai).

## Adding a provider

Providers live in [`server/src/llm/`](../server/src/llm). Anything OpenAI-compatible is
one entry in [`presets.ts`](../server/src/llm/presets.ts). A new wire format is one
adapter implementing `LlmProvider` from [`types.ts`](../server/src/llm/types.ts).
