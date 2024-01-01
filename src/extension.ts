import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PREVIEW_REFACTORING = 'refactoring.preview';

interface IRefactoringResult extends vscode.ChatAgentResult2 {
	originalCode: string;
	suggestedRefactoring: string;
}

const NO_REFACTORING_RESULT: IRefactoringResult = {
	originalCode: '',
	suggestedRefactoring: ''
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
		if (request.slashCommand?.name === 'suggestForEditor') {
			const refactoringResult = await suggestRefactorings(request, token, progress, getFullCode);
			return refactoringResult;
		} else if (request.slashCommand?.name === 'suggestForSelection') {
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
				content: `You are a world class expert in how to use refactorings to improve the quality of code.\n` +
					`Make suggestions for restructuring existing code, altering its internal structure without changing its external behavior.` +
					`You are well familiar with the 'Once and Only Once principle' that states that any given behavior within the code is defined Once and Only Once.\n` +
					`You are well familiar with 'Code Smells' like duplicated code, long methods or functions, and bad naming.\n` +
					`Always refactor in small steps.\n` +
					`Explain the refactoring suggestion in detail and explain why they improve the code. Finally, answer with the complete refactored code\n` +
					`Be aware that you only have access to a subset of the project\n` +
					`Additional Rules\n` +
					`Think step by step:\n` +
					`1. Suggest code changes that eliminate code duplication and ensure the Once and Only Once principle.\n` +
					`2. Suggest code changes that make the code easier to understand and maintain.\n` +
					`3. Suggest improved local variable names that improve the readability.\n` +
					`4. Provide suggestions that make the code more compact\n` +
					`5. Provide suggestions if you see opportunities to improve code for performance, etc.\n` +
					`6. Suggest code changes that make the code follow the language’s idioms and naming patterns. The language used in the code is ${getLanguage()}\n` +
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
			originalCode: code
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
			originalCode: code
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
				vscode.commands.executeCommand('vscode.diff', originalUri, refactoredUri, 'Refactoring');
			} else {
				vscode.window.showInformationMessage(`The refactoring agent answer does not contain the suggested refactored code in the expected format. Please try again.`);
			}
		}),
	);
}

export function deactivate() { }