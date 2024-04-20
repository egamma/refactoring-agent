import * as vscode from 'vscode';
import { SymbolKind } from "vscode";
import { CopilotExtensionApi } from './api';

export async function selectRange(editor: vscode.TextEditor, selection: vscode.Selection): Promise<boolean> {
    let result: vscode.DocumentSymbol[] = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri);

    if (!result) {
        return false;
    }

    // check that the returned result is a DocumentSymbol[] and not a SymbolInformation[]
    if (result.length > 0 && !result[0].hasOwnProperty('children')) {
        return false;
    }

    let initialSelection = editor.selection;
    let enclosingSymbols = findEnclosingSymbol(result, selection.active);
    if (enclosingSymbols && enclosingSymbols.length > 0) {

        let quickPickItems = enclosingSymbols.reverse().map(symbol => ({ label: `${symbolKindToCodicon(symbol.kind)} ${symbol.name}`, symbol }));
        let pickedItem = await vscode.window.showQuickPick(quickPickItems, {
            title: 'Select an Enclosing Range',
            onDidSelectItem(item) {
                let symbol = (item as any).symbol;
                if (symbol) {
                    editor.selection = new vscode.Selection(symbol.range.start, symbol.range.end);
                }
            },
        });
        if (!pickedItem) {
            editor.selection = initialSelection;
            return false;
        }
    } else {
        selectAll(editor);
    }
    return true;
}

// Currently does not work, extension cannot get at the API object
async function selectScope(editor: vscode.TextEditor, options: { reason?: string } = {}): Promise<vscode.Selection | undefined> {
    const extensionName = 'GitHub.copilot';
    const extension = vscode.extensions.getExtension(extensionName);
    if (!extension) {
        return undefined;
    }
    if (!extension.isActive) {
        await extension.activate();
    }
    let exports = extension.exports;
    const copilotAPI = exports.getAPI(1) as CopilotExtensionApi;
    let result = copilotAPI.selectScope(editor, { reason: 'Select a range' });
    return result;
}

function findEnclosingSymbol(rootSymbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol[] | undefined {
    for (const symbol of rootSymbols) {
        if (symbol.range.contains(position)) {
            const enclosingChild = findEnclosingSymbol(symbol.children, position);
            if (enclosingChild) {
                return [symbol, ...enclosingChild];
            } else {
                return [symbol];
            }
        }
    }
    return undefined;
}

function selectAll(editor: vscode.TextEditor) {
    let start = new vscode.Position(0, 0);
    let end = new vscode.Position(editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length);
    editor.selection = new vscode.Selection(start, end);
}

function symbolKindToCodicon(kind: SymbolKind): string {
    switch (kind) {
        case SymbolKind.File:
            return '$(symbol-file)';
        case SymbolKind.Module:
            return '$(symbol-misc)';
        case SymbolKind.Namespace:
            return '$(symbol-namespace)';
        case SymbolKind.Package:
            return '$(package)';
        case SymbolKind.Class:
            return '$(symbol-class)';
        case SymbolKind.Method:
            return '$(symbol-method)';
        case SymbolKind.Property:
            return '$(symbol-property)';
        case SymbolKind.Field:
            return '$(symbol-field)';
        case SymbolKind.Constructor:
            return '$(symbol-misc)';
        case SymbolKind.Enum:
            return '$(symbol-enum)';
        case SymbolKind.Interface:
            return '$(symbol-interface)';
        case SymbolKind.Function:
            return '$(symbol-method)';
        case SymbolKind.Variable:
            return '$(symbol-variable)';
        case SymbolKind.Constant:
            return '$(symbol-constant)';
        case SymbolKind.String:
            return '$(symbol-string)';
        case SymbolKind.Number:
            return '$(symbol-numberic)';
        case SymbolKind.Boolean:
            return '$(symbol-boolean)';
        case SymbolKind.Array:
            return '$(symbol-array)';
        case SymbolKind.Object:
            return '$(symbol-misc)';
        case SymbolKind.Key:
            return '$(symbol-key)';
        case SymbolKind.Null:
            return '$(symbol-misc)';
        case SymbolKind.EnumMember:
            return '$(symbol-enum-member)';
        case SymbolKind.Struct:
            return '$(symbol-structure)';
        case SymbolKind.Event:
            return '$(symbol-event)';
        case SymbolKind.Operator:
            return '$(symbol-operator)';
        case SymbolKind.TypeParameter:
            return '$(symbol-parameter)';
    }
}