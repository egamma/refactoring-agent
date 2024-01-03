import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decode } from 'punycode';

const PREVIEW_REFACTORING = 'refactoring.preview';

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

export function activate(context: vscode.ExtensionContext) {

	function getFullCode(): string {
		if (!vscode.window.activeTextEditor) {
			return '';
		}
		const editor = vscode.window.activeTextEditor;
		return editor.document.getText();
	}

	function getSelectionCode(): string {
		if (!vscode.window.activeTextEditor) {
			return '';
		}
		const editor = vscode.window.activeTextEditor;
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

	function getLanguage(): string {
		if (!vscode.window.activeTextEditor) {
			return '';
		}
		const editor = vscode.window.activeTextEditor;
		return editor.document.languageId;
	}

	function getFileExtension(): string {
		if (!vscode.window.activeTextEditor) {
			return '';
		}
		const editor = vscode.window.activeTextEditor;
		const filePath = editor.document.uri.fsPath;
		const extension = path.extname(filePath);
		return extension;
	}	

	function removeFirstAndLastLine(text: string): string {
		const lines = text.split('\n');
		lines.shift(); // Remove the first line
		lines.pop(); // Remove the last line
		return lines.join('\n');
	}

	const handler: vscode.ChatAgentHandler = async (request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken): Promise<IRefactoringResult> => {
		if (request.slashCommand?.name === 'refactorEditor') {
			const refactoringResult = await suggestRefactorings(request, token, progress, getFullCode);
			return refactoringResult;
		} else if (request.slashCommand?.name === 'refactorSelection') {
			const refactoringResult = await suggestRefactorings(request, token, progress, getSelectionCode);
			return refactoringResult;
		} else if (request.slashCommand?.name === 'suggestExtractMethod') {
			const refactoringResult = await suggestExtractMethod(request, token, progress, getFullCode);
			return refactoringResult;
		}
		else {
			const refactoringResult = await suggestRefactorings(request, token, progress, getFullCode);
			return refactoringResult;
		}
	};

	const agent = vscode.chat.createChatAgent('refactoring', handler);
	agent.iconPath = new vscode.ThemeIcon('lightbulb-sparkle');
	agent.description = vscode.l10n.t('Suggest refactorings');
	agent.fullName = vscode.l10n.t('Suggest Refactorings');
	agent.slashCommandProvider = {
		provideSlashCommands(token) {
			return [
				{ name: 'refactorEditor', description: 'Suggest refacorings for the active editor' },
				{ name: 'refactorSelection', description: 'Suggest refactorings for the current selection' },
				{ name: 'suggestExtractMethod', description: 'Suggest extract method refactorings for the active editor' },
			];
		}
	};
	agent.followupProvider = {
		provideFollowups(result: IRefactoringResult, token: vscode.CancellationToken) {
			if (result.suggestedRefactoring.length > 0) {
				return [{
					commandId: PREVIEW_REFACTORING,
					args: [result],
					message: 'Preview Refactoring',
					title: vscode.l10n.t('Preview Refactoring'),
				}];
			}
		}
	};

	async function suggestRefactorings(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>, getCode: () => string): Promise<IRefactoringResult> {
		if (!vscode.window.activeTextEditor) {
			vscode.window.showInformationMessage(`There is no active editor, open an editor and try again.`);
			return NO_REFACTORING_RESULT;
		}
		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getCode();

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content: 
					`You are a world class expert in how to use refactorings to improve the quality of code.\n` +
					`Make refactoring suggestions that alter the code's its internal structure without changing the code's external behavior.\n` +
					`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
					`You are well familiar with 'Code Smells' like duplicated code, long methods or functions, and bad naming.\n` +
					`Explain the refactoring suggestion in detail and explain why they improve the code. Finally, answer with the complete refactored code\n` +
					`Be aware that you only have access to a subset of the project\n` +
					`Think step by step:\n` +
					`Always refactor in small steps.\n` +
					`Additional Rules\n` +
					`1. Suggest refactorings that eliminate code duplication.\n` +
					`2. Suggest refactorings that make the code easier to understand and maintain.\n` +
					`3. Suggest rename refactorings of local variable names when it improves the readability.\n` +
					`4. Make the code more efficient if possible.\n` +
					`5. Suggest refactorings that make the code follow the language’s idioms and naming patterns. The language used in the code is ${getLanguage()}\n` +
					`Restrict the format used in your answers follows:\n` +
					`1. Use Markdown formatting in your answers.\n` +
					`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
					`3. Avoid wrapping the whole response in triple backticks.\n` +
					`4. In the Markdown code blocks use the same indentation as in the original code.\n`
				},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest refactorings for the following code:\n.` +
					`${code}`
			},
		];

		const chatRequest = access.makeRequest(messages, {}, token);
		let suggestedRefactoring = '';
		for await (const fragment of chatRequest.response) {
			suggestedRefactoring += fragment;
			progress.report({ content: fragment });
		}

		return {
			suggestedRefactoring: suggestedRefactoring,
			originalCode: code,
			refactoringTarget: JSON.stringify(getRefactoringTarget(vscode.window.activeTextEditor))
		};
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

	async function suggestExtractMethod(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>, getCode: () => string): Promise<IRefactoringResult> {
		if (!vscode.window.activeTextEditor) {
			vscode.window.showInformationMessage(`There is no active editor, open an editor and try again.`);
			return NO_REFACTORING_RESULT;
		}
		const access = await vscode.chat.requestChatAccess('copilot');

		let code = getCode();

		const messages = [
			{
				role: vscode.ChatMessageRole.System,
				content: `You are a world class expert in how to use refactorings to improve the quality of code.\n` +
					`Make suggestions for restructuring existing code, altering its internal structure without changing its external behavior.` +
					`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
					`Explain the extract method suggestion in detail and explain why it improve the code.\n` +
					`When you suggest an extract method refactoring answer with 'Extract Code>' followed by the code range in the editor that should be extracted. \n` +
					`Use the following format for the selection: selectionLineStart, selectionColumnStart, selectionLineEnd, selectionColumnEnd\n` +
					`For example: Extract Code> 1, 1, 2, 1\n` +
					`This means to extract the code from line 1, column 1 to line 2, column 1.\n` +
					`Additional Rules\n` +
					`Think step by step:\n` +
					`Restrict the format used in your answers follows:` +
					`1. Use Markdown formatting in your answers.\n` +
					`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
					`3. Avoid wrapping the whole response in triple backticks.\n` +
					`4. In the Markdown code blocks use the same indentation as in the original code.\n`
			},
			{
				role: vscode.ChatMessageRole.User,
				content:
					`${request.prompt}\n` +
					`Suggest extract method refactorings to reduce code duplication for the following code:\n.` +
					`${code}`
			},
		];

		const chatRequest = access.makeRequest(messages, {}, token);
		let suggestedRefactoring = '';
		for await (const fragment of chatRequest.response) {
			suggestedRefactoring += fragment;
			progress.report({ content: fragment });
		}
		return {
			suggestedRefactoring: suggestedRefactoring,
			originalCode: code,
			refactoringTarget: ''
		};
	}

	context.subscriptions.push(
		agent,
		vscode.commands.registerCommand(PREVIEW_REFACTORING, async (arg:IRefactoringResult) => {
			const codeBlock = extractLastMarkdownCodeBlock(arg.suggestedRefactoring);
			if (codeBlock.length) {
				const refactoredCode = removeFirstAndLastLine(codeBlock);
				let originalFile = path.join(os.tmpdir(), `original${getFileExtension()}`);
				let refactoredFile = path.join(os.tmpdir(), `refactored${getFileExtension()}`);

				fs.writeFileSync(originalFile, arg.originalCode);
				fs.writeFileSync(refactoredFile, refactoredCode);

				let originalUri = vscode.Uri.file(originalFile);
				let refactoredUri = vscode.Uri.file(refactoredFile);

				let query = `refactoringTarget=${encodeURIComponent(arg.refactoringTarget)}`;
				let annotatedURI = refactoredUri.with({ query: query });

				await vscode.commands.executeCommand('vscode.diff', originalUri, annotatedURI, 'Suggested Refactoring');
			}
		}),

		vscode.commands.registerCommand('refactoring-agent.apply-refactoring', async () => {
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
			let annotation:IRefactoringTarget = JSON.parse(decodedString!);
			let targetDocumentUri = vscode.Uri.file(annotation.documentPath);
			let targetSelection = new vscode.Selection(annotation.selectionStartLine, annotation.selectionStartCharacter, annotation.selectionEndLine, annotation.selectionEndCharacter);
			let replacement = activeTextEditor.document.getText();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

			let doc = await vscode.workspace.openTextDocument(targetDocumentUri);
    		let editor = await vscode.window.showTextDocument(doc);
			if (editor.document.version !== annotation.documentVersion) {
				vscode.window.showInformationMessage(`The editor has changed, cannot apply the suggested refactoring.`);
				return;
			}
			let success = await editor.edit(editBuilder => {
				editBuilder.replace(targetSelection, replacement!);
			});
			if (!success) {
				vscode.window.showInformationMessage(`Failed to apply the suggested refactoring.`);
			}
		}),
	);
}

export function deactivate() { }