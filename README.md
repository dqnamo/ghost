# Ghost

Ghost lets you invoke AI inline within Obsidian. Keep your AI conversations as files and maintain your flow.

## Features

- **Inline Generation**: Chat with AI directly in your editor (`@model prompt ;;`).
- **Multi-Model**: Access Claude, GPT-4, Llama, Gemini, and more via **OpenRouter**.
- **Context Aware**: The AI reads your current note to provide relevant answers.
- **Personas**: Create custom assistants with specific system prompts (e.g., `@editor`, `@coder`).
- **Web Search**: Access real-time info by appending `+web` to your prompt.
- **Streaming**: Fast, real-time responses.

## Usage

1.  **Type `@`** to select a model or persona.
2.  **Write your prompt**.
3.  **End with `;;`** (the default trigger phrase).

### Examples

**Standard Query:**
```text
@openai/gpt-4o-mini Summarize the key points above ;;
```

**Using a Persona:**
If you have a persona named "dev" defined:
```text
@dev Refactor this function for better performance ;;
```

**Web Search:**
```text
@google/gemini-flash-1.5 What is the latest Obsidian release? +web ;;
```

## Configuration

Go to **Settings > Ghost** to configure:

- **OpenRouter API Key**: Required for functionality.
- **Trigger Phrase**: Customize the `;;` trigger.
- **Response Style**: Choose between `Plain` text, `Callout` blocks, or `Horizontal Rules`.
- **Personas**: Define custom assistants with specific models and system prompts.
- **Web Search**: Configure search policy (Always, Trigger Only, Off) and engine.

## Installation

1.  Install via **BRAT** or manually copy `main.js`, `manifest.json`, and `styles.css` to your `.obsidian/plugins/ghost` folder.
2.  Enable in **Community Plugins**.
3.  Enter your [OpenRouter API Key](https://openrouter.ai/keys) in settings.

## License

0-BSD
