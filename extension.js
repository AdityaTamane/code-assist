const vscode = require('vscode');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

class AICodeAssistant {
    constructor(context) {
        this.context = context;
        // Retrieve API key securely from VS Code secrets
        this.openai = null; // Initialize later once API key is retrieved
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('aiAssistant');
        
        this.initializeOpenAI(); // Call an async function to get the API key
        this.registerCommands();
        this.setupEventListeners();
    }

    async initializeOpenAI() {
        try {
            const apiKey = await this.context.secrets.get('openaiApiKey');
            if (apiKey) {
                this.openai = new OpenAI({ apiKey: apiKey });
            } else {
                vscode.window.showWarningMessage('OpenAI API Key not found. Please set it via "AI Code Assistant: Set OpenAI API Key" command.');
                this.promptForApiKey();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to retrieve OpenAI API Key: ${error.message}`);
        }
    }

    async promptForApiKey() {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your OpenAI API Key',
            ignoreFocusOut: true, // Keep the input box open even if focus is lost
            password: true // Mask the input
        });

        if (apiKey) {
            await this.context.secrets.store('openaiApiKey', apiKey);
            this.openai = new OpenAI({ apiKey: apiKey });
            vscode.window.showInformationMessage('OpenAI API Key successfully set!');
        } else {
            vscode.window.showWarningMessage('OpenAI API Key not set. AI Code Assistant features will be limited.');
        }
    }

    registerCommands() {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('aiAssistant.analyze', () => this.analyzeCodebase()),
            vscode.commands.registerCommand('aiAssistant.suggestChanges', () => this.suggestChanges()),
            vscode.commands.registerCommand('aiAssistant.applyChanges', (changes) => this.applyChanges(changes)),
            vscode.commands.registerCommand('aiAssistant.setApiKey', () => this.promptForApiKey()), // New command to set API key
            vscode.commands.registerCommand('test.command', () => {
                vscode.window.showInformationMessage('Test command works!');
            })
        );
    }

    setupEventListeners() {
        // Debounce the analysis to avoid excessive API calls on rapid file changes/switches
        let analyzeCurrentFileDebounced = this.debounce(() => this.analyzeCurrentFile(), 500);
        vscode.workspace.onDidOpenTextDocument(analyzeCurrentFileDebounced);
        vscode.window.onDidChangeActiveTextEditor(analyzeCurrentFileDebounced);
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                analyzeCurrentFileDebounced();
            }
        });
    }

    debounce(func, delay) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    async analyzeCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.diagnosticCollection.clear(); // Clear diagnostics if no active editor
            return;
        }

        const document = editor.document;
        const code = document.getText();
        const languageId = document.languageId;

        // Clear existing diagnostics for the current file before re-analyzing
        this.diagnosticCollection.set(document.uri, []);

        if (!this.openai) {
            vscode.window.showWarningMessage('OpenAI API Key is not set. Cannot analyze current file.');
            return;
        }

        try {
            vscode.window.setStatusBarMessage(`$(sync~spin) Analyzing current file...`, this.analyzeCode(code, languageId).then(analysis => {
                this.displayAnalysis(analysis, document);
                vscode.window.setStatusBarMessage(`$(check) File analysis complete.`, 3000);
            }).catch(error => {
                vscode.window.showErrorMessage(`Analysis failed: ${error.message}`);
                vscode.window.setStatusBarMessage(`$(error) Analysis failed.`, 3000);
            }));
        } catch (error) {
            vscode.window.showErrorMessage(`Analysis failed: ${error.message}`);
        }
    }

    async analyzeCodebase() {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open. Cannot analyze codebase.');
            return;
        }

        if (!this.openai) {
            vscode.window.showWarningMessage('OpenAI API Key is not set. Cannot analyze codebase.');
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Analyzing codebase...",
            cancellable: true
        }, async (progress, token) => {
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const files = await this.getCodeFiles(workspaceFolder);
                
                if (files.length === 0) {
                    vscode.window.showInformationMessage('No supported code files found in the workspace.');
                    return;
                }

                progress.report({ increment: 0, message: "Processing files..." });
                
                let processed = 0;
                let allDiagnostics = [];
                for (const file of files) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage('Codebase analysis cancelled.');
                        return;
                    }
                    
                    try {
                        const code = fs.readFileSync(file, 'utf-8');
                        const languageId = this.getLanguageIdFromFileExtension(file);
                        
                        // Skip analysis if languageId is not recognized or not a common coding language
                        if (!languageId || !['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'cpp', 'csharp', 'php', 'ruby'].includes(languageId)) {
                            processed++;
                            progress.report({ 
                                increment: (processed / files.length) * 100,
                                message: `Skipping unsupported file: ${path.basename(file)}`
                            });
                            continue;
                        }

                        const analysis = await this.analyzeCode(code, languageId);
                        const documentUri = vscode.Uri.file(file);
                        this.applyAnalysisAsDiagnostics(analysis, documentUri);

                        // Accumulate diagnostics for a comprehensive report if desired, though current display only handles one file.
                        // For a full codebase analysis report, you might need a different UI or approach.
                        // allDiagnostics.push({ uri: documentUri, diagnostics: this.convertAnalysisToDiagnostics(analysis, documentUri) });

                    } catch (fileError) {
                        vscode.window.showWarningMessage(`Failed to analyze ${path.basename(file)}: ${fileError.message}`);
                    } finally {
                        processed++;
                        progress.report({ 
                            increment: (processed / files.length) * 100,
                            message: `Analyzed ${path.basename(file)} (${processed}/${files.length})`
                        });
                    }
                }
                
                vscode.window.showInformationMessage('Codebase analysis completed. Diagnostics displayed in relevant files.');
            } catch (error) {
                vscode.window.showErrorMessage(`Codebase analysis failed: ${error.message}`);
            }
        });
    }

    async getCodeFiles(folder) {
        // Explicitly define common code file extensions and their corresponding language IDs
        const extensionToLanguageId = {
            '.js': 'javascript',
            '.ts': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.go': 'go',
            '.rs': 'rust',
            '.cpp': 'cpp',
            '.c': 'c', // Added C
            '.cs': 'csharp',
            '.php': 'php',
            '.rb': 'ruby',
            '.json': 'json', // Often contains configuration/data, useful for analysis
            '.xml': 'xml',
            '.html': 'html',
            '.css': 'css'
        };
        const supportedExtensions = Object.keys(extensionToLanguageId);
        const files = [];
        
        const walkDir = (dir) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    // Skip common ignored directories like node_modules, .git, etc.
                    if (['node_modules', '.git', '.vscode', 'build', 'dist'].includes(item.name)) {
                        continue;
                    }
                    walkDir(fullPath);
                } else if (supportedExtensions.includes(path.extname(item.name).toLowerCase())) {
                    files.push(fullPath);
                }
            }
        };
        
        walkDir(folder);
        return files;
    }

    getLanguageIdFromFileExtension(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const extensionToLanguageId = {
            '.js': 'javascript',
            '.ts': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.go': 'go',
            '.rs': 'rust',
            '.cpp': 'cpp',
            '.c': 'c',
            '.cs': 'csharp',
            '.php': 'php',
            '.rb': 'ruby',
            '.json': 'json',
            '.xml': 'xml',
            '.html': 'html',
            '.css': 'css'
        };
        return extensionToLanguageId[ext];
    }

    async analyzeCode(code, languageId) {
        if (!this.openai) {
            throw new Error('OpenAI API client is not initialized. Please set your API key.');
        }
        
        // Refined prompt for better JSON output and explicit handling of code blocks
        const prompt = `
Analyze the following ${languageId} code and provide detailed feedback.
Your response MUST be a JSON object with the following structure:
{
    "issues": [
        {
            "type": "Bug" | "Code Smell" | "Security Vulnerability" | "Performance Issue",
            "description": "A clear description of the issue.",
            "severity": "Error" | "Warning" | "Information",
            "line": number, // Optional: The line number where the issue starts (0-indexed)
            "column": number // Optional: The column number where the issue starts (0-indexed)
        }
    ],
    "suggestions": [
        {
            "description": "A general suggestion for improvement.",
            "type": "Refactoring" | "Best Practice" | "Readability"
        }
    ],
    "improvements": [
        {
            "description": "A specific, actionable performance improvement.",
            "type": "Performance"
        }
    ]
}

If no issues, suggestions, or improvements are found, return empty arrays.
Ensure the JSON is perfectly parseable. Do NOT include any other text or markdown outside the JSON.

Code:
\`\`\`${languageId}
${code}
\`\`\`
`;

        try {
            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o", // Using a more capable model if available and desired
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
                response_format: { type: "json_object" }, // Requesting JSON object output
                max_tokens: 2000
            });

            const rawResponseContent = completion.choices[0].message.content;
            // Clean the response by removing markdown code blocks if the model insists on them
            const jsonString = rawResponseContent.replace(/```json\n?|\n?```/g, '').trim();
            return JSON.parse(jsonString);
        } catch (error) {
            console.error("Error calling OpenAI API or parsing response:", error);
            throw new Error(`Failed to get analysis from AI: ${error.message}. Raw response: ${error.response ? JSON.stringify(error.response.data) : 'N/A'}`);
        }
    }

    applyAnalysisAsDiagnostics(analysis, documentUri) {
        const diagnostics = [];
        analysis.issues.forEach(issue => {
            // Default to start of document if line/column are not provided or invalid
            const line = typeof issue.line === 'number' && issue.line >= 0 ? issue.line : 0;
            const column = typeof issue.column === 'number' && issue.column >= 0 ? issue.column : 0;
            const range = new vscode.Range(
                new vscode.Position(line, column),
                new vscode.Position(line, column + 1) // A single character range or expand as needed
            );
            
            let severity;
            switch (issue.severity?.toLowerCase()) {
                case 'error':
                    severity = vscode.DiagnosticSeverity.Error;
                    break;
                case 'warning':
                    severity = vscode.DiagnosticSeverity.Warning;
                    break;
                case 'information':
                    severity = vscode.DiagnosticSeverity.Information;
                    break;
                default:
                    severity = vscode.DiagnosticSeverity.Warning; // Default to warning
            }

            diagnostics.push(new vscode.Diagnostic(
                range,
                `${issue.type}: ${issue.description}`,
                severity
            ));
        });
        this.diagnosticCollection.set(documentUri, diagnostics);
    }

    displayAnalysis(analysis, document) {
        this.applyAnalysisAsDiagnostics(analysis, document.uri); // Also display as diagnostics

        const panel = vscode.window.createWebviewPanel(
            'aiAnalysis',
            'AI Code Analysis',
            vscode.ViewColumn.Two,
            { enableScripts: true } // Enable scripts for webview
        );
        
        panel.webview.html = this.getAnalysisWebviewContent(analysis);

        // Handle messages from the webview (e.g., "Request Code Changes" button)
        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'requestChanges':
                        this.suggestChanges(); // Trigger suggestChanges command
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    getAnalysisWebviewContent(analysis) {
        // Ensure data is structured for display even if parts are missing
        const issuesHtml = analysis.issues && analysis.issues.length > 0
            ? analysis.issues.map(issue => `<div class="issue"><strong>${issue.type || 'Issue'}</strong>: ${issue.description} (Line: ${issue.line !== undefined ? issue.line + 1 : 'N/A'})</div>`).join('')
            : '<p>No issues found.</p>';

        const suggestionsHtml = analysis.suggestions && analysis.suggestions.length > 0
            ? analysis.suggestions.map(suggestion => `<div class="suggestion">${suggestion.description || suggestion}</div>`).join('')
            : '<p>No suggestions found.</p>';
        
        const improvementsHtml = analysis.improvements && analysis.improvements.length > 0
            ? analysis.improvements.map(improvement => `<div class="improvement">${improvement.description || improvement}</div>`).join('')
            : '<p>No performance improvements found.</p>';

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                h1, h2 { color: var(--vscode-textLink-foreground); }
                .section { margin-bottom: 20px; border-bottom: 1px solid var(--vscode-list-hoverBackground); padding-bottom: 10px; }
                .issue { background: var(--vscode-editorWarning-background); padding: 10px; margin: 5px 0; border-left: 3px solid var(--vscode-editorWarning-foreground); }
                .suggestion { background: var(--vscode-editorInfo-background); padding: 10px; margin: 5px 0; border-left: 3px solid var(--vscode-editorInfo-foreground); }
                .improvement { background: var(--vscode-editorGutter-addedBackground); padding: 10px; margin: 5px 0; border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground); }
                button { 
                    background: var(--vscode-button-background); 
                    color: var(--vscode-button-foreground); 
                    border: none; 
                    padding: 8px 16px; 
                    border-radius: 4px; 
                    cursor: pointer; 
                    margin-top: 10px;
                }
                button:hover { background: var(--vscode-button-hoverBackground); }
            </style>
        </head>
        <body>
            <h1>AI Code Analysis</h1>
            
            <div class="section">
                <h2>Issues</h2>
                ${issuesHtml}
            </div>
            
            <div class="section">
                <h2>Suggestions</h2>
                ${suggestionsHtml}
            </div>
            
            <div class="section">
                <h2>Improvements</h2>
                ${improvementsHtml}
            </div>
            
            <button onclick="requestChanges()">Request Code Changes</button>
            
            <script>
                const vscode = acquireVsCodeApi();
                function requestChanges() {
                    vscode.postMessage({
                        command: 'requestChanges'
                    });
                }
            </script>
        </body>
        </html>
        `;
    }

    async suggestChanges() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor to suggest changes for.');
            return;
        }

        if (!this.openai) {
            vscode.window.showWarningMessage('OpenAI API Key is not set. Cannot suggest changes.');
            return;
        }

        const document = editor.document;
        const code = document.getText();
        const languageId = document.languageId;

        const userRequest = await vscode.window.showInputBox({
            prompt: 'What changes would you like to make? (e.g., "Add error handling to this function", "Refactor this loop")',
            placeHolder: 'Describe the desired changes...',
            ignoreFocusOut: true
        });

        if (!userRequest) {
            vscode.window.showInformationMessage('Code change request cancelled.');
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Generating suggestions...",
            cancellable: false
        }, async () => {
            try {
                const prompt = `
Current ${languageId} code:
\`\`\`${languageId}
${code}
\`\`\`
User request:
${userRequest}

Analyze the user's request in the context of the provided code and generate a response that outlines specific code changes.
Your response MUST be a JSON object with the following structure:
{
    "description": "A concise explanation of the proposed changes.",
    "changes": [
        {
            "range": { 
                "start": { "line": number, "character": number }, 
                "end": { "line": number, "character": number } 
            },
            "newText": "string", // The new code to insert or replace with
            "originalText": "string" // Optional: The original text that will be replaced, for diffing.
        }
    ]
}
The 'line' and 'character' properties in 'range' should be 0-indexed.
If no changes are suggested, return an empty 'changes' array.
Ensure the JSON is perfectly parseable. Do NOT include any other text or markdown outside the JSON.
`;

                const completion = await this.openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.4, // Slightly higher temperature for creative suggestions
                    response_format: { type: "json_object" },
                    max_tokens: 2000
                });

                const rawResponseContent = completion.choices[0].message.content;
                const jsonString = rawResponseContent.replace(/```json\n?|\n?```/g, '').trim();
                const changes = JSON.parse(jsonString);

                if (!changes || !Array.isArray(changes.changes) || changes.changes.length === 0) {
                    vscode.window.showInformationMessage('AI did not suggest any changes for your request.');
                    return;
                }

                this.previewChanges(changes, document);
            } catch (error) {
                console.error("Error generating suggestions:", error);
                vscode.window.showErrorMessage(`Failed to generate suggestions: ${error.message}. Please check the output for more details.`);
            }
        });
    }

    previewChanges(changes, document) {
        const panel = vscode.window.createWebviewPanel(
            'aiChanges',
            'AI Suggested Changes Preview',
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = this.getChangesWebviewContent(changes, document);
        panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'applyChanges') {
                    this.applyChanges(changes);
                    panel.dispose(); // Close the webview after applying changes
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    getChangesWebviewContent(changes, document) {
        const diffHtml = changes.changes.map((change, i) => {
            const startPos = new vscode.Position(change.range.start.line, change.range.start.character);
            const endPos = new vscode.Position(change.range.end.line, change.range.end.character);
            const originalText = document.getText(new vscode.Range(startPos, endPos));
            
            // Pass originalText to generateDiffView
            return `
                <div class="change">
                    <h3>Change ${i + 1} (Line ${startPos.line + 1})</h3>
                    <div class="diff">${this.generateDiffView(originalText, change.newText)}</div>
                </div>
            `;
        }).join('');

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                h1, h2, h3 { color: var(--vscode-textLink-foreground); }
                .change { background: var(--vscode-editorWidget-background); padding: 15px; margin-bottom: 15px; border-radius: 5px; border: 1px solid var(--vscode-panel-border); }
                .diff { 
                    background: var(--vscode-textCodeBlock-background); 
                    padding: 10px; 
                    font-family: 'SF Mono', 'Monaco', 'Andale Mono', 'Ubuntu Mono', monospace;
                    white-space: pre-wrap;
                    border-radius: 3px;
                    overflow-x: auto;
                }
                .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
                .remove { color: var(--vscode-gitDecoration-deletedResourceForeground); text-decoration: line-through; }
                .unchanged { color: var(--vscode-editor-foreground); }
                button { 
                    background: var(--vscode-button-background); 
                    color: var(--vscode-button-foreground); 
                    border: none; 
                    padding: 8px 16px; 
                    border-radius: 4px; 
                    cursor: pointer; 
                    margin-top: 10px;
                }
                button:hover { background: var(--vscode-button-hoverBackground); }
            </style>
        </head>
        <body>
            <h1>AI Suggested Changes</h1>
            <p>${changes.description || 'Review the following proposed changes:'}</p>
            
            ${diffHtml}
            
            <button onclick="applyChanges()">Apply All Changes</button>
            
            <script>
                const vscode = acquireVsCodeApi();
                function applyChanges() {
                    vscode.postMessage({
                        command: 'applyChanges'
                    });
                }
            </script>
        </body>
        </html>
        `;
    }

    generateDiffView(originalText, newText) {
        const oldLines = originalText.split('\n');
        const newLines = newText.split('\n');
        
        let diffHtml = '';
        // This is a simplified diff. For a robust diff, a library like 'diff' would be better.
        // This attempts to show line-by-line changes.
        
        // Find common prefix/suffix for better alignment in simple cases
        let commonPrefix = 0;
        while (commonPrefix < oldLines.length && commonPrefix < newLines.length && oldLines[commonPrefix] === newLines[commonPrefix]) {
            diffHtml += `<div class="unchanged">  ${this.escapeHtml(oldLines[commonPrefix])}</div>`;
            commonPrefix++;
        }

        let commonSuffix = 0;
        while (oldLines.length - 1 - commonSuffix >= commonPrefix && 
               newLines.length - 1 - commonSuffix >= commonPrefix && 
               oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]) {
            commonSuffix++;
        }

        for (let i = commonPrefix; i < oldLines.length - commonSuffix; i++) {
            diffHtml += `<div class="remove">- ${this.escapeHtml(oldLines[i])}</div>`;
        }
        for (let i = commonPrefix; i < newLines.length - commonSuffix; i++) {
            diffHtml += `<div class="add">+ ${this.escapeHtml(newLines[i])}</div>`;
        }

        for (let i = oldLines.length - commonSuffix; i < oldLines.length; i++) {
            if (oldLines[i] !== undefined) {
                diffHtml += `<div class="unchanged">  ${this.escapeHtml(oldLines[i])}</div>`;
            }
        }

        if (diffHtml === '') { // If no changes, show original text as unchanged
            return originalText.split('\n').map(line => `<div class="unchanged">  ${this.escapeHtml(line)}</div>`).join('');
        }
        
        return diffHtml;
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    async applyChanges(changes) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor to apply changes to.');
            return;
        }

        const document = editor.document;
        const workspaceEdit = new vscode.WorkspaceEdit();

        let hasValidChanges = false;
        changes.changes.forEach(change => {
            // Validate the range
            if (change.range && 
                typeof change.range.start?.line === 'number' && 
                typeof change.range.start?.character === 'number' &&
                typeof change.range.end?.line === 'number' &&
                typeof change.range.end?.character === 'number' &&
                typeof change.newText === 'string') 
            {
                const startPos = new vscode.Position(
                    change.range.start.line,
                    change.range.start.character
                );
                const endPos = new vscode.Position(
                    change.range.end.line,
                    change.range.end.character
                );
                const range = new vscode.Range(startPos, endPos);
                workspaceEdit.replace(document.uri, range, change.newText);
                hasValidChanges = true;
            } else {
                console.warn("Invalid change object received:", change);
            }
        });

        if (hasValidChanges) {
            await vscode.workspace.applyEdit(workspaceEdit);
            vscode.window.showInformationMessage('Changes applied successfully!');
        } else {
            vscode.window.showWarningMessage('No valid changes to apply or changes object was malformed.');
        }
    }
}

function activate(context) {
    console.log('Congratulations, your extension "ai-code-assistant" is now active!');
    new AICodeAssistant(context);
}

function deactivate() {
    console.log('AI Code Assistant deactivated.');
}

module.exports = {
    activate,
    deactivate
};