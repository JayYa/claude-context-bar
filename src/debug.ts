/**
 * Diagnostic harness for the Claude Context Bar extension.
 *
 * A second adapter over the session-record parser: it reads the same session
 * files the extension host reads, hands them to the same `parseTranscript`,
 * and prints what came back — including the parse diagnostics the status bar
 * has no room for. Nothing here may import `vscode`: the point of this tool is
 * that it runs in a plain terminal, outside the editor.
 *
 * Run with: npm run compile && node out/debug.js [projectFilter]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { parseTranscript, splitTranscriptLines, Transcript } from './transcript';

/**
 * What the supersession pass below needs about one session: where it lives,
 * when it moved, and the few Transcript fields that decide show or hide.
 */
interface SessionInfo {
    projectName: string;
    projectPath: string;
    sessionId: string;
    sessionFile: string;
    totalTokens: number;
    lastUpdated: Date;
    sessionCreated: Date | null;
    wasCleared: boolean;
}

function getClaudeProjectsDir(): string {
    return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Read one session file and parse it, exactly as the extension host does.
 *
 * A file that cannot be read reports as an empty transcript rather than
 * throwing: one unreadable session should not end the diagnostic run.
 */
function readTranscript(jsonlPath: string): Transcript {
    let content: string;
    try {
        content = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
        content = '';
    }
    return parseTranscript(splitTranscriptLines(content));
}

/**
 * Print every recently-touched session file and how the extension would treat
 * it, optionally narrowed to project directories containing `projectFilter`.
 */
function debugSessions(projectFilter?: string): void {
    const claudeDir = getClaudeProjectsDir();
    console.log(`\n========== CLAUDE CONTEXT BAR DEBUG ==========`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Claude dir: ${claudeDir}\n`);

    if (!fs.existsSync(claudeDir)) {
        console.log("Claude projects directory not found!");
        return;
    }

    const cutoffTime = Date.now() - (5 * 60 * 1000);
    const projectDirs = fs.readdirSync(claudeDir);

    // Collect all sessions
    const allSessions: SessionInfo[] = [];

    for (const projectDir of projectDirs) {
        if (projectFilter && !projectDir.includes(projectFilter)) continue;
        if (projectDir.includes('claude-plugins') || projectDir.includes('claude-mem')) continue;

        const projectPath = path.join(claudeDir, projectDir);
        try {
            if (!fs.statSync(projectPath).isDirectory()) continue;
        } catch (e) { continue; }

        const files = fs.readdirSync(projectPath)
            .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
            .map(f => ({
                name: f,
                path: path.join(projectPath, f),
                mtime: fs.statSync(path.join(projectPath, f)).mtime
            }))
            .filter(f => f.mtime.getTime() > cutoffTime)
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (files.length === 0) continue;

        console.log(`\n--- Project: ${projectDir} ---`);
        console.log(`Found ${files.length} active session files\n`);

        for (const file of files) {
            const transcript = readTranscript(file.path);

            console.log(`  📄 ${file.name.substring(0, 8)}...`);
            console.log(`     Created: ${transcript.sessionCreated?.toISOString() || 'unknown'}`);
            console.log(`     LastUpd: ${file.mtime.toISOString()}`);
            console.log(`     Tokens:  ${transcript.totalTokens}`);
            console.log(`     Cleared: ${transcript.wasCleared}`);
            console.log(`     FirstMsg: "${transcript.firstMessage}${transcript.firstMessage ? '...' : ''}"`);
            console.log(`     Lines:   ${transcript.lineCount} total, ${transcript.skippedLines} skipped as corrupt`);
            // The first question when a session looks like a ghost: was it cut
            // off by a /clear, and where? clearIndex is a 0-based index, so it
            // is printed alongside the 1-based line an editor or sed will show.
            const clear = transcript.clearIndex === -1
                ? 'none'
                : `index ${transcript.clearIndex} (file line ${transcript.clearIndex + 1})`;
            console.log(`     Clear:   ${clear}`);
            console.log('');

            if (transcript.totalTokens > 0) {
                allSessions.push({
                    projectName: projectDir,
                    projectPath: projectPath,
                    sessionId: file.name.replace('.jsonl', '').substring(0, 8),
                    sessionFile: file.path,
                    totalTokens: transcript.totalTokens,
                    lastUpdated: file.mtime,
                    sessionCreated: transcript.sessionCreated,
                    wasCleared: transcript.wasCleared
                });
            }
        }
    }

    // Group by project and apply supersession logic
    console.log(`\n========== SUPERSESSION ANALYSIS ==========\n`);

    const projectGroups = new Map<string, SessionInfo[]>();
    for (const session of allSessions) {
        const base = session.projectName;
        if (!projectGroups.has(base)) {
            projectGroups.set(base, []);
        }
        projectGroups.get(base)!.push(session);
    }

    for (const [baseName, group] of projectGroups) {
        console.log(`Project: ${baseName}`);

        // Sort by creation time (newest first)
        group.sort((a, b) => {
            const aTime = a.sessionCreated?.getTime() || 0;
            const bTime = b.sessionCreated?.getTime() || 0;
            return bTime - aTime;
        });

        for (let i = 0; i < group.length; i++) {
            const session = group[i];
            let status = "✅ SHOW";
            let reason = "";

            if (session.wasCleared) {
                status = "❌ HIDE";
                reason = "wasCleared=true (ended with /clear)";
            } else {
                for (let j = 0; j < i; j++) {
                    const newerSession = group[j];
                    const newerCreated = newerSession.sessionCreated?.getTime() || 0;
                    const thisLastUpdated = session.lastUpdated.getTime();

                    if (newerCreated > thisLastUpdated) {
                        status = "❌ HIDE";
                        reason = `superseded by ${newerSession.sessionId} (newer created after this one's last update)`;
                        break;
                    }
                }
            }

            console.log(`  [${status}] ${session.sessionId}`);
            if (reason) console.log(`      Reason: ${reason}`);
            console.log(`      Created: ${session.sessionCreated?.toISOString()}`);
            console.log(`      LastUpd: ${session.lastUpdated.toISOString()}`);
        }
        console.log('');
    }

    // Summary
    const totalShown = allSessions.filter(s => !s.wasCleared).length;
    console.log(`========== SUMMARY ==========`);
    console.log(`Total sessions found: ${allSessions.length}`);
    console.log(`Would be shown (before supersession): ${totalShown}`);
}

// Run with optional project filter
const projectFilter = process.argv[2] || undefined;
debugSessions(projectFilter);
