import * as vscode from 'vscode';

declare module 'vscode' {
    // Chat related types
    export interface ChatResult {
        // Add properties needed by IRefactoringResult
    }

    export interface ChatRequest {
        command?: string;
        prompt: string;
    }

    export interface ChatContext {
        history: Array<ChatResponseTurn>;
    }

    export interface ChatResponseStream {
        markdown(content: string): void;
        progress(content: string): void;
        button(options: {
            command: string;
            arguments?: any[];
            title: string;
        }): void;
    }

    export type ChatRequestHandler = (request: ChatRequest, context: ChatContext, stream: ChatResponseStream, token: vscode.CancellationToken) => Promise<any>;

    // Language model related types
    export interface LanguageModelChatMessage {
        role: string;
        content: string;
    }

    export class LanguageModelChatMessageRole {
        static readonly Assistant: string;
        static readonly User: string;
    }

    export namespace LanguageModelChatMessage {
        export function User(content: string): LanguageModelChatMessage;
        export function Assistant(content: string): LanguageModelChatMessage;
    }

    // Chat participant types
    export class ChatResponseTurn {
        response: ChatResponsePart[];
    }

    export class ChatResponseMarkdownPart {
        value: { value: string };
    }

    export type ChatResponsePart = ChatResponseMarkdownPart;

    // Namespace extensions
    export namespace chat {
        export function createChatParticipant(id: string, handler: ChatRequestHandler): any;
    }

    export namespace lm {
        export function selectChatModels(selector: { vendor: string; family: string }): Promise<{
            sendRequest(messages: LanguageModelChatMessage[], options: any, token: vscode.CancellationToken): Promise<{
                text: AsyncIterableIterator<string>;
            }>;
        }[]>;
    }

    // L10n namespace
    export namespace l10n {
        export function t(message: string): string;
    }
} 