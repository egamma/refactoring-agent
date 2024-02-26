import * as vscode from 'vscode';
import * as path from 'path';

import * as scopePicker from './scopePicker';

// commands
const PREVIEW_REFACTORING = 'refactoring.preview';
const ANOTHER_REFACTORING = 'refactoring.another';
const NEXT_REFACTORING = 'refactoring.next';

// chat commands
const CHAT_COMMAND_DUPLICATION = 'duplication';
const CHAT_COMMAND_PERFORMANCE = 'performance';
const CHAT_COMMAND_UNDERSTANDABILITY = 'understandability';
const CHAT_COMMAND_IDIOMATIC = 'idiomatic';
const CHAT_COMMAND_SMELLS = 'smells';
const CHAT_COMMAND_ERROR_HANDLING = 'errorHandling';
const CHAT_COMMAND_SUGGEST_ANOTHER = 'suggestAnotherRefactoring';
const CHAT_COMMAND_SUGGEST_NEXT = 'suggestNextRefactoring';

// Language model
const LANGUAGE_MODEL_ID = 'copilot-gpt-4';

// prompts
const BASIC_SYSTEM_MESSAGE =
	`You are a world class expert in how to use refactorings to improve the quality of code.\n` +
	`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
	`You are well familiar with 'Code Smells' like duplicated code, long methods or functions, and bad naming.\n` +
	`Make a refactoring suggestion that alters the code's its internal structure without changing the code's external behavior.\n` +
	`Explain explain why the refactoring suggestion improves the code. \n` +
	`Explain which refactorings you have applied. These are some popular refactorings:\n` +
	`- Extract Method or Function\n` +
	`- Extract Constant\n` +
	`- Extract Variable\n` +
	`- Rename a Variable or Function\n` +
	`- Inline Method or Function` +
	`- Introduce Explaining Variable\n` +
	`Finally, answer with the complete refactored code.\n` +
	`Always refactor in small steps.\n` +
	`Always think step by step.\n` +
	`Be aware that you only have access to a subset of the project\n`;

const FORMAT_RESTRICTIONS =
	`Restrict the format used in your answers as follows:\n` +
	`1. Use Markdown formatting in your answers.\n` +
	`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
	`3. Avoid wrapping the whole response in triple backticks.\n` +
	`4. In the Markdown code blocks use the same indentation as in the original code.\n`;

interface IRefactoringResult extends vscode.ChatResult {
	originalCode: string;
	suggestedRefactoring: string;
	refactoringTarget: string; // a JSON stringified IRefactoringTarget
}

interface IRefactoringTarget {
	documentPath: string;
	documentVersion: number;
	selectionStartLine: number;
	selectionStartCharacter: number;
	selectionEndLine: number;
	selectionEndCharacter: number;
}

const NO_REFACTORING_RESULT: IRefactoringResult = {
	originalCode: '',
	suggestedRefactoring: '',
	refactoringTarget: ''
};

class RefactoringPreviewContentProvider implements vscode.TextDocumentContentProvider {
	private originalContent: string = '';
	private refactoredContent: string = '';
	private fileExtension: string = '';
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this._onDidChange.event;

	updateContent(original: string, refactored: string, fileExtension: string) {
		this.originalContent = original;
		this.refactoredContent = refactored;
		this.fileExtension = fileExtension;
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		if (uri.path === `original${this.fileExtension}`) {
			return this.originalContent;
		} else if (uri.path === `refactored${this.fileExtension}`) {
			return this.refactoredContent;
		}
		return `Failed to provide content for the given uri ${uri}`;
	}

	public update(uri: vscode.Uri) {
		this._onDidChange.fire(uri);
	}
}

export function activate(context: vscode.ExtensionContext) {

	let previewContentProvider = new RefactoringPreviewContentProvider();

	// The map stores the original contents of a document before a suggested refactoring is applied.
	// It will be used to restore the original contents when the user request another suggestion.
	let originalDocs = new Map<string, string>();

	function saveOriginalDocument(documentPath: string, content: string) {
		originalDocs.set(documentPath, content);
	}

	function getOriginalDocument(documentPath: string): string | undefined {
		return originalDocs.get(documentPath);
	}

	let capturedDiagnostics: string = '';

	function getSelectedText(editor: vscode.TextEditor): string {
		const selection = editor.selection;
		return editor.document.getText(selection.with({ start: selection.start.with({ character: 0 }), end: selection.end.with({ character: editor.document.lineAt(selection.end.line).text.length }) }));
	}

	function extractLastMarkdownCodeBlock(markdown: string): string {
		const codeBlockRegex = /```[\s\S]*?```/g;
		const codeBlocks = markdown.match(codeBlockRegex);
		if (codeBlocks && codeBlocks.length > 0) {
			return codeBlocks[codeBlocks.length - 1];
		}
		return '';
	}

	function getLanguage(editor: vscode.TextEditor): string {
		return editor.document.languageId;
	}

	function removeFirstAndLastLine(text: string): string {
		const lines = text.split('\n');
		lines.shift();
		lines.pop();
		return lines.join('\n');
	}

	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<IRefactoringResult> => {

		if (!vscode.window.activeTextEditor) {
			stream.markdown(`There is no active editor, open an editor and try again.`);
			return NO_REFACTORING_RESULT;
		}

		const selection = vscode.window.activeTextEditor.selection;
		if (selection.isEmpty) {
			if (!await scopePicker.selectRange(vscode.window.activeTextEditor, selection)) {
				return NO_REFACTORING_RESULT;
			};
		}

		const hasRefactoringRequest = context.history.some(entry => entry.participant.name  === 'refactoring');
		switch (request.command) {
			case CHAT_COMMAND_DUPLICATION:
				return await suggestRefactoringsDuplication(request, token, stream);
			case CHAT_COMMAND_SMELLS:
				return await suggestRefactoringsSmells(request, token, stream);
			case CHAT_COMMAND_PERFORMANCE:
				return await suggestRefactoringsPerformance(request, token, stream);
			case CHAT_COMMAND_IDIOMATIC:
				return await suggestRefactoringsIdiomatic(request, token, stream);
			case CHAT_COMMAND_UNDERSTANDABILITY:
				return await suggestRefactoringsUnderstandability(request, token, stream);
			case CHAT_COMMAND_ERROR_HANDLING:
				return await suggestRefactoringsErrorHandling(request, token, stream);
			case CHAT_COMMAND_SUGGEST_NEXT:
				if (!hasRefactoringRequest) {
					stream.markdown(`No refactorings have been suggested, yet. Please use the refactoring participant to suggest a refactoring`);
					return NO_REFACTORING_RESULT;
				}
				return await suggestNextRefactoring(request, token, stream);
			case CHAT_COMMAND_SUGGEST_ANOTHER:
				if (!hasRefactoringRequest) {
					stream.markdown(`No refactorings have been suggested, yet. Please use the refactoring participant to suggest a refactoring`);
					return NO_REFACTORING_RESULT;
				}
				return await suggestAnotherRefactoring(request, token, stream);
			default:
				return await suggestRefactorings(request, token, stream);
		}
	};

	const refactoringChatParticipant = vscode.chat.createChatParticipant('refactoring', handler);
	refactoringChatParticipant.iconPath = new vscode.ThemeIcon('lightbulb-sparkle');
	refactoringChatParticipant.description = vscode.l10n.t('Suggest refactorings');
	refactoringChatParticipant.isSticky = true;
	refactoringChatParticipant.commandProvider = {
		provideCommands(token) {
			return [
				{ name: CHAT_COMMAND_PERFORMANCE, description: 'Suggest refacorings to improve performance' },
				{ name: CHAT_COMMAND_DUPLICATION, description: 'Suggest refacorings to remove code duplication' },
				{ name: CHAT_COMMAND_UNDERSTANDABILITY, description: 'Suggest refacorings to improve understandability' },
				{ name: CHAT_COMMAND_IDIOMATIC, description: 'Suggest refacorings to make the code more idiomatic' },
				{ name: CHAT_COMMAND_SMELLS, description: 'Suggest refacorings to remove code smells' },
				{ name: CHAT_COMMAND_ERROR_HANDLING, description: 'Suggest refacorings to improve error handling' },
				{ name: CHAT_COMMAND_SUGGEST_ANOTHER, description: 'Suggest another refactoring' },
				{ name: CHAT_COMMAND_SUGGEST_NEXT, description: 'Suggest next refactoring' }
			];
		}
	};

	async function makeRequest(access: vscode.LanguageModelAccess, messages: vscode.LanguageModelMessage[], token: vscode.CancellationToken, stream: vscode.ChatResponseStream, code: string, editor: vscode.TextEditor) {
		// dumpPrompt(messages);
		const chatRequest = access.makeChatRequest(messages, {}, token);
		let suggestedRefactoring = '';

		for await (const fragment of chatRequest.stream) {
			suggestedRefactoring += fragment;
			stream.markdown(fragment);
		}

		if (suggestedRefactoring.length > 0) {
			stream.button({
				command: PREVIEW_REFACTORING,
				arguments: [createRefactoringResult(suggestedRefactoring, code, editor)],
				title: vscode.l10n.t('Show Diff & Apply')
			});
			stream.button({
				command: NEXT_REFACTORING,
				arguments: [createRefactoringResult(suggestedRefactoring, code, editor)],
				title: vscode.l10n.t('$(thumbsup) Suggest Next')
			});
			stream.button({
				command: ANOTHER_REFACTORING,
				arguments: [createRefactoringResult(suggestedRefactoring, code, editor)],
				title: vscode.l10n.t('$(thumbsdown) Suggest Another')
			});
		}

		return createRefactoringResult(suggestedRefactoring, code, editor);
	}

	function createRefactoringResult(suggestedRefactoring: string, code: string, editor: vscode.TextEditor): IRefactoringResult {
		return {
			suggestedRefactoring: suggestedRefactoring,
			originalCode: code,
			refactoringTarget: JSON.stringify(getRefactoringTarget(editor))
		};
	}

	async function suggestRefactorings(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`\n` +
				`Suggest refactorings that:\n` +
				`- eliminate code duplication.\n` +
				`- ensure that the code uses the language's idioms and ensures that modern language features are used.\n` +
				`- improve the readability by improving the names of variables.\n` +
				`- improve the error handling.\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code:\n` +
				`${code}`
			),
		];

		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestNextRefactoring(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		const suggestionTopics = [
			`Suggest a refactoring that eliminates code duplication.\n`,
			`Suggest a rename refactoring for a variable name so that it improves the readability of the code.\n`,
			`Suggest a refactoring that makes the code more efficient.\n`,
			`Suggest a refactoring that improves the error handling.\n`,
			`Suggest a refactoring that makes the code follow the language's idioms and naming patterns better.`
		];
		const randomIndex = Math.floor(Math.random() * suggestionTopics.length);
		const randomSuggestion = suggestionTopics[randomIndex];

		let editor = vscode.window.activeTextEditor!;
		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [new vscode.LanguageModelSystemMessage(
			BASIC_SYSTEM_MESSAGE +
			`The user has applied the previous refactoring suggestion, please make another suggestion.\n` +
			`The language used in the selected code is ${getLanguage(editor)}\n` +
			`\n` +
			`${randomSuggestion}\n` +
			`\n` +
			FORMAT_RESTRICTIONS
		), new vscode.LanguageModelUserMessage(
			`${request.prompt}\n` +
			`Suggest refactorings for the following code:\n` +
			`${code}`
		)];

		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestAnotherRefactoring(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;
		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		let diagnostics = '';
		if (capturedDiagnostics.length) {
			diagnostics = `The previous suggestion has added the following errors:\n` +
				`${capturedDiagnostics}\n`;
		}
		capturedDiagnostics = '';

		const messages = [
			new vscode.LanguageModelSystemMessage(BASIC_SYSTEM_MESSAGE +
				`The user was not satisfied with the previous refactoring suggestion. Please provide another refactoring suggestion that is different from the previous one.\n` +
				`When you have no more suggestions that differ from the previous suggestion, then just respond with "no more refactoring suggestions".\n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS),
			new vscode.LanguageModelUserMessage(`${diagnostics}\n` +
					`\n` +
					`Please suggest another and differerent refactoring than the previous one for the following code:\n` +
					`${request.prompt}\n` +
					`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestRefactoringsDuplication(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`Suggest refactorings that eliminate code duplication.\n` +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code:\n` +
				`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestRefactoringsSmells(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`Suggest refactorings that eliminate code smells.\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that reduce code smells:\n` +
				`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestRefactoringsPerformance(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`Suggest refactorings that make the code more performant.\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that improve the performance:\n` +
				`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestRefactoringsIdiomatic(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`Suggest refactorings that make the code follow the language's idioms and naming patterns. \n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that make the code follow the language's idioms and naming patterns:\n` +
				`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestRefactoringsUnderstandability(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`Suggest refactorings that make the code easier to understand and maintain.\n` +
				`Suggest rename refactorings of variable names when it improves the readability.\n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that make the code easier to understand:\n` +
				`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	async function suggestRefactoringsErrorHandling(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);

		let code = getSelectedText(editor);

		const messages = [
			new vscode.LanguageModelSystemMessage(
				BASIC_SYSTEM_MESSAGE +
				`1. Suggest refactorings that improve the error handling and make the code more robust and maintainable.\n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			new vscode.LanguageModelUserMessage(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that improve the error handling:\n` +
				`${code}`
			),
		];
		return makeRequest(access, messages, token, stream, code, editor);
	}

	function getRefactoringTarget(editor: vscode.TextEditor): IRefactoringTarget {
		const selection = editor.selection;
		return {
			documentPath: editor.document.uri.fsPath,
			documentVersion: editor.document.version,
			selectionStartLine: selection.start.line,
			selectionStartCharacter: selection.start.character,
			selectionEndLine: selection.end.line,
			selectionEndCharacter: selection.end.character
		};
	}

	context.subscriptions.push(
		refactoringChatParticipant,
		vscode.commands.registerCommand(PREVIEW_REFACTORING, showPreview),
		vscode.commands.registerCommand(NEXT_REFACTORING, suggestNextRefactoringCommand),
		vscode.commands.registerCommand(ANOTHER_REFACTORING, suggestAnotherRefactoringCommand),
		vscode.commands.registerCommand('refactoring-participant.apply-refactoring', applyRefactoring),
		vscode.commands.registerCommand('refactoring-participant.suggestRefactoring', suggestRefactoringAction),
		vscode.workspace.registerTextDocumentContentProvider('refactoring-preview', previewContentProvider)
	);

	async function applyRefactoring() {
		const activeTextEditor = vscode.window.activeTextEditor;
		if (!activeTextEditor) {
			vscode.window.showInformationMessage(`There is no active editor, open an editor and try again.`);
			return;
		}

		let uri = activeTextEditor.document.uri;
		let query = uri.query;
		let params = new URLSearchParams(query);
		let annotationString = params.get('refactoringTarget');
		if (!annotationString) {
			vscode.window.showInformationMessage(`The currently active editor does not suggest a refactoring to apply.`);
			return;
		}

		let decodedString = decodeURIComponent(annotationString!);
		let annotation: IRefactoringTarget = JSON.parse(decodedString!);
		let targetDocumentUri = vscode.Uri.file(annotation.documentPath);
		let replacement = activeTextEditor.document.getText();
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		let doc = await vscode.workspace.openTextDocument(targetDocumentUri);
		let editor = await vscode.window.showTextDocument(doc);
		if (editor.document.version !== annotation.documentVersion) {
			vscode.window.showInformationMessage(`The editor contents has changed. It is no longer possible to apply the suggested refactoring.`);
			return;
		}
		let originalContent = editor.document.getText();

		let targetSelection = new vscode.Selection(annotation.selectionStartLine, annotation.selectionStartCharacter, annotation.selectionEndLine, annotation.selectionEndCharacter);
		let success = await editor.edit(editBuilder => {
			editBuilder.replace(targetSelection, replacement!);
		});
		if (success) {
			// store the original document content in the document store
			try {
				saveOriginalDocument(annotation.documentPath, originalContent);
			} catch (error) {
				vscode.window.showInformationMessage(`Failed to store the original document content in the document store.`);
			}
		} else {
			vscode.window.showInformationMessage(`Failed to apply the suggested refactoring.`);
		}

	}

	async function closeDiffEditorIfActive() {
		const activeTextEditor = vscode.window.activeTextEditor;
		if (!activeTextEditor) {
			return;
		}
		let uri = activeTextEditor.document.uri;
		let query = uri.query;
		let params = new URLSearchParams(query);
		let annotationString = params.get('refactoringTarget');
		if (!annotationString) {
			return;
		}
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	}

	async function showPreview(arg: IRefactoringResult) {
		const codeBlock = extractLastMarkdownCodeBlock(arg.suggestedRefactoring);
		if (!codeBlock.length) {
			return;
		}

		let refactoredCode = removeFirstAndLastLine(codeBlock);

		let target: IRefactoringTarget = JSON.parse(arg.refactoringTarget);
		const fileExtension = path.extname(target.documentPath);

		const originalUri = vscode.Uri.parse(`refactoring-preview:original${fileExtension}`);
		const refactoredUri = vscode.Uri.parse(`refactoring-preview:refactored${fileExtension}`);

		previewContentProvider.updateContent(arg.originalCode, refactoredCode, fileExtension);
		previewContentProvider.update(originalUri);
		previewContentProvider.update(refactoredUri);

		// annotate the URI with a query parameter that contains the refactoring target
		// so that the refactoring can be applied later
		let query = `refactoringTarget=${encodeURIComponent(arg.refactoringTarget)}`;
		let annotatedURI = refactoredUri.with({ query: query });

		await vscode.commands.executeCommand('vscode.diff', originalUri, annotatedURI, 'Suggested Refactoring');

	};

	async function suggestAnotherRefactoringCommand(arg: IRefactoringResult) {
		closeDiffEditorIfActive();

		await restoreOriginalContents(arg);

		vscode.interactive.sendInteractiveRequestToProvider('copilot', { message: `@refactoring /${CHAT_COMMAND_SUGGEST_ANOTHER}` });
	}

	async function suggestNextRefactoringCommand(arg: IRefactoringResult) {
		closeDiffEditorIfActive();
		vscode.interactive.sendInteractiveRequestToProvider('copilot', { message: `@refactoring /${CHAT_COMMAND_SUGGEST_NEXT}` });
	}

	async function restoreOriginalContents(arg: IRefactoringResult) {
		let target: IRefactoringTarget = JSON.parse(arg.refactoringTarget);
		let targetDocumentUri = vscode.Uri.file(target.documentPath);
		let doc = await vscode.workspace.openTextDocument(targetDocumentUri);
		let originalContent = getOriginalDocument(target.documentPath);

		if (originalContent) {
			capturedDiagnostics = captureDiagnosticsForDocument(targetDocumentUri); // @TODO: find a better solution

			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			let editor = await vscode.window.showTextDocument(doc);

			await editor.edit(editBuilder => {
				editBuilder.replace(fullRange, originalContent!);
			});
			editor.selection = new vscode.Selection(target.selectionStartLine, target.selectionStartCharacter, target.selectionEndLine, target.selectionEndCharacter);
		}
	}

	function captureDiagnosticsForDocument(targetDocumentUri: vscode.Uri) {
		const diagnostics = vscode.languages.getDiagnostics(targetDocumentUri);
		const errors = diagnostics.filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error);
		if (errors.length > 0) {
			let result = '';
			for (const diagnostic of diagnostics) {
				const line = `${diagnostic.message} line ${diagnostic.range.start.line}\n`;
				result += line;
			}
			return result;
		};
		return '';
	}

	async function suggestRefactoringAction() {
		// await vscode.commands.executeCommand('workbench.action.chat.clear'); @TODO: does not work

		if (vscode.window.activeTextEditor) {
			let selection = vscode.window.activeTextEditor.selection;
			if (selection.isEmpty) {
				if (!await scopePicker.selectRange(vscode.window.activeTextEditor, selection)) {
					return;
				};
			}
		}

		vscode.interactive.sendInteractiveRequestToProvider('copilot', { message: '@refactoring' });
	}

	// debugging aid
	function dumpPrompt(messages: { role: string; content: string; }[]) {
		for (const message of messages) {
			console.log(`Role: ${message.role}`);
			console.log(`Content: ${message.content}`);
			console.log('---');
		}
	}
}

export function deactivate() { }