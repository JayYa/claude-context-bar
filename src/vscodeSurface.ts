// ============================================================================
// VS CODE SURFACE (dependency injection for testability)
// ============================================================================

/**
 * Minimal surface of VS Code APIs that ContextUsageManager depends on.
 *
 * In the extension, the real vscode module is used. In tests, a mock
 * implementation is injected so tests can run without the vscode runtime.
 */
export interface VSCodeSurface {
    createStatusBarItem(alignment: number, priority: number): VSCodeStatusBarItem;
    ThemeColor: new (id: string) => { id: string };
    MarkdownString: new (value: string, supportHtml?: boolean) => { value: string };
    StatusBarAlignment: { Right: number };
}

/**
 * Minimal interface matching vscode.StatusBarItem.
 */
export interface VSCodeStatusBarItem {
    show(): void;
    dispose(): void;
    text: string;
    tooltip: { value: string };
    color: string | undefined;
    backgroundColor: { id: string } | undefined;
    command: { command: string; title: string; arguments: string[] } | undefined;
}

/**
 * Factory that returns the real VS Code API surface.
 *
 * Uses a dynamic require so tests never load the vscode module.
 */
export function getRealVSCodeSurface(): VSCodeSurface {
    // Dynamic require — only called in the extension context, never in tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    return {
        createStatusBarItem: (alignment: number, priority: number) =>
            vscode.window.createStatusBarItem(alignment, priority),
        ThemeColor: vscode.ThemeColor,
        MarkdownString: vscode.MarkdownString,
        StatusBarAlignment: { Right: vscode.StatusBarAlignment.Right },
    };
}
