import { App, Editor, EditorSuggest, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, FuzzySuggestModal, Modal, Notice, Plugin, PluginSettingTab, Setting, prepareFuzzySearch } from 'obsidian';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface Persona {
    name: string;
    model: string;
    systemPrompt: string;
}

interface GhostSettings {
    apiKey: string;
    enabledModels: string[];
    triggerPhrase: string;
    systemPrompt: string;
    cursorBehavior: 'keep' | 'end';
    responseStyle: 'plain' | 'horizontal-rule' | 'callout';
    personas: Persona[];
    webSearchPolicy: 'always' | 'trigger' | 'off';
    webSearchEngine: 'auto' | 'native' | 'exa';
}

const DEFAULT_SETTINGS: GhostSettings = {
    apiKey: '',
    enabledModels: [
        "anthropic/claude-3.5-sonnet",
        "google/gemini-flash-1.5",
        "meta-llama/llama-3-70b-instruct",
        "openai/gpt-4o-mini"
    ],
    triggerPhrase: ';;',
    systemPrompt: '',
    cursorBehavior: 'keep',
    responseStyle: 'plain',
    personas: [],
    webSearchPolicy: 'off',
    webSearchEngine: 'auto'
}

interface OpenRouterAnnotation {
    type: string;
    url_citation?: {
        url: string;
        title: string;
    };
}

interface OpenRouterResponse {
    choices: {
        delta?: {
            content?: string;
            annotations?: OpenRouterAnnotation[];
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

const spinnerPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = this.buildDecorations(update.view);
        }
    }

    buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        
        for (const { from, to } of view.visibleRanges) {
            for (let pos = from; pos <= to;) {
                const line = view.state.doc.lineAt(pos);
                const text = line.text;
                // Check if line starts with any spinner frame followed by " Generating..."
                const isSpinner = spinnerFrames.some(frame => text.startsWith(`${frame} Generating...`));
                
                if (isSpinner) {
                    builder.add(line.from, line.from, Decoration.line({ class: "ghost-spinner" }));
                }
                pos = line.to + 1;
            }
        }
        return builder.finish();
    }
}, {
    decorations: v => v.decorations
});

export default class GhostPlugin extends Plugin {
    settings: GhostSettings;
    availableModels: OpenRouterModel[] = [];

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new GhostSettingTab(this.app, this));
        this.registerEditorSuggest(new ModelSuggest(this.app, this));
        this.registerEditorExtension(spinnerPlugin);

        this.addCommand({
            id: 'trigger-ghost',
            name: 'Trigger Ghost',
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
            new Notice("Ghost: no model specified (e.g. @model-name).");
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
        let prompt = editor.getRange(promptStart, promptEnd).trim();

        // Check for +web flag
        let hasWebFlag = false;
        if (prompt.endsWith('+web')) {
            hasWebFlag = true;
            prompt = prompt.slice(0, -4).trim();
        }

        // 3. Remove the trigger phrase only (keep the prompt text visible as per user request)
        if (shouldRemoveTrigger) {
            editor.replaceRange("", { line: lineNum, ch: promptEndCh }, { line: lineNum, ch: lineText.length });
        }
        
        // 4. Prepare the placeholder
        // We insert after the trigger line
        const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let currentFrameIndex = 0;
        const getSpinnerText = () => `${spinnerFrames[currentFrameIndex]} Generating...`;
        
        let prefix = "\n\n";
        let spinnerPrefix = "";
        let generationLineOffset = 2;

        if (this.settings.responseStyle === 'horizontal-rule') {
            prefix = "\n\n---\n\n";
            generationLineOffset = 4;
        } else if (this.settings.responseStyle === 'callout') {
            prefix = "\n\n> [!ai] Ghost\n> ";
            spinnerPrefix = "> ";
            generationLineOffset = 3;
        }

        const placeholder = `${prefix}${getSpinnerText()}`;
        editor.replaceRange(placeholder, { line: lineNum, ch: promptEndCh }); // Appends new lines after where trigger was
        
        // Track where we are inserting text 
        let isFirstChunk = true;
        const generationLine = lineNum + generationLineOffset;
        let currentInsertPos: EditorPosition = { line: generationLine, ch: 0 };
        
        let loadingInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
            currentFrameIndex = (currentFrameIndex + 1) % spinnerFrames.length;
            if (editor.lineCount() > generationLine) {
                const lineContent = editor.getLine(generationLine);
                const checkContent = this.settings.responseStyle === 'callout' ? lineContent.substring(2) : lineContent;

                // Only update if the line looks like our spinner (starts with ⠋..⠏) to avoid overwriting user content if shifted
                if (spinnerFrames.some(f => checkContent.startsWith(f))) {
                     editor.replaceRange(
                        `${spinnerPrefix}${getSpinnerText()}`, 
                        { line: generationLine, ch: 0 }, 
                        { line: generationLine, ch: lineContent.length }
                    );
                }
            } else {
                if (loadingInterval) clearInterval(loadingInterval);
            }
        }, 100);

        // eslint-disable-next-line no-console
        console.log(`[Ghost] processing query for model: ${model}, prompt length: ${prompt?.length}`);
        
        try {
            // Check if model is a persona
            const persona = this.settings.personas.find(p => p.name === model);
            
            let targetModel = model;
            let systemInstruction = this.settings.systemPrompt;

            if (persona) {
                targetModel = persona.model;
                systemInstruction = persona.systemPrompt;
            }

            const systemPrompt = systemInstruction 
                ? `${systemInstruction}\n\nContext from the current note:\n${context}`
                : `Context from the current note:\n${context}`;

            const requestBody: any = {
                model: targetModel,
                stream: true, 
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
            };

            let shouldSearch = false;
            switch (this.settings.webSearchPolicy) {
                case 'always': shouldSearch = true; break;
                case 'trigger': shouldSearch = hasWebFlag; break;
                case 'off': shouldSearch = false; break;
            }

            if (shouldSearch) {
                requestBody.plugins = [{
                    id: "web",
                    engine: this.settings.webSearchEngine === 'auto' ? undefined : this.settings.webSearchEngine
                }];
            }
            
            // eslint-disable-next-line no-console
            console.log("[Ghost] Sending request to OpenRouter:", JSON.stringify(requestBody, null, 2));

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
            console.log(`[Ghost] Response status: ${response.status} ${response.statusText}`);

            if (!response.ok) {
                if (loadingInterval) clearInterval(loadingInterval);
                const errorText = await response.text();
                console.error("[Ghost] API Error:", errorText);
                new Notice(`Ghost Error: ${response.status} - ${errorText.substring(0, 100)}`);
                return;
            }

            if (!response.body) {
                if (loadingInterval) clearInterval(loadingInterval);
                console.error("[Ghost] Response body is empty");
                return;
            }

            // eslint-disable-next-line no-console
            console.log("[Ghost] Response body received, starting stream read...");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let collectedAnnotations: OpenRouterAnnotation[] = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // eslint-disable-next-line no-console
                    console.log("[Ghost] Stream complete.");

                    // Append Sources if any were found
                    if (collectedAnnotations.length > 0) {
                        const uniqueSources = new Map<string, string>();
                        collectedAnnotations.forEach(a => {
                            if (a.url_citation) {
                                uniqueSources.set(a.url_citation.url, a.url_citation.title || a.url_citation.url);
                            }
                        });

                        if (uniqueSources.size > 0) {
                            let sourcesText = "\n\n**Sources:**\n";
                            uniqueSources.forEach((title, url) => {
                                sourcesText += `- [${title}](${url})\n`;
                            });

                            if (this.settings.responseStyle === 'callout') {
                                sourcesText = sourcesText.replace(/\n/g, '\n> ');
                            }

                            // Append to the end of the current insertion
                            editor.replaceRange(sourcesText, currentInsertPos);
                            
                            // Update cursor position to end of sources
                            const lines = sourcesText.split('\n');
                            currentInsertPos = {
                                line: currentInsertPos.line + lines.length - 1,
                                ch: (lines[lines.length - 1] || "").length
                            };
                        }
                    }

                    if (this.settings.responseStyle === 'horizontal-rule') {
                        const divider = "\n\n---";
                        editor.replaceRange(divider, currentInsertPos);
                        
                        const lines = divider.split('\n');
                        currentInsertPos = {
                            line: currentInsertPos.line + lines.length - 1,
                            ch: (lines[lines.length - 1] || "").length
                        };
                    }

                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                // eslint-disable-next-line no-console
                console.log("[Ghost] Received chunk:", chunk);
                
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
                            const choice = parsed.choices?.[0];
                            const delta = choice?.delta;
                            const content = delta?.content || "";
                            
                             // Collect annotations if present
                            if (delta?.annotations) {
                                collectedAnnotations.push(...delta.annotations);
                            }
                            
                            if (content) {
                                let displayContent = content;
                                if (this.settings.responseStyle === 'callout') {
                                    displayContent = content.replace(/\n/g, '\n> ');
                                }

                                if (isFirstChunk) {
                                    if (loadingInterval) {
                                        clearInterval(loadingInterval);
                                        loadingInterval = null;
                                    }
                                    
                                    // Make sure we are replacing valid range
                                    if (editor.lineCount() > generationLine) {
                                        const currentLineLen = editor.getLine(generationLine).length;
                                        
                                        if (this.settings.responseStyle === 'callout') {
                                            displayContent = "> " + displayContent;
                                        }

                                        // Replace the entire placeholder line with the first chunk
                                        editor.replaceRange(
                                            displayContent, 
                                            { line: generationLine, ch: 0 }, 
                                            { line: generationLine, ch: currentLineLen }
                                        );
                                        
                                        // Update position
                                        const lines = displayContent.split('\n');
                                        if (lines.length > 1) {
                                            currentInsertPos = {
                                                line: generationLine + lines.length - 1,
                                                ch: (lines[lines.length - 1] || "").length
                                            };
                                        } else {
                                            currentInsertPos = {
                                                line: generationLine,
                                                ch: displayContent.length
                                            };
                                        }
                                    } else {
                                        // Fallback if document changed
                                        const lastLine = editor.lineCount() - 1;
                                        const lastLineLen = editor.getLine(lastLine).length;
                                        
                                        let fallbackContent = content;
                                        if (this.settings.responseStyle === 'callout') {
                                            fallbackContent = `\n> ${content.replace(/\n/g, '\n> ')}`;
                                        }
                                        
                                        editor.replaceRange(`\n\n${fallbackContent}`, { line: lastLine, ch: lastLineLen });
                                        
                                        // Reset insert pos to end of doc
                                        const endLine = editor.lineCount() - 1;
                                        const endCh = editor.getLine(endLine).length;
                                        currentInsertPos = { line: endLine, ch: endCh };
                                    }
                                    isFirstChunk = false;
                                } else {
                                    // Append chunk at currentInsertPos
                                    editor.replaceRange(displayContent, currentInsertPos);
                                    
                                    // Update position
                                    const lines = displayContent.split('\n');
                                    if (lines.length > 1) {
                                        currentInsertPos = {
                                            line: currentInsertPos.line + lines.length - 1,
                                            ch: (lines[lines.length - 1] || "").length
                                        };
                                    } else {
                                        currentInsertPos = {
                                            line: currentInsertPos.line,
                                            ch: currentInsertPos.ch + displayContent.length
                                        };
                                    }
                                }
                                
                                // Bring cursor to end
                                // editor.setCursor(currentInsertPos);
                            }
                        } catch (e) {
                            console.error("[Ghost] JSON Parse error:", e, "Data:", data);
                        }
                    } else if (trimmedLine.startsWith('error: ')) {
                        console.error("[Ghost] Stream Error Line:", trimmedLine);
                        new Notice(`Stream Error: ${trimmedLine}`);
                    } else {
                         // eslint-disable-next-line no-console
                        console.log("[Ghost] Unexpected line format:", trimmedLine);
                    }
                }
            }
            
            if (this.settings.cursorBehavior === 'end') {
                if (currentInsertPos.ch !== 0) {
                    editor.replaceRange('\n', currentInsertPos);
                    currentInsertPos = { line: currentInsertPos.line + 1, ch: 0 };
                }
                editor.setCursor(currentInsertPos);
            }

        } catch (err) {
            if (loadingInterval) clearInterval(loadingInterval);
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
            console.error('Ghost: Failed to fetch models', error);
            new Notice('Ghost: failed to fetch models');
        }
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as GhostSettings; 
    }
    async saveSettings() { await this.saveData(this.settings); }
}

class ModelSuggest extends EditorSuggest<string> {
    plugin: GhostPlugin;
    constructor(app: App, plugin: GhostPlugin) { super(app); this.plugin = plugin; }
    
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
        const allSuggestions = [
            ...this.plugin.settings.personas.map(p => p.name),
            ...this.plugin.settings.enabledModels
        ];

        if (!query) return allSuggestions;

        const fuzzySearch = prepareFuzzySearch(query);
        
        return allSuggestions
            .map(item => ({ item, match: fuzzySearch(item) }))
            .filter(result => result.match !== null)
            .sort((a, b) => (b.match?.score || 0) - (a.match?.score || 0))
            .map(result => result.item);
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

class GhostSettingTab extends PluginSettingTab {
    plugin: GhostPlugin;
    constructor(app: App, plugin: GhostPlugin) { super(app, plugin); this.plugin = plugin; }
    
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

        new Setting(containerEl)
            .setName('Cursor behavior')
            .setDesc('Where to place the cursor after generation is complete.')
            .addDropdown(dropdown => dropdown
                .addOption('keep', 'Stay where it is')
                .addOption('end', 'Move to next line')
                .setValue(this.plugin.settings.cursorBehavior)
                .onChange(async (v) => { 
                    this.plugin.settings.cursorBehavior = v as 'keep' | 'end'; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName('Response style')
            .setDesc('How to display the AI response.')
            .addDropdown(dropdown => dropdown
                .addOption('plain', 'Plain text (Co-writer)')
                .addOption('horizontal-rule', 'Horizontal rule (Divider)')
                .addOption('callout', 'Callout block')
                .setValue(this.plugin.settings.responseStyle)
                .onChange(async (v) => { 
                    this.plugin.settings.responseStyle = v as 'plain' | 'horizontal-rule' | 'callout'; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName('System prompt')
            .setDesc('Custom instructions for the AI assistant')
            .addTextArea(text => text
                .setPlaceholder('You are a helpful assistant...')
                .setValue(this.plugin.settings.systemPrompt)
                .onChange(async (v) => { 
                    this.plugin.settings.systemPrompt = v; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl).setName('Models').setHeading();

        new Setting(containerEl)
            .setName('Web Search Policy')
            .setDesc('Control when to use online search.')
            .addDropdown(dropdown => dropdown
                .addOption('off', 'Disabled (Never)')
                .addOption('always', 'Always On')
                .addOption('trigger', 'Trigger (+web)')
                .setValue(this.plugin.settings.webSearchPolicy)
                .onChange(async (v) => {
                    this.plugin.settings.webSearchPolicy = v as 'always' | 'trigger' | 'off';
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide engine option
                }));

        if (this.plugin.settings.webSearchPolicy !== 'off') {
            new Setting(containerEl)
                .setName('Web Search Engine')
                .setDesc('Select the search engine provider.')
                .addDropdown(dropdown => dropdown
                    .addOption('auto', 'Auto (Native if available, else Exa)')
                    .addOption('native', 'Native (Provider specific)')
                    .addOption('exa', 'Exa (Independent)')
                    .setValue(this.plugin.settings.webSearchEngine)
                    .onChange(async (v) => {
                        this.plugin.settings.webSearchEngine = v as 'auto' | 'native' | 'exa';
                        await this.plugin.saveSettings();
                    }));
        }

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

        new Setting(containerEl).setName('Personas').setHeading();

        new Setting(containerEl)
            .setName('Manage personas')
            .setDesc('Create custom personas with specific models and system prompts.')
            .addButton(btn => btn
                .setButtonText('Add persona')
                .onClick(() => {
                    new PersonaModal(this.app, this.plugin, null, async (newPersona) => {
                        this.plugin.settings.personas.push(newPersona);
                        await this.plugin.saveSettings();
                        this.display();
                    }).open();
                }));
        
        if (this.plugin.settings.personas.length === 0) {
            containerEl.createEl('p', { text: 'No personas defined.' });
        } else {
             for (const persona of this.plugin.settings.personas) {
                new Setting(containerEl)
                    .setName(persona.name)
                    .setDesc(persona.model)
                    .addButton(btn => btn
                        .setIcon('pencil')
                        .setTooltip('Edit')
                        .onClick(() => {
                            new PersonaModal(this.app, this.plugin, persona, async (updatedPersona) => {
                                Object.assign(persona, updatedPersona);
                                await this.plugin.saveSettings();
                                this.display();
                            }).open();
                        }))
                    .addButton(btn => btn
                        .setIcon('trash')
                        .setTooltip('Remove')
                        .onClick(async () => {
                            this.plugin.settings.personas = this.plugin.settings.personas.filter(p => p !== persona);
                            await this.plugin.saveSettings();
                            this.display();
                        }));
             }
        }
    }
}

class ModelFuzzySuggestModal extends FuzzySuggestModal<OpenRouterModel> {
    plugin: GhostPlugin;
    onAdd: () => void;

    constructor(plugin: GhostPlugin, onAdd: () => void) {
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

class PersonaModal extends Modal {
    plugin: GhostPlugin;
    persona: Persona;
    onSubmit: (persona: Persona) => Promise<void> | void;

    constructor(app: App, plugin: GhostPlugin, persona: Persona | null, onSubmit: (persona: Persona) => Promise<void> | void) {
        super(app);
        this.plugin = plugin;
        this.persona = persona || { name: '', model: plugin.settings.enabledModels[0] || '', systemPrompt: '' };
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.createEl('h2', { text: this.persona.name ? 'Edit persona' : 'New persona' });

        new Setting(contentEl)
            .setName('Name')
            .setDesc('Name for the persona (no spaces allowed for @ mention)')
            .addText(text => text
                .setValue(this.persona.name)
                .onChange(value => {
                    this.persona.name = value.replace(/\s+/g, '');
                }));

        new Setting(contentEl)
            .setName('Model')
            .setDesc('Select the model for this persona')
            .addDropdown(dropdown => {
                if (this.plugin.settings.enabledModels.length > 0) {
                    this.plugin.settings.enabledModels.forEach(model => {
                        dropdown.addOption(model, model);
                    });
                } else {
                    dropdown.addOption('', 'No enabled models');
                }
                dropdown.setValue(this.persona.model);
                dropdown.onChange(value => this.persona.model = value);
            });

        new Setting(contentEl)
            .setName('System prompt')
            .setDesc('Instructions for this persona')
            .addTextArea(text => text
                .setValue(this.persona.systemPrompt)
                .onChange(value => this.persona.systemPrompt = value));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Save')
                .setCta()
                .onClick(() => {
                    if (!this.persona.name) {
                        new Notice('Persona name is required');
                        return;
                    }
                    if (!this.persona.model) {
                         new Notice('Persona model is required. Please enable models first.');
                         return;
                    }
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    this.onSubmit(this.persona);
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
