import { App, Editor, EditorSuggest, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, prepareFuzzySearch } from 'obsidian';

interface InlineAISettings {
    apiKey: string;
    enabledModels: string[];
    triggerPhrase: string;
}

const DEFAULT_SETTINGS: InlineAISettings = {
    apiKey: '',
    enabledModels: [
        "anthropic/claude-3.5-sonnet",
        "google/gemini-flash-1.5",
        "meta-llama/llama-3-70b-instruct",
        "openai/gpt-4o-mini"
    ],
    triggerPhrase: ';;'
}

interface OpenRouterResponse {
    choices: {
        delta?: {
            content?: string;
        }
    }[]
}

interface OpenRouterModel {
    id: string;
    name: string;
}

interface OpenRouterModelsResponse {
    data: OpenRouterModel[];
}

export default class InlineAI extends Plugin {
    settings: InlineAISettings;
    availableModels: OpenRouterModel[] = [];

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new InlineAISettingTab(this.app, this));
        this.registerEditorSuggest(new ModelSuggest(this.app, this));

        this.addCommand({
            id: 'trigger-inline-ai',
            name: 'Trigger inline AI',
            editorCallback: (editor: Editor) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                this.processStreamingQuery(editor, cursor.line, lineText);
            }
        });

        this.registerEvent(
            this.app.workspace.on('editor-change', (editor: Editor) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                if (lineText.endsWith(this.settings.triggerPhrase)) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    this.processStreamingQuery(editor, cursor.line, lineText);
                }
            })
        );
    }

    async processStreamingQuery(editor: Editor, lineNum: number, lineText: string) {
        // 1. Find the model definition looking backwards
        let modelLineNum = -1;
        let modelMatch = null;
        let model = "";
        const modelRegex = /@([\w/.-]+)/g;

        // Search backwards from current line to find the last @model usage
        for (let i = lineNum; i >= 0; i--) {
            const line = editor.getLine(i);
            const matches = [...line.matchAll(modelRegex)];
            if (matches.length > 0) {
                // Take the last match on this line
                const lastMatch = matches[matches.length - 1];
                if (lastMatch && lastMatch[1]) {
                    modelMatch = lastMatch;
                    modelLineNum = i;
                    model = lastMatch[1];
                    break;
                }
            }
        }

        if (!modelMatch || modelLineNum === -1) {
            new Notice("Inline AI: no model specified (e.g. @model-name).");
            return;
        }

        if (!this.settings.apiKey) {
            new Notice("API key missing.");
            return;
        }

        // 2. Extract Context and Prompt
        // Context: Everything from start of file up to the @model match
        const contextEnd = { line: modelLineNum, ch: modelMatch.index || 0 };
        const context = editor.getRange({ line: 0, ch: 0 }, contextEnd);

        // Determine prompt end and if we need to remove trigger phrase
        const triggerPhrase = this.settings.triggerPhrase;
        let promptEndCh = lineText.length;
        let shouldRemoveTrigger = false;

        if (lineText.endsWith(triggerPhrase)) {
            promptEndCh = lineText.length - triggerPhrase.length;
            shouldRemoveTrigger = true;
        }

        // Prompt: Everything from after @model match up to the trigger phrase/end of line
        const promptStart = { line: modelLineNum, ch: (modelMatch.index || 0) + modelMatch[0].length };
        const promptEnd = { line: lineNum, ch: promptEndCh };
        const prompt = editor.getRange(promptStart, promptEnd).trim();

        // 3. Remove the trigger phrase only (keep the prompt text visible as per user request)
        if (shouldRemoveTrigger) {
            editor.replaceRange("", { line: lineNum, ch: promptEndCh }, { line: lineNum, ch: lineText.length });
        }
        
        // 4. Prepare the placeholder
        // We insert after the trigger line
        const placeholderText = "*Generating...*";
        const placeholder = `\n\n${placeholderText}`;
        editor.replaceRange(placeholder, { line: lineNum, ch: promptEndCh }); // Appends new lines after where trigger was
        
        // Track where we are inserting text 
        let isFirstChunk = true;
        const generationLine = lineNum + 2; // \n\n adds 2 lines
        let currentInsertPos: EditorPosition = { line: generationLine, ch: 0 };

        // eslint-disable-next-line no-console
        console.log(`[Inline AI] processing query for model: ${model}, prompt length: ${prompt?.length}`);
        
        try {
            const requestBody = {
                model: model,
                stream: true, 
                messages: [
                    { role: 'system', content: `Context from the current note:\n${context}` },
                    { role: 'user', content: prompt }
                ],
            };
            
            // eslint-disable-next-line no-console
            console.log("[Inline AI] Sending request to OpenRouter:", JSON.stringify(requestBody, null, 2));

            // eslint-disable-next-line
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            });

            // eslint-disable-next-line no-console
            console.log(`[Inline AI] Response status: ${response.status} ${response.statusText}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error("[Inline AI] API Error:", errorText);
                new Notice(`Inline AI Error: ${response.status} - ${errorText.substring(0, 100)}`);
                return;
            }

            if (!response.body) {
                console.error("[Inline AI] Response body is empty");
                return;
            }

            // eslint-disable-next-line no-console
            console.log("[Inline AI] Response body received, starting stream read...");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // eslint-disable-next-line no-console
                    console.log("[Inline AI] Stream complete.");
                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                // eslint-disable-next-line no-console
                console.log("[Inline AI] Received chunk:", chunk);
                
                buffer += chunk;
                const lines = buffer.split('\n');
                
                // Keep the last line in the buffer as it might be incomplete
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;

                    // Skip OpenRouter keep-alive messages
                    if (trimmedLine === ': OPENROUTER PROCESSING') continue;

                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);
                        if (data === '[DONE]') continue;
                        
                        try {
                            const parsed = JSON.parse(data) as OpenRouterResponse;
                            const content = parsed.choices?.[0]?.delta?.content || "";
                            
                            if (content) {
                                if (isFirstChunk) {
                                    // Remove "Generating..." and start actual content
                                    // We replace the specific line where the placeholder was added
                                    
                                    // Make sure we are replacing valid range
                                    if (editor.lineCount() > generationLine) {
                                        const currentLineLen = editor.getLine(generationLine).length;
                                        // Ensure we don't delete text that might have been after the placeholder if user typed
                                        // But we assume placeholder is at start of line 0..placeholderText.length
                                        const replaceEndCh = Math.min(currentLineLen, placeholderText.length);

                                        editor.replaceRange(
                                            content, 
                                            { line: generationLine, ch: 0 }, 
                                            { line: generationLine, ch: replaceEndCh }
                                        );
                                        
                                        // Update position
                                        const lines = content.split('\n');
                                        if (lines.length > 1) {
                                            currentInsertPos = {
                                                line: generationLine + lines.length - 1,
                                                ch: (lines[lines.length - 1] || "").length
                                            };
                                        } else {
                                            currentInsertPos = {
                                                line: generationLine,
                                                ch: content.length
                                            };
                                        }
                                    } else {
                                        // Fallback if document changed
                                        const lastLine = editor.lineCount() - 1;
                                        const lastLineLen = editor.getLine(lastLine).length;
                                        editor.replaceRange(`\n\n${content}`, { line: lastLine, ch: lastLineLen });
                                        
                                        // Reset insert pos to end of doc
                                        const endLine = editor.lineCount() - 1;
                                        const endCh = editor.getLine(endLine).length;
                                        currentInsertPos = { line: endLine, ch: endCh };
                                    }
                                    isFirstChunk = false;
                                } else {
                                    // Append chunk at currentInsertPos
                                    editor.replaceRange(content, currentInsertPos);
                                    
                                    // Update position
                                    const lines = content.split('\n');
                                    if (lines.length > 1) {
                                        currentInsertPos = {
                                            line: currentInsertPos.line + lines.length - 1,
                                            ch: (lines[lines.length - 1] || "").length
                                        };
                                    } else {
                                        currentInsertPos = {
                                            line: currentInsertPos.line,
                                            ch: currentInsertPos.ch + content.length
                                        };
                                    }
                                }
                                
                                // Bring cursor to end
                                editor.setCursor(currentInsertPos);
                            }
                        } catch (e) {
                            console.error("[Inline AI] JSON Parse error:", e, "Data:", data);
                        }
                    } else if (trimmedLine.startsWith('error: ')) {
                        console.error("[Inline AI] Stream Error Line:", trimmedLine);
                        new Notice(`Stream Error: ${trimmedLine}`);
                    } else {
                         // eslint-disable-next-line no-console
                        console.log("[Inline AI] Unexpected line format:", trimmedLine);
                    }
                }
            }
        } catch (err) {
            new Notice("Streaming error.");
            console.error(err);
        }
    }

    async fetchOpenRouterModels() {
        if (!this.settings.apiKey) return;
        try {
            // eslint-disable-next-line
            const response = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'Authorization': `Bearer ${this.settings.apiKey}` }
            });
            const data = (await response.json()) as OpenRouterModelsResponse;
            if (data && data.data) {
                this.availableModels = data.data.map((m) => ({ id: m.id, name: m.name }));
            }
        } catch (error) {
            console.error('Inline AI: Failed to fetch models', error);
            new Notice('Inline AI: failed to fetch models');
        }
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as InlineAISettings; 
    }
    async saveSettings() { await this.saveData(this.settings); }
}

class ModelSuggest extends EditorSuggest<string> {
    plugin: InlineAI;
    constructor(app: App, plugin: InlineAI) { super(app); this.plugin = plugin; }
    
    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const lastAt = line.lastIndexOf('@');
        if (lastAt !== -1 && !line.slice(lastAt).includes(' ')) {
            return { start: { line: cursor.line, ch: lastAt }, end: cursor, query: line.substring(lastAt + 1, cursor.ch) };
        }
        return null;
    }
    
    getSuggestions(context: EditorSuggestContext) { 
        const query = context.query;
        if (!query) return this.plugin.settings.enabledModels;

        const fuzzySearch = prepareFuzzySearch(query);
        
        return this.plugin.settings.enabledModels
            .map(model => ({ model, match: fuzzySearch(model) }))
            .filter(result => result.match !== null)
            .sort((a, b) => (b.match?.score || 0) - (a.match?.score || 0))
            .map(result => result.model);
    }
    
    renderSuggestion(value: string, el: HTMLElement) { 
        el.setText(value);
    }
    
    selectSuggestion(value: string, evt: MouseEvent | KeyboardEvent) {
        if (this.context) {
            this.context.editor.replaceRange(`@${value} `, this.context.start, this.context.end);
        }
    }
}

class InlineAISettingTab extends PluginSettingTab {
    plugin: InlineAI;
    constructor(app: App, plugin: InlineAI) { super(app, plugin); this.plugin = plugin; }
    
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        new Setting(containerEl).setName('OpenRouter API key').addText(text => text
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl).setName('Trigger phrase').setDesc('The string that triggers the AI generation (default: ;;)').addText(text => text
            .setValue(this.plugin.settings.triggerPhrase)
            .onChange(async (v) => { this.plugin.settings.triggerPhrase = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl).setName('Models').setHeading();

        new Setting(containerEl)
            .setName('Manage models')
            .setDesc('Add or remove models from the suggestion list.')
            .addButton(btn => btn
                .setButtonText('Add model')
                .onClick(async () => {
                     if (this.plugin.availableModels.length === 0) {
                         // eslint-disable-next-line obsidianmd/ui/sentence-case
                         new Notice('Fetching models from OpenRouter...');
                         await this.plugin.fetchOpenRouterModels();
                     }
                     if (this.plugin.availableModels.length > 0) {
                         new ModelFuzzySuggestModal(this.plugin, () => this.display()).open();
                     }
                }));

        // List enabled models
        if (this.plugin.settings.enabledModels.length === 0) {
            containerEl.createEl('p', { text: 'No models enabled.' });
        } else {
            const sortedModels = [...this.plugin.settings.enabledModels].sort();

            for (const modelId of sortedModels) {
                new Setting(containerEl)
                    .setName(modelId)
                    .addButton(btn => btn
                        .setIcon('trash')
                        .setTooltip('Remove')
                        .onClick(async () => {
                            this.plugin.settings.enabledModels = this.plugin.settings.enabledModels.filter(m => m !== modelId);
                            await this.plugin.saveSettings();
                            this.display();
                        }));
            }
        }
    }
}

class ModelFuzzySuggestModal extends FuzzySuggestModal<OpenRouterModel> {
    plugin: InlineAI;
    onAdd: () => void;

    constructor(plugin: InlineAI, onAdd: () => void) {
        super(plugin.app);
        this.plugin = plugin;
        this.onAdd = onAdd;
    }

    getItems(): OpenRouterModel[] {
        return this.plugin.availableModels;
    }

    getItemText(item: OpenRouterModel): string {
        return `${item.name} (${item.id})`;
    }

    onChooseItem(item: OpenRouterModel, evt: MouseEvent | KeyboardEvent): void {
        if (!this.plugin.settings.enabledModels.includes(item.id)) {
            this.plugin.settings.enabledModels.push(item.id);
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.plugin.saveSettings();
            new Notice(`Added ${item.name}`);
            this.onAdd();
        } else {
            new Notice(`${item.name} is already enabled.`);
        }
    }
}
