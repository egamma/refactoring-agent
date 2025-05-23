import * as vscode from 'vscode';
import * as path from 'path';

import * as scopePicker from './scopePicker';
import { RefactoringPreviewContentProvider } from './previewContentProvider';
import { encoding_for_model } from "tiktoken";

const REFACTORING_PARTICIPANT_ID = 'refactoring-participant';

// commands
const PREVIEW_REFACTORING = 'refactoring.preview';
const ANOTHER_REFACTORING = 'refactoring.another';

// chat commands
const CHAT_COMMAND_DUPLICATION = 'duplication';
const CHAT_COMMAND_PERFORMANCE = 'performance';
const CHAT_COMMAND_UNDERSTANDABILITY = 'understandability';
const CHAT_COMMAND_IDIOMATIC = 'idiomatic';
const CHAT_COMMAND_SMELLS = 'smells';
const CHAT_COMMAND_ERROR_HANDLING = 'errorHandling';
const CHAT_COMMAND_SUGGEST_ANOTHER = 'suggestAnotherRefactoring';

// language model
const MAX_TOKENS = 4096;  // TODO
const MAX_SELECTION_TOKENS = Math.floor(MAX_TOKENS * 0.75);

const DEFAULT_LANGUAGE_MODEL_FAMILY = 'copilot-gpt-4';
const modelMapping = new Map<string, string>();
modelMapping.set('gpt4', 'copilot-gpt-4');
modelMapping.set('gpt3-5', 'copilot-gpt-3.5-turbo');

// prompts
const BASIC_SYSTEM_MESSAGE =
	`You are a world class expert in how to use refactorings to improve the quality of code.\n` +
	`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
	`You are well familiar with 'Code Smells' like duplicated code, long methods or functions, and bad naming.\n` +
	`Make a refactoring suggestion that alters the code's its internal structure without changing the code's external behavior.\n` +
	`Explain explain why the refactoring suggestion improves the code. \n` +
	`Explain which refactorings you have applied.\n` +
	`These are popular refactorings:\n` +
	`- Extract Method or Function\n` +
	`- Extract Constant\n` +
	`- Extract Variable\n` +
	`- Rename a Variable or Function\n` +
	`- Inline Method or Function` +
	`- Introduce Explaining Variable\n` +
	`Finally, answer one code snippet showing the complete code after applying the refactorings.\n` +
	`Do not elide any code in the final snippet that shows the refactored code.\n` +
	`Do not use or use placeholders for code in comments in the final snippet that shows the refactored code. ` +
	`Here are some examples of what you should **not** do in the final snippet:\n`;
	`Example 1 elide code: \n` +
	`function foo() {\n` +
	`	// ...\n` +
	`}\n` +
	`End of Example 1\n` +
	`Example 2 elide code: \n` +
	`function foo() {\n` +
	`	const messages = [...];` +
	`}\n` +
	`End of Example 2\n` +
	`Example 3 use comment placeholder for existing code: \n` +
	'function somefunction() {\n' +
	`	// existing logic\n` +
	`}\n` +
	`End of Example 3\n` +
	`Example 4 use comment placeholder for existing code: \n` +
	`// other code unchanged...\n` +
	`End of Example 4\n` +
	`Example 5 use comment placeholder for existing code: \n` +
	`// Cap the remaining codes...\n` +
	`End of Example 5\n` +
	`Example 6 use comment placeholder for existing code: \n` +
	`/* Remaining code remains unchanged... */\n` +
	`End of Example 6\n` +
	`Example 7 use comment placeholder for existing code: \n` +
	`// Rest of the code as before */\n` +
	`End of Example 7\n` +
	`Always refactor in small steps.\n` +
	`Be aware that you only have access to a subset of the project.\n`;

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

export function activate(context: vscode.ExtensionContext) {

	let previewContentProvider = new RefactoringPreviewContentProvider();

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
			if (!await scopePicker.selectRange(vscode.window.activeTextEditor)) {
				return NO_REFACTORING_RESULT;
			};
		}

		const editor = vscode.window.activeTextEditor;
		const selectedText = getSelectedText(editor);
		const maxSelectedText = maxSelection(selectedText, MAX_SELECTION_TOKENS);
		if (maxSelectedText !== selectedText.length) {
			shrinkSelection(editor, maxSelectedText);
			stream.markdown(`**Warning** reduced the size of the selection so that it fits in the model's context window.`);
		}

		const hasRefactoringRequest = context.history.some(entry => entry instanceof vscode.ChatResponseTurn);
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
			case CHAT_COMMAND_SUGGEST_ANOTHER:
				if (!hasRefactoringRequest) {
					stream.markdown(`No refactorings have been suggested, yet. Please use the refactoring participant to suggest a refactoring`);
					return NO_REFACTORING_RESULT;
				}
				return await suggestAnotherRefactoring(request, context, token, stream);
			default:
				return await suggestRefactorings(request, context, token, stream);
		}
	};

	const refactoringChatParticipant = vscode.chat.createChatParticipant(REFACTORING_PARTICIPANT_ID, handler);
	refactoringChatParticipant.iconPath = new vscode.ThemeIcon('lightbulb-sparkle');

	async function makeRequest(messages: vscode.LanguageModelChatMessage[], token: vscode.CancellationToken, stream: vscode.ChatResponseStream, code: string, editor: vscode.TextEditor) {

		stream.progress('Suggesting a refactoring...');

		let tokens = countTokensInMessages(messages);
		console.log('Tokens in request: ' + tokens);

		if (tokens > MAX_TOKENS) {
			messages = removeAssistantMessages(messages);
			let tokens = countTokensInMessages(messages);
			console.log('Tokens in request after removing history: ' + tokens);
			if (tokens > MAX_TOKENS) {
				stream.markdown(`The selected range is too long. Please make the selection smaller.`);
				return NO_REFACTORING_RESULT;
			}
		}

		const selector = getLanguageModelSelector()
		const [languageModel] = await vscode.lm.selectChatModels(selector);

		const chatRequest = await languageModel.sendRequest(messages, {}, token);
		let suggestedRefactoring = '';

		for await (const fragment of chatRequest.text) {
			suggestedRefactoring += fragment;
			stream.markdown(fragment);
		}

		let suggestion = extractLastMarkdownCodeBlock(suggestedRefactoring);
		if (suggestion.length > 0) {
			stream.button({
				command: PREVIEW_REFACTORING,
				arguments: [createRefactoringResult(suggestedRefactoring, code, editor)],
				title: vscode.l10n.t('Show Diff & Apply')
			});
			stream.button({
				command: ANOTHER_REFACTORING,
				arguments: [createRefactoringResult(suggestedRefactoring, code, editor)],
				title: vscode.l10n.t('Suggest Another')
			});
		}

		return createRefactoringResult(suggestedRefactoring, code, editor);
	}

	function removeAssistantMessages(messages: vscode.LanguageModelChatMessage[]): vscode.LanguageModelChatMessage[] {
		return messages.filter((message) => !(message.role === vscode.LanguageModelChatMessageRole.Assistant));
	}

	function getLanguageModelSelector() {
		return { vendor: 'copilot', family: 'gpt-4o' };
	}

	function shrinkSelection(editor: vscode.TextEditor, maxSelectedText: number) {
		const startOffset = editor.document.offsetAt(editor.selection.start);
		const endOffset = startOffset + maxSelectedText;
		const endPosition = editor.document.positionAt(endOffset);
		const lineEndOffset = editor.document.offsetAt(endPosition.with({ character: editor.document.lineAt(endPosition.line).text.length }));
		const lineEndPosition = editor.document.positionAt(lineEndOffset);
		const newSelection = new vscode.Selection(editor.selection.start, lineEndPosition);
		editor.selection = newSelection;
	}

	function maxSelection(selection: string, maxTokens: number): number {
		// First, quickly check if the entire text is within the budget
		if (countTokens(selection) <= maxTokens) {
			return selection.length;
		}

		let low = 0, high = selection.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (countTokens(selection.substring(0, mid)) <= maxTokens) {
				low = mid;  
			} else {
				high = mid - 1; 
			}
		}
		return low;
	}

	function createRefactoringResult(suggestedRefactoring: string, code: string, editor: vscode.TextEditor): IRefactoringResult {
		return {
			suggestedRefactoring: suggestedRefactoring,
			originalCode: code,
			refactoringTarget: JSON.stringify(getRefactoringTarget(editor))
		};
	}

	async function suggestRefactorings(request: vscode.ChatRequest, context: vscode.ChatContext, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [];
		messages.push(
			vscode.LanguageModelChatMessage.User(
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
		);

		addHistoryToMessages(context, messages);

		messages.push(
			vscode.LanguageModelChatMessage.User(
				`This is the request from the user:\n` +
				`${request.prompt}\n\n` +
				`Suggest refactorings for the following code:\n` +
				`${code}`
			),
		);
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestAnotherRefactoring(request: vscode.ChatRequest, context: vscode.ChatContext, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;
		let code = getSelectedText(editor);

		const messages = [];
		messages.push(
			vscode.LanguageModelChatMessage.User(BASIC_SYSTEM_MESSAGE +
				`The user was not satisfied with the previous refactoring suggestion. Please provide another refactoring suggestion that is different from the previous one.\n` +
				`When you have no more suggestions that differ from the previous suggestion, then just respond with "no more refactoring suggestions".\n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS)
		);

		addHistoryToMessages(context, messages);

		messages.push(
			vscode.LanguageModelChatMessage.User(
				`Please suggest another and differerent refactoring than the previous one for the following code.\n` +
				`If you have no more suggestions, then just respond with "no more refactoring suggestions".\n` +
				`This the request from the user:\n` +
				`${request.prompt}\n\n` +
				`This is the code to be refactored:\n` +
				`${code}`
			),
		);
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestRefactoringsDuplication(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [
			vscode.LanguageModelChatMessage.User(
				BASIC_SYSTEM_MESSAGE +
				`Suggest refactorings that eliminate code duplication.\n` +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			vscode.LanguageModelChatMessage.User(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code:\n` +
				`${code}`
			),
		];
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestRefactoringsSmells(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [
			vscode.LanguageModelChatMessage.User(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`Suggest refactorings that eliminate code smells.\n` +
				FORMAT_RESTRICTIONS
			),
			vscode.LanguageModelChatMessage.User(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that reduce code smells:\n` +
				`${code}`
			),
		];
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestRefactoringsPerformance(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [
			vscode.LanguageModelChatMessage.User(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`Suggest refactorings that make the code more performant.\n` +
				FORMAT_RESTRICTIONS
			),
			vscode.LanguageModelChatMessage.User(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that improve the performance:\n` +
				`${code}`
			),
		];
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestRefactoringsIdiomatic(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [
			vscode.LanguageModelChatMessage.User(
				BASIC_SYSTEM_MESSAGE +
				`The language used in the selected code is ${getLanguage(editor)}\n` +
				`Suggest refactorings that make the code follow the language's idioms and naming patterns. \n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			vscode.LanguageModelChatMessage.User(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that make the code follow the language's idioms and naming patterns:\n` +
				`${code}`
			),
		];
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestRefactoringsUnderstandability(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [
			vscode.LanguageModelChatMessage.User(
				BASIC_SYSTEM_MESSAGE +
				`Suggest refactorings that make the code easier to understand and maintain.\n` +
				`Suggest rename refactorings of variable names when it improves the readability.\n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			vscode.LanguageModelChatMessage.User(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that make the code easier to understand:\n` +
				`${code}`
			),
		];
		return makeRequest(messages, token, stream, code, editor);
	}

	async function suggestRefactoringsErrorHandling(request: vscode.ChatRequest, token: vscode.CancellationToken, stream: vscode.ChatResponseStream): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		let code = getSelectedText(editor);

		const messages = [
			vscode.LanguageModelChatMessage.User(
				BASIC_SYSTEM_MESSAGE +
				`Suggest refactorings that improve the error handling and make the code more robust and maintainable.\n` +
				`The language used in the code is ${getLanguage(editor)}\n` +
				FORMAT_RESTRICTIONS
			),
			vscode.LanguageModelChatMessage.User(
				`${request.prompt}\n` +
				`Suggest refactorings for the following code that improve the error handling:\n` +
				`${code}`
			),
		];
		return makeRequest(messages, token, stream, code, editor);
	}

	function addHistoryToMessages(context: vscode.ChatContext, messages: vscode.LanguageModelChatMessage[]) {
		const history = context.history;

		for (const entry of history) {
			if (entry instanceof vscode.ChatResponseTurn) {
				for (const responseEntry of entry.response) {
					if (responseEntry instanceof vscode.ChatResponseMarkdownPart) {
						messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, responseEntry.value.value));
					}
				}
			}
		}
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
		// use the active tab which is a diff editor to get at the editor input URL
		// this is more robust than using the active editor only
		let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab) {
			if (tab.input instanceof vscode.TabInputTextDiff) {
				uri = tab.input.modified;
			}
		}
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

		let targetSelection = new vscode.Selection(annotation.selectionStartLine, annotation.selectionStartCharacter, annotation.selectionEndLine, annotation.selectionEndCharacter);
		let success = await editor.edit(editBuilder => {
			editBuilder.replace(targetSelection, replacement!);
		});
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
		await vscode.commands.executeCommand('workbench.action.chat.open', `@refactoring /${CHAT_COMMAND_SUGGEST_ANOTHER}`);
	}

	async function suggestRefactoringAction() {
		if (vscode.window.activeTextEditor) {
			let selection = vscode.window.activeTextEditor.selection;
			if (selection.isEmpty) {
				if (!await scopePicker.selectRange(vscode.window.activeTextEditor)) {
					return;
				};
			}
		}

		await vscode.commands.executeCommand('workbench.action.chat.open', '@refactoring');
	}

	function countTokensInMessages(messages: vscode.LanguageModelChatMessage[]): number {
		const gpt4Enc = encoding_for_model("gpt-4");
		let tokenCount = 0;
		try {
			for (const message of messages) {
				const encoded = gpt4Enc.encode(message.content);
				tokenCount += encoded.length;
			}
			return tokenCount;
		} catch (e) {
			gpt4Enc.free();
		}
		return tokenCount;
	}

	function countTokens(text: string): number {
		return countTokensInMessages([vscode.LanguageModelChatMessage.User(text)]);
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