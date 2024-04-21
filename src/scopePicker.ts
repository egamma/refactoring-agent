import * as vscode from 'vscode';
import { CopilotExtensionApi } from './api';

export async function selectRange(editor: vscode.TextEditor): Promise<boolean> {
    const extensionId = 'GitHub.copilot-chat';
    const extension = vscode.extensions.getExtension(extensionId);

    if (!extension) {
        console.log(`Failed to get extension: ${extensionId}`);
        return false;
    }
    if (!extension.isActive) {
        await extension.activate();
    }

    const api = extension.exports.getAPI(1) as CopilotExtensionApi;
    if (!api) {
        console.log(`Failed to get API from extension: ${extensionId}`);
        return false;
    }
    const options = {
        reason: `Select a range for a refactoring suggestion`
    };
    let result = await api.selectScope(editor, options);
    if (!result) {
        return false;
    }
    return true;
}