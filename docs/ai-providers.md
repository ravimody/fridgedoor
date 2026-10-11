# Choosing an AI provider

Fridgedoor uses an AI model to read email, understand what you type or photograph, and
write the morning brief. You bring the model: paste an API key in **Settings → AI** (or
during setup), pick a model, and press **Test connection**. You can switch at any time.

## Which one?

| Provider | Why pick it | Key |
| --- | --- | --- |
| **Anthropic (Claude)** | Excellent at careful reading and following instructions. | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenAI (GPT)** | Strong all-rounder; supports web lookups for the assistant and voice transcription. | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Google Gemini** | Generous free tier for light use. | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **OpenRouter** | One key, hundreds of models from many companies; easy to compare. | [openrouter.ai](https://openrouter.ai/settings/keys) |
| **Groq, Mistral, DeepSeek, xAI, Together, Fireworks** | Fast or inexpensive alternatives. | Each provider's console |
| **Azure OpenAI** | Your organization already uses Azure. | Azure portal |
| **Ollama, LM Studio, llama.cpp, vLLM** | Nothing leaves your network. Needs a capable computer; small models miss details. Use the computer's address, or `host.docker.internal` when it runs on the same machine as Fridgedoor. | None |
| **Other** | Anything that speaks the OpenAI Chat Completions API (LiteLLM, LocalAI, a gateway). | Depends |

**Two models:** the main model handles the assistant, briefs and household knowledge.
Optionally choose a cheaper, faster **email model** for reading incoming mail, which is
where most of the volume is. Optionally add a stronger **review model**: the email
model then only screens each message, and the review model reads the ones it flags.

**What the model must do:** return structured JSON (every listed provider supports
this) and, for the assistant, call tools. Models that can read images and PDFs give the
best results with flyers and attachments; without that, Fridgedoor tells the model an
attachment was skipped.

## Costs

You pay the provider directly, per use. A household receiving 30-60 emails a day and
using the assistant a few times a day typically spends a few dollars a month with a
mid-sized model; a small email model brings that down further. Fridgedoor also has
per-person hourly and daily limits on background email reading. Set a monthly budget
in your provider's console.

## Features that depend on the provider

| Feature | Works with |
| --- | --- |
| Reading emails, photos, PDFs; the assistant; briefs | Every provider (images/PDFs need a vision-capable model) |
| Looking up places and recipes on the web for the assistant | OpenAI, Anthropic |
| Server-side voice transcription in the web app | OpenAI, Groq (the iPhone app transcribes on the phone) |

## Setting it with environment variables instead

For scripted installs, set these in `.env`; the web app then shows the AI settings as
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
turns off the assistant, even when a model is configured.

## Adding a provider

Providers live in [`server/src/llm/`](../server/src/llm). Anything OpenAI-compatible is
one entry in [`presets.ts`](../server/src/llm/presets.ts); a new wire format is one
adapter implementing `LlmProvider` from [`types.ts`](../server/src/llm/types.ts).
