import * as vscode from 'vscode';
import * as path from 'path';

const PREVIEW_REFACTORING = 'refactoring.preview';

// slash commands
const SLASH_COMMAND_DUPLICATION = 'duplication';
const SLASH_COMMAND_PERFORMANCE = 'performance';
const SLASH_COMMAND_UNDERSTANDABILITY = 'understandability';
const SLASH_COMMAND_IDIOMATIC = 'idiomatic';
const SLASH_COMMAND_SMELLS = 'smells';
const SLASH_COMMAND_SUGGEST_EXTRACT_METHOD = 'suggestExtractMethod';

// prompts
const BASIC_SYSTEM_MESSAGE =
	`You are a world class expert in how to use refactorings to improve the quality of code.\n` +
	`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
	`You are well familiar with 'Code Smells' like duplicated code, long methods or functions, and bad naming.\n` +
	`Make a refactoring suggestion that alters the code's its internal structure without changing the code's external behavior.\n` +
	`Explain explain why the suggestion improves the code and explain which refactorings you have applied. Finally, answer with the complete refactored code.\n` +
	`Always refactor in small steps.\n` +
	`Always think step by step.\n` +
	`Be aware that you only have access to a subset of the project\n`;

const FORMAT_RESTRICTIONS =
	`Restrict the format used in your answers as follows:\n` +
	`1. Use Markdown formatting in your answers.\n` +
	`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
	`3. Avoid wrapping the whole response in triple backticks.\n` +
	`4. In the Markdown code blocks use the same indentation as in the original code.\n`;

interface IRefactoringResult extends vscode.ChatAgentResult2 {
	originalCode: string;
	suggestedRefactoring: string;
	refactoringTarget: string;
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

	const handler: vscode.ChatAgentHandler = async (request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken): Promise<IRefactoringResult> => {
		if (!vscode.window.activeTextEditor) {
			progress.report({ content: `There is no active editor, open an editor and try again.` });
			return NO_REFACTORING_RESULT;
		}
		if (vscode.window.activeTextEditor.selection.isEmpty) {
			progress.report({ content: 'No selection found, please select the code that should be refactored.' });
			return NO_REFACTORING_RESULT;
		}

		switch (request.slashCommand?.name) {
			case SLASH_COMMAND_DUPLICATION:
				return await suggestRefactoringsDuplication(request, token, progress);
			case SLASH_COMMAND_SMELLS:
				return await suggestRefactoringsSmells(request, token, progress);
			case SLASH_COMMAND_PERFORMANCE:
				return await suggestRefactoringsPerformance(request, token, progress);
			case SLASH_COMMAND_IDIOMATIC:
				return await suggestRefactoringsIdiomatic(request, token, progress);
			case SLASH_COMMAND_UNDERSTANDABILITY:
				return await suggestRefactoringsUnderstandability(request, token, progress);
			case SLASH_COMMAND_SUGGEST_EXTRACT_METHOD:
				return await suggestExtractMethod(request, token, progress);
			default:
				return await suggestRefactorings(request, token, progress);
		}
	};

	const agent = vscode.chat.createChatAgent('refactoring', handler);
	agent.iconPath = new vscode.ThemeIcon('lightbulb-sparkle');
	agent.description = vscode.l10n.t('Suggest refactorings');
	agent.fullName = vscode.l10n.t('Suggest Refactorings');
	agent.slashCommandProvider = {
		provideSlashCommands(token) {
			return [
				{ name: SLASH_COMMAND_PERFORMANCE, description: 'Suggest refacorings to improve performance' },
				{ name: SLASH_COMMAND_DUPLICATION, description: 'Suggest refacorings to remove code duplication' },
				{ name: SLASH_COMMAND_UNDERSTANDABILITY, description: 'Suggest refacorings to improve understandability' },
				{ name: SLASH_COMMAND_IDIOMATIC, description: 'Suggest refacorings to make the code more idiomatic' },
				{ name: SLASH_COMMAND_SMELLS, description: 'Suggest refacorings to remove code smells' },
				{ name: SLASH_COMMAND_SUGGEST_EXTRACT_METHOD, description: 'Suggest an extract method/function refactoring' }
			];
		}
	};

	agent.followupProvider = {
		provideFollowups(result: IRefactoringResult, token: vscode.CancellationToken) {
			if (result.suggestedRefactoring.length > 0) {
				return [{
					commandId: PREVIEW_REFACTORING,
					args: [result],
					message: 'Show Diff & Apply',
					title: vscode.l10n.t('Show Diff & Apply'),
				}];
			}
		}
	};

	async function makeRequest(access: vscode.ChatAccess, messages: { role: vscode.ChatMessageRole; content: string; }[], token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>, code: string, editor: vscode.TextEditor) {
		const chatRequest = access.makeRequest(messages, {}, token);
		let suggestedRefactoring = '';

		for await (const fragment of chatRequest.response) {
			suggestedRefactoring += fragment;
			progress.report({ content: fragment });
		}

		return {
			suggestedRefactoring: suggestedRefactoring,
			originalCode: code,
			refactoringTarget: JSON.stringify(getRefactoringTarget(editor))
		};
	}

	async function suggestRefactorings(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;
		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					BASIC_SYSTEM_MESSAGE +
					`Suggest one refactoring at a time that improves the quality of the code the most.\n` +
					`As a user I want to analyze and then apply only one refactoring at a time\n` +	
					`Prioritize refactorings that improve the maintainability and understandability of the code.\n` +
					`Here are some candidate suggestions:\n` +
					`1. Suggest a refactoring that eliminates code duplication.\n` +
					`2. Suggest a refactoring that makes the code easier to understand and maintain.\n` +
					`3. Suggest a rename refactoring for a variable name so that it improves the readability of the code.\n` +
					`4. Suggest a refactoring that makes the code more efficient.\n` +
					`5. Suggest a refactoring that makes the code follow the language's idioms and naming patterns better. \n` +  
					`   The language used in the code is ${getLanguage(editor)}\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest the most important refactoring for the following code:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
	}

	async function suggestRefactoringsDuplication(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					BASIC_SYSTEM_MESSAGE +
					`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
					`Think step by step:\n` +
					`Additional Rule\n` +
					`1. Suggest refactorings that eliminate code duplication.\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest refactorings for the following code that reduce code duplication:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
	}

	async function suggestRefactoringsSmells(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					BASIC_SYSTEM_MESSAGE +
					`You are well familiar with 'Code Smells' like duplicated code, long methods or functions, and bad naming.\n` +
					`Think step by step:\n` +
					`Additional Rule\n` +
					`1. Suggest refactorings that eliminate code smells.\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest refactorings for the following code that reduce code smells:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
	}

	async function suggestRefactoringsPerformance(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					BASIC_SYSTEM_MESSAGE +
					`Think step by step:\n` +
					`Additional Rule\n` +
					`1. Suggest refactorings that make the code more performant.\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest refactorings for the following code that improve the performance:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
	}

	async function suggestRefactoringsIdiomatic(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					BASIC_SYSTEM_MESSAGE +
					`Think step by step:\n` +
					`Additional Rule\n` +
					`1. Suggest refactorings that make the code follow the language's idioms and naming patterns. \n` +
					`The language used in the code is ${getLanguage(editor)}\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest refactorings for the following code that make the code follow the language's idioms and naming patterns:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
	}

	async function suggestRefactoringsUnderstandability(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					BASIC_SYSTEM_MESSAGE +
					`Think step by step:\n` +
					`Additional Rule\n` +
					`1. Suggest refactorings that make the code easier to understand and maintain.\n` +
					`2. Suggest rename refactorings of variable names when it improves the readability.\n` +
					`The language used in the code is ${getLanguage(editor)}\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest refactorings for the following code that make the code easier to understand:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
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

	async function suggestExtractMethod(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>): Promise<IRefactoringResult> {
		let editor = vscode.window.activeTextEditor!;

		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getSelectedText(editor);

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content:
					`You are a world class expert in how to use refactorings to improve the quality of code.\n` +
					`Make suggestions for restructuring existing code, altering its internal structure without changing its external behavior.` +
					`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
					`Explain the extract method suggestion in detail and explain why it improve the code.\n` +
					`When you suggest an extract method refactoring answer with 'Extract Code>' followed by the code range in the editor that should be extracted. \n` +
					`Use the following format for the selection: selectionLineStart, selectionColumnStart, selectionLineEnd, selectionColumnEnd\n` +
					`For example: Extract Code> 1, 1, 2, 1\n` +
					`This means to extract the code from line 1, column 1 to line 2, column 1.\n` +
					`Additional Rules\n` +
					`Think step by step:\n` +
					FORMAT_RESTRICTIONS
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest extract method refactorings to reduce code duplication for the following code:\n.` +
					`${code}`
			},
		];
		return makeRequest(access, messages, token, progress, code, editor);
	}

	context.subscriptions.push(
		agent,
		vscode.commands.registerCommand(PREVIEW_REFACTORING, showPreview),
		vscode.commands.registerCommand('refactoring-agent.apply-refactoring', applyRefactoring),
		vscode.commands.registerCommand('refactoring-agent.suggestRefactoring', suggestRefactoringAction),
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
		let targetSelection = new vscode.Selection(annotation.selectionStartLine, annotation.selectionStartCharacter, annotation.selectionEndLine, annotation.selectionEndCharacter);
		let success = await editor.edit(editBuilder => {
			editBuilder.replace(targetSelection, replacement!);
		});
		if (!success) {
			vscode.window.showInformationMessage(`Failed to apply the suggested refactoring.`);
		}

	}

	async function showPreview(arg: IRefactoringResult) {
		const codeBlock = extractLastMarkdownCodeBlock(arg.suggestedRefactoring);
		
		if (codeBlock.length) {
			let refactoredCode = removeFirstAndLastLine(codeBlock);
			// HACK sometimes the model generates a code block with a leading dot. This could also be restricted in the prompt
			if (refactoredCode.startsWith(".")) {
				refactoredCode = refactoredCode.substring(1);
			}
			let target: IRefactoringTarget = JSON.parse(arg.refactoringTarget);
			const fileExtension = path.extname(target.documentPath);

			const originalUri = vscode.Uri.parse(`refactoring-preview:original${fileExtension}`);
			const refactoredUri = vscode.Uri.parse(`refactoring-preview:refactored${fileExtension}`);

			previewContentProvider.updateContent(arg.originalCode, refactoredCode, fileExtension);
			previewContentProvider.update(originalUri);
			previewContentProvider.update(refactoredUri);
			vscode.commands.executeCommand('vscode.diff', originalUri, refactoredUri);

			// annotate the URI with a query parameter that contains the refactoring target
			// so that the refactoring can be applied later
			let query = `refactoringTarget=${encodeURIComponent(arg.refactoringTarget)}`;
			let annotatedURI = refactoredUri.with({ query: query });

			await vscode.commands.executeCommand('vscode.diff', originalUri, annotatedURI, 'Suggested Refactoring');
		}
	};

	async function suggestRefactoringAction() {
		vscode.interactive.sendInteractiveRequestToProvider('copilot', { message: '@refactoring'});
	}

}

export function deactivate() { }