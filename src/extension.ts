import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

	function removeFirstAndLastLine(text: string): string {
		const lines = text.split('\n');
		lines.shift(); // Remove the first line
		lines.pop(); // Remove the last line
		return lines.join('\n');
	}

	const handler: vscode.ChatAgentHandler = async (request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken): Promise<vscode.ChatAgentResult2> => {
		if (request.slashCommand?.name === 'suggestForEditor') {
			await suggestRefactorings(request, token, progress, getFullCode);
			return {};
		} else if (request.slashCommand?.name === 'suggestForSelection') {
			await suggestRefactorings(request, token, progress, getSelectionCode);
			return {};
		} else {
			await suggestRefactorings(request, token, progress, getFullCode);
			return {};
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
			];
		}
	};

	async function suggestRefactorings(request: vscode.ChatAgentRequest, token: vscode.CancellationToken, progress: vscode.Progress<vscode.ChatAgentProgress>, getCode: () => string): Promise<void> {
		if (!vscode.window.activeTextEditor) {
			vscode.window.showInformationMessage(`There is no active editor, open an editor and try again.`);
			return;
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
					`5. Suggest code changes that make use of modern JavaScript and TypeScript conventions\n` +
					`6. Provide suggestions if you see opportunities to improve code for performance, etc.\n` +
					`Restrict the format used in your answers follows:` +
					`1. Use Markdown formatting in your answers.\n` +
					`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
					`3. Avoid wrapping the whole response in triple backticks.\n`
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
		let answer = '';
		for await (const fragment of chatRequest.response) {
			answer += fragment;
			progress.report({ content: fragment });
		}

		const codeBlock = extractLastMarkdownCodeBlock(answer);
		if (codeBlock.length) {
			const refactoredCode = removeFirstAndLastLine(codeBlock);
			let originalFile = path.join(os.tmpdir(), 'original.ts');
			let refactoredFile = path.join(os.tmpdir(), 'refactored.ts');
			fs.writeFileSync(originalFile, code);
			fs.writeFileSync(refactoredFile, refactoredCode);
			let originalUri = vscode.Uri.file(originalFile);
			let refactoredUri = vscode.Uri.file(refactoredFile);
			vscode.commands.executeCommand('vscode.diff', originalUri, refactoredUri, 'Suggested Refactorings');
		} else {
			vscode.window.showInformationMessage(`The refactoring agent answer does not contain the refactored code in the correct format. Please try again.`);
		}
	}
}

export function deactivate() { }

