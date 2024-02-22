import { SymbolKind } from "vscode";

export function symbolKindToCodicon(kind: SymbolKind): string {
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